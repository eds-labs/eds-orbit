import {
  authDb,
  scoped,
  type DbTx,
} from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  ConnectorError,
  type FetchLike,
} from "../../../../../packages/connectors/src/index.ts";
import { data, entity, update } from "../shared.ts";
import type { JobDef } from "../jobs/types.ts";
import { projectMembership } from "../tenancy/member-scope.ts";
import { effectiveRole } from "../tenancy/module-roles.ts";
import {
  registeredSignals,
  registeredUserNotification,
} from "../modules/contributions.ts";
import { emailEnabled } from "../email/connection.ts";
import { queueEmail } from "../email/send.ts";
import {
  linkedTelegramConnection,
  telegramEnabled,
  telegramSender,
} from "../connections/telegram.ts";
import { NOTIFICATION_DELIVERY_QUEUE } from "../notifications/members.ts";
import type { SignalSeverity } from "../signals/types.ts";
import {
  proactiveEnabled,
  routeOf,
  userPreferences,
  type Channel,
  type DeliveryMode,
  type Preferences,
} from "./preferences.ts";

// The delivery decision of one member notice (ADR 0023 items 3, 5, 6). The
// writer (`notifyMembers`) queues this job for the first occurrence of a
// notice only; the job runs after commit, re-checks the recipient's access
// and the kind's per-project switch, reads the user's own preferences in
// their personal space (its own transaction, never nested in the
// project's), and then for each channel either delivers at once, leaves the
// notice for the digest, or does nothing. The outcome is recorded on the job
// before anything goes out, so a retried job never sends twice; the digest
// collects exactly the notices recorded as `digest` (each once).
//
// Telegram goes to the user's own bot linked in their personal space, and
// only as a short notice text: the kind's label (or a signal's templated
// title, which holds ids, counts and codes only), the project's name, a
// repeat count and the link. Never a body or customer content.

/** Tests replace the Telegram transport here (no network in tests). */
export const proactiveTestHooks: { fetch?: FetchLike } = {};

type Locale = "en" | "de";

/** A signal kind's title is a template of ids, counts and codes (safe to send). */
export function templatedKind(kind: string) {
  return registeredSignals().some(
    (s) => s.kind === kind && ("event" in s.source || "periodic" in s.source),
  );
}

/** The short notice text for Telegram: never a body or customer content. */
export function telegramNoticeText(input: {
  kind: string;
  title: string;
  link: string | null;
  projectName: string;
  occurrences?: number;
  locale: Locale;
}) {
  const kind = registeredUserNotification(input.kind);
  const headline = templatedKind(input.kind)
    ? input.title
    : (kind?.label[input.locale] ?? input.kind);
  const origin = loadConfig().APP_ORIGIN.replace(/\/+$/, "");
  return [
    `${headline}${input.occurrences && input.occurrences > 1 ? ` (${input.occurrences}×)` : ""}`,
    `Orbit · ${input.projectName}`,
    input.link ? `${origin}${input.link}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1000);
}

/** The user's linked bot in their personal space, only while linked to that user. */
export async function personalTelegram(personal: Scope | null) {
  if (!personal || !telegramEnabled()) return null;
  const row = await scoped(personal.workspaceId, personal.projectId, (tx) =>
    linkedTelegramConnection(tx, personal),
  );
  if (!row || data(row).linkedUserId !== personal.userId) return null;
  return telegramSender(row, { fetch: proactiveTestHooks.fetch });
}

/** Where one channel sends: a notice marked `digest` by its writer never goes at once. */
function channelRoute(
  prefs: Preferences,
  channel: Channel,
  severity: SignalSeverity,
  at: Date,
  digestOnly: boolean,
): DeliveryMode {
  if (digestOnly)
    return prefs.notifications[channel][severity] === "off" ? "off" : "digest";
  return routeOf(prefs, channel, severity, at);
}

const SEVERITIES = new Set(["info", "attention", "urgent"]);

/** Runs one delivery job; never throws for a delivery problem (it is recorded). */
export async function deliverNotification(base: Scope, jobId: string) {
  const now = new Date();
  const prepared = await scoped(base.workspaceId, base.projectId, async (tx) => {
    const job = await entity(tx, base, "jobs", jobId);
    const d = data(job);
    if (d.outcome) return null;
    const userId = String(d.userId ?? "");
    const finish = async (reason: string) => {
      await update(tx, base, job, {
        ...d,
        outcome: { email: "off", telegram: "none", reason, routedAt: now.toISOString() },
      });
      return null;
    };
    if (!proactiveEnabled()) return finish("DISABLED");
    // Notices are private to their member (row-level security).
    await tx.$executeRaw`SELECT set_config('app.user_id',${userId},true)`;
    const row = await tx.notification.findFirst({
      where: { id: String(d.resourceId), projectId: base.projectId, userId },
    });
    if (!row) return finish("GONE");
    const kind = registeredUserNotification(row.kind);
    // The recipient is checked again now: membership and module access.
    const membership = await projectMembership(base.projectId, userId);
    if (!kind || !membership?.role) return finish("NO_ACCESS");
    const member: Scope = {
      workspaceId: base.workspaceId,
      projectId: base.projectId,
      userId,
      role: membership.role,
      ...(membership.moduleRoles ? { moduleRoles: membership.moduleRoles } : {}),
    };
    if (effectiveRole(member, kind.owner) === "none") return finish("NO_ACCESS");
    const preference = await tx.notificationPreference.findUnique({
      where: { projectId_userId_kind: { projectId: base.projectId, userId, kind: row.kind } },
    });
    // The per-project switch wins over every user-level setting.
    if (preference && !preference.inApp) return finish("KIND_OFF");
    const project = await tx.project.findFirst({
      where: { id: base.projectId },
      select: { name: true },
    });
    return {
      userId,
      row,
      kindLabel: kind.label,
      owner: kind.owner,
      email: (preference?.email ?? kind.emailDefault) && d.email === "yes",
      digestOnly: d.delivery === "digest",
      projectName: project?.name ?? "",
    };
  });
  if (!prepared) return;
  const { userId, row } = prepared;
  const severity = (SEVERITIES.has(row.severity) ? row.severity : "info") as SignalSeverity;
  const { personal, preferences } = await userPreferences(base.workspaceId, userId);
  let email: DeliveryMode = prepared.email && emailEnabled()
    ? channelRoute(preferences, "email", severity, row.createdAt, prepared.digestOnly)
    : "off";
  // A digest needs the personal space that schedules it.
  if (email === "digest" && !personal) email = "off";
  const bot = await personalTelegram(personal);
  const telegram: DeliveryMode | "none" = bot
    ? channelRoute(preferences, "telegram", severity, row.createdAt, prepared.digestOnly)
    : "none";
  const user = await authDb.user.findUnique({
    where: { id: userId },
    select: { email: true, locale: true },
  });
  const locale: Locale = user?.locale === "de" ? "de" : "en";
  const recorded = await scoped(base.workspaceId, base.projectId, async (tx: DbTx) => {
    const job = await entity(tx, base, "jobs", jobId);
    const d = data(job);
    if (d.outcome) return false;
    if (email === "immediate" && user) {
      const origin = loadConfig().APP_ORIGIN.replace(/\/+$/, "");
      // The same message the writer sent before ADR 0023.
      await queueEmail(tx, base, {
        to: [user.email],
        subject: row.title.replace(/\s+/g, " "),
        text: [
          row.body || row.title,
          row.link ? `${origin}${row.link}` : "",
          "--",
          `Orbit notification (${prepared.kindLabel.en}). Change what you receive in Orbit under Notifications.`,
        ]
          .filter(Boolean)
          .join("\n\n"),
        moduleId: prepared.owner === "platform" ? "platform" : prepared.owner,
        automatic: true,
      });
    }
    await update(tx, base, job, {
      ...d,
      outcome: {
        email: email === "immediate" ? (user ? "queued" : "off") : email,
        telegram: telegram === "immediate" ? "sending" : telegram,
        routedAt: now.toISOString(),
      },
    });
    return true;
  });
  if (!recorded || telegram !== "immediate" || !bot) return;
  let result = "sent";
  try {
    await bot.client.sendMessage(
      bot.chatId,
      telegramNoticeText({
        kind: row.kind,
        title: row.title,
        link: row.link,
        projectName: prepared.projectName,
        occurrences: row.occurrences,
        locale,
      }),
    );
  } catch (error) {
    // Never retried: an unclear answer may mean the message is out already.
    result = `failed:${error instanceof ConnectorError ? error.code : "UNEXPECTED"}`;
  }
  await scoped(base.workspaceId, base.projectId, async (tx) => {
    const job = await entity(tx, base, "jobs", jobId);
    const d = data(job);
    await update(tx, base, job, { ...d, outcome: { ...d.outcome, telegram: result } });
  });
}

/** The worker queue class (platform contribution). */
export const notificationDeliveryJob: JobDef = {
  queueClass: NOTIFICATION_DELIVERY_QUEUE,
  // Immediate e-mail behaves as before: a paused project sends nothing.
  handler: ({ scope, jobId }) => deliverNotification(scope, jobId),
};

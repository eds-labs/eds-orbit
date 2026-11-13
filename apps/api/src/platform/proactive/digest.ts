import { scoped } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { ConnectorError } from "../../../../../packages/connectors/src/index.ts";
import { data, entity, update } from "../shared.ts";
import type { JobDef } from "../jobs/types.ts";
import { hiddenModules } from "../tenancy/module-roles.ts";
import { NOTIFICATION_DELIVERY_QUEUE } from "../notifications/members.ts";
import { sendSystemMail } from "../email/system-mail.ts";
import { readUserProjects, userContact } from "./collect.ts";
import { personalTelegram, telegramNoticeText } from "./delivery.ts";
import { proactiveEnabled, readState, writeState } from "./preferences.ts";

// The cross-project digest (ADR 0023 item 6, plan WP4.1): at the user's
// digest time their personal space's scheduler queues one job per slot.
// It collects, from every business project the user can still reach, the
// notices the delivery job routed to the digest since the last one (each
// exactly once: the window moves before anything is sent), and sends
//   - one e-mail through the system SMTP sender: titles, counts and links
//     only, never a body or customer content;
//   - one Telegram message to the user's own linked bot, if any.
// Without the system sender the digest stays in-app.

export const DIGEST_QUEUE = "notification_digest";
const DAY = 86_400_000;
const MAX_ITEMS = 100;

export type DigestItem = {
  projectId: string;
  projectName: string;
  kind: string;
  title: string;
  severity: string;
  occurrences: number;
  link: string | null;
  createdAt: Date;
};

/** Notices routed to the digest on a channel within [since, until), per project. */
export async function collectDigest(
  workspaceId: string,
  userId: string,
  since: Date,
  until: Date,
) {
  const items = { email: [] as DigestItem[], telegram: [] as DigestItem[] };
  const reads = await readUserProjects(
    { workspaceId, userId },
    async (tx, member, project) => {
      const jobs = await tx.entity.findMany({
        where: {
          workspaceId,
          projectId: project.id,
          kind: "jobs",
          createdAt: { gte: new Date(since.getTime() - 2 * DAY) },
          AND: [
            { data: { path: ["topic"], equals: NOTIFICATION_DELIVERY_QUEUE } },
            { data: { path: ["userId"], equals: userId } },
          ],
        },
        take: 2000,
      });
      const routed = new Map<string, { email: boolean; telegram: boolean }>();
      for (const job of jobs) {
        const outcome = data(job).outcome as
          | { email?: string; telegram?: string; routedAt?: string }
          | undefined;
        const at = Date.parse(outcome?.routedAt ?? "");
        if (!outcome || !(at >= since.getTime() && at < until.getTime())) continue;
        const email = outcome.email === "digest";
        const telegram = outcome.telegram === "digest";
        if (email || telegram) routed.set(String(data(job).resourceId), { email, telegram });
      }
      if (!routed.size) return [];
      const rows = await tx.notification.findMany({
        where: {
          id: { in: [...routed.keys()] },
          projectId: project.id,
          userId,
          moduleId: { notIn: hiddenModules(member) },
        },
        orderBy: { createdAt: "asc" },
      });
      return rows.map((row) => ({ row, route: routed.get(row.id)! }));
    },
    { userRows: true },
  );
  for (const read of reads)
    for (const { row, route } of read.value) {
      const item: DigestItem = {
        projectId: read.projectId,
        projectName: read.projectName,
        kind: row.kind,
        title: row.title,
        severity: row.severity,
        occurrences: row.occurrences,
        link: row.link,
        createdAt: row.createdAt,
      };
      if (route.email) items.email.push(item);
      if (route.telegram) items.telegram.push(item);
    }
  items.email = items.email.slice(0, MAX_ITEMS);
  items.telegram = items.telegram.slice(0, MAX_ITEMS);
  return items;
}

/** The digest e-mail: titles, counts and links, grouped by project. */
export function digestMail(locale: "en" | "de", items: readonly DigestItem[]) {
  const de = locale === "de";
  const origin = loadConfig().APP_ORIGIN.replace(/\/+$/, "");
  const groups = new Map<string, DigestItem[]>();
  for (const item of items) groups.set(item.projectName, [...(groups.get(item.projectName) ?? []), item]);
  const lines: string[] = [];
  for (const [project, list] of groups) {
    lines.push(project);
    for (const item of list)
      lines.push(
        `- ${item.title.replace(/\s+/g, " ")}${item.occurrences > 1 ? ` (${item.occurrences}×)` : ""}${item.link ? `\n  ${origin}${item.link}` : ""}`,
      );
    lines.push("");
  }
  return {
    subject: de
      ? `Orbit: ${items.length} Benachrichtigung${items.length === 1 ? "" : "en"}`
      : `Orbit: ${items.length} notification${items.length === 1 ? "" : "s"}`,
    text: [
      de ? "Deine Benachrichtigungen seit der letzten Zusammenfassung:" : "Your notifications since the last digest:",
      "",
      ...lines,
      "--",
      de
        ? "Orbit-Zusammenfassung. Ändere sie in Orbit unter Verwaltung & Einstellungen → Mein Konto → Assistent → Mein Kontext (Benachrichtigungen und Briefing)."
        : "Orbit digest. Change it in Orbit under Administration & settings → My account → Assistant → My context (Notifications and briefing).",
    ].join("\n"),
  };
}

/** Runs one digest job of a personal space; records its outcome, never sends twice. */
export async function runDigest(base: Scope, jobId: string) {
  const now = new Date();
  const prepared = await scoped(base.workspaceId, base.projectId, async (tx) => {
    const job = await entity(tx, base, "jobs", jobId);
    const d = data(job);
    if (d.outcome) return null;
    const finish = async (outcome: string) => {
      await update(tx, base, job, { ...d, outcome: { status: outcome, at: now.toISOString() } });
      return null;
    };
    if (!proactiveEnabled()) return finish("disabled");
    const space = await tx.project.findFirst({
      where: { id: base.projectId, kind: "personal" },
      select: { personalUserId: true },
    });
    if (!space?.personalUserId) return finish("not_personal");
    const personal: Scope = {
      workspaceId: base.workspaceId,
      projectId: base.projectId,
      userId: space.personalUserId,
      role: "owner",
    };
    const { state } = await readState(tx, personal);
    const until = new Date(Date.parse(d.slot ?? "") || now.getTime());
    const since = state.lastDigestAt ? new Date(state.lastDigestAt) : new Date(until.getTime() - DAY);
    // The window moves first: each notice is in exactly one digest.
    await writeState(tx, personal, { lastDigestAt: until.toISOString() });
    await update(tx, base, job, { ...d, outcome: { status: "collecting", at: now.toISOString() } });
    return { personal, since, until };
  });
  if (!prepared) return;
  const { personal, since, until } = prepared;
  const contact = await userContact(personal.userId);
  const items = contact
    ? await collectDigest(personal.workspaceId, personal.userId, since, until)
    : { email: [], telegram: [] };
  let mail = "none";
  if (contact && items.email.length) {
    const result = await sendSystemMail({ to: contact.email, ...digestMail(contact.locale, items.email) });
    mail = result.status === "failed" ? `failed:${result.code}` : result.status;
  }
  let telegram = "none";
  if (contact && items.telegram.length) {
    const bot = await personalTelegram(personal);
    if (bot) {
      const text = items.telegram
        .slice(0, 20)
        .map((item) =>
          telegramNoticeText({
            kind: item.kind,
            title: item.title,
            link: item.link,
            projectName: item.projectName,
            occurrences: item.occurrences,
            locale: contact.locale,
          }),
        )
        .join("\n\n");
      try {
        await bot.client.sendMessage(bot.chatId, text.slice(0, 4000));
        telegram = "sent";
      } catch (error) {
        telegram = `failed:${error instanceof ConnectorError ? error.code : "UNEXPECTED"}`;
      }
    }
  }
  await scoped(base.workspaceId, base.projectId, async (tx) => {
    const job = await entity(tx, base, "jobs", jobId);
    await update(tx, base, job, {
      ...data(job),
      outcome: {
        status: "done",
        email: { items: items.email.length, result: mail },
        telegram: { items: items.telegram.length, result: telegram },
        at: new Date().toISOString(),
      },
    });
  });
}

export const digestJob: JobDef = {
  queueClass: DIGEST_QUEUE,
  handler: ({ scope, jobId }) => runDigest(scope, jobId),
};

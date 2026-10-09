import { z } from "zod";
import type { DbTx } from "../../../../packages/db/src/index.ts";
import {
  marketingProfile,
  type Scope,
} from "../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  exception,
  list,
  update,
} from "../shared.ts";
import { activePolicy } from "./policy.ts";
import {
  assertCampaignContext,
  currentMarketingProfile,
  officialTargetLink,
} from "./marketing-profile.ts";
import { assertMissionAssets } from "./asset-tools.ts";
import { assignedPostizChannels, postingTimeFor } from "./postiz-assignment.ts";
import { POSTING_TIME, zonedTime } from "./posting-slots.ts";
import { publishIntent, reviewContent } from "./workflow.ts";
import {
  agentsEnabled,
  assignmentInput,
  freeAssignmentBudget,
  proposeAssignmentInTx,
  type AssignmentInput,
} from "./agents/assignments.ts";
import { channelNames } from "./agents/assignment-overview.ts";
import { confirmationCard } from "./agents/tools/assignment-tools.ts";
import { chatScoped } from "./chat.ts";

/**
 * Weekly autopilot: at the configured weekday and time Orbit plans one post
 * per assigned channel and day for the next week (and the remaining days of
 * the current week when first enabled). Each post is its own single-run
 * mission with a fixed slot, so all drafts exist ahead of time. The worker
 * publishes a draft on its own only when automatic review passes; drafts with
 * free marketing copy wait for the owner's one-click approval.
 *
 * With ORBIT_AGENTS on, standing assignments replace it (spec D5): the sweep
 * plans assignment runs instead (lifecycle.ts), and the saved settings are
 * offered once as a draft assignment (autopilotAsAssignment) that an owner
 * confirms like any other. The settings stay untouched, so switching the flag
 * off again brings the autopilot back as it was.
 */
export const autopilotInput = z
  .object({
    enabled: z.boolean(),
    channels: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/))
      .min(1)
      .max(5),
    factKeys: z.array(z.string().min(1).max(200)).min(1).max(30),
    assetIds: z.array(z.uuid()).max(3).default([]),
    // 0 = Sunday ... 6 = Saturday, local project time.
    planWeekday: z.number().int().min(0).max(6),
    planTime: z.string().regex(POSTING_TIME),
    // First local calendar day to plan, e.g. to skip days already handled.
    startDate: z.iso.date().optional(),
  })
  .strict();

type Settings = z.infer<typeof autopilotInput> & {
  approvedBy: string;
  approvedAt: string;
};

const PLAN_CHECK_MS = 10 * 60_000;
const MIN_LEAD_MS = 2 * 3600_000;
// Publications in these states no longer occupy their slot.
const INACTIVE_PUBLICATION = ["canceled", "failed", "blocked_dependency"];

export async function autopilotSettings(tx: DbTx, scope: Scope) {
  return (await list(tx, scope, "autopilot_settings"))[0] ?? null;
}

/** When planAutopilot next checks the plan; null when disabled or not yet checked. */
export async function nextAutopilotCheckAt(tx: DbTx, scope: Scope) {
  const row = await autopilotSettings(tx, scope);
  if (!row || data(row).enabled !== true) return null;
  const last = Date.parse(data(row).lastPlanCheckAt ?? "");
  return Number.isFinite(last) ? new Date(last + PLAN_CHECK_MS) : null;
}

async function channelContext(tx: DbTx, scope: Scope) {
  const connector = (await list(tx, scope, "connectors")).find(
    (row) =>
      data(row).provider === "postiz" &&
      ["read_verified", "write_verified"].includes(data(row).status),
  );
  if (!connector) throw new DomainError("POSTIZ_NOT_CONNECTED", 409);
  return data(connector);
}

export async function configureAutopilot(tx: DbTx, scope: Scope, raw: unknown) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const input = autopilotInput.parse(raw);
  const connector = await channelContext(tx, scope);
  const assigned = new Set(
    assignedPostizChannels(connector).map((channel: any) => channel.id),
  );
  const policy = await activePolicy(tx, scope);
  for (const channel of input.channels) {
    if (!assigned.has(channel))
      throw new DomainError("POSTIZ_CHANNEL_NOT_ASSIGNED", 409);
    if (!postingTimeFor(connector, channel))
      throw new DomainError("POSTING_TIME_REQUIRED", 409);
    if (!policy || !data(policy).channels?.includes(channel))
      throw new DomainError("POLICY_CHANNEL_REQUIRED", 409);
  }
  const facts = await list(tx, scope, "facts");
  for (const key of input.factKeys)
    if (
      !facts.some(
        (row) =>
          data(row).key === key &&
          data(row).status === "verified" &&
          data(row).publicUse === true,
      )
    )
      throw new DomainError("VERIFIED_PUBLIC_FACT_REQUIRED", 409);
  await assertMissionAssets(tx, scope, input.assetIds);
  const settings: Settings = {
    ...input,
    approvedBy: scope.userId,
    approvedAt: new Date().toISOString(),
  };
  const existing = await autopilotSettings(tx, scope);
  const row = existing
    ? await update(tx, scope, existing, {
        ...settings,
        enabledAt:
          input.enabled && !data(existing).enabled
            ? settings.approvedAt
            : data(existing).enabledAt,
      })
    : await create(tx, scope, "autopilot_settings", {
        ...settings,
        enabledAt: input.enabled ? settings.approvedAt : null,
      });
  await audit(tx, scope, "autopilot.configured", row.id, {
    enabled: input.enabled,
    channels: input.channels,
  });
  return row;
}

function localDate(at: Date, timezone: string) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(at)
    .split("-")
    .map(Number);
  return { y: y!, m: m!, d: d! };
}

/** Local weekday of a calendar date: 0 = Sunday. */
function weekday(y: number, m: number, d: number) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function dayKey(y: number, m: number, d: number) {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

/** Calendar days to plan now: the rest of this week, plus next week once the plan moment passed. */
export function planningDays(
  now: Date,
  timezone: string,
  planWeekday: number,
  planTime: string,
) {
  const today = localDate(now, timezone);
  // Days since Monday (Monday = 0 ... Sunday = 6).
  const sinceMonday = (weekday(today.y, today.m, today.d) + 6) % 7;
  const monday = { ...today, d: today.d - sinceMonday };
  const [hh, mm] = planTime.split(":").map(Number);
  const planOffset = (planWeekday + 6) % 7;
  const planMoment = zonedTime(
    monday.y,
    monday.m,
    monday.d + planOffset,
    hh!,
    mm!,
    timezone,
  );
  const lastDay = now >= planMoment ? 13 : 6;
  const days: { y: number; m: number; d: number }[] = [];
  for (let offset = sinceMonday; offset <= lastDay; offset++) {
    const date = new Date(Date.UTC(monday.y, monday.m - 1, monday.d + offset));
    days.push({
      y: date.getUTCFullYear(),
      m: date.getUTCMonth() + 1,
      d: date.getUTCDate(),
    });
  }
  return days;
}

/** Remembers skipped slots so each skip is recorded once. */
async function saveSkips(
  tx: DbTx,
  scope: Scope,
  settingsId: string,
  skippedSlots: Record<string, unknown>,
) {
  const row = await entity(tx, scope, "autopilot_settings", settingsId);
  await update(tx, scope, row, { ...data(row), skippedSlots });
}

/** Plans missing autopilot slots; idempotent per channel and day. */
export async function planAutopilot(tx: DbTx, scope: Scope, now = new Date()) {
  const row = await autopilotSettings(tx, scope);
  if (!row || data(row).enabled !== true) return { planned: 0 };
  const settings = data(row) as Settings & {
    lastPlanCheckAt?: string;
    skippedSlots?: Record<string, unknown>;
  };
  if (
    settings.lastPlanCheckAt &&
    now.valueOf() - Date.parse(settings.lastPlanCheckAt) < PLAN_CHECK_MS
  )
    return { planned: 0 };
  await update(tx, scope, row, {
    ...settings,
    lastPlanCheckAt: now.toISOString(),
  });
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  if (project.paused || project.mode !== "autopilot") return { planned: 0 };
  const profileRow = await currentMarketingProfile(tx, scope);
  if (!profileRow) return { planned: 0 };
  const profile = marketingProfile.parse(profileRow.data);
  const cta = profile.primaryCtas[0];
  if (!profile.officialLinks.length || !cta) return { planned: 0 };
  const policy = await activePolicy(tx, scope);
  const link = await officialTargetLink(
    tx,
    scope,
    profile,
    data(policy)?.allowedOrigins ?? [],
  );
  // A target the policy forbids would block every draft: say so instead.
  if (!link) {
    await exception(tx, scope, "AUTOPILOT_PLANNING_BLOCKED", row.id);
    return { planned: 0, blocked: "LINK_NOT_ALLOWED" };
  }
  const linkFact = data(await entity(tx, scope, "facts", link.factId));
  const connector = await channelContext(tx, scope);
  const channels = assignedPostizChannels(connector);
  const existing = new Set(
    (await list(tx, scope, "missions"))
      .map((mission) => data(mission).autopilotSlot)
      .filter(Boolean),
  );
  // Scheduled posts, for example owner-approved package posts, keep their day:
  // the autopilot plans no paid draft that the daily quota would block later.
  const maxPerDay = Number(data(policy)?.maxPerDay ?? 1);
  const minIntervalMinutes = Number(data(policy)?.minIntervalMinutes ?? 0);
  const scheduled = (await list(tx, scope, "publications")).filter(
    (row) => !INACTIVE_PUBLICATION.includes(data(row).status),
  );
  const previouslySkipped = (settings.skippedSlots ?? {}) as Record<
    string,
    unknown
  >;
  const skippedSlots: Record<string, unknown> = {};
  const skipped: {
    slot: string;
    reason: "PUBLICATION_SCHEDULED";
    publicationIds: string[];
  }[] = [];
  let planned = 0;
  for (const day of planningDays(
    now,
    project.timezone,
    settings.planWeekday,
    settings.planTime,
  )) {
    const key = dayKey(day.y, day.m, day.d);
    if (settings.startDate && key < settings.startDate) continue;
    for (const [index, channelId] of settings.channels.entries()) {
      const slotKey = `${channelId}|${key}`;
      if (existing.has(slotKey)) continue;
      const time = postingTimeFor(connector, channelId);
      const channel = channels.find((item: any) => item.id === channelId);
      if (!time || !channel) continue;
      const [hh, mm] = time.split(":").map(Number);
      const slot = zonedTime(day.y, day.m, day.d, hh!, mm!, project.timezone);
      if (slot.valueOf() - now.valueOf() < MIN_LEAD_MS) continue;
      // Same day quota and spacing as publishIntent.
      const sameChannel = scheduled.filter(
        (publication) => data(publication).channel === channelId,
      );
      const sameDay = sameChannel.filter((publication) => {
        const local = localDate(
          new Date(data(publication).scheduledAt),
          project.timezone,
        );
        return dayKey(local.y, local.m, local.d) === key;
      });
      const tooClose = sameChannel.filter(
        (publication) =>
          Math.abs(Date.parse(data(publication).scheduledAt) - slot.valueOf()) <
          minIntervalMinutes * 60000,
      );
      if (sameDay.length >= maxPerDay || tooClose.length) {
        const skip = {
          slot: slotKey,
          reason: "PUBLICATION_SCHEDULED" as const,
          publicationIds: [
            ...new Set([...sameDay, ...tooClose].map((item) => item.id)),
          ],
        };
        skippedSlots[slotKey] = skip;
        if (!previouslySkipped[slotKey]) {
          skipped.push(skip);
          await audit(tx, scope, "autopilot.slot_skipped", row.id, skip);
        }
        continue;
      }
      // Different facts per channel on the same day, rotating daily.
      const dayNumber = Math.floor(
        Date.UTC(day.y, day.m - 1, day.d) / 86_400_000,
      );
      const factKey =
        settings.factKeys[(dayNumber + index) % settings.factKeys.length]!;
      const mission = {
        title: `Autopilot · ${String(channel.name)} · ${key}`,
        goal: `Write exactly one ${profile.contentLanguage === "de" ? "German" : "English"} social post for ${String(channel.name)} (${String(channel.identifier)}) that explains only the verified fact ${factKey}.`,
        audience: profile.audience.slice(0, 300),
        product: "",
        allowedTopics: [],
        allowedActions: ["draft", "review", "publish_live"],
        language: profile.contentLanguage,
        channels: [channelId],
        startAt: now.toISOString(),
        endAt: new Date(slot.valueOf() + 2 * 3600_000).toISOString(),
        maxContents: 1,
        targetAction: cta,
        targetUrl: link.url,
        sourceIds: [],
        assetIds: settings.assetIds,
        contentType: "social",
        campaignType: "product",
        profileVersion: profileRow.version,
      };
      try {
        await assertCampaignContext(tx, scope, mission, now);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        await exception(tx, scope, "AUTOPILOT_PLANNING_BLOCKED", row.id);
        await saveSkips(tx, scope, row.id, {
          ...previouslySkipped,
          ...skippedSlots,
        });
        return { planned, blocked: error.code };
      }
      await create(tx, scope, "missions", {
        ...mission,
        status: "ready",
        autopilot: true,
        autopilotSlot: slotKey,
        plannedSlotAt: slot.toISOString(),
        factKeys: [factKey, String(linkFact.key)],
      });
      existing.add(slotKey);
      planned++;
    }
  }
  if (planned) await audit(tx, scope, "autopilot.planned", row.id, { planned });
  // The current skips replace the previous ones: a freed day is planned again.
  await saveSkips(tx, scope, row.id, skippedSlots);
  return skipped.length ? { planned, skipped } : { planned };
}

/** Owner one-click approval: confirm the reviewed text, then schedule it. */
export async function approveAndSchedule(tx: DbTx, scope: Scope, raw: unknown) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const input = z
    .object({ contentId: z.uuid(), version: z.number().int().positive() })
    .strict()
    .parse(raw);
  const reviewed = await reviewContent(
    tx,
    scope,
    input.contentId,
    input.version,
    true,
  );
  if (data(reviewed).status !== "reviewed")
    throw new DomainError("CONTENT_REVIEW_REQUIRED", 409);
  return publishIntent(tx, scope, {
    contentId: reviewed.id,
    version: reviewed.version,
  });
}

// An assignment names at most four channels; the autopilot allowed five.
const ASSIGNMENT_CHANNELS = 4;

/** Why saved autopilot settings give no proposal; the migration card shows it. */
export type AutopilotProposalBlocker =
  | "POSTING_TIME_REQUIRED"
  | "ACTIVE_POLICY_REQUIRED"
  | "NO_FREE_PROJECT_BUDGET";

/**
 * The saved weekly autopilot as an Orbit Agents assignment: one social post
 * per channel and day at the earliest posting time of the channels it keeps,
 * about the autopilot's verified facts, its assets as style references (and
 * so an image per run), with the share of the project's monthly budget that
 * confirmed assignments leave free. `proposal` is null without saved settings
 * (`reason` null) or when no useful assignment can be proposed (`reason`
 * says why); a zero budget is never proposed. Only a proposal: it becomes a
 * draft through proposeAssignment and runs after an owner confirms it.
 */
async function autopilotProposal(
  tx: DbTx,
  scope: Scope,
): Promise<{
  proposal: AssignmentInput | null;
  reason: AutopilotProposalBlocker | null;
}> {
  const row = await autopilotSettings(tx, scope);
  if (!row) return { proposal: null, reason: null };
  const settings = data(row) as Settings;
  const channels = settings.channels.slice(0, ASSIGNMENT_CHANNELS);
  const connector = (await list(tx, scope, "connectors")).find(
    (item) =>
      data(item).provider === "postiz" &&
      ["read_verified", "write_verified"].includes(data(item).status),
  );
  const times = connector
    ? channels
        .map((channel) => postingTimeFor(data(connector), channel))
        .filter((value): value is string => value !== null)
        .sort()
    : [];
  if (!times.length) return { proposal: null, reason: "POSTING_TIME_REQUIRED" };
  if (!(await activePolicy(tx, scope)))
    return { proposal: null, reason: "ACTIVE_POLICY_REQUIRED" };
  const budget = await freeAssignmentBudget(tx, scope);
  if (budget <= 0) return { proposal: null, reason: "NO_FREE_PROJECT_BUDGET" };
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  const de = project.language.startsWith("de");
  const facts = settings.factKeys.join(", ");
  const assetIds = settings.assetIds ?? [];
  return {
    proposal: assignmentInput.parse({
      name: de ? "Autopilot (übernommen)" : "Autopilot (migrated)",
      kind: "standing",
      schedule: { rhythm: "daily", weekdays: [], times: [times[0]] },
      contentType: "social",
      channels,
      topicFrame: (de
        ? `Ein Social-Post pro Kanal und Tag, der jeweils genau einen dieser verifizierten Fakten erklärt (übernommen aus dem Autopilot): ${facts}.`
        : `One social post per channel and day, each explaining exactly one of these verified facts (taken over from the autopilot): ${facts}.`
      ).slice(0, 2000),
      image: assetIds.length > 0,
      styleAssetIds: assetIds,
      monthlyBudgetMicros: budget,
    }),
    reason: null,
  };
}

/** The saved autopilot as an assignment input, or null (see autopilotProposal). */
export async function autopilotAsAssignment(
  tx: DbTx,
  scope: Scope,
): Promise<AssignmentInput | null> {
  return (await autopilotProposal(tx, scope)).proposal;
}

/** The assignment proposed from the autopilot that is not ended yet, if any. */
async function migratedAssignment(tx: DbTx, scope: Scope) {
  return (
    (await list(tx, scope, "assignments")).find(
      (row) =>
        data(row).origin?.kind === "autopilot" && data(row).status !== "ended",
    ) ?? null
  );
}

/**
 * What the migration card shows: the proposal from the saved settings with
 * the names of its channels, and the assignment already proposed from them
 * (until it ends).
 */
export async function autopilotMigration(tx: DbTx, scope: Scope) {
  const { proposal, reason } = await autopilotProposal(tx, scope);
  const names = await channelNames(tx, scope);
  const row = await migratedAssignment(tx, scope);
  const status = row ? String(data(row).status) : null;
  return {
    proposal,
    reason,
    channelNames: Object.fromEntries(
      (proposal?.channels ?? [])
        .filter((id) => names.has(id))
        .map((id) => [id, names.get(id)!]),
    ),
    assignment: row
      ? {
          id: row.id,
          status,
          actionRequestId:
            status === "draft" ? (data(row).actionRequestId ?? null) : null,
        }
      : null,
  };
}

/**
 * Proposes the saved autopilot as a draft assignment through the normal
 * proposal path, in a new conversation of the proposing person that carries
 * the confirmation card. Nothing becomes active before an owner confirms it;
 * the autopilot settings are left unchanged.
 */
export async function proposeAutopilotAssignment(scope: Scope) {
  if (scope.role === "viewer") throw new DomainError("EDITOR_REQUIRED", 403);
  if (!agentsEnabled()) throw new DomainError("AGENTS_DISABLED", 409);
  return chatScoped(scope, async (tx) => {
    // One proposal at a time: the project lock scoped() also takes (re-entrant
    // within this transaction) serializes the check and the create below.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope.workspaceId + ":" + scope.projectId},0))`;
    if (await migratedAssignment(tx, scope))
      throw new DomainError("AUTOPILOT_ALREADY_PROPOSED", 409);
    const settings = await autopilotSettings(tx, scope);
    const { proposal, reason } = await autopilotProposal(tx, scope);
    if (!settings) throw new DomainError("AUTOPILOT_NOT_CONFIGURED", 409);
    if (!proposal)
      throw new DomainError(reason ?? "AUTOPILOT_NOT_CONFIGURED", 409);
    const project = await tx.project.findUniqueOrThrow({
      where: { id: scope.projectId },
    });
    const de = project.language.startsWith("de");
    const owner = {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      userId: scope.userId,
    };
    const thread = await tx.chatConversation.create({
      data: {
        ...owner,
        title: de ? "Autopilot als Auftrag" : "Autopilot as an assignment",
      },
    });
    const { assignment, actionRequest } = await proposeAssignmentInTx(
      tx,
      scope,
      thread.id,
      proposal,
      {
        kind: "autopilot",
        autopilotSettingsId: settings.id,
        autopilotSettingsVersion: settings.version,
      },
    );
    await tx.chatMessage.create({
      data: {
        ...owner,
        conversationId: thread.id,
        sequence: 1,
        role: "assistant",
        text: de
          ? "Vorschlag aus deinen Autopilot-Einstellungen: Dieser Auftrag ersetzt den wöchentlichen Autopilot. Er läuft erst, wenn ein Owner ihn bestätigt."
          : "A proposal from your autopilot settings: this assignment replaces the weekly autopilot. It runs only after an owner confirms it.",
        cards: [confirmationCard(assignment)],
      },
    });
    await audit(tx, scope, "autopilot.migration_proposed", settings.id, {
      assignmentId: assignment.id,
    });
    return { assignment, actionRequest, conversationId: thread.id };
  });
}

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

/**
 * Weekly autopilot: at the configured weekday and time Orbit plans one post
 * per assigned channel and day for the next week (and the remaining days of
 * the current week when first enabled). Each post is its own single-run
 * mission with a fixed slot, so all drafts exist ahead of time. The worker
 * publishes a draft on its own only when automatic review passes; drafts with
 * free marketing copy wait for the owner's one-click approval.
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

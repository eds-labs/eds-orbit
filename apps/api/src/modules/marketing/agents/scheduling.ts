import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { data, DomainError, list } from "../../shared.ts";
import { activePolicy } from "../policy.ts";
import { calendarConflicts } from "../calendar.ts";
import {
  assignedPostizChannels,
  postingTimeFor,
} from "../postiz-assignment.ts";
import { zonedTime } from "../posting-slots.ts";

/**
 * Read-only slot overview for scheduling package posts (Orbit Core J3.0).
 * It applies the same day quota, spacing, quiet hours and calendar blocks as
 * publishIntent and preflight, and also counts slots the weekly autopilot and
 * assignment runs have planned but not yet published, so a package never
 * takes one silently. `slotContext` and `slotStatus` are the per-channel
 * free-slot query it is built from; assignment runs use them for arbitrary
 * local times (assignment-runs.ts).
 */
const DEFAULT_POSTING_TIME = "09:00";
// Same minimum lead as the weekly autopilot.
const MIN_LEAD_MS = 2 * 3600_000;
const INACTIVE_PUBLICATION = ["canceled", "failed", "blocked_dependency"];
const INACTIVE_MISSION = ["archived", "expired", "blocked_dependency"];

export const slotQuery = z
  .object({
    channels: z.array(z.string().trim().min(1).max(80)).max(4).optional(),
    days: z.number().int().min(1).max(14).optional(),
  })
  .strict();

export type SlotReason =
  | "TOO_SOON"
  | "CHANNEL_NOT_APPROVED"
  | "OUTSIDE_POLICY"
  | "DAILY_QUOTA"
  | "SPACING"
  | "QUIET_HOURS"
  | "CALENDAR_BLOCK";
type Occupant = {
  kind: "publication" | "autopilot" | "run";
  id: string;
  at: string;
};
// A run holds its slots until it ends; a slot with a publication counts as that publication.
const HELD_RUN = ["planned", "running", "done", "partial"];
export type HeldSlot = { channel: string; at: string };

export function localDate(at: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(at);
}
function localHour(at: Date, timezone: string) {
  return Number(
    new Intl.DateTimeFormat("en", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: timezone,
    }).format(at),
  );
}

export type SlotContext = Awaited<ReturnType<typeof slotContext>>;

/** Everything the slot rules need, read once: policy, publications, autopilot slots and run slots. */
export async function slotContext(tx: DbTx, scope: Scope, now = new Date()) {
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  const policyRow = await activePolicy(tx, scope);
  if (!policyRow) throw new DomainError("POLICY_REQUIRED", 409);
  const p = data(policyRow);
  const publications = (await list(tx, scope, "publications"))
    .map((row): Record<string, any> => ({ id: row.id, ...data(row) }))
    .filter((pub) => !INACTIVE_PUBLICATION.includes(pub.status));
  const published = new Set(publications.map((pub) => pub.contentId));
  // An autopilot slot whose draft already has a publication is counted once, as that publication.
  const autopilot = (await list(tx, scope, "missions"))
    .map((row): Record<string, any> => ({ id: row.id, ...data(row) }))
    .filter(
      (m) =>
        m.autopilot === true &&
        m.autopilotSlot &&
        m.plannedSlotAt &&
        !INACTIVE_MISSION.includes(m.status) &&
        !(m.lastContentId && published.has(m.lastContentId)),
    );
  // Only runs of the last days can still hold a slot that matters.
  const since = new Date(now.valueOf() - 2 * 86400000);
  const runs = (
    await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "assignment_runs",
        data: { path: ["date"], gte: localDate(since, project.timezone) },
      },
    })
  )
    .map((row): Record<string, any> => ({ id: row.id, ...data(row) }))
    .filter((run) => HELD_RUN.includes(run.status))
    .flatMap((run) =>
      ((run.slots ?? []) as Array<Record<string, any>>)
        // A slot with a publication is counted as that publication; a released one is free.
        .filter((slot) => !slot.publicationId && !slot.releasedAt)
        .map((slot) => ({
          id: run.id as string,
          channel: String(slot.channel),
          at: new Date(slot.at),
        })),
    );
  return {
    tx,
    scope,
    now,
    timezone: project.timezone,
    policy: p,
    publications,
    autopilot,
    runs,
  };
}

/**
 * Whether one channel may post at `at`, with the same rules as publishIntent
 * and preflight. `held` are slots a caller has chosen but not saved yet.
 */
export async function slotStatus(
  ctx: SlotContext,
  channelId: string,
  at: Date,
  held: HeldSlot[] = [],
) {
  const { tx, scope, now, timezone, policy: p } = ctx;
  const date = localDate(at, timezone);
  const heldRuns = [
    ...ctx.runs.filter((run) => run.channel === channelId),
    ...held
      .filter((slot) => slot.channel === channelId)
      .map((slot) => ({ id: "held", at: new Date(slot.at) })),
  ];
  const occupiedBy: Occupant[] = [
    ...ctx.publications
      .filter(
        (pub) =>
          pub.channel === channelId &&
          localDate(new Date(pub.scheduledAt), timezone) === date,
      )
      .map((pub) => ({
        kind: "publication" as const,
        id: pub.id,
        at: new Date(pub.scheduledAt).toISOString(),
      })),
    ...ctx.autopilot
      .filter((m) => m.autopilotSlot === `${channelId}|${date}`)
      .map((m) => ({
        kind: "autopilot" as const,
        id: m.id,
        at: new Date(m.plannedSlotAt).toISOString(),
      })),
    ...heldRuns
      .filter((run) => localDate(run.at, timezone) === date)
      .map((run) => ({
        kind: "run" as const,
        id: run.id,
        at: run.at.toISOString(),
      })),
  ];
  const nearby = [
    ...ctx.publications
      .filter((pub) => pub.channel === channelId)
      .map((pub) => new Date(pub.scheduledAt)),
    ...ctx.autopilot
      .filter((m) => String(m.autopilotSlot).startsWith(`${channelId}|`))
      .map((m) => new Date(m.plannedSlotAt)),
    ...heldRuns.map((run) => run.at),
  ];
  const reasons: SlotReason[] = [];
  if (at.valueOf() - now.valueOf() < MIN_LEAD_MS) reasons.push("TOO_SOON");
  if (!(p.channels as string[]).includes(channelId))
    reasons.push("CHANNEL_NOT_APPROVED");
  if (at < new Date(p.startAt) || at >= new Date(p.endAt))
    reasons.push("OUTSIDE_POLICY");
  if (occupiedBy.length >= Number(p.maxPerDay ?? 0))
    reasons.push("DAILY_QUOTA");
  if (
    nearby.some(
      (other) =>
        Math.abs(other.valueOf() - at.valueOf()) <
        Number(p.minIntervalMinutes ?? 0) * 60000,
    )
  )
    reasons.push("SPACING");
  const hourOfSlot = localHour(at, timezone);
  if (
    p.quietStart !== undefined &&
    p.quietEnd !== undefined &&
    (p.quietStart <= p.quietEnd
      ? hourOfSlot >= p.quietStart && hourOfSlot < p.quietEnd
      : hourOfSlot >= p.quietStart || hourOfSlot < p.quietEnd)
  )
    reasons.push("QUIET_HOURS");
  if ((await calendarConflicts(tx, scope, channelId, at)).length)
    reasons.push("CALENDAR_BLOCK");
  return {
    date,
    at: at.toISOString(),
    free: reasons.length === 0,
    reasons,
    ...(occupiedBy.length ? { occupiedBy } : {}),
  };
}

export async function channelSlots(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  now = new Date(),
) {
  const input = slotQuery.parse(raw);
  const days = input.days ?? 14;
  const ctx = await slotContext(tx, scope, now);
  const connectors = (await list(tx, scope, "connectors")).filter(
    (row) => data(row).provider === "postiz",
  );
  const channels = input.channels ?? (ctx.policy.channels as string[]);
  const today = localDate(now, ctx.timezone).split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const result = [];
  for (const channelId of channels) {
    const connector = connectors.find((row) =>
      assignedPostizChannels(data(row)).some(
        (channel: { id: string }) => channel.id === channelId,
      ),
    );
    const postingTime =
      (connector && postingTimeFor(data(connector), channelId)) ??
      DEFAULT_POSTING_TIME;
    const [hour, minute] = postingTime.split(":").map(Number) as [
      number,
      number,
    ];
    const slots = [];
    for (let offset = 0; offset < days; offset++) {
      const at = zonedTime(
        today[0],
        today[1],
        today[2] + offset,
        hour,
        minute,
        ctx.timezone,
      );
      slots.push(await slotStatus(ctx, channelId, at));
    }
    result.push({
      channelId,
      postingTime,
      slots,
      nextFree: slots.find((slot) => slot.free)?.at ?? null,
    });
  }
  return {
    timezone: ctx.timezone,
    days,
    from: now.toISOString(),
    channels: result,
  };
}

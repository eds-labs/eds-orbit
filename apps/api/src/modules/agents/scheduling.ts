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
 * publishIntent and preflight, and also counts slots the weekly autopilot has
 * planned but not yet published, so a package never takes one silently.
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
type Occupant = { kind: "publication" | "autopilot"; id: string; at: string };

function localDate(at: Date, timezone: string) {
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

export async function channelSlots(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  now = new Date(),
) {
  const input = slotQuery.parse(raw);
  const days = input.days ?? 14;
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  const policyRow = await activePolicy(tx, scope);
  if (!policyRow) throw new DomainError("POLICY_REQUIRED", 409);
  const p = data(policyRow);
  const connectors = (await list(tx, scope, "connectors")).filter(
    (row) => data(row).provider === "postiz",
  );
  const channels = input.channels ?? (p.channels as string[]);
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
  const today = localDate(now, project.timezone).split("-").map(Number) as [
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
        project.timezone,
      );
      const date = localDate(at, project.timezone);
      const occupiedBy: Occupant[] = [
        ...publications
          .filter(
            (pub) =>
              pub.channel === channelId &&
              localDate(new Date(pub.scheduledAt), project.timezone) === date,
          )
          .map((pub) => ({
            kind: "publication" as const,
            id: pub.id,
            at: new Date(pub.scheduledAt).toISOString(),
          })),
        ...autopilot
          .filter((m) => m.autopilotSlot === `${channelId}|${date}`)
          .map((m) => ({
            kind: "autopilot" as const,
            id: m.id,
            at: new Date(m.plannedSlotAt).toISOString(),
          })),
      ];
      const nearby = [
        ...publications
          .filter((pub) => pub.channel === channelId)
          .map((pub) => new Date(pub.scheduledAt)),
        ...autopilot
          .filter((m) => String(m.autopilotSlot).startsWith(`${channelId}|`))
          .map((m) => new Date(m.plannedSlotAt)),
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
      const hourOfSlot = localHour(at, project.timezone);
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
      slots.push({
        date,
        at: at.toISOString(),
        free: reasons.length === 0,
        reasons,
        ...(occupiedBy.length ? { occupiedBy } : {}),
      });
    }
    result.push({
      channelId,
      postingTime,
      slots,
      nextFree: slots.find((slot) => slot.free)?.at ?? null,
    });
  }
  return {
    timezone: project.timezone,
    days,
    from: now.toISOString(),
    channels: result,
  };
}

import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { isTimeZone, localOf, resolveLocalTime } from "../../../platform/time/zoned-time.ts";
import { DomainError } from "../../../shared.ts";
import { refused } from "../entries/common.ts";
import type { CmsSettings } from "../settings.ts";

// When content goes live (ADR 0029 §4.6): now, an instant, or a local time in
// a zone (the module's setting, else the project's). A local time that does
// not exist (spring forward) is refused with the next valid one; one that
// exists twice (fall back) needs `fold`. A schedule lies at least two minutes
// and at most a year ahead.

export const scheduleFields = {
  at: z.string().max(40).optional(),
  local: z.string().max(16).optional(),
  timeZone: z.string().max(64).optional(),
  fold: z.enum(["earlier", "later"]).optional(),
};
export type ScheduleFields = { at?: string; local?: string; timeZone?: string; fold?: "earlier" | "later" };

export type Schedule =
  | { mode: "now"; at: null; local: null; timeZone: string }
  | { mode: "at"; at: Date; local: string; timeZone: string };

const LEAD_MS = 2 * 60_000;
const HORIZON_MS = 365 * 86_400_000;
const invalid = () => new DomainError("CMS_SCHEDULE_INVALID", 422);

/** The zone schedules are shown and entered in. */
export async function scheduleZone(tx: DbTx, scope: Scope, settings: CmsSettings) {
  if (settings.timeZone) return settings.timeZone;
  const project = await tx.project.findUnique({ where: { id: scope.projectId }, select: { timezone: true } });
  return project?.timezone && isTimeZone(project.timezone) ? project.timezone : "UTC";
}

/** Resolves the requested time; no `at` and no `local` means now. */
export function resolveSchedule(input: ScheduleFields, zone: string, now = new Date()): Schedule {
  if (input.at === undefined && input.local === undefined) return { mode: "now", at: null, local: null, timeZone: zone };
  if (input.at !== undefined && input.local !== undefined) throw invalid();
  let at: Date;
  let local: string;
  let timeZone = zone;
  if (input.at !== undefined) {
    at = new Date(input.at);
    if (Number.isNaN(at.getTime())) throw invalid();
    local = localOf(at, zone);
  } else {
    timeZone = input.timeZone ?? zone;
    if (!isTimeZone(timeZone)) throw invalid();
    let found;
    try {
      found = resolveLocalTime(input.local!, timeZone);
    } catch {
      throw invalid();
    }
    if (found.kind === "gap")
      throw refused("CMS_SCHEDULE_TIME_GAP", 422, {
        suggestedLocal: found.suggestedLocal,
        suggestedAt: found.suggestedAt.toISOString(),
      });
    if (found.kind === "ambiguous") {
      if (!input.fold)
        throw refused("CMS_SCHEDULE_TIME_AMBIGUOUS", 422, {
          earlier: found.earlier.toISOString(),
          later: found.later.toISOString(),
        });
      at = input.fold === "earlier" ? found.earlier : found.later;
    } else at = found.at;
    local = input.local!;
  }
  if (at.getTime() < now.getTime() + LEAD_MS) throw new DomainError("CMS_SCHEDULE_TOO_SOON", 422);
  if (at.getTime() > now.getTime() + HORIZON_MS) throw new DomainError("CMS_SCHEDULE_TOO_FAR", 422);
  return { mode: "at", at, local, timeZone };
}

import { isTimeZone, localOf, resolveLocalTime } from "../../../platform/time/zoned-time.ts";
import { DomainError } from "../../../shared.ts";
import { SocialDetailError } from "../errors.ts";

// When a post is to be published (plan §7 "Time"): an instant, or a local
// time in a zone (the project's by default). A time that does not exist
// (spring forward) is refused with the next valid one; a time that exists
// twice (fall back) needs `fold`. At least two minutes ahead, at most a year.

export type ScheduleInput = { at: string } | { local: string; timeZone?: string; fold?: "earlier" | "later" };
export type ResolvedSchedule = { at: Date; local: string; timeZone: string; fold: "earlier" | "later" | null };

const LEAD_MS = 2 * 60_000;
const HORIZON_MS = 365 * 86_400_000;
const invalid = () => new DomainError("SOCIAL_SCHEDULE_INVALID", 422);

export function resolveSchedule(input: ScheduleInput, projectTimeZone: string, now: Date): ResolvedSchedule {
  let resolved: ResolvedSchedule;
  if ("at" in input) {
    const at = new Date(input.at);
    if (typeof input.at !== "string" || Number.isNaN(at.getTime())) throw invalid();
    resolved = { at, local: localOf(at, projectTimeZone), timeZone: projectTimeZone, fold: null };
  } else {
    const timeZone = input.timeZone ?? projectTimeZone;
    if (!isTimeZone(timeZone)) throw invalid();
    let found;
    try {
      found = resolveLocalTime(input.local, timeZone);
    } catch {
      throw invalid();
    }
    if (found.kind === "gap")
      throw new SocialDetailError("SOCIAL_SCHEDULE_TIME_GAP", 422, {
        suggestedLocal: found.suggestedLocal,
        suggestedAt: found.suggestedAt.toISOString(),
      });
    if (found.kind === "ambiguous") {
      if (!input.fold)
        throw new SocialDetailError("SOCIAL_SCHEDULE_TIME_AMBIGUOUS", 422, {
          earlier: found.earlier.toISOString(),
          later: found.later.toISOString(),
        });
      resolved = {
        at: input.fold === "earlier" ? found.earlier : found.later,
        local: input.local,
        timeZone,
        fold: input.fold,
      };
    } else resolved = { at: found.at, local: input.local, timeZone, fold: null };
  }
  if (resolved.at.getTime() < now.getTime() + LEAD_MS) throw new DomainError("SOCIAL_SCHEDULE_TOO_SOON", 422);
  if (resolved.at.getTime() > now.getTime() + HORIZON_MS) throw new DomainError("SOCIAL_SCHEDULE_TOO_FAR", 422);
  return resolved;
}

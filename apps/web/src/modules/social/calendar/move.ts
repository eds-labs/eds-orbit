import type { CalendarItem } from "../api";

// Who may move which post where (S6, S-D6): a draft moves freely; an
// approved or waiting post needs a new approval, which an owner gives on
// the spot and an editor requests; anything else never moves.

export type MoveCheck = { kind: "free" } | { kind: "reapprove" } | { kind: "request" } | { kind: "forbidden"; reason: string };

const MOVABLE = ["draft", "needs_approval", "scheduled", "approved"];

export function moveCheck(item: CalendarItem, role: "owner" | "editor" | "viewer", scope: "project" | "organization"): MoveCheck {
  if (scope === "organization") return { kind: "forbidden", reason: "organization" };
  if (item.readOnly) return { kind: "forbidden", reason: "read_only" };
  if (!MOVABLE.includes(item.status)) return { kind: "forbidden", reason: "status" };
  if (role === "viewer") return { kind: "forbidden", reason: "role" };
  if (item.status === "draft") return { kind: "free" };
  return role === "owner" ? { kind: "reapprove" } : { kind: "request" };
}

/** The local time a drop names: a week slot's own time, or the post's time of day on another date. */
export function dropLocal(item: CalendarItem, target: { date: string; time?: string }, timeZone: string): string {
  if (target.time) return `${target.date}T${target.time}`;
  const own =
    item.schedule.local && item.schedule.timeZone === timeZone
      ? item.schedule.local.slice(11, 16)
      : item.schedule.at
        ? new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(item.schedule.at))
        : "09:00";
  return `${target.date}T${own}`;
}

/** The body of POST …/posts/:postId/reschedule. */
export function rescheduleBody(
  item: CalendarItem,
  local: string,
  timeZone: string,
  opts: { reapprove?: boolean; fold?: "earlier" | "later" },
): Record<string, unknown> {
  return {
    version: item.version,
    local,
    timeZone,
    ...(opts.reapprove ? { reapprove: true } : {}),
    ...(opts.fold ? { fold: opts.fold } : {}),
  };
}

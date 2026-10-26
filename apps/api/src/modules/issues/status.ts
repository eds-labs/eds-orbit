import { DomainError } from "../../shared.ts";

// The issue status machine (ADR 0018 I-6, plan §2.3). People move issues
// along TRANSITIONS; the sync rules (I-4) only move them forward along
// AUTO_CHAIN, with the reopen of a fix-ready issue as the one exception.
// `fix_ready` means merged or done, not deployed; only `released` means
// in production.

export const ISSUE_STATUSES = [
  "new",
  "triage",
  "needs_info",
  "confirmed",
  "duplicate",
  "wont_fix",
  "planned",
  "in_progress",
  "fix_ready",
  "released",
  "verified",
  "closed",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/** Statuses of finished issues: no automatic move touches them. */
export const CLOSED_STATUSES: readonly IssueStatus[] = ["duplicate", "wont_fix", "closed"];
/** Statuses that still need a person to triage. */
export const TRIAGE_STATUSES: readonly IssueStatus[] = ["new", "triage", "needs_info"];
/** Statuses of issues someone still works on or waits for. */
export const OPEN_STATUSES: readonly IssueStatus[] = ISSUE_STATUSES.filter(
  (s) => !CLOSED_STATUSES.includes(s) && s !== "verified",
);

/**
 * The moves a person may make. `duplicate` is reached only by a merge,
 * which keeps every report (I-3), and is never left.
 */
export const TRANSITIONS: Readonly<Record<IssueStatus, readonly IssueStatus[]>> = {
  new: ["triage", "needs_info", "confirmed", "wont_fix"],
  triage: ["needs_info", "confirmed", "wont_fix"],
  needs_info: ["triage", "confirmed", "wont_fix"],
  confirmed: ["triage", "planned", "in_progress", "wont_fix"],
  planned: ["confirmed", "in_progress", "wont_fix"],
  in_progress: ["planned", "fix_ready", "wont_fix"],
  fix_ready: ["in_progress", "released"],
  released: ["in_progress", "verified"],
  verified: ["in_progress", "closed"],
  wont_fix: ["triage", "closed"],
  duplicate: [],
  // A new report reopens a closed issue into triage.
  closed: ["triage"],
};

/** The order automatic moves follow; they never go back (I-4 rule 4). */
export const AUTO_CHAIN: readonly IssueStatus[] = ["confirmed", "planned", "in_progress", "fix_ready", "released"];

/** Throws 409 ISSUES_TRANSITION_INVALID unless a person may make the move. */
export function assertTransition(from: string, to: string) {
  if (!(TRANSITIONS[from as IssueStatus] ?? []).includes(to as IssueStatus))
    throw new DomainError("ISSUES_TRANSITION_INVALID", 409);
}

/**
 * Whether an automatic rule may move an issue from `from` to `to`: forward
 * along AUTO_CHAIN only, or the reopen from fix-ready to in progress (S7).
 */
export function autoMoveAllowed(from: string, to: string, reopen = false) {
  if (reopen) return from === "fix_ready" && to === "in_progress";
  const a = AUTO_CHAIN.indexOf(from as IssueStatus);
  const b = AUTO_CHAIN.indexOf(to as IssueStatus);
  return a >= 0 && b > a;
}

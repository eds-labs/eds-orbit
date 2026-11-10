// What the approvals page lists, as the server counts it for the attention
// items. The web keeps its own copies (apps/web/src/modules/marketing/
// draft-cleanup.ts and approval-lists.ts); a test
// (apps/web/src/modules/marketing/approval-state-parity.test.tsx) asserts
// they agree. Free of imports so the web typecheck can load it for that test.

/** Content statuses the approvals page lists; archived drafts are not among them. */
export const APPROVAL_STATUSES = [
  "review",
  "needs_review",
  "reviewed",
  "draft",
  "blocked",
  "pending_approval",
] as const;

/**
 * Content statuses that still wait for someone (the badge counts only
 * these): the approvals list without `reviewed`. A reviewed row is done with
 * its review; whether it was also released is read from its hand-offs.
 */
export const OPEN_REVIEW_STATUSES = [
  "review",
  "needs_review",
  "draft",
  "blocked",
  "pending_approval",
] as const;

/**
 * Where a content row belongs on the approvals page (WP3, 2026-11-10):
 *
 * - `open`: waits for a review or a release (the badge counts these).
 * - `reviewed`: reviewed, but nothing was handed on (no publication, no
 *   Postiz draft).
 * - `released`: a publication or Postiz draft that is not canceled or
 *   failed holds it (scheduled, held in Social, handed over).
 * - `cleanup`: an assignment draft whose slot passed (D-2): it can never be
 *   released, only rejected or archived.
 * - `history`: replaced (a revision or a retried run), closed (rejected,
 *   archived) or published.
 *
 * Derived at read time from the row and its hand-offs; nothing is written,
 * so a released row's version (bound by its package hash) never changes.
 */
export type ApprovalLane = "open" | "reviewed" | "released" | "cleanup" | "history";

/** A publication or Postiz draft of the content, as the lane reads it. */
export type LaneHandoff = {
  kind: "publication" | "postiz_draft";
  status: unknown;
};

// Over: they hold nothing any more (content-decisions.ts DONE_*).
const DONE_HANDOFF = ["canceled", "failed"];
const PUBLISHED = ["published", "published_test"];

/** The lane of one content row; first match wins (see ApprovalLane). */
export function approvalLane(
  content: Record<string, unknown>,
  context: { handoffs?: readonly LaneHandoff[]; expired?: boolean } = {},
): ApprovalLane {
  // Replaced: a revision superseded it or the owner retried its run.
  if (content.supersededBy || content.retiredWithRunId) return "history";
  if (content.status === "rejected" || content.status === "archived")
    return "history";
  const active = (context.handoffs ?? []).filter(
    (h) => !DONE_HANDOFF.includes(String(h.status)),
  );
  if (active.length)
    return active.some(
      (h) => h.kind === "publication" && PUBLISHED.includes(String(h.status)),
    )
      ? "history"
      : "released";
  if (content.status === "reviewed") return "reviewed";
  if (context.expired) return "cleanup";
  return "open";
}

/** The original a channel copy was made from (R76), else the row itself. */
export function baseContentId(row: { id: string; data: unknown }): string {
  const shared = (row.data as { sharedFrom?: { contentId?: unknown } } | null)
    ?.sharedFrom?.contentId;
  return typeof shared === "string" ? shared : row.id;
}

/**
 * Whether a publication is a post a project pause stopped that can still be
 * scheduled again: blocked by the pause and its slot still ahead.
 */
export function isPausedPost(
  publication: Record<string, unknown>,
  now: Date,
): boolean {
  return (
    publication.status === "blocked_dependency" &&
    publication.reason === "PROJECT_PAUSED" &&
    Date.parse(String(publication.scheduledAt)) > now.getTime()
  );
}

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

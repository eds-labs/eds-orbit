/**
 * The content statuses the approvals page lists: the old drafts an owner
 * cleanup archives. The web keeps its own copy (approvals filter); a web test
 * asserts both lists are equal. Kept free of imports for that test.
 */
export const DRAFT_STATUSES = [
  "review",
  "needs_review",
  "reviewed",
  "draft",
  "blocked",
  "pending_approval",
] as const;

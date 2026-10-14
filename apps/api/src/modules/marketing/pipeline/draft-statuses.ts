/**
 * The content statuses the approvals page lists: the old drafts an owner
 * cleanup archives. The web keeps its own copies of these lists (approvals
 * filter, dialog texts); a web test asserts they are equal. Kept free of
 * imports for that test.
 */
export const DRAFT_STATUSES = [
  "review",
  "needs_review",
  "reviewed",
  "draft",
  "blocked",
  "pending_approval",
] as const;

/** Why a draft is kept by the cleanup. */
export const KEEP_REASONS = [
  "HAS_OPEN_PUBLICATION",
  "HAS_OPEN_POSTIZ_DRAFT",
  "PENDING_DECISION",
  "ACTIVE_ASSIGNMENT_RUN",
] as const;
/** Why a ready mission stays, first match in this order. */
export const MISSION_KEEP_REASONS = [
  "ACTIVE_RUN",
  "BATCH_RUNNING",
  "ACTIVE_JOB",
  "NO_CONTENT",
  "KEPT_CONTENT",
  "UNSETTLED_CONTENT",
] as const;

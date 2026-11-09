/**
 * How far a piece of content got on its way out, for readers that would
 * otherwise see only a mission or content status: `completed` on a mission
 * means its drafts are done, and `reviewed` on content means its text passed
 * review. Neither says anything about delivery. Derived from the stored
 * publication, never stored itself.
 */
export type DeliveryState =
  | "generated"
  | "awaiting_approval"
  | "rejected"
  | "approved"
  | "handoff_pending"
  | "scheduled"
  | "published"
  | "failed"
  | "canceled";

export type Delivery = { state: DeliveryState; errorCode: string | null };

const FAILED = ["failed", "blocked_dependency", "outcome_unknown"];

export function deliveryOf(
  content: Record<string, any>,
  publication: Record<string, any> | null,
  onSocial: boolean,
): Delivery {
  if (!publication) {
    if (["rejected", "archived", "deleted"].includes(content.status))
      return { state: "rejected", errorCode: null };
    if (content.status === "needs_review")
      return { state: "awaiting_approval", errorCode: null };
    return {
      state: content.status === "reviewed" ? "approved" : "generated",
      errorCode: null,
    };
  }
  const p = publication;
  if (["published", "published_test"].includes(p.status))
    return { state: "published", errorCode: null };
  if (p.status === "canceled") return { state: "canceled", errorCode: null };
  if (FAILED.includes(p.status))
    return {
      state: "failed",
      errorCode: String(p.reason ?? p.blockers?.[0] ?? p.status),
    };
  if (p.status === "scheduled_remote")
    return { state: "scheduled", errorCode: null };
  if (!onSocial) return { state: "approved", errorCode: null };
  return typeof p.socialPostId === "string"
    ? { state: "scheduled", errorCode: null }
    : {
        state: "handoff_pending",
        errorCode:
          p.socialHold?.state === "failed" ? String(p.socialHold.code) : null,
      };
}

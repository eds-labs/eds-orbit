import { SocialError, type DeliveryOutcome } from "@opencoredev/social-sdk";
import type { SendResult } from "./registry.ts";

// From the SDK's answers to the dispatcher's three cases (ADR 0020 §7):
// published, failed (the provider says nothing was posted) and unknown
// (maybe posted). An unknown result is never sent again automatically.

const codeOf = (code: string) =>
  code === "rate_limited" ? "SOCIAL_RATE_LIMITED" : `SOCIAL_PROVIDER_${code.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
const MAYBE_SENT = new Set(["ambiguous_outcome", "timeout", "cancelled"]);

/** A thrown SDK error as a send result; anything else is unknown. */
export function resultFromSocialError(error: unknown): SendResult {
  if (!(error instanceof SocialError)) return { kind: "unknown", code: "SOCIAL_PROVIDER_UNKNOWN" };
  const disposition = error.retryDisposition;
  if (disposition.kind === "reconcile-first" || MAYBE_SENT.has(error.code))
    return { kind: "unknown", code: codeOf(error.code) };
  if (disposition.kind === "after-delay")
    return { kind: "failed", code: codeOf(error.code), retry: "after-delay", delayMs: disposition.delayMs };
  if (disposition.kind === "after-reconnect")
    return { kind: "failed", code: "SOCIAL_ACCOUNT_RECONNECT_REQUIRED", retry: "after-reconnect" };
  return { kind: "failed", code: codeOf(error.code), retry: "never" };
}

/** A returned SDK outcome as a send result (the caller adds permalinks). */
export function resultFromOutcome(outcome: DeliveryOutcome): SendResult {
  switch (outcome.state) {
    case "published":
      return { kind: "published", externalPostId: outcome.post.postId, permalink: outcome.url ?? null };
    case "processing":
    case "accepted":
    case "scheduled":
      return { kind: "processing", providerState: {} };
    case "failed":
      return resultFromSocialError(
        new SocialError({ code: outcome.code as never, operation: "posts.publish", message: outcome.message, retryDisposition: outcome.retryDisposition }),
      );
    case "not-submitted":
      return { kind: "failed", code: `SOCIAL_NOT_SUBMITTED_${outcome.reason.toUpperCase().replace(/-/g, "_")}`, retry: "never" };
    default:
      return { kind: "unknown", code: "SOCIAL_PROVIDER_UNKNOWN" };
  }
}

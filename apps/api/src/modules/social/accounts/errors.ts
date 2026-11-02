import { SocialError } from "@opencoredev/social-sdk";
import { ConnectorError } from "../../../../../../packages/connectors/src/index.ts";
import { DomainError } from "../../../shared.ts";

// Provider failures become social error codes. Provider messages and
// details are dropped: they may echo a request, a code or a token.

export function providerFailure(error: unknown, lastStatus?: number): DomainError {
  if (error instanceof DomainError) return error;
  if (lastStatus === 401 && error instanceof SocialError && error.code === "reconnect_required")
    return new DomainError("SOCIAL_APP_INVALID", 409);
  if (error instanceof SocialError) {
    switch (error.code) {
      case "cancelled":
        return new DomainError("SOCIAL_OAUTH_CANCELLED", 409);
      case "rate_limited":
        return new DomainError("SOCIAL_RATE_LIMITED", 429);
      // A 401 at a token endpoint refuses the client (the developer app),
      // not the account; so do a forbidden or misconfigured app.
      case "reconnect_required":
        return error.upstreamStatus === 401
          ? new DomainError("SOCIAL_APP_INVALID", 409)
          : new DomainError("SOCIAL_PROVIDER_REJECTED", 409);
      case "missing_permission":
      case "invalid_config":
        return new DomainError("SOCIAL_APP_INVALID", 409);
      case "upstream_failure":
        // A client error (e.g. X's 400 invalid_request for a used code or
        // a revoked token) is a refusal, not an outage.
        return rejectedStatus(error.upstreamStatus)
          ? new DomainError("SOCIAL_PROVIDER_REJECTED", 409)
          : new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
      case "invalid_input":
      case "unauthorized":
      case "not_found":
      case "gone":
      case "ineligible_account":
        return new DomainError("SOCIAL_PROVIDER_REJECTED", 409);
      default:
        return new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
    }
  }
  if (error instanceof ConnectorError) {
    if (error.code === "RATE_LIMITED" || error.status === 429) return new DomainError("SOCIAL_RATE_LIMITED", 429);
    return error.code === "PROVIDER_AUTH" || rejectedStatus(error.status)
      ? new DomainError("SOCIAL_PROVIDER_REJECTED", 409)
      : new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
  }
  return new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
}

/** A 4xx answer other than a timeout or a rate limit. */
function rejectedStatus(status: number | undefined) {
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** A non-2xx provider response as a social error. */
export function responseFailure(response: Response): DomainError {
  return response.status === 401 || response.status === 403 || response.status === 400
    ? new DomainError("SOCIAL_PROVIDER_REJECTED", 409)
    : response.status === 429
      ? new DomainError("SOCIAL_RATE_LIMITED", 429)
      : new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
}

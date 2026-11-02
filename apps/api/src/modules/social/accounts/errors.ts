import { SocialError } from "@opencoredev/social-sdk";
import { ConnectorError } from "../../../../../../packages/connectors/src/index.ts";
import { DomainError } from "../../../shared.ts";

// Provider failures become social error codes. Provider messages and
// details are dropped: they may echo a request, a code or a token.

export function providerFailure(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  if (error instanceof SocialError) {
    switch (error.code) {
      case "cancelled":
        return new DomainError("SOCIAL_OAUTH_CANCELLED", 409);
      case "rate_limited":
        return new DomainError("SOCIAL_RATE_LIMITED", 429);
      case "upstream_failure": {
        // A client error (e.g. X's 400 invalid_request for a used code or
        // a revoked token) is a refusal, not an outage.
        const status = error.upstreamStatus ?? 0;
        return status >= 400 && status < 500 && status !== 408 && status !== 429
          ? new DomainError("SOCIAL_PROVIDER_REJECTED", 409)
          : new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
      }
      case "timeout":
      case "ambiguous_outcome":
        return new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
      default:
        return new DomainError("SOCIAL_PROVIDER_REJECTED", 409);
    }
  }
  if (error instanceof ConnectorError)
    return error.status === 401 || error.status === 403 || error.code === "PROVIDER_AUTH"
      ? new DomainError("SOCIAL_PROVIDER_REJECTED", 409)
      : new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
  return new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
}

/** A non-2xx provider response as a social error. */
export function responseFailure(response: Response): DomainError {
  return response.status === 401 || response.status === 403 || response.status === 400
    ? new DomainError("SOCIAL_PROVIDER_REJECTED", 409)
    : response.status === 429
      ? new DomainError("SOCIAL_RATE_LIMITED", 429)
      : new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
}

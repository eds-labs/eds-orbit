import { describe, expect, it } from "vitest";
import { SocialError } from "@opencoredev/social-sdk";
import { ConnectorError } from "../../../packages/connectors/src/index.ts";
import { providerFailure } from "../src/modules/social/accounts/errors.ts";

const sdk = (code: ConstructorParameters<typeof SocialError>[0]["code"], upstreamStatus?: number) =>
  new SocialError({ code, operation: "oauth.refresh", message: "provider detail", ...(upstreamStatus ? { upstreamStatus } : {}) });
const codeOf = (error: unknown) => providerFailure(error).code;

// Which provider failures concern one account (reconnect) and which concern
// the developer app or an outage (no account changes) (ADR 0020, S2 review).
describe("social provider failures", () => {
  it("treats a refused client (401 at the token endpoint) and a forbidden or misconfigured app as an app problem", () => {
    expect(codeOf(sdk("reconnect_required", 401))).toBe("SOCIAL_APP_INVALID");
    expect(codeOf(sdk("missing_permission", 403))).toBe("SOCIAL_APP_INVALID");
    expect(codeOf(sdk("invalid_config"))).toBe("SOCIAL_APP_INVALID");
  });

  it("treats a revoked grant and other 4xx answers as a refusal of the account", () => {
    expect(codeOf(sdk("reconnect_required", 400))).toBe("SOCIAL_PROVIDER_REJECTED");
    expect(codeOf(sdk("upstream_failure", 400))).toBe("SOCIAL_PROVIDER_REJECTED");
    expect(codeOf(sdk("unauthorized"))).toBe("SOCIAL_PROVIDER_REJECTED");
  });

  it("treats unknown and transient failures as an outage", () => {
    expect(codeOf(sdk("runtime_unsupported"))).toBe("SOCIAL_PROVIDER_UNAVAILABLE");
    expect(codeOf(sdk("upstream_failure", 503))).toBe("SOCIAL_PROVIDER_UNAVAILABLE");
    expect(codeOf(sdk("timeout"))).toBe("SOCIAL_PROVIDER_UNAVAILABLE");
    expect(codeOf(sdk("rate_limited", 429))).toBe("SOCIAL_RATE_LIMITED");
  });

  it("treats a connector's 400 answer as a refusal, not an outage", () => {
    expect(codeOf(new ConnectorError("PROVIDER_REJECTED", "rejected", false, 400))).toBe("SOCIAL_PROVIDER_REJECTED");
    expect(codeOf(new ConnectorError("PROVIDER_AUTH", "rejected", false, 401))).toBe("SOCIAL_PROVIDER_REJECTED");
    expect(codeOf(new ConnectorError("NETWORK_ERROR", "not_sent", true))).toBe("SOCIAL_PROVIDER_UNAVAILABLE");
    expect(codeOf(new ConnectorError("PROVIDER_REJECTED", "rejected", true, 502))).toBe("SOCIAL_PROVIDER_UNAVAILABLE");
  });

  it("never carries the provider's message", () => {
    expect(providerFailure(sdk("unauthorized")).message).not.toContain("provider detail");
  });
});

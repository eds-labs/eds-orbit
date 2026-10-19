import { describe, expect, it } from "vitest";
import { acceptedScopes } from "../connect/oauth-flow";

describe("MCP 2.0 explicit sensitive consent", () => {
  it("keeps new execute/customer-content scopes unchecked unless the user chooses each", () => {
    const requested = [
      "openid",
      "orbit:read",
      "orbit:propose",
      "orbit:write",
      "orbit:support",
    ];
    expect(acceptedScopes(requested, true)).toEqual([
      "openid",
      "orbit:read",
      "orbit:propose",
    ]);
    expect(acceptedScopes(requested, true, ["orbit:support"])).toEqual([
      "openid",
      "orbit:read",
      "orbit:propose",
      "orbit:support",
    ]);
    expect(acceptedScopes(requested, false, ["orbit:write"])).toEqual([
      "openid",
      "orbit:read",
      "orbit:write",
    ]);
  });
});

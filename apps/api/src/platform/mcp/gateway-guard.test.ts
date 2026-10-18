import { describe, expect, it } from "vitest";
import {
  assertMcpGatewayEnabled,
  parseAllowedOrigins,
} from "./gateway-guard.ts";

describe("MCP gateway start guard (WP-M2)", () => {
  it("starts only with the gateway and the OAuth server both on", () => {
    expect(() =>
      assertMcpGatewayEnabled({
        ORBIT_MCP_GATEWAY: "true",
        ORBIT_MCP_OAUTH: "true",
      }),
    ).not.toThrow();
  });
  it("refuses when the gateway flag is off, naming the flag", () => {
    expect(() =>
      assertMcpGatewayEnabled({
        ORBIT_MCP_GATEWAY: "false",
        ORBIT_MCP_OAUTH: "true",
      }),
    ).toThrow("ORBIT_MCP_GATEWAY");
  });
  it("refuses when the OAuth server is off, naming the flag", () => {
    expect(() =>
      assertMcpGatewayEnabled({
        ORBIT_MCP_GATEWAY: "true",
        ORBIT_MCP_OAUTH: "false",
      }),
    ).toThrow("ORBIT_MCP_OAUTH");
  });
  it("names both flags when both are off", () => {
    expect(() =>
      assertMcpGatewayEnabled({
        ORBIT_MCP_GATEWAY: "false",
        ORBIT_MCP_OAUTH: "false",
      }),
    ).toThrow(/ORBIT_MCP_GATEWAY.*ORBIT_MCP_OAUTH/);
  });
  it("parses the allowed origins as a trimmed comma list of origins", () => {
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(
      parseAllowedOrigins(" https://a.example/ , https://b.example:8443 ,,"),
    ).toEqual(["https://a.example", "https://b.example:8443"]);
  });
  it("rejects an entry that is not an origin", () => {
    expect(() => parseAllowedOrigins("https://a.example/path")).toThrow(
      "ORBIT_MCP_ALLOWED_ORIGINS",
    );
    expect(() => parseAllowedOrigins("not a url")).toThrow(
      "ORBIT_MCP_ALLOWED_ORIGINS",
    );
    expect(() => parseAllowedOrigins("ftp://a.example")).toThrow(
      "ORBIT_MCP_ALLOWED_ORIGINS",
    );
  });
});

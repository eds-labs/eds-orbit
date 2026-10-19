/**
 * Start guard and origin list of the MCP gateway process (Track M, WP-M2).
 * The gateway is a separate process; this keeps it from serving half-configured.
 */
import type { Config } from "../../../../../packages/config/src/index.ts";

/** True when the gateway flag and the OAuth server flag are both "true". */
export function mcpGatewayEnabled(
  config: Pick<Config, "ORBIT_MCP_GATEWAY" | "ORBIT_MCP_OAUTH">,
): boolean {
  return (
    config.ORBIT_MCP_GATEWAY === "true" && config.ORBIT_MCP_OAUTH === "true"
  );
}

/**
 * Throws unless the gateway flag and the OAuth server flag are both "true".
 * `buildMcpServer` calls it, so the real gateway never builds half-configured;
 * `mcp-main.ts` decides with `mcpGatewayEnabled` first and serves a
 * health-only app while a flag is off (bootstrap.ts).
 */
export function assertMcpGatewayEnabled(
  config: Pick<Config, "ORBIT_MCP_GATEWAY" | "ORBIT_MCP_OAUTH">,
): void {
  const missing = (["ORBIT_MCP_GATEWAY", "ORBIT_MCP_OAUTH"] as const).filter(
    (flag) => config[flag] !== "true",
  );
  if (missing.length)
    throw new Error(
      `MCP gateway disabled: set ${missing.join(" and ")} to "true" to start it`,
    );
}

/** `ORBIT_MCP_ALLOWED_ORIGINS` as a list of origins (no path), trailing slashes ignored. */
export function parseAllowedOrigins(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      let url: URL;
      try {
        url = new URL(entry);
      } catch {
        throw new Error(`ORBIT_MCP_ALLOWED_ORIGINS: "${entry}" is not a URL`);
      }
      if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.origin + (entry.endsWith("/") ? "/" : "") !== entry
      )
        throw new Error(
          `ORBIT_MCP_ALLOWED_ORIGINS: "${entry}" is not an http(s) origin`,
        );
      return url.origin;
    });
}

import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { filesConfig } from "../files/files.ts";

// What the environment provides, for the system integrations page: names and
// booleans only. A URL, host, key id or count would leak the layout of the
// deployment, so nothing but "is it there" is ever reported.

export type EnvironmentStatus = {
  redis: { configured: boolean; reachable: boolean };
  files: { configured: boolean };
  googleDriveApp: { configured: boolean };
  aiFallbackKeys: { openai: boolean; anthropic: boolean };
  credentialKeys: { ring: boolean };
  mcp: {
    oauth: boolean;
    gateway: boolean;
    dcr: boolean;
    tasks: boolean;
    proposals: boolean;
    projectConfiguration: boolean;
    projectAdministration: boolean;
  };
  connectionsCutover: string[];
};

/**
 * Pure over the environment and its one input: Redis reachability comes from
 * the runtime health read the overview already performs, so no probe is added.
 */
export function environmentStatus(input: { redisReachable: boolean }): EnvironmentStatus {
  const c = loadConfig();
  const redisConfigured = Boolean(c.REDIS_URL);
  return {
    redis: { configured: redisConfigured, reachable: redisConfigured && input.redisReachable },
    files: { configured: filesConfig() !== null },
    googleDriveApp: {
      configured: Boolean(c.GOOGLE_DRIVE_CLIENT_ID && c.GOOGLE_DRIVE_CLIENT_SECRET),
    },
    aiFallbackKeys: { openai: Boolean(c.OPENAI_API_KEY), anthropic: Boolean(c.ANTHROPIC_API_KEY) },
    credentialKeys: { ring: Boolean(c.CREDENTIAL_KEYS) },
    mcp: {
      oauth: c.ORBIT_MCP_OAUTH === "true",
      gateway: c.ORBIT_MCP_GATEWAY === "true",
      dcr: c.ORBIT_MCP_DCR === "true",
      tasks: c.ORBIT_MCP_TASKS === "true",
      proposals: c.ORBIT_MCP_PROPOSALS === "true",
      projectConfiguration: c.ORBIT_MCP_PROJECT_CONFIGURATION === "true",
      projectAdministration: c.ORBIT_MCP_PROJECT_ADMINISTRATION === "true",
    },
    connectionsCutover: (c.ORBIT_CONNECTIONS_CUTOVER ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  };
}

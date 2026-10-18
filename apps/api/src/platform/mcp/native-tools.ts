/**
 * Gateway-native MCP tools (Track M, WP-M2 D-M2-4, WP-M3): workspace-level
 * tools that are not registry tools: `orbit_projects`, `orbit_profile`,
 * `search` and `fetch` (in native/). Module tools reach MCP only through the
 * adapter and `exposure.mcp`.
 */
import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod";
import type { ToolRisk } from "../../modules/agents/tools/registry.ts";
import { fetchTool } from "./native/fetch.ts";
import { orbitProfile } from "./native/profile.ts";
import { orbitProjects } from "./native/projects.ts";
import { searchTool } from "./native/search.ts";
import type { McpPrincipal } from "./principal.ts";

export { orbitProjects };

/**
 * What the gateway hands a native tool besides the principal and the parsed
 * arguments (Track M, WP-M3). A project-bound native names its project first
 * (`setAuditProject`, or `startRun` which does so too); a project outside the
 * grant is ignored, so the call is then logged without a project.
 */
export type NativeToolContext = {
  requestId: string;
  /** Unique per call: the nonce of per-call keys (budget reservations). */
  callId: string;
  clientId: string;
  grantId: string;
  /** The `mcp` AgentRun of this call once `startRun` created it. */
  readonly agentRunId: string | null;
  /** Attributes the call (audit row, run) to a project of the grant. */
  setAuditProject(projectId: string): void;
  /**
   * Starts the call's AgentRun in the project, before any work. Null when the
   * project is not one of the grant's or the run cannot be created
   * (telemetry is best effort); the call goes on either way.
   */
  startRun(projectId: string): Promise<string | null>;
  log: FastifyBaseLogger;
};

export type NativeTool = {
  name: string;
  description: string;
  risk: ToolRisk;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodObject;
  /** Merged into the tool definition's `_meta` (for example `openai/profile`). */
  meta?: Record<string, unknown>;
  run(
    principal: McpPrincipal,
    args: Record<string, unknown>,
    ctx: NativeToolContext,
  ): Promise<unknown>;
};

export const nativeTools: readonly NativeTool[] = [
  orbitProjects,
  orbitProfile,
  searchTool,
  fetchTool,
];

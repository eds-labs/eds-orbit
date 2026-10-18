/**
 * Gateway-native MCP tools (Track M, WP-M2, D-M2-4): workspace-level tools
 * that need no project scope and are not registry tools. `orbit_projects`
 * now; `orbit_profile`, `search` and `fetch` follow in WP-M3. Module tools
 * reach MCP only through the adapter and `exposure.mcp`.
 */
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { authDb } from "../../../../../packages/db/src/index.ts";
import type { ToolRisk } from "../../modules/agents/tools/registry.ts";
import { DomainError } from "../shared.ts";
import { projectScope, type McpPrincipal } from "./principal.ts";
import { principalModules } from "./visibility.ts";

/**
 * What the gateway hands a native tool besides the principal and the parsed
 * arguments (Track M, WP-M3). A project-bound native names its project first
 * (`setAuditProject`, or `startRun` which does so too); a project outside the
 * grant is ignored, so the call is then logged without a project.
 */
export type NativeToolContext = {
  requestId: string;
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

const projectsOutput = z
  .object({
    workspace: z.object({ id: z.string(), name: z.string() }).strict(),
    projects: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          modules: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * The granted workspace and the granted projects the user is still a member
 * of, in name order, each with the modules the principal may use there.
 */
export const orbitProjects: NativeTool = {
  name: "orbit_projects",
  description:
    "List the Orbit workspace and projects this connection may use, with each project's modules. Pass a project's id as projectId to the other tools.",
  risk: "R0_read",
  inputSchema: z.object({}).strict(),
  outputSchema: projectsOutput,
  async run(principal) {
    const workspace = await authDb.workspace.findUnique({
      where: { id: principal.workspaceId },
      select: { id: true, name: true },
    });
    if (!workspace) throw new DomainError("NOT_FOUND", 404);
    const rows = await authDb.project.findMany({
      where: {
        workspaceId: principal.workspaceId,
        id: { in: [...principal.projectIds] },
      },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    const projects = [];
    for (const row of rows) {
      // Membership is read again per project; a project lost since the
      // principal was resolved is left out, never reported.
      const scope = await projectScope(principal, row.id).catch(
        (error: unknown) => {
          if (error instanceof DomainError && error.code === "NOT_FOUND")
            return null;
          throw error;
        },
      );
      if (!scope) continue;
      projects.push({
        id: row.id,
        name: row.name,
        modules: await principalModules(principal, scope),
      });
    }
    return { workspace, projects };
  },
};

export const nativeTools: readonly NativeTool[] = [orbitProjects];

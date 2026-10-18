/**
 * Gateway-native MCP tools (Track M, WP-M2, D-M2-4): workspace-level tools
 * that need no project scope and are not registry tools. `orbit_projects`
 * now; `orbit_profile`, `search` and `fetch` follow in WP-M3. Module tools
 * reach MCP only through the adapter and `exposure.mcp`.
 */
import { z } from "zod";
import { authDb } from "../../../../../packages/db/src/index.ts";
import type { ToolRisk } from "../../modules/agents/tools/registry.ts";
import { DomainError } from "../shared.ts";
import { projectScope, type McpPrincipal } from "./principal.ts";
import { principalModules } from "./visibility.ts";

export type NativeTool = {
  name: string;
  description: string;
  risk: ToolRisk;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodObject;
  run(principal: McpPrincipal): Promise<unknown>;
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

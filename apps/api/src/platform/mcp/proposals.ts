import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { hash } from "../shared.ts";
import { recordGrantEvent } from "../mcp-auth/events.ts";

/**
 * Shared pieces of the MCP proposal tools (Track M, WP-M4). A proposal is a
 * pending ActionRequest; the module's own service creates it and the
 * decision stays in Orbit. These helpers only name the client's call.
 */

/**
 * The dedupe key of one proposal (D-M4-4): the MCP tool name, the project
 * and the arguments as the service normalized them, so a retry that spells
 * out a default matches. Only the hash is stored, never the values.
 */
export function mcpProposalArgsHash(
  tool: string,
  projectId: string,
  args: unknown,
): string {
  return hash({ tool, projectId, args });
}

/** Where the owner decides (D-M4-5): the project's approval inbox; no per-request link exists. */
export function mcpApproveUrl(projectId: string): string {
  return `${new URL(loadConfig().APP_ORIGIN).origin}/p/${encodeURIComponent(projectId)}/approvals`;
}

/**
 * Records one created proposal on the grant (`mcp.proposal`); deduplicated
 * calls are not recorded. Identifiers only, never arguments.
 */
export async function recordMcpProposal(input: {
  userId: string;
  clientId: string;
  grantId: string;
  workspaceId: string;
  actionType: string;
  actionRequestId: string;
}): Promise<void> {
  await recordGrantEvent({
    action: "mcp.proposal",
    userId: input.userId,
    clientId: input.clientId,
    grantId: input.grantId,
    workspaceId: input.workspaceId,
    detail: {
      actionType: input.actionType,
      actionRequestId: input.actionRequestId,
    },
  });
}

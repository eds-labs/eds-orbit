/**
 * The native MCP `orbit_action_status` tool (Track M, WP-M4, D-M4-12): lets a
 * client poll the state of a proposal it made. It answers for requests the
 * calling user made through the calling client in this workspace only (also
 * those of a grant a re-selection replaced) and never leaves anything
 * internal in the answer. It
 * does not depend on ORBIT_MCP_PROPOSALS, so a client can still see how its
 * proposals ended after the switch was turned off.
 */
import { z } from "zod";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import {
  MCP_ACTION_STATUSES,
  mcpActionRequestStatus,
} from "../../../modules/action-requests.ts";
import type { NativeTool } from "../native-tools.ts";
import { projectScope } from "../principal.ts";
import { mcpApproveUrl } from "../proposals.ts";

const statusInput = z
  .object({ projectId: z.uuid(), actionRequestId: z.uuid() })
  .strict();

const statusOutput = z
  .object({
    actionRequestId: z.string(),
    actionType: z.string(),
    status: z.enum(MCP_ACTION_STATUSES),
    createdAt: z.string(),
    expiresAt: z.string(),
    decidedAt: z.string().nullable(),
    approveUrl: z.string(),
  })
  .strict();

export const actionStatusTool: NativeTool = {
  name: "orbit_action_status",
  description:
    "Check the state of a proposal this connection made (pending, approved, rejected, consumed, canceled or expired), with the link where the owner decides.",
  risk: "R0_read",
  inputSchema: statusInput,
  outputSchema: statusOutput,
  async run(principal, args, ctx) {
    const { projectId, actionRequestId } = statusInput.parse(args);
    // Audited in the project only when it is one of the grant's.
    ctx.setAuditProject(projectId);
    // 404 NOT_FOUND for a project outside the grant, like every other miss.
    const scope = await projectScope(principal, projectId);
    // The read locks the project: inside one of its slots (R-10).
    const status = await ctx.withProjectSlot(projectId, () =>
      scoped(scope.workspaceId, scope.projectId, (tx) =>
        mcpActionRequestStatus(tx, scope, actionRequestId, {
          userId: principal.userId,
          clientId: principal.clientId,
        }),
      ),
    );
    return { ...status, approveUrl: mcpApproveUrl(projectId) };
  },
};

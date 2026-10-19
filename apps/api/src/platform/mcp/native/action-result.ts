import { z } from "zod";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import { mcpActionRequestStatus } from "../../../modules/action-requests.ts";
import {
  registeredActionType,
  registeredActionTypeOwner,
} from "../../modules/contributions.ts";
import { data, entity, DomainError } from "../../shared.ts";
import { projectScope } from "../principal.ts";
import { principalModules } from "../visibility.ts";
import { mcp2Enabled } from "../../tasks/operation-tools.ts";
import type { NativeTool } from "../native-tools.ts";

const input = z
  .object({ projectId: z.uuid(), actionRequestId: z.uuid() })
  .strict();
export const actionResult: NativeTool = {
  name: "orbit_get_action_result",
  available: mcp2Enabled,
  risk: "R0_read",
  description:
    "Read the durable execution receipt/result of this connection's exact approved operation. Approval in Orbit executes or queues it once. A pending, rejected, expired or canceled request never executes through this read.",
  inputSchema: input,
  outputSchema: z
    .object({
      schemaVersion: z.literal(1),
      actionRequestId: z.string(),
      status: z.string(),
      result: z.unknown(),
    })
    .strict(),
  async run(p, raw, ctx) {
    const args = input.parse(raw);
    ctx.setAuditProject(args.projectId);
    const scope = await projectScope(p, args.projectId);
    const modules = await principalModules(p, scope);
    return ctx.withProjectSlot(args.projectId, () =>
      scoped(scope.workspaceId, scope.projectId, async (tx) => {
        const status = await mcpActionRequestStatus(
          tx,
          scope,
          args.actionRequestId,
          p,
        );
        const row = await entity(
          tx,
          scope,
          "action_requests",
          args.actionRequestId,
        );
        const d = data(row);
        const owner = registeredActionTypeOwner(d.actionType);
        const def = registeredActionType(d.actionType);
        if (
          (owner && owner !== "platform" && !modules.includes(owner)) ||
          (def?.mcpScopes ?? []).some((s) => !p.scopes.has(s))
        )
          throw new DomainError("NOT_FOUND", 404);
        return {
          schemaVersion: 1,
          actionRequestId: row.id,
          status: status.status,
          result:
            d.executionResult == null
              ? null
              : def?.executionResult
                ? await def.executionResult(tx, scope, row)
                : d.executionResult,
        };
      }),
    );
  },
};

/** Module-owned typed adapters: service calls stay inside their native transaction. */
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
import {
  defineTool,
  type ToolContext,
} from "../../modules/agents/tools/registry.ts";
import {
  createActionRequest,
  decideActionRequest,
  type ActionDefinition,
  type RequestedBy,
} from "../../modules/action-requests.ts";
import { userScoped } from "../tenancy/scope.ts";
import { actorScope } from "../tenancy/member-scope.ts";
import { moduleScope } from "../tenancy/module-roles.ts";
import { authorize, can, PROJECT_OWN } from "../tenancy/permissions.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { audit, data, DomainError, entity, hash, update } from "../shared.ts";
import {
  mcpRequester,
  mcpProposalOrigin,
  mcpApproveUrl,
} from "../mcp/proposals.ts";
import { moduleAvailable } from "../modules/contributions.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";

type Operation = {
  name: string;
  module: string;
  description: string;
  input: z.ZodObject;
  permission: PermissionDef;
  sensitive?: boolean;
  /** Code-owned, default-off standing authorization for this owner's MCP calls only. */
  ownerMcpAutoApproval?(
    tx: DbTx,
    scope: Scope,
  ): Promise<{ settingsVersion: number } | null>;
  mcpProjectRequired?: boolean;
  output?: z.ZodType;
  validate?(tx: DbTx, scope: Scope, args: any): Promise<void>;
  approvalContext?(tx: DbTx, scope: Scope, args: any): Promise<unknown>;
  revalidateContext?(
    tx: DbTx,
    scope: Scope,
    args: any,
    saved: unknown,
  ): Promise<void>;
  executionResult?(tx: DbTx, scope: Scope, saved: any): Promise<unknown>;
  spendCeiling?(tx: DbTx, scope: Scope, args: any): Promise<number>;
  run(
    tx: DbTx,
    scope: Scope,
    args: any,
    requester?: RequestedBy,
  ): Promise<unknown>;
};
/** Model strict schemas use null for omitted optional fields; native service schemas retain defaults. */
function modelField(value: z.ZodType): z.ZodType {
  if (value instanceof z.ZodOptional)
    return modelField(value.unwrap() as z.ZodType)
      .nullable()
      .optional();
  if (value instanceof z.ZodDefault)
    return modelField(value.unwrap() as z.ZodType)
      .nullable()
      .optional();
  if (value instanceof z.ZodNullable)
    return modelField(value.unwrap() as z.ZodType).nullable();
  if (value instanceof z.ZodString)
    return value.clone({ ...value.def, checks: [] });
  if (value instanceof z.ZodArray)
    return z.array(modelField(value.element as z.ZodType));
  if (value instanceof z.ZodObject) return modelParameters(value);
  return value;
}
function modelParameters(input: z.ZodObject) {
  return z
    .object(
      Object.fromEntries(
        Object.entries(input.shape).map(([key, value]) => [
          key,
          modelField(value as z.ZodType),
        ]),
      ) as z.ZodRawShape,
    )
    .strict();
}
function normalizeServiceValue(schema: z.ZodType, raw: unknown): unknown {
  if (raw === null && schema.isOptional() && !schema.isNullable())
    return undefined;
  if (raw === null) return raw;
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodNullable
  )
    return normalizeServiceValue(schema.unwrap() as z.ZodType, raw);
  if (schema instanceof z.ZodArray && Array.isArray(raw))
    return raw.map((v) =>
      normalizeServiceValue(schema.element as z.ZodType, v),
    );
  if (
    schema instanceof z.ZodObject &&
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw)
  ) {
    return Object.fromEntries(
      Object.entries(raw).flatMap(([key, value]) => {
        const field = schema.shape[key] as z.ZodType | undefined;
        const parsed = field ? normalizeServiceValue(field, value) : value;
        return parsed === undefined ? [] : [[key, parsed]];
      }),
    );
  }
  return raw;
}
function serviceArgs(input: z.ZodObject, raw: unknown) {
  return input.parse(normalizeServiceValue(input, raw));
}

const envelope = z
  .object({ schemaVersion: z.literal(1), result: z.unknown() })
  .strict();
const proposalOutput = z
  .object({
    actionRequestId: z.string(),
    deduplicated: z.boolean(),
    approveUrl: z.string(),
    status: z.string(),
    requiresApproval: z.boolean(),
    result: z.unknown().optional(),
  })
  .strict();
async function check(tx: DbTx, scope: Scope, op: Operation) {
  if (
    !moduleAvailable(op.module) ||
    !((await enabledModules(tx, scope))?.has(op.module) ?? true)
  )
    throw new DomainError("MODULE_DISABLED", 404);
  authorize(scope, op.permission);
}
export const mcp2Enabled = () => loadConfig().ORBIT_MCP_TASKS === "true";

export function readOperation(op: Operation) {
  return defineTool({
    name: op.name,
    namespace: op.module,
    mcpProjectRequired: op.mcpProjectRequired,
    description: op.description,
    parameters: modelParameters(op.input),
    risk: "R0_read",
    permission: op.permission,
    exposure: { assistant: true, mcp: true },
    outputSchema: op.output ? envelope.extend({ result: op.output }) : envelope,
    deferLoading: true,
    feature: "mcp_tasks",
    ...(op.sensitive ? { mcpScopes: ["orbit:support"] } : {}),
    async execute(ctx, raw) {
      const args = serviceArgs(op.input, raw);
      const result = await userScoped(ctx.scope, async (tx) => {
        await check(tx, ctx.scope, op);
        return op.run(tx, ctx.scope, args);
      });
      const serialized = JSON.parse(JSON.stringify(result));
      return {
        output: {
          schemaVersion: 1,
          result: op.output ? op.output.parse(serialized) : serialized,
        },
        cards: [],
      };
    },
  });
}

export function approvedOperation(op: Operation) {
  const actionType = `${op.module}.mcp.${op.name}`;
  const input = op.input
    .extend({ idempotencyKey: z.string().min(1).max(128) })
    .strict();
  const payload = z
    .object({
      actorId: z.string(),
      args: z.unknown(),
      idempotencyKey: z.string(),
      ceilingMicros: z.number().int().nonnegative(),
      approvalContext: z.unknown().optional(),
    })
    .strict();
  const action: ActionDefinition<z.infer<typeof payload>> = {
    riskClass: "W2",
    approvalMode: "approval_required",
    deciderRole: "owner",
    get mcpProposable() {
      return mcp2Enabled();
    },
    ...(op.sensitive ? { mcpScopes: ["orbit:support"] } : {}),
    ttlMs: 24 * 3600000,
    payload,
    costCeilingMicros: (p) => p.ceilingMicros,
    async revalidate(tx, scope, p) {
      const actor = await actorScope(
        scope.workspaceId,
        scope.projectId,
        p.actorId,
      );
      if (!actor) throw new DomainError("ACTOR_MEMBERSHIP_REQUIRED", 403);
      await check(tx, moduleScope(actor, op.module), op);
      const args = op.input.parse(p.args);
      await op.validate?.(tx, moduleScope(actor, op.module), args);
      await op.revalidateContext?.(
        tx,
        moduleScope(actor, op.module),
        args,
        p.approvalContext,
      );
      if (
        op.spendCeiling &&
        (await op.spendCeiling(tx, moduleScope(actor, op.module), p.args)) >
          p.ceilingMicros
      )
        throw new DomainError("COST_CEILING_CHANGED", 409);
    },
    ...(op.executionResult
      ? {
          executionResult: (tx: DbTx, scope: Scope, row: any) =>
            op.executionResult!(
              tx,
              moduleScope(scope, op.module),
              data(row).executionResult,
            ),
        }
      : {}),
    async onApproved(tx, scope, row) {
      const p = payload.parse(data(row).payload);
      const actor = await actorScope(
        scope.workspaceId,
        scope.projectId,
        p.actorId,
      );
      if (!actor) throw new DomainError("ACTOR_MEMBERSHIP_REQUIRED", 403);
      const asModule = moduleScope(actor, op.module);
      await check(tx, asModule, op);
      await tx.$executeRaw`SELECT set_config('app.user_id',${actor.userId},true)`;
      const args = op.input.parse(p.args);
      await op.validate?.(tx, asModule, args);
      await op.revalidateContext?.(tx, asModule, args, p.approvalContext);
      const result = await op.run(tx, asModule, args, data(row).requestedBy);
      await update(tx, asModule, row, {
        ...data(row),
        status: "consumed",
        executionResult: JSON.parse(JSON.stringify(result)),
        consumedBy: {
          executionId: row.id,
          consumedAt: new Date().toISOString(),
        },
      });
      await audit(tx, asModule, "mcp.operation.executed", row.id, {
        tool: op.name,
      });
    },
  };
  const tool = defineTool({
    name: op.name,
    namespace: op.module,
    mcpProjectRequired: op.mcpProjectRequired,
    description:
      op.description +
      (op.ownerMcpAutoApproval
        ? " Sends without another Orbit approval only when the owner has enabled direct MCP replies and makes the call personally through MCP; otherwise saves an owner approval request. Read requiresApproval/status and the delivery receipt; queued does not mean delivered. Retry with the same idempotencyKey."
        : " Saves an exact owner approval request; executes only after approval in Orbit. Retry with the same idempotencyKey."),
    parameters: modelParameters(input),
    risk: "P_proposal",
    permission: op.permission,
    feature: "mcp_tasks",
    deferLoading: true,
    exposure: { assistant: true, mcp: true },
    outputSchema: proposalOutput,
    ...(op.ownerMcpAutoApproval
      ? { openWorld: true as const, mcpDirectEffect: true as const }
      : {}),
    ...(op.sensitive ? { mcpScopes: ["orbit:support"] } : {}),
    async execute(ctx: ToolContext, raw: unknown) {
      const { idempotencyKey, ...args } = serviceArgs(input, raw);
      const requester: RequestedBy = ctx.channel
        ? mcpRequester(mcpProposalOrigin(ctx, op.name), ctx.scope.projectId, {
            args,
            idempotencyKey,
          })
        : { kind: "agent", userId: ctx.scope.userId, agentRunId: ctx.runId };
      return userScoped(ctx.scope, async (tx) => {
        await check(tx, ctx.scope, op);
        const old = await tx.entity.findFirst({
          where: {
            projectId: ctx.scope.projectId,
            kind: "action_requests",
            AND: [
              { data: { path: ["actionType"], equals: actionType } },
              {
                data: {
                  path: ["payload", "actorId"],
                  equals: ctx.scope.userId,
                },
              },
              {
                data: {
                  path: ["payload", "idempotencyKey"],
                  equals: String(idempotencyKey),
                },
              },
              ...(requester.kind === "mcp"
                ? [
                    {
                      data: {
                        path: ["requestedBy", "clientId"],
                        equals: requester.clientId,
                      },
                    },
                  ]
                : []),
            ],
          },
        });
        if (old && hash(data(old).payload.args) !== hash(args))
          throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", 409);
        if (!old) await op.validate?.(tx, ctx.scope, args);
        const approvalContext =
          !old && op.approvalContext
            ? await op.approvalContext(tx, ctx.scope, args)
            : undefined;
        let row =
          old ??
          (await createActionRequest(tx, ctx.scope, {
            actionType,
            payload: {
              actorId: ctx.scope.userId,
              args,
              idempotencyKey,
              ...(approvalContext === undefined ? {} : { approvalContext }),
              ceilingMicros: op.spendCeiling
                ? await op.spendCeiling(tx, ctx.scope, args)
                : 0,
            },
            requestedBy: requester,
          }));
        // Only new exact proposals by the deciding owner can use the setting.
        // A retry never auto-sends an older pending proposal or executes twice.
        // Delegated/in-app tools have no gateway channel and retain approval.
        const currentActor =
          !old && ctx.channel?.kind === "mcp" && op.ownerMcpAutoApproval
            ? await actorScope(
                ctx.scope.workspaceId,
                ctx.scope.projectId,
                ctx.scope.userId,
              )
            : null;
        const currentOwner = currentActor
          ? moduleScope(currentActor, op.module)
          : null;
        const standingApproval =
          currentOwner && can(currentOwner, PROJECT_OWN)
            ? await op.ownerMcpAutoApproval?.(tx, currentOwner)
            : null;
        if (standingApproval) {
          await decideActionRequest(
            tx,
            currentOwner!,
            row.id,
            {
              version: row.version,
              packageHash: data(row).packageHash,
              decision: "approve",
            },
            {
              channel: "mcp_setting",
              settingsVersion: standingApproval.settingsVersion,
            },
          );
          row = await entity(tx, ctx.scope, "action_requests", row.id);
        }
        const state = data(row);
        const result =
          state.status === "consumed" && op.executionResult
            ? await op.executionResult(tx, ctx.scope, state.executionResult)
            : undefined;
        return {
          output: {
            actionRequestId: row.id,
            deduplicated: Boolean(old),
            approveUrl: mcpApproveUrl(ctx.scope.projectId),
            status: state.status,
            requiresApproval: state.status === "pending",
            ...(result === undefined ? {} : { result }),
          },
          cards: [
            {
              kind: "status" as const,
              label:
                state.status === "consumed"
                  ? op.ownerMcpAutoApproval
                    ? "Reply queued"
                    : "Action completed"
                  : state.status === "pending"
                    ? "Owner approval required"
                    : "Request closed",
              status:
                state.status === "consumed"
                  ? op.ownerMcpAutoApproval
                    ? "queued"
                    : "completed"
                  : state.status === "pending"
                    ? "confirmation_required"
                    : state.status,
            },
          ],
        };
      });
    },
  });
  return { tool, actionType, action };
}

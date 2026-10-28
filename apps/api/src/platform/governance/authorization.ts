import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, data, DomainError, entity } from "../shared.ts";
import { requireSpendMandate } from "../ai/spend-mandate.ts";
import { actorScope } from "../tenancy/member-scope.ts";
import { moduleScope } from "../tenancy/module-roles.ts";
import { can, PROJECT_OWN } from "../tenancy/permissions.ts";
import {
  registeredActionType,
  registeredActionTypeOwner,
} from "../modules/contributions.ts";
import {
  decideActionRequest,
  MANDATABLE_RISK_CLASSES,
  mcpGrantStillProposes,
  type ActionRequestRow,
} from "./action-requests.ts";
import {
  activeMandateRow,
  AGENT_MANDATES,
  agentMandatesEnabled,
  mandateApprovalsToday,
  mandateInForce,
  mandateTerms,
  type AgentMandateRecord,
} from "./agent-mandates.ts";

// The one place that decides whether a new action request runs under an
// agent mandate (ADR 0019 §4). Deterministic and server-side: its inputs are
// the stored request, the code-owned action definition and current records;
// nothing a requester sends can choose a mode, a class or a mandate. The
// assistant and MCP proposals reach it through the same approvedOperation.

export type Authorization =
  | {
      mode: "auto_within_policy";
      mandate: { id: string; version: number };
      grantedBy: string;
    }
  | { mode: "approval_required"; reasons: string[] };

const PAID = ["C1", "C2"];

/**
 * Whether the requester is a channel the mandate covers: the owner's own
 * assistant (`agent`) or a covered MCP client. Delegated work orders (an
 * MCP requester with a task) and every other requester are never covered.
 */
async function requesterReasons(
  scope: Scope,
  row: ActionRequestRow,
  record: AgentMandateRecord,
  mcpScopes: readonly string[] | undefined,
): Promise<string[]> {
  const by = data(row).requestedBy as Record<string, any>;
  if (!record.members.includes(String(by?.userId)))
    return ["REQUESTER_NOT_COVERED"];
  if (by.kind === "agent")
    return record.assistant ? [] : ["CHANNEL_NOT_COVERED"];
  if (by.kind !== "mcp") return ["REQUESTER_NOT_COVERED"];
  if (by.taskId) return ["DELEGATED_TASK_NOT_COVERED"];
  if (!record.mcp) return ["CHANNEL_NOT_COVERED"];
  if (record.mcpClientIds.length && !record.mcpClientIds.includes(by.clientId))
    return ["MCP_CLIENT_NOT_COVERED"];
  const stands = await mcpGrantStillProposes(by as any, scope, row.createdAt, {
    module: registeredActionTypeOwner(String(data(row).actionType)),
    scopes: mcpScopes,
  });
  return stands ? [] : ["MCP_GRANT_ENDED"];
}

/** The grantor's scope in the type's module while they are still an owner there, else null. */
async function ownerScope(
  scope: Pick<Scope, "workspaceId" | "projectId">,
  userId: string,
  module: string,
): Promise<Scope | null> {
  const actor = await actorScope(scope.workspaceId, scope.projectId, userId);
  if (!actor) return null;
  try {
    const own = moduleScope(actor, module);
    return can(own, PROJECT_OWN) ? own : null;
  } catch {
    return null;
  }
}

/**
 * Decides how a pending request may proceed: `auto_within_policy` under
 * the type's mandate in force when every condition of ADR 0019 §4 holds,
 * else `approval_required` with the code of each failed condition. Reads
 * and counts inside `tx`, the project transaction that also decides, so
 * parallel proposals are counted one after the other.
 */
export async function resolveAuthorization(
  tx: DbTx,
  scope: Scope,
  row: ActionRequestRow,
  now = new Date(),
): Promise<Authorization> {
  const d = data(row);
  const actionType = String(d.actionType);
  const type = registeredActionType(actionType);
  const refuse = (...reasons: string[]): Authorization => ({
    mode: "approval_required",
    reasons,
  });
  if (!agentMandatesEnabled()) return refuse("AGENT_MANDATES_DISABLED");
  if (!type?.mandate || !MANDATABLE_RISK_CLASSES.includes(type.riskClass))
    return refuse("ACTION_TYPE_NOT_MANDATABLE");
  if (d.status !== "pending") return refuse("ACTION_REQUEST_NOT_PENDING");
  const mandateRow = await activeMandateRow(tx, scope, actionType);
  if (!mandateRow) return refuse("NO_AGENT_MANDATE");
  const record = data(mandateRow) as AgentMandateRecord;
  if (!mandateInForce(record, now)) return refuse("AGENT_MANDATE_ENDED");
  const reasons: string[] = [];
  const module = registeredActionTypeOwner(actionType) ?? "platform";
  if (!(await ownerScope(scope, record.grantedBy, module)))
    reasons.push("GRANTOR_NOT_OWNER");
  reasons.push(...(await requesterReasons(scope, row, record, type.mcpScopes)));
  const ceiling = Number(d.costCeilingMicros ?? 0);
  if (
    ceiling > record.maxCostMicrosPerAction ||
    ceiling > type.mandate.maxCostMicrosPerAction
  )
    reasons.push("COST_OVER_MANDATE");
  // Paid work needs a spending authority that allows it now; the
  // reservation still enforces every budget at execution (ADR 0015).
  if (PAID.includes(type.riskClass) && ceiling > 0) {
    const spend = await requireSpendMandate(tx, scope).catch(() => null);
    const limits = spend?.limits;
    if (
      !limits?.approvedPaidTests ||
      Date.parse(limits.startAt) > now.getTime() ||
      Date.parse(limits.endAt) <= now.getTime()
    )
      reasons.push("SPEND_AUTHORITY_INACTIVE");
    else if (ceiling > limits.perRunBudgetMicros)
      reasons.push("COST_OVER_RUN_BUDGET");
  }
  if (
    (await mandateApprovalsToday(tx, scope, mandateRow.id, now)) >=
    record.maxActionsPerDay
  )
    reasons.push("AGENT_MANDATE_DAILY_LIMIT");
  try {
    reasons.push(
      ...(type.mandate.check?.(type.payload.parse(d.payload), mandateTerms(record)) ??
        []),
    );
  } catch {
    reasons.push("PAYLOAD_NOT_COVERED");
  }
  if (reasons.length) return refuse(...new Set(reasons));
  return {
    mode: "auto_within_policy",
    mandate: { id: mandateRow.id, version: mandateRow.version },
    grantedBy: record.grantedBy,
  };
}

/**
 * Approves a new request under its type's mandate when
 * `resolveAuthorization` accepts it, through the unchanged
 * `decideActionRequest` (the grantor decides; role, hash, expiry, MCP
 * grant, revalidation and single use all apply). Returns the decision, the
 * request as it is now and, without a mandate, the reasons.
 */
export async function approveUnderMandate(
  tx: DbTx,
  scope: Scope,
  row: ActionRequestRow,
  now = new Date(),
): Promise<{ authorization: Authorization; row: ActionRequestRow }> {
  const authorization = await resolveAuthorization(tx, scope, row, now);
  if (authorization.mode !== "auto_within_policy")
    return { authorization, row };
  const d = data(row);
  const module = registeredActionTypeOwner(String(d.actionType)) ?? "platform";
  const grantor = await ownerScope(scope, authorization.grantedBy, module);
  if (!grantor) throw new DomainError("OWNER_REQUIRED", 403);
  await decideActionRequest(
    tx,
    grantor,
    row.id,
    { version: row.version, packageHash: d.packageHash, decision: "approve" },
    {
      channel: "mandate",
      mandateId: authorization.mandate.id,
      mandateVersion: authorization.mandate.version,
    },
  );
  const by = d.requestedBy as Record<string, any>;
  // Who asked through which channel under which mandate; never the payload.
  await audit(tx, grantor, "action_request.auto_approved", row.id, {
    actionType: d.actionType,
    packageHash: d.packageHash,
    mandateId: authorization.mandate.id,
    mandateVersion: authorization.mandate.version,
    requesterKind: by?.kind,
    requesterId: by?.userId,
    ...(by?.kind === "mcp"
      ? { clientId: by.clientId, grantId: by.grantId }
      : {}),
    costCeilingMicros: d.costCeilingMicros,
  });
  return {
    authorization,
    row: await entity(tx, scope, "action_requests", row.id),
  };
}

/**
 * Whether work approved under `mandateId` may still pay (ADR 0019 §6):
 * mandates are on, this record (not a later replacement) is in force and its
 * grantor is still an owner in `module`. Call
 * it in the reservation transaction; `AGENT_MANDATE_ENDED` otherwise.
 */
export async function assertMandateStillAuthorizes(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  mandateId: string,
  module: string,
  now = new Date(),
) {
  const row = await tx.entity.findFirst({
    where: {
      id: mandateId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: AGENT_MANDATES,
    },
  });
  const record = row ? (data(row) as AgentMandateRecord) : null;
  // Switching mandates off (rollback) stops their pending work too.
  if (
    !agentMandatesEnabled() ||
    !record ||
    !mandateInForce(record, now) ||
    !(await ownerScope(scope, record.grantedBy, module))
  )
    throw new DomainError("AGENT_MANDATE_ENDED", 409);
  return record;
}

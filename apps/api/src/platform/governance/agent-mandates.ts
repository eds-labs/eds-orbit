import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { audit, create, data, DomainError, entity, update } from "../shared.ts";
import { authorize, PROJECT_OWN } from "../tenancy/permissions.ts";
import {
  registeredActionType,
  registeredActionTypeOwner,
  registeredActionTypes,
} from "../modules/contributions.ts";
import {
  MANDATABLE_RISK_CLASSES,
  type ActionDefinition,
  type AgentMandateTerms,
} from "./action-requests.ts";

// Agent mandates (ADR 0019): an owner's standing, bounded decision that one
// internal action type may run without a per-request approval when the
// assistant or a covered MCP client proposes it for the owner. A mandate is
// never a budget: paid work still reserves against the spending authority.
// One active record per project and type; granting and revoking are
// governance actions for an owner in the web UI only.

export const AGENT_MANDATES = "agent_mandates";
const DAY = 86_400_000;
/** The longest window one grant may name (ADR 0019 §3). */
export const MANDATE_MAX_DAYS = 90;

export const agentMandatesEnabled = () =>
  loadConfig().ORBIT_AGENT_MANDATES === "true";

/** What an owner grants (the request body). */
export const agentMandateInput = z
  .object({
    actionType: z.string().min(1).max(200),
    // Which channels it covers; MCP is a separate opt-in (ADR 0019 §8).
    assistant: z.boolean(),
    mcp: z.boolean(),
    // Only these MCP clients (their client ids) when given; any covered client otherwise.
    mcpClientIds: z.array(z.string().min(1).max(500)).max(10).default([]),
    maxCostMicrosPerAction: z.number().int().min(0),
    maxActionsPerDay: z.number().int().min(1).max(100),
    days: z.number().int().min(1).max(MANDATE_MAX_DAYS),
    // Limits on the type's own options (for example the art modes).
    options: z.record(z.string(), z.array(z.string().min(1)).min(1)).default({}),
    // The separate rights consent for images the type generates (ADR 0019 §7).
    generatedImageRights: z.boolean().default(false),
  })
  .strict();
export type AgentMandateInput = z.infer<typeof agentMandateInput>;

/** One mandate as stored. */
export type AgentMandateRecord = Omit<AgentMandateInput, "days"> & {
  members: string[];
  startAt: string;
  endAt: string;
  active: boolean;
  grantedBy: string;
  grantedAt: string;
  /** The image terms the rights consent is bound to, when given. */
  rightsTerms: Record<string, unknown> | null;
  revokedBy?: string;
  revokedAt?: string;
};

/** The action definition of a type an owner may cover, or a refusal. */
export function mandatableType(actionType: string): ActionDefinition<any> {
  const type = registeredActionType(actionType);
  if (!type?.mandate || !MANDATABLE_RISK_CLASSES.includes(type.riskClass))
    throw new DomainError("ACTION_TYPE_NOT_MANDATABLE", 409);
  return type;
}

/** Every type an owner may cover, with what a grant can limit. */
export function mandatableTypes() {
  return [...registeredActionTypes()]
    .filter(
      ([, type]) =>
        type.mandate && MANDATABLE_RISK_CLASSES.includes(type.riskClass),
    )
    .map(([actionType, type]) => ({
      actionType,
      module: registeredActionTypeOwner(actionType),
      riskClass: type.riskClass,
      maxCostMicrosPerAction: type.mandate!.maxCostMicrosPerAction,
      options: Object.fromEntries(
        Object.entries(type.mandate!.options ?? {}).map(([k, v]) => [k, [...v]]),
      ),
      generatesImages: Boolean(type.mandate!.rightsTerms),
    }));
}

/** The active mandate record of a type, newest first, or null. One row. */
export async function activeMandateRow(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  actionType: string,
) {
  return tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: AGENT_MANDATES,
      AND: [
        { data: { path: ["active"], equals: true } },
        { data: { path: ["actionType"], equals: actionType } },
      ],
    },
    orderBy: { createdAt: "desc" },
  });
}

/** The terms the decision and the type's own check read. */
export function mandateTerms(record: AgentMandateRecord): AgentMandateTerms {
  return {
    maxCostMicrosPerAction: record.maxCostMicrosPerAction,
    options: record.options,
  };
}

/** Whether a record is in force at `now`: active, not revoked, inside its window. */
export function mandateInForce(record: AgentMandateRecord, now: Date) {
  return (
    record.active === true &&
    !record.revokedAt &&
    Date.parse(record.startAt) <= now.getTime() &&
    Date.parse(record.endAt) > now.getTime()
  );
}

/**
 * Grants (or replaces) the mandate of one type: owner only, web only (the
 * routes never mount it for MCP or the assistant). The older record of the
 * type is deactivated; the new one covers the granting owner's own
 * requests (D-3). Its limits never exceed the type's own.
 */
export async function grantAgentMandate(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  now = new Date(),
) {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  if (!agentMandatesEnabled()) throw new DomainError("NOT_FOUND", 404);
  const input = agentMandateInput.parse(raw);
  const type = mandatableType(input.actionType);
  const descriptor = type.mandate!;
  if (!input.assistant && !input.mcp)
    throw new DomainError("AGENT_MANDATE_NO_CHANNEL", 400);
  if (input.mcpClientIds.length && !input.mcp)
    throw new DomainError("AGENT_MANDATE_INVALID", 400);
  if (input.maxCostMicrosPerAction > descriptor.maxCostMicrosPerAction)
    throw new DomainError("AGENT_MANDATE_COST_TOO_HIGH", 409);
  for (const [key, values] of Object.entries(input.options)) {
    const allowed = descriptor.options?.[key];
    if (!allowed || values.some((v) => !allowed.includes(v)))
      throw new DomainError("AGENT_MANDATE_INVALID", 400);
  }
  if (input.generatedImageRights && !descriptor.rightsTerms)
    throw new DomainError("AGENT_MANDATE_INVALID", 400);
  const rightsTerms = input.generatedImageRights
    ? await descriptor.rightsTerms!(tx, scope)
    : null;
  const previous = await activeMandateRow(tx, scope, input.actionType);
  if (previous)
    await update(tx, scope, previous, { ...data(previous), active: false });
  const { days, ...terms } = input;
  const record: AgentMandateRecord = {
    ...terms,
    members: [scope.userId],
    startAt: now.toISOString(),
    endAt: new Date(now.getTime() + days * DAY).toISOString(),
    active: true,
    grantedBy: scope.userId,
    grantedAt: now.toISOString(),
    rightsTerms,
  };
  const row = await create(tx, scope, AGENT_MANDATES, record);
  // Terms only: which type, which channels, which limits.
  await audit(tx, scope, "agent_mandate.granted", row.id, {
    actionType: input.actionType,
    assistant: input.assistant,
    mcp: input.mcp,
    mcpClientCount: input.mcpClientIds.length,
    maxCostMicrosPerAction: input.maxCostMicrosPerAction,
    maxActionsPerDay: input.maxActionsPerDay,
    endAt: record.endAt,
    options: input.options,
    generatedImageRights: input.generatedImageRights,
    ...(previous ? { replaces: previous.id } : {}),
  });
  return row;
}

/**
 * Revokes a mandate on the version that was shown: it authorizes nothing
 * new from now on, and work approved under it stops before any payment
 * (ADR 0019 §6). Revoking twice returns the revoked record.
 */
export async function revokeAgentMandate(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
  now = new Date(),
) {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const { version } = z
    .object({ version: z.number().int().positive() })
    .strict()
    .parse(raw);
  const row = await entity(tx, scope, AGENT_MANDATES, id);
  const record = data(row) as AgentMandateRecord;
  if (record.revokedAt) return row;
  if (row.version !== version)
    throw new DomainError("AGENT_MANDATE_STALE", 409);
  const revoked = await update(tx, scope, row, {
    ...record,
    active: false,
    revokedBy: scope.userId,
    revokedAt: now.toISOString(),
  });
  await audit(tx, scope, "agent_mandate.revoked", row.id, {
    actionType: record.actionType,
  });
  return revoked;
}

/** Mandate approvals of `mandateId` decided since the start of `now`'s UTC day. */
export async function mandateApprovalsToday(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  mandateId: string,
  now = new Date(),
) {
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return tx.entity.count({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "action_requests",
      createdAt: { gte: day },
      data: { path: ["authorization", "mandateId"], equals: mandateId },
    },
  });
}

/**
 * What Settings → Agent permissions shows: the types an owner may cover,
 * each type's mandate in force (or its latest ended one) and today's use.
 */
export async function readAgentMandates(
  tx: DbTx,
  scope: Scope,
  now = new Date(),
) {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: AGENT_MANDATES,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const types = mandatableTypes();
  const items = [];
  for (const type of types) {
    const row = rows.find((r) => data(r).actionType === type.actionType);
    const record = row ? (data(row) as AgentMandateRecord) : null;
    items.push({
      ...type,
      mandate:
        row && record
          ? {
              id: row.id,
              version: row.version,
              ...record,
              inForce: mandateInForce(record, now),
              usedToday: await mandateApprovalsToday(tx, scope, row.id, now),
            }
          : null,
    });
  }
  return { enabled: agentMandatesEnabled(), items };
}

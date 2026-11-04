/**
 * Agent work orders (ADR 0021 §6, plan §2.4–§2.5, WP1.6): one durable unit
 * of agent work per row of the project table AgentWorkOrder. A work order
 * freezes the agent's activated version, its allowlist, its sponsor and its
 * requester, and is executed by the worker (queue class `agent_work`).
 */
import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import { enqueue } from "../../jobs/enqueue.ts";
import { requireEntitlement } from "../../entitlements/entitlements.ts";
import { audit, DomainError } from "../../shared.ts";
import { effectiveRole, moduleScope } from "../../tenancy/module-roles.ts";
import {
  AGENTS_READ,
  AGENTS_RUN,
  authorize,
  can,
  PROJECT_READ,
  PROJECT_WRITE,
} from "../../tenancy/permissions.ts";
import type { AgentConfig } from "../definitions/schema.ts";
import { readVisibleAgent } from "../definitions/service.ts";
import { readAgentDefinition } from "../definitions/store.ts";

export const AGENT_WORK_QUEUE = "agent_work";
/** Statuses of a work order that has not ended. */
export const OPEN_STATUSES = ["queued", "awaiting_start", "running", "waiting_approval"] as const;
/** How long a queued work order may wait for a free slot before it fails. */
export const WORK_ORDER_WAIT_MS = 3_600_000;
const MAX_GOAL = 2000;

export const agentPlatformEnabled = () => loadConfig().ORBIT_AGENT_PLATFORM === "true";
export const agentAutomationEnabled = () => loadConfig().ORBIT_AGENT_AUTOMATION === "true";

export type WorkOrderOrigin = "manual" | "schedule" | "event" | "assistant" | "agent" | "mcp";

/** The frozen allowlist as stored (sets as sorted arrays). */
export function allowSnapshot(config: AgentConfig) {
  return {
    tools: [...config.tools].sort(),
    modules: [...config.modules].sort(),
    mode: config.mode,
    knowledge: config.knowledge,
  };
}

/** Whether the member may see a work order: agents read and read in every module it may use. */
export function maySeeWorkOrder(scope: Scope, row: { allow: unknown }) {
  if (!can(scope, AGENTS_READ)) return false;
  const modules = ((row.allow as { modules?: string[] })?.modules ?? []) as string[];
  return modules.every(
    (module) =>
      effectiveRole(scope, module) !== "none" &&
      can(moduleScope(scope, module), PROJECT_READ),
  );
}

/**
 * Inserts a work order for an active agent and queues it, or returns the
 * existing one with the same idempotency key. Refuses AGENT_NOT_ACTIVE,
 * AGENT_RUN_LIMIT (the day's runs used up) and, for a subject, returns the
 * open work order of the same agent and subject instead of a second one.
 */
export async function insertWorkOrder(
  tx: DbTx,
  scope: Scope,
  input: {
    agentId: string;
    origin: WorkOrderOrigin;
    originRef?: string | null;
    idempotencyKey: string;
    requestedBy: Record<string, unknown>;
    requesterUserId?: string | null;
    goal?: string;
    subject?: { type: string; id: string } | null;
    input?: Record<string, unknown>;
    availableAt?: Date;
    parent?: { id: string; rootId: string; depth: number; ceilingMicros?: number } | null;
  },
  now = new Date(),
) {
  const existing = await tx.agentWorkOrder.findUnique({
    where: { projectId_idempotencyKey: { projectId: scope.projectId, idempotencyKey: input.idempotencyKey } },
  });
  if (existing) return { workOrder: existing, created: false };
  const stored = await readAgentDefinition(tx, scope, input.agentId);
  const { definition } = stored;
  if (definition.status !== "active" || !definition.active || !definition.activation)
    throw new DomainError("AGENT_NOT_ACTIVE", 409);
  const config = definition.active;
  if (input.subject) {
    const open = await tx.agentWorkOrder.findFirst({
      where: {
        projectId: scope.projectId,
        agentId: input.agentId,
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        status: { in: [...OPEN_STATUSES] },
      },
    });
    if (open) return { workOrder: open, created: false };
  }
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const today = await tx.agentWorkOrder.count({
    where: { projectId: scope.projectId, agentId: input.agentId, createdAt: { gte: day } },
  });
  if (today >= config.limits.maxRunsPerDay) throw new DomainError("AGENT_RUN_LIMIT", 429);
  const id = crypto.randomUUID();
  const ceiling = Math.min(
    config.budget.runCeilingMicros,
    input.parent?.ceilingMicros ?? Number.MAX_SAFE_INTEGER,
  );
  const workOrder = await tx.agentWorkOrder.create({
    data: {
      id,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      target: "agent",
      agentId: input.agentId,
      agentVersion: definition.activation.version,
      configHash: definition.activation.configHash,
      origin: input.origin,
      originRef: input.originRef ?? null,
      subjectType: input.subject?.type ?? null,
      subjectId: input.subject?.id ?? null,
      idempotencyKey: input.idempotencyKey,
      requestedBy: {
        ...input.requestedBy,
        ...(input.requesterUserId ? { requesterUserId: input.requesterUserId } : {}),
      },
      sponsorUserId: definition.activation.sponsorUserId,
      allow: allowSnapshot(config),
      parentId: input.parent?.id ?? null,
      rootId: input.parent?.rootId ?? id,
      depth: input.parent ? input.parent.depth + 1 : 0,
      goal: (input.goal ?? "").slice(0, MAX_GOAL),
      input: (input.input ?? {}) as object,
      status: "queued",
      ceilingMicros: BigInt(ceiling),
      expiresAt: new Date(now.getTime() + WORK_ORDER_WAIT_MS),
    },
  });
  const job = await enqueue(tx, scope, AGENT_WORK_QUEUE, id, `agent-work-order:${id}`, input.availableAt ?? now);
  await tx.agentWorkOrder.update({ where: { id }, data: { jobId: job.id } });
  await audit(tx, scope, "agent_work_order.started", id, {
    agentId: input.agentId,
    agentVersion: definition.activation.version,
    origin: input.origin,
  });
  return { workOrder, created: true };
}

export const manualRunInput = z.strictObject({
  requestId: z.uuid(),
  goal: z.string().max(MAX_GOAL).optional(),
  subject: z.strictObject({ type: z.string().min(1).max(80), id: z.string().min(1).max(200) }).optional(),
});

/**
 * Starts a manual work order: the member (owner or editor) asks for it from
 * the web, which is the start confirmation of D-06. The member must be an
 * editor in every module of the agent, the agent must offer a manual
 * trigger, and the run acts for the member as requester and the sponsor.
 */
export async function startManualWorkOrder(tx: DbTx, scope: Scope, agentId: string, raw: unknown) {
  authorize(scope, AGENTS_RUN);
  const input = manualRunInput.parse(raw);
  const { definition } = await readVisibleAgent(tx, scope, agentId);
  const config = definition.active;
  if (definition.status !== "active" || !config) throw new DomainError("AGENT_NOT_ACTIVE", 409);
  if (!config.triggers.some((t) => t.kind === "manual"))
    throw new DomainError("AGENT_TRIGGER_DISABLED", 409);
  for (const module of config.modules)
    if (effectiveRole(scope, module) === "none" || !can(moduleScope(scope, module), PROJECT_WRITE))
      throw new DomainError("AGENT_PRINCIPAL_FORBIDDEN", 403);
  await requireEntitlement(scope.workspaceId, { triggerKind: "manual" });
  const { workOrder } = await insertWorkOrder(tx, scope, {
    agentId,
    origin: "manual",
    idempotencyKey: `agent:${agentId}:manual:${input.requestId}`,
    requestedBy: { kind: "user", userId: scope.userId },
    requesterUserId: scope.userId,
    goal: input.goal ?? "",
    subject: input.subject ?? null,
  });
  return workOrderView(workOrder);
}

/** Reads one work order the member may see (404 otherwise). */
export async function readWorkOrder(tx: DbTx, scope: Scope, id: string) {
  authorize(scope, AGENTS_READ);
  const row = await tx.agentWorkOrder.findFirst({ where: { id, projectId: scope.projectId } });
  if (!row || !maySeeWorkOrder(scope, row)) throw new DomainError("NOT_FOUND", 404);
  return row;
}

export const listInput = z.strictObject({
  agentId: z.uuid().optional(),
  status: z.enum([...OPEN_STATUSES, "succeeded", "failed", "blocked", "canceled", "outcome_unknown"]).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** The member's visible work orders, newest first, paged by id cursor. */
export async function listWorkOrders(tx: DbTx, scope: Scope, raw: unknown) {
  authorize(scope, AGENTS_READ);
  const input = listInput.parse(raw ?? {});
  const cursorRow = input.cursor
    ? await tx.agentWorkOrder.findFirst({ where: { id: input.cursor, projectId: scope.projectId } })
    : null;
  const rows = await tx.agentWorkOrder.findMany({
    where: {
      projectId: scope.projectId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(cursorRow ? { createdAt: { lt: cursorRow.createdAt } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: input.limit + 1,
  });
  const visible = rows.slice(0, input.limit).filter((row) => maySeeWorkOrder(scope, row));
  return {
    items: visible.map(workOrderView),
    nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.id : null,
  };
}

/**
 * Cancels a work order: one that has not started ends at once; a running
 * one is stopped by its host at the next check (cooperative, as chat).
 */
export async function cancelWorkOrder(tx: DbTx, scope: Scope, id: string) {
  authorize(scope, AGENTS_RUN);
  const row = await readWorkOrder(tx, scope, id);
  if (!(OPEN_STATUSES as readonly string[]).includes(row.status)) return workOrderView(row);
  const updated = await tx.agentWorkOrder.update({
    where: { id },
    data: {
      status: "canceled",
      errorCode: "AGENT_CANCELED",
      ...(row.status === "running" ? {} : { finishedAt: new Date() }),
    },
  });
  await audit(tx, scope, "agent_work_order.canceled", id, { agentId: row.agentId });
  return workOrderView(updated);
}

/** Starts a new manual work order with the same goal and subject, linked to the old one. */
export async function retryWorkOrder(tx: DbTx, scope: Scope, id: string, raw: unknown) {
  const old = await readWorkOrder(tx, scope, id);
  if ((OPEN_STATUSES as readonly string[]).includes(old.status))
    throw new DomainError("AGENT_WORK_ORDER_OPEN", 409);
  const { requestId } = z.strictObject({ requestId: z.uuid() }).parse(raw);
  const view = await startManualWorkOrder(tx, scope, old.agentId!, {
    requestId,
    goal: old.goal,
    ...(old.subjectType && old.subjectId ? { subject: { type: old.subjectType, id: old.subjectId } } : {}),
  });
  await tx.agentWorkOrder.update({ where: { id: view.id }, data: { originRef: old.id } });
  return { ...view, originRef: old.id };
}

/** What the API returns for a work order: never raw arguments (there are none stored). */
export function workOrderView(row: Awaited<ReturnType<DbTx["agentWorkOrder"]["findFirstOrThrow"]>>) {
  const requestedBy = row.requestedBy as Record<string, unknown>;
  return {
    id: row.id,
    agentId: row.agentId,
    agentVersion: row.agentVersion,
    origin: row.origin,
    originRef: row.originRef,
    subject: row.subjectType ? { type: row.subjectType, id: row.subjectId } : null,
    onBehalfOf: { sponsorUserId: row.sponsorUserId, requesterUserId: requestedBy?.requesterUserId ?? null },
    allow: row.allow,
    parentId: row.parentId,
    rootId: row.rootId,
    depth: row.depth,
    goal: row.goal,
    status: row.status,
    errorCode: row.errorCode,
    ceilingMicros: Number(row.ceilingMicros),
    spentMicros: Number(row.spentMicros),
    costUnknown: row.costUnknown,
    result: row.result,
    steps: row.steps,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/**
 * Deletes the work orders about these subjects, their delegated children and
 * the agent runs that ran them (spans cascade), e.g. when Support deletes a
 * ticket or erases a contact (ADR 0021 Phase 2, plan §2.4 item 9). Runs in
 * the caller's project transaction; a work order still running ends without
 * a record. ActionRequests and reservations stay as recorded.
 */
export async function deleteWorkOrdersForSubject(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  subjectType: string,
  subjectIds: readonly string[],
) {
  if (!subjectIds.length) return 0;
  const roots = await tx.agentWorkOrder.findMany({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId, subjectType, subjectId: { in: [...subjectIds] } },
    select: { id: true },
  });
  if (!roots.length) return 0;
  const rootIds = roots.map((r) => r.id);
  const tree = await tx.agentWorkOrder.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      OR: [{ id: { in: rootIds } }, { parentId: { in: rootIds } }, { rootId: { in: rootIds } }],
    },
    select: { id: true },
  });
  const ids = tree.map((r) => r.id);
  await tx.agentRun.deleteMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      subjectType: "agent_work_order",
      subjectId: { in: ids },
    },
  });
  const deleted = await tx.agentWorkOrder.deleteMany({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId, id: { in: ids } },
  });
  return deleted.count;
}

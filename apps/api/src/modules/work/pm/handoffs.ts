import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { EventSubscription } from "../../../platform/events/types.ts";
import {
  createActionRequest,
  type ActionDefinition,
  type RequestedBy,
} from "../../../platform/governance/action-requests.ts";
import { HANDOFF_EVENT } from "../../../platform/handoffs/handoffs.ts";
import { createLink } from "../../../platform/links/links.ts";
import type { LinkTypeDef } from "../../../platform/links/types.ts";
import { registeredHandoff } from "../../../platform/modules/contributions.ts";
import { enabledModules } from "../../../platform/modules/enforcement.ts";
import { actorScope } from "../../../platform/tenancy/member-scope.ts";
import { effectiveRole } from "../../../platform/tenancy/module-roles.ts";
import { can } from "../../../platform/tenancy/permissions.ts";
import { audit, data, DomainError, update } from "../../../shared.ts";
import { taskPath, uuid, workDomainEvent, workEvent } from "../common.ts";
import { pmActive, requirePm } from "../gate.ts";
import { WORK_READ } from "../permissions.ts";
import { firstStatus, readWorkSettings, type StatusCategory } from "../settings.ts";
import { loadTask, updateTask } from "../tasks.ts";
import { pmActor } from "./planner.ts";

// Handoffs (ADR 0017 P-3, plan §2.6): a member hands a task to work another
// target owns, after an approval (an editor for internal work, the owner
// for paid or external work). The task links to the target's object with
// `delegated_to`, carries the target as its agent assignee, and moves
// forward when the target reports progress: to in progress when it starts,
// to review when it finishes. A person closes the task, never a target.

export const HANDOFF = "work.handoff";
export const HANDOFF_OWNER = "work.handoff_owner";
const ACTIVE = ["awaiting_approval", "running"];
const BEFORE_PROGRESS: readonly string[] = ["backlog", "todo"];
const BEFORE_REVIEW: readonly string[] = ["backlog", "todo", "in_progress", "blocked"];

export const handoffInput = z
  .object({
    target: z.string().regex(/^[a-z][a-z0-9_]{1,30}\.[a-z][a-z0-9_]{1,40}$/),
    input: z.unknown(),
  })
  .strict();

export type HandoffRow = Awaited<ReturnType<DbTx["workHandoff"]["findFirstOrThrow"]>>;

const hashOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function handoffView(row: HandoffRow) {
  return {
    id: row.id,
    taskId: row.taskId,
    target: row.targetKey,
    label: registeredHandoff(row.targetKey)?.label ?? null,
    status: row.status,
    targetType: row.targetType,
    targetId: row.targetId,
    actionRequestId: row.actionRequestId,
    ceilingMicros: Number(row.ceilingMicros),
    costMicros: Number(row.costMicros),
    result: row.result as Record<string, unknown>,
    errorCode: row.errorCode,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The target, available in the project and allowed for the member. */
async function allowedTarget(tx: DbTx, member: Scope, key: string) {
  const def = registeredHandoff(key);
  if (!def) throw new DomainError("WORK_HANDOFF_UNKNOWN", 422);
  const enabled = await enabledModules(tx, member);
  if (enabled && !enabled.has(def.owner)) throw new DomainError("WORK_HANDOFF_UNAVAILABLE", 409);
  const role = effectiveRole(member, def.owner);
  if (role === "none" || !can({ ...member, role }, def.permission)) throw new DomainError("FORBIDDEN", 403);
  return { def, scope: { ...member, role } };
}

/** Proposes handing a task over; returns the handoff with its approval request. */
export async function proposeHandoff(
  tx: DbTx,
  scope: Scope,
  taskId: string,
  raw: unknown,
  requestedBy: RequestedBy = { kind: "user", userId: scope.userId },
) {
  await requirePm(tx, scope);
  const { target, input: rawInput } = handoffInput.parse(raw);
  const task = await loadTask(tx, scope, taskId);
  if (task.archivedAt || ["done", "canceled"].includes(task.statusCategory))
    throw new DomainError("WORK_TASK_CLOSED", 409);
  const { def } = await allowedTarget(tx, scope, target);
  const input = def.input.parse(rawInput);
  const ceilingMicros = def.costCeilingMicros?.(input) ?? 0;
  const active = await tx.workHandoff.findFirst({
    where: { projectId: scope.projectId, taskId: task.id, targetKey: target, status: { in: ACTIVE } },
    select: { id: true },
  });
  if (active) throw new DomainError("WORK_HANDOFF_ACTIVE", 409);
  const handoff = await tx.workHandoff.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      taskId: task.id,
      targetKey: target,
      input: input as Prisma.InputJsonValue,
      inputHash: hashOf(input),
      ceilingMicros: BigInt(ceilingMicros),
      createdBy: scope.userId,
    },
  });
  const request = await createActionRequest(tx, scope, {
    actionType: def.risk === "P_proposal" || ceilingMicros > 0 ? HANDOFF_OWNER : HANDOFF,
    payload: {
      handoffId: handoff.id,
      target,
      inputHash: handoff.inputHash,
      ceilingMicros,
      actorId: scope.userId,
      taskNumber: task.number,
    },
    requestedBy,
  });
  const row = await tx.workHandoff.update({
    where: { id: handoff.id },
    data: { actionRequestId: request.id },
  });
  await audit(tx, scope, "work.pm.handoff_proposed", handoff.id, { target, taskId: task.id, ceilingMicros });
  return row;
}

const payload = z
  .object({
    handoffId: z.uuid(),
    target: z.string(),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    ceilingMicros: z.int().min(0),
    actorId: z.string().min(1),
    taskNumber: z.int().min(1),
  })
  .strict();
type Payload = z.infer<typeof payload>;

/** The handoff as proposed, its proposer still allowed, the task still open. */
async function stillValid(tx: DbTx, scope: Scope, p: Payload) {
  await requirePm(tx, scope);
  const handoff = await tx.workHandoff.findFirst({
    where: { projectId: scope.projectId, id: p.handoffId },
  });
  if (!handoff || handoff.status !== "awaiting_approval" || handoff.inputHash !== p.inputHash || handoff.targetKey !== p.target)
    throw new DomainError("WORK_PROPOSAL_OUTDATED", 409);
  const member = await actorScope(scope.workspaceId, scope.projectId, p.actorId);
  if (!member) throw new DomainError("ACTOR_MEMBERSHIP_REQUIRED", 403);
  const target = await allowedTarget(tx, member, p.target);
  const task = await loadTask(tx, scope, handoff.taskId);
  if (task.archivedAt || ["done", "canceled"].includes(task.statusCategory))
    throw new DomainError("WORK_TASK_CLOSED", 409);
  return { handoff, member, target, task };
}

function action(deciderRole: "owner" | "editor"): ActionDefinition<Payload> {
  return {
    riskClass: deciderRole === "owner" ? "C2" : "W0_internal",
    approvalMode: "approval_required",
    deciderRole,
    // A target's own spending takes its own paid path.
    policyRequired: false,
    ttlMs: 3 * 24 * 3600000,
    payload,
    costCeilingMicros: (p) => p.ceilingMicros,
    summary: (p) => ({ operation: { kind: "handoff", target: p.target, task: p.taskNumber } }),
    async revalidate(tx, scope, p) {
      await stillValid(tx, scope, p);
    },
    async onApproved(tx, scope, row) {
      const p = payload.parse(data(row).payload);
      const { handoff, target, task } = await stillValid(tx, scope, p);
      const started = await target.def.create(
        tx,
        target.scope,
        { type: "work.task", id: task.id },
        handoff.input,
        { kind: "agent", id: pmActor.id },
        handoff.id,
      );
      await createLink(
        tx,
        target.scope,
        { source: { type: "work.task", id: task.id }, target: started.target, relation: "delegated_to" },
        { kind: "agent", id: pmActor.id },
      );
      await tx.workTask.update({
        where: { id: task.id },
        data: { assigneeAgentKey: p.target, version: { increment: 1 } },
      });
      await workEvent(tx, scope, { taskId: task.id }, "assignee_agent", pmActor, { assigneeAgentKey: task.assigneeAgentKey }, { assigneeAgentKey: p.target });
      await workDomainEvent(tx, scope, "work.task.updated", { type: "work.task", id: task.id }, pmActor, {
        number: task.number,
        fields: ["assigneeAgentKey"],
      });
      await tx.workHandoff.update({
        where: { id: handoff.id },
        data: {
          status: "running",
          targetType: started.target.type,
          targetId: started.target.id,
          version: { increment: 1 },
        },
      });
      await audit(tx, scope, "work.pm.handoff_started", handoff.id, { target: p.target });
      await update(tx, scope, row, {
        ...data(row),
        status: "consumed",
        executionResult: { target: started.target },
        consumedBy: { executionId: row.id, consumedAt: new Date().toISOString() },
      });
    },
    async executionResult(_tx, _scope, row) {
      return data(row).executionResult ?? null;
    },
  };
}

export const handoffActionTypes = {
  [HANDOFF]: action("editor"),
  [HANDOFF_OWNER]: action("owner"),
};

/** Moves a task's status forward to the first status of `category`, if allowed. */
async function moveForward(
  tx: DbTx,
  scope: Scope,
  taskId: string,
  category: StatusCategory,
  from: readonly string[],
) {
  const task = await loadTask(tx, scope, taskId);
  if (!from.includes(task.statusCategory)) return false;
  const { settings } = await readWorkSettings(tx, scope);
  const status = firstStatus(settings, category);
  if (!status) return false;
  try {
    await updateTask(tx, scope, task.id, { expectedVersion: task.version, status: status.key }, pmActor);
    return true;
  } catch (error) {
    // The workflow does not allow the step: the task stays where it is.
    if (error instanceof DomainError && error.code === "WORK_TRANSITION_NOT_ALLOWED") return false;
    throw error;
  }
}

/** Follows the targets' progress: forward only, never to done. */
export const handoffSyncSubscriber: EventSubscription = {
  name: "work.handoff_sync",
  types: [HANDOFF_EVENT],
  async handler(tx, scope, event) {
    if (!(await pmActive(tx, scope))) return;
    const status = (event.data as { status?: string }).status;
    const handoffs = await tx.workHandoff.findMany({
      where: {
        projectId: scope.projectId,
        targetType: event.subject.type,
        targetId: event.subject.id,
        status: "running",
      },
    });
    for (const handoff of handoffs) {
      if (status === "started") await moveForward(tx, scope, handoff.taskId, "in_progress", BEFORE_PROGRESS);
      else if (status === "finished" || status === "failed") {
        await tx.workHandoff.update({
          where: { id: handoff.id },
          data: {
            status: status === "finished" ? "finished" : "failed",
            ...(status === "failed" ? { errorCode: handoff.errorCode ?? "WORK_HANDOFF_TARGET_FAILED" } : {}),
            version: { increment: 1 },
          },
        });
        if (status === "finished") await moveForward(tx, scope, handoff.taskId, "in_review", BEFORE_REVIEW);
        await audit(tx, scope, "work.pm.handoff_" + status, handoff.id, { target: handoff.targetKey });
      }
    }
  },
};

/** The handoff record as a link target, for targets without their own object. */
export const handoffLinkType: LinkTypeDef = {
  label: { en: "Handoff", de: "Übergabe" },
  linkPermission: WORK_READ,
  async resolve(tx, scope, ids) {
    const rows = await tx.workHandoff.findMany({
      where: { projectId: scope.projectId, id: { in: [...ids] } },
      select: { id: true, taskId: true, targetKey: true, status: true },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        {
          title: registeredHandoff(r.targetKey)?.label.en ?? r.targetKey,
          status: r.status,
          href: taskPath(scope.projectId, r.taskId),
        },
      ]),
    );
  },
  async search() {
    return [];
  },
};

export async function listHandoffs(tx: DbTx, scope: Scope, taskId: string) {
  const rows = await tx.workHandoff.findMany({
    where: { projectId: scope.projectId, taskId: uuid.parse(taskId) },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(handoffView);
}

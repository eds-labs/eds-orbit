import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { ActionDefinition } from "../../../platform/governance/action-requests.ts";
import { audit, data, DomainError, update } from "../../../shared.ts";
import { assignableIds, workDomainEvent } from "../common.ts";
import { requirePm } from "../gate.ts";
import { createInitiative } from "../initiatives.ts";
import { createMilestone } from "../milestones.ts";
import { addDependency } from "../parts.ts";
import { readWorkSettings } from "../settings.ts";
import { createTask } from "../tasks.ts";
import { workPlanSchema, type WorkPlan } from "./plan-schema.ts";
import { loadProposal, planHash, pmActor, PLAN_APPLY } from "./planner.ts";
import { BULK_UPDATE, bulkUpdateAction } from "./analyst.ts";

// Applying an approved plan (plan §2.4): initiative (for a new plan),
// milestones, tasks with their acceptance criteria as checklist items, and
// dependencies, in the decision's transaction and exactly once. Everything
// is written by the PM actor (`source: pm_agent`, origin `work.pm`).

const payload = z
  .object({
    proposalId: z.uuid(),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.int().min(1),
    actorId: z.string().min(1),
    kind: z.enum(["new_plan", "extension"]),
    initiativeTitle: z.string(),
    milestones: z.int().min(0),
    tasks: z.int().min(1),
  })
  .strict();
type Payload = z.infer<typeof payload>;

const list = (title: string, items: string[]) =>
  items.length ? `## ${title}\n${items.map((i) => `- ${i}`).join("\n")}` : "";

/** The initiative description: the plan's goal, scope, risks, decisions and assumptions. */
function initiativeDescription(plan: WorkPlan) {
  return [
    plan.goal,
    list("In scope", plan.scope.in),
    list("Out of scope", plan.scope.out),
    list(
      "Workstreams",
      plan.workstreams.map((w) => (w.summary ? `${w.title}: ${w.summary}` : w.title)),
    ),
    list(
      "Risks",
      plan.risks.map((r) => `${r.title} (${r.impact})${r.mitigation ? `: ${r.mitigation}` : ""}`),
    ),
    list(
      "Open decisions",
      plan.openDecisions.map(
        (d) =>
          `${d.question}${d.options.length ? ` Options: ${d.options.join("; ")}.` : ""}${d.recommendation ? ` Recommendation: ${d.recommendation}` : ""}`,
      ),
    ),
    list("Assumptions", plan.assumptions),
    "_Planned by the AI project manager; reviewed and approved in Orbit._",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 20000);
}

function taskDescription(plan: WorkPlan, task: WorkPlan["tasks"][number]) {
  const workstream = plan.workstreams.find((w) => w.ref === task.workstreamRef);
  return [
    task.description,
    workstream ? `Workstream: ${workstream.title}` : "",
    task.suggestedRole ? `Suggested role: ${task.suggestedRole}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Creates the plan's objects; returns the initiative and the created task ids. */
export async function applyPlan(
  tx: DbTx,
  scope: Scope,
  proposalId: string,
  requesterId: string,
) {
  const proposal = await loadProposal(tx, scope, proposalId);
  const plan = workPlanSchema.parse(proposal.plan);
  const assignable = await assignableIds(scope);
  const { settings } = await readWorkSettings(tx, scope);
  let initiativeId = proposal.initiativeId;
  if (proposal.kind === "new_plan") {
    const initiative = await createInitiative(
      tx,
      scope,
      {
        title: plan.initiative.title,
        ...(plan.initiative.key ? { key: plan.initiative.key } : {}),
        description: initiativeDescription(plan),
        ownerUserId: assignable.has(requesterId) ? requesterId : null,
        startDate: plan.initiative.startDate,
        targetDate: plan.initiative.targetDate,
      },
      pmActor,
    );
    initiativeId = initiative.id;
    // The PM watches what it planned; reports stay off until enabled (Q-P2-2).
    await tx.workPmState.create({
      data: {
        id: randomUUID(),
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        initiativeId,
        enabled: true,
        updatedBy: scope.userId,
      },
    });
  }
  if (!initiativeId) throw new DomainError("WORK_PROPOSAL_OUTDATED", 409);
  const milestones = new Map<string, string>();
  for (const [index, milestone] of plan.milestones.entries()) {
    const row = await createMilestone(
      tx,
      scope,
      initiativeId,
      {
        title: milestone.title,
        description: milestone.criteria || null,
        dueDate: milestone.dueDate,
        sortOrder: index * 10,
      },
      pmActor,
    );
    milestones.set(milestone.ref, row.id);
  }
  const tasks = new Map<string, string>();
  // Parents before their subtasks.
  const ordered = [
    ...plan.tasks.filter((t) => !t.parentRef),
    ...plan.tasks.filter((t) => t.parentRef),
  ];
  for (const task of ordered) {
    const row = await createTask(
      tx,
      scope,
      {
        title: task.title,
        description: taskDescription(plan, task) || null,
        priority: task.priority,
        estimate: task.estimate,
        dueDate: task.dueDate,
        initiativeId,
        milestoneId: task.milestoneRef ? (milestones.get(task.milestoneRef) ?? null) : null,
        parentTaskId: task.parentRef ? (tasks.get(task.parentRef) ?? null) : null,
        // A member who left or lost the module since the proposal is dropped.
        assigneeUserId:
          task.suggestedAssigneeUserId && assignable.has(task.suggestedAssigneeUserId)
            ? task.suggestedAssigneeUserId
            : null,
        checklist: task.acceptanceCriteria,
      },
      pmActor,
      "pm_agent",
      { settings, assignable },
    );
    tasks.set(task.ref, row.id);
  }
  for (const task of plan.tasks)
    for (const ref of task.dependsOn)
      await addDependency(tx, scope, tasks.get(task.ref)!, { dependsOnTaskId: tasks.get(ref)! }, pmActor);
  const appliedTaskIds = plan.tasks.map((t) => tasks.get(t.ref)!);
  await tx.workPlanProposal.update({
    where: { id: proposal.id },
    data: {
      status: "applied",
      initiativeId,
      appliedAt: new Date(),
      appliedTaskIds,
      version: { increment: 1 },
    },
  });
  await audit(tx, scope, "work.pm.plan_applied", proposal.id, {
    initiativeId,
    milestones: milestones.size,
    tasks: appliedTaskIds.length,
  });
  await workDomainEvent(tx, scope, "work.pm.plan.applied", { type: "work.initiative", id: initiativeId }, pmActor, {
    proposalId: proposal.id,
    tasks: appliedTaskIds.length,
  });
  return { initiativeId, appliedTaskIds };
}

/** Rechecked when deciding: the exact revision is still the open one. */
async function stillOpen(tx: DbTx, scope: Scope, p: Payload) {
  await requirePm(tx, scope);
  const proposal = await loadProposal(tx, scope, p.proposalId);
  if (
    proposal.status !== "proposed" ||
    proposal.revision !== p.revision ||
    proposal.planHash !== p.planHash ||
    planHash(workPlanSchema.parse(proposal.plan)) !== p.planHash
  )
    throw new DomainError("WORK_PROPOSAL_OUTDATED", 409);
  if (proposal.initiativeId) {
    const initiative = await tx.workInitiative.findFirst({
      where: { projectId: scope.projectId, id: proposal.initiativeId },
      select: { archivedAt: true },
    });
    if (!initiative || initiative.archivedAt) throw new DomainError("WORK_PROPOSAL_OUTDATED", 409);
  }
  return proposal;
}

/** `work.plan.apply`: an owner or editor applies a validated plan once. */
export const planApplyAction: ActionDefinition<Payload> = {
  riskClass: "W0_internal",
  approvalMode: "approval_required",
  deciderRole: "editor",
  inbox: "editors",
  // Spends nothing: no spend mandate is needed to decide it.
  policyRequired: false,
  ttlMs: 7 * 24 * 3600000,
  payload,
  costCeilingMicros: () => 0,
  summary: (p) => ({
    operation: {
      kind: p.kind,
      initiative: p.initiativeTitle,
      milestones: p.milestones,
      tasks: p.tasks,
    },
  }),
  async revalidate(tx, scope, p) {
    await stillOpen(tx, scope, p);
  },
  async onApproved(tx, scope, row) {
    const p = payload.parse(data(row).payload);
    await stillOpen(tx, scope, p);
    const result = await applyPlan(tx, scope, p.proposalId, p.actorId);
    await update(tx, scope, row, {
      ...data(row),
      status: "consumed",
      executionResult: result,
      consumedBy: { executionId: row.id, consumedAt: new Date().toISOString() },
    });
  },
  async executionResult(_tx, _scope, row) {
    return data(row).executionResult ?? null;
  },
};

export const pmActionTypes = { [PLAN_APPLY]: planApplyAction, [BULK_UPDATE]: bulkUpdateAction };

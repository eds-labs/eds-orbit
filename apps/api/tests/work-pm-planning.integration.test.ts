import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { data, entity } from "../src/shared.ts";
import { registerModules } from "../src/modules/registry.ts";
import { decideActionRequest, listActionRequests } from "../src/platform/governance/action-requests.ts";
import { registeredActionType } from "../src/platform/modules/contributions.ts";
import { savePmSettings, readPmSettings } from "../src/modules/work/pm/settings.ts";
import {
  discardPlan,
  loadProposal,
  requestPlan,
  revisePlan,
  runPlanJob,
} from "../src/modules/work/pm/planner.ts";
import { syntheticPlan } from "./fixtures/work-pm/plans.ts";
import { createWorkPmProject, withEnv } from "./support/work-pm-project.ts";

registerModules();

const mocked = vi.hoisted(() => ({ replies: [] as Array<unknown | Error>, calls: 0 }));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  respond: vi.fn(async (request: any) => {
    mocked.calls++;
    const next = mocked.replies.shift();
    if (next === undefined) throw new Error("NO_RECORDED_REPLY");
    if (next instanceof Error) throw next;
    return {
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(next) }] },
      ],
      usage: {
        model: request.route.model,
        inputTokens: 1000,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 4000,
        reasoningTokens: 0,
        costMicros: 50_000,
      },
      responseId: "resp_pm_plan",
    };
  }),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/** Planning from request to applied plan (ADR 0017, WP2.3), with a scripted model. */
describe.skipIf(!enabled)("AI project manager planning", () => {
  let p: Awaited<ReturnType<typeof createWorkPmProject>>;
  const env = withEnv({ ORBIT_WORK: "true", ORBIT_WORK_PM: "true" });
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => "resolved",
      (e: Error) => e.message,
    );
  const request = async (goal: string, extra: Record<string, unknown> = {}) => {
    const { proposal } = await p.run((tx) => requestPlan(tx, p.editor, { goal, ...extra }, "ui"));
    return proposal;
  };
  const proposal = (id: string) => p.run((tx) => loadProposal(tx, p.owner, id));
  const decide = (who: typeof p.owner, requestId: string, decision: "approve" | "reject" = "approve") =>
    p.run(async (tx) => {
      const row = await entity(tx, who, "action_requests", requestId);
      return decideActionRequest(tx, who, requestId, { version: row.version, packageHash: data(row).packageHash, decision });
    });

  beforeAll(async () => {
    env.apply();
    p = await createWorkPmProject();
  });
  beforeEach(() => {
    mocked.replies.length = 0;
    mocked.calls = 0;
  });
  afterAll(async () => {
    env.restore();
    await p?.cleanup();
    await closeDatabase();
  });

  it("is unavailable while ORBIT_WORK_PM is off", async () => {
    process.env.ORBIT_WORK_PM = "false";
    try {
      expect(await failure(request("Plan something"))).toBe("WORK_PM_DISABLED");
    } finally {
      process.env.ORBIT_WORK_PM = "true";
    }
  });

  it("plans 30 tasks in the background and applies them once after an editor approves", async () => {
    const queued = await request("Plane die Einführung des uLiquid Marketplace", { idempotencyKey: "plan-1" });
    expect(queued).toMatchObject({ status: "queued", kind: "new_plan", requestedBy: p.editor.userId });
    // The same request returns the same proposal.
    const again = await p.run((tx) =>
      requestPlan(tx, p.editor, { goal: "Plane die Einführung des uLiquid Marketplace", idempotencyKey: "plan-1" }, "ui"),
    );
    expect(again).toMatchObject({ deduplicated: true, proposal: { id: queued.id } });
    const jobs = await p.run((tx) =>
      tx.entity.findMany({ where: { projectId: p.owner.projectId, kind: "jobs", data: { path: ["resourceId"], equals: queued.id } } }),
    );
    expect(jobs.map((j) => data(j).topic)).toEqual(["work_pm"]);

    const plan = syntheticPlan(30);
    plan.tasks[0]!.suggestedAssigneeUserId = p.viewer.userId;
    plan.tasks[1]!.suggestedAssigneeUserId = p.editor.userId;
    mocked.replies.push(plan);
    await runPlanJob(p.owner, queued.id);
    const proposed = await proposal(queued.id);
    expect(proposed).toMatchObject({ status: "proposed", costMicros: 50_000n });
    // A viewer never owns work; the warning names the task ref only.
    expect(proposed.validation).toEqual({ errors: [], warnings: ["assignee_dropped:t1"] });
    const reservations = await p.run((tx) =>
      tx.budgetReservation.findMany({ where: { projectId: p.owner.projectId, category: "work_pm" } }),
    );
    expect(reservations.map((r) => [r.state, Number(r.settledMicros), r.taskClass])).toEqual([["settled", 50_000, "pm_plan"]]);
    const actionRequest = await p.run((tx) => entity(tx, p.owner, "action_requests", proposed.actionRequestId!));
    expect(data(actionRequest)).toMatchObject({ actionType: "work.plan.apply", status: "pending" });
    expect(registeredActionType("work.plan.apply")!.deciderRole).toBe("editor");
    // Editors see what they may decide in the approvals list; viewers see nothing.
    const listed = await p.run((tx) => listActionRequests(tx, p.editor));
    expect(listed.find((r) => r.id === proposed.actionRequestId)).toMatchObject({
      actionType: "work.plan.apply",
      summary: { operation: { kind: "new_plan", tasks: 30, milestones: 3 } },
    });
    expect(await p.run((tx) => listActionRequests(tx, p.viewer))).toEqual([]);
    // A viewer cannot decide; the editor's approval applies the plan.
    expect(await failure(decide(p.viewer, proposed.actionRequestId!))).not.toBe("resolved");
    await decide(p.editor, proposed.actionRequestId!);
    const applied = await proposal(queued.id);
    expect(applied).toMatchObject({ status: "applied" });
    expect(applied.appliedTaskIds).toHaveLength(30);
    const tasks = await p.run((tx) =>
      tx.workTask.findMany({ where: { projectId: p.owner.projectId, initiativeId: applied.initiativeId! }, orderBy: { number: "asc" } }),
    );
    expect(tasks).toHaveLength(30);
    expect(new Set(tasks.map((t) => t.source))).toEqual(new Set(["pm_agent"]));
    expect(tasks.filter((t) => t.parentTaskId)).toHaveLength(plan.tasks.filter((t) => t.parentRef).length);
    expect(tasks.find((t) => t.title === "Task 2")!.assigneeUserId).toBe(p.editor.userId);
    expect(tasks.find((t) => t.title === "Task 1")!.assigneeUserId).toBeNull();
    const counts = await p.run(async (tx) => ({
      milestones: await tx.workMilestone.count({ where: { initiativeId: applied.initiativeId! } }),
      dependencies: await tx.workTaskDependency.count({ where: { projectId: p.owner.projectId } }),
      checklist: await tx.workChecklistItem.count({ where: { taskId: { in: applied.appliedTaskIds } } }),
      state: await tx.workPmState.findFirst({ where: { initiativeId: applied.initiativeId! } }),
      events: await tx.domainEvent.findMany({ where: { projectId: p.owner.projectId, type: "work.task.created" } }),
    }));
    expect(counts.milestones).toBe(3);
    expect(counts.dependencies).toBe(plan.tasks.reduce((n, t) => n + t.dependsOn.length, 0));
    expect(counts.checklist).toBe(30);
    expect(counts.state).toMatchObject({ enabled: true });
    // The PM's writes carry its origin, so its own monitor is not woken by them.
    expect(new Set(counts.events.map((e) => e.origin))).toEqual(new Set(["work.pm"]));
    // A second approval click runs nothing again.
    await decide(p.editor, proposed.actionRequestId!).catch(() => undefined);
    expect(await p.run((tx) => tx.workTask.count({ where: { projectId: p.owner.projectId } }))).toBe(30);
    expect(mocked.calls).toBe(1);
  });

  it("stores an invalid plan without an approval request", async () => {
    const queued = await request("Plan a cycle");
    const plan = syntheticPlan(3);
    plan.tasks[0]!.dependsOn = ["t3"];
    plan.tasks[2]!.dependsOn = ["t1"];
    mocked.replies.push(plan);
    await runPlanJob(p.owner, queued.id);
    expect(await proposal(queued.id)).toMatchObject({
      status: "invalid",
      actionRequestId: null,
      errorCode: "PLAN_INVALID",
      validation: { errors: ["PLAN_DEPENDENCY_CYCLE"] },
    });
  });

  it("makes an edit a new revision and withdraws the previous request", async () => {
    const queued = await request("Plan a revision");
    mocked.replies.push(syntheticPlan(4));
    await runPlanJob(p.owner, queued.id);
    const first = await proposal(queued.id);
    const edited = { ...syntheticPlan(4), goal: "Edited goal" };
    const second = await p.run((tx) => revisePlan(tx, p.editor, first.id, { expectedVersion: first.version, plan: edited }));
    expect(second).toMatchObject({ status: "proposed", revision: 2, supersedesId: first.id });
    expect(await proposal(first.id)).toMatchObject({ status: "superseded" });
    const old = await p.run((tx) => entity(tx, p.owner, "action_requests", first.actionRequestId!));
    expect(data(old).status).toBe("canceled");
    expect(await failure(decide(p.editor, first.actionRequestId!))).toBe("ACTION_REQUEST_NOT_PENDING");
    // Discarding withdraws the new request; nothing was applied.
    await p.run((tx) => discardPlan(tx, p.editor, second.id));
    const withdrawn = await p.run((tx) => entity(tx, p.owner, "action_requests", second.actionRequestId!));
    expect(data(withdrawn).status).toBe("canceled");
  });

  it("never sends a planning call twice and stops at the daily ceiling", async () => {
    const queued = await request("Plan with a broken connection");
    mocked.replies.push(new Error("socket hang up"));
    await runPlanJob(p.owner, queued.id);
    expect(await proposal(queued.id)).toMatchObject({ status: "failed", errorCode: "AGENT_OUTCOME_UNKNOWN" });
    // A repeated job attempt finds the proposal closed and sends nothing.
    await runPlanJob(p.owner, queued.id);
    expect(mocked.calls).toBe(1);
    const current = await p.run((tx) => readPmSettings(tx, p.owner));
    await p.run((tx) => savePmSettings(tx, p.owner, { ...current.settings, dailyCeilingMicros: 0 }, current.version));
    expect(await failure(request("Plan without budget"))).toBe("WORK_PM_BUDGET_EXHAUSTED");
  });
});

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  scoped,
  closeDatabase,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { create, data, update } from "../src/shared.ts";
import { createPackageProject } from "./support/package-project.ts";
import { runOperation } from "../src/modules/marketing/agents/run-operation.ts";
import { latestAssignmentResult } from "../src/modules/marketing/agents/assignment-result.ts";
import {
  conversationAssignments,
  listAssignments,
} from "../src/modules/marketing/agents/assignment-overview.ts";
import { assignmentRun } from "./support/assignment-review.ts";
import { marketingAttention } from "../src/modules/marketing/attention.ts";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)("MA-06 shared operational evidence", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, fn);
  beforeEach(async () => {
    vi.stubEnv("ORBIT_AGENTS", "true");
    project = await createPackageProject();
  });
  afterEach(async () => {
    await project.cleanup();
    vi.unstubAllEnvs();
  });
  afterAll(closeDatabase);
  const saved = (changes: Record<string, unknown> = {}) =>
    run((tx) =>
      create(tx, project.owner, "assignment_runs", {
        assignmentId: randomUUID(),
        status: "done",
        date: "2026-10-20",
        slots: [],
        steps: [],
        ...changes,
      }),
    );
  const task = (runId: string, changes: Record<string, unknown> = {}) =>
    run((tx) =>
      create(tx, project.owner, "agent_tasks", {
        runId,
        stepKey: "review",
        role: "review",
        status: "done",
        errorCode: null,
        ...changes,
      }),
    );
  it("labels optional research degradation while required review remains usable", async () => {
    const row = await saved({
      status: "partial",
      steps: [
        { key: "research", status: "failed", dependsOn: [] },
        {
          key: "strategy",
          status: "done",
          dependsOn: ["research"],
          optionalDependsOn: ["research"],
        },
        { key: "review", status: "done", dependsOn: ["strategy"] },
      ],
    });
    await task(row.id, {
      stepKey: "research",
      status: "failed",
      errorCode: "RESEARCH_UNAVAILABLE",
    });
    const operation = await run((tx) =>
      runOperation(tx, project.owner, row, []),
    );
    expect(operation).toMatchObject({
      state: "degraded",
      lifecycle: "partial",
      degraded: true,
      complete: true,
    });
    expect(operation.issues[0]).toMatchObject({
      optional: true,
      code: "RESEARCH_UNAVAILABLE",
    });
    expect(
      (
        await run((tx) => marketingAttention(tx, project.owner, new Date()))
      ).find((i) => i.params.code === "RUN_DEGRADED"),
    ).toMatchObject({ severity: "warning", count: 1 });
    await task(row.id, { status: "failed", errorCode: "REVIEW_FAILED" });
    expect(
      await run((tx) => runOperation(tx, project.owner, row, [])),
    ).toMatchObject({ state: "failed", degraded: true });
  });
  it("partitions ledger totals across model, image and retrieval without trusting cached run cost", async () => {
    const row = await saved({ costMicros: 999999 });
    const t = await task(row.id);
    for (const [suffix, state, amount, settled] of [
      [`agent:${t.id}:model`, "settled", 100, 60],
      [`image:agent:${t.id}:image`, "reserved", 200, null],
      [`query:agent:${t.id}:lookup`, "unknown", 300, null],
      [`query:mission:agent:${t.id}:lookup`, "released", 400, null],
    ] as const)
      await run((tx) =>
        tx.budgetReservation.create({
          data: {
            workspaceId: project.owner.workspaceId,
            projectId: project.owner.projectId,
            key: `${project.owner.projectId}:${suffix}`,
            category: "model",
            state,
            amountMicros: BigInt(amount),
            settledMicros: settled === null ? null : BigInt(settled),
          },
        }),
      );
    expect(
      await run((tx) => runOperation(tx, project.owner, row, [])),
    ).toMatchObject({
      state: "outcome_unknown",
      costs: {
        settledMicros: 60,
        heldMicros: 200,
        unknownMicros: 300,
        releasedMicros: 400,
        complete: true,
      },
      recovery: [{ action: "reconcile_outcome", href: "/operations" }],
    });
  });
  it.each(["outcome_unknown", "reconciliation_required"])(
    "does not call a completed run delivered when publication is %s",
    async (status) => {
      const row = await saved();
      expect(
        await run((tx) =>
          runOperation(tx, project.owner, row, [
            { outcome: "handed_over", publicationStatus: status },
          ]),
        ),
      ).toMatchObject({ state: "outcome_unknown", lifecycle: "done" });
    },
  );
  it("keeps owner approval separate from completed work and capacity holds", async () => {
    const row = await saved();
    expect(
      await run((tx) =>
        runOperation(tx, project.owner, row, [{ outcome: "awaiting_owner" }]),
      ),
    ).toMatchObject({
      state: "awaiting_owner",
      recovery: [{ action: "review_content", href: "/approvals" }],
    });
    await task(row.id, {
      status: "queued",
      errorCode: "ASSIGNMENT_REVIEW_BACKLOG_FULL",
    });
    expect(
      await run((tx) => runOperation(tx, project.owner, row, [])),
    ).toMatchObject({ state: "blocked" });
  });
  it("discloses bounded partial evidence rather than reporting a successful total", async () => {
    const row = await saved();
    await run(async (tx) => {
      for (let i = 0; i < 101; i++)
        await create(tx, project.owner, "agent_tasks", {
          runId: row.id,
          stepKey: `s${i}`,
          status: "done",
        });
    });
    expect(
      await run((tx) => runOperation(tx, project.owner, row, [])),
    ).toMatchObject({
      state: "outcome_unknown",
      complete: false,
      costs: { complete: false },
    });
  });
  it("does not read another project's tasks, ledger or latest result", async () => {
    const row = await saved();
    await task(row.id, { status: "outcome_unknown" });
    const other = await createPackageProject();
    try {
      const result = await scoped(
        other.owner.workspaceId,
        other.owner.projectId,
        async (tx) => ({
          operation: await runOperation(tx, other.owner, row, []),
          latest: await latestAssignmentResult(
            tx,
            other.owner,
            data(row).assignmentId,
          ),
        }),
      );
      expect(result.latest).toBeNull();
      expect(result.operation.issues).toEqual([]);
      expect(result.operation.costs.unknownMicros).toBe(0);
    } finally {
      await other.cleanup();
    }
  });
  it("shares the exact saved projection between assignment management and chat", async () => {
    const h = assignmentRun(project);
    const assignment = await h.makeAssignment();
    const row = await saved({ assignmentId: assignment.id });
    await task(row.id, {
      status: "outcome_unknown",
      errorCode: "AGENT_OUTCOME_UNKNOWN",
    });
    const [latest, chat, overview] = await run(async (tx) =>
      Promise.all([
        latestAssignmentResult(tx, project.owner, assignment.id),
        conversationAssignments(tx, project.owner, [assignment.id]),
        listAssignments(tx, project.owner),
      ]),
    );
    expect(chat[0]!.latestRun!.operation).toEqual(latest!.operation);
    expect(
      overview.items.find((i) => i.id === assignment.id)!.latestRun!.operation,
    ).toEqual(latest!.operation);
  });
});

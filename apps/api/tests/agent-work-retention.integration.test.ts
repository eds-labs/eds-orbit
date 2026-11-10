import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { registerModules } from "../src/modules/registry.ts";
import { retention } from "../src/platform/governance/retention.ts";
import {
  AGENT_RUN_RETENTION_DAYS,
  WORK_ORDER_RETENTION_DAYS,
  agentWorkRetention,
} from "../src/platform/agents/work-orders/retention.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerModules();

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

/**
 * Agent records under the project's retention action (ADR 0021, plan WP1.4,
 * T-4): finished work order trees after 90 days, agent runs with their spans
 * after 180 days, a shorter project period first, in the project only.
 */
describe.skipIf(!enabled)("agent work order and run retention", () => {
  const workspaces: string[] = [];
  let scope: Scope;
  let other: Scope;
  const run = <T>(fn: (tx: DbTx) => Promise<T>, s = scope) =>
    scoped(s.workspaceId, s.projectId, fn);
  const project = async () => {
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic agent retention" },
    });
    workspaces.push(workspace.id);
    const row = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic agent retention" },
    });
    return {
      workspaceId: workspace.id,
      projectId: row.id,
      userId: "owner",
      role: "owner" as const,
    };
  };
  /** A work order that finished `finished` days ago (null: still running). */
  const workOrder = (
    s: Scope,
    finished: number | null,
    tree: { parentId?: string; rootId?: string; depth?: number } = {},
  ) =>
    run(async (tx) => {
      const row = await tx.agentWorkOrder.create({
        data: {
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          target: "agent",
          agentId: randomUUID(),
          origin: tree.parentId ? "agent" : "manual",
          idempotencyKey: randomUUID(),
          requestedBy: { kind: "user", userId: s.userId },
          allow: { tools: [] },
          parentId: tree.parentId ?? null,
          rootId: tree.rootId ?? null,
          depth: tree.depth ?? 0,
          goal: "Synthetic retention goal",
          status: finished === null ? "running" : "succeeded",
          ceilingMicros: 1000n,
          createdAt: ago((finished ?? 0) + 1),
          finishedAt: finished === null ? null : ago(finished),
        },
      });
      return row.id;
    }, s);
  /** An agent run started `days` ago with one span. */
  const agentRun = (s: Scope, days: number) =>
    run(async (tx) => {
      const id = randomUUID();
      await tx.agentRun.create({
        data: {
          id,
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          kind: "agent_work",
          agentName: "retention-test",
          taskClass: "agent_custom",
          status: "succeeded",
          startedAt: ago(days),
        },
      });
      await tx.agentSpan.create({
        data: {
          id: randomUUID(),
          workspaceId: s.workspaceId,
          projectId: s.projectId,
          runId: id,
          type: "model_call",
          name: "retention-test",
          status: "succeeded",
          startedAt: ago(days),
          durationMs: 1,
        },
      });
      return id;
    }, s);
  const workOrderIds = (s = scope) =>
    run(
      async (tx) =>
        (await tx.agentWorkOrder.findMany({ select: { id: true } }))
          .map((r) => r.id)
          .sort(),
      s,
    );
  const runIds = (s = scope) =>
    run(
      async (tx) =>
        (await tx.agentRun.findMany({ select: { id: true } }))
          .map((r) => r.id)
          .sort(),
      s,
    );

  beforeAll(async () => {
    scope = await project();
    other = await project();
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await closeDatabase();
  });

  it("uses 90 and 180 days as defaults", () => {
    expect(WORK_ORDER_RETENTION_DAYS).toBe(90);
    expect(AGENT_RUN_RETENTION_DAYS).toBe(180);
  });

  it("purges finished trees and old runs by date, in the project only", async () => {
    // A fully finished, old tree of depth 2: purged as a whole.
    const oldRoot = await workOrder(scope, 100);
    const oldChild = await workOrder(scope, 100, { parentId: oldRoot, rootId: oldRoot, depth: 1 });
    await workOrder(scope, 95, { parentId: oldChild, rootId: oldRoot, depth: 2 });
    // Finished within 90 days: kept.
    const recentRoot = await workOrder(scope, 80);
    // An old root with an unfinished child, and one with a grandchild that
    // finished recently: kept with all of their rows.
    const liveRoot = await workOrder(scope, 100);
    const liveChild = await workOrder(scope, null, { parentId: liveRoot, rootId: liveRoot, depth: 1 });
    const busyRoot = await workOrder(scope, 120);
    const busyChild = await workOrder(scope, 120, { parentId: busyRoot, rootId: busyRoot, depth: 1 });
    const busyGrandchild = await workOrder(scope, 10, { parentId: busyChild, rootId: busyRoot, depth: 2 });
    // Never finished: not purged by age.
    const stuck = await workOrder(scope, null);
    // Runs: one past 180 days (with its span), one inside.
    const oldRun = await agentRun(scope, 200);
    const recentRun = await agentRun(scope, 170);
    // A reservation pointing at the old run keeps its plain reference.
    const reservationId = randomUUID();
    const agentId = randomUUID();
    await run((tx) =>
      tx.budgetReservation.create({
        data: {
          id: reservationId,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          key: `${scope.projectId}:${reservationId}`,
          amountMicros: 10n,
          category: "agent_work",
          state: "settled",
          settledMicros: 8n,
          agentRunId: oldRun,
          agentId,
        },
      }),
    );
    // Another project's old rows are untouched.
    const foreignOrder = await workOrder(other, 400);
    const foreignRun = await agentRun(other, 400);

    const result = await run((tx) =>
      agentWorkRetention(tx, scope, { cutoff: ago(3650), at: new Date() }),
    );
    expect(result).toEqual({
      audit: { agentWorkOrders: 1, agentRuns: 1 },
      result: { purgedAgentWorkOrders: 1, purgedAgentRuns: 1 },
    });
    expect(await workOrderIds()).toEqual(
      [recentRoot, liveRoot, liveChild, busyRoot, busyChild, busyGrandchild, stuck].sort(),
    );
    expect(await runIds()).toEqual([recentRun]);
    const spans = await run((tx) =>
      tx.agentSpan.findMany({ select: { runId: true } }),
    );
    expect(spans.map((s) => s.runId)).toEqual([recentRun]);
    const reservation = await run((tx) =>
      tx.budgetReservation.findUniqueOrThrow({ where: { id: reservationId } }),
    );
    expect(reservation).toMatchObject({ agentRunId: oldRun, agentId });
    expect(await workOrderIds(other)).toEqual([foreignOrder]);
    expect(await runIds(other)).toEqual([foreignRun]);

    // Nothing more on a second run.
    expect(
      await run((tx) =>
        agentWorkRetention(tx, scope, { cutoff: ago(3650), at: new Date() }),
      ),
    ).toEqual({ audit: {}, result: {} });
  });

  it("is part of the retention action, where a shorter project period wins", async () => {
    const recentRoot = await workOrder(other, 40);
    const keptRoot = await workOrder(other, 20);
    const recentRun = await agentRun(other, 40);
    const keptRun = await agentRun(other, 20);
    const result = await run(
      (tx) => retention(tx, { ...other, userId: "owner" }, 30),
      other,
    );
    // The two 400-day-old rows from the previous test and the 40-day rows.
    expect(result).toMatchObject({
      purgedAgentWorkOrders: 2,
      purgedAgentRuns: 2,
    });
    expect(await workOrderIds(other)).toEqual([keptRoot]);
    expect(await runIds(other)).toEqual([keptRun]);
    expect(await workOrderIds(other)).not.toContain(recentRoot);
    expect(await runIds(other)).not.toContain(recentRun);
    const [entry] = await run(
      (tx) => tx.auditEvent.findMany({ where: { action: "retention.apply" } }),
      other,
    );
    expect(entry!.metadata).toMatchObject({
      days: 30,
      agentWorkOrders: 2,
      agentRuns: 2,
    });
  });
});

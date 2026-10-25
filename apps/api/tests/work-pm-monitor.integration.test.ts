import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabase, type DbTx } from "../../../packages/db/src/index.ts";
import { data } from "../src/shared.ts";
import { registerModules } from "../src/modules/registry.ts";
import { createInitiative } from "../src/modules/work/initiatives.ts";
import { createTask, updateTask } from "../src/modules/work/tasks.ts";
import { pmActor } from "../src/modules/work/pm/planner.ts";
import { setPmState } from "../src/modules/work/pm/state.ts";
import {
  dismissFinding,
  listFindings,
  pmMonitorSubscriber,
  runScanJob,
  scanInitiative,
} from "../src/modules/work/pm/monitor.ts";
import { createWorkPmProject, withEnv } from "./support/work-pm-project.ts";

registerModules();

// Monitoring makes no model call: any call fails the test.
const mocked = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  respond: vi.fn(async () => {
    mocked.calls++;
    throw new Error("NO_MODEL_CALL_EXPECTED");
  }),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/** Rule scans, findings, escalation and the event-driven wake-up (WP2.4). */
describe.skipIf(!enabled)("AI project manager monitoring", () => {
  let p: Awaited<ReturnType<typeof createWorkPmProject>>;
  let initiativeId = "";
  const env = withEnv({ ORBIT_WORK: "true", ORBIT_WORK_PM: "true", ORBIT_NOTIFICATIONS: "true" });
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const task = (body: Record<string, unknown>) =>
    p.run((tx) => createTask(tx, p.owner, { initiativeId, ...body }, p.as(p.owner)));
  const scan = () => p.run((tx) => scanInitiative(tx, p.owner, initiativeId));
  const findings = (status?: "open" | "resolved" | "dismissed") =>
    p.run((tx) => listFindings(tx, p.owner, { initiativeId, status }));
  const monitorJobs = (tx: DbTx) =>
    tx.entity.findMany({
      where: { projectId: p.owner.projectId, kind: "jobs", data: { path: ["subscriber"], equals: "work.pm" } },
    });

  beforeAll(async () => {
    env.apply();
    p = await createWorkPmProject();
    const initiative = await p.run((tx) =>
      createInitiative(tx, p.owner, { title: "Watched", ownerUserId: p.editor.userId }, p.as(p.owner)),
    );
    initiativeId = initiative.id;
    await p.run((tx) => setPmState(tx, p.owner, initiativeId, { expectedVersion: 0, enabled: true }));
  });
  afterAll(async () => {
    env.restore();
    await p?.cleanup();
    await closeDatabase();
  });

  it("opens findings once, escalates critical ones and resolves them when cleared", async () => {
    const urgent = await task({ title: "Urgent and late", priority: "urgent", dueDate: yesterday, assigneeUserId: p.editor.userId });
    const first = await scan();
    expect(first).toMatchObject({ opened: 1, resolved: 0 });
    expect((await findings()).map((f) => [f.rule, f.severity, f.taskIds])).toEqual([["overdue", "critical", [urgent.id]]]);
    // Notifications are private to each member (RLS); the audit counts them.
    const escalations = () =>
      p.run((tx) => tx.auditEvent.findMany({ where: { projectId: p.owner.projectId, action: "work.pm.escalated" } }));
    expect((await escalations()).map((a) => a.metadata)).toEqual([{ findings: 1, notified: 1 }]);
    // The same condition stays one finding and is not escalated again.
    expect(await scan()).toMatchObject({ opened: 0, resolved: 0, critical: [] });
    expect(await findings()).toHaveLength(1);
    expect(await escalations()).toHaveLength(1);
    await p.run((tx) => updateTask(tx, p.owner, urgent.id, { expectedVersion: urgent.version, status: "done" }, p.as(p.owner)));
    expect(await scan()).toMatchObject({ resolved: 1 });
    expect(await findings()).toEqual([]);
    expect((await findings("resolved")).map((f) => f.rule)).toEqual(["overdue"]);
  });

  it("keeps a dismissed finding quiet until its time is over", async () => {
    await task({ title: "Late", dueDate: yesterday });
    await scan();
    const [finding] = await findings();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await p.run((tx) => dismissFinding(tx, p.editor, finding!.id, { until }));
    expect(await scan()).toMatchObject({ opened: 0 });
    expect((await findings("dismissed")).map((f) => f.id)).toEqual([finding!.id]);
    await p.run((tx) => tx.workPmFinding.update({ where: { id: finding!.id }, data: { dismissedUntil: new Date(Date.now() - 1000) } }));
    expect(await scan()).toMatchObject({ opened: 1 });
    expect((await findings()).map((f) => [f.rule, f.id])).toEqual([["overdue", finding!.id]]);
  });

  it("wakes on member changes, at most one scan per five minutes, never on its own writes", async () => {
    const before = (await p.run(monitorJobs)).length;
    const own = await p.run((tx) => createTask(tx, p.owner, { initiativeId, title: "Written by the PM" }, pmActor, "pm_agent"));
    expect((await p.run(monitorJobs)).length).toBe(before);
    await p.run((tx) => updateTask(tx, p.owner, own.id, { expectedVersion: own.version, priority: "high" }, p.as(p.owner)));
    expect((await p.run(monitorJobs)).length).toBe(before + 1);
    // A hundred events in one bucket queue one scan.
    const event = {
      id: own.id,
      type: "work.task.updated",
      subject: { type: "work.task", id: own.id },
      actor: { kind: "user" as const, id: p.owner.userId },
      origin: "work",
      depth: 0,
      correlationId: own.id,
      data: {},
      createdAt: new Date().toISOString(),
    };
    const scans = (tx: DbTx) =>
      tx.entity.findMany({
        where: {
          projectId: p.owner.projectId,
          kind: "jobs",
          AND: [
            { data: { path: ["kind"], equals: "scan" } },
            { data: { path: ["resourceId"], equals: initiativeId } },
          ],
        },
      });
    const queuedBefore = (await p.run(scans)).length;
    for (let i = 0; i < 100; i++) await p.run((tx) => pmMonitorSubscriber.handler(tx, p.owner, event as never));
    const queued = await p.run(scans);
    expect(queued.length - queuedBefore).toBeLessThanOrEqual(1);
    expect(new Date(data(queued.at(-1)!).availableAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("does nothing while the PM is off or the initiative is not watched", async () => {
    process.env.ORBIT_WORK_PM = "false";
    try {
      expect(await runScanJob(p.owner, initiativeId)).toBeNull();
    } finally {
      process.env.ORBIT_WORK_PM = "true";
    }
    const other = await p.run((tx) => createInitiative(tx, p.owner, { title: "Unwatched" }, p.as(p.owner)));
    expect(await runScanJob(p.owner, other.id)).toBeNull();
    expect(mocked.calls).toBe(0);
  });
});

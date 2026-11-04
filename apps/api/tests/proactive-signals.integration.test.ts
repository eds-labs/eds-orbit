import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { finishWorkOrder } from "../src/platform/agents/work-orders/execute.ts";
import { reserve } from "../src/platform/ai/budget.ts";
import { notifyMembers } from "../src/platform/notifications/members.ts";
import {
  registeredSignals,
  registeredSubscriber,
} from "../src/platform/modules/contributions.ts";
import { deliverFindings } from "../src/platform/signals/deliver.ts";
import {
  BUDGET_THRESHOLD_EVENT,
  crossedThresholds,
} from "../src/platform/signals/budget-threshold.ts";
import { signalsPeriodic, resetSignalThrottle } from "../src/platform/signals/adapters.ts";
import { saveSignalSettings, listSignalSettings } from "../src/platform/signals/settings.ts";
import { taskCompletedSignal } from "../src/modules/work/signals.ts";
import { proactiveFixture, type ProactiveFixture } from "./support/proactive-fixture.ts";

// Proactive signals (ADR 0023, plan WP4.1/WP4.2, §10): deterministic
// detection with no model call, dedupe by key, budget thresholds once,
// aging approvals to deciders only, module access, no double Support
// notices, and nothing changed while ORBIT_PROACTIVE is off.

const provider = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  respond: vi.fn(async () => {
    provider.calls++;
    throw new Error("REAL_PROVIDER_CALLED");
  }),
}));

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
Object.assign(process.env, {
  ORBIT_NOTIFICATIONS: "true",
  ORBIT_PERSONAL_ASSISTANT: "true",
  ORBIT_AGENT_PLATFORM: "true",
  ORBIT_MODULE_ROLES: "true",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
});

const LIMITS = (monthly: number) => ({
  startAt: new Date(Date.now() - 86_400_000).toISOString(),
  endAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  approvedPaidTests: true,
  dailyBudgetMicros: monthly,
  monthlyBudgetMicros: monthly,
  perRunBudgetMicros: monthly,
});

describe.skipIf(!enabled)("Proactive signals (ADR 0023)", () => {
  let f: ProactiveFixture;

  beforeAll(async () => {
    f = await proactiveFixture();
  });
  beforeEach(() => {
    process.env.ORBIT_PROACTIVE = "true";
    delete process.env.ORBIT_EMAIL;
    provider.calls = 0;
  });
  afterAll(async () => {
    delete process.env.ORBIT_PROACTIVE;
    await f?.cleanup();
    await closeDatabase();
  });

  const workOrder = (projectId: string, agentId: string, sponsor: string) =>
    scoped(f.workspaceId, projectId, (tx) =>
      tx.agentWorkOrder.create({
        data: {
          workspaceId: f.workspaceId,
          projectId,
          target: "agent",
          origin: "manual",
          agentId,
          sponsorUserId: sponsor,
          idempotencyKey: `test:${randomUUID()}`,
          requestedBy: { kind: "user", userId: sponsor },
          allow: {},
          goal: "Synthetic goal",
          status: "running",
          ceilingMicros: BigInt(100_000),
        },
      }),
    );

  it("scenario E: three failures of one agent and code on one day are one notice with occurrences 3, without any model call", async () => {
    const agentId = randomUUID();
    for (let i = 0; i < 3; i++) {
      const row = await workOrder(f.businessId, agentId, f.editor);
      await scoped(f.workspaceId, f.businessId, (tx) =>
        finishWorkOrder(tx, f.worker(f.businessId), row, { status: "failed", code: "AGENT_LIMIT" }),
      );
    }
    expect(await f.runSubscriber(f.businessId, "platform.signal_agent_work_failed")).toBe(3);
    // The sponsor (an editor) and the agent managers (owners).
    const sponsor = (await f.notices(f.businessId, f.editor)).filter((n) => n.kind === "agent_work_failed");
    const owner = (await f.notices(f.businessId, f.owner)).filter((n) => n.kind === "agent_work_failed");
    const viewer = (await f.notices(f.businessId, f.viewer)).filter((n) => n.kind === "agent_work_failed");
    expect(sponsor).toHaveLength(1);
    expect(sponsor[0]).toMatchObject({ occurrences: 3, severity: "attention" });
    expect(sponsor[0]!.dedupeKey).toMatch(new RegExp(`^agent_failed:${agentId}:AGENT_LIMIT:\\d{4}-\\d{2}-\\d{2}$`));
    expect(sponsor[0]!.title).toContain("AGENT_LIMIT");
    expect(owner).toHaveLength(1);
    expect(viewer).toHaveLength(0);
    // The Phase 1 day marker is not written any more (the guard is replaced).
    const markers = await scoped(f.workspaceId, f.businessId, (tx) =>
      tx.entity.count({ where: { projectId: f.businessId, kind: "agent_failure_notices" } }),
    );
    expect(markers).toBe(0);
    expect(provider.calls).toBe(0);
  });

  it("a signal storm of 500 failures writes one row per recipient", async () => {
    const agentId = randomUUID();
    const row = await workOrder(f.businessId, agentId, f.editor);
    await scoped(f.workspaceId, f.businessId, (tx) =>
      tx.agentWorkOrder.update({ where: { id: row.id }, data: { status: "failed", errorCode: "CONNECTOR_DOWN" } }),
    );
    const subscriber = registeredSubscriber("platform.signal_agent_work_failed")!;
    const now = new Date();
    await scoped(f.workspaceId, f.businessId, async (tx) => {
      for (let i = 0; i < 500; i++)
        await subscriber.handler(tx, f.worker(f.businessId), {
          id: randomUUID(),
          type: "platform.agent.work_order.failed",
          version: 1,
          subject: { type: "platform.agent_work_order", id: row.id },
          actor: { kind: "agent", id: agentId },
          origin: "platform.agents",
          causationId: null,
          correlationId: randomUUID(),
          depth: 0,
          data: { agentId, status: "failed", code: "CONNECTOR_DOWN" },
          createdAt: now,
        });
    });
    for (const userId of [f.editor, f.owner]) {
      const rows = (await f.notices(f.businessId, userId)).filter((n) => n.dedupeKey?.includes(agentId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.occurrences).toBe(500);
    }
    expect(provider.calls).toBe(0);
  });

  it("a repeat increments occurrences without a new row or delivery job; a rise in severity marks it unread", async () => {
    process.env.ORBIT_EMAIL = "true";
    const send = (severity: "info" | "attention" | "urgent") =>
      scoped(f.workspaceId, f.businessId, (tx) =>
        notifyMembers(tx, f.business, {
          kind: "ai_budget_threshold",
          userIds: [f.owner],
          title: "Synthetic threshold",
          dedupeKey: "test:repeat:1",
          severity,
        }),
      );
    const before = (await f.jobs(f.businessId, "notification_delivery")).length;
    await send("attention");
    const [first] = (await f.notices(f.businessId, f.owner)).filter((n) => n.dedupeKey === "test:repeat:1");
    await scoped(f.workspaceId, f.businessId, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id',${f.owner},true)`;
      await tx.notification.update({ where: { id: first!.id }, data: { readAt: new Date() } });
    });
    await send("attention");
    let [row] = (await f.notices(f.businessId, f.owner)).filter((n) => n.dedupeKey === "test:repeat:1");
    expect(row).toMatchObject({ id: first!.id, occurrences: 2, severity: "attention" });
    expect(row!.readAt).not.toBeNull();
    await send("urgent");
    [row] = (await f.notices(f.businessId, f.owner)).filter((n) => n.dedupeKey === "test:repeat:1");
    expect(row).toMatchObject({ occurrences: 3, severity: "urgent", readAt: null });
    await send("info");
    [row] = (await f.notices(f.businessId, f.owner)).filter((n) => n.dedupeKey === "test:repeat:1");
    expect(row).toMatchObject({ occurrences: 4, severity: "urgent" });
    // Only the first occurrence is delivered (e-mail default on for the kind).
    expect((await f.jobs(f.businessId, "notification_delivery")).length).toBe(before + 1);
  });

  it("a kind switched off in the project wins: no row and no delivery", async () => {
    await scoped(f.workspaceId, f.businessId, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id',${f.editor},true)`;
      await tx.notificationPreference.create({
        data: {
          workspaceId: f.workspaceId,
          projectId: f.businessId,
          userId: f.editor,
          kind: "approval_aging",
          inApp: false,
          email: true,
        },
      });
    });
    const before = (await f.jobs(f.businessId, "notification_delivery")).length;
    const result = await scoped(f.workspaceId, f.businessId, (tx) =>
      notifyMembers(tx, f.business, {
        kind: "approval_aging",
        userIds: [f.editor],
        title: "Synthetic aging",
        dedupeKey: "test:kind-off",
      }),
    );
    expect(result).toEqual({ inApp: 0, email: 0 });
    expect((await f.notices(f.businessId, f.editor)).some((n) => n.dedupeKey === "test:kind-off")).toBe(false);
    expect((await f.jobs(f.businessId, "notification_delivery")).length).toBe(before);
  });

  it("emits a budget threshold once at 80 % and once at 100 % per period, also under parallel reservations", async () => {
    const projectId = await f.project("Synthetic budget project", []);
    const scope = f.scopeOf(projectId, f.owner);
    const r = (amount: number) =>
      scoped(f.workspaceId, projectId, (tx) =>
        reserve(tx, scope, `test:${randomUUID()}`, "test", amount, LIMITS(1000), new Date(), `run:${randomUUID()}`),
      );
    await r(700);
    // Five parallel reservations of 50 cross 80 % together (700 -> 950).
    await Promise.all(Array.from({ length: 5 }, () => r(50)));
    // 950 + 40 leaves 10, less than this size: used up.
    await r(40);
    await r(5);
    const events = await scoped(f.workspaceId, projectId, (tx) =>
      tx.domainEvent.findMany({ where: { projectId, type: BUDGET_THRESHOLD_EVENT }, orderBy: { createdAt: "asc" } }),
    );
    expect(events.map((e) => (e.data as { threshold: number }).threshold).sort()).toEqual([100, 80]);
    expect(events.every((e) => (e.data as { layer: string }).layer === "project_month")).toBe(true);
    expect(JSON.stringify(events.map((e) => e.data))).not.toMatch(/Micros|amount/);
    await f.runSubscriber(projectId, "platform.signal_budget_threshold");
    const notices = (await f.notices(projectId, f.owner)).filter((n) => n.kind === "ai_budget_threshold");
    expect(notices.map((n) => n.severity).sort()).toEqual(["attention", "urgent"]);
    expect(notices.every((n) => n.link === `/p/${projectId}/settings?section=ai`)).toBe(true);
    expect(provider.calls).toBe(0);
  });

  it("computes threshold crossings deterministically", () => {
    expect(crossedThresholds({ before: 700, after: 850, amount: 150, limit: 1000 })).toEqual([80]);
    expect(crossedThresholds({ before: 850, after: 990, amount: 140, limit: 1000 })).toEqual([100]);
    expect(crossedThresholds({ before: 100, after: 200, amount: 100, limit: 1000 })).toEqual([]);
    expect(crossedThresholds({ before: 0, after: 1000, amount: 1000, limit: 1000 })).toEqual([80, 100]);
    expect(crossedThresholds({ before: 0, after: 10, amount: 10, limit: null })).toEqual([]);
  });

  it("sends an aging approval only to members who may decide it", async () => {
    const projectId = await f.project("Synthetic approvals project", [
      [f.editor, "editor"],
      [f.viewer, "viewer"],
    ]);
    const old = new Date(Date.now() - 2 * 86_400_000);
    await scoped(f.workspaceId, projectId, (tx) =>
      tx.entity.create({
        data: {
          workspaceId: f.workspaceId,
          projectId,
          kind: "action_requests",
          createdAt: old,
          data: {
            status: "pending",
            actionType: "platform.task.start",
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            payload: {},
          },
        },
      }),
    );
    resetSignalThrottle();
    await signalsPeriodic.run(f.worker(projectId));
    const ownerRows = (await f.notices(projectId, f.owner)).filter((n) => n.kind === "approval_aging");
    expect(ownerRows).toHaveLength(1);
    expect(ownerRows[0]!.link).toBe(`/p/${projectId}/decisions`);
    expect((await f.notices(projectId, f.editor)).filter((n) => n.kind === "approval_aging")).toHaveLength(0);
    expect((await f.notices(projectId, f.viewer)).filter((n) => n.kind === "approval_aging")).toHaveLength(0);
    // The next hourly pass on the same day repeats the same row.
    resetSignalThrottle();
    await signalsPeriodic.run(f.worker(projectId));
    const again = (await f.notices(projectId, f.owner)).filter((n) => n.kind === "approval_aging");
    expect(again).toHaveLength(1);
    expect(again[0]!.occurrences).toBe(2);
  });

  it("gives a user without access to the module nothing", async () => {
    const projectId = await f.project("Synthetic work project", [[f.editor, "editor"]]);
    await authDb.projectMemberModuleRole.create({
      data: { workspaceId: f.workspaceId, projectId, userId: f.editor, moduleId: "work", role: "none" },
    });
    const def = registeredSignals().find((s) => s.key === taskCompletedSignal.key)!;
    await scoped(f.workspaceId, projectId, (tx) =>
      deliverFindings(tx, f.scopeOf(projectId, f.owner), def, [
        {
          fingerprint: `task_completed:${randomUUID()}`,
          recipients: { userIds: [f.editor, f.owner] },
          severity: "info",
          titleKey: "completed",
          params: { number: 7 },
          link: `/p/${projectId}/work/tasks`,
        },
      ]),
    );
    expect(await f.notices(projectId, f.editor)).toHaveLength(0);
    const owner = await f.notices(projectId, f.owner);
    expect(owner).toHaveLength(1);
    expect(owner[0]!.title).toBe("Task #7 is done");
  });

  it("maps Support's urgent notices without detecting them again", async () => {
    const support = registeredSignals().filter((s) => s.owner === "support");
    expect(support.map((s) => s.key)).toEqual(["support.urgent_ticket"]);
    expect(support.every((s) => !s.detect && "kinds" in s.source)).toBe(true);
    await scoped(f.workspaceId, f.businessId, (tx) =>
      notifyMembers(tx, f.business, {
        kind: "support_sla_breached",
        userIds: [f.owner],
        title: "#12 · SLA breached",
        link: `/p/${f.businessId}/support?ticket=${randomUUID()}`,
      }),
    );
    const rows = (await f.notices(f.businessId, f.owner)).filter((n) => n.kind === "support_sla_breached");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe("urgent");
    // No signal writes a Support kind of its own.
    expect(registeredSignals().filter((s) => s.detect && s.kind.startsWith("support_"))).toEqual([]);
  });

  it("lets owners switch a detector off per project; a switched-off detector writes nothing", async () => {
    const projectId = await f.project("Synthetic switch project", [[f.editor, "editor"]]);
    const owner = f.scopeOf(projectId, f.owner);
    const listed = await scoped(f.workspaceId, projectId, (tx) => listSignalSettings(tx, owner));
    expect(listed.signals.find((s) => s.key === "platform.agent_work_failed")).toMatchObject({ on: true, switchable: true });
    await expect(
      scoped(f.workspaceId, projectId, (tx) =>
        saveSignalSettings(tx, f.scopeOf(projectId, f.editor, "editor"), { signals: { "platform.agent_work_failed": false } }),
      ),
    ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
    await scoped(f.workspaceId, projectId, (tx) =>
      saveSignalSettings(tx, owner, { signals: { "platform.agent_work_failed": false } }),
    );
    const def = registeredSignals().find((s) => s.key === "platform.agent_work_failed")!;
    const written = await scoped(f.workspaceId, projectId, (tx) =>
      deliverFindings(tx, owner, def, [
        {
          fingerprint: `agent_failed:x:y:${randomUUID()}`,
          recipients: { userIds: [f.owner] },
          severity: "attention",
          titleKey: "failed",
          params: { code: "X" },
          link: `/p/${projectId}/agents`,
        },
      ]),
    );
    expect(written).toBe(0);
  });

  it("changes nothing while ORBIT_PROACTIVE is off", async () => {
    process.env.ORBIT_PROACTIVE = "false";
    const projectId = await f.project("Synthetic flag-off project", []);
    const scope = f.scopeOf(projectId, f.owner);
    const send = () =>
      scoped(f.workspaceId, projectId, (tx) =>
        notifyMembers(tx, scope, {
          kind: "agent_work_failed",
          userIds: [f.owner],
          title: "Synthetic",
          dedupeKey: "test:off",
          severity: "urgent",
        }),
      );
    await send();
    await send();
    const rows = await f.notices(projectId, f.owner);
    // The options are ignored: two rows as before, the default severity.
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.dedupeKey === null && r.severity === "info" && r.occurrences === 1)).toBe(true);
    expect(await f.jobs(projectId, "notification_delivery")).toHaveLength(0);
    // The failure guard of Phase 1 is back, and no signal job is queued.
    const agentId = randomUUID();
    const row = await workOrder(projectId, agentId, f.owner);
    await scoped(f.workspaceId, projectId, (tx) =>
      finishWorkOrder(tx, f.worker(projectId), row, { status: "failed", code: "AGENT_LIMIT" }),
    );
    const subscribers = (await f.jobs(projectId, "domain_event")).map((j: Record<string, unknown>) => j.subscriber);
    expect(subscribers.some((s) => String(s).includes(".signal_"))).toBe(false);
    expect((await f.notices(projectId, f.owner)).filter((n) => n.kind === "agent_work_failed")).toHaveLength(3);
    // No threshold events either.
    await scoped(f.workspaceId, projectId, (tx) =>
      reserve(tx, scope, `test:${randomUUID()}`, "test", 900, LIMITS(1000), new Date(), `run:${randomUUID()}`),
    );
    const events = await scoped(f.workspaceId, projectId, (tx) =>
      tx.domainEvent.count({ where: { projectId, type: BUDGET_THRESHOLD_EVENT } }),
    );
    expect(events).toBe(0);
    expect(await signalsPeriodic.nextDueAt!({} as never, scope)).toBeNull();
  });
});

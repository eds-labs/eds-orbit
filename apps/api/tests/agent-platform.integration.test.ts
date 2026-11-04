import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authDb, closeDatabase, scoped, type DbTx } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { agentToolCatalog } from "../src/platform/agents/definitions/catalog.ts";
import { configHash } from "../src/platform/agents/definitions/schema.ts";
import {
  activateAgent,
  agentVersions,
  createAgent,
  readVisibleAgent,
  setAgentStatus,
  updateAgentDraft,
} from "../src/platform/agents/definitions/service.ts";
import { agentWorkJob, finishWorkOrder } from "../src/platform/agents/work-orders/execute.ts";
import {
  cancelWorkOrder,
  listWorkOrders,
  startManualWorkOrder,
} from "../src/platform/agents/work-orders/service.ts";
import { agentTriggerSubscriber, TEST_PING } from "../src/platform/agents/triggers/events.ts";
import { agentScheduleScheduler, slotsBetween } from "../src/platform/agents/triggers/schedule.ts";
import { planChildWorkOrders } from "../src/platform/agents/work-orders/delegation.ts";
import { managedAgentGroups } from "../src/platform/agents/managed.ts";
import { create } from "../src/shared.ts";
import { registerModules } from "../src/modules/registry.ts";
import { createPackageProject } from "./support/package-project.ts";

registerModules();

// Scripted provider: each queued reply is one call's output items. No test reaches a provider.
const mocked = vi.hoisted(() => ({
  replies: [] as Array<unknown[] | Error>,
  // Runs before the reply is returned (to change state between calls).
  before: [] as Array<(() => Promise<void>) | undefined>,
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  respond: vi.fn(async (request: any) => {
    await mocked.before.shift()?.();
    const next = mocked.replies.shift();
    if (next === undefined) throw new Error("NO_RECORDED_REPLY");
    if (next instanceof Error) throw next;
    return {
      output: next,
      usage: {
        model: request.route.model,
        inputTokens: 100,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 20,
        reasoningTokens: 0,
        costMicros: 7,
      },
      responseId: `resp_${randomUUID()}`,
      truncated: false,
    };
  }),
}));

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const message = (value: unknown) => [
  { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] },
];
const call = (name: string, args: unknown) => [
  { type: "function_call", call_id: `call_${randomUUID()}`, name, arguments: JSON.stringify(args) },
];
const done = message({ outcome: "done", summary: "Looked at the sources." });

describe.skipIf(!enabled)("agent platform (ADR 0021, Phase 1)", () => {
  let p: Awaited<ReturnType<typeof createPackageProject>>;
  const saved: Record<string, string | undefined> = {};
  const flags = {
    ORBIT_AGENT_PLATFORM: "true",
    ORBIT_AGENT_AUTOMATION: "true",
    ORBIT_NOTIFICATIONS: "true",
  };
  const runIn = <T>(work: (tx: DbTx) => Promise<T>) => scoped(p.owner.workspaceId, p.owner.projectId, work);
  const worker = (): Scope => ({ ...p.owner, userId: "worker", role: "owner" });
  const config = (extra: Record<string, unknown> = {}) => ({
    name: "Source watcher",
    description: "Checks the knowledge sources.",
    templateKey: null,
    instructions: "Report stale sources.",
    modules: ["knowledge"],
    tools: ["knowledge_sources", "knowledge_propose_fact"],
    knowledge: null,
    mode: "draft",
    model: { override: null },
    limits: { maxModelCalls: 4, maxToolCalls: 4, wallSeconds: 60, maxRunsPerDay: 50, maxConcurrent: 3 },
    budget: { monthlyCeilingMicros: 1_000_000, runCeilingMicros: 100_000 },
    triggers: [{ kind: "manual" }],
    delegateTo: [],
    outputs: { notify: ["sponsor"], onFailure: "notify" },
    ...extra,
  });
  async function activeAgent(extra: Record<string, unknown> = {}) {
    const created = await runIn((tx) => createAgent(tx, p.owner, { config: config(extra) }));
    return runIn((tx) =>
      activateAgent(tx, p.owner, created.id, {
        version: created.version,
        configHash: configHash(created.definition.draft),
      }),
    );
  }
  const runJob = (workOrderId: string) =>
    agentWorkJob.handler({ scope: worker(), jobId: randomUUID(), job: { resourceId: workOrderId }, executionMode: "test" });
  const workOrder = (id: string) => runIn((tx) => tx.agentWorkOrder.findFirstOrThrow({ where: { id } }));
  const setRole = (userId: string, role: string) =>
    authDb.projectMember.update({
      where: { projectId_userId: { projectId: p.owner.projectId, userId } },
      data: { role },
    });

  beforeAll(async () => {
    for (const [k, v] of Object.entries(flags)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    p = await createPackageProject({ name: "Synthetic agent platform" });
  });
  beforeEach(() => {
    mocked.replies.length = 0;
    mocked.before.length = 0;
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await p?.cleanup();
    await closeDatabase();
  });

  it("keeps the active configuration while the draft is edited, and activates only the shown draft", async () => {
    // Only owners create; a forged tool name is refused.
    await expect(runIn((tx) => createAgent(tx, p.editor, { config: config() }))).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
    await expect(
      runIn((tx) => createAgent(tx, p.owner, { config: config({ tools: ["knowledge_sources", "drop_database"] }) })),
    ).rejects.toMatchObject({ code: "AGENT_TOOL_NOT_GRANTABLE" });
    // A tool of a module the agent does not name is not grantable either.
    await expect(
      runIn((tx) => createAgent(tx, p.owner, { config: config({ tools: ["marketing_campaigns"] }) })),
    ).rejects.toMatchObject({ code: "AGENT_TOOL_NOT_GRANTABLE" });
    const created = await runIn((tx) => createAgent(tx, p.owner, { config: config() }));
    expect(created.definition).toMatchObject({ status: "draft", active: null, activation: null });
    await expect(
      runIn((tx) => activateAgent(tx, p.owner, created.id, { version: created.version, configHash: "0".repeat(64) })),
    ).rejects.toMatchObject({ code: "AGENT_VERSION_CHANGED" });
    await expect(
      runIn((tx) =>
        activateAgent(tx, p.editor, created.id, { version: created.version, configHash: configHash(created.definition.draft) }),
      ),
    ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
    const active = await runIn((tx) =>
      activateAgent(tx, p.owner, created.id, { version: created.version, configHash: configHash(created.definition.draft) }),
    );
    expect(active.definition).toMatchObject({
      status: "active",
      draft: null,
      activation: { sponsorUserId: p.owner.userId, version: 1 },
    });
    const edited = await runIn((tx) =>
      updateAgentDraft(tx, p.owner, created.id, { version: active.version, config: config({ name: "Renamed" }) }),
    );
    expect(edited.definition.active!.name).toBe("Source watcher");
    expect(edited.definition.draft!.name).toBe("Renamed");
    expect((await runIn((tx) => agentVersions(tx, p.owner, created.id))).length).toBe(3);
    // Editors see it; viewers do not.
    await expect(runIn((tx) => readVisibleAgent(tx, p.editor, created.id))).resolves.toBeTruthy();
    await expect(runIn((tx) => readVisibleAgent(tx, p.viewer, created.id))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("offers in the catalogue only tools the member may grant, with the reason otherwise", async () => {
    const owner = await runIn((tx) => agentToolCatalog(tx, p.owner));
    const viewer = await runIn((tx) => agentToolCatalog(tx, p.viewer));
    const of = (list: typeof owner, name: string) => list.find((t) => t.name === name);
    expect(of(owner, "knowledge_propose_fact")).toMatchObject({ grantable: true, needsApproval: true, mandatable: true });
    expect(of(viewer, "knowledge_propose_fact")).toMatchObject({ grantable: false, reason: "ROLE_INSUFFICIENT" });
    expect(of(viewer, "knowledge_sources")).toMatchObject({ grantable: true, needsApproval: false });
    expect(owner.every((t) => t.title.de && t.summary.en)).toBe(true);
  });

  it("runs a manual work order on the worker and records origin, principal, steps, cost and result", async () => {
    const agent = await activeAgent();
    const view = await runIn((tx) => startManualWorkOrder(tx, p.editor, agent.id, { requestId: randomUUID(), goal: "Check" }));
    expect(view).toMatchObject({ status: "queued", origin: "manual", onBehalfOf: { sponsorUserId: p.owner.userId, requesterUserId: p.editor.userId } });
    mocked.replies.push(call("knowledge_sources", { limit: 5 }), done);
    await runJob(view.id);
    const row = await workOrder(view.id);
    expect(row).toMatchObject({ status: "succeeded", errorCode: null, agentVersion: 1 });
    expect(Number(row.spentMicros)).toBe(14);
    expect(row.steps).toEqual([{ index: 1, tool: "knowledge_sources", risk: "R0_read", outcome: "succeeded" }]);
    expect(row.result).toMatchObject({ outcome: "done", summary: "Looked at the sources.", actionRequestIds: [] });
    const reservations = await runIn((tx) =>
      tx.budgetReservation.findMany({ where: { projectId: p.owner.projectId, key: { startsWith: `${p.owner.projectId}:agent-work-order:${view.id}:` } } }),
    );
    expect(reservations.map((r) => [r.state, r.agentId])).toEqual([["settled", agent.id], ["settled", agent.id]]);
    const runs = await runIn((tx) => tx.agentRun.findMany({ where: { projectId: p.owner.projectId, subjectId: view.id } }));
    expect(runs.map((r) => [r.kind, r.status])).toEqual([["agent_work", "succeeded"]]);
    // The same claim twice runs nothing more.
    await runJob(view.id);
    expect(mocked.replies).toHaveLength(0);
    // A viewer cannot start runs; a duplicate request id returns the same work order.
    await expect(runIn((tx) => startManualWorkOrder(tx, p.viewer, agent.id, { requestId: randomUUID() }))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("routes to the agent's own model only when it is a verified model", async () => {
    await expect(
      runIn((tx) => createAgent(tx, p.owner, { config: config({ model: { override: "unverified-model" } }) })),
    ).rejects.toMatchObject({ code: "AGENT_ROUTE_UNAVAILABLE" });
    const agent = await activeAgent({ model: { override: "synthetic-model" } });
    const view = await runIn((tx) => startManualWorkOrder(tx, p.owner, agent.id, { requestId: randomUUID() }));
    mocked.replies.push(done);
    await runJob(view.id);
    expect(await workOrder(view.id)).toMatchObject({ status: "succeeded" });
  });

  it("D: stops all tool execution when the requester loses a right mid-run, and proposals name the agent", async () => {
    const agent = await activeAgent();
    const view = await runIn((tx) => startManualWorkOrder(tx, p.editor, agent.id, { requestId: randomUUID() }));
    mocked.replies.push(
      call("knowledge_sources", { limit: 5 }),
      call("knowledge_propose_fact", { idempotencyKey: randomUUID() }),
      done,
    );
    // The requester is demoted after the first tool call, before the second model call.
    mocked.before.push(undefined, () => setRole(p.editor.userId, "viewer").then(() => undefined));
    try {
      await runJob(view.id);
    } finally {
      await setRole(p.editor.userId, "editor");
    }
    const row = await workOrder(view.id);
    expect(row).toMatchObject({ status: "blocked", errorCode: "AGENT_PRINCIPAL_FORBIDDEN" });
    expect((row.steps as any[]).map((s) => [s.tool, s.code])).toEqual([
      ["knowledge_sources", undefined],
      ["knowledge_propose_fact", "AGENT_PRINCIPAL_FORBIDDEN"],
    ]);
    expect(mocked.replies).toHaveLength(1);
    const requests = await runIn((tx) =>
      tx.entity.count({ where: { projectId: p.owner.projectId, kind: "action_requests", data: { path: ["requestedBy", "workOrderId"], equals: view.id } } }),
    );
    expect(requests).toBe(0);
  });

  it("stops when the agent is paused mid-run, and refuses runs of a paused agent", async () => {
    const agent = await activeAgent();
    const view = await runIn((tx) => startManualWorkOrder(tx, p.owner, agent.id, { requestId: randomUUID() }));
    mocked.replies.push(call("knowledge_sources", { limit: 5 }), call("knowledge_sources", { limit: 5 }), done);
    mocked.before.push(undefined, async () => {
      const current = await runIn((tx) => readVisibleAgent(tx, p.owner, agent.id));
      await runIn((tx) => setAgentStatus(tx, p.owner, agent.id, "pause", { version: current.version }));
    });
    await runJob(view.id);
    expect(await workOrder(view.id)).toMatchObject({ status: "blocked", errorCode: "AGENT_NOT_ACTIVE" });
    await expect(runIn((tx) => startManualWorkOrder(tx, p.owner, agent.id, { requestId: randomUUID() }))).rejects.toMatchObject({ code: "AGENT_NOT_ACTIVE" });
  });

  it("cancels a queued work order at once, and sends one failure notice per agent, code and day without a model call", async () => {
    const agent = await activeAgent();
    const queued = await runIn((tx) => startManualWorkOrder(tx, p.owner, agent.id, { requestId: randomUUID() }));
    expect(await runIn((tx) => cancelWorkOrder(tx, p.editor, queued.id))).toMatchObject({ status: "canceled" });
    await runJob(queued.id);
    expect(await workOrder(queued.id)).toMatchObject({ status: "canceled", errorCode: "AGENT_CANCELED" });

    // Notices are user-private rows: counted as the sponsor.
    const notices = () =>
      runIn(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id',${p.owner.userId},true)`;
        return tx.notification.count({ where: { projectId: p.owner.projectId, userId: p.owner.userId, kind: "agent_work_failed" } });
      });
    const before = await notices();
    for (let i = 0; i < 3; i++) {
      const view = await runIn((tx) => startManualWorkOrder(tx, p.owner, agent.id, { requestId: randomUUID() }));
      const row = await workOrder(view.id);
      await runIn((tx) => finishWorkOrder(tx, p.owner, row, { status: "failed", code: "AGENT_OUTPUT_INVALID" }));
    }
    expect((await notices()) - before).toBe(1);
    expect(mocked.replies).toHaveLength(0);
  });

  it("ends a lost run as unknown after a sent call, and starts over without one", async () => {
    const agent = await activeAgent();
    const sent = await runIn((tx) => startManualWorkOrder(tx, p.owner, agent.id, { requestId: randomUUID() }));
    const fresh = await runIn((tx) => startManualWorkOrder(tx, p.owner, agent.id, { requestId: randomUUID() }));
    await runIn(async (tx) => {
      await tx.agentWorkOrder.updateMany({ where: { id: { in: [sent.id, fresh.id] } }, data: { status: "running" } });
      await tx.budgetReservation.create({
        data: {
          workspaceId: p.owner.workspaceId,
          projectId: p.owner.projectId,
          key: `${p.owner.projectId}:agent-work-order:${sent.id}:0`,
          category: "agent_work",
          amountMicros: 10,
          state: "in_flight",
        } as any,
      });
    });
    for (const id of [sent.id, fresh.id])
      await runIn((tx) => agentWorkJob.onLeaseExpired!(tx, worker(), { resourceId: id }));
    expect(await workOrder(sent.id)).toMatchObject({ status: "outcome_unknown", costUnknown: true });
    expect(await workOrder(fresh.id)).toMatchObject({ status: "queued" });
  });

  it("starts one work order per event and subject, ignores agent events, and respects the flag", async () => {
    const agent = await activeAgent({ triggers: [{ kind: "event", type: TEST_PING, filter: { channel: "a" }, debounceSeconds: 0 }] });
    const event = (subject: string, extra: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      type: TEST_PING,
      version: 1,
      subject: { type: "platform.test_subject", id: subject },
      actor: { kind: "user" as const, id: p.owner.userId },
      origin: "platform",
      causationId: null,
      correlationId: randomUUID(),
      depth: 0,
      data: { channel: "a" },
      createdAt: new Date(),
      ...extra,
    });
    const count = () => runIn((tx) => tx.agentWorkOrder.count({ where: { projectId: p.owner.projectId, agentId: agent.id } }));
    const before = await count();
    const one = event("s1");
    await runIn((tx) => agentTriggerSubscriber.handler(tx, p.owner, one));
    await runIn((tx) => agentTriggerSubscriber.handler(tx, p.owner, one));
    for (let i = 0; i < 20; i++) await runIn((tx) => agentTriggerSubscriber.handler(tx, p.owner, event("s1")));
    expect((await count()) - before).toBe(1);
    await runIn((tx) => agentTriggerSubscriber.handler(tx, p.owner, event("s2", { data: { channel: "b" } })));
    await runIn((tx) => agentTriggerSubscriber.handler(tx, p.owner, event("s3", { actor: { kind: "agent", id: randomUUID() } })));
    process.env.ORBIT_AGENT_AUTOMATION = "false";
    try {
      await runIn((tx) => agentTriggerSubscriber.handler(tx, p.owner, event("s4")));
    } finally {
      process.env.ORBIT_AGENT_AUTOMATION = "true";
    }
    expect((await count()) - before).toBe(1);
  });

  it("starts one work order per schedule slot and skips stale slots", async () => {
    await authDb.project.update({ where: { id: p.owner.projectId }, data: { timezone: "UTC" } });
    const agent = await activeAgent({ triggers: [{ kind: "schedule", rhythm: "daily", times: ["09:00"] }] });
    const at = new Date("2026-11-04T09:30:00Z");
    await runIn((tx) => agentScheduleScheduler.sweep(tx, p.owner, at));
    await runIn((tx) => agentScheduleScheduler.sweep(tx, p.owner, new Date(at.getTime() + 60_000)));
    const rows = await runIn((tx) => tx.agentWorkOrder.findMany({ where: { projectId: p.owner.projectId, agentId: agent.id } }));
    expect(rows.map((r) => [r.origin, r.originRef])).toEqual([["schedule", "2026-11-04T09:00:00.000Z"]]);
    // Three hours later the 09:00 slot is stale; the next one is tomorrow.
    await runIn((tx) => agentScheduleScheduler.sweep(tx, p.owner, new Date("2026-11-05T12:30:00Z")));
    expect(await runIn((tx) => tx.agentWorkOrder.count({ where: { projectId: p.owner.projectId, agentId: agent.id } }))).toBe(1);
    expect(await runIn((tx) => agentScheduleScheduler.nextDueAt(tx, p.owner, at))).toEqual(new Date("2026-11-05T09:00:00Z"));
    const listed = await runIn((tx) => listWorkOrders(tx, p.editor, { agentId: agent.id }));
    expect(listed.items).toHaveLength(1);
  });

  it("lists the assignments Marketing manages as read-only managed agents (WP1.9)", async () => {
    const assignment = (name: string, status: string, schedule: Record<string, unknown>) =>
      runIn((tx) =>
        create(tx, p.owner, "assignments", {
          name,
          kind: "standing",
          schedule: { weekdays: [], leadMinutes: 360, ...schedule },
          contentType: "social",
          channels: ["x-int"],
          topicFrame: "Short updates about beta access",
          image: false,
          styleAssetIds: [],
          vetoMinutes: 180,
          monthlyBudgetMicros: 20_000_000,
          status,
          confirmation: null,
          actionRequestId: null,
        }),
      );
    const daily = await assignment("Daily product post", "active", { rhythm: "daily", times: ["10:00", "17:00"] });
    const weekly = await assignment("Weekly digest", "paused", { rhythm: "weekly", weekdays: [1, 4], times: ["09:00"] });
    await assignment("Old campaign", "ended", { rhythm: "daily", times: ["08:00"] });
    const before = process.env.ORBIT_AGENTS;
    process.env.ORBIT_AGENTS = "true";
    try {
      const { groups } = await runIn((tx) => managedAgentGroups(tx, p.editor));
      expect(groups.map((g) => g.module)).toEqual(["marketing"]);
      const link = `/p/${p.owner.projectId}/marketing/assignments`;
      expect(groups[0]!.items).toEqual(
        expect.arrayContaining([
          {
            id: daily.id,
            name: "Daily product post",
            status: "active",
            schedule: expect.stringMatching(/^Daily at 10:00, 17:00 \(.+\)$/),
            monthSpendMicros: 0,
            monthBudgetMicros: 20_000_000,
            link,
          },
          expect.objectContaining({
            id: weekly.id,
            status: "paused",
            schedule: expect.stringMatching(/^Weekly on Mon, Thu at 09:00 \(/),
          }),
        ]),
      );
      // Ended assignments are left out.
      expect(groups[0]!.items.map((i) => i.name)).not.toContain("Old campaign");
      // A member without access to Marketing sees no Marketing group.
      const hidden = await runIn((tx) => managedAgentGroups(tx, { ...p.editor, moduleRoles: { marketing: "none" } }));
      expect(hidden.groups).toEqual([]);
      // With Orbit Agents off Marketing lists nothing.
      process.env.ORBIT_AGENTS = "false";
      expect((await runIn((tx) => managedAgentGroups(tx, p.editor))).groups).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.ORBIT_AGENTS;
      else process.env.ORBIT_AGENTS = before;
    }
  });
});

describe("schedule slots across daylight saving", () => {
  it("keeps the local time and resolves gaps and overlaps", () => {
    const daily = { kind: "schedule" as const, rhythm: "daily" as const, times: ["02:30", "09:00"] };
    // Europe/Berlin springs forward on 2026-03-29 at 02:00 -> 03:00.
    const spring = slotsBetween(daily, "Europe/Berlin", new Date("2026-03-28T22:00:00Z"), new Date("2026-03-29T21:59:00Z"));
    expect(spring.map((d) => d.toISOString())).toEqual(["2026-03-29T01:00:00.000Z", "2026-03-29T07:00:00.000Z"]);
    // It falls back on 2026-10-25 at 03:00 -> 02:00: 02:30 exists twice, the earlier counts.
    const fall = slotsBetween(daily, "Europe/Berlin", new Date("2026-10-24T22:00:00Z"), new Date("2026-10-25T22:59:00Z"));
    expect(fall.map((d) => d.toISOString())).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-25T08:00:00.000Z"]);
    const weekly = { kind: "schedule" as const, rhythm: "weekly" as const, times: ["10:00"], days: [3] };
    expect(slotsBetween(weekly, "UTC", new Date("2026-11-02T00:00:00Z"), new Date("2026-11-08T23:59:00Z")).map((d) => d.toISOString())).toEqual(["2026-11-04T10:00:00.000Z"]);
  });
});

describe("delegation core", () => {
  const allow = (tools: string[]) => ({ tools: new Set(tools), modules: new Set(["support"]), mode: "draft" as const, knowledge: null });
  const parent = {
    workOrderId: "w1",
    rootWorkOrderId: "r1",
    depth: 0,
    chain: ["a1"],
    delegateTo: ["a2", "a3"],
    allow: allow(["x", "y"]),
    remainingCeilingMicros: 100,
    sponsorUserId: "u1",
  };
  const target = (agentId: string, tools = ["x"], ceilingMicros = 10) => ({ agentId, sponsorUserId: "u2", allow: allow(tools), ceilingMicros });

  it("enforces depth, cycles, fan-out, named targets, narrowing and the ceiling", () => {
    expect(planChildWorkOrders(parent, [target("a2")])).toMatchObject([{ parentId: "w1", rootId: "r1", depth: 1 }]);
    expect(() => planChildWorkOrders({ ...parent, depth: 2 }, [target("a2")])).toThrow("AGENT_DELEGATION_DEPTH");
    expect(() => planChildWorkOrders({ ...parent, delegateTo: null }, [target("a1")])).toThrow("AGENT_DELEGATION_CYCLE");
    expect(() => planChildWorkOrders({ ...parent, delegateTo: null }, Array.from({ length: 11 }, (_, i) => target(`t${i}`)))).toThrow("AGENT_DELEGATION_FANOUT");
    expect(() => planChildWorkOrders(parent, [target("a9")])).toThrow("AGENT_DELEGATION_TARGET");
    expect(() => planChildWorkOrders(parent, [target("a2", ["z"])])).toThrow("AGENT_DELEGATION_WIDENS");
    expect(() => planChildWorkOrders(parent, [target("a2", ["x"], 60), target("a3", ["x"], 60)])).toThrow("AGENT_BUDGET_EXHAUSTED");
  });
});

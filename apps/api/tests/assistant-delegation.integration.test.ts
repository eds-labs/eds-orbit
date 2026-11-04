import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authDb, closeDatabase, scoped, type DbTx } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";

// Delegation from the personal assistant and the MCP task fold-in (ADR 0022
// item 7, plan agent-platform-phase-3 WP3.6, ADR 0021 D-05 to D-07).
// Scenario C uses a blank Knowledge agent (read mode, knowledge_sources):
// the Support agent's pipeline is not needed to prove the delegation, the
// worker restart and the single notice. Every model reply is scripted; the
// provider spy counts the paid calls.

const mocked = vi.hoisted(() => ({ replies: [] as unknown[][], calls: 0 }));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  respond: vi.fn(async (request: any) => {
    mocked.calls++;
    const next = mocked.replies.shift();
    if (!next) throw new Error("NO_RECORDED_REPLY");
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
  streamChat: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
}));

import { create, data } from "../src/shared.ts";
import { registerModules, moduleRegistry } from "../src/modules/registry.ts";
import { configHash } from "../src/platform/agents/definitions/schema.ts";
import { activateAgent, createAgent } from "../src/platform/agents/definitions/service.ts";
import { agentWorkJob } from "../src/platform/agents/work-orders/execute.ts";
import { capabilityFeatures, resolveCapabilities } from "../src/platform/agents/capabilities.ts";
import { exposedToAgent } from "../src/platform/agents/tools/registry.ts";
import { registeredAssistants, registeredTools } from "../src/platform/modules/contributions.ts";
import { decideActionRequest, createActionRequest } from "../src/platform/governance/action-requests.ts";
import { preparePersonalTurn } from "../src/platform/assistant/personal-turn.ts";
import { ensurePersonalSpace } from "../src/platform/assistant/personal-space.ts";
import { delegationNoticeSubscriber } from "../src/platform/assistant/notices.ts";
import { DELEGATE_ACTION } from "../src/platform/assistant/delegation.ts";
import { getConversation } from "../src/platform/assistant/chat.ts";
import { userScoped } from "../src/platform/tenancy/scope.ts";
import { cancelTask, createTask, listTasks, readTask, TASK_KIND } from "../src/platform/tasks/tasks.ts";
import { taskDelegation } from "../src/platform/tasks/delegation.ts";
import type { McpPrincipal } from "../src/platform/mcp/principal.ts";
import { createPackageProject } from "./support/package-project.ts";
import { taskChatCeiling } from "../src/platform/tasks/tasks.ts";
import { runtimeOpenAiConfiguration } from "../src/platform/ai/openai-configuration.ts";
import { hash } from "../src/shared.ts";

registerModules();

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const FLAGS: Record<string, string> = {
  ORBIT_AGENT_PLATFORM: "true",
  ORBIT_PERSONAL_ASSISTANT: "true",
  ORBIT_MODULE_ROLES: "true",
  ORBIT_MCP_TASKS: "true",
  ORBIT_MCP_PROPOSALS: "true",
  EXECUTION_MODE: "test",
};
const done = [
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: JSON.stringify({ outcome: "done", summary: "Checked." }) }],
  },
];

describe.skipIf(!enabled)("assistant delegation and MCP task fold-in (WP3.6)", () => {
  const saved: Record<string, string | undefined> = {};
  let p: Awaited<ReturnType<typeof createPackageProject>>;
  let personal: Scope;
  const runIn = <T>(work: (tx: DbTx) => Promise<T>) => scoped(p.owner.workspaceId, p.owner.projectId, work);
  const worker = (): Scope => ({ ...p.owner, userId: "worker", role: "owner" });
  const runJob = (id: string) =>
    agentWorkJob.handler({ scope: worker(), jobId: randomUUID(), job: { resourceId: id }, executionMode: "test" } as never);

  async function activeAgent(budget = { monthlyCeilingMicros: 1_000_000, runCeilingMicros: 100_000 }) {
    const created = await runIn((tx) =>
      createAgent(tx, p.owner, {
        config: {
          name: "Ticket investigator",
          description: "Investigates one record per work order.",
          templateKey: null,
          instructions: "Check the knowledge sources for the record.",
          modules: ["knowledge"],
          tools: ["knowledge_sources"],
          knowledge: null,
          mode: "read",
          model: { override: null },
          limits: { maxModelCalls: 2, maxToolCalls: 2, wallSeconds: 60, maxRunsPerDay: 50, maxConcurrent: 3 },
          budget,
          triggers: [{ kind: "manual" }],
          delegateTo: [],
          outputs: { notify: ["sponsor"], onFailure: "silent" },
        },
      }),
    );
    return runIn((tx) =>
      activateAgent(tx, p.owner, created.id, {
        version: created.version,
        configHash: configHash(created.definition.draft),
      }),
    );
  }
  async function conversation() {
    return userScoped(personal, (tx) =>
      tx.chatConversation.create({
        data: { workspaceId: personal.workspaceId, projectId: personal.projectId, userId: personal.userId, title: "Delegate" },
      }),
    );
  }
  async function delegate(args: object, who: Scope = personal, conversationId?: string) {
    const thread = conversationId ?? (await conversation()).id;
    const turn = await preparePersonalTurn({
      mode: "personal",
      userId: who.userId,
      workspaceId: who.workspaceId,
      run: { runId: randomUUID(), conversationId: thread, scope: who },
    });
    const output = JSON.parse(
      await turn.host.execute({ callId: "d", name: "agent_delegate", arguments: JSON.stringify(args) }, 1),
    );
    return { output, cards: turn.cards, conversationId: thread, turn };
  }
  const workOrders = (agentId: string) =>
    runIn((tx) => tx.agentWorkOrder.findMany({ where: { agentId }, orderBy: { idempotencyKey: "asc" } }));
  const delegations = () =>
    runIn((tx) =>
      tx.entity.findMany({ where: { kind: "action_requests", data: { path: ["actionType"], equals: DELEGATE_ACTION } } }),
    );

  beforeAll(async () => {
    for (const [key, value] of Object.entries(FLAGS)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    p = await createPackageProject({ name: "Synthetic assistant delegation" });
    const space = await ensurePersonalSpace(p.owner.workspaceId, p.editor.userId, moduleRegistry());
    personal = { workspaceId: p.owner.workspaceId, projectId: space.projectId, userId: p.editor.userId, role: "owner" };
  });
  beforeEach(() => {
    mocked.replies = [];
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await p?.cleanup();
    await closeDatabase();
  });

  it("scenario C: one confirmation, five work orders, a restart without a second paid call, one notice", async () => {
    const agent = await activeAgent();
    const tickets = Array.from({ length: 5 }, () => ({ type: "support.ticket", id: randomUUID() }));
    const { output, cards, conversationId, turn } = await delegate({
      projectId: p.owner.projectId,
      agentId: agent.id,
      goal: "Investigate the ticket and summarize",
      subjects: tickets,
    });
    expect(output).toMatchObject({
      status: "pending",
      requiresApproval: true,
      workOrders: 5,
      ceilingMicrosPerWorkOrder: 100_000,
      agent: { id: agent.id, name: "Ticket investigator" },
      onBehalfOf: { requesterUserId: p.editor.userId, sponsorUserId: p.owner.userId },
    });
    expect(cards).toEqual([
      expect.objectContaining({
        kind: "status",
        projectId: p.owner.projectId,
        actionRequest: expect.objectContaining({ id: output.actionRequestId, decidable: true, inline: true }),
      }),
    ]);
    expect(turn.contextProjects()).toEqual([p.owner.projectId]);
    // Nothing runs before the confirmation.
    expect(await workOrders(agent.id)).toEqual([]);
    const card = cards[0]!.actionRequest!;
    // Only the requester confirms (D-06); the owner may not.
    await expect(
      runIn((tx) =>
        decideActionRequest(tx, p.owner, card.id, { version: card.version, packageHash: card.packageHash, decision: "approve" }),
      ),
    ).rejects.toMatchObject({ code: "DECIDER_NOT_ALLOWED" });
    await runIn((tx) =>
      decideActionRequest(tx, p.editor, card.id, { version: card.version, packageHash: card.packageHash, decision: "approve" }),
    );
    const orders = await workOrders(agent.id);
    expect(orders).toHaveLength(5);
    for (const order of orders)
      expect(order).toMatchObject({
        origin: "assistant",
        target: "agent",
        depth: 0,
        status: "queued",
        ceilingMicros: 100_000n,
        originRef: card.id,
        requestedBy: expect.objectContaining({
          kind: "user",
          via: "assistant",
          userId: p.editor.userId,
          personalSpaceId: personal.projectId,
          conversationId,
          batchId: output.batchId,
          batchSize: 5,
          requesterUserId: p.editor.userId,
        }),
      });
    expect(orders.map((o) => o.subjectId).sort()).toEqual(tickets.map((t) => t.id).sort());

    // The worker: child 1 runs; child 2 is lost after its paid call was
    // sent (a worker restart); the restarted worker sends nothing again.
    const [first, second, ...rest] = orders;
    mocked.replies.push(done);
    const before = mocked.calls;
    await runJob(first!.id);
    expect(mocked.calls).toBe(before + 1);
    await runIn(async (tx) => {
      await tx.agentWorkOrder.update({ where: { id: second!.id }, data: { status: "running", startedAt: new Date() } });
      await tx.budgetReservation.create({
        data: {
          workspaceId: p.owner.workspaceId,
          projectId: p.owner.projectId,
          key: `${p.owner.projectId}:agent-work-order:${second!.id}:0`,
          category: "agent_work",
          amountMicros: 10,
          state: "in_flight",
          agentId: agent.id,
        } as never,
      });
    });
    await runIn((tx) => agentWorkJob.onLeaseExpired!(tx, worker(), { resourceId: second!.id } as never));
    await runJob(second!.id);
    expect(mocked.calls).toBe(before + 1);
    for (const order of rest) {
      mocked.replies.push(done);
      await runJob(order.id);
    }
    expect(mocked.calls).toBe(before + 4);
    const finished = await workOrders(agent.id);
    expect(finished.find((o) => o.id === second!.id)).toMatchObject({ status: "outcome_unknown", costUnknown: true });
    expect(finished.filter((o) => o.status === "succeeded")).toHaveLength(4);

    // The events reach the notice subscriber (as the event dispatcher does), each once and again.
    for (const order of [...finished, ...finished])
      await runIn((tx) =>
        delegationNoticeSubscriber.handler(tx, worker(), {
          id: randomUUID(),
          type: order.status === "succeeded" ? "platform.agent.work_order.finished" : "platform.agent.work_order.failed",
          subject: { type: "platform.agent_work_order", id: order.id },
          actor: { kind: "agent", id: null },
          data: {},
        } as never),
      );
    const read = await getConversation(personal, conversationId);
    const notices = read.messages.filter((m: any) => m.role === "notice");
    expect(notices).toHaveLength(1);
    expect((notices[0] as any).cards).toHaveLength(5);
    expect(notices[0]!.text).toContain("4 of 5");

    // The batch status, derived from its work orders.
    const status = JSON.parse(
      await turn.host.execute(
        {
          callId: "s",
          name: "agent_work_order_status",
          arguments: JSON.stringify({ projectId: p.owner.projectId, workOrderId: null, batchId: output.batchId, status: null }),
        },
        2,
      ),
    );
    expect(status.projects[0].batch).toMatchObject({
      status: "partially_failed",
      total: 5,
      counts: { succeeded: 4, outcome_unknown: 1 },
    });
  });

  it("refuses before anything exists: no agent rights, Knowledge viewer, fan-out 11, month budget", async () => {
    const agent = await activeAgent();
    const before = (await delegations()).length;
    // A project viewer may not run agents.
    const viewerSpace = await ensurePersonalSpace(p.owner.workspaceId, p.viewer.userId, moduleRegistry());
    const viewerPersonal: Scope = { ...personal, projectId: viewerSpace.projectId, userId: p.viewer.userId };
    const asViewer = await delegate({ projectId: p.owner.projectId, agentId: agent.id, goal: "x", subjects: null }, viewerPersonal);
    expect(asViewer.output).toEqual({ projectId: p.owner.projectId, error: "PERMISSION_DENIED" });
    // An editor who is only a viewer in the agent's module (D-06).
    await authDb.projectMemberModuleRole.create({
      data: {
        workspaceId: p.owner.workspaceId,
        projectId: p.owner.projectId,
        userId: p.editor.userId,
        moduleId: "knowledge",
        role: "viewer",
        changedBy: p.owner.userId,
      },
    });
    try {
      const limited = await delegate({ projectId: p.owner.projectId, agentId: agent.id, goal: "x", subjects: null });
      expect(limited.output).toEqual({ error: "AGENT_PRINCIPAL_FORBIDDEN" });
    } finally {
      await authDb.projectMemberModuleRole.deleteMany({
        where: { projectId: p.owner.projectId, userId: p.editor.userId },
      });
    }
    const eleven = Array.from({ length: 11 }, () => ({ type: "support.ticket", id: randomUUID() }));
    expect((await delegate({ projectId: p.owner.projectId, agentId: agent.id, goal: "x", subjects: eleven })).output).toEqual({
      error: "AGENT_DELEGATION_FANOUT",
    });
    const small = await activeAgent({ monthlyCeilingMicros: 250_000, runCeilingMicros: 100_000 });
    const three = eleven.slice(0, 3);
    expect((await delegate({ projectId: p.owner.projectId, agentId: small.id, goal: "x", subjects: three })).output).toEqual({
      error: "AGENT_BUDGET_EXHAUSTED",
    });
    expect((await delegations()).length).toBe(before);
    expect(await workOrders(agent.id)).toEqual([]);
    expect(await workOrders(small.id)).toEqual([]);
  });

  it("keeps depth bounded: an agent is never offered agent_delegate", () => {
    const tool = registeredTools().find((t) => t.name === "agent_delegate")!;
    expect(tool.scopeShape).toBe("user");
    expect(exposedToAgent(tool)).toBe(false);
    for (const channel of ["agent", "mcp", "assistant"] as const)
      expect(
        resolveCapabilities(p.owner, {
          channel,
          enabled: undefined,
          features: capabilityFeatures(registeredAssistants(), { toolSearch: true, moduleOperations: true }),
        }).map((t) => t.name),
      ).not.toContain("agent_delegate");
  });

  describe("MCP tasks in the work order table", () => {
    async function principal(): Promise<McpPrincipal> {
      const scopes = ["orbit:read", "orbit:propose"];
      const grant = await authDb.mcpGrant.create({
        data: {
          workspaceId: p.owner.workspaceId,
          userId: p.owner.userId,
          clientId: `https://fold-in.test/${randomUUID()}.json`,
          projectIds: [p.owner.projectId],
          modules: [],
          scopes,
          status: "active",
          activatedAt: new Date(),
        },
      });
      return {
        workspaceId: p.owner.workspaceId,
        userId: p.owner.userId,
        clientId: grant.clientId,
        grantId: grant.id,
        projectIds: [p.owner.projectId],
        modules: [],
        scopes: new Set(scopes),
      };
    }

    it("creates a table-backed task and still reads, lists, starts and cancels a legacy entity task", async () => {
      const mcp = await principal();
      // A legacy task, stored as before the fold-in.
      const legacy = await userScoped(p.owner, async (tx) => {
        const ceiling = taskChatCeiling(await runtimeOpenAiConfiguration(tx, p.owner));
        const conversation = await tx.chatConversation.create({
          data: { workspaceId: p.owner.workspaceId, projectId: p.owner.projectId, userId: p.owner.userId, title: "Legacy" },
        });
        const task = await create(tx, p.owner, TASK_KIND, {
          description: "Legacy task",
          userId: p.owner.userId,
          clientId: mcp.clientId,
          delegation: {
            grantId: mcp.grantId,
            clientId: mcp.clientId,
            userId: mcp.userId,
            scopes: [...mcp.scopes],
            modules: ["marketing"],
            mode: "draft",
            ceilingMicros: ceiling,
          },
          idempotencyKey: "legacy-key",
          argsHash: "0".repeat(64),
          conversationId: conversation.id,
          runId: null,
          jobId: null,
          canceledAt: null,
        });
        const request = await createActionRequest(tx, p.owner, {
          actionType: "platform.task.start",
          payload: { taskId: task.id, descriptionHash: hash("Legacy task"), ceilingMicros: ceiling },
          requestedBy: {
            kind: "mcp",
            userId: p.owner.userId,
            clientId: mcp.clientId,
            grantId: mcp.grantId,
            agentRunId: null,
            argsHash: "0".repeat(64),
            taskId: task.id,
          },
        });
        await tx.entity.update({
          where: { id: task.id },
          data: { data: { ...data(task), actionRequestId: request.id } },
        });
        return { id: task.id, conversationId: conversation.id, requestId: request.id };
      });
      const made = await createTask(mcp, p.owner.projectId, {
        description: "A new table task",
        modules: ["marketing"],
        idempotencyKey: randomUUID(),
      });
      const row = await runIn((tx) => tx.agentWorkOrder.findUniqueOrThrow({ where: { id: made.taskId } }));
      expect(row).toMatchObject({
        target: "assistant",
        origin: "mcp",
        status: "awaiting_start",
        startRequestId: made.actionRequestId,
        requestedBy: { kind: "mcp", userId: p.owner.userId, clientId: mcp.clientId, grantId: mcp.grantId },
        allow: expect.objectContaining({ modules: ["marketing"], mode: "draft" }),
      });
      expect(row.conversationId).toBeTruthy();
      // A retry with the same key finds it; no entity was written.
      const again = await createTask(mcp, p.owner.projectId, {
        description: "A new table task",
        modules: ["marketing"],
        idempotencyKey: (row.input as { idempotencyKey: string }).idempotencyKey,
      });
      expect(again).toMatchObject({ taskId: made.taskId, deduplicated: true });
      expect(await runIn((tx) => tx.entity.count({ where: { id: made.taskId } }))).toBe(0);
      // Both stores read and list the same way.
      expect(await readTask(p.owner, legacy.id, mcp.clientId)).toMatchObject({
        taskId: legacy.id,
        status: "awaiting_approval",
        description: "Legacy task",
      });
      expect(await readTask(p.owner, made.taskId, mcp.clientId)).toMatchObject({
        taskId: made.taskId,
        status: "awaiting_approval",
        description: "A new table task",
      });
      const listed = await listTasks(p.owner, { clientId: mcp.clientId });
      expect(listed.items.map((t) => t.taskId)).toEqual([made.taskId, legacy.id]);
      const page = await listTasks(p.owner, { clientId: mcp.clientId, limit: 1 });
      expect(page.items.map((t) => t.taskId)).toEqual([made.taskId]);
      const next = await listTasks(p.owner, { clientId: mcp.clientId, limit: 1, cursor: page.nextCursor! });
      expect(next.items.map((t) => t.taskId)).toEqual([legacy.id]);
      // The legacy task still starts through platform.task.start, and its
      // run's delegation is found in the entity store.
      const request = await runIn((tx) => tx.entity.findUniqueOrThrow({ where: { id: legacy.requestId } }));
      await runIn((tx) =>
        decideActionRequest(tx, p.owner, legacy.requestId, {
          version: request.version,
          packageHash: data(request).packageHash,
          decision: "approve",
        }),
      );
      const started = await readTask(p.owner, legacy.id, mcp.clientId);
      expect(started.runId).toBeTruthy();
      expect(await runIn((tx) => taskDelegation(tx, p.owner, started.runId))).toMatchObject({
        taskId: legacy.id,
        clientId: mcp.clientId,
      });
      // The legacy task is cancellable; the table task too.
      expect((await cancelTask(p.owner, legacy.id, mcp.clientId)).status).toBe("canceled");
      expect((await cancelTask(p.owner, made.taskId, mcp.clientId)).status).toBe("canceled");
      expect(await runIn((tx) => tx.agentWorkOrder.findUniqueOrThrow({ where: { id: made.taskId } }))).toMatchObject({
        status: "canceled",
      });
      // A table task never shows in the project's agent work order lists.
      const { listWorkOrders } = await import("../src/platform/agents/work-orders/service.ts");
      const agentList = await runIn((tx) => listWorkOrders(tx, p.owner, {}));
      expect(agentList.items.map((i) => i.id)).not.toContain(made.taskId);
    });

    it("finds a task's delegation by its run in either store", async () => {
      const mcp = await principal();
      const runId = randomUUID();
      const tableTask = await createTask(mcp, p.owner.projectId, {
        description: "Run lookup",
        modules: ["marketing"],
        idempotencyKey: randomUUID(),
      });
      await runIn((tx) =>
        tx.agentWorkOrder.update({
          where: { id: tableTask.taskId },
          data: { input: { description: "Run lookup", idempotencyKey: "k", argsHash: "a", runId } },
        }),
      );
      const found = await runIn((tx) => taskDelegation(tx, p.owner, runId));
      expect(found).toMatchObject({ taskId: tableTask.taskId, clientId: mcp.clientId, modules: ["marketing"], mode: "draft" });
      expect(await runIn((tx) => taskDelegation(tx, p.owner, randomUUID()))).toBeNull();
    });
  });
});

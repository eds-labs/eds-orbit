import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";

// Personal conversation mode (ADR 0022, plan agent-platform-phase-3 WP3.4,
// WP3.5 and the WP3.7 tool): a turn in a personal space runs with the
// personal-mode instructions and staged tools, behind the assistant gate;
// page hints are kept only for readable projects; earlier turns keep
// tainting proposals; approval cards name their project and decide on the
// unchanged route; context_remember saves with a notice or proposes. No
// provider is called: every model step is scripted.

const mocked = vi.hoisted(() => ({
  steps: [] as Array<unknown[]>,
  requests: [] as Array<{ instructions: string; tools: any[]; input: unknown[] }>,
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  embed: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
  respond: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
  streamChat: vi.fn(async (request: { instructions: string; tools: any[]; input: unknown[] }) => {
    mocked.requests.push({
      instructions: request.instructions,
      tools: request.tools,
      input: [...request.input],
    });
    const output = mocked.steps[mocked.requests.length - 1] ?? [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
    ];
    return {
      async *[Symbol.asyncIterator]() {
        const text = (output as any[])
          .filter((item) => item.type === "message")
          .map((item) => item.content?.[0]?.text ?? "")
          .join("");
        if (text) yield { type: "response.output_text.delta", delta: text };
        yield {
          type: "response.completed",
          response: { id: randomUUID(), usage: { input_tokens: 100, output_tokens: 20 }, output },
        };
      },
    };
  }),
}));

import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { moduleRegistry } from "../src/modules/registry.ts";
import { saveOpenAiConfiguration } from "../src/modules/openai-configuration.ts";
import { create, data, update } from "../src/shared.ts";
import { runChatJob } from "../src/platform/assistant/chat-runner.ts";
import {
  createConversation,
  getConversation,
  getRun,
  sendMessage,
} from "../src/platform/assistant/chat.ts";
import { ensurePersonalSpace } from "../src/platform/assistant/personal-space.ts";
import {
  addContext,
  listContext,
  saveAssistantSettings,
} from "../src/platform/assistant/personal-context.ts";
import { PERSONAL_INSTRUCTIONS, actionRequestCard } from "../src/platform/assistant/personal-mode.ts";
import { LOAD_PROJECT_TOOLS, preparePersonalTurn } from "../src/platform/assistant/personal-turn.ts";
import { saveOrganizationAiBudget } from "../src/platform/administration/ai-budget.ts";
import { setEntitlementsResolver, defaultEntitlements } from "../src/platform/entitlements/entitlements.ts";
import { grantAgentMandate } from "../src/platform/governance/agent-mandates.ts";
import { resolveCapabilities, capabilityFeatures } from "../src/platform/agents/capabilities.ts";
import { registeredAssistants } from "../src/platform/modules/contributions.ts";
import { userScoped } from "../src/platform/tenancy/scope.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const FLAGS: Record<string, string> = {
  ORBIT_PERSONAL_ASSISTANT: "true",
  ORBIT_WORK: "true",
  ORBIT_MODULE_ROLES: "true",
  ORBIT_AGENT_MANDATES: "true",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
};
const USD = 1_000_000;
const MARKER = "Zephyrine weekly cadence";
const ALPHA_TASK = "Alpha personal task";

const fn = (name: string, args: object) => ({
  type: "function_call",
  call_id: `call_${randomUUID().slice(0, 8)}`,
  name,
  arguments: JSON.stringify(args),
});
const say = (text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

describe.skipIf(!enabled)("Personal conversation mode (ADR 0022)", () => {
  const saved: Record<string, string | undefined> = {};
  const password = randomBytes(24).toString("base64url");
  const origin = process.env.APP_ORIGIN!;
  let app: Awaited<ReturnType<typeof buildServer>>;
  const users: string[] = [];
  let workspaceId = "";
  let ownerId = "";
  let user = { id: "", email: "", cookie: "" };
  const ids = {} as Record<"A" | "B" | "T" | "H", string>;
  let alphaTaskId = "";
  let personal: Scope;

  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  async function signUp(name: string) {
    const email = `${randomUUID()}@example.invalid`;
    const r = await makeAuth().api.signUpEmail({ body: { email, name, password } });
    users.push(r.user.id);
    return { id: r.user.id, email, cookie: "" };
  }
  async function project(name: string, role: "owner" | "editor" | "viewer" | null) {
    const row = await authDb.project.create({
      data: {
        workspaceId,
        name,
        members: { create: [{ userId: ownerId, role: "owner" }, ...(role ? [{ userId: user.id, role }] : [])] },
      },
    });
    await scoped(workspaceId, row.id, (tx) =>
      tx.projectModule.create({
        data: { workspaceId, projectId: row.id, moduleId: "work", enabled: true, moduleVersion: "1.0.0", changedBy: ownerId },
      }),
    );
    return row.id;
  }
  async function task(projectId: string, number: number, title: string) {
    const id = randomUUID();
    await scoped(workspaceId, projectId, (tx) =>
      tx.workTask.create({
        data: {
          id, workspaceId, projectId, number, title,
          status: "todo", statusCategory: "todo", rank: `a${number}`,
          assigneeUserId: user.id, createdBy: ownerId,
        },
      }),
    );
    return id;
  }

  beforeAll(async () => {
    for (const [key, value] of Object.entries(FLAGS)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    app = await buildServer();
    ownerId = (await signUp("Synthetic personal-mode owner")).id;
    user = await signUp("Synthetic personal-mode user");
    workspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic personal-mode org",
          members: { create: [{ userId: ownerId, role: "owner" }, { userId: user.id, role: "viewer" }] },
        },
      })
    ).id;
    ids.A = await project("Alpha", "editor");
    ids.B = await project("Beta", "viewer");
    ids.T = await project("Taint target", "owner");
    ids.H = await project("Hidden Zr9", null);
    alphaTaskId = await task(ids.A, 1, ALPHA_TASK);
    await task(ids.T, 1, "Taint task");
    const space = await ensurePersonalSpace(workspaceId, user.id, moduleRegistry());
    personal = { workspaceId, projectId: space.projectId, userId: user.id, role: "owner" };
    await saveOrganizationAiBudget(ownerId, workspaceId, {
      monthlyMicros: null,
      assistantPerUserMonthlyMicros: 5 * USD,
    });
    await scoped(workspaceId, personal.projectId, (tx) =>
      saveOpenAiConfiguration(tx, personal, {
        apiKey: "synthetic-no-provider-call-key",
        verifiedModels: ["synthetic-model"],
        rateCard: {
          "synthetic-model": {
            inputMicrosPerMillion: 1000,
            outputMicrosPerMillion: 1000,
            verifiedAt: new Date().toISOString(),
          },
        },
        modelRoutes: {
          fast: "synthetic-model",
          standard: "synthetic-model",
          quality: "synthetic-model",
          escalation: "synthetic-model",
        },
      }),
    );
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: ip() },
      payload: { email: user.email, password },
    });
    expect(r.statusCode).toBe(200);
    const set = r.headers["set-cookie"];
    user.cookie = (Array.isArray(set) ? set : [set]).filter(Boolean).map((c) => c!.split(";")[0]).join("; ");
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    setEntitlementsResolver();
    if (workspaceId) await authDb.workspace.delete({ where: { id: workspaceId } }).catch(() => null);
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  beforeEach(() => {
    mocked.steps = [];
    mocked.requests = [];
  });

  /** One personal turn: send, then run as the worker does. */
  async function turn(text: string, extra: object = {}, conversationId?: string) {
    const thread = conversationId ?? (await createConversation(personal)).id;
    const sent = await sendMessage(personal, thread, {
      text,
      clientRequestId: randomUUID(),
      ...extra,
    });
    await runChatJob(personal, user.id, sent.runId);
    return { conversationId: thread, runId: sent.runId, run: await getRun(personal, sent.runId) };
  }
  const messages = (conversationId: string) =>
    userScoped(personal, (tx) =>
      tx.chatMessage.findMany({ where: { conversationId }, orderBy: { sequence: "asc" } }),
    );

  describe("the gate", () => {
    it("refuses a send without the flag, for a switched-off member and without the entitlement", async () => {
      const thread = (await createConversation(personal)).id;
      const send = () => sendMessage(personal, thread, { text: "Hello", clientRequestId: randomUUID() });
      process.env.ORBIT_PERSONAL_ASSISTANT = "false";
      await expect(send()).rejects.toMatchObject({ code: "ASSISTANT_DISABLED" });
      process.env.ORBIT_PERSONAL_ASSISTANT = "true";
      await authDb.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: user.id } },
        data: { assistantEnabled: false },
      });
      await expect(send()).rejects.toMatchObject({ code: "ASSISTANT_DISABLED_FOR_MEMBER" });
      await authDb.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: user.id } },
        data: { assistantEnabled: true },
      });
      setEntitlementsResolver(() => ({ ...defaultEntitlements(), assistantPersonal: false }));
      await expect(send()).rejects.toMatchObject({ code: "ASSISTANT_ENTITLEMENT" });
      setEntitlementsResolver();
      expect(mocked.requests).toHaveLength(0);
    });

    it("refuses again at run time, before any model call", async () => {
      const thread = (await createConversation(personal)).id;
      const sent = await sendMessage(personal, thread, { text: "Hello", clientRequestId: randomUUID() });
      await authDb.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: user.id } },
        data: { assistantEnabled: false },
      });
      try {
        await runChatJob(personal, user.id, sent.runId);
      } finally {
        await authDb.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId, userId: user.id } },
          data: { assistantEnabled: true },
        });
      }
      const run = await getRun(personal, sent.runId);
      expect(run).toMatchObject({ status: "blocked", errorCode: "ASSISTANT_DISABLED_FOR_MEMBER" });
      expect(mocked.requests).toHaveLength(0);
    });

    it("answers PROJECT_PAUSED for a paused space and POLICY_REQUIRED without a cap", async () => {
      const thread = (await createConversation(personal)).id;
      await authDb.project.update({ where: { id: personal.projectId }, data: { paused: true } });
      await expect(
        sendMessage(personal, thread, { text: "Hello", clientRequestId: randomUUID() }),
      ).rejects.toMatchObject({ code: "PROJECT_PAUSED" });
      await authDb.project.update({ where: { id: personal.projectId }, data: { paused: false } });
      await saveOrganizationAiBudget(ownerId, workspaceId, { monthlyMicros: null, assistantPerUserMonthlyMicros: null });
      try {
        const { run } = await turn("Hello");
        expect(run).toMatchObject({ status: "blocked", errorCode: "POLICY_REQUIRED" });
        expect(mocked.requests).toHaveLength(0);
      } finally {
        await saveOrganizationAiBudget(ownerId, workspaceId, {
          monthlyMicros: null,
          assistantPerUserMonthlyMicros: 5 * USD,
        });
      }
    });

    it("refuses BUDGET_NOT_APPROVED with a cap of 0 or a per-answer limit below the call, and no project budget pays (WP2 A)", async () => {
      const reservations = () =>
        scoped(workspaceId, personal.projectId, (tx) =>
          tx.budgetReservation.count({ where: { projectId: personal.projectId } }),
        );
      const before = await reservations();
      // The focus project has its own spending authority (FamilyPlan-like);
      // it never funds the personal space.
      const focusOwner: Scope = { workspaceId, projectId: ids.T, userId: ownerId, role: "owner" };
      const policy = await scoped(workspaceId, ids.T, (tx) =>
        create(tx, focusOwner, "ai_spend_policies", {
          profile: "normal",
          startAt: new Date(Date.now() - 86_400_000).toISOString(),
          endAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          approvedPaidUse: true,
          dailyBudgetMicros: 5 * USD,
          monthlyBudgetMicros: 50 * USD,
          perRunBudgetMicros: 2 * USD,
          active: true,
        }),
      );
      try {
        for (const cap of [0, 1]) {
          await saveOrganizationAiBudget(ownerId, workspaceId, {
            monthlyMicros: null,
            assistantPerUserMonthlyMicros: cap,
          });
          const { run } = await turn("Hello", { focusProjectId: ids.T });
          expect(run).toMatchObject({ status: "blocked", errorCode: "BUDGET_NOT_APPROVED" });
        }
        expect(mocked.requests).toHaveLength(0);
        expect(await reservations()).toBe(before);
        // The budget row keeps the owner's value; nothing raised it.
        expect(
          (await authDb.organizationAiBudget.findFirstOrThrow({ where: { workspaceId } }))
            .assistantPerUserMonthlyMicros,
        ).toBe(1n);
      } finally {
        await saveOrganizationAiBudget(ownerId, workspaceId, {
          monthlyMicros: null,
          assistantPerUserMonthlyMicros: 5 * USD,
        });
        await scoped(workspaceId, ids.T, (tx) =>
          update(tx, focusOwner, policy, { ...data(policy), active: false }),
        );
      }
    });
  });

  describe("hints", () => {
    it("keeps a readable project's hints, drops others and unknown entities, and hides the stored card", async () => {
      mocked.steps = [[say("Ok.")]];
      const kept = await turn("What is due?", {
        focusProjectId: ids.A,
        pageContext: {
          projectId: ids.A,
          route: `/p/${ids.A}/work/tasks`,
          entity: { type: "work.task", id: alphaTaskId },
        },
      });
      const read = await getConversation(personal, kept.conversationId);
      const userMessage = read.messages.find((m: any) => m.role === "user") as any;
      expect(userMessage.pageContext).toEqual({
        focusProjectId: ids.A,
        pageContext: {
          projectId: ids.A,
          route: `/p/${ids.A}/work/tasks`,
          entity: { type: "work.task", id: alphaTaskId },
        },
      });
      expect(userMessage.cards).toEqual([]);
      // The focus preloads Alpha's tools and is marked in the project list.
      expect(mocked.requests[0]!.instructions).toContain(`${ids.A}: Alpha (focus)`);

      const thread = (await createConversation(personal)).id;
      await sendMessage(personal, thread, {
        text: "And here?",
        clientRequestId: randomUUID(),
        focusProjectId: ids.H,
        pageContext: { projectId: ids.A, entity: { type: "work.task", id: randomUUID() } },
      });
      const dropped = await getConversation(personal, thread);
      expect((dropped.messages[0] as any).pageContext).toEqual({
        pageContext: { projectId: ids.A },
      });
      const forbidden = (await createConversation(personal)).id;
      await sendMessage(personal, forbidden, {
        text: "Hidden?",
        clientRequestId: randomUUID(),
        pageContext: { projectId: ids.H },
      });
      expect((await getConversation(personal, forbidden)).messages[0]).not.toHaveProperty("pageContext");
    });
  });

  describe("reading cards of other projects", () => {
    it("drops a card of a project the user cannot read and checks resources in their own project", async () => {
      const thread = (await createConversation(personal)).id;
      const missing = randomUUID();
      await userScoped(personal, (tx) =>
        tx.chatMessage.create({
          data: {
            workspaceId, projectId: personal.projectId, userId: user.id,
            conversationId: thread, sequence: 1, role: "assistant", text: "Cards",
            cards: [
              { kind: "status", label: "hidden", status: "ok", projectId: ids.H, projectName: "Hidden Zr9" },
              { kind: "source", label: "gone", status: "ok", resourceId: missing, version: 1, projectId: ids.A, projectName: "Alpha" },
              { kind: "link", label: "plain", href: "/x" },
            ],
          },
        }),
      );
      const read = await getConversation(personal, thread);
      expect((read.messages[0] as any).cards).toEqual([
        { kind: "source", label: "gone", status: "stale", resourceId: missing, version: 1, projectId: ids.A, projectName: "Alpha" },
        { kind: "link", label: "plain", href: "/x" },
      ]);
      expect(JSON.stringify(read)).not.toContain("Hidden Zr9");
    });
  });

  describe("a personal turn", () => {
    it("uses the personal instructions, the project list and the scoped context, and loads tools mid-turn", async () => {
      await scoped(workspaceId, personal.projectId, async (tx) => {
        await addContext(tx, personal, { category: "preference", text: `${MARKER} for summaries` }, "user");
        await addContext(tx, personal, { category: "project_note", text: "Alpha note visible", projectId: ids.A }, "user");
        await addContext(tx, personal, { category: "project_note", text: "Beta note hidden", projectId: ids.B }, "user");
      });
      mocked.steps = [
        [fn(LOAD_PROJECT_TOOLS, { projectId: ids.A, goal: "work_my_tasks" })],
        [fn("work_my_tasks", { projectId: ids.A })],
        [say("You have one task in Alpha.")],
      ];
      const { conversationId, run } = await turn("What are my tasks in Alpha?");
      expect(run.status).toBe("succeeded");
      const [first, second, third] = mocked.requests;
      expect(first!.instructions.startsWith(PERSONAL_INSTRUCTIONS)).toBe(true);
      expect(first!.instructions).toContain(`${ids.A}: Alpha`);
      expect(first!.instructions).toContain(`${ids.B}: Beta`);
      expect(first!.instructions).not.toContain("Hidden Zr9");
      expect(first!.instructions).toContain(MARKER);
      // "Alpha" is named in the message, Beta is not.
      expect(first!.instructions).toContain("Alpha note visible");
      expect(first!.instructions).not.toContain("Beta note hidden");
      expect(first!.instructions).toContain("context_remember");
      const names = (tools: any[]) => tools.map((t) => t.name);
      expect(names(first!.tools)).toContain("my_overview");
      expect(names(first!.tools)).not.toContain("work_my_tasks");
      expect(names(second!.tools)).toContain("work_my_tasks");
      expect(second!.tools.slice(0, first!.tools.length)).toEqual(first!.tools);
      expect(JSON.stringify(third!.input)).toContain(ALPHA_TASK);
      // The turn's context projects are stored, but no read shows them.
      const stored = await messages(conversationId);
      const answer = stored.find((m) => m.role === "assistant")!;
      expect(answer.cards).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "turn_context", contextProjects: [ids.A] })]),
      );
      const read = await getConversation(personal, conversationId);
      expect(JSON.stringify(read.messages)).not.toContain("turn_context");
      // Progress steps in the run snapshot.
      expect((run as any).steps).toEqual([
        { tool: LOAD_PROJECT_TOOLS, projectId: ids.A, projectName: "Alpha", state: "finished" },
        { tool: "work_my_tasks", projectId: ids.A, projectName: "Alpha", state: "finished" },
      ]);
    });

    it("a later turn of the same conversation stays tainted by earlier reads", async () => {
      await scoped(workspaceId, ids.T, (tx) =>
        grantAgentMandate(tx, { workspaceId, projectId: ids.T, userId: user.id, role: "owner" }, {
          actionType: "work.mcp.work_propose_comment",
          assistant: true,
          mcp: false,
          maxCostMicrosPerAction: 0,
          maxActionsPerDay: 20,
          days: 1,
        }),
      );
      mocked.steps = [
        [fn(LOAD_PROJECT_TOOLS, { projectId: ids.A, goal: "work_my_tasks" })],
        [fn("work_my_tasks", { projectId: ids.A })],
        [say("Read Alpha.")],
      ];
      const first = await turn("Look at Alpha");
      mocked.requests = [];
      mocked.steps = [
        [fn(LOAD_PROJECT_TOOLS, { projectId: ids.T, goal: "work_propose_comment" })],
        [fn("work_propose_comment", { projectId: ids.T, number: 1, body: "From Alpha", idempotencyKey: randomUUID() })],
        [say("Proposed.")],
      ];
      await turn("Comment on the taint task", {}, first.conversationId);
      const requests = await scoped(workspaceId, ids.T, (tx) =>
        tx.entity.findMany({ where: { projectId: ids.T, kind: "action_requests" } }),
      );
      expect(requests).toHaveLength(1);
      expect(data(requests[0]!)).toMatchObject({
        status: "pending",
        requestedBy: { kind: "agent", crossProjectContext: [ids.A] },
      });
    });
  });

  describe("inline decisions (WP3.5)", () => {
    it("a proposal card names its project and decides on the unchanged route", async () => {
      const proposal = (body: string) => [
        [fn(LOAD_PROJECT_TOOLS, { projectId: ids.A, goal: "work_propose_comment" })],
        [fn("work_propose_comment", { projectId: ids.A, number: 1, body, idempotencyKey: randomUUID() })],
        [say("Proposed.")],
      ];
      const cardOf = async (conversationId: string) => {
        const read = await getConversation(personal, conversationId);
        const answer = read.messages.find((m: any) => m.role === "assistant") as any;
        return answer.cards.find((c: any) => c.kind === "status");
      };
      mocked.steps = proposal("Please review");
      const { conversationId } = await turn("Propose a comment on Alpha task 1");
      const card = await cardOf(conversationId);
      expect(card).toMatchObject({
        projectId: ids.A,
        projectName: "Alpha",
        actionRequest: { decidable: true, inline: true, version: 1 },
      });
      const decide = (id: string, payload: object) =>
        app.inject({
          method: "POST",
          url: `/api/projects/${ids.A}/action-requests/${id}/decide`,
          headers: { origin, [CLIENT_IP_HEADER]: ip(), cookie: user.cookie },
          payload,
        });
      const ok = await decide(card.actionRequest.id, {
        version: card.actionRequest.version,
        packageHash: card.actionRequest.packageHash,
        decision: "approve",
      });
      expect(ok.statusCode).toBe(200);
      const audits = await scoped(workspaceId, ids.A, (tx) =>
        tx.auditEvent.findMany({ where: { resourceId: card.actionRequest.id, action: "action_request.approved" } }),
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actorId).toBe(user.id);
      const row = await scoped(workspaceId, ids.A, (tx) => tx.entity.findUniqueOrThrow({ where: { id: card.actionRequest.id } }));
      expect(audits[0]!.metadata).toEqual({ actionType: data(row).actionType, packageHash: data(row).packageHash });
      // Read again, the card is no longer decidable.
      expect((await cardOf(conversationId)).actionRequest.decidable).toBe(false);

      mocked.requests = [];
      mocked.steps = proposal("Second one");
      const stale = await cardOf((await turn("Another comment on Alpha task 1")).conversationId);
      const refused = await decide(stale.actionRequest.id, {
        version: stale.actionRequest.version + 1,
        packageHash: stale.actionRequest.packageHash,
        decision: "approve",
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: { code: "ACTION_REQUEST_STALE" } });
    });

    it("a viewer's card is not decidable, and pending approvals refuse a viewer project", async () => {
      // An owner's pending Work proposal in Beta, where the user is a viewer.
      const owner: Scope = { workspaceId, projectId: ids.B, userId: ownerId, role: "owner" };
      const tool = resolveCapabilities(owner, {
        channel: "assistant",
        enabled: new Set(["work"]),
        features: capabilityFeatures(registeredAssistants(new Set(["work"])), { toolSearch: true, moduleOperations: false }),
      }).find((t) => t.name === "work_propose_comment")!;
      await task(ids.B, 1, "Beta task");
      const out = (await tool.execute(
        { scope: { ...owner, role: "owner" }, runId: randomUUID(), conversationId: randomUUID(), callIndex: 1 },
        { number: 1, body: "Owner comment", idempotencyKey: randomUUID() },
      )).output as { actionRequestId: string };
      const row = await scoped(workspaceId, ids.B, (tx) => tx.entity.findUniqueOrThrow({ where: { id: out.actionRequestId } }));
      const viewer: Scope = { workspaceId, projectId: ids.B, userId: user.id, role: "viewer" };
      expect(actionRequestCard(viewer, row as any)).toMatchObject({ decidable: false, inline: true });
      expect(actionRequestCard(owner, row as any).decidable).toBe(true);
      const t = await preparePersonalTurn({
        mode: "personal", userId: user.id, workspaceId,
        run: { runId: randomUUID(), conversationId: randomUUID(), scope: personal },
      });
      const result = JSON.parse(
        await t.host.execute({ callId: "p", name: "pending_approvals", arguments: JSON.stringify({ projectIds: [ids.B] }) }, 1),
      );
      expect(result.projects).toEqual([{ projectId: ids.B, projectName: "Beta", refusal: "PERMISSION_DENIED" }]);
      expect(t.cards).toEqual([]);
    });
  });

  describe("context_remember", () => {
    const remember = async (userText: string, args: object) => {
      const conversationId = (await createConversation(personal)).id;
      const t = await preparePersonalTurn({
        mode: "personal", userId: user.id, workspaceId, userText,
        run: { runId: randomUUID(), conversationId, scope: personal },
      });
      const out = JSON.parse(
        await t.host.execute({ callId: "c", name: "context_remember", arguments: JSON.stringify(args) }, 1),
      );
      return { out, cards: t.cards, conversationId };
    };
    const entries = () => scoped(workspaceId, personal.projectId, (tx) => listContext(tx, personal));

    it("saves automatically with exactly one notice, ordered before the answer", async () => {
      mocked.steps = [
        [fn("context_remember", { category: "preference", text: "prefer short German summaries on Mondays", projectId: null })],
        [say("Noted.")],
      ];
      const { conversationId } = await turn("Please remember that I prefer short German summaries on Mondays");
      const rows = await messages(conversationId);
      expect(rows.map((m) => m.role)).toEqual(["user", "notice", "assistant"]);
      expect(rows.map((m) => m.sequence)).toEqual([1, 2, 3]);
      const notice = (rows[1]!.cards as any[])[0].notice;
      expect(notice).toMatchObject({ kind: "context_saved", text: "prefer short German summaries on Mondays" });
      const entry = (await entries()).find((e) => e.id === notice.entryId)!;
      expect(entry).toMatchObject({ createdBy: "assistant", source: { conversationId } });
      expect(notice.key).toBe(`context:${entry.id}`);
    });

    it("never saves refused or ungrounded content", async () => {
      const before = (await entries()).length;
      const secret = await remember("Remember that my password is hunter2 forever", {
        category: "preference", text: "my password is hunter2 forever", projectId: null,
      });
      expect(secret.out).toEqual({ error: "PERSONAL_CONTEXT_NOT_ALLOWED" });
      const health = await remember("Remember my diagnosis was diabetes", {
        category: "preference", text: "diagnosis was diabetes", projectId: null,
      });
      expect(health.out).toEqual({ error: "PERSONAL_CONTEXT_NOT_ALLOWED" });
      const ungrounded = await remember("Remember this for me", {
        category: "project_note", text: `${ALPHA_TASK} is due next Friday`, projectId: null,
      });
      expect(ungrounded.out).toEqual({ error: "PERSONAL_CONTEXT_NOT_GROUNDED" });
      const foreign = await remember("Remember Hidden project notes daily", {
        category: "project_note", text: "Hidden project notes daily", projectId: ids.H,
      });
      expect(foreign.out).toEqual({ projectId: ids.H, error: "PROJECT_FORBIDDEN" });
      expect((await entries()).length).toBe(before);
      for (const { conversationId } of [secret, health, ungrounded, foreign])
        expect((await messages(conversationId)).filter((m) => m.role === "notice")).toEqual([]);
    });

    it("proposes a card and saves nothing with automatic memory off", async () => {
      await scoped(workspaceId, personal.projectId, (tx) => saveAssistantSettings(tx, personal, { autoMemory: false }));
      try {
        const before = (await entries()).length;
        const result = await remember("Remember I review drafts every Thursday", {
          category: "workflow", text: "review drafts every Thursday", projectId: null,
        });
        expect(result.out).toEqual({ saved: false, proposed: true });
        expect(result.cards).toEqual([
          expect.objectContaining({
            kind: "context_proposal",
            contextProposal: { category: "workflow", text: "review drafts every Thursday" },
          }),
        ]);
        expect((await entries()).length).toBe(before);
        expect((await messages(result.conversationId)).filter((m) => m.role === "notice")).toEqual([]);
      } finally {
        await scoped(workspaceId, personal.projectId, (tx) => saveAssistantSettings(tx, personal, { autoMemory: true }));
      }
    });
  });

  describe("context isolation", () => {
    it("context is never offered to project chat, MCP or agents", () => {
      for (const channel of ["assistant", "mcp", "agent"] as const) {
        const offered = resolveCapabilities(personal, {
          channel,
          enabled: undefined,
          features: capabilityFeatures(registeredAssistants(), { toolSearch: true, moduleOperations: true }),
        }).map((t) => t.name);
        expect(offered).not.toContain("context_remember");
      }
    });

    it("a project chat turn of the same user never sees the personal context", async () => {
      const business: Scope = { workspaceId, projectId: ids.T, userId: user.id, role: "owner" };
      const past = new Date(Date.now() - 3600000).toISOString();
      const future = new Date(Date.now() + 86400000).toISOString();
      await scoped(workspaceId, ids.T, async (tx) => {
        await create(tx, business, "policies", {
          mode: "observe", channels: [], contentTypes: ["social"], allowedOrigins: ["https://example.invalid"],
          startAt: past, endAt: future, maxPerDay: 0, minIntervalMinutes: 1,
          dailyBudgetMicros: 100000, monthlyBudgetMicros: 100000, perRunBudgetMicros: 10000,
          approvedPaidTests: true, active: true,
        });
        await saveOpenAiConfiguration(tx, business, {
          apiKey: "synthetic-no-provider-call-key",
          verifiedModels: ["synthetic-model"],
          rateCard: { "synthetic-model": { inputMicrosPerMillion: 1000, outputMicrosPerMillion: 1000, verifiedAt: new Date().toISOString() } },
          modelRoutes: { fast: "synthetic-model", standard: "synthetic-model", quality: "synthetic-model", escalation: "synthetic-model" },
        });
      });
      mocked.steps = [[say("Project answer.")]];
      const thread = await createConversation(business);
      const sent = await sendMessage(business, thread.id, {
        text: `What about ${MARKER}?`,
        clientRequestId: randomUUID(),
        // Hints are ignored outside a personal space.
        focusProjectId: ids.A,
      });
      await runChatJob(business, user.id, sent.runId);
      expect(mocked.requests).toHaveLength(1);
      const sentRequest = JSON.stringify({ ...mocked.requests[0], input: [] });
      expect(sentRequest).not.toContain(MARKER);
      expect(mocked.requests[0]!.instructions).not.toContain(PERSONAL_INSTRUCTIONS);
      const names = mocked.requests[0]!.tools.map((t: any) => t.name);
      expect(names).not.toContain("context_remember");
      expect(names).not.toContain("my_overview");
      const stored = await userScoped(business, (tx) =>
        tx.chatMessage.findFirstOrThrow({ where: { conversationId: thread.id, role: "user" } }),
      );
      // No hint card: the column keeps its default.
      expect(stored.cards).toEqual([]);
    });

    it("only the personal-context store, the personal prompt, routes and context_remember read the context", () => {
      // Agent work orders and MCP tools build their inputs elsewhere: no
      // file outside this list may name the store's readers or its kind.
      const allowed = new Set([
        "platform/assistant/personal-context.ts",
        "platform/assistant/personal-mode.ts",
        "platform/assistant/chat-runner.ts",
        "platform/assistant/routes.ts",
        "platform/assistant/user-tools.ts",
        "platform/modules/platform-declaration.ts",
      ]);
      const root = join(__dirname, "../src");
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          if (statSync(path).isDirectory()) walk(path);
          else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) {
            const rel = path.slice(root.length + 1);
            const text = readFileSync(path, "utf8");
            if (/listContext|contextForPrompt|personalContextSection|PERSONAL_CONTEXT_KIND|"personal_context"/.test(text) && !allowed.has(rel))
              offenders.push(rel);
          }
        }
      };
      walk(root);
      expect(offenders).toEqual([]);
    });
  });
});

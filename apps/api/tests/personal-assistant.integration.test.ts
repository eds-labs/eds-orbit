import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import {
  fromAnthropicMessage,
  toAnthropicMessages,
  toAnthropicTools,
} from "../../../packages/ai/src/providers/anthropic.ts";
import { data } from "../src/shared.ts";
import {
  executePersonalProjectCall,
  inProjectCall,
} from "../src/platform/agents/project-calls.ts";
import { legacyResponsesRuntime } from "../src/platform/agents/runtime/legacy-responses.ts";
import type {
  BudgetedModel,
  ModelStep,
} from "../src/platform/agents/runtime/port.ts";
import {
  LOAD_PROJECT_TOOLS,
  preparePersonalTurn,
  requestBytes,
  type PersonalTurn,
} from "../src/platform/assistant/personal-turn.ts";
import { grantAgentMandate } from "../src/platform/governance/agent-mandates.ts";
import { resolveAuthorization } from "../src/platform/governance/authorization.ts";
import { createActionRequest } from "../src/platform/governance/action-requests.ts";
import { crossProjectExecution } from "../src/platform/agents/agent-execution.ts";

// The personal Orbit Assistant's cross-project layer (ADR 0022, plan
// agent-platform-phase-3 WP3.2/WP3.3, tests of §3 and §10): user tools read
// one project at a time with the member's own rights there, refusals carry
// no data, proposals after another project's data are never mandate
// approved, and project tools load in stages the same way for Claude and
// OpenAI. No provider is called: model steps are scripted.

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

const FLAGS: Record<string, string> = {
  ORBIT_WORK: "true",
  ORBIT_MODULE_ROLES: "true",
  ORBIT_AGENT_MANDATES: "true",
  ORBIT_PERSONAL_ASSISTANT: "true",
};
const ALPHA_TASK = "Alpha visible task";
const BETA_TASK = "Beta hidden task Qx7";
const HIDDEN_NAME = "Hidden project Zr9";

describe.skipIf(!enabled)("personal assistant cross-project layer", () => {
  const saved: Record<string, string | undefined> = {};
  let workspaceId = "";
  let ownerId = "";
  let userId = "";
  // A: editor; B: editor with Work role none; V: viewer; T: owner (taint);
  // H: not a member; P: paused; N: editor, Work not enabled.
  const ids = {} as Record<"A" | "B" | "V" | "T" | "H" | "P" | "N", string>;
  let personal: Scope;

  async function user(name: string) {
    const id = randomUUID();
    await authDb.user.create({
      data: { id, name, email: `${id}@example.invalid` },
    });
    return id;
  }
  async function project(
    name: string,
    role: "owner" | "editor" | "viewer" | null,
    options: { work?: boolean; paused?: boolean } = {},
  ) {
    const row = await authDb.project.create({
      data: {
        workspaceId,
        name,
        paused: options.paused ?? false,
        members: {
          create: [
            { userId: ownerId, role: "owner" },
            ...(role ? [{ userId, role }] : []),
          ],
        },
      },
    });
    if (options.work !== false)
      await scoped(workspaceId, row.id, (tx) =>
        tx.projectModule.create({
          data: {
            workspaceId,
            projectId: row.id,
            moduleId: "work",
            enabled: true,
            moduleVersion: "1.0.0",
            changedBy: ownerId,
          },
        }),
      );
    return row.id;
  }
  async function task(projectId: string, number: number, title: string) {
    await scoped(workspaceId, projectId, (tx) =>
      tx.workTask.create({
        data: {
          id: randomUUID(),
          workspaceId,
          projectId,
          number,
          title,
          status: "todo",
          statusCategory: "todo",
          rank: `a${number}`,
          assigneeUserId: userId,
          createdBy: ownerId,
        },
      }),
    );
  }

  beforeAll(async () => {
    for (const [key, value] of Object.entries(FLAGS)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    ownerId = await user("Synthetic org owner");
    userId = await user("Synthetic personal user");
    const workspace = await authDb.workspace.create({
      data: {
        name: "Personal assistant org",
        members: {
          create: [
            { userId: ownerId, role: "owner" },
            { userId, role: "viewer" },
          ],
        },
      },
    });
    workspaceId = workspace.id;
    ids.A = await project("Alpha", "editor");
    ids.B = await project("Beta", "editor");
    ids.V = await project("Viewer project", "viewer");
    ids.T = await project("Taint target", "owner");
    ids.H = await project(HIDDEN_NAME, null);
    ids.P = await project("Paused", "editor", { paused: true });
    ids.N = await project("No work", "editor", { work: false });
    await authDb.projectMemberModuleRole.create({
      data: {
        workspaceId,
        projectId: ids.B,
        userId,
        moduleId: "work",
        role: "none",
        changedBy: ownerId,
      },
    });
    await task(ids.A, 1, ALPHA_TASK);
    await task(ids.B, 1, BETA_TASK);
    await task(ids.V, 1, "Viewer task");
    await task(ids.T, 1, "Taint task");
    await task(ids.H, 1, "Hidden task");
    const space = await authDb.project.create({
      data: {
        workspaceId,
        name: "Personal space",
        kind: "personal",
        personalUserId: userId,
        members: { create: { userId, role: "owner" } },
      },
    });
    personal = { workspaceId, projectId: space.id, userId, role: "owner" };
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await closeDatabase();
  });

  const turn = (focusProjectId?: string) =>
    preparePersonalTurn({
      mode: "personal",
      userId,
      workspaceId,
      ...(focusProjectId ? { focusProjectId } : {}),
      run: { runId: randomUUID(), conversationId: randomUUID(), scope: personal },
    });
  let callIndex = 0;
  const call = async (t: PersonalTurn, name: string, args: object) =>
    JSON.parse(
      await t.host.execute(
        { callId: randomUUID(), name, arguments: JSON.stringify(args) },
        ++callIndex,
      ),
    );
  const entry = (output: any, projectId: string) =>
    output.projects.find((p: any) => p.projectId === projectId);

  it("lists only the business projects the user is in, never the personal space", async () => {
    const t = await turn();
    expect(t.projects.map((p) => p.id).sort()).toEqual(
      [ids.A, ids.B, ids.V, ids.T, ids.P, ids.N].sort(),
    );
    const listed = await call(t, "projects_list", {});
    expect(listed.projects.map((p: any) => p.id)).not.toContain(personal.projectId);
    expect(listed.projects.map((p: any) => p.id)).not.toContain(ids.H);
    expect(JSON.stringify(listed)).not.toContain(HIDDEN_NAME);
    const beta = listed.projects.find((p: any) => p.id === ids.B);
    expect(beta.modules).not.toContain("work");
    expect(listed.projects.find((p: any) => p.id === ids.A).modules).toContain(
      "work",
    );
  });

  it("scenario B: A's tasks, only a refusal for B's Work, no data of B's tasks", async () => {
    const t = await turn();
    const output = await call(t, "my_overview", {
      projectIds: [ids.A, ids.B],
      modules: ["work"],
    });
    const alpha = entry(output, ids.A);
    expect(alpha.projectName).toBe("Alpha");
    expect(alpha.modules.work.openTasks).toBe(1);
    expect(alpha.modules.work.tasks[0].title).toBe(ALPHA_TASK);
    expect(alpha.modules.work.tasks[0].link).toMatch(
      new RegExp(`^/p/${ids.A}/work/tasks\\?task=`),
    );
    const beta = entry(output, ids.B);
    expect(beta.modules.work).toEqual({ refusal: "PERMISSION_DENIED" });
    expect(beta.attention).toEqual([]);
    expect(JSON.stringify(output)).not.toContain(BETA_TASK);
    expect(t.contextProjects().sort()).toEqual([ids.A, ids.B].sort());
  });

  it("a viewer sees viewer data only: no approvals to decide", async () => {
    const t = await turn();
    const overview = await call(t, "my_overview", { projectIds: [ids.V], modules: null });
    const viewer = entry(overview, ids.V);
    expect(viewer.approvals).toEqual({ refusal: "PERMISSION_DENIED" });
    expect(viewer.modules.work.tasks[0].title).toBe("Viewer task");
    const approvals = await call(t, "pending_approvals", { projectIds: [ids.V] });
    expect(approvals.projects).toEqual([
      {
        projectId: ids.V,
        projectName: "Viewer project",
        refusal: "PERMISSION_DENIED",
      },
    ]);
  });

  it("a project the user is not in is PROJECT_FORBIDDEN without its name", async () => {
    const t = await turn();
    const overview = await call(t, "my_overview", {
      projectIds: [ids.H, personal.projectId, randomUUID()],
      modules: null,
    });
    for (const projectEntry of overview.projects)
      expect(projectEntry).toEqual({
        projectId: projectEntry.projectId,
        refusal: "PROJECT_FORBIDDEN",
      });
    expect(JSON.stringify(overview)).not.toContain(HIDDEN_NAME);
    const loaded = await call(t, LOAD_PROJECT_TOOLS, {
      projectId: ids.H,
      goal: "tasks",
    });
    expect(loaded).toEqual({ projectId: ids.H, error: "PROJECT_FORBIDDEN" });
    expect(t.contextProjects()).toEqual([]);
  });

  it("refuses target-project calls uniformly, with no data", async () => {
    const run = (projectId: string, toolName = "work_my_tasks") =>
      executePersonalProjectCall({
        workspaceId,
        userId,
        projectId,
        toolName,
        args: {},
        context: { runId: randomUUID(), conversationId: randomUUID(), callIndex: 1 },
      });
    await expect(run(ids.H)).rejects.toMatchObject({ code: "PROJECT_FORBIDDEN" });
    await expect(run(personal.projectId)).rejects.toMatchObject({
      code: "PROJECT_FORBIDDEN",
    });
    await expect(run(ids.B)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(run(ids.N)).rejects.toMatchObject({ code: "MODULE_DISABLED" });
    await expect(run(ids.P)).rejects.toMatchObject({ code: "PROJECT_PAUSED" });
    const ok = await run(ids.A);
    expect(JSON.stringify(ok.result.output)).toContain(ALPHA_TASK);
  });

  it("never nests project calls (lock-order assertion)", async () => {
    await expect(
      inProjectCall(ids.A, () =>
        executePersonalProjectCall({
          workspaceId,
          userId,
          projectId: ids.B,
          toolName: "work_my_tasks",
          args: {},
          context: { runId: randomUUID(), conversationId: randomUUID(), callIndex: 1 },
        }),
      ),
    ).rejects.toThrow("NESTED_PROJECT_CALL");
  });

  it("refuses a forged call to an unloaded tool or an unloaded project", async () => {
    const t = await turn();
    expect(await call(t, "work_my_tasks", { projectId: ids.A })).toEqual({
      error: "CHAT_TOOL_NOT_ALLOWED",
    });
    expect(
      await call(t, LOAD_PROJECT_TOOLS, { projectId: ids.A, goal: "work_my_tasks" }),
    ).toMatchObject({ projectId: ids.A, projectName: "Alpha", loaded: ["work_my_tasks"] });
    // Loaded for A only: B (and the hidden project) stay refused before any read.
    expect(await call(t, "work_my_tasks", { projectId: ids.B })).toEqual({
      error: "CHAT_TOOL_NOT_ALLOWED",
    });
    expect(await call(t, "work_my_tasks", { projectId: ids.H })).toEqual({
      error: "CHAT_TOOL_NOT_ALLOWED",
    });
    expect(await call(t, "orbit_projects", {})).toEqual({ error: "CHAT_TOOL_NOT_ALLOWED" });
    // B's Work tools cannot be loaded: role none.
    const beta = await call(t, LOAD_PROJECT_TOOLS, { projectId: ids.B, goal: "work_my_tasks" });
    expect(beta.loaded).not.toContain("work_my_tasks");
    const ok = await call(t, "work_my_tasks", { projectId: ids.A });
    expect(ok.projectId).toBe(ids.A);
    expect(ok.projectName).toBe("Alpha");
    expect(JSON.stringify(ok.result)).toContain(ALPHA_TASK);
  });

  it("preloads at most six tools of an accessible focus project and drops another focus", async () => {
    const focused = await turn(ids.A);
    expect(focused.focusProjectId).toBe(ids.A);
    const preloaded = focused.staticTools.length - (await turn()).staticTools.length;
    expect(preloaded).toBeGreaterThan(0);
    expect(preloaded).toBeLessThanOrEqual(6);
    const foreign = await turn(ids.H);
    expect(foreign.focusProjectId).toBeNull();
  });

  describe("taint", () => {
    const COMMENT = "work.mcp.work_propose_comment";
    const ownerInT = (): Scope => ({ workspaceId, projectId: ids.T, userId, role: "owner" });

    beforeAll(async () => {
      await scoped(workspaceId, ids.T, (tx) =>
        grantAgentMandate(tx, ownerInT(), {
          actionType: COMMENT,
          assistant: true,
          mcp: false,
          maxCostMicrosPerAction: 0,
          maxActionsPerDay: 20,
          days: 1,
        }),
      );
    });

    async function propose(t: PersonalTurn, body: string) {
      await call(t, LOAD_PROJECT_TOOLS, { projectId: ids.T, goal: "work_propose_comment" });
      const out = await call(t, "work_propose_comment", {
        projectId: ids.T,
        number: 1,
        body,
        idempotencyKey: randomUUID(),
      });
      expect(out.projectId).toBe(ids.T);
      return out.result;
    }
    const row = (id: string) =>
      scoped(workspaceId, ids.T, (tx) => tx.entity.findUniqueOrThrow({ where: { id } }));

    it("a proposal with only its own project's data runs under the mandate", async () => {
      const result = await propose(await turn(), "Own context only");
      expect(result.approvedBy).toBe("mandate");
      expect(data(await row(result.actionRequestId)).requestedBy.crossProjectContext).toBeUndefined();
    });

    it("a proposal after another project's data waits for a human and names it", async () => {
      const t = await turn();
      await call(t, "my_overview", { projectIds: [ids.A], modules: ["work"] });
      const result = await propose(t, "Uses Alpha's data");
      expect(result.status).toBe("pending");
      expect(result.requiresApproval).toBe(true);
      const stored = await row(result.actionRequestId);
      expect(data(stored).requestedBy).toMatchObject({
        kind: "agent",
        userId,
        crossProjectContext: [ids.A],
      });
      const authorization = await scoped(workspaceId, ids.T, (tx) =>
        resolveAuthorization(tx, ownerInT(), stored as any),
      );
      expect(authorization).toEqual({
        mode: "approval_required",
        reasons: ["CROSS_PROJECT_CONTEXT"],
      });
    });

    it("the taint never names the proposal's own project", async () => {
      const created = await scoped(workspaceId, ids.T, (tx) =>
        crossProjectExecution.run({ contextProjects: [ids.T] }, () =>
          createActionRequest(tx, ownerInT(), {
            actionType: COMMENT,
            payload: {
              actorId: userId,
              args: { number: 1, body: "x" },
              idempotencyKey: randomUUID(),
              ceilingMicros: 0,
            },
            requestedBy: { kind: "agent", userId, agentRunId: null },
          }),
        ),
      );
      expect(data(created).requestedBy.crossProjectContext).toBeUndefined();
    });
  });

  describe("staged loading with scripted providers", () => {
    type Script = (turn: PersonalTurn) => Array<(request: unknown) => ModelStep>;
    async function runScripted(provider: "anthropic" | "openai", t: PersonalTurn, script: Script) {
      const sent: Array<{ tools: unknown[]; input: unknown[]; bytes: number }> = [];
      const steps = script(t);
      const model: BudgetedModel = {
        async call(request) {
          const tools = [...t.staticTools, ...(request.loadedTools ?? [])];
          const instructions = "Personal mode (scripted).";
          // What each provider adapter would receive; the Anthropic adapter
          // refuses tool_search items, so none may appear.
          if (provider === "anthropic") {
            toAnthropicTools(tools);
            toAnthropicMessages(request.input);
          }
          sent.push({
            tools,
            input: [...request.input],
            bytes: requestBytes({ input: request.input, instructions, tools }),
          });
          return steps[sent.length - 1]!(request);
        },
      };
      await legacyResponsesRuntime.runTurn({
        input: [{ role: "user", content: "What are my open tasks in Alpha?" }],
        model,
        tools: t.host,
        limits: { maxModelCalls: 8, maxToolCalls: 16 },
        signal: new AbortController().signal,
      });
      return sent;
    }

    const toolStep = (provider: "anthropic" | "openai", name: string, input: object): ModelStep => {
      const id = `call_${randomUUID().slice(0, 8)}`;
      if (provider === "anthropic") {
        // A Claude response as the Messages API returns it.
        const message = {
          id: `msg_${id}`,
          type: "message",
          role: "assistant",
          model: "claude-scripted",
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "tool_use", id, name, input }],
        } as unknown as Message;
        const output = fromAnthropicMessage(message);
        return {
          output,
          toolCalls: output
            .filter((item: any) => item.type === "function_call")
            .map((item: any) => ({ callId: item.call_id, name: item.name, arguments: item.arguments })),
          toolSearches: [],
        };
      }
      const item = { type: "function_call", call_id: id, name, arguments: JSON.stringify(input) };
      return {
        output: [item],
        toolCalls: [{ callId: id, name, arguments: item.arguments }],
        toolSearches: [],
      };
    };
    const answer: ModelStep = {
      output: [{ type: "message", role: "assistant", content: "Done." }],
      toolCalls: [],
      toolSearches: [],
    };

    for (const provider of ["anthropic", "openai"] as const)
      it(`a ${provider} turn loads project tools mid-turn, with a stable fixed list`, async () => {
        const t = await turn();
        const sent = await runScripted(provider, t, () => [
          () => toolStep(provider, LOAD_PROJECT_TOOLS, { projectId: ids.A, goal: "work_my_tasks" }),
          () => toolStep(provider, "work_my_tasks", { projectId: ids.A }),
          () => answer,
        ]);
        expect(sent).toHaveLength(3);
        const names = (tools: unknown[]) => tools.map((tool: any) => tool.name);
        expect(names(sent[0]!.tools)).not.toContain("work_my_tasks");
        expect(names(sent[1]!.tools)).toContain("work_my_tasks");
        // The fixed list is the unchanged prefix of every call; loaded tools are appended.
        for (const request of sent)
          expect(request.tools.slice(0, t.staticTools.length)).toEqual([...t.staticTools]);
        expect(sent[1]!.tools.at(-1)).toMatchObject({
          name: "work_my_tasks",
          parameters: { required: ["projectId"] },
        });
        // Definitions count toward the request bytes.
        const withoutLoaded = requestBytes({
          input: sent[1]!.input,
          instructions: "Personal mode (scripted).",
          tools: sent[0]!.tools,
        });
        expect(sent[1]!.bytes).toBeGreaterThan(withoutLoaded);
        // The project tool's labelled output reached the model.
        const outputs = sent[2]!.input.filter((item: any) => item.type === "function_call_output");
        expect(String((outputs.at(-1) as any).output)).toContain(ALPHA_TASK);
        expect(String((outputs.at(-1) as any).output)).toContain(`"projectId":"${ids.A}"`);
        expect(t.contextProjects()).toEqual([ids.A]);
      });
  });
});

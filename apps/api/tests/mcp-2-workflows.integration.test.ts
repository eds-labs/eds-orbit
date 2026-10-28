import { userScoped } from "../src/platform/tenancy/scope.ts";
import { exportProject } from "../src/platform/governance/export.ts";
import { taskRetention } from "../src/platform/tasks/retention.ts";
import { eraseContact } from "../src/modules/support/privacy.ts";
import {
  TaskSubscriptions,
  taskUri,
} from "../src/platform/mcp/task-resources.ts";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  authDb,
  scoped,
  closeDatabase,
} from "../../../packages/db/src/index.ts";
import { createPackageProject, X } from "./support/package-project.ts";
import { registerModules } from "../src/modules/registry.ts";
import { create, data, entity, update } from "../src/shared.ts";
import { taskTools } from "../src/platform/mcp/native/tasks.ts";
import type { McpPrincipal } from "../src/platform/mcp/principal.ts";
import type { NativeToolContext } from "../src/platform/mcp/native-tools.ts";
import {
  createTask,
  readTask,
  cancelTask,
  listTasks,
} from "../src/platform/tasks/tasks.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import { runChatJob } from "../src/modules/chat-runner.ts";
import {
  visibleMcpTools,
  authorizeMcpCall,
} from "../src/platform/mcp/visibility.ts";
import { moduleScope } from "../src/platform/tenancy/module-roles.ts";
import { createMailInbox } from "./fixtures/mailbox.ts";
import { createTicket } from "../src/modules/support/tickets.ts";
import { loadInbox, updateInbox } from "../src/modules/support/inboxes.ts";
import { supportMcpTools } from "../src/modules/support/mcp-tools.ts";
import { knowledgeMcpTools } from "../src/modules/knowledge/mcp-tools.ts";
import { retrieve } from "../../../packages/knowledge/src/index.ts";

const model = vi.hoisted(() => ({
  calls: 0,
  tool: "",
  args: {} as any,
  called: false,
  offered: [] as any[],
  pause: null as null | (() => Promise<void>),
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  streamChat: vi.fn(async (request: any) => {
    model.calls++;
    model.offered = request.tools;
    await model.pause?.();
    const call = model.tool && !model.called;
    if (call) model.called = true;
    return {
      async *[Symbol.asyncIterator]() {
        if (!call)
          yield {
            type: "response.output_text.delta",
            delta: "Synthetic reviewed result.",
          };
        yield {
          type: "response.completed",
          response: {
            id: "synthetic",
            usage: { input_tokens: 100, output_tokens: 20 },
            output: call
              ? [
                  {
                    type: "function_call",
                    call_id: "synthetic-call",
                    name: model.tool,
                    arguments: JSON.stringify(model.args),
                  },
                ]
              : [],
          },
        };
      },
    };
  }),
}));
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerModules();
describe.skipIf(!enabled)(
  "MCP 2.0 native workflows A–G (real SQL, fake providers)",
  () => {
    let project: Awaited<ReturnType<typeof createPackageProject>>;
    let principal: McpPrincipal;
    let inboxId: string;
    const saved: Record<string, string | undefined> = {};
    const flags = {
      ORBIT_MCP_TASKS: "true",
      ORBIT_MCP_PROPOSALS: "true",
      ORBIT_SUPPORT: "true",
      ORBIT_CONTENT_PACKAGES: "true",
      ORBIT_MODULES: "true",
    };
    const run = <T>(work: Parameters<typeof scoped<T>>[2]) =>
      scoped(project.owner.workspaceId, project.owner.projectId, work);
    const ctx = {
      requestId: "synthetic",
      callId: "synthetic",
      clientId: "client.test",
      grantId: "",
      agentRunId: null,
      setAuditProject() {},
      async startRun() {
        return null;
      },
      withProjectSlot: (_p: string, work: () => Promise<any>) => work(),
      projectSlotDeadline: () => Date.now() + 5000,
      log: { warn() {}, error() {} },
    } as unknown as NativeToolContext;
    async function decide(
      id: string,
      decision: "approve" | "reject" = "approve",
    ) {
      return run(async (tx) => {
        const row = await entity(tx, project.owner, "action_requests", id);
        return decideActionRequest(tx, project.owner, id, {
          version: row.version,
          packageHash: data(row).packageHash,
          decision,
        });
      });
    }
    async function native(name: string, args: any) {
      return taskTools
        .find((t) => t.name === name)!
        .run(
          principal,
          { projectId: project.owner.projectId, ...args },
          ctx,
        ) as Promise<any>;
    }
    async function op(name: string, args: any, p = principal) {
      const { tool, scope } = await authorizeMcpCall(
        p,
        name,
        project.owner.projectId,
      );
      return tool.execute(
        {
          scope: moduleScope(
            scope,
            name.startsWith("support") ? "support" : "knowledge",
          ),
          runId: "synthetic",
          conversationId: "synthetic",
          callIndex: 0,
          channel: {
            kind: "mcp",
            clientId: p.clientId,
            grantId: p.grantId,
            requestId: "synthetic",
          },
        },
        args,
      );
    }
    beforeAll(async () => {
      for (const [key, value] of Object.entries(flags)) {
        saved[key] = process.env[key];
        process.env[key] = value;
      }
      project = await createPackageProject({ name: "Synthetic MCP 2.0" });
      await run(async (tx) => {
        for (const id of ["support", "marketing", "knowledge"])
          await tx.projectModule.upsert({
            where: {
              workspaceId_projectId_moduleId: {
                workspaceId: project.owner.workspaceId,
                projectId: project.owner.projectId,
                moduleId: id,
              },
            },
            create: {
              workspaceId: project.owner.workspaceId,
              projectId: project.owner.projectId,
              moduleId: id,
              moduleVersion: "1.0.0",
              enabled: true,
            },
            update: { enabled: true },
          });
        const inbox = await createMailInbox(tx, project.owner, {
          name: "Synthetic support",
          channels: ["email"],
          emailAddress: "support@example.invalid",
        });
        inboxId = inbox.inbox.id;
      });
      const grant = await authDb.mcpGrant.create({
        data: {
          workspaceId: project.owner.workspaceId,
          userId: project.owner.userId,
          clientId: "https://client.test/mcp2.json",
          projectIds: [project.owner.projectId],
          scopes: [
            "orbit:read",
            "orbit:propose",
            "orbit:write",
            "orbit:support",
          ],
          modules: [],
          status: "active",
          activatedAt: new Date(),
        },
      });
      principal = {
        workspaceId: project.owner.workspaceId,
        userId: project.owner.userId,
        clientId: grant.clientId,
        grantId: grant.id,
        projectIds: [project.owner.projectId],
        scopes: new Set(grant.scopes),
        modules: [],
      };
    }, 120000);
    afterAll(async () => {
      await project?.cleanup();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await closeDatabase();
    });

    it("A/G: creates once, requires approval, runs existing chat worker, survives a repeated worker invocation and returns its result", async () => {
      model.tool = "";
      model.called = false;
      const input = {
        description: "Inspect the synthetic project's marketing state",
        modules: ["marketing"],
        idempotencyKey: randomUUID(),
      };
      const made = await native("orbit_create_task", input);
      const repeated = await Promise.all([
        native("orbit_create_task", input),
        native("orbit_create_task", input),
      ]);
      expect(
        repeated.every((r) => r.taskId === made.taskId && r.deduplicated),
      ).toBe(true);
      await expect(
        native("orbit_create_task", { ...input, description: "changed" }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
      const before = await native("orbit_get_task", { taskId: made.taskId });
      expect(before.task.status).toBe("awaiting_approval");
      expect(before.task.runId).toBeNull();
      await decide(made.actionRequestId);
      const queued = await readTask(project.owner, made.taskId);
      expect(queued.phase).toBe("queued");
      const calls = model.calls;
      await runChatJob(project.owner, project.owner.userId, queued.runId);
      await runChatJob(project.owner, project.owner.userId, queued.runId);
      expect(model.calls).toBe(calls + 1);
      const result = await native("orbit_get_task_result", {
        taskId: made.taskId,
      });
      expect(result.task.status).toBe("succeeded");
      expect(result.task.result).toContain("Synthetic reviewed result");
      expect(
        (await cancelTask(project.owner, made.taskId, principal.clientId))
          .status,
      ).toBe("succeeded");
    });

    it("budget: a delegated run cannot exceed the exact approved chat ceiling", async () => {
      model.tool = "";
      const made = await native("orbit_create_task", {
        description: "Review state within the approved budget",
        modules: ["marketing"],
        idempotencyKey: randomUUID(),
      });
      await decide(made.actionRequestId);
      const task = await readTask(project.owner, made.taskId);
      // Simulate an insufficient saved ceiling before the queued run dispatches.
      await run(async (tx) => {
        const row = await entity(tx, project.owner, "orbit_tasks", made.taskId);
        await update(tx, project.owner, row, {
          ...data(row),
          delegation: { ...data(row).delegation, ceilingMicros: 1 },
        });
      });
      const calls = model.calls;
      await runChatJob(project.owner, project.owner.userId, task.runId);
      expect(model.calls).toBe(calls);
      const stopped = await readTask(project.owner, made.taskId);
      expect(stopped.status).toBe("blocked");
      expect(stopped.errorCode).toBe("COST_CEILING_CHANGED");
    });

    it("B/F: reads a ticket and stores a draft after exact owner approval without sending it", async () => {
      const made = await run((tx) =>
        createTicket(tx, project.owner, {
          inboxId,
          channel: "email",
          inbound: {
            externalId: randomUUID(),
            contact: {
              email: "private@example.invalid",
              name: "Synthetic Customer",
            },
            subject: "Test question",
            bodyText: "Where is my report?",
            attachments: [],
          },
        }),
      );
      const ticketId = made.ticketId;
      const read: any = await op("support_ticket", { ticketId });
      expect(
        read.output.result.messages.some((m: any) =>
          m.bodyText?.includes("report"),
        ),
      ).toBe(true);
      expect(JSON.stringify(read.output)).not.toContain(
        "private@example.invalid",
      );
      const draft: any = await op("support_prepare_reply", {
        ticketId,
        bodyText: "Your report is being reviewed.",
        idempotencyKey: randomUUID(),
      });
      expect(
        await run((tx) =>
          tx.supportMessage.count({ where: { ticketId, kind: "ai_draft" } }),
        ),
      ).toBe(0);
      await decide(draft.output.actionRequestId);
      const messages = await run((tx) =>
        tx.supportMessage.findMany({ where: { ticketId } }),
      );
      expect(messages.filter((m) => m.kind === "ai_draft")).toHaveLength(1);
      expect(
        messages.some(
          (m) =>
            m.kind === "agent_reply" ||
            (m.visibleToCustomer && m.kind !== "customer"),
        ),
      ).toBe(false);
      const refused: any = await op("support_send_reply", {
        ticketId,
        bodyText: "Must never be sent.",
        idempotencyKey: randomUUID(),
      });
      await decide(refused.output.actionRequestId, "reject");
      expect(
        await run((tx) =>
          tx.supportMessage.count({ where: { ticketId, kind: "agent_reply" } }),
        ),
      ).toBe(0);
    });

    it("Support: the main agent proposes the canonical reply tool and still needs separate exact send approval", async () => {
      const made = await run((tx) =>
        createTicket(tx, project.owner, {
          inboxId,
          channel: "email",
          inbound: {
            externalId: randomUUID(),
            contact: { email: `${randomUUID()}@example.invalid` },
            subject: "Canonical task reply",
            bodyText: "Please review my report.",
            attachments: [],
          },
        }),
      );
      model.tool = "support_reply_ticket";
      model.called = false;
      model.args = {
        ticketId: made.ticketId,
        message: "Your report is being reviewed.",
        idempotencyKey: randomUUID(),
      };
      const created = await native("orbit_create_task", {
        description: "Propose a reply to the report ticket",
        modules: ["support"],
        idempotencyKey: randomUUID(),
      });
      await decide(created.actionRequestId);
      const queued = await readTask(project.owner, created.taskId);
      await runChatJob(project.owner, project.owner.userId, queued.runId);
      const awaiting = await readTask(project.owner, created.taskId);
      const reply = awaiting.approvals.find(
        (a) => a.actionType === "support.mcp.support_send_reply",
      );
      expect(reply).toBeDefined();
      expect(
        await run((tx) =>
          tx.supportMessage.count({
            where: { ticketId: made.ticketId, kind: "agent_reply" },
          }),
        ),
      ).toBe(0);
      await decide(reply!.actionRequestId);
      expect(
        await run((tx) =>
          tx.supportMessage.count({
            where: { ticketId: made.ticketId, kind: "agent_reply" },
          }),
        ),
      ).toBe(1);
      const finished = await readTask(project.owner, created.taskId);
      expect(finished.status).toBe("succeeded");
      const replyMessage = await run((tx) =>
        tx.supportMessage.findFirstOrThrow({
          where: { ticketId: made.ticketId, kind: "agent_reply" },
        }),
      );
      expect(
        finished.artifacts.some(
          (a) => a.id === replyMessage.id && a.kind === "operation_result",
        ),
      ).toBe(true);
    });

    it("Support: a delegated work order never sends under the owner's inbox reply rule", async () => {
      // The rule covers the owner's own MCP calls; a delegated run carries
      // an MCP channel too, but is recorded with its task and keeps approval.
      const setRule = (enabled: boolean) =>
        run(async (tx) => {
          const current = await loadInbox(tx, project.owner, inboxId);
          return updateInbox(tx, project.owner, inboxId, {
            version: current.version,
            rules: {
              ...(current.rules as Record<string, unknown>),
              mcpOwnerRepliesWithoutApproval: enabled,
            },
          });
        });
      await setRule(true);
      try {
        const made = await run((tx) =>
          createTicket(tx, project.owner, {
            inboxId,
            channel: "email",
            inbound: {
              externalId: randomUUID(),
              contact: { email: `${randomUUID()}@example.invalid` },
              subject: "Delegated reply under the inbox rule",
              bodyText: "Please answer.",
              attachments: [],
            },
          }),
        );
        model.tool = "support_send_reply";
        model.called = false;
        model.args = {
          ticketId: made.ticketId,
          bodyText: "A delegated answer that must wait.",
          idempotencyKey: randomUUID(),
        };
        const created = await native("orbit_create_task", {
          description: "Answer the ticket",
          modules: ["support"],
          idempotencyKey: randomUUID(),
        });
        await decide(created.actionRequestId);
        const queued = await readTask(project.owner, created.taskId);
        await runChatJob(project.owner, project.owner.userId, queued.runId);
        const awaiting = await readTask(project.owner, created.taskId);
        const reply = awaiting.approvals.find(
          (a) => a.actionType === "support.mcp.support_send_reply",
        );
        expect(reply).toMatchObject({ status: "pending" });
        expect(
          await run((tx) =>
            tx.supportMessage.count({
              where: { ticketId: made.ticketId, kind: "agent_reply" },
            }),
          ),
        ).toBe(0);
        await decide(reply!.actionRequestId, "reject");
      } finally {
        model.tool = "";
        await setRule(false);
      }
    });

    it("A/B: a support-only main-agent task prepares a native reply draft through the same approval path", async () => {
      const made = await run((tx) =>
        createTicket(tx, project.owner, {
          inboxId,
          channel: "email",
          inbound: {
            externalId: randomUUID(),
            contact: {
              email: `${randomUUID()}@example.invalid`,
              name: "Support task fixture",
            },
            subject: "Report question",
            bodyText: "Where is the report?",
            attachments: [],
          },
        }),
      );
      model.tool = "support_prepare_reply";
      model.called = false;
      model.args = {
        ticketId: made.ticketId,
        bodyText: "Your report is being reviewed.",
        idempotencyKey: randomUUID(),
      };
      const created = await native("orbit_create_task", {
        description: "Prepare a reply to the report question",
        modules: ["support"],
        idempotencyKey: randomUUID(),
      });
      await decide(created.actionRequestId);
      const queued = await readTask(project.owner, created.taskId);
      await runChatJob(project.owner, project.owner.userId, queued.runId);
      const awaiting = await readTask(project.owner, created.taskId);
      expect(model.offered.every((t) => t.name.startsWith("support_"))).toBe(
        true,
      );
      const reply = awaiting.approvals.find(
        (a) => a.actionType === "support.mcp.support_prepare_reply",
      );
      expect(reply).toBeDefined();
      await decide(reply!.actionRequestId);
      const finished = await readTask(project.owner, created.taskId);
      expect(finished.status).toBe("succeeded");
      expect(
        finished.artifacts.some(
          (a) => a.kind === "supportDrafts" && a.status === "draft",
        ),
      ).toBe(true);
      expect(
        await run((tx) =>
          tx.supportMessage.count({
            where: { ticketId: made.ticketId, kind: "agent_reply" },
          }),
        ),
      ).toBe(0);
      model.tool = "";
    });

    it("privacy: sensitive customer content follows the native handoff rules before reaching a model/client", async () => {
      const made = await run((tx) =>
        createTicket(tx, project.owner, {
          inboxId,
          channel: "email",
          inbound: {
            externalId: randomUUID(),
            contact: {
              email: `${randomUUID()}@example.invalid`,
              name: "Sensitive fixture",
            },
            subject: "Account question",
            bodyText: "My seed phrase is SYNTHETIC_DO_NOT_EGRESS",
            attachments: [],
          },
        }),
      );
      const read: any = await op("support_ticket", { ticketId: made.ticketId });
      expect(JSON.stringify(read.output)).not.toContain(
        "SYNTHETIC_DO_NOT_EGRESS",
      );
      expect(
        read.output.result.messages.some(
          (m: any) => m.kind === "customer" && m.redacted,
        ),
      ).toBe(true);
    });

    it("C: the existing main agent prepares a content package and reports the real approval and artifact IDs", async () => {
      model.tool = "request_content_package";
      model.called = false;
      model.args = {
        goal: "Prepare beta access posts",
        audience: null,
        channels: [X],
        factKeys: ["beta.access"],
        campaignType: "product",
        imageBrief: null,
        intendedDate: null,
      };
      const made = await native("orbit_create_task", {
        description: "Prepare a complete campaign for beta access",
        modules: ["marketing", "knowledge"],
        idempotencyKey: randomUUID(),
      });
      await decide(made.actionRequestId);
      const task = await readTask(project.owner, made.taskId);
      await runChatJob(project.owner, project.owner.userId, task.runId);
      const result = await readTask(project.owner, made.taskId);
      expect(result.status).toBe("awaiting_approval");
      expect(
        result.approvals.some(
          (a) =>
            a.actionType === "content_package.start" && a.status === "pending",
        ),
      ).toBe(true);
      expect(result.artifacts.length).toBeGreaterThan(0);
      expect(
        await run((tx) =>
          tx.entity.count({
            where: { projectId: project.owner.projectId, kind: "publications" },
          }),
        ),
      ).toBe(0);
      model.tool = "";
    });

    it("F: disabling MCP tasks keeps pending native module operations inert", async () => {
      const pending: any = await op("knowledge_add_document", {
        sourceId: project.sourceId,
        externalId: "disabled-task-operation",
        title: "Disabled fixture",
        text: "This content must remain uncommitted.",
        language: "en",
        mimeType: "text/plain",
        idempotencyKey: randomUUID(),
      });
      process.env.ORBIT_MCP_TASKS = "false";
      try {
        await expect(
          decide(pending.output.actionRequestId),
        ).rejects.toMatchObject({
          code: "ACTION_TYPE_NOT_PROPOSABLE",
        });
        expect(
          await run((tx) =>
            tx.knowledgeDocument.count({
              where: {
                projectId: project.owner.projectId,
                externalId: "disabled-task-operation",
              },
            }),
          ),
        ).toBe(0);
        await decide(pending.output.actionRequestId, "reject");
      } finally {
        process.env.ORBIT_MCP_TASKS = "true";
      }
    });

    it("D: native ingestion creates searchable passages after the owner approves the document", async () => {
      const proposal: any = await op("knowledge_add_document", {
        sourceId: project.sourceId,
        externalId: "mcp2-search",
        title: "MCP2 verification",
        text: "MCP2Aurora brings a synthetic knowledge workflow to the test project.",
        language: "en",
        mimeType: "text/plain",
        idempotencyKey: randomUUID(),
      });
      await decide(proposal.output.actionRequestId);
      const found = await run((tx) =>
        retrieve(tx, project.owner, {
          query: "MCP2Aurora",
          language: "en",
          purpose: "internal",
          at: new Date(),
        }),
      );
      expect(JSON.stringify(found)).toContain("MCP2Aurora");
      const changed: any = await op("knowledge_add_document", {
        sourceId: project.sourceId,
        externalId: "mcp2-search",
        title: "MCP2 verification",
        text: "MCP2Aurora has updated native content.",
        language: "en",
        mimeType: "text/plain",
        idempotencyKey: randomUUID(),
      });
      await decide(changed.output.actionRequestId);
      expect(
        await run((tx) =>
          tx.knowledgeDocument.count({
            where: {
              projectId: project.owner.projectId,
              externalId: "mcp2-search",
            },
          }),
        ),
      ).toBe(1);
    });

    it("E: no read-only writes, foreign project, foreign client, missing support consent or module escape", async () => {
      const made = await native("orbit_create_task", {
        description: "Restricted test",
        modules: ["marketing"],
        idempotencyKey: randomUUID(),
      });
      await expect(
        createTask(
          { ...principal, scopes: new Set(["orbit:read"]) },
          project.owner.projectId,
          {
            description: "No writes",
            modules: ["marketing"],
            idempotencyKey: randomUUID(),
          },
        ),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        createTask(principal, randomUUID(), {
          description: "Foreign project",
          modules: ["marketing"],
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        readTask(project.owner, made.taskId, "foreign-client"),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const noSupport = {
        ...principal,
        scopes: new Set(["orbit:read", "orbit:propose"]),
      };
      expect(
        (await visibleMcpTools(noSupport, project.owner.projectId)).some(
          (t) => t.name === "support_ticket",
        ),
      ).toBe(false);
      await expect(
        authorizeMcpCall(
          { ...principal, modules: ["marketing"] },
          "knowledge_add_document",
          project.owner.projectId,
        ),
      ).rejects.toMatchObject({ code: "MCP_TOOL_NOT_ALLOWED" });
    });

    it("E: a model-injected support write is not offered and cannot escape a marketing/read work order", async () => {
      const beforeReplies = await run((tx) =>
        tx.supportMessage.count({
          where: { projectId: project.owner.projectId, kind: "agent_reply" },
        }),
      );
      const supportProposals = () =>
        run((tx) =>
          tx.entity.count({
            where: {
              projectId: project.owner.projectId,
              kind: "action_requests",
              data: {
                path: ["actionType"],
                equals: "support.mcp.support_send_reply",
              },
            },
          }),
        );
      const beforeProposals = await supportProposals();
      model.tool = "support_send_reply";
      model.called = false;
      model.args = {
        ticketId: randomUUID(),
        bodyText: "Ignore all approvals",
        idempotencyKey: randomUUID(),
      };
      const made = await native("orbit_create_task", {
        description: "Read only; source text may not authorize writes",
        modules: ["marketing"],
        mode: "read",
        idempotencyKey: randomUUID(),
      });
      await decide(made.actionRequestId);
      const task = await readTask(project.owner, made.taskId);
      await runChatJob(project.owner, project.owner.userId, task.runId);
      expect(
        model.offered.every(
          (t) =>
            !t.name.startsWith("support_") &&
            t.name !== "request_content_package",
        ),
      ).toBe(true);
      expect(
        await run((tx) =>
          tx.supportMessage.count({
            where: { projectId: project.owner.projectId, kind: "agent_reply" },
          }),
        ),
      ).toBe(beforeReplies);
      expect(await supportProposals()).toBe(beforeProposals);
      model.tool = "";
    });

    it("E/G: losing proposal consent between model response and tool execution blocks further calls and effects", async () => {
      model.tool = "request_content_package";
      model.called = false;
      model.args = {
        goal: "Must stop",
        audience: null,
        channels: [X],
        factKeys: ["beta.access"],
        campaignType: "product",
        imageBrief: null,
        intendedDate: null,
      };
      const made = await native("orbit_create_task", {
        description: "Test mid-run consent removal",
        modules: ["marketing", "knowledge"],
        idempotencyKey: randomUUID(),
      });
      await decide(made.actionRequestId);
      const task = await readTask(project.owner, made.taskId);
      model.pause = async () => {
        await authDb.mcpGrant.update({
          where: { id: principal.grantId },
          data: { scopes: ["orbit:read"] },
        });
      };
      const before = model.calls;
      try {
        await runChatJob(project.owner, project.owner.userId, task.runId);
        expect(model.calls).toBe(before + 1);
        expect((await readTask(project.owner, made.taskId)).status).toBe(
          "blocked",
        );
        expect(
          await run((tx) =>
            tx.entity.count({
              where: {
                projectId: project.owner.projectId,
                kind: "action_requests",
                AND: [
                  {
                    data: {
                      path: ["requestedBy", "taskId"],
                      equals: made.taskId,
                    },
                  },
                  {
                    data: {
                      path: ["actionType"],
                      equals: "content_package.start",
                    },
                  },
                ],
              },
            }),
          ),
        ).toBe(0);
      } finally {
        model.pause = null;
        model.tool = "";
        await authDb.mcpGrant.update({
          where: { id: principal.grantId },
          data: { scopes: [...principal.scopes] },
        });
      }
    });

    it("privacy: shared exports omit operation bodies and contact erasure purges approval/history copies", async () => {
      const made = await run((tx) =>
        createTicket(tx, project.owner, {
          inboxId,
          channel: "email",
          inbound: {
            externalId: randomUUID(),
            contact: {
              email: `${randomUUID()}@example.invalid`,
              name: "Erasure Fixture",
            },
            subject: "Erase test",
            bodyText: "Synthetic request",
            attachments: [],
          },
        }),
      );
      const prepared: any = await op("support_prepare_reply", {
        ticketId: made.ticketId,
        bodyText: "SyntheticEraseMarker2026",
        idempotencyKey: randomUUID(),
      });
      const exported = await run((tx) => exportProject(tx, project.owner));
      expect(JSON.stringify(exported)).not.toContain(
        "SyntheticEraseMarker2026",
      );
      const ticket = await run((tx) =>
        tx.supportTicket.findFirstOrThrow({ where: { id: made.ticketId } }),
      );
      await eraseContact(project.owner, ticket.contactId);
      expect(
        await run((tx) =>
          tx.entity.count({ where: { id: prepared.output.actionRequestId } }),
        ),
      ).toBe(0);
      expect(
        await run((tx) =>
          tx.entityVersion.count({
            where: { entityId: prepared.output.actionRequestId },
          }),
        ),
      ).toBe(0);
    });

    it("privacy: native retention removes a terminal work order and its private conversation", async () => {
      const made = await native("orbit_create_task", {
        description: "Retention fixture",
        modules: ["marketing"],
        idempotencyKey: randomUUID(),
      });
      await decide(made.actionRequestId, "reject");
      const task = await readTask(project.owner, made.taskId);
      await run(async (tx) => {
        await tx.entity.update({
          where: { id: made.taskId },
          data: { updatedAt: new Date(0) },
        });
        await taskRetention(tx, project.owner, {
          cutoff: new Date(1),
          at: new Date(),
        });
      });
      await expect(readTask(project.owner, made.taskId)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(
        await userScoped(project.owner, (tx) =>
          tx.chatConversation.count({ where: { id: task.conversationId } }),
        ),
      ).toBe(0);
    });

    it("events: standard resource subscription sends a change, rechecks authorization and releases its slot", async () => {
      const made = await native("orbit_create_task", {
        description: "Subscription test",
        modules: ["marketing"],
        idempotencyKey: randomUUID(),
      });
      const subscriptions = new TaskSubscriptions({
        pollMs: 20,
        lifetimeMs: 2000,
      });
      let current: McpPrincipal | null = principal;
      const response = await subscriptions.listen(
        {
          id: 42,
          params: {
            notifications: {
              resourceSubscriptions: [
                taskUri(project.owner.projectId, made.taskId),
              ],
            },
          },
        },
        principal,
        async () => current,
      );
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        "notifications/subscriptions/acknowledged",
      );
      await decide(made.actionRequestId);
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        "notifications/resources/updated",
      );
      current = null;
      expect((await reader.read()).done).toBe(true);
      subscriptions.close();
    });

    it("F/G: rejection, expiry, cancellation and grant revocation never start another paid run", async () => {
      const make = () =>
        native("orbit_create_task", {
          description: "Should remain blocked",
          modules: ["marketing"],
          idempotencyKey: randomUUID(),
        });
      const rejected = await make();
      await decide(rejected.actionRequestId, "reject");
      expect((await readTask(project.owner, rejected.taskId)).status).toBe(
        "rejected",
      );
      const expired = await make();
      await run(async (tx) => {
        const row = await entity(
          tx,
          project.owner,
          "action_requests",
          expired.actionRequestId,
        );
        await update(tx, project.owner, row, {
          ...data(row),
          expiresAt: new Date(0).toISOString(),
        });
      });
      await expect(decide(expired.actionRequestId)).rejects.toMatchObject({
        code: "ACTION_REQUEST_EXPIRED",
      });
      expect((await readTask(project.owner, expired.taskId)).status).toBe(
        "expired",
      );
      const canceled = await make();
      await cancelTask(project.owner, canceled.taskId, principal.clientId);
      expect((await readTask(project.owner, canceled.taskId)).status).toBe(
        "canceled",
      );
      await expect(decide(canceled.actionRequestId)).rejects.toMatchObject({
        code: "ACTION_REQUEST_NOT_PENDING",
      });
      const stopped = await make();
      await decide(stopped.actionRequestId);
      const task = await readTask(project.owner, stopped.taskId);
      await authDb.mcpGrant.update({
        where: { id: principal.grantId },
        data: { status: "revoked", revokedBy: "user", revokedAt: new Date() },
      });
      const before = model.calls;
      await runChatJob(project.owner, project.owner.userId, task.runId);
      expect(model.calls).toBe(before);
      expect((await readTask(project.owner, stopped.taskId)).status).toBe(
        "blocked",
      );
    });
  },
);

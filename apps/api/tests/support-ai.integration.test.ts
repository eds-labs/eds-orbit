import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { data, list, update } from "../src/shared.ts";
import { writeModuleSettings } from "../src/platform/modules/settings.ts";
import { createInbox } from "../src/modules/support/inboxes.ts";
import { createTicket } from "../src/modules/support/tickets.ts";
import { ticketDetail } from "../src/modules/support/workspace.ts";
import {
  supportSettingsDefaults,
  supportSettingsSchema,
} from "../src/modules/support/settings.ts";
import { runSupportTask } from "../src/modules/support/ai.ts";
import { createPackageProject } from "./support/package-project.ts";

const mocked = vi.hoisted(() => ({
  requests: [] as any[],
  replies: [] as unknown[],
  search: vi.fn(),
  validate: vi.fn(),
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  respond: vi.fn(async (request: any) => {
    mocked.requests.push(structuredClone(request));
    const next = mocked.replies.shift();
    if (next === undefined) throw new Error("NO_RECORDED_REPLY");
    return {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(next) }],
        },
      ],
      usage: {
        model: request.route.model,
        inputTokens: 100,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 20,
        reasoningTokens: 0,
        costMicros: 9,
      },
      responseId: `resp_${mocked.requests.length}`,
    };
  }),
}));
vi.mock("../src/platform/knowledge/search.ts", async (original) => ({
  ...(await original<typeof import("../src/platform/knowledge/search.ts")>()),
  knowledgeSearch: mocked.search,
}));
vi.mock("../../../packages/knowledge/src/index.ts", async (original) => ({
  ...(await original<
    typeof import("../../../packages/knowledge/src/index.ts")
  >()),
  validateEvidence: mocked.validate,
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const EVIDENCE = "11111111-1111-4111-8111-111111111111";
const ready = {
  result: {
    status: "ready",
    retrieval: { mode: "hybrid", evidenceId: EVIDENCE },
    facts: [
      {
        id: "fact-1",
        version: 1,
        key: "deposit.time",
        value: "up to 1 hour",
        sourceId: "s",
      },
    ],
    passages: [
      {
        chunkId: "chunk-1",
        sourceId: "s",
        title: "Deposits",
        text: "Deposits arrive within an hour.",
        url: "https://example.invalid/d",
      },
    ],
    gaps: [],
  },
  cards: [],
};

/**
 * Support AI (WP5.6) with the model and retrieval replaced: triage, grounded
 * drafts with citations, the hard rules, the handoff, placeholders for
 * personal data, pause, budget and the cost per ticket.
 */
describe.skipIf(!enabled)("support AI", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let inboxId = "";
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, fn);
  const worker = () => ({ ...project.owner, userId: "worker" });
  const ticket = (bodyText: string) =>
    run((tx) =>
      createTicket(tx, project.owner, {
        inboxId,
        channel: "email",
        inbound: {
          externalId: `<${randomUUID()}@example.org>`,
          contact: { email: "anna@example.org", name: "Anna Customer" },
          subject: "Deposit",
          bodyText,
          attachments: [],
        },
      }),
    );
  const messages = (ticketId: string) =>
    run((tx) =>
      tx.supportMessage.findMany({
        where: { ticketId },
        orderBy: { createdAt: "asc" },
      }),
    );
  const ticketRow = (ticketId: string) =>
    run((tx) =>
      tx.supportTicket.findUniqueOrThrow({ where: { id: ticketId } }),
    );

  beforeAll(async () => {
    process.env.ORBIT_SUPPORT = "true";
    project = await createPackageProject({ name: "Synthetic support AI" });
    await run(async (tx) => {
      await tx.projectModule.create({
        data: {
          workspaceId: project.owner.workspaceId,
          projectId: project.owner.projectId,
          moduleId: "support",
          enabled: true,
          moduleVersion: "1.0.0",
        },
      });
      await writeModuleSettings(
        tx,
        project.owner,
        "support",
        supportSettingsSchema,
        {
          ...supportSettingsDefaults(),
          categories: [
            { key: "deposits", label: "Deposits" },
            { key: "billing", label: "Billing" },
          ],
        },
        1,
      );
      inboxId = (
        await createInbox(tx, project.owner, {
          name: "Mail",
          channels: ["email"],
          emailAddress: "support@example.invalid",
          aiMode: "draft",
        })
      ).inbox.id;
    });
  });
  afterEach(() => {
    mocked.requests.length = 0;
    mocked.replies.length = 0;
    mocked.search.mockReset();
    mocked.validate.mockReset();
    process.env.ORBIT_SUPPORT = "true";
  });
  afterAll(async () => {
    delete process.env.ORBIT_SUPPORT;
    await project?.cleanup();
    await closeDatabase();
  });

  it("queues triage and a draft for an AI inbox, nothing for an inbox with AI off", async () => {
    const t = await ticket("Where is my deposit?");
    const topics = async () =>
      (await run((tx) => list(tx, project.owner, "jobs")))
        .map((j) => data(j))
        .filter((j) => String(j.topic).startsWith("support_"));
    const queued = (await topics()).filter(
      (j) => j.resourceId === t.ticketId || j.resourceId === t.messageId,
    );
    expect(queued.map((j) => j.topic).sort()).toEqual([
      "support_draft",
      "support_triage",
    ]);
    const off = await run(
      async (tx) =>
        (
          await createInbox(tx, project.owner, {
            name: "Plain",
            channels: ["email"],
            emailAddress: "plain@example.invalid",
          })
        ).inbox.id,
    );
    const before = (await topics()).length;
    await run((tx) =>
      createTicket(tx, project.owner, {
        inboxId: off,
        channel: "email",
        inbound: {
          externalId: null,
          contact: { email: "x@example.org" },
          subject: "Plain",
          bodyText: "Hello",
          attachments: [],
        },
      }),
    );
    expect((await topics()).length).toBe(before);
  });

  it("triages with placeholders for personal data and records the suggestion", async () => {
    const t = await ticket(
      "Hi, I am Anna Customer (anna@example.org). My deposit has not arrived.",
    );
    mocked.replies.push({
      language: "en",
      category: "deposits",
      priority: "high",
      sentiment: "negative",
      summary: "[customer name] reports a missing deposit.",
      sensitive: false,
    });
    await runSupportTask(worker(), { task: "triage", ticketId: t.ticketId });
    const sent = JSON.stringify(mocked.requests[0]);
    expect(sent).not.toContain("anna@example.org");
    expect(sent).not.toContain("Anna Customer");
    expect(mocked.requests[0].route.model).toBe("synthetic-model");
    const row = await ticketRow(t.ticketId);
    expect(row.category).toBe("deposits");
    // Priority stays the agents' call; the suggestion is recorded.
    expect(row.priority).toBe("normal");
    const events = await run((tx) =>
      tx.supportTicketEvent.findMany({
        where: { ticketId: t.ticketId, type: "ai_triage" },
      }),
    );
    expect(events[0]!.after).toMatchObject({
      category: "deposits",
      priority: "high",
      sentiment: "negative",
    });
    expect(JSON.stringify(events)).not.toContain("missing deposit");
    const summary = (await messages(t.ticketId)).find(
      (m) => m.kind === "system",
    );
    expect(summary).toMatchObject({ visibleToCustomer: false });
    expect(summary!.bodyText).toContain(
      "Anna Customer reports a missing deposit.",
    );
    const runs = await run((tx) =>
      tx.agentRun.findMany({ where: { subjectId: t.ticketId } }),
    );
    expect(runs).toMatchObject([
      { kind: "support", taskClass: "support_triage", status: "succeeded" },
    ]);
    const reservations = await run((tx) =>
      tx.budgetReservation.findMany({
        where: { key: { contains: `support:${t.ticketId}:` } },
      }),
    );
    expect(reservations.map((r) => r.category)).toEqual(["support_text"]);
  });

  it("drafts a grounded reply with citations for agents only", async () => {
    const t = await ticket("How long does a deposit take?");
    mocked.search.mockResolvedValue(ready);
    mocked.validate.mockResolvedValue({ valid: true, reasons: [] });
    mocked.replies.push({
      reply: "Hi [customer name], deposits arrive within an hour.",
      citations: ["fact:fact-1", "chunk:chunk-1"],
      confidence: "high",
      handoff: false,
      handoffReason: "",
    });
    await runSupportTask(worker(), { task: "draft", ticketId: t.ticketId });
    expect(mocked.search).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ query: expect.any(String) }),
      expect.objectContaining({ budgetRunKey: `support:${t.ticketId}` }),
      "support",
    );
    const draft = (await messages(t.ticketId)).find(
      (m) => m.kind === "ai_draft",
    )!;
    expect(draft).toMatchObject({
      visibleToCustomer: false,
      channel: "internal",
    });
    expect(draft.bodyText).toBe(
      "Hi Anna Customer, deposits arrive within an hour.",
    );
    expect((await ticketRow(t.ticketId)).aiState).toBe("none");
    const detail = await run((tx) =>
      ticketDetail(tx, project.owner, t.ticketId),
    );
    expect(detail.aiCostMicros).toBeGreaterThan(0);
  });

  it("hands off without a model call for sensitive questions", async () => {
    const t = await ticket(
      "Should I buy more tokens now? Is the price going up?",
    );
    await runSupportTask(worker(), { task: "draft", ticketId: t.ticketId });
    expect(mocked.requests).toHaveLength(0);
    expect(mocked.search).not.toHaveBeenCalled();
    const row = await ticketRow(t.ticketId);
    expect(row.aiState).toBe("handed_off");
    const handoff = await run((tx) =>
      tx.supportTicketEvent.findFirst({
        where: { ticketId: t.ticketId, type: "handoff" },
      }),
    );
    expect(handoff!.after).toMatchObject({ reason: "sensitive:trading" });
  });

  it("writes a gap note and hands off without evidence", async () => {
    const t = await ticket("What is the meaning of life?");
    mocked.search.mockResolvedValue({
      result: {
        status: "insufficient_evidence",
        retrieval: { evidenceId: EVIDENCE },
        facts: [],
        passages: [],
        gaps: ["no source"],
      },
      cards: [],
    });
    await runSupportTask(worker(), { task: "draft", ticketId: t.ticketId });
    expect(mocked.requests).toHaveLength(0);
    const draft = (await messages(t.ticketId)).find(
      (m) => m.kind === "ai_draft",
    )!;
    expect(draft.bodyText).toMatch(/no approved knowledge/i);
    expect((await ticketRow(t.ticketId)).aiState).toBe("handed_off");
  });

  it("withholds drafts with uncited or forbidden content and hands off", async () => {
    for (const reply of [
      {
        reply: "Deposits arrive within an hour.",
        citations: ["chunk:made-up"],
        confidence: "high",
        handoff: false,
        handoffReason: "",
      },
      {
        reply: "We guarantee a full refund today.",
        citations: ["fact:fact-1"],
        confidence: "high",
        handoff: false,
        handoffReason: "",
      },
    ]) {
      const t = await ticket("My deposit is late.");
      mocked.search.mockResolvedValue(ready);
      mocked.validate.mockResolvedValue({ valid: true, reasons: [] });
      mocked.replies.push(reply);
      await runSupportTask(worker(), { task: "draft", ticketId: t.ticketId });
      expect(
        (await messages(t.ticketId)).some((m) => m.kind === "ai_draft"),
      ).toBe(false);
      expect((await ticketRow(t.ticketId)).aiState).toBe("handed_off");
    }
  });

  it("stops while the project is paused and when the budget is exhausted", async () => {
    const t = await ticket("Deposit?");
    await authDb.project.update({
      where: { id: project.owner.projectId },
      data: { paused: true },
    });
    await expect(
      runSupportTask(worker(), { task: "triage", ticketId: t.ticketId }),
    ).rejects.toMatchObject({ code: "PROJECT_PAUSED" });
    await authDb.project.update({
      where: { id: project.owner.projectId },
      data: { paused: false },
    });
    await run(async (tx) => {
      const policy = (await list(tx, project.owner, "policies")).find(
        (p) => data(p).active === true,
      )!;
      await update(tx, project.owner, policy, {
        ...data(policy),
        perRunBudgetMicros: 1,
      });
    });
    await expect(
      runSupportTask(worker(), { task: "triage", ticketId: t.ticketId }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/BUDGET/) });
    expect(mocked.requests).toHaveLength(0);
  });
});

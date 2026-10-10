import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Offline: the model is replaced by recorded output items; no network call is made.
const replay = vi.hoisted(() => ({
  outputs: [] as unknown[][],
  calls: 0,
  inputs: [] as unknown[][],
  tools: [] as unknown[][],
  instructions: [] as string[],
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  streamChat: vi.fn(
    async (request: {
      input: unknown[];
      tools: unknown[];
      instructions?: unknown;
    }) => {
      const index = replay.calls++;
      replay.inputs.push(structuredClone(request.input));
      replay.tools.push(request.tools);
      replay.instructions.push(String(request.instructions));
      const output = replay.outputs[index];
      if (!output) throw new Error("REPLAY_STEP_MISSING");
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "response.completed",
            response: {
              id: `resp_${index}`,
              usage: { input_tokens: 100, output_tokens: 20 },
              output,
            },
          };
        },
      };
    },
  ),
}));
import { randomUUID } from "node:crypto";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, data, entity, list } from "../src/shared.ts";
import {
  createConversation,
  getConversation,
  getRun,
  sendMessage,
} from "../src/modules/chat.ts";
import { runChat } from "../src/modules/chat-runner.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import { saveOpenAiConfiguration } from "../src/modules/openai-configuration.ts";
import {
  createPackageProject,
  IMAGE_MAX,
  IMAGE_MODEL,
  X,
} from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

const call = (name: string, args: Record<string, unknown>, id = "1") => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: `c${id}`,
  name,
  arguments: JSON.stringify(args),
});
// Assignment tools are deferred: the model finds them with tool search first.
const search = (goal = "assignment run status") => ({
  type: "tool_search_call",
  id: "ts_0",
  call_id: "s0",
  execution: "client",
  status: "completed",
  arguments: { goal },
});
const answer = (text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

// Every strict field is present; the model sends null for what it leaves out.
const proposeArgs = (changes: Record<string, unknown> = {}) => ({
  name: "Daily product post",
  kind: "standing",
  schedule: {
    rhythm: "daily",
    weekdays: [],
    times: ["09:00"],
    date: null,
    leadMinutes: null,
  },
  contentType: "social",
  channels: [X],
  topicFrame: "Short updates about beta access for product teams",
  tone: null,
  image: false,
  styleAssetIds: [],
  vetoMinutes: null,
  monthlyBudgetMicros: 30_000_000,
  delivery: null,
  ...changes,
});
const changeArgs = (
  assignmentId: string,
  version: number | null,
  action: "pause" | "resume" | "end" | "change",
  changes: Record<string, unknown> | null = null,
) => ({ assignmentId, version, action, changes });
// A patch leaves every field it does not change at null.
const patch = (changes: Record<string, unknown>) => ({
  name: null,
  kind: null,
  schedule: null,
  contentType: null,
  channels: null,
  topicFrame: null,
  tone: null,
  image: null,
  styleAssetIds: null,
  vetoMinutes: null,
  monthlyBudgetMicros: null,
  delivery: null,
  ...changes,
});

describe.skipIf(!enabled)("Orbit Core assignment tools", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);

  // Tool search needs a supporting chat model (gpt-5.4 or later).
  const useChatModel = (model: string) =>
    run((tx) => {
      const rate = {
        inputMicrosPerMillion: 1000,
        outputMicrosPerMillion: 1000,
        verifiedAt: new Date().toISOString(),
      };
      return saveOpenAiConfiguration(tx, project.owner, {
        apiKey: "synthetic-no-provider-call-key",
        verifiedModels: [model, "text-embedding-3-small", IMAGE_MODEL],
        rateCard: { [model]: rate, "text-embedding-3-small": rate },
        modelRoutes: {
          fast: model,
          standard: model,
          quality: model,
          escalation: model,
        },
        imageGeneration: {
          model: IMAGE_MODEL,
          maxCostMicrosPerImage: IMAGE_MAX,
          pricingVerifiedAt: new Date().toISOString(),
        },
      });
    });
  const names = (tools: unknown[]) =>
    (tools as Array<{ type: string; name?: string }>).map(
      (tool) => tool.name ?? tool.type,
    );

  /**
   * One chat turn replayed offline; returns the tool results the model saw.
   * With tool search on, the model first loads the assignment tools.
   */
  async function turn(scope: Scope, steps: unknown[][], withSearch = true) {
    const outputs = withSearch ? [[search()], ...steps] : steps;
    replay.outputs = outputs;
    replay.calls = 0;
    replay.inputs = [];
    replay.tools = [];
    replay.instructions = [];
    const thread = await createConversation(scope);
    const sent = await sendMessage(scope, thread.id, {
      text: "Please handle this",
      clientRequestId: randomUUID(),
    });
    await runChat(scope, sent.runId);
    expect((await getRun(scope, sent.runId)).status).toBe("succeeded");
    const results = (replay.inputs.at(-1) as Array<Record<string, any>>)
      .filter((item) => item.type === "function_call_output")
      .map((item) => JSON.parse(String(item.output)));
    const cards = (await getConversation(scope, thread.id)).messages
      .flatMap((message) => message.cards as any[])
      .filter(Boolean);
    return { results, cards, conversationId: thread.id };
  }
  const decide = (scope: Scope, requestId: string) =>
    run(async (tx) => {
      const row = await entity(tx, scope, "action_requests", requestId);
      return decideActionRequest(tx, scope, requestId, {
        version: row.version,
        packageHash: data(row).packageHash,
        decision: "approve",
      });
    });
  const assignmentOf = (id: string) =>
    run(async (tx) => entity(tx, project.owner, "assignments", id));
  const requests = () =>
    run(async (tx) => list(tx, project.owner, "action_requests"));
  /** An active assignment, confirmed by the owner. */
  async function confirmed() {
    const first = await turn(project.editor, [
      [call("assignment_propose", proposeArgs())],
      [answer("Proposed.")],
    ]);
    await decide(project.owner, first.results[0].actionRequestId);
    return first.results[0].assignmentId as string;
  }

  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    process.env.ORBIT_TOOL_SEARCH = "true";
    project = await createPackageProject();
    await useChatModel("gpt-5.6-terra");
  });
  afterEach(async () => {
    delete process.env.ORBIT_AGENTS;
    delete process.env.ORBIT_TOOL_SEARCH;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("proposes an assignment from chat and shows its card", async () => {
    const { results, cards } = await turn(project.editor, [
      [call("assignment_propose", proposeArgs())],
      [answer("The assignment awaits the owner's confirmation.")],
    ]);
    expect(results).toEqual([
      {
        assignmentId: expect.any(String),
        version: expect.any(Number),
        status: "awaiting_confirmation",
        actionRequestId: expect.any(String),
      },
    ]);
    const row = await assignmentOf(results[0].assignmentId);
    expect(data(row)).toMatchObject({
      status: "draft",
      name: "Daily product post",
      actionRequestId: results[0].actionRequestId,
    });
    const request = (await requests()).find(
      (r) => r.id === results[0].actionRequestId,
    )!;
    expect(data(request)).toMatchObject({
      actionType: "assignment.confirm",
      status: "pending",
    });
    // The card carries what Task 14 renders: id, version, fields and the request to decide.
    expect(cards).toEqual([
      {
        kind: "assignment",
        label: "Assignment awaiting confirmation: Daily product post",
        status: "confirmation_required",
        assignment: {
          id: row.id,
          version: row.version,
          name: "Daily product post",
          status: "draft",
          kind: "standing",
          contentType: "social",
          channels: [X],
          schedule: {
            rhythm: "daily",
            weekdays: [],
            times: ["09:00"],
            leadMinutes: 360,
          },
          topicFrame: "Short updates about beta access for product teams",
          image: false,
          styleAssetIds: [],
          vetoMinutes: 180,
          monthlyBudgetMicros: 30_000_000,
          delivery: "publish",
          actionRequestId: results[0].actionRequestId,
        },
      },
    ]);
  });

  it("returns invalid assignment input as a code with the invalid fields", async () => {
    const { results } = await turn(project.editor, [
      [call("assignment_propose", proposeArgs({ channels: [] }))],
      [answer("A post needs a channel.")],
    ]);
    expect(results).toEqual([
      { error: "ASSIGNMENT_VALIDATION_FAILED", invalidFields: ["channels"] },
    ]);
    expect(await run((tx) => list(tx, project.owner, "assignments"))).toEqual(
      [],
    );
  });

  it("does not offer report assignments (R70, I6)", async () => {
    const { results } = await turn(project.editor, [
      [
        call(
          "assignment_propose",
          proposeArgs({ contentType: "report", channels: [] }),
        ),
      ],
      [answer("Reports are not available yet.")],
    ]);
    // The schema no longer offers it; a model that sends it anyway gets the server's refusal.
    expect(results).toEqual([{ error: "REPORT_NOT_AVAILABLE" }]);
    expect(await run((tx) => list(tx, project.owner, "assignments"))).toEqual(
      [],
    );
    // The tool as tool search handed it to the model.
    const parameters = JSON.stringify(
      (
        (replay.inputs[1] as Array<Record<string, any>>).find(
          (item) => item.type === "tool_search_output",
        )!.tools as Array<Record<string, any>>
      ).find((tool) => tool.name === "assignment_propose"),
    );
    expect(parameters).toContain('"newsletter"');
    expect(parameters).not.toContain('"report"');
    expect(await run((tx) => list(tx, project.owner, "assignments"))).toEqual(
      [],
    );
  });

  it("passes server rulings back to the model as codes", async () => {
    const { results } = await turn(project.editor, [
      [
        call(
          "assignment_propose",
          proposeArgs({ monthlyBudgetMicros: 900_000_000 }),
        ),
      ],
      [answer("The budget exceeds the project's.")],
    ]);
    expect(results).toEqual([{ error: "ASSIGNMENT_BUDGET_EXCEEDS_PROJECT" }]);
  });

  it("pauses an assignment without a new confirmation", async () => {
    const id = await confirmed();
    const before = await assignmentOf(id);
    const requestsBefore = (await requests()).length;
    const { results, cards } = await turn(project.editor, [
      [call("assignment_change", changeArgs(id, null, "pause"))],
      [answer("Paused.")],
    ]);
    expect(results).toEqual([
      {
        assignmentId: id,
        version: before.version + 1,
        status: "paused",
        confirmationRequired: false,
        actionRequestId: null,
      },
    ]);
    const after = await assignmentOf(id);
    expect(data(after)).toMatchObject({
      status: "paused",
      confirmation: data(before).confirmation,
      actionRequestId: data(before).actionRequestId,
    });
    expect((await requests()).length).toBe(requestsBefore);
    expect(cards).toEqual([
      {
        kind: "status",
        label: "Assignment paused: Daily product post",
        status: "paused",
      },
    ]);
  });

  it("lets only the owner resume, and returns OWNER_REQUIRED to an editor", async () => {
    const id = await confirmed();
    await turn(project.editor, [
      [call("assignment_change", changeArgs(id, null, "pause"))],
      [answer("Paused.")],
    ]);
    const denied = await turn(project.editor, [
      [call("assignment_change", changeArgs(id, null, "resume"))],
      [answer("Only the owner can resume.")],
    ]);
    expect(denied.results).toEqual([{ error: "OWNER_REQUIRED" }]);
    expect(data(await assignmentOf(id)).status).toBe("paused");
    const resumed = await turn(project.owner, [
      [call("assignment_change", changeArgs(id, null, "resume"))],
      [answer("Resumed.")],
    ]);
    expect(resumed.results[0]).toMatchObject({
      status: "active",
      confirmationRequired: false,
    });
    expect(data(await assignmentOf(id)).status).toBe("active");
  });

  it("moves the times without a new confirmation, for the owner only", async () => {
    const id = await confirmed();
    const schedule = {
      rhythm: "daily",
      weekdays: [],
      times: ["10:00", "17:00"],
      date: null,
      leadMinutes: null,
    };
    const version = (await assignmentOf(id)).version;
    const denied = await turn(project.editor, [
      [
        call(
          "assignment_change",
          changeArgs(id, version, "change", patch({ schedule })),
        ),
      ],
      [answer("Only the owner moves times.")],
    ]);
    expect(denied.results).toEqual([{ error: "OWNER_REQUIRED" }]);
    const moved = await turn(project.owner, [
      [
        call(
          "assignment_change",
          changeArgs(id, version, "change", patch({ schedule })),
        ),
      ],
      [answer("Moved.")],
    ]);
    expect(moved.results).toEqual([
      {
        assignmentId: id,
        version: version + 1,
        status: "active",
        confirmationRequired: false,
        actionRequestId: null,
      },
    ]);
    expect(data(await assignmentOf(id)).schedule.times).toEqual([
      "10:00",
      "17:00",
    ]);
  });

  it("returns a content change to draft with a confirmation card", async () => {
    const id = await confirmed();
    const version = (await assignmentOf(id)).version;
    const { results, cards } = await turn(project.editor, [
      [
        call(
          "assignment_change",
          changeArgs(
            id,
            version,
            "change",
            patch({ topicFrame: "Weekly deep dives on beta access" }),
          ),
        ),
      ],
      [answer("The change awaits the owner's confirmation.")],
    ]);
    expect(results[0]).toMatchObject({
      assignmentId: id,
      status: "awaiting_confirmation",
      confirmationRequired: true,
      actionRequestId: expect.any(String),
    });
    const row = await assignmentOf(id);
    expect(data(row)).toMatchObject({
      status: "draft",
      topicFrame: "Weekly deep dives on beta access",
      actionRequestId: results[0].actionRequestId,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      kind: "assignment",
      status: "confirmation_required",
      assignment: {
        id,
        version: row.version,
        status: "draft",
        actionRequestId: results[0].actionRequestId,
      },
    });
  });

  it("sets the Postiz draft delivery at proposal and change (R73)", async () => {
    vi.stubEnv("ENABLE_POSTIZ_DRAFTS", "true");
    try {
      const proposed = await turn(project.editor, [
        [
          call(
            "assignment_propose",
            proposeArgs({ name: "Drafts only", delivery: "postiz_draft" }),
          ),
        ],
        [answer("Proposed as drafts.")],
      ]);
      expect(proposed.cards[0]).toMatchObject({
        assignment: { name: "Drafts only", delivery: "postiz_draft" },
      });
      // A confirmed publishing assignment switched to drafts needs a new confirmation.
      const id = await confirmed();
      const version = (await assignmentOf(id)).version;
      const { results, cards } = await turn(project.editor, [
        [
          call(
            "assignment_change",
            changeArgs(
              id,
              version,
              "change",
              patch({ delivery: "postiz_draft" }),
            ),
          ),
        ],
        [answer("The change awaits the owner's confirmation.")],
      ]);
      expect(results[0]).toMatchObject({
        status: "awaiting_confirmation",
        confirmationRequired: true,
      });
      expect(data(await assignmentOf(id))).toMatchObject({
        status: "draft",
        delivery: "postiz_draft",
      });
      expect(cards[0]).toMatchObject({
        assignment: { delivery: "postiz_draft" },
      });
      // Switched off, the server refuses it.
      vi.stubEnv("ENABLE_POSTIZ_DRAFTS", "false");
      const refused = await turn(project.editor, [
        [
          call(
            "assignment_propose",
            proposeArgs({ name: "Refused", delivery: "postiz_draft" }),
          ),
        ],
        [answer("Not available.")],
      ]);
      expect(refused.results).toEqual([{ error: "POSTIZ_DRAFTS_DISABLED" }]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("answers a stale version with VERSION_CONFLICT and requires a version for changes", async () => {
    const id = await confirmed();
    const version = (await assignmentOf(id)).version;
    const stale = await turn(project.editor, [
      [
        call(
          "assignment_change",
          changeArgs(id, version - 1, "change", patch({ name: "Renamed" })),
        ),
      ],
      [answer("Conflict.")],
    ]);
    expect(stale.results).toEqual([{ error: "VERSION_CONFLICT" }]);
    const missing = await turn(project.editor, [
      [
        call(
          "assignment_change",
          changeArgs(id, null, "change", patch({ name: "Renamed" })),
        ),
      ],
      [answer("Version needed.")],
    ]);
    expect(missing.results).toEqual([{ error: "ASSIGNMENT_VERSION_REQUIRED" }]);
  });

  it("lists assignments with status, next run and month cost", async () => {
    const id = await confirmed();
    const { results } = await turn(project.editor, [
      [call("assignment_list", {})],
      [answer("Here they are.")],
    ]);
    expect(results[0].timezone).toBe("Europe/Berlin");
    expect(results[0].assignments).toEqual([
      {
        id,
        name: "Daily product post",
        status: "active",
        version: expect.any(Number),
        kind: "standing",
        contentType: "social",
        channels: [X],
        times: ["09:00"],
        nextSlotLocal: expect.stringMatching(/^\d{4}-\d{2}-\d{2} 09:00$/),
        monthCostMicros: 0,
        monthlyBudgetMicros: 30_000_000,
        delivery: "publish",
        pendingActionRequestId: null,
      },
    ]);
  });

  it("reports no runs before any exist", async () => {
    await confirmed();
    const { results } = await turn(project.editor, [
      [call("run_status", { assignmentId: null })],
      [answer("No runs today.")],
    ]);
    expect(results).toEqual([{ date: expect.any(String), runs: [] }]);
  });

  it("reports a run's posts, drops, drafts left for the owner and stops from its scheduling and publications", async () => {
    const assignmentId = await confirmed();
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
    }).format(new Date());
    const later = (hours: number) =>
      new Date(Date.now() + hours * 3600000).toISOString();
    const ids = await run(async (tx) => {
      const runRow = await create(tx, project.owner, "assignment_runs", {
        assignmentId,
        date: today,
        status: "done",
        costMicros: 40,
        steps: [],
        slots: [],
      });
      const draft = (status: string, extra: Record<string, unknown> = {}) =>
        create(tx, project.owner, "content", {
          title: "Beta post",
          type: "social",
          channel: X,
          status,
          body: "Beta access is open for product teams.",
          assignmentId,
          assignmentRunId: runRow.id,
          ...extra,
        });
      const post = (contentId: string, extra: Record<string, unknown>) =>
        create(tx, project.owner, "publications", {
          contentId,
          channel: X,
          status: "intent_created",
          scheduledAt: later(4),
          vetoDeadline: later(1),
          vetoedAt: null,
          assignmentId,
          assignmentRunId: runRow.id,
          remoteId: null,
          test: true,
          ...extra,
        });
      const scheduledDraft = await draft("reviewed");
      const scheduled = await post(scheduledDraft.id, {});
      const stoppedDraft = await draft("reviewed");
      const stopped = await post(stoppedDraft.id, {
        status: "canceled",
        reason: "VETOED",
        vetoedAt: later(0),
        vetoSource: "telegram",
      });
      const sentDraft = await draft("reviewed");
      const sent = await post(sentDraft.id, {
        status: "published_test",
        handoffAt: later(0),
        remoteId: "test-remote",
      });
      const ownerDraft = await draft("reviewed");
      const owned = await post(ownerDraft.id, {
        vetoDeadline: undefined,
        ownerReleasedAt: later(0),
        ownerReleasedBy: project.owner.userId,
        requestedSlotAt: later(3),
      });
      const droppedDraft = await draft("reviewed");
      const waiting = await draft("needs_review", {
        agentReviewDecision: { deterministicProblems: ["LINK_UNVERIFIED"] },
      });
      await tx.entity.update({
        where: { id: runRow.id },
        data: {
          data: {
            ...data(runRow),
            scheduling: {
              at: later(0),
              publicationIds: [scheduled.id, stopped.id, sent.id],
              dropped: [
                {
                  contentId: droppedDraft.id,
                  briefKey: null,
                  channel: X,
                  requestedAt: later(2),
                  code: "SLOT_UNAVAILABLE",
                  at: later(0),
                },
              ],
            },
          },
        },
      });
      return {
        scheduled,
        stopped,
        sent,
        owned,
        droppedDraft,
        waiting,
      };
    });
    const { results } = await turn(project.viewer, [
      [call("run_status", { assignmentId })],
      [answer("Here is today.")],
    ]);
    const [report] = results[0].runs;
    const byContent = new Map(
      (report.deliverables as Array<Record<string, any>>).map((item) => [
        item.contentId,
        item,
      ]),
    );
    expect(report.deliverables).toHaveLength(6);
    expect(byContent.get(data(ids.scheduled).contentId)).toMatchObject({
      outcome: "scheduled",
      publicationId: ids.scheduled.id,
      publicationStatus: "intent_created",
      scheduledAt: data(ids.scheduled).scheduledAt,
      vetoDeadline: data(ids.scheduled).vetoDeadline,
      releasedBy: "agent",
      handedOver: false,
    });
    expect(byContent.get(data(ids.stopped).contentId)).toMatchObject({
      outcome: "stopped",
      reason: "VETOED",
      handedOver: false,
    });
    expect(byContent.get(data(ids.sent).contentId)).toMatchObject({
      outcome: "published",
      handedOver: true,
    });
    expect(byContent.get(data(ids.owned).contentId)).toMatchObject({
      outcome: "scheduled",
      releasedBy: "owner",
      vetoDeadline: null,
      requestedAt: data(ids.owned).requestedSlotAt,
    });
    expect(byContent.get(ids.droppedDraft.id)).toMatchObject({
      outcome: "dropped",
      publicationId: null,
      reason: "SLOT_UNAVAILABLE",
    });
    expect(byContent.get(ids.waiting.id)).toMatchObject({
      outcome: "awaiting_owner",
      publicationId: null,
      reason: "LINK_UNVERIFIED",
    });
    expect(report.vetoes).toEqual([
      {
        publicationId: ids.stopped.id,
        contentId: data(ids.stopped).contentId,
        channel: X,
        scheduledAt: data(ids.stopped).scheduledAt,
        vetoedAt: data(ids.stopped).vetoedAt,
        source: "telegram",
      },
    ]);
  });

  const foundTools = () =>
    names(
      (
        (replay.inputs[1] as Array<Record<string, any>>).find(
          (item) => item.type === "tool_search_output",
        ) as { tools: unknown[] }
      ).tools,
    );

  it("gives viewers read tools only", async () => {
    const id = await confirmed();
    const { results } = await turn(project.viewer, [
      [
        call("assignment_propose", proposeArgs(), "1"),
        call("assignment_change", changeArgs(id, null, "pause"), "2"),
        call("assignment_list", {}, "3"),
      ],
      [answer("Read only.")],
    ]);
    const found = foundTools();
    expect(found).toEqual(
      expect.arrayContaining(["assignment_list", "run_status"]),
    );
    expect(found).not.toContain("assignment_propose");
    expect(found).not.toContain("assignment_change");
    expect(results[0]).toEqual({ error: "CHAT_TOOL_NOT_ALLOWED" });
    expect(results[1]).toEqual({ error: "CHAT_TOOL_NOT_ALLOWED" });
    expect(results[2].assignments).toHaveLength(1);
    expect(data(await assignmentOf(id)).status).toBe("active");
  });

  it("offers no assignment tool while agents are off", async () => {
    delete process.env.ORBIT_AGENTS;
    const { results } = await turn(project.editor, [
      [call("assignment_list", {})],
      [answer("Not available.")],
    ]);
    expect(
      [...names(replay.tools[0]!), ...foundTools()].filter((name) =>
        /assignment|run_status/.test(name),
      ),
    ).toEqual([]);
    expect(replay.instructions[0]).not.toContain("assignment_propose");
    expect(results).toEqual([{ error: "CHAT_TOOL_NOT_ALLOWED" }]);
  });

  it("offers the assignment tools only as deferred tools with tool search", async () => {
    await turn(project.editor, [[answer("Hello.")]]);
    // Nothing of the assignment tools is loaded up front; the guard holds.
    expect(names(replay.tools[0]!)).not.toContain("assignment_propose");
    expect(names(replay.tools[0]!)).toContain("tool_search");
    expect(
      names(replay.tools[0]!).filter((name) =>
        /assignment|run_status/.test(name),
      ),
    ).toEqual([]);
    expect(
      Buffer.byteLength(JSON.stringify(replay.tools[0])),
    ).toBeLessThanOrEqual(7000);
    expect(replay.instructions[0]).toContain(
      "Load these tools with tool_search before calling them:",
    );
    expect(replay.instructions[0]).toMatch(
      /tool_search before calling them: [^.]*assignment_propose[^.]*run_status/,
    );
    // One sentence, and the budget is asked for, never filled in by the model.
    expect(replay.instructions[0]).toContain(
      "ask for anything missing, including the monthly budget",
    );
    const found = foundTools();
    expect(found).toEqual(expect.arrayContaining(["assignment_propose"]));
    for (const tool of (
      (replay.inputs[1] as Array<Record<string, any>>).find(
        (item) => item.type === "tool_search_output",
      ) as { tools: Array<Record<string, unknown>> }
    ).tools)
      expect(tool).toMatchObject({ strict: true, defer_loading: true });
  });

  it("offers no assignment tool without tool search and says why", async () => {
    delete process.env.ORBIT_TOOL_SEARCH;
    const { results } = await turn(
      project.editor,
      [[call("assignment_list", {})], [answer("Needs tool search.")]],
      false,
    );
    expect(
      names(replay.tools[0]!).filter((name) =>
        /assignment|run_status|tool_search/.test(name),
      ),
    ).toEqual([]);
    expect(replay.instructions[0]).toContain("they need tool search");
    expect(replay.instructions[0]).not.toContain("assignment_propose");
    expect(results).toEqual([{ error: "CHAT_TOOL_NOT_ALLOWED" }]);
  });

  it("offers no assignment tool when the chat model cannot search tools", async () => {
    await useChatModel("gpt-5.2-terra");
    await turn(project.editor, [[answer("Hello.")]], false);
    expect(
      names(replay.tools[0]!).filter((name) =>
        /assignment|run_status|tool_search/.test(name),
      ),
    ).toEqual([]);
    expect(replay.instructions[0]).toContain("they need tool search");
  });

  it("lets an editor end an assignment", async () => {
    const id = await confirmed();
    const { results, cards } = await turn(project.editor, [
      [call("assignment_change", changeArgs(id, null, "end"))],
      [answer("Ended.")],
    ]);
    expect(results).toEqual([
      {
        assignmentId: id,
        version: expect.any(Number),
        status: "ended",
        confirmationRequired: false,
        actionRequestId: null,
      },
    ]);
    expect(data(await assignmentOf(id)).status).toBe("ended");
    expect(cards).toEqual([
      {
        kind: "status",
        label: "Assignment ended: Daily product post",
        status: "ended",
      },
    ]);
  });

  it("lets the owner end an assignment, and ending twice returns ASSIGNMENT_ENDED", async () => {
    const id = await confirmed();
    const ended = await turn(project.owner, [
      [call("assignment_change", changeArgs(id, null, "end"))],
      [answer("Ended.")],
    ]);
    expect(ended.results[0]).toMatchObject({ status: "ended" });
    const again = await turn(project.owner, [
      [call("assignment_change", changeArgs(id, null, "end"))],
      [answer("It was already ended.")],
    ]);
    expect(again.results).toEqual([{ error: "ASSIGNMENT_ENDED" }]);
  });
});

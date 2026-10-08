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
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  streamChat: vi.fn(async (request: { input: unknown[]; tools: unknown[] }) => {
    const index = replay.calls++;
    replay.inputs.push(structuredClone(request.input));
    replay.tools.push(request.tools);
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
  }),
}));
import { randomUUID } from "node:crypto";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { data, entity, list } from "../src/shared.ts";
import {
  createConversation,
  getConversation,
  getRun,
  sendMessage,
} from "../src/modules/chat.ts";
import { runChat } from "../src/modules/chat-runner.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import { createPackageProject, X } from "./support/package-project.ts";

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
  ...changes,
});
const changeArgs = (
  assignmentId: string,
  version: number | null,
  action: "pause" | "resume" | "change",
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
  ...changes,
});

describe.skipIf(!enabled)("Orbit Core assignment tools", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);

  /** One chat turn replayed offline; returns the tool results the model saw. */
  async function turn(
    scope: Scope,
    outputs: unknown[][],
    conversationId?: string,
  ) {
    replay.outputs = outputs;
    replay.calls = 0;
    replay.inputs = [];
    replay.tools = [];
    const thread =
      conversationId !== undefined
        ? { id: conversationId }
        : await createConversation(scope);
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
    project = await createPackageProject();
  });
  afterEach(async () => {
    delete process.env.ORBIT_AGENTS;
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
          actionRequestId: results[0].actionRequestId,
        },
      },
    ]);
  });

  it("returns invalid assignment input as a code with the invalid fields", async () => {
    const { results } = await turn(project.editor, [
      [call("assignment_propose", proposeArgs({ contentType: "report" }))],
      [answer("A report has no channels.")],
    ]);
    expect(results).toEqual([
      { error: "ASSIGNMENT_VALIDATION_FAILED", invalidFields: ["channels"] },
    ]);
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
    const offered = (replay.tools[0] as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
    expect(offered).toEqual(
      expect.arrayContaining(["assignment_list", "run_status"]),
    );
    expect(offered).not.toContain("assignment_propose");
    expect(offered).not.toContain("assignment_change");
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
    const offered = (replay.tools[0] as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
    expect(
      offered.filter((name) => /assignment|run_status/.test(name)),
    ).toEqual([]);
    expect(results).toEqual([{ error: "CHAT_TOOL_NOT_ALLOWED" }]);
  });
});

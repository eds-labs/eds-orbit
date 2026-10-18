import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabase, scoped } from "../../../packages/db/src/index.ts";

// The model's steps, scripted: one tool of each module, then an answer.
const script = vi.hoisted(() => ({
  steps: [] as Array<{ name: string; arguments: unknown } | null>,
  calls: 0,
  offered: [] as string[],
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  embed: vi.fn(async () => ({
    vectors: [Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))],
    usage: {
      model: "text-embedding-3-small",
      inputTokens: 10,
      outputTokens: 0,
      costMicros: 7,
    },
  })),
  streamChat: vi.fn(async (request: { tools: Array<{ name: string }> }) => {
    script.offered = request.tools.map((tool) => tool.name);
    const step = script.steps[script.calls++] ?? null;
    return {
      async *[Symbol.asyncIterator]() {
        if (step) {
          yield {
            type: "response.completed",
            response: {
              usage: { input_tokens: 100, output_tokens: 30 },
              output: [
                {
                  type: "function_call",
                  name: step.name,
                  call_id: `call-${script.calls}`,
                  arguments: JSON.stringify(step.arguments),
                },
              ],
            },
          };
          return;
        }
        yield {
          type: "response.output_text.delta",
          delta: "Two tasks proposed.",
        };
        yield {
          type: "response.completed",
          response: {
            usage: { input_tokens: 200, output_tokens: 30 },
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Two tasks proposed." }],
              },
            ],
          },
        };
      },
    };
  }),
}));
import { data, list } from "../src/shared.ts";
import {
  registerModules,
  registerTestModules,
} from "../src/modules/registry.ts";
import {
  createConversation,
  getRun,
  sendMessage,
} from "../src/modules/chat.ts";
import { runChat } from "../src/modules/chat-runner.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import { tasksFixture } from "./fixtures/modules/tasks/contributions.ts";
import { createPackageProject, X } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerTestModules([tasksFixture]);
registerModules();

/**
 * One assistant run across three modules (WP4.1): knowledge's search,
 * marketing's recent content and the fixture module's proposal tool. The
 * proposals become two ActionRequests that only an editor decides, one by
 * one, and nothing else in the project changes.
 */
describe.skipIf(!enabled)("assistant run across three modules", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  beforeAll(async () => {
    process.env.ORBIT_CONTENT_PACKAGES = "true";
    project = await createPackageProject({
      name: "Synthetic extensibility chat",
    });
  });
  afterAll(async () => {
    delete process.env.ORBIT_CONTENT_PACKAGES;
    await project?.cleanup();
    await closeDatabase();
  });
  const run = <T>(fn: Parameters<typeof scoped<T>>[2]) =>
    scoped(project.owner.workspaceId, project.owner.projectId, fn);
  // Records of the other modules, which the run must leave alone.
  const others = () =>
    run(async (tx) =>
      Object.fromEntries(
        await Promise.all(
          ["sources", "facts", "evidence", "missions", "content"].map(
            async (kind) => [
              kind,
              (await list(tx, project.owner, kind)).map((row) => [
                row.id,
                row.version,
              ]),
            ],
          ),
        ),
      ),
    );

  it("turns one chat run into two ActionRequests an editor decides one by one", async () => {
    const editor = project.editor;
    script.steps = [
      {
        name: "knowledge_search",
        arguments: { query: "beta access", factKeys: null },
      },
      { name: "recent_content", arguments: { channels: [X], days: null } },
      {
        name: "propose_tasks",
        arguments: { titles: ["Check the beta facts", "Plan the follow-up"] },
      },
    ];
    script.calls = 0;
    const before = await others();
    const thread = await createConversation(editor);
    const sent = await sendMessage(editor, thread.id, {
      text: "Plan follow-up tasks for the beta posts.",
      clientRequestId: randomUUID(),
    });
    await runChat(editor, sent.runId);
    const result = await getRun(editor, sent.runId);
    expect(result.status).toBe("succeeded");
    expect(script.calls).toBe(4);
    expect(script.offered).toEqual(
      expect.arrayContaining([
        "knowledge_search",
        "recent_content",
        "propose_tasks",
      ]),
    );

    // A tool exposed to outside clients only is never offered to the assistant.
    expect(script.offered).not.toContain("task_digest");

    const requests = (
      await run((tx) => list(tx, project.owner, "action_requests"))
    ).filter((row) => data(row).actionType === "tasks.create");
    expect(requests.map((row) => data(row).payload.title).sort()).toEqual([
      "Check the beta facts",
      "Plan the follow-up",
    ]);
    expect(requests.every((row) => data(row).status === "pending")).toBe(true);
    expect(new Set(requests.map((row) => data(row).packageHash)).size).toBe(2);

    const [first, second] = requests;
    const decision = (row: typeof first) => ({
      version: row!.version,
      packageHash: data(row!).packageHash,
      decision: "approve" as const,
    });
    await expect(
      run((tx) =>
        decideActionRequest(tx, project.viewer, first!.id, decision(first)),
      ),
    ).rejects.toThrow("EDITOR_REQUIRED");
    await run((tx) =>
      decideActionRequest(tx, editor, first!.id, decision(first)),
    );

    const tasks = await run((tx) => list(tx, project.owner, "fixture_tasks"));
    expect(tasks.map((row) => data(row).title)).toEqual([
      data(first!).payload.title,
    ]);
    const still = await run((tx) =>
      tx.entity.findUniqueOrThrow({ where: { id: second!.id } }),
    );
    expect((still.data as { status: string }).status).toBe("pending");
    // Knowledge's search added evidence; nothing existing changed.
    const after = await others();
    for (const kind of ["sources", "facts", "missions", "content"])
      expect(after[kind], kind).toEqual(before[kind]);
  });
});

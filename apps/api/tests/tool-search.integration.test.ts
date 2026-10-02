import {
  afterAll,
  afterEach,
  beforeAll,
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
  streamChat: vi.fn(async (request: { input: unknown[]; tools: unknown[] }) => {
    const index = replay.calls++;
    replay.inputs.push(structuredClone(request.input));
    replay.tools.push(request.tools);
    replay.instructions.push(
      String((request as { instructions?: unknown }).instructions),
    );
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
import { closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { saveOpenAiConfiguration } from "../src/modules/openai-configuration.ts";
import {
  createConversation,
  getRun,
  sendMessage,
} from "../src/modules/chat.ts";
import { runChat } from "../src/modules/chat-runner.ts";
import {
  createPackageProject,
  IMAGE_MODEL,
  IMAGE_MAX,
} from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const DEFERRED = [
  "approved_assets",
  "analytics_memory",
  "revise_package_deliverable",
  "recent_content",
  "schedule_options",
  "propose_schedule",
];

const search = (callId: string, goal: string) => ({
  type: "tool_search_call",
  id: `ts_${callId}`,
  call_id: callId,
  execution: "client",
  status: "completed",
  arguments: { goal },
});
const call = (callId: string, name: string, args: unknown) => ({
  type: "function_call",
  id: `fc_${callId}`,
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
});
const text = (value: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: value }],
});

describe.skipIf(!enabled)("Client-executed tool search in Orbit Chat", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const names = (tools: unknown[]) =>
    (tools as Array<{ type: string; name?: string }>).map(
      (tool) => tool.name ?? tool.type,
    );
  // The chat route's model; tool search needs gpt-5.4 or later.
  const useChatModel = (model: string) =>
    scoped(project.owner.workspaceId, project.owner.projectId, (tx) => {
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
  const chat = async (scope: Scope, outputs: unknown[][]) => {
    replay.outputs = outputs;
    replay.calls = 0;
    replay.inputs = [];
    replay.tools = [];
    replay.instructions = [];
    const thread = await createConversation(scope);
    const sent = await sendMessage(scope, thread.id, {
      text: "Which slots are free for X this week?",
      clientRequestId: randomUUID(),
    });
    await runChat(scope, sent.runId);
    return (await getRun(scope, sent.runId)).status;
  };
  // Items of one kind that Orbit added to the model input.
  const inputItems = (index: number, type: string) =>
    (replay.inputs[index] as Array<Record<string, any>>).filter(
      (item) => item.type === type,
    );

  beforeAll(async () => {
    project = await createPackageProject();
  });
  afterEach(() => {
    delete process.env.ORBIT_TOOL_SEARCH;
    delete process.env.ORBIT_CONTENT_PACKAGES;
  });
  afterAll(async () => {
    await project.cleanup();
    await closeDatabase();
  });

  it("loads the core tools plus tool search and returns the found tools for the same call", async () => {
    process.env.ORBIT_TOOL_SEARCH = "true";
    process.env.ORBIT_CONTENT_PACKAGES = "true";
    await useChatModel("gpt-5.6-terra");
    const status = await chat(project.editor, [
      [search("s1", "Show free schedule slots for X")],
      [call("c1", "schedule_options", { channels: ["x-int"], days: 3 })],
      [text("Here are the free slots.")],
    ]);
    expect(status).toBe("succeeded");
    expect(names(replay.tools[0]!)).toEqual([
      "project_status",
      "knowledge_search",
      "propose_campaign",
      "request_content_package",
      "package_status",
      "tool_search",
    ]);
    expect(replay.instructions[0]).toContain(
      "Load these tools with tool_search before calling them: approved_assets, analytics_memory, revise_package_deliverable, recent_content, schedule_options, propose_schedule.",
    );
    // The loaded set stays the same on every call, so the cached prefix holds;
    // only the always-loaded core counts against this guard.
    expect(replay.tools[1]).toEqual(replay.tools[0]);
    expect(
      Buffer.byteLength(JSON.stringify(replay.tools[0])),
    ).toBeLessThanOrEqual(5000);
    const [output] = inputItems(1, "tool_search_output");
    expect(output).toMatchObject({
      call_id: "s1",
      execution: "client",
      status: "completed",
    });
    expect(names(output!.tools)).toEqual(["schedule_options"]);
    for (const tool of output!.tools)
      expect(tool).toMatchObject({ strict: true, defer_loading: true });
    const [result] = inputItems(2, "function_call_output");
    expect(JSON.parse(result!.output)).toHaveProperty("channels");
  });

  it("never returns or runs tools the user's role does not allow", async () => {
    process.env.ORBIT_TOOL_SEARCH = "true";
    process.env.ORBIT_CONTENT_PACKAGES = "true";
    await useChatModel("gpt-5.6-terra");
    const status = await chat(project.viewer, [
      [search("s1", "Propose a schedule slot and revise the post")],
      [call("c1", "propose_schedule", { deliverableKey: "x-int", date: null })],
      [text("Viewers cannot schedule.")],
    ]);
    expect(status).toBe("succeeded");
    expect(names(replay.tools[0]!)).not.toContain("request_content_package");
    const [output] = inputItems(1, "tool_search_output");
    const found = names(output!.tools);
    expect(found).toContain("schedule_options");
    expect(found).not.toContain("propose_schedule");
    expect(found).not.toContain("revise_package_deliverable");
    const [result] = inputItems(2, "function_call_output");
    expect(JSON.parse(result!.output)).toEqual({
      error: "CHAT_TOOL_NOT_ALLOWED",
    });
  });

  it("keeps loading every tool on a model without tool search", async () => {
    process.env.ORBIT_TOOL_SEARCH = "true";
    process.env.ORBIT_CONTENT_PACKAGES = "true";
    await useChatModel("gpt-5.3-mini");
    await chat(project.editor, [[text("Hello.")]]);
    expect(names(replay.tools[0]!)).not.toContain("tool_search");
    expect(names(replay.tools[0]!)).toEqual(expect.arrayContaining(DEFERRED));
    expect(replay.instructions[0]).not.toContain("tool_search");
  });

  it("keeps loading every tool while the flag is off", async () => {
    process.env.ORBIT_CONTENT_PACKAGES = "true";
    await useChatModel("gpt-5.6-terra");
    await chat(project.editor, [[text("Hello.")]]);
    expect(names(replay.tools[0]!)).not.toContain("tool_search");
    expect(names(replay.tools[0]!)).toEqual(expect.arrayContaining(DEFERRED));
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Only the Anthropic SDK is replaced: the chat runner, the runtime port, the
// provider dispatch, the adapter, budget, settlement and telemetry are real.
const sdk = vi.hoisted(() => ({
  requests: [] as any[],
  replies: [] as Array<() => any>,
}));
vi.mock("@anthropic-ai/sdk", async (original) => ({
  ...(await original<typeof import("@anthropic-ai/sdk")>()),
  default: class {
    messages = {
      stream: (params: unknown) => {
        sdk.requests.push(structuredClone(params));
        const reply = sdk.replies.shift();
        if (!reply) throw new Error("NO_RECORDED_REPLY");
        const final = reply();
        return {
          async *[Symbol.asyncIterator]() {
            for (const block of final.content)
              if (block.type === "text")
                yield {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: block.text },
                };
          },
          finalMessage: async () => final,
        };
      },
      create: () => {
        throw new Error("NOT_EXPECTED");
      },
    };
  },
}));
import "../src/modules/registry.ts";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create } from "../src/shared.ts";
import {
  saveAiProviderConfiguration,
  saveOpenAiConfiguration,
} from "../src/platform/ai/openai-configuration.ts";
import {
  createConversation,
  getConversation,
  getRun,
  sendMessage,
} from "../src/modules/chat.ts";
import { runChat } from "../src/modules/chat-runner.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const CLAUDE = "claude-sonnet-5-5";
const usage = {
  input_tokens: 1_000,
  output_tokens: 100,
  cache_creation_input_tokens: 2_000,
  cache_read_input_tokens: 500,
  output_tokens_details: { thinking_tokens: 20 },
  server_tool_use: null,
};
const message = (content: unknown[], id: string) => ({
  id,
  type: "message",
  role: "assistant",
  model: CLAUDE,
  content,
  stop_reason: content.some((b: any) => b.type === "tool_use")
    ? "tool_use"
    : "end_turn",
  stop_sequence: null,
  stop_details: null,
  usage,
});

describe.skipIf(!enabled)("Orbit Chat on a Claude route (mocked SDK)", () => {
  let scope: Scope;
  beforeAll(async () => {
    const user = await authDb.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic Claude chat",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    const workspace = await authDb.workspace.create({
      data: {
        name: "Claude chat",
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Claude project" },
    });
    scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: user.id,
      role: "owner",
    };
    const past = new Date(Date.now() - 3600000).toISOString();
    const future = new Date(Date.now() + 86400000).toISOString();
    await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      await create(tx, scope, "policies", {
        mode: "observe",
        channels: ["x-test"],
        contentTypes: ["social"],
        allowedOrigins: ["https://example.invalid"],
        startAt: past,
        endAt: future,
        maxPerDay: 0,
        minIntervalMinutes: 1,
        dailyBudgetMicros: 10_000_000,
        monthlyBudgetMicros: 10_000_000,
        perRunBudgetMicros: 1_000_000,
        approvedPaidTests: true,
        active: true,
      });
      await saveOpenAiConfiguration(tx, scope, {
        apiKey: "synthetic-openai-" + "k".repeat(24),
        verifiedModels: [CLAUDE, "gpt-5.6-terra"],
        rateCard: {
          [CLAUDE]: {
            inputMicrosPerMillion: 2_000_000,
            outputMicrosPerMillion: 10_000_000,
            cachedInputMicrosPerMillion: 100_000,
            cacheWriteMicrosPerMillion: 2_500_000,
            verifiedAt: new Date().toISOString(),
          },
          "gpt-5.6-terra": {
            inputMicrosPerMillion: 1_000_000,
            outputMicrosPerMillion: 1_000_000,
            verifiedAt: new Date().toISOString(),
          },
        },
        modelRoutes: {
          fast: "gpt-5.6-terra",
          standard: "gpt-5.6-terra",
          quality: "gpt-5.6-terra",
          escalation: "gpt-5.6-terra",
        },
        taskRoutes: {
          chat_operator: {
            model: CLAUDE,
            reasoningEffort: "low",
            maxOutputTokens: 2000,
          },
        },
      });
      await saveAiProviderConfiguration(tx, scope, {
        anthropicApiKey: "synthetic-anthropic-" + "k".repeat(24),
        providerBudgets: {
          anthropic: {
            monthlyMicros: 100_000_000,
            warnMicros: 75_000_000,
            warn2Micros: 90_000_000,
            stopMicros: 95_000_000,
            anchorDay: 1,
          },
        },
      });
    });
  });
  afterAll(async () => {
    await authDb.workspace.delete({ where: { id: scope.workspaceId } });
    await authDb.user.delete({ where: { id: scope.userId } });
    await closeDatabase();
  });

  it("runs a tool step and an answer through the Messages API with budget, settlement and spans", async () => {
    const toolTurn = [
      { type: "thinking", thinking: "", signature: "sig-1" },
      { type: "text", text: "Let me check.", citations: null },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "project_status",
        input: {},
        caller: { type: "direct" },
      },
    ];
    sdk.replies.push(
      () => message(toolTurn, "msg_tool"),
      () =>
        message(
          [
            {
              type: "text",
              // The sentence before the tool call and the answer, joined by the adapter.
              text: "The project is in observe mode.",
              citations: null,
            },
          ],
          "msg_answer",
        ),
    );
    const thread = await createConversation(scope);
    const sent = await sendMessage(scope, thread.id, {
      text: "What is our project status?",
      clientRequestId: randomUUID(),
    });
    await runChat(scope, sent.runId);
    const run = await getRun(scope, sent.runId);
    expect(run).toMatchObject({ status: "succeeded", errorCode: null });
    // Both steps reached the adapter as Messages API requests.
    expect(sdk.requests).toHaveLength(2);
    const [first, second] = sdk.requests;
    expect(first).toMatchObject({
      model: CLAUDE,
      max_tokens: 2000,
      output_config: { effort: "low" },
      cache_control: { type: "ephemeral" },
    });
    expect(first.system[0]).toMatchObject({
      type: "text",
      cache_control: { type: "ephemeral" },
    });
    expect(first.system[0].text).toContain("Orbit");
    expect(first.tools.map((tool: any) => tool.name)).toContain(
      "project_status",
    );
    expect(first.tools.every((tool: any) => tool.strict === true)).toBe(true);
    expect("tool_choice" in first).toBe(false);
    expect("thinking" in first).toBe(false);
    expect(first.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "What is our project status?" }],
      },
    ]);
    // The second request carries the assistant blocks verbatim (thinking
    // included) and the tool result in one user message.
    expect(second.messages[1]).toEqual({
      role: "assistant",
      content: toolTurn,
    });
    expect(second.messages[2].role).toBe("user");
    expect(second.messages[2].content).toHaveLength(1);
    expect(second.messages[2].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_1",
    });
    expect(JSON.parse(second.messages[2].content[0].content)).toMatchObject({
      policy: expect.objectContaining({
        modelBudget: expect.objectContaining({ currency: "USD" }),
      }),
    });
    // The answer is stored and the text was streamed.
    const detail = await getConversation(scope, thread.id);
    expect(detail.messages.at(-1)).toMatchObject({
      role: "assistant",
      // The sentence before the tool call and the answer, joined by the adapter.
      text: "Let me check.\n\nThe project is in observe mode.",
    });
    // Two settled reservations priced from the Anthropic usage:
    // 1000 uncached x 2 + 500 cached x 0.1 + 2000 written x 2.5 + 100 output x 10 (USD per million).
    const rows = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.budgetReservation.findMany({
        where: { projectId: scope.projectId, category: "chat_text" },
        orderBy: { createdAt: "asc" },
      }),
    );
    expect(
      rows.map((row) => [row.state, row.model, Number(row.settledMicros)]),
    ).toEqual([
      ["settled", CLAUDE, 2000 + 50 + 5000 + 1000],
      ["settled", CLAUDE, 2000 + 50 + 5000 + 1000],
    ]);
    const spans = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.agentSpan.findMany({
        where: { projectId: scope.projectId, type: "model_call" },
        orderBy: { startedAt: "asc" },
      }),
    );
    expect(spans.map((span) => [span.name, span.model, span.status])).toEqual([
      ["messages.stream", CLAUDE, "succeeded"],
      ["messages.stream", CLAUDE, "succeeded"],
    ]);
    expect(spans[0]).toMatchObject({
      inputTokens: 3_500,
      cachedTokens: 500,
      cacheWriteTokens: 2_000,
      outputTokens: 100,
      reasoningTokens: 20,
      providerResponseId: "msg_tool",
    });
  });

  it("closes a refused turn as blocked with the usage settled", async () => {
    sdk.replies.push(() => ({
      ...message([], "msg_refused"),
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: null },
    }));
    const thread = await createConversation(scope);
    const sent = await sendMessage(scope, thread.id, {
      text: "Do something unsafe.",
      clientRequestId: randomUUID(),
    });
    await runChat(scope, sent.runId);
    const run = await getRun(scope, sent.runId);
    expect(run).toMatchObject({
      status: "blocked",
      errorCode: "CHAT_MODEL_CONTENT_FILTER",
    });
  });
});

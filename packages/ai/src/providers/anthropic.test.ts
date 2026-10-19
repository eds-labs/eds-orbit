import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  stream: vi.fn(),
  options: [] as unknown[],
}));
vi.mock("@anthropic-ai/sdk", async (original) => ({
  ...(await original<typeof import("@anthropic-ai/sdk")>()),
  default: class {
    messages = { create: sdk.create, stream: sdk.stream };
    constructor(options: unknown) {
      sdk.options.push(options);
    }
  },
}));
import { APIError } from "@anthropic-ai/sdk";
import {
  anthropicRequest,
  anthropicStrictSchema,
  fromAnthropicMessage,
  normalizeAnthropicUsage,
  toAnthropicMessages,
  toAnthropicTools,
} from "./anthropic.ts";
import {
  GenerationOutputError,
  generate,
  isRejectedRequest,
  respond,
  streamChat,
} from "../index.ts";

const route = { model: "claude-sonnet-5-5", maxOutputTokens: 1800 };
const runtime = {
  anthropicApiKey: "synthetic-anthropic-key",
  verifiedModels: ["claude-sonnet-5-5"],
  rateCard: {
    "claude-sonnet-5-5": {
      inputMicrosPerMillion: 2_000_000,
      outputMicrosPerMillion: 10_000_000,
      cachedInputMicrosPerMillion: 100_000,
      cacheWriteMicrosPerMillion: 2_500_000,
      verifiedAt: new Date().toISOString(),
    },
  },
};
const usage = {
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 200,
  cache_read_input_tokens: 1_000,
  output_tokens_details: { thinking_tokens: 10 },
  server_tool_use: null,
};
const message = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: route.model,
  content,
  stop_reason: "end_turn",
  stop_sequence: null,
  stop_details: null,
  usage,
  ...extra,
});

describe("Orbit items as Messages API messages", () => {
  it("joins consecutive items of one side and sends assistant blocks back verbatim", () => {
    const providerContent = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "Looking it up." },
      { type: "tool_use", id: "call_1", name: "project_status", input: {} },
    ];
    const messages = toAnthropicMessages([
      { role: "user", content: "Status?" },
      { role: "system", content: "Be brief." },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Looking it up." }],
        providerContent,
      },
      // Repeats the tool_use block above: skipped.
      {
        type: "function_call",
        call_id: "call_1",
        name: "project_status",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: '{"ok":1}' },
      { type: "function_call_output", call_id: "call_2", output: "late" },
    ]);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Status?" },
          { type: "text", text: "Be brief." },
        ],
      },
      { role: "assistant", content: providerContent },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: '{"ok":1}' },
          { type: "tool_result", tool_use_id: "call_2", content: "late" },
        ],
      },
    ]);
  });
  it("turns a function_call without provider blocks into a tool_use block", () => {
    expect(
      toAnthropicMessages([
        { role: "user", content: "x" },
        {
          type: "function_call",
          call_id: "c",
          name: "knowledge_search",
          arguments: '{"query":"beta"}',
        },
      ])[1],
    ).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "c",
          name: "knowledge_search",
          input: { query: "beta" },
        },
      ],
    });
  });
  it("refuses tool search items instead of pretending", () => {
    expect(() =>
      toAnthropicMessages([
        { type: "tool_search_call", call_id: "s", arguments: {} },
      ]),
    ).toThrow("PROVIDER_FEATURE_UNSUPPORTED");
    expect(() =>
      toAnthropicTools([{ type: "tool_search", execution: "client" }]),
    ).toThrow("PROVIDER_FEATURE_UNSUPPORTED");
  });
  it("drops empty text so the API never sees an empty block", () => {
    expect(
      toAnthropicMessages([
        { role: "user", content: "" },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
      ]),
    ).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });
});

describe("Messages API responses as Orbit items", () => {
  it("returns the text with citations, the tool calls and the hosted searches", () => {
    const content = [
      { type: "text", text: "Searching. ", citations: null },
      {
        type: "server_tool_use",
        id: "srv_1",
        name: "web_search",
        input: { query: "uliquid" },
        caller: { type: "direct" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srv_1",
        caller: { type: "direct" },
        content: [
          {
            type: "web_search_result",
            url: "https://uliquid.vip/",
            title: "uLiquid",
            encrypted_content: "x",
            page_age: null,
          },
        ],
      },
      {
        type: "text",
        text: "Found it.",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://uliquid.vip/docs",
            title: "Docs",
            encrypted_index: "e",
            cited_text: "c",
          },
        ],
      },
      {
        type: "tool_use",
        id: "call_9",
        name: "knowledge_search",
        input: { query: "x" },
        caller: { type: "direct" },
      },
    ];
    const items = fromAnthropicMessage(
      message(content, {
        usage: { ...usage, server_tool_use: { web_search_requests: 2 } },
      }) as never,
    );
    expect(items).toEqual([
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Searching. Found it.",
            annotations: [
              {
                type: "url_citation",
                url: "https://uliquid.vip/docs",
                title: "Docs",
              },
            ],
          },
        ],
        providerContent: content,
      },
      {
        type: "web_search_call",
        id: "srv_1",
        status: "completed",
        action: {
          type: "search",
          query: "uliquid",
          sources: [{ type: "url", url: "https://uliquid.vip/" }],
        },
      },
      // The second billed search had no result block; it still counts.
      {
        type: "web_search_call",
        id: "msg_1:search:1",
        status: "completed",
        action: { type: "search", query: null, sources: [] },
      },
      {
        type: "function_call",
        call_id: "call_9",
        name: "knowledge_search",
        arguments: '{"query":"x"}',
      },
    ]);
  });
});

describe("usage and schema conversion", () => {
  it("sums the uncached, cached and written tokens into the prompt size", () => {
    expect(normalizeAnthropicUsage(usage)).toEqual({
      inputTokens: 1_300,
      cachedTokens: 1_000,
      cacheWriteTokens: 200,
      outputTokens: 50,
      reasoningTokens: 10,
      detailsKnown: true,
    });
  });
  it("marks the cache split unknown when a count is missing", () => {
    expect(
      normalizeAnthropicUsage({
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: null,
      }),
    ).toMatchObject({ inputTokens: 10, detailsKnown: false });
    expect(() => normalizeAnthropicUsage({ output_tokens: 1 })).toThrow(
      "USAGE_UNKNOWN",
    );
  });
  it("strips the keywords Anthropic's strict mode refuses and keeps the rest", () => {
    expect(
      anthropicStrictSchema({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          angle: { type: "string", maxLength: 1200, description: "d" },
          n: { type: "integer", minimum: 0, maximum: 9 },
          tags: {
            type: "array",
            maxItems: 5,
            minItems: 1,
            items: { type: "string" },
          },
          few: { type: "array", minItems: 3, items: { type: "string" } },
          day: { type: "string", format: "date", pattern: "^complex$" },
          code: { type: "string", format: "custom", pattern: "^[a-z]+$" },
          kind: { type: "string", enum: ["a", "b"] },
          nested: {
            anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
          },
        },
        required: ["angle"],
        additionalProperties: false,
      }),
    ).toEqual({
      type: "object",
      properties: {
        angle: { type: "string", description: "d" },
        n: { type: "integer" },
        tags: { type: "array", minItems: 1, items: { type: "string" } },
        few: { type: "array", items: { type: "string" } },
        day: { type: "string", format: "date" },
        code: { type: "string", pattern: "^[a-z]+$" },
        kind: { type: "string", enum: ["a", "b"] },
        nested: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["angle"],
      additionalProperties: false,
    });
  });
  it("builds strict tools and a capped direct web search", () => {
    expect(
      toAnthropicTools(
        [
          {
            type: "function",
            name: "project_status",
            description: "Status",
            strict: true,
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
              required: [],
            },
            defer_loading: true,
          },
          { type: "web_search" },
        ],
        { maxSearches: 2 },
      ),
    ).toEqual([
      {
        name: "project_status",
        description: "Status",
        input_schema: {
          type: "object",
          properties: {},
          additionalProperties: false,
          required: [],
        },
        strict: true,
      },
      {
        type: "web_search_20260209",
        name: "web_search",
        allowed_callers: ["direct"],
        max_uses: 2,
      },
    ]);
  });
  it("caches the system prompt and the prefix, maps effort and the output format", () => {
    const request = anthropicRequest({
      route: { ...route, reasoningEffort: "low" },
      instructions: "Be Orbit.",
      input: [{ role: "user", content: "hi" }],
      outputSchema: {
        type: "object",
        properties: { a: { type: "string", maxLength: 3 } },
        required: ["a"],
        additionalProperties: false,
      },
    });
    expect(request).toEqual({
      model: route.model,
      max_tokens: 1800,
      system: [
        {
          type: "text",
          text: "Be Orbit.",
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
            additionalProperties: false,
          },
        },
      },
      cache_control: { type: "ephemeral" },
    });
    expect("thinking" in request).toBe(false);
    expect("tool_choice" in request).toBe(false);
  });
  it("refuses the effort value Anthropic has no equivalent for", () => {
    expect(() =>
      anthropicRequest({
        route: { ...route, reasoningEffort: "none" },
        instructions: "x",
        input: [{ role: "user", content: "hi" }],
      }),
    ).toThrow("ROUTE_EFFORT_UNSUPPORTED");
  });
});

describe("routed calls through the Anthropic adapter", () => {
  beforeEach(() => {
    sdk.create.mockReset();
    sdk.stream.mockReset();
    sdk.options.length = 0;
  });
  it("generate prices the draft with the Anthropic usage and never retries", async () => {
    sdk.create.mockResolvedValue(
      message([
        {
          type: "text",
          text: JSON.stringify({ title: "t", body: "b", claims: [] }),
          citations: null,
        },
      ]),
    );
    const result = await generate({
      task: "draft",
      goal: "g",
      evidence: {},
      route,
      reservationId: "r",
      runtime,
    });
    expect(sdk.options[0]).toMatchObject({
      apiKey: "synthetic-anthropic-key",
      maxRetries: 0,
      timeout: 45000,
    });
    const [body] = sdk.create.mock.calls[0]!;
    expect(body).toMatchObject({
      model: route.model,
      max_tokens: 1800,
      output_config: { format: { type: "json_schema" } },
    });
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: JSON.stringify({ goal: "g", evidence: {} }) },
        ],
      },
    ]);
    // 100 uncached at 2, 1000 cached at 0.1, 200 written at 2.5, 50 output at 10 (USD per million).
    expect(result.usage).toEqual({
      model: route.model,
      inputTokens: 1_300,
      cachedTokens: 1_000,
      cacheWriteTokens: 200,
      outputTokens: 50,
      reasoningTokens: 10,
      costMicros: 200 + 100 + 500 + 500,
    });
    expect(result.output.body).toBe("b");
  });
  it("generate reports a refusal as a billed, non-retryable outcome", async () => {
    sdk.create.mockResolvedValue(
      message([], {
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: null },
      }),
    );
    const error = await generate({
      task: "draft",
      goal: "g",
      evidence: {},
      route,
      reservationId: "r",
      runtime,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GenerationOutputError);
    expect(error).toMatchObject({ code: "MODEL_REFUSAL", costMicros: 1300 });
  });
  it("generate refuses without an Anthropic key", async () => {
    await expect(
      generate({
        task: "draft",
        goal: "g",
        evidence: {},
        route,
        reservationId: "r",
        runtime: { ...runtime, anthropicApiKey: undefined, apiKey: "openai" },
      }),
    ).rejects.toThrow("PAID_CALL_NOT_AUTHORIZED");
    expect(sdk.create).not.toHaveBeenCalled();
  });
  it("respond converts tools, caps searches and returns Orbit items", async () => {
    sdk.create.mockResolvedValue(
      message([
        { type: "text", text: '{"ok":true}', citations: null },
        {
          type: "tool_use",
          id: "c1",
          name: "knowledge_search",
          input: { query: "q" },
          caller: { type: "direct" },
        },
      ]),
    );
    const result = await respond({
      route,
      instructions: "i",
      input: [{ role: "user", content: "x" }],
      tools: [
        {
          type: "function",
          name: "knowledge_search",
          description: "d",
          strict: true,
          parameters: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
        { type: "web_search" },
      ],
      outputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      maxToolCalls: 1,
      reservationId: "r",
      runtime,
    });
    const [body] = sdk.create.mock.calls[0]!;
    expect(body.tools).toEqual([
      expect.objectContaining({ name: "knowledge_search", strict: true }),
      expect.objectContaining({ type: "web_search_20260209", max_uses: 1 }),
    ]);
    expect(sdk.options[0]).toMatchObject({ timeout: 60000 });
    expect(result.responseId).toBe("msg_1");
    expect(result.output).toEqual([
      expect.objectContaining({ type: "message" }),
      {
        type: "function_call",
        call_id: "c1",
        name: "knowledge_search",
        arguments: '{"query":"q"}',
      },
    ]);
    expect(result.usage.costMicros).toBe(1300);
  });
  it("streamChat yields the chat runner's events with the usage in Responses shape", async () => {
    const final = message([
      { type: "text", text: "Hello there", citations: null },
    ]);
    sdk.stream.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start" };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "…" },
        };
        yield {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Hello" },
        };
        yield {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: " there" },
        };
      },
      finalMessage: async () => final,
    });
    const events = [];
    for await (const event of await streamChat({
      route,
      input: [{ role: "user", content: "hi" }],
      tools: [],
      instructions: "i",
      reservationId: "r",
      runtime,
    }))
      events.push(event);
    expect(events).toEqual([
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.output_text.delta", delta: " there" },
      {
        type: "response.completed",
        response: {
          id: "msg_1",
          usage: {
            input_tokens: 1_300,
            output_tokens: 50,
            input_tokens_details: {
              cached_tokens: 1_000,
              cache_write_tokens: 200,
            },
            output_tokens_details: { reasoning_tokens: 10 },
          },
          output: [
            expect.objectContaining({
              type: "message",
              content: [expect.objectContaining({ text: "Hello there" })],
            }),
          ],
        },
      },
    ]);
    expect(sdk.stream.mock.calls[0]![0]).toMatchObject({
      model: route.model,
      system: [
        expect.objectContaining({ cache_control: { type: "ephemeral" } }),
      ],
    });
  });
  it.each([
    ["max_tokens", "max_output_tokens"],
    ["refusal", "content_filter"],
  ])(
    "streamChat reports stop reason %s as an incomplete response",
    async (stop, reason) => {
      sdk.stream.mockReturnValue({
        async *[Symbol.asyncIterator]() {},
        finalMessage: async () => message([], { stop_reason: stop }),
      });
      const events = [];
      for await (const event of await streamChat({
        route,
        input: [{ role: "user", content: "hi" }],
        tools: [],
        instructions: "i",
        reservationId: "r",
        runtime,
      }))
        events.push(event);
      expect(events).toEqual([
        {
          type: "response.incomplete",
          response: expect.objectContaining({ incomplete_details: { reason } }),
        },
      ]);
    },
  );
});

describe("rejected Anthropic requests", () => {
  const status = (code: number) =>
    APIError.generate(
      code,
      { error: { type: "x", message: "synthetic" } },
      "synthetic",
      new Headers(),
    );
  it.each([400, 401, 403, 404, 413, 422, 429, 529])(
    "treats HTTP %i as not processed and not billed",
    (code) => expect(isRejectedRequest(status(code))).toBe(true),
  );
  it.each([408, 409, 500, 502, 503])("keeps HTTP %i unknown", (code) =>
    expect(isRejectedRequest(status(code))).toBe(false),
  );
});

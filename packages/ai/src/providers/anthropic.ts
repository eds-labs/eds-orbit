import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  ToolUnion,
} from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";
import type { NormalizedUsage } from "../cost.ts";
import type { ModelRoute } from "../routing.ts";

/**
 * Anthropic adapter (plan D-A1, D-A10). Orbit's internal conversation format
 * is the Responses item list the runtime port already uses (`message`,
 * `function_call`, `function_call_output`, synthetic `web_search_call`);
 * this module converts it to Messages API blocks and back, so no caller
 * knows which provider served a route. Every request is sent once, without
 * SDK retries, with the system prompt and the conversation prefix marked
 * for prompt caching.
 */

/** HTTP statuses Anthropic answers before any model work; such a request is not billed. */
export const ANTHROPIC_UNBILLED_STATUSES = new Set([
  400, 401, 403, 404, 413, 422, 429,
  // overloaded_error: the request was not processed.
  529,
]);

export function anthropicClient(apiKey: string, timeout: number) {
  return new Anthropic({ apiKey, maxRetries: 0, timeout });
}

/** Thrown for a feature of Orbit's internal format the Messages API has no equivalent for. */
export const PROVIDER_FEATURE_UNSUPPORTED = "PROVIDER_FEATURE_UNSUPPORTED";

// Strict structured outputs accept a subset of JSON Schema; everything else
// is a 400. Dropped keywords stay enforced by Orbit's own zod validation of
// the parsed answer.
const DROPPED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "default",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "maxItems",
]);
const SUPPORTED_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** A strict-mode schema (tool parameters or output format) as Anthropic's strict mode accepts it. */
export function anthropicStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(anthropicStrictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const supportedFormat =
    typeof source.format === "string" && SUPPORTED_FORMATS.has(source.format);
  for (const [key, value] of Object.entries(source)) {
    if (DROPPED_KEYWORDS.has(key)) continue;
    if (key === "minItems") {
      if (value === 0 || value === 1) out[key] = value;
      continue;
    }
    if (key === "format") {
      if (supportedFormat) out[key] = value;
      continue;
    }
    // A pattern that only restates a supported format is left out: complex
    // patterns are refused, the format carries the check.
    if (key === "pattern") {
      if (!supportedFormat) out[key] = value;
      continue;
    }
    if (key === "properties" || key === "$defs" || key === "definitions") {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([name, child]) => [name, anthropicStrictSchema(child)],
        ),
      );
      continue;
    }
    if (
      key === "items" ||
      key === "anyOf" ||
      key === "allOf" ||
      key === "oneOf"
    ) {
      out[key] = anthropicStrictSchema(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Tool definitions of Orbit's internal (Responses) shape as Messages API tools. */
export function toAnthropicTools(
  tools: unknown[],
  options: { maxSearches?: number } = {},
): ToolUnion[] {
  return tools.map((raw): ToolUnion => {
    const tool = raw as Record<string, unknown> | null;
    if (tool?.type === "function" && typeof tool.name === "string")
      return {
        name: tool.name,
        ...(typeof tool.description === "string"
          ? { description: tool.description }
          : {}),
        input_schema: anthropicStrictSchema(
          tool.parameters ?? { type: "object", properties: {} },
        ) as { type: "object"; [key: string]: unknown },
        strict: true,
      };
    if (tool?.type === "web_search" || tool?.type === "web_search_preview")
      return {
        type: "web_search_20260209",
        name: "web_search",
        // Direct calls only: no code execution runs for the search.
        allowed_callers: ["direct"],
        ...(options.maxSearches !== undefined
          ? { max_uses: Math.max(1, options.maxSearches) }
          : {}),
      };
    // Client-executed tool search and anything else have no Messages API form.
    throw new Error(PROVIDER_FEATURE_UNSUPPORTED);
  });
}

type Item = Record<string, unknown>;

function itemText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "string"
        ? part
        : typeof (part as Item)?.text === "string"
          ? String((part as Item).text)
          : "",
    )
    .join("");
}

/**
 * Orbit's item list as Messages API messages. Consecutive items of one side
 * join one message (parallel tool results must arrive in a single user
 * message). An assistant item that carries `providerContent` (the blocks
 * exactly as Anthropic returned them, including thinking, tool_use and
 * server tool blocks) is sent back verbatim; the `function_call` items that
 * repeat its tool_use blocks are skipped.
 */
export function toAnthropicMessages(items: unknown[]): MessageParam[] {
  const messages: MessageParam[] = [];
  const carried = new Set<string>();
  const push = (role: "user" | "assistant", blocks: ContentBlockParam[]) => {
    if (!blocks.length) return;
    const last = messages.at(-1);
    if (last && last.role === role && Array.isArray(last.content))
      last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };
  for (const raw of items) {
    const item = raw as Item | null;
    if (!item || typeof item !== "object")
      throw new Error("MODEL_INPUT_INVALID");
    switch (item.type) {
      case "function_call_output":
        push("user", [
          {
            type: "tool_result",
            tool_use_id: String(item.call_id),
            content: String(item.output ?? ""),
          },
        ]);
        continue;
      case "function_call": {
        const id = String(item.call_id);
        if (carried.has(id)) continue;
        let input: unknown = {};
        try {
          input = JSON.parse(String(item.arguments ?? "{}"));
        } catch {
          input = {};
        }
        push("assistant", [
          { type: "tool_use", id, name: String(item.name), input },
        ]);
        continue;
      }
      case "web_search_call":
        // Synthetic; its server blocks travel inside providerContent.
        continue;
      case "tool_search_call":
      case "tool_search_output":
        throw new Error(PROVIDER_FEATURE_UNSUPPORTED);
      default:
        break;
    }
    if (item.type !== undefined && item.type !== "message")
      throw new Error("MODEL_INPUT_INVALID");
    const role = item.role === "assistant" ? "assistant" : "user";
    if (role === "assistant" && Array.isArray(item.providerContent)) {
      for (const block of item.providerContent as Item[])
        if (block?.type === "tool_use") carried.add(String(block.id));
      push("assistant", item.providerContent as ContentBlockParam[]);
      continue;
    }
    const text = itemText(item.content);
    // The API refuses empty text blocks; an empty turn carries nothing.
    if (text) push(role, [{ type: "text", text }]);
  }
  return messages;
}

/**
 * A Messages API response as Orbit's item list: one `message` item with the
 * joined text (and `url_citation` annotations), the provider blocks kept in
 * `providerContent` for the next request, one synthetic `web_search_call`
 * per hosted search with the URLs it returned, then the `function_call`
 * items for the tools Orbit executes.
 */
export function fromAnthropicMessage(message: Message): unknown[] {
  const texts: string[] = [];
  const annotations: Item[] = [];
  const calls: Item[] = [];
  const searches = new Map<string, { query: unknown; sources: string[] }>();
  for (const block of message.content as ContentBlock[]) {
    switch (block.type) {
      case "text":
        texts.push(block.text);
        for (const citation of block.citations ?? [])
          if (citation.type === "web_search_result_location")
            annotations.push({
              type: "url_citation",
              url: citation.url,
              title: citation.title ?? "",
            });
        break;
      case "tool_use":
        calls.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
        break;
      case "server_tool_use":
        if (block.name === "web_search")
          searches.set(block.id, {
            query: (block.input as Item | null)?.query,
            sources: [],
          });
        break;
      case "web_search_tool_result": {
        const search = searches.get(block.tool_use_id);
        if (search && Array.isArray(block.content))
          for (const result of block.content)
            if (result.type === "web_search_result")
              search.sources.push(result.url);
        break;
      }
      default:
        // thinking and redacted_thinking blocks stay in providerContent only.
        break;
    }
  }
  const items: unknown[] = [
    {
      type: "message",
      id: message.id,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: texts.join(""), annotations }],
      providerContent: message.content,
    },
  ];
  // Billed searches without a result block (errors) still count as one call each.
  const billed = message.usage?.server_tool_use?.web_search_requests ?? 0;
  for (const [id, search] of searches)
    items.push({
      type: "web_search_call",
      id,
      status: "completed",
      action: {
        type: "search",
        query: search.query,
        sources: search.sources.map((url) => ({ type: "url", url })),
      },
    });
  for (let index = searches.size; index < billed; index++)
    items.push({
      type: "web_search_call",
      id: `${message.id}:search:${index}`,
      status: "completed",
      action: { type: "search", query: null, sources: [] },
    });
  items.push(...calls);
  return items;
}

const count = z.number().int().nonnegative();
const usageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  cache_creation_input_tokens: count.nullish(),
  cache_read_input_tokens: count.nullish(),
  output_tokens_details: z
    .object({ thinking_tokens: count.nullish() })
    .nullish(),
  server_tool_use: z.object({ web_search_requests: count.nullish() }).nullish(),
});

/**
 * A Messages API usage object normalized. Anthropic's `input_tokens` is the
 * uncached remainder: the prompt is `input_tokens + cache_read + cache_creation`.
 * Thinking tokens are inside `output_tokens`. Missing cache counts mark the
 * split unknown, so the cost settles at the highest rate (ADR 0003).
 */
export function normalizeAnthropicUsage(usage: unknown): NormalizedUsage {
  const parsed = usageSchema.safeParse(usage);
  if (!parsed.success) throw new Error("USAGE_UNKNOWN");
  const u = parsed.data;
  const read = u.cache_read_input_tokens;
  const write = u.cache_creation_input_tokens;
  return {
    inputTokens: u.input_tokens + (read ?? 0) + (write ?? 0),
    cachedTokens: read ?? 0,
    cacheWriteTokens: write ?? 0,
    outputTokens: u.output_tokens,
    reasoningTokens: u.output_tokens_details?.thinking_tokens ?? 0,
    detailsKnown: read != null && write != null,
  };
}

/** The normalized usage in the Responses shape the chat runner reads from a stream. */
export function toResponsesUsage(usage: NormalizedUsage) {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    input_tokens_details: usage.detailsKnown
      ? {
          cached_tokens: usage.cachedTokens,
          cache_write_tokens: usage.cacheWriteTokens,
        }
      : null,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
  };
}

/** How a response ended, in Orbit's terms. */
export type AnthropicStop =
  "completed" | "max_tokens" | "refusal" | "pause_turn";

export function anthropicStop(
  message: Pick<Message, "stop_reason">,
): AnthropicStop {
  switch (message.stop_reason) {
    case "refusal":
      return "refusal";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "pause_turn":
      return "pause_turn";
    default:
      return "completed";
  }
}

export type AnthropicRequestInput = {
  route: ModelRoute;
  instructions: string;
  input: unknown[];
  tools?: unknown[];
  maxSearches?: number;
  outputSchema?: object;
};

/** The Messages API request of one Orbit call; `ROUTE_EFFORT_UNSUPPORTED` for an effort the API has no value for. */
export function anthropicRequest(
  params: AnthropicRequestInput,
): MessageCreateParamsNonStreaming {
  const effort = params.route.reasoningEffort;
  if (effort === "none") throw new Error("ROUTE_EFFORT_UNSUPPORTED");
  const tools = params.tools?.length
    ? toAnthropicTools(params.tools, { maxSearches: params.maxSearches })
    : [];
  const outputConfig = {
    ...(effort ? { effort } : {}),
    ...(params.outputSchema
      ? {
          format: {
            type: "json_schema" as const,
            schema: anthropicStrictSchema(params.outputSchema) as Record<
              string,
              unknown
            >,
          },
        }
      : {}),
  };
  return {
    model: params.route.model,
    max_tokens: params.route.maxOutputTokens,
    // Stable first: tools, then the system prompt with a cache breakpoint.
    system: [
      {
        type: "text",
        text: params.instructions,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: toAnthropicMessages(params.input),
    ...(tools.length ? { tools } : {}),
    ...(Object.keys(outputConfig).length
      ? { output_config: outputConfig }
      : {}),
    // The conversation prefix too: the next step of a tool loop re-sends it.
    cache_control: { type: "ephemeral" },
  };
}

/** The joined text of the response's text blocks. */
export function anthropicText(message: Pick<Message, "content">) {
  return (message.content as ContentBlock[])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** One non-streaming request. Nothing is retried; the caller settles the cost. */
export async function anthropicComplete(params: {
  apiKey: string;
  timeout: number;
  request: AnthropicRequestInput;
  signal?: AbortSignal;
}) {
  const client = anthropicClient(params.apiKey, params.timeout);
  const message = await client.messages.create(
    anthropicRequest(params.request),
    { signal: params.signal },
  );
  return {
    message,
    text: anthropicText(message),
    output: fromAnthropicMessage(message),
    usage: normalizeAnthropicUsage(message.usage),
    stop: anthropicStop(message),
    responseId: message.id ?? null,
  };
}

/**
 * One streaming request as the events the chat runner reads
 * (`response.output_text.delta`, `response.completed`, `response.incomplete`,
 * `response.failed`). A refusal arrives as `content_filter`, a cut-off answer
 * as `max_output_tokens`; both carry the usage of the billed response.
 */
export async function* anthropicStream(params: {
  apiKey: string;
  timeout: number;
  request: AnthropicRequestInput;
  signal?: AbortSignal;
}): AsyncGenerator<{ type: string } & Record<string, unknown>> {
  const client = anthropicClient(params.apiKey, params.timeout);
  const stream = client.messages.stream(anthropicRequest(params.request), {
    signal: params.signal,
  });
  let streamed = false;
  for await (const event of stream)
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      streamed = true;
      yield { type: "response.output_text.delta", delta: event.delta.text };
    }
  const message = await stream.finalMessage();
  // Claude may say a sentence before its tool calls; the chat runner joins
  // the text of every step, so a paragraph break keeps the answer readable.
  if (streamed && message.stop_reason === "tool_use")
    yield { type: "response.output_text.delta", delta: "\n\n" };
  const usage = toResponsesUsage(normalizeAnthropicUsage(message.usage));
  const stop = anthropicStop(message);
  if (stop === "completed" || stop === "pause_turn") {
    yield {
      type: "response.completed",
      response: {
        id: message.id,
        usage,
        output: fromAnthropicMessage(message),
      },
    };
    return;
  }
  yield {
    type: "response.incomplete",
    response: {
      id: message.id,
      usage,
      incomplete_details: {
        reason: stop === "refusal" ? "content_filter" : "max_output_tokens",
      },
    },
  };
}

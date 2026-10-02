/**
 * Spike (ADR 0005, S2): the OpenAI Agents SDK runner behind the AgentRuntime
 * port. The SDK never talks to OpenAI itself: its model is a bridge to
 * Orbit's BudgetedModel (reservation, transmission, settlement, spans), its
 * tools only dispatch to Orbit's ToolHost, tracing is off and retries are 0.
 * Responses API items travel unchanged in providerData, so the host sees the
 * same input as with the legacy loop.
 */
import {
  Agent,
  AgentsError,
  Runner,
  ToolCallError,
  Usage,
  tool,
  type AgentInputItem,
  type AgentOutputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents-core";
import { DomainError } from "../../../shared.ts";
import type { AgentRuntime, ToolCallRequest, TurnInput } from "./port.ts";

type ResponsesItem = Record<string, any>;
const RAW = "orbitResponsesItem";

/** Responses API item -> SDK protocol item, keeping the original for the way back. */
function toAgentItem(item: ResponsesItem): AgentOutputItem {
  const providerData = { [RAW]: item };
  if (item.type === "function_call")
    return {
      type: "function_call",
      callId: item.call_id,
      name: item.name,
      arguments: item.arguments,
      status: "completed",
      providerData,
    } as AgentOutputItem;
  if (item.role === "user")
    return {
      role: "user",
      content: typeof item.content === "string" ? item.content : "",
      providerData,
    } as AgentOutputItem;
  if (item.role === "assistant" || item.type === "message")
    return {
      type: "message",
      role: "assistant",
      status: "completed",
      content: (Array.isArray(item.content)
        ? item.content
        : [{ type: "output_text", text: String(item.content ?? "") }]
      )
        .filter((part: any) => part?.type === "output_text")
        .map((part: any) => ({ type: "output_text", text: part.text })),
      providerData,
    } as AgentOutputItem;
  if (item.type === "reasoning")
    return { type: "reasoning", content: [], providerData } as AgentOutputItem;
  return { type: "unknown", providerData } as AgentOutputItem;
}

/** SDK protocol item -> the Responses API item the host sends. */
function toResponsesItem(item: AgentInputItem): ResponsesItem {
  const raw = (item as { providerData?: Record<string, unknown> })
    .providerData?.[RAW];
  if (raw) return raw as ResponsesItem;
  if (item.type === "function_call_result") {
    const output = item.output as unknown;
    return {
      type: "function_call_output",
      call_id: item.callId,
      output:
        typeof output === "string"
          ? output
          : String((output as { text?: unknown })?.text ?? ""),
    };
  }
  throw new DomainError("RUNTIME_ITEM_UNSUPPORTED");
}

/** The error Orbit code threw, unwrapped from SDK error classes. */
function originalError(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (current instanceof ToolCallError) current = current.error;
    else if (current instanceof AgentsError && current.cause)
      current = current.cause;
    else break;
  }
  return current;
}

export const openAiAgentsRuntime: AgentRuntime = {
  name: "openai_agents_sdk",
  async runTurn(turn: TurnInput) {
    const { limits, signal } = turn;
    let modelCalls = 0;
    let toolCalls = 0;
    let dispatched = 0;
    const bridge: Model = {
      async getResponse(request: ModelRequest): Promise<ModelResponse> {
        // Same order as the legacy loop: abort check, one budgeted call, then limits.
        if (signal.aborted) throw new DomainError("CHAT_CANCELED");
        const input = (
          typeof request.input === "string"
            ? [{ role: "user", content: request.input }]
            : request.input.map(toResponsesItem)
        ) as unknown[];
        const step = await turn.model.call({ input, signal });
        modelCalls++;
        if (
          step.toolCalls.length &&
          (toolCalls + step.toolCalls.length > limits.maxToolCalls ||
            modelCalls >= limits.maxModelCalls)
        )
          throw new DomainError("CHAT_TOOL_LIMIT");
        toolCalls += step.toolCalls.length;
        return {
          usage: new Usage(),
          output: (step.output as ResponsesItem[]).map(toAgentItem),
        };
      },
      getStreamedResponse() {
        throw new DomainError("RUNTIME_STREAMING_UNSUPPORTED");
      },
    };
    const agent = new Agent({
      name: "orbit_operator",
      instructions: "",
      model: bridge,
      modelSettings: { retry: { maxRetries: 0 } },
      tools: turn.toolNames.map((name) =>
        tool({
          name,
          description: name,
          strict: false,
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: true,
          } as never,
          // Orbit's ToolHost validates arguments and maps its own errors.
          errorFunction: null,
          async execute(_input, _context, details) {
            const call = details?.toolCall as
              { callId: string; name: string; arguments: string } | undefined;
            const request: ToolCallRequest = {
              callId: call?.callId ?? "",
              name: call?.name ?? name,
              arguments: call?.arguments ?? "{}",
            };
            dispatched++;
            return turn.tools.execute(request, dispatched);
          },
        }),
      ),
    });
    const runner = new Runner({
      tracingDisabled: true,
      toolExecution: { maxFunctionToolConcurrency: 1 },
    });
    try {
      await runner.run(
        agent,
        (turn.input as ResponsesItem[]).map(
          toAgentItem,
        ) as unknown as AgentInputItem[],
        {
          maxTurns: limits.maxModelCalls,
          signal,
          // An invented tool name still goes to Orbit's ToolHost, which refuses and records it.
          toolNotFoundBehavior: "return_error_to_model",
          toolErrorFormatter: async ({ kind, toolName, callId }) => {
            if (kind !== "tool_not_found") return undefined;
            dispatched++;
            return turn.tools.execute(
              { callId, name: toolName, arguments: "{}" },
              dispatched,
            );
          },
        },
      );
    } catch (error) {
      const original = originalError(error);
      if (original instanceof DomainError) throw original;
      if (signal.aborted) throw new DomainError("CHAT_CANCELED");
      throw original;
    }
    return { modelCalls, toolCalls };
  },
};

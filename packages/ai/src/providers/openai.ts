import OpenAI from "openai";
import { normalizeResponsesUsage } from "../cost.ts";
import type { ModelRoute } from "../routing.ts";

/**
 * OpenAI adapter: the Responses API calls Orbit has always made, unchanged
 * (`store: false`, no SDK retries, strict structured output). Orbit's
 * internal item list is the Responses input, so nothing is converted.
 */

function client(apiKey: string, timeout: number) {
  return new OpenAI({ apiKey, maxRetries: 0, timeout });
}

// The reasoning key is omitted entirely unless the route sets an effort.
function reasoningParameter(route: ModelRoute) {
  return route.reasoningEffort
    ? { reasoning: { effort: route.reasoningEffort } }
    : {};
}

function outputFormat(name: string, schema: object | undefined) {
  return schema
    ? {
        text: {
          format: {
            type: "json_schema" as const,
            name,
            strict: true as const,
            schema: schema as Record<string, unknown>,
          },
        },
      }
    : {};
}

/** One strict-JSON draft request; returns the text and the normalized usage. */
export async function openAiGenerate(params: {
  apiKey: string;
  route: ModelRoute;
  instructions: string;
  input: string;
  schema: object;
  signal?: AbortSignal;
}) {
  const api = client(params.apiKey, 45000);
  const response = await api.responses.create(
    {
      model: params.route.model,
      store: false,
      max_output_tokens: params.route.maxOutputTokens,
      ...reasoningParameter(params.route),
      instructions: params.instructions,
      input: params.input,
      ...outputFormat("orbit_content", params.schema),
    },
    { signal: params.signal },
  );
  return {
    text: response.output_text,
    usage: normalizeResponsesUsage(response.usage),
    responseId: response.id ?? null,
    stop: "completed" as const,
  };
}

/** The streamed Responses events of one chat step. */
export function openAiStream(params: {
  apiKey: string;
  route: ModelRoute;
  input: unknown[];
  tools: unknown[];
  instructions: string;
  signal?: AbortSignal;
}) {
  const api = client(params.apiKey, 45000);
  return api.responses.create(
    {
      model: params.route.model,
      store: false,
      stream: true,
      max_output_tokens: params.route.maxOutputTokens,
      ...reasoningParameter(params.route),
      instructions: params.instructions,
      input: params.input as OpenAI.Responses.ResponseInput,
      tools: params.tools as OpenAI.Responses.Tool[],
      parallel_tool_calls: false,
    },
    { signal: params.signal },
  );
}

/** One non-streaming step with tools and, with `outputSchema`, a strict JSON answer. */
export async function openAiRespond(params: {
  apiKey: string;
  route: ModelRoute;
  instructions: string;
  input: unknown[];
  tools: unknown[];
  outputSchema?: object;
  maxToolCalls?: number;
  include?: OpenAI.Responses.ResponseIncludable[];
  signal?: AbortSignal;
}) {
  const api = client(params.apiKey, 60000);
  const response = await api.responses.create(
    {
      model: params.route.model,
      store: false,
      max_output_tokens: params.route.maxOutputTokens,
      ...reasoningParameter(params.route),
      instructions: params.instructions,
      input: params.input as OpenAI.Responses.ResponseInput,
      tools: params.tools as OpenAI.Responses.Tool[],
      parallel_tool_calls: false,
      ...(params.maxToolCalls !== undefined
        ? { max_tool_calls: params.maxToolCalls }
        : {}),
      ...(params.include?.length ? { include: params.include } : {}),
      ...outputFormat("orbit_agent_output", params.outputSchema),
    },
    { signal: params.signal },
  );
  return {
    output: response.output as unknown[],
    usage: normalizeResponsesUsage(response.usage),
    responseId: response.id ?? null,
    truncated:
      response.status === "incomplete" &&
      response.incomplete_details?.reason === "max_output_tokens",
  };
}

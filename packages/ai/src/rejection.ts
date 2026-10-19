import { APIError as OpenAiApiError } from "openai";
import { APIError as AnthropicApiError } from "@anthropic-ai/sdk";
import { ANTHROPIC_UNBILLED_STATUSES } from "./providers/anthropic.ts";

// HTTP statuses the API returns before any model work. Such a request is
// not billed; a stream error event has no status and stays unknown.
const REJECTED_STATUSES = new Set([400, 401, 403, 404, 422, 429]);

/** True when the provider refused the request itself, so it cost nothing. */
export function isRejectedRequest(error: unknown): boolean {
  if (error instanceof OpenAiApiError)
    return (
      typeof error.status === "number" && REJECTED_STATUSES.has(error.status)
    );
  if (error instanceof AnthropicApiError)
    return (
      typeof error.status === "number" &&
      ANTHROPIC_UNBILLED_STATUSES.has(error.status)
    );
  return false;
}

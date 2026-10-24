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

/**
 * What a provider said when it refused a request, for the call's span: the
 * status, error type and the start of the message (which names the invalid
 * request field, never prompt content), reduced to plain characters; and
 * the provider's request id. Null for anything that is not a refusal.
 */
export function rejectionDetail(
  error: unknown,
): { code: string; requestId: string | null } | null {
  if (!isRejectedRequest(error)) return null;
  const e = error as {
    status?: number;
    requestID?: string | null;
    error?: { error?: { type?: unknown; message?: unknown } };
    type?: unknown;
    message?: string;
  };
  const body = e.error?.error;
  const type = String(body?.type ?? e.type ?? "error");
  const message = String(body?.message ?? e.message ?? "");
  const text = `${e.status} ${type}: ${message}`
    .replace(/[^A-Za-z0-9 ._:/'"()[\]=<>,-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return { code: text, requestId: e.requestID ?? null };
}

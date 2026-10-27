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

/**
 * Why a provider refused a request, as a specific code for runs and the
 * people who read them (the run still cost nothing):
 * - `MODEL_RATE_LIMITED` (429) and `MODEL_OVERLOADED` (Anthropic 529) are
 *   temporary; the same request may succeed later.
 * - `MODEL_AUTH_REJECTED` (401, 403): the key or its permissions.
 * - `MODEL_NOT_AVAILABLE` (404): the model is unknown to this key.
 * - `MODEL_REQUEST_INVALID` (400, 413, 422): a request field, such as the
 *   output schema or the output limit, was refused.
 * Null for anything that is not a refusal.
 */
export function rejectionCode(error: unknown): string | null {
  if (!isRejectedRequest(error)) return null;
  const status = (error as { status?: number }).status;
  if (status === 429) return "MODEL_RATE_LIMITED";
  if (status === 529) return "MODEL_OVERLOADED";
  if (status === 401 || status === 403) return "MODEL_AUTH_REJECTED";
  if (status === 404) return "MODEL_NOT_AVAILABLE";
  if (status === 400 || status === 413 || status === 422) return "MODEL_REQUEST_INVALID";
  return "MODEL_REQUEST_NOT_ACCEPTED";
}

/** Refusal codes after which the same request may be tried again later. */
export const TEMPORARY_REJECTIONS: ReadonlySet<string> = new Set(["MODEL_RATE_LIMITED", "MODEL_OVERLOADED"]);

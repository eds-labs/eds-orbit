import { APIError } from "openai";

// HTTP statuses the API returns before any model work. Such a request is
// not billed; a stream error event has no status and stays unknown.
const REJECTED_STATUSES = new Set([400, 401, 403, 404, 422, 429]);

/** True when the provider refused the request itself, so it cost nothing. */
export function isRejectedRequest(error: unknown): boolean {
  return (
    error instanceof APIError &&
    typeof error.status === "number" &&
    REJECTED_STATUSES.has(error.status)
  );
}

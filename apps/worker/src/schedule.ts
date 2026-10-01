/** Pure scheduling helpers for the durable queue pump. */
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** Next marker value: the earliest candidate, never later than `maxIdleMs` from `at`. */
export function earliestDue(
  at: Date,
  maxIdleMs: number,
  candidates: (Date | null | undefined)[],
) {
  let due = at.valueOf() + maxIdleMs;
  for (const candidate of candidates) {
    const value = candidate?.valueOf();
    if (value !== undefined && Number.isFinite(value))
      due = Math.min(due, Math.max(value, at.valueOf()));
  }
  return new Date(due);
}

export async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

/** Error messages can carry paths, URLs or credentials; only codes and class names are logged. */
export function safeErrorCode(error: unknown) {
  if (!(error instanceof Error)) return "PUMP_FAILED";
  if (/^[A-Z0-9_]{1,100}$/.test(error.message)) return error.message;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code))
    return code;
  return /^[A-Za-z]{1,60}$/.test(error.name) ? error.name : "PUMP_FAILED";
}

/** Test-only workspace restriction so acceptance runs ignore unrelated local projects. */
export function workspaceAllowlist(
  raw: string | undefined,
  executionMode: "test" | "live",
) {
  const ids = [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  if (!ids.length) return null;
  if (executionMode !== "test")
    throw new Error("WORKER_WORKSPACE_ALLOWLIST_TEST_ONLY");
  if (!ids.every((id) => uuid.test(id)))
    throw new Error("WORKER_WORKSPACE_ALLOWLIST_INVALID");
  return ids;
}

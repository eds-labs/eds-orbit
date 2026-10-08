const terminal = new Set(["succeeded", "blocked", "failed", "canceled"]);

/**
 * The unfinished reply to follow after loading a conversation. Loaded data
 * can still belong to the conversation just left, so it must match the open
 * one.
 */
export function runToFollow<R extends { id: string; status: string }>(
  detail: { conversation: { id: string }; runs: R[] } | null,
  conversationId: string,
  activeRunId: string,
): R | null {
  if (!detail || activeRunId || detail.conversation.id !== conversationId)
    return null;
  return detail.runs.find((run) => !terminal.has(run.status)) ?? null;
}

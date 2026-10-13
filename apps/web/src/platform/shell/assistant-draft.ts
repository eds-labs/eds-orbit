// Hands a message from the project home to Orbit Chat without putting it in
// the URL. Session storage only; the chat removes it when it reads it.
const key = (projectId: string) => `orbit.assistant.draft.${projectId}`;

export function storeAssistantDraft(projectId: string, text: string) {
  try {
    sessionStorage.setItem(key(projectId), text);
  } catch {
    /* Storage may be unavailable; the chat then opens empty. */
  }
}

export function takeAssistantDraft(projectId: string): string {
  try {
    const text = sessionStorage.getItem(key(projectId)) ?? "";
    sessionStorage.removeItem(key(projectId));
    return text;
  } catch {
    return "";
  }
}

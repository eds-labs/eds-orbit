const texts: Record<string, [string, string]> = {
  PROJECT_PAUSED: [
    "The project is paused; Orbit answers again once it is resumed under Operations.",
    "Das Projekt ist pausiert; Orbit antwortet erst wieder, wenn es unter Betrieb fortgesetzt wird.",
  ],
};

// Codes the user can act on read as a sentence; others stay as codes.
export function chatErrorText(code: string | null, de: boolean) {
  if (!code) return "—";
  return texts[code]?.[de ? 1 : 0] ?? code;
}

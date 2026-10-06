import { describe, expect, it } from "vitest";
import { chatErrorText } from "./chat-errors";

describe("chat error text", () => {
  it("tells the user how to continue when the project is paused", () => {
    expect(chatErrorText("PROJECT_PAUSED", true)).toBe(
      "Das Projekt ist pausiert; Orbit antwortet erst wieder, wenn es unter Betrieb fortgesetzt wird.",
    );
    expect(chatErrorText("PROJECT_PAUSED", false)).toBe(
      "The project is paused; Orbit answers again once it is resumed under Operations.",
    );
  });

  it("keeps other codes as they are", () => {
    expect(chatErrorText("CHAT_TOOL_LIMIT", true)).toBe("CHAT_TOOL_LIMIT");
    expect(chatErrorText(null, true)).toBe("—");
  });
});

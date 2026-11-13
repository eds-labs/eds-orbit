import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { chatErrorOf, chatErrorText } from "./chat-errors";

// Every CHAT_* code the API and worker raise (apps/api/src/platform/assistant,
// marketing proposals, knowledge search) and the personal assistant's codes.
const CODES = [
  "CHAT_FAILED",
  "CHAT_CANCELED",
  "CHAT_RUN_IN_PROGRESS",
  "CHAT_TOOL_LIMIT",
  "CHAT_MAX_TOOL_CALLS",
  "CHAT_MAX_MODEL_CALLS",
  "CHAT_MAX_INPUT_BYTES",
  "CHAT_CONTEXT_LIMIT",
  "CHAT_MAX_OUTPUT_CHARS",
  "CHAT_OUTPUT_LIMIT",
  "CHAT_MODEL_OUTPUT_LIMIT",
  "CHAT_MODEL_INCOMPLETE",
  "CHAT_MODEL_FAILED",
  "CHAT_MODEL_CONTENT_FILTER",
  "CHAT_OUTCOME_UNKNOWN",
  "CHAT_TOOL_NOT_ALLOWED",
  "CHAT_TOOL_RESULT_LIMIT",
  "CHAT_EVIDENCE_CHANGED",
  "CHAT_ROUTE_CHANGED",
  "CHAT_PROPOSAL_COST_EXCEEDED",
  "CHAT_PROPOSAL_IMMUTABLE",
  "CHAT_PUBLISHING_FORBIDDEN",
  "ASSISTANT_DISABLED",
  "ASSISTANT_DISABLED_FOR_MEMBER",
  "ASSISTANT_ENTITLEMENT",
  "PROJECT_FORBIDDEN",
  "MODULE_DISABLED",
  "CROSS_PROJECT_CONTEXT",
  "PERSONAL_CONTEXT_NOT_ALLOWED",
  "PERSONAL_SPACE_SPEND_READ_ONLY",
  "AI_BUDGET_EXCEEDED",
  "POLICY_REQUIRED",
];

describe("chat error text", () => {
  it("tells the user how to continue when the project is paused", () => {
    expect(chatErrorText("PROJECT_PAUSED", true)).toBe(
      "Das Projekt ist pausiert; Orbit antwortet erst wieder, wenn es unter Betrieb fortgesetzt wird.",
    );
    expect(chatErrorText("PROJECT_PAUSED", false)).toBe(
      "The project is paused; Orbit answers again once it is resumed under Operations.",
    );
  });

  it("has a German and an English sentence for every code", () => {
    for (const code of CODES) {
      for (const de of [true, false]) {
        const text = chatErrorText(code, de, true);
        expect(text, code).not.toBe(code);
        expect(text, code).toMatch(/[.!?]$/);
      }
      expect(chatErrorText(code, true)).not.toBe(chatErrorText(code, false));
    }
  });

  it("reads POLICY_REQUIRED as the missing assistant budget in the personal space", () => {
    expect(chatErrorText("POLICY_REQUIRED", true, true)).toBe(
      "Persönliches Assistentenbudget der Organisation nicht gesetzt. Projektbudgets gelten nicht für den persönlichen Assistenten; nur Organisations-Owner legen dieses Budget fest.",
    );
    expect(chatErrorText("POLICY_REQUIRED", false, true)).toContain(
      "Project budgets do not fund the personal assistant",
    );
    expect(chatErrorText("POLICY_REQUIRED", false)).toContain(
      "No AI spending authority for this project",
    );
  });

  it("never names a project budget for a personal BUDGET_NOT_APPROVED (cap 0 or too small)", () => {
    for (const de of [true, false]) {
      const text = chatErrorText("BUDGET_NOT_APPROVED", de, true);
      expect(text).not.toMatch(/Projekt|project/);
      expect(text).toMatch(de ? /Organisations-Owner/ : /organization owners/);
      expect(text).toMatch(/2 USD|USD 2/);
    }
    // The project chat keeps the project text.
    expect(chatErrorText("BUDGET_NOT_APPROVED", true)).toContain("Projekt");
  });

  it("maps every AI_BUDGET_* code, keeping the budget layer's own texts", () => {
    expect(chatErrorText("ISSUES_AI_BUDGET_EXHAUSTED", true, true)).toBe(
      "Dein monatliches Assistenten-Budget ist aufgebraucht.",
    );
    expect(chatErrorText("ORG_AI_BUDGET_EXCEEDED", false, true)).toBe(
      "The organization's monthly AI budget is used up.",
    );
  });

  it("accepts ApiError messages with spaces and keeps unknown codes", () => {
    expect(chatErrorText("CHAT TOOL LIMIT", false)).toBe(
      chatErrorText("CHAT_TOOL_LIMIT", false),
    );
    expect(
      chatErrorOf(new ApiError("PERSONAL_CONTEXT_NOT_ALLOWED", 400), true),
    ).toContain("Das kann nicht gemerkt werden");
    expect(chatErrorText("SOMETHING_ELSE", true)).toBe("SOMETHING_ELSE");
    expect(chatErrorText(null, true)).toBe("—");
  });
});

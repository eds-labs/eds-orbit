import { describe, expect, it } from "vitest";
import {
  aiErrorText,
  presetName,
  shownAiTasks,
  taskRoutesFrom,
} from "./ai-presets";
import { budgetRefusalText } from "./budget-refusals";

describe("taskRoutesFrom", () => {
  it("keeps chosen tasks only, with the previous route or the task's default tokens", () => {
    expect(
      taskRoutesFrom(
        {
          "task-chat_operator": "claude-sonnet-5-5",
          "task-support_triage": "gpt-6-luna",
          "task-draft_blog": "",
        },
        {
          chat_operator: {
            model: "claude-sonnet-5-5",
            reasoningEffort: "high",
            maxOutputTokens: 2000,
          },
          support_triage: { model: "claude-haiku-5-5", maxOutputTokens: 900 },
        },
      ),
    ).toEqual({
      chat_operator: {
        model: "claude-sonnet-5-5",
        reasoningEffort: "high",
        maxOutputTokens: 2000,
      },
      // A new model drops the old effort but keeps the token limit.
      support_triage: { model: "gpt-6-luna", maxOutputTokens: 900 },
    });
    expect(taskRoutesFrom({ "task-finance_extraction": "gpt-6-luna" })).toEqual({
      finance_extraction: { model: "gpt-6-luna", maxOutputTokens: 4000 },
    });
  });
});

describe("AI preset wording", () => {
  it("names presets and explains error codes, spaced or not", () => {
    expect(presetName({ provider: "anthropic", level: "balanced" }, "de")).toBe(
      "Claude · Ausgewogen",
    );
    expect(aiErrorText("PRESET MODEL INACTIVE", "en")).toMatch(/switched off/);
    expect(aiErrorText("SOMETHING_ELSE", "de")).toBe("SOMETHING_ELSE");
    expect(aiErrorText(null, "de")).toBeNull();
  });
});

describe("budget refusals", () => {
  it("names the layer that stopped a call", () => {
    expect(budgetRefusalText("ORG_AI_BUDGET_EXCEEDED", true)).toMatch(/Organisation/);
    expect(budgetRefusalText("BUDGET EXCEEDED", false)).toMatch(/project's AI budget/);
    expect(budgetRefusalText("MODEL_OUTPUT_NOT_VALID", true)).toBeNull();
    // The AI settings fall back to the refusal texts.
    expect(aiErrorText("ORG_PROVIDER_BUDGET_EXCEEDED", "en")).toMatch(/cap for this provider/);
  });
});

// CS-D6 (R64): the Creative Studio's vision review is a task only while it is on.
describe("shownAiTasks", () => {
  it("offers the creative vision review only with the Creative Studio on", () => {
    const ids = (features?: Record<string, boolean>) =>
      shownAiTasks(features).map((task) => task.id);
    expect(ids()).not.toContain("creative_review");
    expect(ids({ creativeStudio: false })).not.toContain("creative_review");
    expect(ids({ creativeStudio: true })).toContain("creative_review");
    expect(ids()).toContain("issue_triage");
  });
});

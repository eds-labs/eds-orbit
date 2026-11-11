import { describe, expect, it } from "vitest";
import {
  aiErrorText,
  presetName,
  shownAiTasks,
  taskRoutesFrom,
  withStoredOption,
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

// F-8 risk 3: a form saves only the routes it shows.
describe("taskRoutesFrom without a field", () => {
  it("keeps the route of a task the form shows no field for", () => {
    const current = { creative_review: { model: "m1", maxOutputTokens: 1500 } };
    expect(taskRoutesFrom({ "task-chat_operator": "m2" }, current)).toEqual({
      creative_review: current.creative_review,
      chat_operator: { model: "m2", maxOutputTokens: 3000 },
    });
    expect(taskRoutesFrom({ "task-creative_review": "" }, current)).toEqual({}); // shown and cleared
  });

  it("keeps the stored route of a task class the web list does not know", () => {
    const current = {
      future_task: { model: "m9", maxOutputTokens: 700 },
      chat_operator: { model: "m1", maxOutputTokens: 3000 },
    };
    expect(taskRoutesFrom({ "task-chat_operator": "" }, current)).toEqual({
      future_task: current.future_task,
    });
  });
});

// A stored value that is no longer offered stays selectable, so an untouched
// save keeps it instead of falling back to the first option.
describe("withStoredOption", () => {
  const options = [
    { value: "", label: "None" },
    { value: "a", label: "A" },
  ];
  it("appends a stored value that is not among the options", () => {
    expect(withStoredOption(options, "old")).toEqual([...options, { value: "old", label: "old" }]);
  });
  it("leaves the options alone for an offered or empty value", () => {
    expect(withStoredOption(options, "a")).toEqual(options);
    expect(withStoredOption(options, "")).toEqual(options);
    expect(withStoredOption(options, undefined)).toEqual(options);
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

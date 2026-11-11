import { describe, expect, it } from "vitest";
import {
  budgetStepFields,
  routingFrom,
  wizardSteps,
  type ModelChoiceView,
} from "./ai-model-choice";

const t = {
  budget: "Budget for paid AI",
  budgets: { off: "Off", "10": "USD 10", "50": "USD 50" },
};

// F-8 risk 3: switching per-task models off clears only the shown tasks.
describe("routingFrom", () => {
  it("keeps hidden overrides when per-task models are switched off", () => {
    const view = {
      routing: {
        source: "organization",
        overrides: { creative_review: { model: "m1", maxOutputTokens: 1500 } },
      },
      providers: { anthropic: { keyConfigured: true }, openai: { keyConfigured: false } },
    } as ModelChoiceView;
    expect(
      routingFrom({ source: "organization", advanced: "no", "task-chat_operator": "" }, view),
    ).toEqual({
      source: "organization",
      overrides: { creative_review: { model: "m1", maxOutputTokens: 1500 } },
    });
  });
});

// F-8 risk 5: the setup never writes a spending authority by preselection.
describe("setup wizard", () => {
  it("offers the budget step only to a project without an authority (risk 5)", () => {
    expect(wizardSteps({ keyReady: true, policy: { record: { id: "r" }, source: "platform" } })).toEqual(["models"]);
    expect(wizardSteps({ keyReady: false, policy: { record: null, source: "none" } })).toEqual(["key", "models", "budget"]);
    expect(wizardSteps({ keyReady: true, policy: null })).toEqual(["models"]);
    expect(wizardSteps({ keyReady: true, policy: { record: null, source: "marketing_policy" } })).toEqual(["models"]);
  });

  it("preselects no budget (risk 5)", () => {
    expect(budgetStepFields(t)[0]).toMatchObject({ name: "profile", value: "", required: true });
    expect(budgetStepFields(t)[0]!.options?.map((o) => o.value)).toEqual(["off", "10", "50"]);
  });
});

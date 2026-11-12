import { describe, expect, it } from "vitest";
import type { FormField, FormValues } from "@/platform/ui/form";
import {
  budgetStepFields,
  choiceSubmit,
  modelChoiceFields,
  routingFrom,
  wizardSteps,
  type ModelChoiceView,
} from "./ai-model-choice";

// What an untouched form submits: an uncontrolled select whose default value
// has no matching option shows (and submits) its first option.
function untouched(fields: FormField[]): FormValues {
  return Object.fromEntries(
    fields.map((f) => {
      const value = String(f.value ?? "");
      if (f.type !== "select") return [f.name, value];
      const offered = f.options?.some((o) => o.value === value);
      return [f.name, offered ? value : (f.options?.[0]?.value ?? "")];
    }),
  );
}

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

const tiers = { fast: "f", standard: "s", quality: "q" };
const presets = {
  anthropic: { economy: tiers, balanced: tiers, quality: tiers },
  openai: { economy: tiers, balanced: tiers, quality: tiers },
};

// Review I4: an override whose model is no longer an active catalog text
// model stays selected and survives an untouched save.
describe("model choice form", () => {
  const view = {
    routing: {
      source: "preset",
      provider: "openai",
      level: "balanced",
      overrides: { chat_operator: { model: "text-old", maxOutputTokens: 2000 } },
    },
    defaults: { standard: null, presets },
    catalog: [
      { id: "text-new", purpose: "text", displayName: "Text", active: true },
      { id: "text-old", purpose: "text", displayName: "Old text", active: false },
    ],
    providers: { anthropic: { keyConfigured: false }, openai: { keyConfigured: true } },
  } as ModelChoiceView;

  it("keeps an inactive stored task model selected", () => {
    const task = modelChoiceFields(view, "en", { custom: true, advanced: true }).find(
      (f) => f.name === "task-chat_operator",
    )!;
    expect(task.value).toBe("text-old");
    expect(task.options?.map((o) => o.value)).toContain("text-old");
  });

  it("saves it unchanged when the form is submitted untouched", () => {
    const values = untouched(modelChoiceFields(view, "en", { custom: true, advanced: true }));
    expect(routingFrom(values, view)).toEqual({
      source: "preset",
      provider: "openai",
      level: "balanced",
      overrides: { chat_operator: { model: "text-old", maxOutputTokens: 2000 } },
    });
  });
});

// Review I2: the model choice and the wizard's models step send nothing
// until the first-save confirmation allows it.
describe("choiceSubmit", () => {
  const view = {
    routing: null,
    defaults: { standard: null, presets },
    providers: { anthropic: { keyConfigured: true }, openai: { keyConfigured: false } },
  } as ModelChoiceView;
  const values = { source: "preset", provider: "anthropic", level: "balanced" };

  it("sends no request while the confirmation refuses", () => {
    expect(choiceSubmit(values, view, () => false)).toBeNull();
  });

  it("sends the routing once the confirmation allows it", () => {
    expect(choiceSubmit(values, view, () => true)).toEqual({
      routing: { source: "preset", provider: "anthropic", level: "balanced", overrides: {} },
    });
  });

  it("asks the confirmation with the submitted values", () => {
    const seen: FormValues[] = [];
    choiceSubmit(values, view, (v) => (seen.push(v), true));
    expect(seen).toEqual([values]);
  });
});

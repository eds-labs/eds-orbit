import { describe, expect, it } from "vitest";
import type { AiDefaults, PresetTiers } from "@/lib/ai-presets";
import type { FormField, FormValues } from "@/platform/ui/form";
import { defaultsFields, defaultsPayload } from "./ai-defaults-ui";

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

// F-8 risk 3: the organization's and the system's standard keep the route of
// a task the form does not show (the Creative Studio's while it is off).
describe("defaultsPayload", () => {
  it("keeps a hidden task route of the standard", () => {
    const current: AiDefaults = {
      provider: "anthropic",
      level: "balanced",
      taskRoutes: { creative_review: { model: "m1", maxOutputTokens: 1500 } },
    };
    expect(
      defaultsPayload({ provider: "anthropic", level: "balanced", imageModel: "", advanced: "no" }, current)
        .taskRoutes,
    ).toEqual(current.taskRoutes);
  });

  it("drops a shown route that was cleared and keeps the image model", () => {
    const current: AiDefaults = {
      provider: "openai",
      level: "quality",
      taskRoutes: { chat_operator: { model: "m2", maxOutputTokens: 2000 } },
    };
    expect(
      defaultsPayload(
        { provider: "openai", level: "quality", imageModel: "img-1", advanced: "yes", "task-chat_operator": "" },
        current,
      ),
    ).toEqual({ provider: "openai", level: "quality", imageModel: "img-1", taskRoutes: {} });
  });
});

// Review I4: a stored image or task model that is no longer active stays
// selected and survives an untouched save.
describe("standard models form", () => {
  const tiers: PresetTiers = { fast: "f", standard: "s", quality: "q" };
  const presets = {
    anthropic: { economy: tiers, balanced: tiers, quality: tiers },
    openai: { economy: tiers, balanced: tiers, quality: tiers },
  };
  const current: AiDefaults = {
    provider: "openai",
    level: "balanced",
    imageModel: "img-old",
    taskRoutes: { chat_operator: { model: "text-old", maxOutputTokens: 2000 } },
  };
  const catalog = [
    { id: "img-new", provider: "openai" as const, purpose: "image" as const, displayName: "New", active: true },
    { id: "img-old", provider: "openai" as const, purpose: "image" as const, displayName: "Old", active: false },
    { id: "text-new", provider: "openai" as const, purpose: "text" as const, displayName: "Text", active: true },
    { id: "text-old", provider: "openai" as const, purpose: "text" as const, displayName: "Old text", active: false },
  ];

  it("keeps an inactive stored image model and task model selected", () => {
    const fields = defaultsFields({ enabled: true, defaults: current, presets }, catalog, "en");
    const image = fields.find((f) => f.name === "imageModel")!;
    expect(image.value).toBe("img-old");
    expect(image.options?.map((o) => o.value)).toContain("img-old");
    const task = fields.find((f) => f.name === "task-chat_operator")!;
    expect(task.value).toBe("text-old");
    expect(task.options?.map((o) => o.value)).toContain("text-old");
  });

  it("saves them unchanged when the form is submitted untouched", () => {
    const fields = defaultsFields({ enabled: true, defaults: current, presets }, catalog, "en");
    expect(defaultsPayload(untouched(fields), current)).toEqual(current);
  });
});

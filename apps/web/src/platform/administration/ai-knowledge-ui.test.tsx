import { describe, expect, it } from "vitest";
import type { FormValues } from "@/platform/ui/form";
import { profileFields, profilePayload } from "./ai-knowledge-ui";

// A stored profile with every field the editor shows.
const stored = {
  defaultProvider: "anthropic" as const,
  verifiedModels: ["gpt-5.6-luna", "gpt-5.6-terra"],
  modelRoutes: {
    fast: "gpt-5.6-luna",
    standard: "gpt-5.6-luna",
    quality: "gpt-5.6-terra",
    escalation: "gpt-5.6-terra",
  },
  anthropicTierRoutes: {
    fast: "claude-haiku-5-5",
    standard: "claude-sonnet-5-5",
    quality: "claude-opus-5-5",
  },
  rateCard: {
    "gpt-5.6-luna": { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 },
  },
  providerBudgets: { openai: { monthlyMicros: 5_000_000 } },
  taskRoutes: { support_triage: { model: "gpt-5.6-luna", maxOutputTokens: 800 } },
};
const STANDARD = { provider: "anthropic", level: "balanced", taskRoutes: {} };
// The form as it opens on `stored`: what a member submits without editing.
const untouched: FormValues = Object.fromEntries(
  profileFields(stored, "en").map((f) => [f.name, String(f.value ?? "")]),
);

describe("the AI profile editor's payload (settings center phase 4, risk 7)", () => {
  it("refuses a half-filled route set instead of removing the routes (risk 7)", () => {
    expect(profilePayload(stored, { ...untouched, fast: "" })).toEqual({
      error: "PROFILE_ROUTES_INCOMPLETE",
    });
  });

  it("refuses a half-filled Claude tier set", () => {
    expect(profilePayload(stored, { ...untouched, claudeQuality: "" })).toEqual({
      error: "PROFILE_TIERS_INCOMPLETE",
    });
  });

  it("removes the routes only when all four are cleared", () => {
    const r = profilePayload(stored, {
      ...untouched,
      fast: "",
      standard: "",
      quality: "",
      escalation: "",
    });
    expect(r).toMatchObject({
      payload: expect.not.objectContaining({ modelRoutes: expect.anything() }),
    });
    expect(r).toMatchObject({ payload: { anthropicTierRoutes: stored.anthropicTierRoutes } });
  });

  it("resends what the form does not show, the standard included", () => {
    const r = profilePayload(
      { ...stored, defaults: STANDARD, fallback: { onProviderBudgetStop: "openai" } },
      untouched,
    );
    expect(r).toEqual({
      payload: { ...stored, defaults: STANDARD, fallback: { onProviderBudgetStop: "openai" } },
    });
  });

  it("refuses a rate card that is not JSON", () => {
    expect(profilePayload(stored, { ...untouched, rateCard: "{" })).toEqual({
      error: "PROFILE_JSON_INVALID",
    });
  });
});

import { describe, expect, it } from "vitest";
import { textModelReady } from "./openai-configuration.ts";

// Chat and text drafting count as ready on a verified OpenAI key, as
// before, or on Claude routes with an Anthropic key (FamilyPlan's setup).

const route = (provider: "openai" | "anthropic", price = "current") => ({
  model: provider === "anthropic" ? "claude-sonnet-5-5" : "gpt-test",
  provider,
  price,
});
const claude = {
  textKeyConfigured: false,
  anthropicKeyConfigured: true,
  verifiedModels: ["claude-sonnet-5-5"],
  effectiveRoutes: {
    chat_operator: route("anthropic"),
    draft_social: route("anthropic"),
  },
};

describe("textModelReady", () => {
  it("keeps the OpenAI rule unchanged", () => {
    expect(
      textModelReady({
        textKeyConfigured: true,
        anthropicKeyConfigured: false,
        verifiedModels: ["gpt-test"],
      }),
    ).toBe(true);
    expect(
      textModelReady({
        textKeyConfigured: true,
        anthropicKeyConfigured: false,
        verifiedModels: [],
      }),
    ).toBe(false);
  });

  it("counts a project whose chat and draft routes are priced Claude models with a key", () => {
    expect(textModelReady(claude)).toBe(true);
  });

  it("needs the Anthropic key, a price and a resolving route for every text task", () => {
    expect(textModelReady({ ...claude, anthropicKeyConfigured: false })).toBe(false);
    expect(
      textModelReady({
        ...claude,
        effectiveRoutes: { ...claude.effectiveRoutes, draft_social: route("anthropic", "missing") },
      }),
    ).toBe(false);
    expect(
      textModelReady({
        ...claude,
        effectiveRoutes: {
          ...claude.effectiveRoutes,
          chat_operator: { error: "MODEL_CAPABILITY_NOT_VERIFIED" },
        },
      }),
    ).toBe(false);
    // An OpenAI route without an OpenAI key does not count.
    expect(
      textModelReady({
        ...claude,
        effectiveRoutes: { ...claude.effectiveRoutes, draft_social: route("openai") },
      }),
    ).toBe(false);
    expect(textModelReady({ ...claude, effectiveRoutes: undefined })).toBe(false);
  });
});

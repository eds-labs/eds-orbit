import { describe, expect, it } from "vitest";
import {
  publicOpenAiConfiguration,
  routesWithoutKey,
  textModelReady,
} from "./openai-configuration.ts";

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

  it("does not let an OpenAI key stand in for Claude routes without an Anthropic key", () => {
    expect(
      textModelReady({
        ...claude,
        textKeyConfigured: true,
        anthropicKeyConfigured: false,
        verifiedModels: ["gpt-test", "claude-sonnet-5-5"],
      }),
    ).toBe(false);
  });
});

describe("publicOpenAiConfiguration provider status", () => {
  const environment = {
    apiKey: "sk-environment-openai",
    anthropicApiKey: "sk-ant-environment",
    verifiedModels: [],
    rateCard: {},
  };
  const saved = {
    version: 3,
    data: {
      verifiedModels: ["claude-sonnet-5-5"],
      rateCard: {},
      modelRoutes: {
        fast: "gpt-5.6-luna",
        standard: "gpt-5.6-terra",
        quality: "gpt-5.6-sol",
        escalation: "gpt-6-astra",
      },
      updatedBy: "owner",
      updatedAt: new Date().toISOString(),
    },
  };

  it("counts the environment OpenAI key only while nothing is saved, as the runtime does", () => {
    expect(publicOpenAiConfiguration(null, environment).providers.openai).toEqual({
      keyConfigured: true,
      source: "environment",
    });
    // EDS-Labs/FamilyPlan: a saved configuration without an OpenAI key.
    const view = publicOpenAiConfiguration(saved, environment);
    expect(view.providers.openai).toEqual({ keyConfigured: false, source: "none" });
    expect(view.textKeyConfigured).toBe(false);
    // The runtime keeps the environment Anthropic key after a save.
    expect(view.providers.anthropic).toEqual({
      keyConfigured: true,
      source: "environment",
    });
  });
});

describe("routesWithoutKey", () => {
  it("lists the task classes routed to a provider without a key", () => {
    const status = {
      textKeyConfigured: false,
      anthropicKeyConfigured: true,
      effectiveRoutes: {
        chat_operator: route("anthropic"),
        draft_blog: route("openai"),
        support_triage: route("openai", "missing"),
        draft_social: { error: "MODEL_CAPABILITY_NOT_VERIFIED" },
      },
    };
    // Unverified routes fail for their own reason and are not listed.
    expect(routesWithoutKey(status)).toEqual(["draft_blog", "support_triage"]);
    expect(routesWithoutKey({ ...status, textKeyConfigured: true })).toEqual([]);
    expect(
      routesWithoutKey({ ...status, anthropicKeyConfigured: false, textKeyConfigured: true }),
    ).toEqual(["chat_operator"]);
  });
});

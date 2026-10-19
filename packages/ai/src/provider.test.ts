import { describe, expect, it } from "vitest";
import {
  anthropicCatalog,
  anthropicCatalogRateCard,
  anthropicCatalogRegistry,
  providerCallName,
  providerOfModel,
} from "./provider.ts";
import {
  DEFAULT_ANTHROPIC_BUDGET,
  providerBudgetLevel,
  providerBudgetSchema,
  providerPeriod,
} from "./provider-budget.ts";
import { rateCardSchema } from "./cost.ts";
import { resolveRoute } from "./routing.ts";

describe("provider of a model", () => {
  it("reads the registry first, then the claude- prefix, else OpenAI", () => {
    expect(providerOfModel("claude-haiku-5-5")).toBe("anthropic");
    expect(providerOfModel("gpt-5.6-terra")).toBe("openai");
    expect(providerOfModel("text-embedding-3-small")).toBe("openai");
    expect(
      providerOfModel("my-claude", { "my-claude": { provider: "openai" } }),
    ).toBe("openai");
    expect(
      providerOfModel("custom", { custom: { provider: "anthropic" } }),
    ).toBe("anthropic");
  });
  it("names spans per provider", () => {
    expect(providerCallName("openai", "stream")).toBe("responses.stream");
    expect(providerCallName("anthropic", "create")).toBe("messages.create");
  });
  it("ships the suggested Claude catalog as a valid, dated rate card and registry", () => {
    const card = rateCardSchema.parse(anthropicCatalogRateCard());
    expect(Object.keys(card)).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
    ]);
    for (const rate of Object.values(card)) {
      expect(rate.verifiedAt).toBe(anthropicCatalog.verifiedAt);
      // Cache reads are cheaper than input, writes 1.25x input (5-minute cache).
      expect(rate.cachedInputMicrosPerMillion!).toBeLessThan(
        rate.inputMicrosPerMillion,
      );
      expect(rate.cacheWriteMicrosPerMillion).toBe(
        Math.round(rate.inputMicrosPerMillion * 1.25),
      );
    }
    expect(anthropicCatalogRegistry()["claude-opus-5-5"]).toMatchObject({
      provider: "anthropic",
      displayName: "Claude Opus 5.5",
    });
    expect(anthropicCatalog.sources[1]).toMatch(/pricing/);
  });
});

describe("routes with a second provider", () => {
  const runtime = {
    verifiedModels: [
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-haiku-5-5",
    ],
    anthropicTierRoutes: {
      fast: "claude-haiku-5-5",
      standard: "claude-sonnet-5-5",
      quality: "claude-opus-5-5",
    },
  };
  it("keeps the OpenAI tiers unless the default provider is Anthropic", () => {
    expect(resolveRoute("chat_operator", runtime).model).toBe("gpt-5.6-terra");
    expect(
      resolveRoute("chat_operator", {
        ...runtime,
        defaultProvider: "anthropic" as const,
      }).model,
    ).toBe("claude-sonnet-5-5");
    expect(
      resolveRoute("draft_blog", {
        ...runtime,
        defaultProvider: "anthropic" as const,
      }).model,
    ).toBe("claude-opus-5-5");
  });
  it("ignores the Anthropic default without saved Anthropic tiers", () => {
    expect(
      resolveRoute("chat_operator", {
        verifiedModels: ["gpt-5.6-terra"],
        defaultProvider: "anthropic" as const,
      }).model,
    ).toBe("gpt-5.6-terra");
  });
  it("forces a provider's tier for the budget fallback and ignores the task route then", () => {
    const withRoute = {
      ...runtime,
      defaultProvider: "anthropic" as const,
      taskRoutes: {
        chat_operator: { model: "claude-opus-5-5", maxOutputTokens: 3000 },
      },
    };
    expect(resolveRoute("chat_operator", withRoute).model).toBe(
      "claude-opus-5-5",
    );
    expect(
      resolveRoute("chat_operator", withRoute, { provider: "openai" }).model,
    ).toBe("gpt-5.6-terra");
    expect(() =>
      resolveRoute(
        "chat_operator",
        { verifiedModels: ["claude-sonnet-5-5"] },
        { provider: "anthropic" },
      ),
    ).toThrow("MODEL_CAPABILITY_NOT_VERIFIED");
  });
  it("refuses an effort of none on a Claude model at resolution time", () => {
    expect(() =>
      resolveRoute("chat_operator", {
        ...runtime,
        taskRoutes: {
          chat_operator: {
            model: "claude-sonnet-5-5",
            reasoningEffort: "none" as const,
            maxOutputTokens: 3000,
          },
        },
      }),
    ).toThrow("ROUTE_EFFORT_UNSUPPORTED");
    expect(
      resolveRoute("chat_operator", {
        ...runtime,
        taskRoutes: {
          chat_operator: {
            model: "gpt-5.6-terra",
            reasoningEffort: "none" as const,
            maxOutputTokens: 3000,
          },
        },
      }).reasoningEffort,
    ).toBe("none");
  });
});

describe("provider budget periods and levels", () => {
  it("starts the period on the anchor day of this or the previous month (UTC)", () => {
    expect(providerPeriod(15, new Date("2026-10-19T10:00:00Z"))).toEqual({
      start: new Date("2026-10-15T00:00:00Z"),
      end: new Date("2026-11-15T00:00:00Z"),
    });
    expect(providerPeriod(20, new Date("2026-10-19T23:59:59Z"))).toEqual({
      start: new Date("2026-09-20T00:00:00Z"),
      end: new Date("2026-10-20T00:00:00Z"),
    });
    expect(providerPeriod(1, new Date("2026-01-01T00:00:00Z"))).toEqual({
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-02-01T00:00:00Z"),
    });
  });
  it("classifies spend against the thresholds", () => {
    const budget = DEFAULT_ANTHROPIC_BUDGET;
    expect(providerBudgetLevel(budget, 0)).toBe("ok");
    expect(providerBudgetLevel(budget, 74_999_999)).toBe("ok");
    expect(providerBudgetLevel(budget, 75_000_000)).toBe("warn");
    expect(providerBudgetLevel(budget, 90_000_000)).toBe("warn2");
    expect(providerBudgetLevel(budget, 95_000_000)).toBe("stopped");
  });
  it("validates ordered thresholds and the anchor day", () => {
    expect(providerBudgetSchema.parse(DEFAULT_ANTHROPIC_BUDGET)).toEqual(
      DEFAULT_ANTHROPIC_BUDGET,
    );
    expect(() =>
      providerBudgetSchema.parse({
        ...DEFAULT_ANTHROPIC_BUDGET,
        stopMicros: 99_000_000,
        warn2Micros: 99_500_000,
      }),
    ).toThrow(/PROVIDER_BUDGET_THRESHOLDS_INVALID/);
    expect(() =>
      providerBudgetSchema.parse({
        ...DEFAULT_ANTHROPIC_BUDGET,
        anchorDay: 31,
      }),
    ).toThrow();
  });
});

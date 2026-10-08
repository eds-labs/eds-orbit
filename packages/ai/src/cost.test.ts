import { describe, expect, it } from "vitest";
import { computeCost, DEFAULT_WEB_SEARCH_MICROS_PER_CALL, estimateCost, normalizeResponsesUsage, rateStatus, webSearchFee } from "./cost.ts";

const verifiedAt = new Date().toISOString();
const runtime = (rate: Record<string, unknown>) => ({
  verifiedModels: ["m"],
  rateCard: { m: { verifiedAt, ...rate } },
}) as any;
const base = { inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 12_000_000 };

describe("normalizeResponsesUsage", () => {
  it("reads cache and reasoning details", () => {
    expect(
      normalizeResponsesUsage({
        input_tokens: 1000,
        output_tokens: 200,
        input_tokens_details: { cached_tokens: 300, cache_write_tokens: 500 },
        output_tokens_details: { reasoning_tokens: 50 },
      }),
    ).toEqual({ inputTokens: 1000, cachedTokens: 300, cacheWriteTokens: 500, outputTokens: 200, reasoningTokens: 50, detailsKnown: true });
  });
  it("marks missing details as unknown", () => {
    expect(normalizeResponsesUsage({ input_tokens: 100, output_tokens: 30 })).toMatchObject({ cachedTokens: 0, cacheWriteTokens: 0, detailsKnown: false });
  });
  it("accepts null detail objects and counts as unknown details", () => {
    const unknown = { cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, detailsKnown: false };
    expect(normalizeResponsesUsage({ input_tokens: 10, output_tokens: 2, input_tokens_details: null, output_tokens_details: null })).toMatchObject(unknown);
    expect(normalizeResponsesUsage({ input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4, cache_write_tokens: null } })).toMatchObject({ cachedTokens: 4, cacheWriteTokens: 0, detailsKnown: false });
    expect(normalizeResponsesUsage({ input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: null, cache_write_tokens: 3 } })).toMatchObject({ cachedTokens: 0, cacheWriteTokens: 3, detailsKnown: false });
    expect(normalizeResponsesUsage({ input_tokens: 10, output_tokens: 2, output_tokens_details: { reasoning_tokens: null } })).toMatchObject({ reasoningTokens: 0 });
  });
  it("treats partial details (only cached_tokens) as unknown", () => {
    expect(normalizeResponsesUsage({ input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } })).toMatchObject({ cachedTokens: 4, detailsKnown: false });
  });
  it("rejects usage without token counts", () => {
    expect(() => normalizeResponsesUsage({ output_tokens: 3 })).toThrow("USAGE_UNKNOWN");
    expect(() => normalizeResponsesUsage(null)).toThrow("USAGE_UNKNOWN");
  });
});

describe("computeCost", () => {
  it("applies the documented formula with explicit cache prices", () => {
    const usage = { inputTokens: 1_000_000, cachedTokens: 200_000, cacheWriteTokens: 300_000, outputTokens: 100_000, reasoningTokens: 40_000, detailsKnown: true };
    // ordinary 500k*2 + cached 200k*0.2 + write 300k*2.5 + output 100k*12 = 1.0+0.04+0.75+1.2 USD
    expect(computeCost("m", usage, runtime({ ...base, cachedInputMicrosPerMillion: 200_000, cacheWriteMicrosPerMillion: 2_500_000 }))).toBe(2_990_000);
  });
  it("defaults cached reads to the input rate and writes to 1.25x input", () => {
    const usage = { inputTokens: 1_000_000, cachedTokens: 200_000, cacheWriteTokens: 300_000, outputTokens: 0, reasoningTokens: 0, detailsKnown: true };
    // 500k*2 + 200k*2 + 300k*2.5 = 1.0+0.4+0.75
    expect(computeCost("m", usage, runtime(base))).toBe(2_150_000);
  });
  it("charges all input at the cache-write rate when details are unknown", () => {
    const usage = { inputTokens: 1_000_000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, detailsKnown: false };
    expect(computeCost("m", usage, runtime(base))).toBe(2_500_000);
  });
  it("never settles above the estimate for any details split when cached reads cost more than input", () => {
    const rt = runtime({ ...base, cachedInputMicrosPerMillion: 4_000_000, cacheWriteMicrosPerMillion: 2_500_000 });
    const estimate = estimateCost("m", 1_000_000, 0, rt);
    for (const cachedTokens of [0, 250_000, 500_000, 1_000_000]) {
      const cacheWriteTokens = 1_000_000 - cachedTokens;
      const settled = computeCost("m", { inputTokens: 1_000_000, cachedTokens, cacheWriteTokens, outputTokens: 0, reasoningTokens: 0, detailsKnown: true }, rt);
      expect(estimate).toBeGreaterThanOrEqual(settled);
    }
    expect(estimate).toBe(4_000_000);
  });
  it("rounds up and never returns zero", () => {
    const usage = { inputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, detailsKnown: true };
    // 1 token * 0.1 USD/M = 0.1 micros, rounded up to 1
    expect(computeCost("m", usage, runtime({ ...base, inputMicrosPerMillion: 100_000 }))).toBe(1);
    expect(computeCost("m", { ...usage, inputTokens: 0 }, runtime(base))).toBe(1);
  });
  it("fails closed on missing prices and accepts old ones", () => {
    const usage = { inputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, detailsKnown: true };
    expect(() => computeCost("x", usage, runtime(base))).toThrow("CURRENT_PRICE_REQUIRED");
    // A saved price stays valid until the owner changes it; there is no expiry.
    const old = { verifiedModels: ["m"], rateCard: { m: { ...base, verifiedAt: "2020-01-01T00:00:00.000Z" } } } as any;
    expect(computeCost("m", usage, old)).toBe(computeCost("m", usage, runtime(base)));
  });
  it("requires a verified price configuration when the rate card is empty", () => {
    const usage = { inputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, detailsKnown: true };
    const empty = { verifiedModels: ["m"], rateCard: {} } as any;
    expect(() => computeCost("m", usage, empty)).toThrow("VERIFIED_PRICE_CONFIGURATION_REQUIRED");
    expect(() => estimateCost("m", 1, 1, empty)).toThrow("VERIFIED_PRICE_CONFIGURATION_REQUIRED");
  });
  it("rejects cache counts larger than input", () => {
    const usage = { inputTokens: 10, cachedTokens: 8, cacheWriteTokens: 8, outputTokens: 0, reasoningTokens: 0, detailsKnown: true };
    expect(() => computeCost("m", usage, runtime(base))).toThrow("USAGE_INCONSISTENT");
  });
});

describe("estimateCost", () => {
  it("is conservative: input at the cache-write rate", () => {
    expect(estimateCost("m", 1_000_000, 100_000, runtime(base))).toBe(2_500_000 + 1_200_000);
  });
});

describe("rateStatus", () => {
  const day = 86_400_000;
  const card = (age: number) => ({
    m: { ...base, verifiedAt: new Date(Date.now() - age).toISOString() },
  });
  it("matches the runtime price gate", () => {
    expect(rateStatus("m", card(30 * day))).toBe("current");
    expect(rateStatus("m", card(400 * day))).toBe("current");
    expect(rateStatus("other", card(0))).toBe("missing");
    expect(rateStatus("m", {})).toBe("missing");
    // The runtime refuses exactly the non-current states.
    expect(estimateCost("m", 1000, 100, { rateCard: card(400 * day) })).toBe(estimateCost("m", 1000, 100, { rateCard: card(0) }));
    expect(() => estimateCost("other", 1000, 100, { rateCard: card(0) })).toThrow("CURRENT_PRICE_REQUIRED");
    expect(() => estimateCost("m", 1000, 100, { rateCard: {} })).toThrow("VERIFIED_PRICE_CONFIGURATION_REQUIRED");
  });
});

describe("webSearchFee", () => {
  it("charges the configured fee per search and the documented default otherwise", () => {
    expect(webSearchFee("m", 0, runtime(base))).toBe(0);
    expect(DEFAULT_WEB_SEARCH_MICROS_PER_CALL).toBe(10_000);
    expect(webSearchFee("m", 3, runtime(base))).toBe(30_000);
    expect(webSearchFee("m", 3, runtime({ ...base, webSearchMicrosPerCall: 2_500 }))).toBe(7_500);
    expect(webSearchFee("other", 1, runtime(base))).toBe(10_000);
    expect(() => webSearchFee("m", -1, runtime(base))).toThrow("WEB_SEARCH_COUNT_INVALID");
  });
});

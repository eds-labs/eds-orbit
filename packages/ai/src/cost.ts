import { z } from "zod";

export const rateSchema = z.object({
  inputMicrosPerMillion: z.number().nonnegative(),
  outputMicrosPerMillion: z.number().nonnegative(),
  cachedInputMicrosPerMillion: z.number().nonnegative().optional(),
  cacheWriteMicrosPerMillion: z.number().nonnegative().optional(),
  // Fee of one hosted `web_search` call with this model, on top of the search content tokens that are billed as input.
  webSearchMicrosPerCall: z.number().nonnegative().optional(),
  // Input tokens a reservation allows for the content one hosted `web_search` call adds, priced at the input rate.
  webSearchInputTokensPerCall: z.number().int().nonnegative().optional(),
  verifiedAt: z.iso.datetime(),
});
export type Rate = z.infer<typeof rateSchema>;
export const rateCardSchema = z.record(z.string(), rateSchema);
export type CostRuntime = { rateCard: Record<string, Rate> };

/**
 * Fee per hosted web search call when the rate card has none: USD 10 per 1,000
 * calls, the OpenAI list price of the `web_search` tool when this was written.
 * Set `webSearchMicrosPerCall` on the model's rate to override it.
 */
export const DEFAULT_WEB_SEARCH_MICROS_PER_CALL = 10_000;

/**
 * Search content one hosted web search call adds to the input, as reserved
 * before the call when the rate card has no `webSearchInputTokensPerCall`:
 * a generous allowance for the result pages the provider bills as input
 * tokens. The settled cost uses the reported usage, never this allowance.
 */
export const DEFAULT_WEB_SEARCH_INPUT_TOKENS_PER_CALL = 8_000;

export type NormalizedUsage = {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  detailsKnown: boolean;
};

const count = z.number().int().nonnegative();
const responsesUsage = z.object({
  input_tokens: count,
  output_tokens: count,
  // Providers may send explicit nulls; treat them like missing values.
  input_tokens_details: z
    .object({ cached_tokens: count.nullish(), cache_write_tokens: count.nullish() })
    .nullish(),
  output_tokens_details: z.object({ reasoning_tokens: count.nullish() }).nullish(),
});

/** Normalizes a Responses API usage object. Missing cache details are marked unknown, never assumed zero-cost. */
export function normalizeResponsesUsage(usage: unknown): NormalizedUsage {
  const parsed = responsesUsage.safeParse(usage);
  if (!parsed.success) throw new Error("USAGE_UNKNOWN");
  const u = parsed.data;
  const details = u.input_tokens_details;
  const detailsKnown = details?.cached_tokens != null && details?.cache_write_tokens != null;
  return {
    inputTokens: u.input_tokens,
    cachedTokens: details?.cached_tokens ?? 0,
    cacheWriteTokens: details?.cache_write_tokens ?? 0,
    outputTokens: u.output_tokens,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    detailsKnown,
  };
}

/**
 * Whether a paid call for `model` would find a price; the runtime gate below uses the same rule.
 * A saved price stays valid until the owner changes it (no expiry, owner decision 2026-10-02).
 */
export function rateStatus(model: string, rateCard: Record<string, Rate> | undefined): "current" | "missing" {
  return rateCard?.[model] ? "current" : "missing";
}

function currentRate(model: string, runtime: CostRuntime): Required<
  Omit<Rate, "verifiedAt" | "webSearchMicrosPerCall" | "webSearchInputTokensPerCall">
> {
  if (!Object.keys(runtime.rateCard ?? {}).length)
    throw new Error("VERIFIED_PRICE_CONFIGURATION_REQUIRED");
  if (rateStatus(model, runtime.rateCard) !== "current")
    throw new Error("CURRENT_PRICE_REQUIRED");
  const rate = runtime.rateCard[model]!;
  return {
    inputMicrosPerMillion: rate.inputMicrosPerMillion,
    outputMicrosPerMillion: rate.outputMicrosPerMillion,
    // Conservative defaults: a cached read is never cheaper than configured, a write costs the documented 1.25x.
    cachedInputMicrosPerMillion: rate.cachedInputMicrosPerMillion ?? rate.inputMicrosPerMillion,
    cacheWriteMicrosPerMillion:
      rate.cacheWriteMicrosPerMillion ?? Math.ceil(rate.inputMicrosPerMillion * 1.25),
  };
}

/** Cost in USD micros per the documented formula: ordinary + cached + cache writes + output (reasoning is part of output). */
export function computeCost(model: string, usage: NormalizedUsage, runtime: CostRuntime) {
  const rate = currentRate(model, runtime);
  if (usage.cachedTokens + usage.cacheWriteTokens > usage.inputTokens)
    throw new Error("USAGE_INCONSISTENT");
  const input = usage.detailsKnown
    ? (usage.inputTokens - usage.cachedTokens - usage.cacheWriteTokens) * rate.inputMicrosPerMillion +
      usage.cachedTokens * rate.cachedInputMicrosPerMillion +
      usage.cacheWriteTokens * rate.cacheWriteMicrosPerMillion
    : usage.inputTokens *
      Math.max(
        rate.inputMicrosPerMillion,
        rate.cacheWriteMicrosPerMillion,
        rate.cachedInputMicrosPerMillion,
      );
  return Math.max(1, Math.ceil((input + usage.outputTokens * rate.outputMicrosPerMillion) / 1_000_000));
}

/** Pre-transmission estimate. Charges all input at the cache-write rate because implicit caching may write it. */
export function estimateCost(model: string, inputTokens: number, outputTokens: number, runtime: CostRuntime) {
  return computeCost(
    model,
    { inputTokens, cachedTokens: 0, cacheWriteTokens: 0, outputTokens, reasoningTokens: 0, detailsKnown: false },
    runtime,
  );
}

/** Embedding usage: no caching, input only. */
export function embeddingUsage(totalTokens: number): NormalizedUsage {
  return { inputTokens: totalTokens, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, detailsKnown: true };
}

/** Fee of `calls` hosted web search calls with `model`, rounded up; the search content tokens are part of the usage. */
export function webSearchFee(model: string, calls: number, runtime: CostRuntime) {
  if (!Number.isInteger(calls) || calls < 0) throw new Error("WEB_SEARCH_COUNT_INVALID");
  if (calls === 0) return 0;
  const perCall = runtime.rateCard?.[model]?.webSearchMicrosPerCall ?? DEFAULT_WEB_SEARCH_MICROS_PER_CALL;
  return Math.ceil(calls * perCall);
}

/** Input tokens to reserve for the search content of `calls` hosted web search calls with `model`. */
export function webSearchInputTokens(model: string, calls: number, runtime: CostRuntime) {
  if (!Number.isInteger(calls) || calls < 0) throw new Error("WEB_SEARCH_COUNT_INVALID");
  if (calls === 0) return 0;
  const perCall =
    runtime.rateCard?.[model]?.webSearchInputTokensPerCall ?? DEFAULT_WEB_SEARCH_INPUT_TOKENS_PER_CALL;
  return calls * perCall;
}

import { z } from "zod";

export const rateSchema = z.object({
  inputMicrosPerMillion: z.number().nonnegative(),
  outputMicrosPerMillion: z.number().nonnegative(),
  cachedInputMicrosPerMillion: z.number().nonnegative().optional(),
  cacheWriteMicrosPerMillion: z.number().nonnegative().optional(),
  verifiedAt: z.iso.datetime(),
});
export type Rate = z.infer<typeof rateSchema>;
export const rateCardSchema = z.record(z.string(), rateSchema);
export type CostRuntime = { rateCard: Record<string, Rate> };

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
  input_tokens_details: z
    .object({ cached_tokens: count.optional(), cache_write_tokens: count.optional() })
    .optional(),
  output_tokens_details: z.object({ reasoning_tokens: count.optional() }).optional(),
});

/** Normalizes a Responses API usage object. Missing cache details are marked unknown, never assumed zero-cost. */
export function normalizeResponsesUsage(usage: unknown): NormalizedUsage {
  const parsed = responsesUsage.safeParse(usage);
  if (!parsed.success) throw new Error("USAGE_UNKNOWN");
  const u = parsed.data;
  const details = u.input_tokens_details;
  const detailsKnown =
    details?.cached_tokens !== undefined && details?.cache_write_tokens !== undefined;
  return {
    inputTokens: u.input_tokens,
    cachedTokens: details?.cached_tokens ?? 0,
    cacheWriteTokens: details?.cache_write_tokens ?? 0,
    outputTokens: u.output_tokens,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    detailsKnown,
  };
}

function currentRate(model: string, runtime: CostRuntime): Required<Omit<Rate, "verifiedAt">> {
  if (!Object.keys(runtime.rateCard ?? {}).length)
    throw new Error("VERIFIED_PRICE_CONFIGURATION_REQUIRED");
  const rate = runtime.rateCard[model];
  if (!rate || Date.now() - new Date(rate.verifiedAt).valueOf() > 31 * 86400000)
    throw new Error("CURRENT_PRICE_REQUIRED");
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
    : usage.inputTokens * Math.max(rate.inputMicrosPerMillion, rate.cacheWriteMicrosPerMillion);
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

import type { Rate } from "./cost.ts";
import { anthropicCatalog, type ProviderId } from "./provider.ts";

/**
 * Orbit's price catalog (plan docs/plans/ai-central-management.md, phase A,
 * decision D-3): models Orbit knows with prices read from the providers'
 * official pages on the dated `verifiedAt`. Administrators and organizations
 * may override a price or switch a model off (`AiModelPrice`); a project's
 * own rate card still wins. Prices are USD micros per million tokens.
 *
 * Image models carry `perImageMicros`, the amount Orbit reserves and books
 * per generated image. The OpenAI pricing page lists only token prices for
 * the GPT Image 2.5 models, no per-image price, and Orbit settles an image
 * at this amount (image-generation.ts). It is therefore a conservative
 * ceiling above the highest published per-image price of the previous
 * generation (gpt-image-2, high quality, 1024x1024: USD 0.211), not a price.
 */

export type CatalogPurpose = "text" | "image" | "embedding";
export type CatalogEntry = {
  provider: ProviderId;
  purpose: CatalogPurpose;
  displayName: string;
  /** Token prices (text and embedding models). */
  rate?: Omit<Rate, "verifiedAt">;
  /** Booked amount per generated image (image models). */
  perImageMicros?: number;
  verifiedAt: string;
  source: string;
  note?: string;
};

const OPENAI_VERIFIED_AT = "2026-10-25T00:00:00.000Z";
const OPENAI_PRICING = "https://developers.openai.com/api/docs/pricing";
const OPENAI_IMAGES =
  "https://developers.openai.com/api/docs/guides/image-generation";

/** An OpenAI text model: cache writes cost nothing extra; web search USD 10 per 1,000 calls. */
const openaiText = (
  displayName: string,
  input: number,
  cached: number,
  output: number,
  note?: string,
): CatalogEntry => ({
  provider: "openai",
  purpose: "text",
  displayName,
  rate: {
    inputMicrosPerMillion: input,
    outputMicrosPerMillion: output,
    cachedInputMicrosPerMillion: cached,
    cacheWriteMicrosPerMillion: input,
    webSearchMicrosPerCall: 10_000,
  },
  verifiedAt: OPENAI_VERIFIED_AT,
  source: OPENAI_PRICING,
  ...(note ? { note } : {}),
});

const openaiImage = (displayName: string): CatalogEntry => ({
  provider: "openai",
  purpose: "image",
  displayName,
  perImageMicros: 250_000,
  verifiedAt: OPENAI_VERIFIED_AT,
  source: OPENAI_IMAGES,
  note: "Conservative ceiling per image: OpenAI publishes only token prices for GPT Image 2.5 (USD 8 / 30 per million image input / output tokens).",
});

const openaiEmbedding = (displayName: string, input: number): CatalogEntry => ({
  provider: "openai",
  purpose: "embedding",
  displayName,
  rate: { inputMicrosPerMillion: input, outputMicrosPerMillion: 0 },
  verifiedAt: OPENAI_VERIFIED_AT,
  source: OPENAI_PRICING,
});

export const priceCatalog: Readonly<Record<string, CatalogEntry>> = {
  // OpenAI text models, standard tier, prompts up to 272K tokens.
  "gpt-6-astra": openaiText("GPT-6 Astra", 10_000_000, 1_000_000, 50_000_000),
  "gpt-6.1-sol": openaiText("GPT-6.1 Sol", 2_000_000, 100_000, 10_000_000),
  "gpt-6-sol": openaiText("GPT-6 Sol", 2_000_000, 200_000, 10_000_000),
  "gpt-6-luna": openaiText("GPT-6 Luna", 100_000, 10_000, 500_000),
  "gpt-5.6-sol": openaiText(
    "GPT-5.6 Sol",
    4_000_000,
    400_000,
    20_000_000,
    "The pricing page mentions a promotion for GPT-5.6 Sol until at least 2026-11-21; check the price after that date.",
  ),
  "gpt-5.6-terra": openaiText("GPT-5.6 Terra", 2_000_000, 200_000, 12_000_000),
  "gpt-5.6-luna": openaiText("GPT-5.6 Luna", 200_000, 20_000, 1_200_000),
  // OpenAI image models Orbit can call (imageModelSchema).
  "gpt-image-2.5-flare": openaiImage("GPT Image 2.5 Flare"),
  "gpt-image-2.5-flare-2026-09-08": openaiImage("GPT Image 2.5 Flare (2026-09-08)"),
  "gpt-image-2.5-sunburst": openaiImage("GPT Image 2.5 Sunburst"),
  "gpt-image-2.5-sunburst-2026-09-08": openaiImage("GPT Image 2.5 Sunburst (2026-09-08)"),
  // OpenAI embedding models (semantic search).
  "text-embedding-3-small": openaiEmbedding("Text Embedding 3 Small", 20_000),
  "text-embedding-3-large": openaiEmbedding("Text Embedding 3 Large", 130_000),
  // Anthropic models from the reviewed Claude catalog.
  ...Object.fromEntries(
    Object.entries(anthropicCatalog.models).map(([id, entry]): [string, CatalogEntry] => [
      id,
      {
        provider: "anthropic",
        purpose: "text",
        displayName: entry.displayName,
        rate: { ...entry.rate },
        verifiedAt: anthropicCatalog.verifiedAt,
        source: anthropicCatalog.sources[1],
      },
    ]),
  ),
};

/** Days after which a catalog price is shown as "please check" (D-3); calls go on. */
export const PRICE_REVIEW_DAYS = 90;

export function priceNeedsReview(verifiedAt: string, now = Date.now()) {
  return now - Date.parse(verifiedAt) > PRICE_REVIEW_DAYS * 86_400_000;
}

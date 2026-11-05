import { z } from "zod";
import type { ProviderId } from "./provider.ts";

/**
 * The speech port (ADR 0024, agent platform Phase 4 WP4.5): speech-to-text
 * and text-to-speech behind one provider-neutral interface. The first
 * adapter is OpenAI (`providers/openai-speech.ts`); a fake adapter in the
 * contract tests proves the provider can be exchanged. Model ids come from
 * the AI catalogue and routing (`resolveSpeechRoute`), never from code
 * constants in the call path.
 *
 * Audio is never stored: callers hold it in memory for one request, the
 * adapter sends it and returns text, and synthesized audio is streamed to the
 * client without being written anywhere.
 */

export const speechTaskClasses = ["speech_to_text", "text_to_speech"] as const;
export type SpeechTaskClass = (typeof speechTaskClasses)[number];

/** The pricing units of `AiModelPrice.unit`; `token` keeps the rate card. */
export const priceUnits = ["token", "audio_minute", "character"] as const;
export type PriceUnit = (typeof priceUnits)[number];
export type SpeechUnit = Exclude<PriceUnit, "token">;

/** The unit each speech task class is priced and settled in. */
export const speechUnitOf: Readonly<Record<SpeechTaskClass, SpeechUnit>> = {
  speech_to_text: "audio_minute",
  text_to_speech: "character",
};

/** The budget category a speech reservation is booked under. */
export const speechBudgetCategory: Readonly<Record<SpeechTaskClass, string>> = {
  speech_to_text: "speech_stt",
  text_to_speech: "speech_tts",
};

// Input and output limits (ADR 0024 item 4 and 6).
export const SPEECH_MAX_SECONDS = 60;
export const SPEECH_MAX_BYTES = 2 * 1024 * 1024;
/** Characters one read-aloud request sends at most (R4-5). */
export const SPEECH_MAX_CHARACTERS = 3000;
/** The recording containers the transcription route accepts. */
export const speechMimeTypes = ["audio/webm", "audio/mp4"] as const;
export type SpeechMime = (typeof speechMimeTypes)[number];
export const speechOutputFormats = ["mp3", "opus"] as const;
export type SpeechOutputFormat = (typeof speechOutputFormats)[number];

/** The base MIME type of a Content-Type header when it is an allowed recording type. */
export function speechMimeOf(
  contentType: string | undefined,
): SpeechMime | null {
  const base = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return (speechMimeTypes as readonly string[]).includes(base)
    ? (base as SpeechMime)
    : null;
}

export type TranscribeInput = {
  audio: Uint8Array;
  mime: SpeechMime;
  /** ISO 639-1 hint; the provider detects the language without it. */
  language?: string;
  model: string;
};
export type TranscribeResult = {
  text: string;
  /** The audio duration the provider reports billing, when it reports one. */
  durationSeconds?: number;
  usage?: unknown;
};
export type SynthesizeInput = {
  text: string;
  voice: string;
  format: SpeechOutputFormat;
  model: string;
};
export type SynthesizeResult = {
  /** The audio as it arrives; nothing buffers or stores it. */
  audio: AsyncIterable<Uint8Array>;
  /** The characters the provider bills for this request. */
  characters: number;
  mime: string;
};

/**
 * One speech provider. Both methods take an AbortSignal and must not retry:
 * a transmitted request with an unclear outcome is reported as `unknown`.
 * `synthesize` resolves once the provider accepted the request (it is billed
 * from then on) and streams the audio afterwards.
 */
export interface SpeechProvider {
  readonly provider: ProviderId;
  transcribe(
    input: TranscribeInput,
    signal: AbortSignal,
  ): Promise<TranscribeResult>;
  synthesize(
    input: SynthesizeInput,
    signal: AbortSignal,
  ): Promise<SynthesizeResult>;
}

/**
 * Why a speech call failed, for settlement:
 * - `not_sent`: nothing left Orbit; the reservation is released at 0.
 * - `rejected`: the provider refused the request before any work (an HTTP
 *   status it does not bill); settled at 0.
 * - `unknown`: transmitted with an unclear outcome (network error, timeout,
 *   server error, cut-off answer); settled as unknown and never retried.
 */
export class SpeechProviderError extends Error {
  constructor(
    readonly outcome: "not_sent" | "rejected" | "unknown",
    readonly status?: number,
  ) {
    super(`SPEECH_PROVIDER_${outcome.toUpperCase()}`);
    this.name = "SpeechProviderError";
  }
}

/** A speech model as the catalogue (with its overrides) describes it. */
export type SpeechCatalogModel = {
  id: string;
  provider: ProviderId;
  purpose: string;
  active: boolean;
  unitPrice?: { unit: string; micros: number };
  speech?: { voices?: readonly string[]; defaultVoice?: string };
};

export const speechRouteSchema = z
  .object({
    model: z.string().trim().min(1).max(120),
    voice: z.string().trim().min(1).max(40).optional(),
  })
  .strict();
export type SpeechRoute = z.infer<typeof speechRouteSchema>;

export type ResolvedSpeechRoute = {
  taskClass: SpeechTaskClass;
  model: string;
  provider: ProviderId;
  voice?: string;
  price: { unit: SpeechUnit; micros: number };
};

/**
 * The route of a speech task class: the explicit route when one is given,
 * otherwise the first active catalogue model of that purpose that is
 * verified (catalogue order is the preference; administrators steer it by
 * switching models off in "Models & prices"). Fails closed:
 * - SPEECH_MODEL_NOT_CONFIGURED: no catalogue model of the purpose;
 * - MODEL_CAPABILITY_NOT_VERIFIED: the model is not verified or inactive;
 * - SPEECH_PRICE_REQUIRED: the model has no unit price;
 * - PRICE_UNIT_UNKNOWN: its unit is not the task class's unit.
 */
export function resolveSpeechRoute(
  taskClass: SpeechTaskClass,
  runtime: { verifiedModels: readonly string[] },
  catalog: readonly SpeechCatalogModel[],
  explicit?: SpeechRoute,
): ResolvedSpeechRoute {
  const candidates = catalog.filter((m) => m.purpose === taskClass);
  const entry = explicit
    ? candidates.find((m) => m.id === explicit.model)
    : candidates.find((m) => m.active && runtime.verifiedModels.includes(m.id));
  if (!entry) {
    if (explicit || candidates.some((m) => m.active))
      throw new Error("MODEL_CAPABILITY_NOT_VERIFIED");
    throw new Error("SPEECH_MODEL_NOT_CONFIGURED");
  }
  if (!entry.active || !runtime.verifiedModels.includes(entry.id))
    throw new Error("MODEL_CAPABILITY_NOT_VERIFIED");
  if (!entry.unitPrice) throw new Error("SPEECH_PRICE_REQUIRED");
  const price = speechPrice(taskClass, entry.unitPrice);
  const voice =
    taskClass === "text_to_speech"
      ? (explicit?.voice ?? entry.speech?.defaultVoice)
      : undefined;
  if (taskClass === "text_to_speech") {
    if (!voice) throw new Error("SPEECH_VOICE_REQUIRED");
    if (entry.speech?.voices && !entry.speech.voices.includes(voice))
      throw new Error("SPEECH_VOICE_REQUIRED");
  }
  return {
    taskClass,
    model: entry.id,
    provider: entry.provider,
    ...(voice ? { voice } : {}),
    price,
  };
}

/** A validated unit price for a task class; PRICE_UNIT_UNKNOWN otherwise. */
export function speechPrice(
  taskClass: SpeechTaskClass,
  price: { unit: string; micros: number },
): { unit: SpeechUnit; micros: number } {
  if (price.unit !== speechUnitOf[taskClass])
    throw new Error("PRICE_UNIT_UNKNOWN");
  if (!Number.isFinite(price.micros) || price.micros < 0)
    throw new Error("SPEECH_PRICE_REQUIRED");
  return { unit: price.unit as SpeechUnit, micros: price.micros };
}

// Unit prices carry up to six decimals of a micro-dollar (Decimal(18,6)).
const SCALE = 1_000_000n;
const scaled = (micros: number) => BigInt(Math.round(micros * 1_000_000));

/**
 * The cost in whole USD micros of `quantity` units, rounded up, at least 1
 * (a reservation needs a positive amount):
 * - `audio_minute`: `quantity` is seconds, billed per started second;
 * - `character`: `quantity` is characters.
 * Any other unit is refused with PRICE_UNIT_UNKNOWN; token prices stay with
 * the rate card (`computeCost`).
 */
export function speechCostMicros(
  price: { unit: string; micros: number },
  quantity: number,
): number {
  if (!Number.isFinite(quantity) || quantity < 0)
    throw new Error("INVALID_USAGE");
  if (!Number.isFinite(price.micros) || price.micros < 0)
    throw new Error("SPEECH_PRICE_REQUIRED");
  let numerator: bigint;
  let denominator: bigint;
  if (price.unit === "audio_minute") {
    numerator = BigInt(Math.ceil(quantity)) * scaled(price.micros);
    denominator = 60n * SCALE;
  } else if (price.unit === "character") {
    numerator = BigInt(Math.ceil(quantity)) * scaled(price.micros);
    denominator = SCALE;
  } else throw new Error("PRICE_UNIT_UNKNOWN");
  const whole = (numerator + denominator - 1n) / denominator;
  const cost = Number(whole);
  if (!Number.isSafeInteger(cost)) throw new Error("COST_ESTIMATE_REQUIRED");
  return Math.max(1, cost);
}

/** What one read-aloud request may say: the text up to the cap, cut at a word. */
export function capSpeechText(text: string, max = SPEECH_MAX_CHARACTERS) {
  const clean = text.trim();
  if (clean.length <= max) return { text: clean, truncated: false };
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return {
    text: (space > max * 0.8 ? cut.slice(0, space) : cut).trimEnd(),
    truncated: true,
  };
}

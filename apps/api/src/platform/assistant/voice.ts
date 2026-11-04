import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import { userScoped } from "../tenancy/scope.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  capSpeechText,
  measureAudioDuration,
  openAiSpeechProvider,
  resolveSpeechRoute,
  SPEECH_MAX_BYTES,
  SPEECH_MAX_CHARACTERS,
  SPEECH_MAX_SECONDS,
  SpeechProviderError,
  type ProviderId,
  type ResolvedSpeechRoute,
  type SpeechMime,
  type SpeechProvider,
  type SpeechTaskClass,
} from "../../../../../packages/ai/src/index.ts";
import { projectCatalog, speechCatalog } from "../ai/catalog.ts";
import { providersForData } from "../ai/data-class.ts";
import { runtimeOpenAiConfiguration } from "../ai/openai-configuration.ts";
import {
  estimateSpeechMicros,
  reserveSpeech,
  settleSpeech,
} from "../ai/speech-budget.ts";
import { entitled, entitlementsFor } from "../entitlements/entitlements.ts";
import { create, data, DomainError, list, update } from "../shared.ts";
import { ASSISTANT_SETTINGS_KIND } from "./personal-context.ts";
import { personalAssistantRefusal } from "./personal-space.ts";

/**
 * Voice in the personal assistant (ADR 0024, plan Phase 4 WP4.6/WP4.7):
 * push-to-talk transcription into the composer and "Read aloud" of an
 * assistant answer. Both run in the user's personal space within the
 * per-member cap, behind ORBIT_VOICE, the `assistantVoice` entitlement and
 * the personal-assistant gate.
 *
 * Privacy (D-19): audio exists only in this request's memory. Nothing here
 * writes it to the database, platform files or logs; the transcript is
 * returned to the composer and becomes a chat message only when the user
 * sends it. Synthesized audio is streamed through and never kept.
 */

export const voiceEnabled = () => process.env.ORBIT_VOICE === "true";

/** STT requests wait at most this long for the provider (plan §7). */
export const TRANSCRIBE_TIMEOUT_MS = 30_000;
/** A read-aloud stream is cut after this long. */
export const SPEECH_TIMEOUT_MS = 120_000;
/** The composer's limit; a transcript never exceeds it. */
export const TRANSCRIPT_MAX_CHARS = 4000;

/** Why the user may not use voice in this organization, or null. */
export async function voiceRefusal(workspaceId: string, userId: string) {
  if (!voiceEnabled()) return "VOICE_DISABLED";
  const refusal = await personalAssistantRefusal(workspaceId, userId);
  if (refusal) return refusal;
  if (!entitled(await entitlementsFor(workspaceId), "assistantVoice"))
    return "VOICE_ENTITLEMENT";
  return null;
}

// ------------------------------------------------------------ settings ----

export const voiceSettingsInput = z
  .object({
    autoSend: z.boolean().optional(),
    autoRead: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.autoSend !== undefined || v.autoRead !== undefined, {
    message: "VOICE_SETTING_REQUIRED",
  });
export type VoiceSettings = { autoSend: boolean; autoRead: boolean };
/** Both off by default (T4-3; read aloud only on request). */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  autoSend: false,
  autoRead: false,
};

async function assertPersonalSpace(tx: DbTx, scope: Scope) {
  const space = await tx.project.findFirst({
    where: {
      id: scope.projectId,
      workspaceId: scope.workspaceId,
      kind: "personal",
      personalUserId: scope.userId,
    },
    select: { id: true },
  });
  if (!space) throw new DomainError("NOT_FOUND", 404);
}

function voiceOf(row: { data: unknown } | undefined): VoiceSettings {
  const stored = (data(row).voice ?? {}) as Partial<VoiceSettings>;
  return {
    autoSend: stored.autoSend === true,
    autoRead: stored.autoRead === true,
  };
}

/** The voice settings in the user-private `assistant_settings` entity. */
export async function readVoiceSettings(
  tx: DbTx,
  scope: Scope,
): Promise<VoiceSettings> {
  await assertPersonalSpace(tx, scope);
  return voiceOf((await list(tx, scope, ASSISTANT_SETTINGS_KIND))[0]);
}

/**
 * Merges the given voice settings into `assistant_settings.voice`; every
 * other key of the entity (automatic memory, other preferences) stays.
 */
export async function saveVoiceSettings(tx: DbTx, scope: Scope, raw: unknown) {
  await assertPersonalSpace(tx, scope);
  const input = voiceSettingsInput.parse(raw);
  const row = (await list(tx, scope, ASSISTANT_SETTINGS_KIND))[0];
  const voice = { ...voiceOf(row), ...input };
  if (row) await update(tx, scope, row, { ...data(row), voice });
  else await create(tx, scope, ASSISTANT_SETTINGS_KIND, { voice });
  return voice;
}

// ------------------------------------------------------------- routing ----

type SpeechProviderFactory = (
  provider: ProviderId,
  apiKey: string,
) => SpeechProvider;

const defaultFactory: SpeechProviderFactory = (provider, apiKey) => {
  // Safety net: no test may ever reach a real speech provider (a live call
  // needs Mario's separate approval); tests inject a fake adapter.
  if (process.env.VITEST) throw new SpeechProviderError("not_sent");
  if (provider !== "openai") throw new SpeechProviderError("not_sent");
  return openAiSpeechProvider({ apiKey });
};
let factory: SpeechProviderFactory = defaultFactory;

/** Replaces the speech adapter; for tests only. Pass nothing to restore it. */
export function setSpeechProviderFactory(next?: SpeechProviderFactory) {
  factory = next ?? defaultFactory;
}

const ROUTE_ERRORS: Record<string, number> = {
  SPEECH_MODEL_NOT_CONFIGURED: 409,
  MODEL_CAPABILITY_NOT_VERIFIED: 409,
  SPEECH_PRICE_REQUIRED: 409,
  PRICE_UNIT_UNKNOWN: 409,
  SPEECH_VOICE_REQUIRED: 409,
};

/**
 * The speech route of the space, checked before anything is reserved: a
 * verified, priced catalogue model, a provider on the personal-data
 * allow-list (voice is personal data, D-11) and a key for it.
 */
async function speechRoute(tx: DbTx, scope: Scope, taskClass: SpeechTaskClass) {
  const runtime = await runtimeOpenAiConfiguration(tx, scope);
  const catalog = speechCatalog(await projectCatalog(tx, scope));
  let route: ResolvedSpeechRoute;
  try {
    route = resolveSpeechRoute(taskClass, runtime, catalog);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (ROUTE_ERRORS[code]) throw new DomainError(code, ROUTE_ERRORS[code]);
    throw error;
  }
  if (!providersForData("customer_personal")!.includes(route.provider))
    throw new DomainError("SPEECH_PROVIDER_NOT_ALLOWED", 409);
  const apiKey =
    route.provider === "openai" ? runtime.apiKey : runtime.anthropicApiKey;
  if (!apiKey) throw new DomainError("SPEECH_NOT_CONFIGURED", 409);
  return { route, apiKey };
}

/** Whether STT and TTS could run now (for the controls); never throws for routing. */
export async function voiceReadiness(tx: DbTx, scope: Scope) {
  const ready = async (taskClass: SpeechTaskClass) => {
    try {
      await speechRoute(tx, scope, taskClass);
      return { ready: true as const };
    } catch (error) {
      if (error instanceof DomainError)
        return { ready: false as const, reason: error.code };
      throw error;
    }
  };
  return {
    speechToText: await ready("speech_to_text"),
    textToSpeech: await ready("text_to_speech"),
  };
}

export const voiceLimits = {
  maxSeconds: SPEECH_MAX_SECONDS,
  maxBytes: SPEECH_MAX_BYTES,
  maxCharacters: SPEECH_MAX_CHARACTERS,
};

const withTimeout = (signal: AbortSignal | undefined, ms: number) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(ms)])
    : AbortSignal.timeout(ms);

/** Maps a failed provider call to its settlement and the client's code. */
async function failed(
  scope: Scope,
  reservationId: string,
  route: ResolvedSpeechRoute,
  error: unknown,
): Promise<never> {
  const outcome =
    error instanceof SpeechProviderError && error.outcome !== "unknown"
      ? "not_billed"
      : "unknown";
  await userScoped(scope, (tx) =>
    settleSpeech(tx, scope, reservationId, route, outcome),
  );
  // Never retried: an unknown outcome stays unknown for reconciliation.
  throw new DomainError(
    outcome === "unknown"
      ? "SPEECH_OUTCOME_UNKNOWN"
      : "SPEECH_PROVIDER_REJECTED",
    502,
  );
}

// ------------------------------------------------------- transcription ----

/**
 * Transcribes one recording held in memory: measures its duration from the
 * container (refusing unreadable or too long input before anything is
 * reserved), reserves the estimate, calls the provider once and settles
 * with the reported duration (else the measured one). Returns the text for
 * the composer; nothing is stored.
 */
export async function transcribe(
  scope: Scope,
  input: { audio: Uint8Array; mime: SpeechMime; language?: string },
  signal?: AbortSignal,
) {
  if (input.audio.byteLength > SPEECH_MAX_BYTES)
    throw new DomainError("SPEECH_TOO_LARGE", 413);
  let seconds: number;
  try {
    seconds = measureAudioDuration(input.audio, input.mime).durationSeconds;
  } catch {
    throw new DomainError("SPEECH_UNREADABLE", 422);
  }
  if (seconds > SPEECH_MAX_SECONDS)
    throw new DomainError("SPEECH_TOO_LONG", 413);
  const prepared = await userScoped(scope, async (tx) => {
    await assertPersonalSpace(tx, scope);
    const { route, apiKey } = await speechRoute(tx, scope, "speech_to_text");
    const provider = factory(route.provider, apiKey);
    const estimateMicros = estimateSpeechMicros(route, seconds);
    const reservationId = await reserveSpeech(
      tx,
      scope,
      route,
      estimateMicros,
      `speech_stt:${crypto.randomUUID()}`,
    );
    return { route, provider, reservationId, estimateMicros };
  });
  let result;
  try {
    result = await prepared.provider.transcribe(
      {
        audio: input.audio,
        mime: input.mime,
        model: prepared.route.model,
        ...(input.language ? { language: input.language } : {}),
      },
      withTimeout(signal, TRANSCRIBE_TIMEOUT_MS),
    );
  } catch (error) {
    return failed(scope, prepared.reservationId, prepared.route, error);
  }
  const billedSeconds = result.durationSeconds ?? seconds;
  const costMicros = await userScoped(scope, (tx) =>
    settleSpeech(tx, scope, prepared.reservationId, prepared.route, {
      quantity: billedSeconds,
    }),
  );
  return {
    text: result.text.trim().slice(0, TRANSCRIPT_MAX_CHARS),
    durationSeconds: Math.round(seconds * 10) / 10,
    estimateMicros: prepared.estimateMicros,
    costMicros,
  };
}

// ---------------------------------------------------------- read aloud ----

/**
 * The text "Read aloud" speaks for a message: the visible answer without
 * Markdown syntax, code blocks or link targets, then each card's title
 * (cards are summarized by their titles, never their content).
 */
export function speechTextOf(text: string, cards: unknown): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]*?\S)\1/g, "$2")
    .replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  const titles = (Array.isArray(cards) ? cards : [])
    .map((card) =>
      card && typeof card === "object"
        ? (card as { label?: unknown }).label
        : null,
    )
    .filter(
      (label): label is string =>
        typeof label === "string" && label.trim().length > 0,
    )
    .map((label) => label.trim().replace(/[.!?]?$/, "."));
  return [plain, ...titles].filter(Boolean).join("\n");
}

/**
 * Synthesizes one of the user's own assistant messages in the personal
 * space: capped text, cost reserved before the call and settled per billed
 * character once the provider accepted the request. Returns the audio
 * stream for the response; nothing is stored.
 */
export async function speak(
  scope: Scope,
  messageId: string,
  signal?: AbortSignal,
) {
  const prepared = await userScoped(scope, async (tx) => {
    await assertPersonalSpace(tx, scope);
    const message = await tx.chatMessage.findFirst({
      where: {
        id: messageId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        userId: scope.userId,
        role: "assistant",
      },
      select: { text: true, cards: true },
    });
    if (!message) throw new DomainError("NOT_FOUND", 404);
    const capped = capSpeechText(speechTextOf(message.text, message.cards));
    if (!capped.text) throw new DomainError("SPEECH_NOTHING_TO_READ", 409);
    const { route, apiKey } = await speechRoute(tx, scope, "text_to_speech");
    const provider = factory(route.provider, apiKey);
    const estimateMicros = estimateSpeechMicros(route, capped.text.length);
    const reservationId = await reserveSpeech(
      tx,
      scope,
      route,
      estimateMicros,
      `speech_tts:${crypto.randomUUID()}`,
    );
    return { route, provider, reservationId, estimateMicros, ...capped };
  });
  let result;
  try {
    result = await prepared.provider.synthesize(
      {
        text: prepared.text,
        voice: prepared.route.voice!,
        format: "mp3",
        model: prepared.route.model,
      },
      withTimeout(signal, SPEECH_TIMEOUT_MS),
    );
  } catch (error) {
    return failed(scope, prepared.reservationId, prepared.route, error);
  }
  // Accepted: the characters are billed even if the stream breaks later.
  const costMicros = await userScoped(scope, (tx) =>
    settleSpeech(tx, scope, prepared.reservationId, prepared.route, {
      quantity: Math.max(result.characters, 0),
    }),
  );
  return {
    audio: result.audio,
    mime: result.mime,
    characters: prepared.text.length,
    truncated: prepared.truncated,
    estimateMicros: prepared.estimateMicros,
    costMicros,
  };
}

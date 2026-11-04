import {
  SpeechProviderError,
  type SpeechProvider,
  type SynthesizeInput,
  type TranscribeInput,
} from "../speech.ts";

/**
 * OpenAI adapter of the speech port (ADR 0024): `POST /v1/audio/transcriptions`
 * and `POST /v1/audio/speech` over `fetch`, which is injectable so tests never
 * reach the network. No retries: one request per call, and a transmitted
 * request with an unclear outcome is `unknown`. The model, voice and format
 * come from the caller's resolved route.
 *
 * Audio is passed through in memory: the recording goes into the multipart
 * request body, and the synthesized audio is returned as the response
 * stream, never buffered as a whole or written anywhere.
 */

// Statuses the API returns before doing any work; such a request is not billed.
const UNBILLED = new Set([400, 401, 403, 404, 413, 415, 422, 429]);

export type OpenAiSpeechOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
};

const FILE_NAMES: Record<TranscribeInput["mime"], string> = {
  "audio/webm": "speech.webm",
  "audio/mp4": "speech.mp4",
};
const OUTPUT_MIME: Record<SynthesizeInput["format"], string> = {
  mp3: "audio/mpeg",
  opus: "audio/ogg",
};

function failure(status: number): SpeechProviderError {
  return new SpeechProviderError(
    UNBILLED.has(status) ? "rejected" : "unknown",
    status,
  );
}

/** The duration the provider reports billing, when its usage names one. */
function reportedSeconds(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const value = usage as { type?: unknown; seconds?: unknown };
  return value.type === "duration" &&
    typeof value.seconds === "number" &&
    Number.isFinite(value.seconds) &&
    value.seconds >= 0
    ? value.seconds
    : undefined;
}

export function openAiSpeechProvider(
  options: OpenAiSpeechOptions,
): SpeechProvider {
  if (!options.apiKey) throw new SpeechProviderError("not_sent");
  const call = options.fetch ?? fetch;
  const base = (options.baseUrl ?? "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
  const auth = { authorization: `Bearer ${options.apiKey}` };

  async function send(url: string, init: RequestInit, signal: AbortSignal) {
    // Aborted before anything was sent: nothing to settle.
    if (signal.aborted) throw new SpeechProviderError("not_sent");
    try {
      return await call(url, { ...init, signal });
    } catch {
      // The request may have reached the provider: never retried.
      throw new SpeechProviderError("unknown");
    }
  }

  return {
    provider: "openai",
    async transcribe(input, signal) {
      const form = new FormData();
      form.append(
        "file",
        new Blob([input.audio as Uint8Array<ArrayBuffer>], {
          type: input.mime,
        }),
        FILE_NAMES[input.mime],
      );
      form.append("model", input.model);
      form.append("response_format", "json");
      if (input.language) form.append("language", input.language);
      const response = await send(
        `${base}/audio/transcriptions`,
        { method: "POST", headers: auth, body: form },
        signal,
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw failure(response.status);
      }
      let body: { text?: unknown; usage?: unknown };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        throw new SpeechProviderError("unknown", response.status);
      }
      if (typeof body.text !== "string")
        throw new SpeechProviderError("unknown", response.status);
      const durationSeconds = reportedSeconds(body.usage);
      return {
        text: body.text,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(body.usage !== undefined ? { usage: body.usage } : {}),
      };
    },
    async synthesize(input, signal) {
      const response = await send(
        `${base}/audio/speech`,
        {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({
            model: input.model,
            input: input.text,
            voice: input.voice,
            response_format: input.format,
          }),
        },
        signal,
      );
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw failure(response.ok ? 502 : response.status);
      }
      const stream = response.body;
      return {
        characters: input.text.length,
        mime: OUTPUT_MIME[input.format],
        audio: {
          async *[Symbol.asyncIterator]() {
            const reader = stream.getReader();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) return;
                if (value?.byteLength) yield value;
              }
            } finally {
              reader.releaseLock();
            }
          },
        },
      };
    },
  };
}

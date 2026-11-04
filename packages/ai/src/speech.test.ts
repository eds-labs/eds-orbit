import { describe, expect, it, vi } from "vitest";
import { priceCatalog } from "./catalog.ts";
import { computeCost } from "./cost.ts";
import { fakeSpeechProvider } from "./audio-fixtures.test-helpers.ts";
import { openAiSpeechProvider } from "./providers/openai-speech.ts";
import {
  capSpeechText,
  resolveSpeechRoute,
  speechCostMicros,
  speechMimeOf,
  SpeechProviderError,
  type SpeechCatalogModel,
  type SpeechProvider,
} from "./speech.ts";

// The speech port (ADR 0024, WP4.5): unit pricing, routing from the
// catalogue, the provider contract (exchangeable through a fake adapter) and
// the OpenAI adapter against an injected fetch. Nothing reaches a network.

const catalog: SpeechCatalogModel[] = Object.entries(priceCatalog)
  .filter(
    ([, e]) => e.purpose === "speech_to_text" || e.purpose === "text_to_speech",
  )
  .map(([id, e]) => ({
    id,
    provider: e.provider,
    purpose: e.purpose,
    active: true,
    unitPrice: e.unitPrice,
    speech: e.speech,
  }));
const allVerified = { verifiedModels: catalog.map((m) => m.id) };

describe("speech unit pricing", () => {
  it("estimates STT per started second of the measured duration and TTS per character", () => {
    const perMinute = { unit: "audio_minute", micros: 6_000 };
    expect(speechCostMicros(perMinute, 60)).toBe(6_000);
    expect(speechCostMicros(perMinute, 30)).toBe(3_000);
    // 10.2 s count as 11 s: 11 * 6000 / 60 = 1100.
    expect(speechCostMicros(perMinute, 10.2)).toBe(1_100);
    const perCharacter = { unit: "character", micros: 15 };
    expect(speechCostMicros(perCharacter, 1_000)).toBe(15_000);
    // Six decimals of a micro: 0.6 micros per character, rounded up.
    expect(speechCostMicros({ unit: "character", micros: 0.6 }, 5)).toBe(3);
    expect(speechCostMicros({ unit: "character", micros: 0.000001 }, 1)).toBe(
      1,
    );
    // A reservation needs a positive amount.
    expect(speechCostMicros(perCharacter, 0)).toBe(1);
  });

  it("settles actual against the estimate in the same unit", () => {
    const perMinute = { unit: "audio_minute", micros: 3_000 };
    const estimate = speechCostMicros(perMinute, 42); // measured
    const actual = speechCostMicros(perMinute, 40.5); // reported by the provider
    expect(estimate).toBe(2_100);
    expect(actual).toBe(2_050);
    const perCharacter = { unit: "character", micros: 30 };
    expect(speechCostMicros(perCharacter, 2_400)).toBe(72_000);
  });

  it("refuses an unknown unit, token prices and invalid quantities", () => {
    expect(() => speechCostMicros({ unit: "token", micros: 1 }, 10)).toThrow(
      "PRICE_UNIT_UNKNOWN",
    );
    expect(() => speechCostMicros({ unit: "second", micros: 1 }, 10)).toThrow(
      "PRICE_UNIT_UNKNOWN",
    );
    expect(() =>
      speechCostMicros({ unit: "character", micros: -1 }, 10),
    ).toThrow("SPEECH_PRICE_REQUIRED");
    expect(() =>
      speechCostMicros({ unit: "character", micros: 1 }, Number.NaN),
    ).toThrow("INVALID_USAGE");
  });

  it("leaves token pricing unchanged", () => {
    const runtime = {
      rateCard: {
        m: {
          inputMicrosPerMillion: 2_000_000,
          outputMicrosPerMillion: 10_000_000,
          verifiedAt: new Date().toISOString(),
        },
      },
    };
    const usage = {
      inputTokens: 1000,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 500,
      reasoningTokens: 0,
      detailsKnown: true,
    };
    expect(computeCost("m", usage, runtime as never)).toBe(7_000);
    for (const entry of Object.values(priceCatalog))
      if (entry.purpose === "text" || entry.purpose === "embedding") {
        expect(entry.rate).toBeDefined();
        expect(entry.unitPrice).toBeUndefined();
      }
  });
});

describe("speech routing from the catalogue", () => {
  it("routes each class to the first active, verified, priced model of its purpose", () => {
    const stt = resolveSpeechRoute("speech_to_text", allVerified, catalog);
    expect(stt).toMatchObject({
      model: "gpt-4o-mini-transcribe",
      provider: "openai",
      price: { unit: "audio_minute" },
    });
    const tts = resolveSpeechRoute("text_to_speech", allVerified, catalog);
    expect(tts).toMatchObject({
      model: "tts-1",
      voice: "alloy",
      price: { unit: "character" },
    });
    // Switching the first model off moves to the next.
    const off = catalog.map((m) =>
      m.id === "gpt-4o-mini-transcribe" ? { ...m, active: false } : m,
    );
    expect(resolveSpeechRoute("speech_to_text", allVerified, off).model).toBe(
      "gpt-4o-transcribe",
    );
  });

  it("has no model id constant in the call path: a different catalogue routes differently", () => {
    const other: SpeechCatalogModel[] = [
      {
        id: "fake-stt",
        provider: "openai",
        purpose: "speech_to_text",
        active: true,
        unitPrice: { unit: "audio_minute", micros: 1 },
      },
    ];
    expect(
      resolveSpeechRoute(
        "speech_to_text",
        { verifiedModels: ["fake-stt"] },
        other,
      ).model,
    ).toBe("fake-stt");
  });

  it("fails closed without a model, verification, price or the right unit", () => {
    expect(() => resolveSpeechRoute("speech_to_text", allVerified, [])).toThrow(
      "SPEECH_MODEL_NOT_CONFIGURED",
    );
    expect(() =>
      resolveSpeechRoute("speech_to_text", { verifiedModels: [] }, catalog),
    ).toThrow("MODEL_CAPABILITY_NOT_VERIFIED");
    const unpriced = catalog.map((m) => ({ ...m, unitPrice: undefined }));
    expect(() =>
      resolveSpeechRoute("text_to_speech", allVerified, unpriced),
    ).toThrow("SPEECH_PRICE_REQUIRED");
    const wrongUnit = catalog.map((m) => ({
      ...m,
      unitPrice: { unit: "token", micros: 1 },
    }));
    expect(() =>
      resolveSpeechRoute("speech_to_text", allVerified, wrongUnit),
    ).toThrow("PRICE_UNIT_UNKNOWN");
    expect(() =>
      resolveSpeechRoute("text_to_speech", allVerified, catalog, {
        model: "tts-1",
        voice: "not-a-voice",
      }),
    ).toThrow("SPEECH_VOICE_REQUIRED");
  });

  it("dates every speech price and marks it for review", () => {
    for (const m of catalog) {
      const entry = priceCatalog[m.id]!;
      expect(Date.parse(entry.verifiedAt)).not.toBeNaN();
      expect(entry.source).toMatch(/^https:\/\//);
      expect(entry.note).toMatch(/re-verified/);
    }
  });

  it("accepts only the recording types of the allow-list", () => {
    expect(speechMimeOf("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(speechMimeOf("AUDIO/MP4")).toBe("audio/mp4");
    for (const type of [
      "audio/ogg",
      "audio/wav",
      "video/webm",
      "application/octet-stream",
      undefined,
    ])
      expect(speechMimeOf(type)).toBeNull();
  });

  it("caps read-aloud text at a word boundary", () => {
    const long = "word ".repeat(1000);
    const capped = capSpeechText(long, 100);
    expect(capped.truncated).toBe(true);
    expect(capped.text.length).toBeLessThanOrEqual(100);
    expect(capped.text.endsWith("word")).toBe(true);
    expect(capSpeechText(" short ", 100)).toEqual({
      text: "short",
      truncated: false,
    });
  });
});

/** A provider-neutral contract every speech adapter must meet. */
async function contract(provider: SpeechProvider, expectText: string) {
  const signal = new AbortController().signal;
  const heard = await provider.transcribe(
    { audio: Uint8Array.from([1, 2, 3]), mime: "audio/webm", model: "m" },
    signal,
  );
  expect(heard.text).toBe(expectText);
  const spoken = await provider.synthesize(
    { text: "Hello there", voice: "v", format: "mp3", model: "m" },
    signal,
  );
  expect(spoken.characters).toBe(11);
  expect(spoken.mime).toMatch(/^audio\//);
  const chunks: Uint8Array[] = [];
  for await (const chunk of spoken.audio) chunks.push(chunk);
  expect(chunks.reduce((n, c) => n + c.length, 0)).toBeGreaterThan(0);
}

function fakeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init ?? {}),
  );
}

describe("speech provider contract", () => {
  it("is met by a fake adapter (exchangeable provider)", async () => {
    await contract(fakeSpeechProvider("from the fake"), "from the fake");
  });

  it("is met by the OpenAI adapter over an injected fetch, without retries", async () => {
    const fetch = fakeFetch((url, init) => {
      if (url.endsWith("/audio/transcriptions")) {
        const form = init.body as FormData;
        expect(form.get("model")).toBe("m");
        expect(["audio/webm", "audio/mp4"]).toContain(
          (form.get("file") as File).type,
        );
        return Response.json({
          text: "from openai",
          usage: { type: "duration", seconds: 3 },
        });
      }
      expect(JSON.parse(String(init.body))).toEqual({
        model: "m",
        input: "Hello there",
        voice: "v",
        response_format: "mp3",
      });
      return new Response(Uint8Array.from([1, 2, 3]), {
        headers: { "content-type": "audio/mpeg" },
      });
    });
    const provider = openAiSpeechProvider({
      apiKey: "synthetic-test-key",
      fetch: fetch as never,
      baseUrl: "https://example.invalid/v1",
    });
    await contract(provider, "from openai");
    expect(fetch).toHaveBeenCalledTimes(2);
    const reported = await provider.transcribe(
      { audio: Uint8Array.from([1]), mime: "audio/mp4", model: "m" },
      new AbortController().signal,
    );
    expect(reported.durationSeconds).toBe(3);
  });

  it("reports refusals as rejected, everything unclear as unknown, and never retries", async () => {
    const signal = () => new AbortController().signal;
    const input = {
      audio: Uint8Array.from([1]),
      mime: "audio/webm" as const,
      model: "m",
    };
    for (const [status, outcome] of [
      [400, "rejected"],
      [429, "rejected"],
      [500, "unknown"],
      [503, "unknown"],
    ] as const) {
      const fetch = fakeFetch(() => new Response("{}", { status }));
      const provider = openAiSpeechProvider({
        apiKey: "k",
        fetch: fetch as never,
      });
      await expect(provider.transcribe(input, signal())).rejects.toMatchObject({
        outcome,
        status,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const broken = fakeFetch(() => {
      throw new TypeError("socket hang up");
    });
    const provider = openAiSpeechProvider({
      apiKey: "k",
      fetch: broken as never,
    });
    await expect(
      provider.synthesize(
        { text: "x", voice: "v", format: "mp3", model: "m" },
        signal(),
      ),
    ).rejects.toMatchObject({
      outcome: "unknown",
    });
    expect(broken).toHaveBeenCalledTimes(1);
    // A cut-off JSON answer after transmission is unknown, not retried.
    const cut = fakeFetch(() => new Response('{"text": "par', { status: 200 }));
    await expect(
      openAiSpeechProvider({ apiKey: "k", fetch: cut as never }).transcribe(
        input,
        signal(),
      ),
    ).rejects.toMatchObject({ outcome: "unknown" });
    expect(cut).toHaveBeenCalledTimes(1);
    // Aborted before sending: nothing left Orbit.
    const aborted = new AbortController();
    aborted.abort();
    const idle = fakeFetch(() => Response.json({}));
    await expect(
      openAiSpeechProvider({ apiKey: "k", fetch: idle as never }).transcribe(
        input,
        aborted.signal,
      ),
    ).rejects.toMatchObject({ outcome: "not_sent" });
    expect(idle).not.toHaveBeenCalled();
    expect(() => openAiSpeechProvider({ apiKey: "" })).toThrow(
      SpeechProviderError,
    );
  });
});

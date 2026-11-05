import { describe, expect, it } from "vitest";
import { measureAudioDuration, opusPacketMs } from "./audio-duration.ts";
import { mp4Recording, webmRecording } from "./audio-fixtures.test-helpers.ts";

// Server-side duration measurement (ADR 0024): the estimate a transcription
// reserves rests on it, so shortened timestamps or headers must not lower it
// and anything unparseable is refused.

describe("measureAudioDuration", () => {
  it("measures a MediaRecorder-style WebM/Opus recording without an Info duration", () => {
    const { durationSeconds, container } = measureAudioDuration(
      webmRecording(12),
      "audio/webm",
    );
    expect(container).toBe("webm");
    expect(durationSeconds).toBeCloseTo(12, 1);
  });

  it("keeps the Opus packet sum when timestamps or the header claim less", () => {
    const squeezed = webmRecording(30, {
      timestampScale: 0.1,
      infoDurationMs: 1000,
    });
    expect(
      measureAudioDuration(squeezed, "audio/webm").durationSeconds,
    ).toBeCloseTo(30, 1);
  });

  it("takes a longer Info duration into account", () => {
    const stated = webmRecording(5, { infoDurationMs: 90_000 });
    expect(
      measureAudioDuration(stated, "audio/webm").durationSeconds,
    ).toBeCloseTo(90, 1);
  });

  it("refuses WebM without Opus, with laced blocks, truncated or garbage", () => {
    expect(() =>
      measureAudioDuration(
        webmRecording(2, { codec: "A_VORBIS" }),
        "audio/webm",
      ),
    ).toThrow("SPEECH_UNREADABLE");
    expect(() =>
      measureAudioDuration(webmRecording(2, { laced: true }), "audio/webm"),
    ).toThrow("SPEECH_UNREADABLE");
    expect(() =>
      measureAudioDuration(webmRecording(2).subarray(0, 30), "audio/webm"),
    ).toThrow("SPEECH_UNREADABLE");
    expect(() =>
      measureAudioDuration(new Uint8Array(4096).fill(7), "audio/webm"),
    ).toThrow("SPEECH_UNREADABLE");
    expect(() => measureAudioDuration(new Uint8Array(0), "audio/webm")).toThrow(
      "SPEECH_UNREADABLE",
    );
    // A container of the other kind is not read as this one.
    expect(() => measureAudioDuration(mp4Recording(3), "audio/webm")).toThrow(
      "SPEECH_UNREADABLE",
    );
  });

  it("measures plain and fragmented MP4/AAC (Safari)", () => {
    expect(
      measureAudioDuration(mp4Recording(8), "audio/mp4").durationSeconds,
    ).toBeCloseTo(8, 1);
    const fragmented = measureAudioDuration(
      mp4Recording(20, { fragmented: true }),
      "audio/mp4",
    );
    expect(fragmented.container).toBe("mp4");
    expect(fragmented.durationSeconds).toBeCloseTo(20, 1);
  });

  it("keeps the AAC frame count when MP4 headers claim less", () => {
    expect(
      measureAudioDuration(mp4Recording(40, { headerSeconds: 1 }), "audio/mp4")
        .durationSeconds,
    ).toBeCloseTo(40, 0);
    expect(
      measureAudioDuration(
        mp4Recording(40, { fragmented: true, headerSeconds: 1 }),
        "audio/mp4",
      ).durationSeconds,
    ).toBeCloseTo(40, 0);
  });

  it("refuses MP4 without an audio track, truncated or garbage", () => {
    expect(() =>
      measureAudioDuration(
        mp4Recording(3, { noAudioTrack: true }),
        "audio/mp4",
      ),
    ).toThrow("SPEECH_UNREADABLE");
    expect(() =>
      measureAudioDuration(mp4Recording(3).subarray(0, 40), "audio/mp4"),
    ).toThrow("SPEECH_UNREADABLE");
    expect(() =>
      measureAudioDuration(new Uint8Array(512).fill(1), "audio/mp4"),
    ).toThrow("SPEECH_UNREADABLE");
    expect(() => measureAudioDuration(webmRecording(3), "audio/mp4")).toThrow(
      "SPEECH_UNREADABLE",
    );
  });
});

describe("opusPacketMs", () => {
  it("reads frame size and count from the TOC byte", () => {
    expect(opusPacketMs(Uint8Array.from([0xf8]))).toBe(20); // CELT 20 ms, one frame
    expect(opusPacketMs(Uint8Array.from([0x19]))).toBe(120); // SILK 60 ms, two frames
    expect(opusPacketMs(Uint8Array.from([0xe3, 0x04]))).toBe(10); // CELT 2.5 ms, four frames
    expect(() => opusPacketMs(Uint8Array.from([0x1b, 0x03]))).toThrow(
      "SPEECH_UNREADABLE",
    ); // 180 ms
    expect(() => opusPacketMs(new Uint8Array(0))).toThrow("SPEECH_UNREADABLE");
  });
});

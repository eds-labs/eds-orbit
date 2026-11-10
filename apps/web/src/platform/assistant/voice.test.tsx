import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createSpeechPlayer,
  initialRecorder,
  MicButtonView,
  pickRecordingMime,
  ReadAloudView,
  recorderReducer,
  voiceErrorText,
  voiceViewProps,
  VoiceSettingsForm,
  type RecorderState,
  type VoiceStatus,
} from "./voice";
import type { AssistantConversation } from "./use-assistant-conversation";

// Voice controls (ADR 0024, WP4.6/WP4.7): format negotiation, the recorder's
// states and their accessible markup, the read-aloud player, and that voice
// adds nothing while it is off. No microphone, network or audio is used.

const limits = {
  maxSeconds: 60,
  maxBytes: 2 * 1024 * 1024,
  maxCharacters: 3000,
};

describe("pickRecordingMime", () => {
  it("prefers WebM/Opus and falls back to MP4 for Safari", () => {
    expect(pickRecordingMime(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickRecordingMime((t) => t.startsWith("audio/mp4"))).toBe(
      "audio/mp4;codecs=mp4a.40.2",
    );
    expect(pickRecordingMime((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickRecordingMime(() => false)).toBeNull();
  });
});

describe("recorder states", () => {
  const run = (...events: Parameters<typeof recorderReducer>[1][]) =>
    events.reduce<RecorderState>(recorderReducer, initialRecorder);

  it("moves idle → requesting → recording → transcribing → done", () => {
    expect(run({ type: "request", mode: "hold" })).toMatchObject({
      phase: "requesting",
      mode: "hold",
    });
    expect(
      run({ type: "request", mode: "hold" }, { type: "started" }),
    ).toMatchObject({ phase: "recording" });
    expect(
      run(
        { type: "request", mode: "hold" },
        { type: "started" },
        { type: "tick", seconds: 4 },
      ),
    ).toMatchObject({ seconds: 4 });
    expect(
      run(
        { type: "request", mode: "hold" },
        { type: "started" },
        { type: "stopped" },
      ),
    ).toMatchObject({ phase: "transcribing" });
    expect(
      run(
        { type: "request", mode: "toggle" },
        { type: "started" },
        { type: "stopped" },
        { type: "done", outcome: "added" },
      ),
    ).toEqual({ ...initialRecorder, notice: { kind: "added" } });
  });

  it("switches a short press into toggle mode and ignores events out of order", () => {
    expect(
      run(
        { type: "request", mode: "hold" },
        { type: "started" },
        { type: "toggle" },
      ).mode,
    ).toBe("toggle");
    expect(run({ type: "started" })).toEqual(initialRecorder);
    expect(run({ type: "stopped" })).toEqual(initialRecorder);
    const busy = run({ type: "request", mode: "hold" }, { type: "started" });
    expect(recorderReducer(busy, { type: "request", mode: "toggle" })).toBe(
      busy,
    );
  });

  it("ends in an error state that a new press leaves", () => {
    const failed = run(
      { type: "request", mode: "hold" },
      { type: "failed", code: "MICROPHONE_DENIED" },
    );
    expect(failed).toMatchObject({
      phase: "error",
      notice: { kind: "error", code: "MICROPHONE_DENIED" },
    });
    expect(
      recorderReducer(failed, { type: "request", mode: "hold" }).phase,
    ).toBe("requesting");
    expect(
      run({ type: "request", mode: "hold" }, { type: "canceled" }),
    ).toEqual(initialRecorder);
  });
});

describe("MicButtonView", () => {
  const render = (state: RecorderState, de = false) =>
    renderToStaticMarkup(
      <MicButtonView state={state} de={de} maxSeconds={60} />,
    );

  it("shows an idle microphone with a hint and an empty live region", () => {
    const html = render(initialRecorder);
    expect(html).toContain('aria-label="Voice input"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Hold to talk");
  });

  it("shows a visible recording state with the time and a stop label", () => {
    const html = render({ ...initialRecorder, phase: "recording", seconds: 7 });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Stop recording"');
    expect(html).toContain("voice-recording");
    expect(html).toContain("Recording · 7 of 60 s");
    expect(
      render({ ...initialRecorder, phase: "recording", seconds: 7 }, true),
    ).toContain("Aufnahme läuft · 7 von 60 s");
  });

  it("disables the button while transcribing and announces outcomes and errors", () => {
    const transcribing = render({ ...initialRecorder, phase: "transcribing" });
    expect(transcribing).toContain("disabled");
    expect(transcribing).toContain("Transcribing…");
    expect(render({ ...initialRecorder, notice: { kind: "added" } })).toContain(
      "Check it before sending",
    );
    expect(
      render({
        ...initialRecorder,
        phase: "error",
        notice: { kind: "error", code: "SPEECH_TOO_LONG" },
      }),
    ).toContain("longer than allowed");
  });

  it("explains voice and budget codes", () => {
    expect(voiceErrorText("SPEECH_PROVIDER_NOT_ALLOWED", false)).toMatch(
      /not approved for personal data/,
    );
    expect(voiceErrorText("BUDGET_EXCEEDED", false)).toMatch(
      /assistant budget/,
    );
    expect(voiceErrorText("MICROPHONE_DENIED", true)).toMatch(/Mikrofon/);
  });
});

describe("read aloud", () => {
  it("renders idle, loading, playing and error per message", () => {
    const idle = renderToStaticMarkup(
      <ReadAloudView
        messageId="m1"
        player={{ messageId: null, phase: "idle" }}
        de={false}
      />,
    );
    expect(idle).toContain("Read aloud");
    expect(idle).toContain('aria-pressed="false"');
    const loading = renderToStaticMarkup(
      <ReadAloudView
        messageId="m1"
        player={{ messageId: "m1", phase: "loading" }}
        de={false}
      />,
    );
    expect(loading).toContain("Creating audio…");
    expect(loading).toContain('aria-pressed="true"');
    const playing = renderToStaticMarkup(
      <ReadAloudView
        messageId="m1"
        player={{ messageId: "m1", phase: "playing" }}
        de
      />,
    );
    expect(playing).toContain("Vorlesen beenden");
    // Another message playing leaves this one idle.
    expect(
      renderToStaticMarkup(
        <ReadAloudView
          messageId="m2"
          player={{ messageId: "m1", phase: "playing" }}
          de={false}
        />,
      ),
    ).toContain("Read aloud");
    expect(
      renderToStaticMarkup(
        <ReadAloudView
          messageId="m1"
          player={{
            messageId: "m1",
            phase: "error",
            code: "SPEECH_OUTCOME_UNKNOWN",
          }}
          de={false}
        />,
      ),
    ).toContain("not retried automatically");
  });

  it("plays one message at a time and releases the audio when stopped", async () => {
    const played: string[] = [];
    const paused: string[] = [];
    class FakeAudio {
      onended: null | (() => void) = null;
      constructor(readonly src: string) {}
      play() {
        played.push(this.src);
        return Promise.resolve();
      }
      pause() {
        paused.push(this.src);
      }
    }
    vi.stubGlobal("Audio", FakeAudio);
    const revoke = vi.fn();
    let n = 0;
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: () => `blob:${++n}`,
      revokeObjectURL: revoke,
    });
    const load = vi.fn(
      async () => new Blob([Uint8Array.from([1])], { type: "audio/mpeg" }),
    );
    const player = createSpeechPlayer(load);
    await player.play("m1");
    expect(player.getSnapshot()).toEqual({ messageId: "m1", phase: "playing" });
    await player.play("m2");
    expect(paused).toEqual(["blob:1"]);
    expect(revoke).toHaveBeenCalledWith("blob:1");
    player.stop();
    expect(player.getSnapshot()).toEqual({ messageId: null, phase: "idle" });
    expect(played).toEqual(["blob:1", "blob:2"]);
    const failing = createSpeechPlayer(async () => {
      throw Object.assign(new Error("x"), { code: "BUDGET_EXCEEDED" });
    });
    await failing.play("m3");
    expect(failing.getSnapshot()).toMatchObject({
      messageId: "m3",
      phase: "error",
    });
    vi.unstubAllGlobals();
  });
});

describe("voiceViewProps", () => {
  const conversation = {
    busy: false,
    conversationId: "",
    detail: { data: null },
  } as unknown as AssistantConversation;
  const options = {
    conversation,
    input: "",
    setInput: () => {},
    inputId: "x",
    de: false,
  };
  const status = (stt: boolean, tts: boolean): VoiceStatus => ({
    available: true,
    workspaceId: "w1",
    settings: { autoSend: false, autoRead: false },
    limits,
    speechToText: { ready: stt },
    textToSpeech: { ready: tts },
  });

  it("adds nothing while voice is off or unavailable", () => {
    expect(voiceViewProps(null, options)).toEqual({});
    expect(
      voiceViewProps(
        {
          available: false,
          workspaceId: "w1",
          reason: "VOICE_ENTITLEMENT",
          settings: { autoSend: false, autoRead: false },
          limits,
        },
        options,
      ),
    ).toEqual({});
  });

  it("offers read aloud only for assistant messages with text and only when TTS is ready", () => {
    expect(
      voiceViewProps(status(true, false), options).messageActions,
    ).toBeUndefined();
    const props = voiceViewProps(status(false, true), options);
    expect(props.composerTools).toBeDefined();
    const action = props.messageActions!;
    expect(action({ id: "u", role: "user", text: "Hi", cards: [] })).toBeNull();
    expect(
      action({ id: "e", role: "assistant", text: "  ", cards: [] }),
    ).toBeNull();
    expect(
      renderToStaticMarkup(
        <>
          {action({ id: "a", role: "assistant", text: "Answer", cards: [] })}
        </>,
      ),
    ).toContain("Read aloud");
  });

  it("renders the microphone only when STT is ready", () => {
    expect(
      renderToStaticMarkup(
        <>{voiceViewProps(status(true, true), options).composerTools}</>,
      ),
    ).toContain('aria-label="Voice input"');
    expect(
      renderToStaticMarkup(
        <>{voiceViewProps(status(false, true), options).composerTools}</>,
      ),
    ).toBe("");
  });
});

describe("VoiceSettingsForm", () => {
  it("shows both switches off by default with their hints", () => {
    const html = renderToStaticMarkup(
      <VoiceSettingsForm
        de={false}
        initial={{ autoSend: false, autoRead: false }}
        save={async (v) => ({ autoSend: false, autoRead: false, ...v })}
      />,
    );
    expect(html).toContain("Send transcripts right away");
    expect(html).toContain("Read answers aloud automatically");
    expect(html).toContain("Recordings are not stored");
    expect(html.match(/role="switch"/g)).toHaveLength(2);
    expect(html).not.toContain("checked");
  });
});

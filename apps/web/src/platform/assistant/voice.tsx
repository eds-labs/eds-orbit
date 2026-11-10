"use client";
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { LoaderCircle, Mic, Square, Volume2 } from "lucide-react";
import { ApiError, put, useResource } from "@/lib/api";
import { Button } from "@/components/ui/primitives";
import { chatErrorText } from "@/components/chat-errors";
import { withWorkspace, type ChatMessage } from "./api";
import type { AssistantContextValue } from "./assistant-context";
import type { AssistantConversation } from "./use-assistant-conversation";

// Voice in the personal assistant (ADR 0024, plan Phase 4 WP4.6/WP4.7): a
// push-to-talk microphone in the composer (hold to talk, or click / Enter /
// Space to start and stop), "Read aloud" per answer and the user's voice
// switches. The microphone is opened only after the user presses the
// button; the recording goes to the API in memory and its transcript lands
// in the composer (sent automatically only with the user's setting). No
// audio is kept in the browser after the request either.

export type VoiceSettings = { autoSend: boolean; autoRead: boolean };
type Readiness = { ready: boolean; reason?: string };
export type VoiceStatus =
  | {
      available: true;
      workspaceId: string;
      settings: VoiceSettings;
      limits: { maxSeconds: number; maxBytes: number; maxCharacters: number };
      speechToText: Readiness;
      textToSpeech: Readiness;
    }
  | {
      available: false;
      workspaceId: string;
      reason: string;
      settings: VoiceSettings;
      limits: { maxSeconds: number; maxBytes: number; maxCharacters: number };
    };

export const voicePaths = {
  settings: (workspaceId?: string) =>
    withWorkspace("/assistant/voice-settings", workspaceId),
  transcriptions: (workspaceId?: string) =>
    withWorkspace("/assistant/transcriptions", workspaceId),
  speech: (workspaceId?: string) =>
    withWorkspace("/assistant/speech", workspaceId),
};

async function failure(response: Response) {
  const value = await response.json().catch(() => null);
  return new ApiError(value?.error?.code ?? "REQUEST_FAILED", response.status);
}

/** Sends one recording as the raw request body; returns the transcript. */
export async function transcribeRecording(blob: Blob, workspaceId?: string) {
  const response = await fetch(
    `/api${voicePaths.transcriptions(workspaceId)}`,
    {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": blob.type.split(";")[0]! },
      body: blob,
    },
  );
  if (!response.ok) throw await failure(response);
  return (await response.json()) as { text: string; durationSeconds: number };
}

/** The spoken audio of one assistant message. */
export async function fetchSpeech(
  messageId: string,
  workspaceId: string | undefined,
  signal: AbortSignal,
) {
  const response = await fetch(`/api${voicePaths.speech(workspaceId)}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId }),
    signal,
  });
  if (!response.ok) throw await failure(response);
  return response.blob();
}

export const voiceText = (de: boolean) => ({
  record: de ? "Spracheingabe" : "Voice input",
  recordHint: de
    ? "Gedrückt halten zum Sprechen, oder klicken bzw. Enter drücken zum Starten und Stoppen"
    : "Hold to talk, or click or press Enter to start and stop",
  stop: de ? "Aufnahme beenden" : "Stop recording",
  requesting: de ? "Mikrofon wird geöffnet…" : "Opening the microphone…",
  recording: (seconds: number, max: number) =>
    de
      ? `Aufnahme läuft · ${seconds} von ${max} s`
      : `Recording · ${seconds} of ${max} s`,
  transcribing: de ? "Wird verschriftlicht…" : "Transcribing…",
  added: de
    ? "Text ins Eingabefeld übernommen. Prüfe ihn vor dem Senden."
    : "Text added to the message box. Check it before sending.",
  sent: de ? "Text gesendet." : "Text sent.",
  empty: de ? "Es wurde nichts erkannt." : "Nothing was recognized.",
  readAloud: de ? "Vorlesen" : "Read aloud",
  stopReading: de ? "Vorlesen beenden" : "Stop reading",
  loadingAudio: de ? "Audio wird erzeugt…" : "Creating audio…",
  settingsTitle: de ? "Sprache" : "Voice",
  settingsIntro: de
    ? "Spracheingabe und Vorlesen im Assistenten. Aufnahmen werden nicht gespeichert; sie zählen zu deinem Assistenten-Budget."
    : "Voice input and read aloud in the assistant. Recordings are not stored; they count toward your assistant budget.",
  autoSend: de
    ? "Verschriftlichten Text sofort senden"
    : "Send transcripts right away",
  autoSendHint: de
    ? "Aus: Der Text landet zuerst im Eingabefeld, damit du ihn prüfen kannst."
    : "Off: the text lands in the message box first so you can check it.",
  autoRead: de
    ? "Antworten automatisch vorlesen"
    : "Read answers aloud automatically",
  autoReadHint: de
    ? "Jede neue Antwort wird vorgelesen; das kostet pro Zeichen."
    : "Every new answer is read aloud; this costs per character.",
});

const errorTexts: Record<string, [string, string]> = {
  SPEECH_TOO_LONG: [
    "The recording is longer than allowed. Keep it under a minute.",
    "Die Aufnahme ist länger als erlaubt. Bleib unter einer Minute.",
  ],
  SPEECH_TOO_LARGE: [
    "The recording is too large.",
    "Die Aufnahme ist zu groß.",
  ],
  SPEECH_UNREADABLE: [
    "The recording could not be read. Please try again.",
    "Die Aufnahme konnte nicht gelesen werden. Bitte versuche es erneut.",
  ],
  SPEECH_FORMAT_UNSUPPORTED: [
    "This browser records in a format Orbit does not accept.",
    "Dieser Browser nimmt in einem Format auf, das Orbit nicht annimmt.",
  ],
  SPEECH_PROVIDER_NOT_ALLOWED: [
    "Voice is not available: its provider is not approved for personal data.",
    "Sprache ist nicht verfügbar: Ihr Anbieter ist für personenbezogene Daten nicht freigegeben.",
  ],
  SPEECH_NOT_CONFIGURED: [
    "Voice is not set up for your organization yet.",
    "Sprache ist für deine Organisation noch nicht eingerichtet.",
  ],
  SPEECH_MODEL_NOT_CONFIGURED: [
    "Voice is not set up for your organization yet.",
    "Sprache ist für deine Organisation noch nicht eingerichtet.",
  ],
  SPEECH_PRICE_REQUIRED: [
    "Voice has no price yet; an administrator has to save one.",
    "Für Sprache ist noch kein Preis hinterlegt; ein Administrator muss ihn speichern.",
  ],
  SPEECH_PROVIDER_REJECTED: [
    "The speech service refused the request. Please try again later.",
    "Der Sprachdienst hat die Anfrage abgelehnt. Bitte versuche es später erneut.",
  ],
  SPEECH_OUTCOME_UNKNOWN: [
    "The speech service did not answer clearly. It is not retried automatically.",
    "Der Sprachdienst hat nicht eindeutig geantwortet. Es wird nicht automatisch wiederholt.",
  ],
  SPEECH_NOTHING_TO_READ: [
    "This answer has no text to read.",
    "Diese Antwort hat keinen Text zum Vorlesen.",
  ],
  VOICE_ENTITLEMENT: [
    "Voice is not included for your organization.",
    "Sprache ist für deine Organisation nicht enthalten.",
  ],
  MICROPHONE_DENIED: [
    "The microphone is blocked. Allow it in the browser and try again.",
    "Das Mikrofon ist blockiert. Erlaube es im Browser und versuche es erneut.",
  ],
  VOICE_UNSUPPORTED: [
    "This browser cannot record audio.",
    "Dieser Browser kann kein Audio aufnehmen.",
  ],
  PLAYBACK_FAILED: [
    "The audio could not be played.",
    "Das Audio konnte nicht abgespielt werden.",
  ],
};

/** A voice code as a sentence; other codes (budget, gates) as in the chat. */
export function voiceErrorText(code: string, de: boolean) {
  return errorTexts[code]?.[de ? 1 : 0] ?? chatErrorText(code, de, true);
}
const codeOf = (cause: unknown) =>
  cause instanceof ApiError
    ? cause.code
    : cause instanceof Error
      ? cause.message
      : "REQUEST_FAILED";

/**
 * The recording type to ask MediaRecorder for: WebM/Opus where the browser
 * supports it (Chrome, Firefox, Android), else MP4 (Safari). Null when the
 * browser can record neither.
 */
export function pickRecordingMime(
  isTypeSupported: (type: string) => boolean,
): string | null {
  for (const type of [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
  ])
    if (isTypeSupported(type)) return type;
  return null;
}

// ------------------------------------------------------------ recorder ----

export type RecorderState = {
  phase: "idle" | "requesting" | "recording" | "transcribing" | "error";
  mode: "hold" | "toggle";
  seconds: number;
  /** The last outcome for the live region: an error code or a done message. */
  notice:
    | { kind: "error"; code: string }
    | { kind: "added" | "sent" | "empty" }
    | null;
};
export type RecorderEvent =
  | { type: "request"; mode: "hold" | "toggle" }
  | { type: "started" }
  | { type: "tick"; seconds: number }
  | { type: "toggle" }
  | { type: "stopped" }
  | { type: "canceled" }
  | { type: "done"; outcome: "added" | "sent" | "empty" }
  | { type: "failed"; code: string };

export const initialRecorder: RecorderState = {
  phase: "idle",
  mode: "hold",
  seconds: 0,
  notice: null,
};

/** The recorder's states: idle → requesting → recording → transcribing → idle (or error). */
export function recorderReducer(
  state: RecorderState,
  event: RecorderEvent,
): RecorderState {
  switch (event.type) {
    case "request":
      return state.phase === "idle" || state.phase === "error"
        ? { phase: "requesting", mode: event.mode, seconds: 0, notice: null }
        : state;
    case "started":
      return state.phase === "requesting"
        ? { ...state, phase: "recording" }
        : state;
    case "tick":
      return state.phase === "recording"
        ? { ...state, seconds: event.seconds }
        : state;
    case "toggle":
      return state.phase === "recording" || state.phase === "requesting"
        ? { ...state, mode: "toggle" }
        : state;
    case "stopped":
      return state.phase === "recording"
        ? { ...state, phase: "transcribing" }
        : state;
    case "canceled":
      return { ...initialRecorder };
    case "done":
      return { ...initialRecorder, notice: { kind: event.outcome } };
    case "failed":
      return {
        ...initialRecorder,
        phase: "error",
        notice: { kind: "error", code: event.code },
      };
  }
}

/** The microphone button and its live status, for a recorder state. */
export function MicButtonView({
  state,
  de,
  maxSeconds,
  disabled,
  handlers = {},
}: {
  state: RecorderState;
  de: boolean;
  maxSeconds: number;
  disabled?: boolean;
  handlers?: {
    onPointerDown?: (event: PointerEvent<HTMLButtonElement>) => void;
    onPointerUp?: (event: PointerEvent<HTMLButtonElement>) => void;
    onPointerLeave?: (event: PointerEvent<HTMLButtonElement>) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  };
}) {
  const t = voiceText(de);
  const active = state.phase === "recording" || state.phase === "requesting";
  const status =
    state.phase === "requesting"
      ? t.requesting
      : state.phase === "recording"
        ? t.recording(state.seconds, maxSeconds)
        : state.phase === "transcribing"
          ? t.transcribing
          : state.notice?.kind === "error"
            ? voiceErrorText(state.notice.code, de)
            : state.notice
              ? t[state.notice.kind]
              : "";
  return (
    <span className="voice-mic" data-phase={state.phase}>
      <Button
        type="button"
        size="icon"
        variant={active ? "destructive" : "outline"}
        aria-label={active ? t.stop : t.record}
        aria-pressed={active}
        title={active ? t.stop : t.recordHint}
        disabled={disabled || state.phase === "transcribing"}
        className={active ? "voice-recording" : undefined}
        {...handlers}
      >
        {state.phase === "transcribing" ? (
          <LoaderCircle aria-hidden="true" className="spin" />
        ) : active ? (
          <Square aria-hidden="true" />
        ) : (
          <Mic aria-hidden="true" />
        )}
      </Button>
      <span
        className={status ? "voice-status" : "sr-only"}
        role="status"
        aria-live="polite"
      >
        {status}
      </span>
    </span>
  );
}

/** A short press switches hold-to-talk into toggle mode. */
const HOLD_MS = 400;

export function MicButton({
  de,
  workspaceId,
  limits,
  disabled,
  onTranscript,
}: {
  de: boolean;
  workspaceId?: string;
  limits: { maxSeconds: number; maxBytes: number };
  disabled?: boolean;
  /** Returns whether the text was sent (auto-send) or put in the composer. */
  onTranscript: (text: string) => Promise<"added" | "sent">;
}) {
  const [state, dispatch] = useReducer(recorderReducer, initialRecorder);
  const live = useRef<{
    recorder?: MediaRecorder;
    stream?: MediaStream;
    timer?: ReturnType<typeof setInterval>;
    downAt: number;
    stopRequested: boolean;
    canceled: boolean;
  }>({ downAt: 0, stopRequested: false, canceled: false });
  const stateRef = useRef(state);
  stateRef.current = state;

  function release() {
    const current = live.current;
    if (current.timer) clearInterval(current.timer);
    current.stream?.getTracks().forEach((track) => track.stop());
    current.recorder = undefined;
    current.stream = undefined;
    current.timer = undefined;
  }
  useEffect(
    () => () => {
      live.current.canceled = true;
      live.current.recorder?.state === "recording" &&
        live.current.recorder.stop();
      release();
    },
    [],
  );

  function stop() {
    const recorder = live.current.recorder;
    if (recorder?.state === "recording") recorder.stop();
    else live.current.stopRequested = true;
  }

  async function start(mode: "hold" | "toggle") {
    dispatch({ type: "request", mode });
    live.current.stopRequested = false;
    live.current.canceled = false;
    const mime =
      typeof MediaRecorder !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function"
        ? pickRecordingMime((type) => MediaRecorder.isTypeSupported(type))
        : null;
    if (!mime) return dispatch({ type: "failed", code: "VOICE_UNSUPPORTED" });
    let stream: MediaStream;
    try {
      // The only place the microphone opens: after the user pressed the button.
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return dispatch({ type: "failed", code: "MICROPHONE_DENIED" });
    }
    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      audioBitsPerSecond: 32_000,
    });
    const chunks: Blob[] = [];
    let bytes = 0;
    live.current = { ...live.current, recorder, stream };
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      chunks.push(event.data);
      bytes += event.data.size;
      if (bytes >= limits.maxBytes * 0.95 && recorder.state === "recording")
        recorder.stop();
    };
    recorder.onstop = () => {
      const type = (recorder.mimeType || mime).split(";")[0]!;
      release();
      if (live.current.canceled) return dispatch({ type: "canceled" });
      dispatch({ type: "stopped" });
      const blob = new Blob(chunks, { type });
      chunks.length = 0;
      void (async () => {
        try {
          const { text } = await transcribeRecording(blob, workspaceId);
          if (!text.trim()) return dispatch({ type: "done", outcome: "empty" });
          dispatch({ type: "done", outcome: await onTranscript(text.trim()) });
        } catch (cause) {
          dispatch({ type: "failed", code: codeOf(cause) });
        }
      })();
    };
    recorder.start(250);
    dispatch({ type: "started" });
    const began = Date.now();
    live.current.timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - began) / 1000);
      dispatch({ type: "tick", seconds });
      // Stop just before the limit so the measured duration stays within it.
      if ((Date.now() - began) / 1000 >= limits.maxSeconds - 0.5) stop();
    }, 250);
    if (live.current.stopRequested) stop();
  }

  const recording = () =>
    ["recording", "requesting"].includes(stateRef.current.phase);
  const handlers = {
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      if (event.button !== 0) return;
      event.preventDefault();
      if (recording()) {
        if (stateRef.current.mode === "toggle") stop();
        return;
      }
      live.current.downAt = Date.now();
      void start("hold");
    },
    onPointerUp() {
      if (!recording() || stateRef.current.mode !== "hold") return;
      if (Date.now() - live.current.downAt < HOLD_MS)
        dispatch({ type: "toggle" });
      else stop();
    },
    onPointerLeave() {
      if (
        recording() &&
        stateRef.current.mode === "hold" &&
        Date.now() - live.current.downAt >= HOLD_MS
      )
        stop();
    },
    onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
      if (event.key === "Escape" && recording()) {
        event.preventDefault();
        live.current.canceled = true;
        stop();
        return;
      }
      if ((event.key !== "Enter" && event.key !== " ") || event.repeat) return;
      event.preventDefault();
      if (recording()) stop();
      else void start("toggle");
    },
  };
  return (
    <MicButtonView
      state={state}
      de={de}
      maxSeconds={limits.maxSeconds}
      disabled={disabled}
      handlers={handlers}
    />
  );
}

// -------------------------------------------------------------- player ----

export type PlayerState = {
  messageId: string | null;
  phase: "idle" | "loading" | "playing" | "error";
  code?: string;
};

/** One player for the whole page: a new read-aloud stops the previous one. */
export function createSpeechPlayer(load: typeof fetchSpeech = fetchSpeech) {
  let state: PlayerState = { messageId: null, phase: "idle" };
  let audio: HTMLAudioElement | null = null;
  let url: string | null = null;
  let controller: AbortController | null = null;
  const listeners = new Set<() => void>();
  const set = (next: PlayerState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  function cleanup() {
    controller?.abort();
    controller = null;
    audio?.pause();
    audio = null;
    if (url) URL.revokeObjectURL(url);
    url = null;
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      cleanup();
      set({ messageId: null, phase: "idle" });
    },
    async play(messageId: string, workspaceId?: string) {
      cleanup();
      const own = new AbortController();
      controller = own;
      set({ messageId, phase: "loading" });
      try {
        const blob = await load(messageId, workspaceId, own.signal);
        if (own.signal.aborted) return;
        url = URL.createObjectURL(blob);
        audio = new Audio(url);
        audio.onended = () => {
          cleanup();
          set({ messageId: null, phase: "idle" });
        };
        await audio.play();
        set({ messageId, phase: "playing" });
      } catch (cause) {
        if (own.signal.aborted) return;
        cleanup();
        set({
          messageId,
          phase: "error",
          code:
            cause instanceof DOMException ? "PLAYBACK_FAILED" : codeOf(cause),
        });
      }
    },
  };
}
export const speechPlayer = createSpeechPlayer();
const IDLE: PlayerState = { messageId: null, phase: "idle" };

/** "Read aloud" of one message for a player state. */
export function ReadAloudView({
  messageId,
  player,
  de,
  onPlay,
  onStop,
}: {
  messageId: string;
  player: PlayerState;
  de: boolean;
  onPlay?: () => void;
  onStop?: () => void;
}) {
  const t = voiceText(de);
  const mine = player.messageId === messageId;
  const busy =
    mine && (player.phase === "loading" || player.phase === "playing");
  return (
    <span className="voice-read" data-phase={mine ? player.phase : "idle"}>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-pressed={busy}
        onClick={busy ? onStop : onPlay}
      >
        {mine && player.phase === "loading" ? (
          <LoaderCircle aria-hidden="true" className="spin" />
        ) : busy ? (
          <Square aria-hidden="true" />
        ) : (
          <Volume2 aria-hidden="true" />
        )}
        {busy ? t.stopReading : t.readAloud}
      </Button>
      <span
        className={mine && player.phase !== "idle" ? "voice-status" : "sr-only"}
        role="status"
        aria-live="polite"
      >
        {mine && player.phase === "loading"
          ? t.loadingAudio
          : mine && player.phase === "error"
            ? voiceErrorText(player.code ?? "PLAYBACK_FAILED", de)
            : ""}
      </span>
    </span>
  );
}

function usePlayer() {
  return useSyncExternalStore(
    speechPlayer.subscribe,
    speechPlayer.getSnapshot,
    () => IDLE,
  );
}

export function ReadAloudButton({
  messageId,
  workspaceId,
  de,
}: {
  messageId: string;
  workspaceId?: string;
  de: boolean;
}) {
  const player = usePlayer();
  return (
    <ReadAloudView
      messageId={messageId}
      player={player}
      de={de}
      onPlay={() => void speechPlayer.play(messageId, workspaceId)}
      onStop={() => speechPlayer.stop()}
    />
  );
}

// ------------------------------------------------------------ assembly ----

/** The voice status of the assistant's organization; null while off or loading. */
export function useAssistantVoice(assistant: AssistantContextValue | null) {
  const path = assistant?.enabled
    ? voicePaths.settings(assistant.status?.workspaceId)
    : null;
  const status = useResource<VoiceStatus>(path);
  return status.data?.available ? status.data : null;
}

/** The newest assistant message of the open conversation, read aloud when new (auto-read). */
function useAutoRead(
  conversation: AssistantConversation,
  enabled: boolean,
  workspaceId?: string,
) {
  const messages = conversation.detail.data?.messages ?? [];
  const latest =
    [...messages].reverse().find((m) => m.role === "assistant")?.id ?? null;
  const seen = useRef<{ conversation: string; id: string | null } | null>(null);
  useEffect(() => {
    const id = conversation.conversationId;
    if (!conversation.detail.data) return;
    // A conversation opened or loaded: what is there already is not new.
    if (!seen.current || seen.current.conversation !== id) {
      seen.current = { conversation: id, id: latest };
      return;
    }
    if (latest && latest !== seen.current.id) {
      seen.current = { conversation: id, id: latest };
      if (enabled) void speechPlayer.play(latest, workspaceId);
    }
  }, [
    conversation.conversationId,
    conversation.detail.data,
    latest,
    enabled,
    workspaceId,
  ]);
}

function VoiceComposer({
  voice,
  conversation,
  input,
  setInput,
  inputId,
  de,
}: {
  voice: Extract<VoiceStatus, { available: true }>;
  conversation: AssistantConversation;
  input: string;
  setInput: (value: string) => void;
  inputId: string;
  de: boolean;
}) {
  const inputRef = useRef(input);
  inputRef.current = input;
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  useAutoRead(
    conversation,
    voice.textToSpeech.ready && voice.settings.autoRead,
    voice.workspaceId,
  );
  if (!voice.speechToText.ready) return null;
  return (
    <MicButton
      de={de}
      workspaceId={voice.workspaceId}
      limits={voice.limits}
      disabled={conversation.busy}
      onTranscript={async (text) => {
        if (
          voice.settings.autoSend &&
          !inputRef.current.trim() &&
          !conversationRef.current.busy
        ) {
          if (await conversationRef.current.send(text)) return "sent";
        }
        const current = inputRef.current.trim();
        setInput(current ? `${current} ${text}` : text);
        document.getElementById(inputId)?.focus();
        return "added";
      }}
    />
  );
}

/**
 * The voice props of a ConversationView in personal mode: the microphone in
 * the composer and "Read aloud" under each assistant message, each only
 * while its route is ready. Empty while voice is off.
 */
export function voiceViewProps(
  voice: VoiceStatus | null,
  options: {
    conversation: AssistantConversation;
    input: string;
    setInput: (value: string) => void;
    inputId: string;
    de: boolean;
  },
): {
  composerTools?: ReactNode;
  messageActions?: (message: ChatMessage) => ReactNode;
} {
  if (!voice?.available) return {};
  return {
    composerTools: <VoiceComposer voice={voice} {...options} />,
    ...(voice.textToSpeech.ready
      ? {
          messageActions: (message: ChatMessage) =>
            message.role === "assistant" && message.text.trim() ? (
              <ReadAloudButton
                messageId={message.id}
                workspaceId={voice.workspaceId}
                de={options.de}
              />
            ) : null,
        }
      : {}),
  };
}

// ------------------------------------------------------------ settings ----

/** The voice switches on "My context"; nothing while voice is off. */
export function VoiceSettingsPanel({
  workspaceId,
  de,
}: {
  workspaceId?: string;
  de: boolean;
}) {
  const status = useResource<VoiceStatus>(voicePaths.settings(workspaceId));
  if (!status.data?.available) return null;
  return (
    <VoiceSettingsForm
      de={de}
      workspaceId={workspaceId}
      initial={status.data.settings}
    />
  );
}

export function VoiceSettingsForm({
  de,
  workspaceId,
  initial,
  save = (change) =>
    put<VoiceSettings>(voicePaths.settings(workspaceId), change),
}: {
  de: boolean;
  workspaceId?: string;
  initial: VoiceSettings;
  save?: (change: Partial<VoiceSettings>) => Promise<VoiceSettings>;
}) {
  const t = voiceText(de);
  const [settings, setSettings] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function change(next: Partial<VoiceSettings>) {
    setPending(true);
    setError("");
    try {
      setSettings(await save(next));
    } catch (cause) {
      setError(voiceErrorText(codeOf(cause), de));
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="panel" aria-labelledby="voice-settings-title">
      <div className="panel-head">
        <div>
          <h2 id="voice-settings-title">{t.settingsTitle}</h2>
          <p>{t.settingsIntro}</p>
        </div>
      </div>
      <div className="panel-body personal-context-settings">
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {(["autoSend", "autoRead"] as const).map((key) => (
          <label className="switch-row" key={key}>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={settings[key]}
              disabled={pending}
              onChange={(event) => void change({ [key]: event.target.checked })}
            />
            <span>
              <strong>{t[key]}</strong>
              <small>
                {key === "autoSend" ? t.autoSendHint : t.autoReadHint}
              </small>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

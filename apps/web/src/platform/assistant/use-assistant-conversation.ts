"use client";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api, collectionPath, post, useResource } from "@/lib/api";
import { chatErrorOf } from "@/components/chat-errors";
import { runToFollow } from "@/components/chat-resume";
import {
  messageBody,
  type ChatRun,
  type Conversation,
  type ConversationDetail,
  type SendExtras,
} from "./api";

// The headless Orbit Chat conversation (plan agent-platform-phase-3 §2.7,
// WP3.8): list, load, send with a client request id, follow the run over
// SSE, cancel and archive. The project page (project mode) and the personal
// assistant's panel and page (personal mode, the personal space's project id)
// share it; the views only render what it returns.

export const TERMINAL_RUN = new Set([
  "succeeded",
  "blocked",
  "failed",
  "canceled",
]);
const UUID = /^[a-f0-9-]{36}$/i;

export type ConversationState = {
  /** The chat this state belongs to; a different one resets it. */
  projectId: string;
  conversationId: string;
  /** The run followed over SSE; "" while none. */
  activeRunId: string;
  /** The followed run's last snapshot (kept after it ends for its error). */
  stream: ChatRun | null;
  pending: boolean;
  error: string;
  historyRevision: number;
  detailRevision: number;
};

export type ConversationAction =
  | { type: "reset"; projectId: string; conversationId: string }
  | { type: "open"; conversationId: string }
  | { type: "new" }
  | { type: "busy" }
  | { type: "created"; conversationId: string }
  | { type: "accepted"; runId: string }
  | { type: "failed"; error: string }
  | { type: "done" }
  | { type: "follow"; run: ChatRun }
  | { type: "snapshot"; run: ChatRun }
  | { type: "archived"; conversationId: string }
  | { type: "refresh" }
  | { type: "poll" }
  | { type: "error"; error: string };

export const initialConversation = (
  projectId: string,
  conversationId = "",
): ConversationState => ({
  projectId,
  conversationId,
  activeRunId: "",
  stream: null,
  pending: false,
  error: "",
  historyRevision: 0,
  detailRevision: 0,
});

/** The conversation's state machine; pure, so the transitions are tested. */
export function conversationReducer(
  state: ConversationState,
  action: ConversationAction,
): ConversationState {
  switch (action.type) {
    case "reset":
      return initialConversation(action.projectId, action.conversationId);
    case "open":
      return {
        ...state,
        conversationId: action.conversationId,
        activeRunId: "",
        stream: null,
        error: "",
      };
    case "new":
      return {
        ...state,
        conversationId: "",
        activeRunId: "",
        stream: null,
        error: "",
      };
    case "busy":
      return { ...state, pending: true, error: "" };
    case "created":
      return { ...state, conversationId: action.conversationId };
    case "accepted":
      return {
        ...state,
        pending: false,
        activeRunId: action.runId,
        stream: {
          id: action.runId,
          status: "queued",
          partialText: "",
          errorCode: null,
          sequence: 0,
        },
        historyRevision: state.historyRevision + 1,
        detailRevision: state.detailRevision + 1,
      };
    case "failed":
      return { ...state, pending: false, error: action.error };
    case "done":
      return {
        ...state,
        pending: false,
        historyRevision: state.historyRevision + 1,
        detailRevision: state.detailRevision + 1,
      };
    case "follow":
      // A run of the loaded conversation that is still going (after a reload
      // or on reopening); never replaces one already followed.
      if (state.activeRunId) return state;
      return { ...state, activeRunId: action.run.id, stream: action.run };
    case "snapshot": {
      // Late events of a run no longer followed are ignored.
      if (action.run.id !== state.activeRunId) return state;
      if (action.run.sequence < (state.stream?.sequence ?? 0)) return state;
      if (!TERMINAL_RUN.has(action.run.status))
        return { ...state, stream: action.run };
      return {
        ...state,
        stream: action.run,
        activeRunId: "",
        historyRevision: state.historyRevision + 1,
        detailRevision: state.detailRevision + 1,
      };
    }
    case "archived":
      return {
        ...state,
        conversationId:
          action.conversationId === state.conversationId
            ? ""
            : state.conversationId,
        historyRevision: state.historyRevision + 1,
      };
    case "refresh":
      return {
        ...state,
        historyRevision: state.historyRevision + 1,
        detailRevision: state.detailRevision + 1,
      };
    case "poll":
      return { ...state, detailRevision: state.detailRevision + 1 };
    case "error":
      return { ...state, error: action.error };
  }
}

/** Whether a message may be sent now: text, and no request or run going. */
export function canSend(state: ConversationState, text: string) {
  return Boolean(text.trim()) && !state.pending && !state.activeRunId;
}

function readStored(key: string) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}
function writeStored(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* Storage may be unavailable; the chat then opens empty next time. */
  }
}

/**
 * The conversation to open first: a `?conversation=` deep link when the view
 * reads links, else the last one opened in this chat.
 */
export function initialConversationId(
  href: string | null,
  stored: string,
): string {
  if (href) {
    const linked = new URL(href).searchParams.get("conversation");
    if (linked && UUID.test(linked)) return linked;
  }
  return UUID.test(stored) ? stored : "";
}

export type AssistantConversationOptions = {
  /** The chat's project: the business project, or the personal space. "" is off. */
  projectId: string;
  /** localStorage key of the last opened conversation. */
  storageKey: string;
  /** Reads `?conversation=` on load (pages, not the floating panel). */
  readLink?: boolean;
  /** Personal mode: personal error texts. */
  personal?: boolean;
  de: boolean;
  /** Hints added to every message (personal mode). */
  extras?: () => SendExtras;
  /** Called once when a followed run ends. */
  onRunEnd?: (run: ChatRun) => void;
};

export function useAssistantConversation(
  options: AssistantConversationOptions,
) {
  const { projectId, storageKey, readLink, personal = false, de } = options;
  const [state, dispatch] = useReducer(conversationReducer, projectId, (id) =>
    initialConversation(id),
  );
  const [loaded, setLoaded] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const base = projectId ? collectionPath(projectId, "chat") : "";
  const ready = Boolean(projectId) && loaded === `${projectId}|${storageKey}`;
  // The first conversation of this chat; again when the chat changes (the
  // personal space of another organization).
  useEffect(() => {
    dispatch({
      type: "reset",
      projectId,
      conversationId: projectId
        ? initialConversationId(
            readLink ? window.location.href : null,
            readStored(storageKey),
          )
        : "",
    });
    setLoaded(`${projectId}|${storageKey}`);
  }, [projectId, storageKey, readLink]);
  useEffect(() => {
    if (ready) writeStored(storageKey, state.conversationId);
  }, [ready, storageKey, state.conversationId]);
  const archivedQuery = showArchived ? "&archived=true" : "";
  const history = useResource<{
    items: Conversation[];
    nextCursor: string | null;
  }>(
    ready
      ? `${base}/conversations?revision=${state.historyRevision}${archivedQuery}`
      : null,
  );
  const [older, setOlder] = useState<{
    items: Conversation[];
    next: string | null;
  }>({ items: [], next: null });
  useEffect(() => {
    setOlder({ items: [], next: history.data?.nextCursor ?? null });
  }, [history.data]);
  const detail = useResource<ConversationDetail>(
    ready && state.conversationId
      ? `${base}/conversations/${state.conversationId}?revision=${state.detailRevision}`
      : null,
  );
  useEffect(() => {
    const run = runToFollow(
      detail.data,
      state.conversationId,
      state.activeRunId,
    );
    if (run) dispatch({ type: "follow", run });
  }, [detail.data, state.conversationId, state.activeRunId]);
  useEffect(() => {
    if (!state.activeRunId || !projectId) return;
    const events = new EventSource(
      `/api/projects/${encodeURIComponent(projectId)}/chat/runs/${encodeURIComponent(state.activeRunId)}/events`,
    );
    events.addEventListener("snapshot", (event) => {
      const run = JSON.parse((event as MessageEvent).data) as ChatRun;
      dispatch({ type: "snapshot", run });
      if (TERMINAL_RUN.has(run.status)) {
        events.close();
        optionsRef.current.onRunEnd?.(run);
      }
    });
    events.onerror = () => {
      /* EventSource reconnects; the saved run remains authoritative. */
    };
    return () => events.close();
  }, [state.activeRunId, projectId]);
  const errorOf = useCallback(
    (cause: unknown) => chatErrorOf(cause, de, personal),
    [de, personal],
  );
  const open = useCallback(
    (conversationId: string) => dispatch({ type: "open", conversationId }),
    [],
  );
  const startNew = useCallback(() => dispatch({ type: "new" }), []);
  const refresh = useCallback(() => dispatch({ type: "refresh" }), []);
  const poll = useCallback(() => dispatch({ type: "poll" }), []);
  const setError = useCallback(
    (error: string) => dispatch({ type: "error", error }),
    [],
  );
  /** Sends one message; true when the run was accepted (clear the input). */
  async function send(input: string): Promise<boolean> {
    const text = input.trim();
    if (!base || !canSend(state, text)) return false;
    dispatch({ type: "busy" });
    try {
      let id = state.conversationId;
      if (!id) {
        const created = await post<Conversation>(`${base}/conversations`, {});
        id = created.id;
        dispatch({ type: "created", conversationId: id });
      }
      const result = await post<{ runId: string }>(
        `${base}/conversations/${id}/messages`,
        messageBody(
          text,
          crypto.randomUUID(),
          optionsRef.current.extras?.() ?? {},
        ),
      );
      dispatch({ type: "accepted", runId: result.runId });
      return true;
    } catch (cause) {
      dispatch({ type: "failed", error: errorOf(cause) });
      return false;
    }
  }
  async function cancel() {
    if (!state.activeRunId || !base) return;
    try {
      await post(`${base}/runs/${state.activeRunId}/cancel`, {});
    } catch (cause) {
      setError(errorOf(cause));
    }
  }
  async function archive(conversationId: string, archived: boolean) {
    if (!base) return;
    try {
      await post(`${base}/conversations/${conversationId}/archive`, {
        archived,
      });
      dispatch({ type: "archived", conversationId });
    } catch (cause) {
      setError(errorOf(cause));
    }
  }
  async function loadOlder() {
    if (!older.next || !base) return;
    try {
      const page = await api<{
        items: Conversation[];
        nextCursor: string | null;
      }>(`${base}/conversations?cursor=${older.next}${archivedQuery}`);
      setOlder((current) => ({
        items: [...current.items, ...page.items],
        next: page.nextCursor,
      }));
    } catch (cause) {
      setError(errorOf(cause));
    }
  }
  /**
   * Runs one action with the chat's pending state and error line, then
   * reloads the conversation (the module chat parts' `ChatHost.run`).
   */
  async function run(task: () => Promise<string | void>, failure: string) {
    dispatch({ type: "busy" });
    try {
      const message = await task();
      dispatch({ type: "done" });
      if (message) dispatch({ type: "error", error: message });
    } catch (cause) {
      dispatch({
        type: "failed",
        error: cause instanceof Error ? errorOf(cause) : failure,
      });
    }
  }
  return {
    base,
    projectId,
    state,
    conversationId: state.conversationId,
    activeRunId: state.activeRunId,
    stream: state.stream,
    pending: state.pending,
    error: state.error,
    busy: state.pending || Boolean(state.activeRunId),
    history: {
      items: [...(history.data?.items ?? []), ...older.items],
      loading: history.loading && ready,
      error: history.error,
      hasOlder: Boolean(older.next),
      showArchived,
      setShowArchived,
      loadOlder,
    },
    detail: {
      data:
        detail.data && detail.data.conversation.id === state.conversationId
          ? detail.data
          : null,
      loading: detail.loading && Boolean(state.conversationId),
      error: detail.error,
    },
    open,
    startNew,
    send,
    cancel,
    archive,
    refresh,
    poll,
    run,
    setError,
  };
}

export type AssistantConversation = ReturnType<typeof useAssistantConversation>;

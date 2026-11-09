import { ApiError } from "@/lib/api";
import type { HandoffSession } from "./api";
import {
  sessionKept,
  type SessionKeptReason,
  type SessionLostReason,
} from "./bridge";

// Opens a mailbox in the embedded client (ADR 0026, E4): one POST for a
// one-time token, one form posted into the frame. The token only ever exists
// in a local variable and, for the length of submit(), in a detached form.

export const FRAME_NAME = "orbit-webmail";
export const FRAME_SANDBOX =
  "allow-same-origin allow-scripts allow-forms allow-downloads allow-popups";
export const LOAD_TIMEOUT_MS = 20_000;

const EMBED_REFERRER_POLICY = "strict-origin-when-cross-origin";
const APP_REFERRER_POLICY = "same-origin";

export type EmbedFailure =
  | "disabled"
  | "no_access"
  | "token"
  | "unavailable"
  | "timeout";

export type SessionEndedReason = Exclude<
  SessionLostReason,
  SessionKeptReason | "not_authorized"
>;

export type EmbedState =
  | { phase: "requesting" }
  | { phase: "loading" }
  /** The client is up; a banner says a page could not be shown just now. */
  | { phase: "ready"; banner?: SessionKeptReason }
  | { phase: "ended"; reason: SessionEndedReason }
  | { phase: "error"; reason: EmbedFailure };

/** What a failed session request means for the member. */
export function failureOf(error: unknown): EmbedFailure {
  if (!(error instanceof ApiError)) return "token";
  if (error.code === "WEBMAIL_DISABLED") return "disabled";
  if (error.code === "WEBMAIL_MAILBOX_UNAVAILABLE") return "unavailable";
  if (error.code === "WEBMAIL_MAILBOX_NOT_FOUND") return "no_access";
  if (error.status === 403 || error.status === 404) return "no_access";
  if (error.status >= 502 && error.status <= 504) return "unavailable";
  return "token";
}

/** True when the handoff goes to the webmail origin and nowhere else. */
export function actionIsAllowed(action: string, origin: string) {
  try {
    return new URL(action).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Posts the handoff into the named frame. The browser reads the fields during
 * submit(), so the form is emptied and removed right after it.
 */
export function submitHandoff(
  doc: Document,
  frameName: string,
  session: HandoffSession,
) {
  const form = doc.createElement("form");
  form.method = "post";
  form.action = session.action;
  form.target = frameName;
  form.hidden = true;
  const inputs = Object.entries(session.fields).map(([name, value]) => {
    const input = doc.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    return input;
  });
  form.append(...inputs);
  doc.body.append(form);
  try {
    form.submit();
  } finally {
    for (const input of inputs) input.value = "";
    form.remove();
  }
}

/**
 * Lets the handoff carry the Orbit origin while the embed is open. The
 * route's response header (next.config.ts) only covers a full page load: the
 * sidebar navigates client-side, so the document keeps the `same-origin`
 * policy it was loaded with and the POST would send `Origin: null`. The
 * returned function restores the app's policy; removing the element alone
 * would not.
 */
export function holdReferrerPolicy(doc: Document) {
  const meta = doc.createElement("meta");
  meta.name = "referrer";
  meta.content = EMBED_REFERRER_POLICY;
  doc.head.append(meta);
  return () => {
    meta.content = APP_REFERRER_POLICY;
    meta.remove();
  };
}

/**
 * Runs session ends in order. DELETE names no session, so an end that arrives
 * late would close the session opened after it: a new session waits for them.
 */
export function createEndQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    add(task: () => Promise<unknown>) {
      tail = tail.then(task).catch(() => undefined);
    },
    idle: () => tail,
  };
}
export type EndQueue = ReturnType<typeof createEndQueue>;

export type EmbedDeps = {
  origin: string;
  queue: EndQueue;
  create: () => Promise<HandoffSession>;
  submit: (session: HandoffSession) => void;
  end: () => Promise<unknown>;
  onState: (state: EmbedState) => void;
  /** The member's access is gone; the page takes over from here. */
  onWithdrawn: () => void;
  timeoutMs?: number;
};

/** One attempt to open a mailbox: a fresh token every time, none reused. */
export function startEmbed(deps: EmbedDeps) {
  let cancelled = false;
  // "waiting" lasts from the submit until the client's first message.
  let stage: "before" | "waiting" | "open" | "closed" = "before";
  let banner = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const fail = (reason: EmbedFailure) => {
    stage = "closed";
    if (!cancelled) deps.onState({ phase: "error", reason });
  };

  deps.onState({ phase: "requesting" });
  const created = deps.queue.idle().then(() => {
    if (cancelled) return false;
    return deps.create().then(
      (session) => {
        if (cancelled) return true;
        if (!actionIsAllowed(session.action, deps.origin)) {
          fail("token");
          return true;
        }
        try {
          deps.submit(session);
        } catch {
          fail("token");
          return true;
        }
        stage = "waiting";
        deps.onState({ phase: "loading" });
        timer = setTimeout(() => fail("timeout"), deps.timeoutMs ?? LOAD_TIMEOUT_MS);
        return true;
      },
      (error) => {
        fail(failureOf(error));
        return false;
      },
    );
  });

  return {
    /**
     * The client rendered a page of a live session. It says so on every page,
     * so this is the only success signal: a frame's load event also fires for
     * error pages and blocked sign-ins.
     */
    ready() {
      if (stage === "waiting") clearTimeout(timer);
      else if (stage !== "open" || !banner) return;
      stage = "open";
      banner = false;
      deps.onState({ phase: "ready" });
    },
    sessionLost(reason: SessionLostReason) {
      if (stage !== "waiting" && stage !== "open") return;
      clearTimeout(timer);
      if (sessionKept(reason)) {
        // The frame answered, so embedding works: show it with the banner.
        stage = "open";
        banner = true;
        deps.onState({ phase: "ready", banner: reason });
        return;
      }
      stage = "closed";
      if (reason === "not_authorized") deps.onWithdrawn();
      else deps.onState({ phase: "ended", reason });
    },
    /** The member retries from the banner; the session itself is still there. */
    clearBanner() {
      if (stage !== "open" || !banner) return;
      banner = false;
      deps.onState({ phase: "ready" });
    },
    /** Leaves this attempt and ends its session once it is known to exist. */
    cancel() {
      cancelled = true;
      stage = "closed";
      clearTimeout(timer);
      deps.queue.add(async () => {
        if (await created) await deps.end();
      });
    },
  };
}

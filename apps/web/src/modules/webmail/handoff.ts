import { ApiError } from "@/lib/api";
import type { HandoffSession } from "./api";

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

export type EmbedState =
  | { phase: "requesting" }
  | { phase: "loading" }
  | { phase: "ready" }
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
  timeoutMs?: number;
};

/** One attempt to open a mailbox: a fresh token every time, none reused. */
export function startEmbed(deps: EmbedDeps) {
  let cancelled = false;
  let awaitingLoad = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const fail = (reason: EmbedFailure) => {
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
        awaitingLoad = true;
        deps.onState({ phase: "loading" });
        timer = setTimeout(() => {
          awaitingLoad = false;
          fail("timeout");
        }, deps.timeoutMs ?? LOAD_TIMEOUT_MS);
        return true;
      },
      (error) => {
        fail(failureOf(error));
        return false;
      },
    );
  });

  return {
    /** The frame's load event; the frame's first blank load comes too early. */
    loaded() {
      if (!awaitingLoad || cancelled) return;
      awaitingLoad = false;
      clearTimeout(timer);
      deps.onState({ phase: "ready" });
    },
    /** Leaves this attempt and ends its session once it is known to exist. */
    cancel() {
      cancelled = true;
      awaitingLoad = false;
      clearTimeout(timer);
      deps.queue.add(async () => {
        if (await created) await deps.end();
      });
    },
  };
}

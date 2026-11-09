"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Alert, Button, Loading } from "@/components/ui/primitives";
import { createSession, endSession, type ConvertReference } from "./api";
import { listenToBridge, type BridgeMessage } from "./bridge";
import {
  createEndQueue,
  FRAME_NAME,
  FRAME_SANDBOX,
  holdReferrerPolicy,
  startEmbed,
  submitHandoff,
  type EmbedState,
} from "./handoff";
import type { WebmailText } from "./labels";
import styles from "./webmail.module.css";

// The embedded client (ADR 0026): a sandboxed frame on the webmail origin.

// Module-level so that it also orders the end of a session when the member
// leaves the page and comes straight back.
const endQueue = createEndQueue();

/** Hands a message of the embedded client to whoever acts on it. */
export function dispatchBridgeMessage(
  message: BridgeMessage,
  shownMailboxId: string,
  flow: Pick<
    ReturnType<typeof startEmbed>,
    "ready" | "sessionLost" | "sessionMoved"
  > | null,
  onConvert: ((reference: ConvertReference) => void) | null,
) {
  if (message.kind === "ready") flow?.ready();
  else if (message.kind === "session_lost") flow?.sessionLost(message.reason);
  // First, and whatever the member's rights: a dialog here would take over a
  // message of a mailbox this page does not show.
  else if (message.mailboxId !== shownMailboxId) flow?.sessionMoved();
  else onConvert?.(message.reference);
}

/** The frame and its states; an error replaces the frame, never a blank one. */
export function EmbedView({
  t,
  state,
  address,
  frameRef,
  onRetry,
  onBannerRetry,
}: {
  t: WebmailText;
  state: EmbedState;
  address: string;
  frameRef?: RefObject<HTMLIFrameElement | null>;
  onRetry: () => void;
  onBannerRetry: () => void;
}) {
  if (state.phase === "error")
    return (
      <div className={styles.failure}>
        <Alert kind="error">{t.embed.failure[state.reason]}</Alert>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t.retry}
        </Button>
      </div>
    );
  if (state.phase === "ended")
    return (
      <div className={styles.failure}>
        <Alert kind="info">{t.embed.ended[state.reason]}</Alert>
        <Button size="sm" onClick={onRetry}>
          {t.embed.reopen}
        </Button>
      </div>
    );
  const ready = state.phase === "ready";
  return (
    <div className={styles.embed}>
      {ready && state.banner && (
        <div className={styles.banner}>
          <Alert kind="warning">{t.embed.banner[state.banner]}</Alert>
          <Button variant="outline" size="sm" onClick={onBannerRetry}>
            {t.retry}
          </Button>
        </div>
      )}
      <div className={styles.frameWrap}>
        <iframe
          ref={frameRef}
          name={FRAME_NAME}
          title={t.embed.frameTitle(address)}
          sandbox={FRAME_SANDBOX}
          className={styles.frame}
        />
        {!ready && (
          <div className={styles.frameCover}>
            <Loading label={t.embed.opening} />
          </div>
        )}
      </div>
      <div className={styles.frameHint}>
        {!ready && <p className="field-hint">{t.embed.hint}</p>}
        <Button variant="ghost" size="sm" onClick={onRetry}>
          {t.embed.reload}
        </Button>
      </div>
    </div>
  );
}

function EmbedAttempt({
  t,
  projectId,
  mailboxId,
  address,
  origin,
  onConvert,
  onWithdrawn,
  onRetry,
}: {
  t: WebmailText;
  projectId: string;
  mailboxId: string;
  address: string;
  origin: string;
  onConvert: ((reference: ConvertReference) => void) | null;
  onWithdrawn: (mailbox: { id: string; address: string }) => void;
  onRetry: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const flow = useRef<ReturnType<typeof startEmbed> | null>(null);
  const [state, setState] = useState<EmbedState>({ phase: "requesting" });

  useEffect(() => {
    // Deferred: React's second effect pass in development cancels the timer,
    // so it never opens two sessions.
    const timer = setTimeout(() => {
      flow.current = startEmbed({
        origin,
        queue: endQueue,
        create: () => createSession(projectId, mailboxId),
        // The token goes straight from the response into the form.
        submit: (session) => submitHandoff(document, FRAME_NAME, session),
        end: () => endSession(projectId, mailboxId),
        onState: setState,
        onWithdrawn: () => onWithdrawn({ id: mailboxId, address }),
      });
    }, 0);
    return () => {
      clearTimeout(timer);
      flow.current?.cancel();
      flow.current = null;
    };
  }, [projectId, mailboxId, address, origin, onWithdrawn]);

  useEffect(
    () =>
      listenToBridge(
        window,
        origin,
        () => frameRef.current?.contentWindow ?? null,
        (message) =>
          dispatchBridgeMessage(message, mailboxId, flow.current, onConvert),
      ),
    [origin, mailboxId, onConvert],
  );

  return (
    <EmbedView
      t={t}
      state={state}
      address={address}
      frameRef={frameRef}
      onRetry={onRetry}
      onBannerRetry={() => {
        flow.current?.clearBanner();
        // The session is still there, so no new handoff: load its start page.
        if (frameRef.current) frameRef.current.src = `${origin}/`;
      }}
    />
  );
}

/** Opens the mailbox; a new mailbox or a retry starts over with a new token. */
export function WebmailEmbed(props: {
  t: WebmailText;
  projectId: string;
  mailboxId: string;
  address: string;
  origin: string;
  onConvert: ((reference: ConvertReference) => void) | null;
  onWithdrawn: (mailbox: { id: string; address: string }) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  useEffect(() => holdReferrerPolicy(document), []);
  return (
    <EmbedAttempt
      key={`${props.mailboxId}:${attempt}`}
      {...props}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  );
}

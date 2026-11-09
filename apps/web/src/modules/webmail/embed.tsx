"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Alert, Button, Loading } from "@/components/ui/primitives";
import { createSession, endSession, type ConvertReference } from "./api";
import { listenForConvert } from "./bridge";
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

/** The frame and its states; an error replaces the frame, never a blank one. */
export function EmbedView({
  t,
  state,
  address,
  frameRef,
  onLoad,
  onRetry,
}: {
  t: WebmailText;
  state: EmbedState;
  address: string;
  frameRef?: RefObject<HTMLIFrameElement | null>;
  onLoad: () => void;
  onRetry: () => void;
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
  return (
    <div className={styles.embed}>
      <div className={styles.frameWrap}>
        <iframe
          ref={frameRef}
          name={FRAME_NAME}
          title={t.embed.frameTitle(address)}
          sandbox={FRAME_SANDBOX}
          className={styles.frame}
          onLoad={onLoad}
        />
        {state.phase !== "ready" && (
          <div className={styles.frameCover}>
            <Loading label={t.embed.opening} />
          </div>
        )}
      </div>
      <div className={styles.frameHint}>
        <p className="field-hint">{t.embed.hint}</p>
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
  onRetry,
}: {
  t: WebmailText;
  projectId: string;
  mailboxId: string;
  address: string;
  origin: string;
  onConvert: ((reference: ConvertReference) => void) | null;
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
      });
    }, 0);
    return () => {
      clearTimeout(timer);
      flow.current?.cancel();
      flow.current = null;
    };
  }, [projectId, mailboxId, origin]);

  useEffect(() => {
    if (!onConvert) return;
    return listenForConvert(
      window,
      origin,
      () => frameRef.current?.contentWindow ?? null,
      onConvert,
    );
  }, [origin, onConvert]);

  return (
    <EmbedView
      t={t}
      state={state}
      address={address}
      frameRef={frameRef}
      onLoad={() => flow.current?.loaded()}
      onRetry={onRetry}
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

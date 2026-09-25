"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { MessageCircle, Plus, Send, Square, ExternalLink } from "lucide-react";
import { api, collectionPath, post, useResource, usd } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Loading,
  Textarea,
} from "./ui/primitives";
import { PageHead } from "./work";
import { useWorkspace } from "./workspace-context";

type Conversation = { id: string; title: string; updatedAt: string };
type Card = {
  kind: "source" | "asset" | "link" | "status";
  label: string;
  href?: string;
  status?: string;
  resourceId?: string;
  version?: number;
};
type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  cards: Card[];
};
type Run = {
  id: string;
  status: string;
  partialText: string;
  errorCode: string | null;
  sequence: number;
};
type Proposal = {
  id: string;
  groupId: string;
  version: number;
  payloadHash: string;
  status: string;
  missionId?: string;
  jobId?: string;
  action?: {
    status: string;
    error: string | null;
    contentId: string | null;
  } | null;
  payload: {
    mission: {
      title: string;
      goal: string;
      audience: string;
      channels: string[];
      startAt: string;
      endAt: string;
      maxContents: number;
      sourceIds: string[];
      assetIds: string[];
    };
    firstDraftMaxMicros: number;
    planMaxMicros: number;
    sources: { id: string }[];
    assets: { id: string }[];
  };
};
type Detail = {
  conversation: Conversation;
  messages: Message[];
  runs: Run[];
  proposals: Proposal[];
};
const terminal = new Set(["succeeded", "blocked", "failed", "canceled"]);

function statusLabel(status: string, de: boolean) {
  const labels: Record<string, [string, string]> = {
    proposed: ["Proposed", "Vorgeschlagen"],
    confirmation_required: [
      "Confirmation required",
      "Bestätigung erforderlich",
    ],
    queued: ["In progress", "In Bearbeitung"],
    running: ["In progress", "In Bearbeitung"],
    in_progress: ["In progress", "In Bearbeitung"],
    confirmed: ["In progress", "In Bearbeitung"],
    succeeded: ["Successful", "Erfolgreich"],
    blocked: ["Blocked", "Blockiert"],
    failed: ["Blocked", "Blockiert"],
    canceled: ["Canceled", "Abgebrochen"],
    blocked_dependency: ["Blocked", "Blockiert"],
    retry_scheduled: ["In progress", "In Bearbeitung"],
  };
  return (labels[status] ?? [status, status])[de ? 1 : 0];
}

export function OrbitChat() {
  const { project, identity, locale, canEdit } = useWorkspace();
  const de = locale === "de";
  const base = collectionPath(project.id, "chat");
  const savedKey = `orbit.chat.${identity.user.id}.${project.id}`;
  const [conversationId, setConversationId] = useState("");
  const [historyRevision, setHistoryRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const [input, setInput] = useState("");
  const [activeRunId, setActiveRunId] = useState("");
  const [stream, setStream] = useState<Run | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const history = useResource<{
    items: Conversation[];
    nextCursor: string | null;
  }>(`${base}/conversations?revision=${historyRevision}`);
  const detail = useResource<Detail>(
    conversationId
      ? `${base}/conversations/${conversationId}?revision=${detailRevision}`
      : null,
  );
  useEffect(() => {
    setConversationId(localStorage.getItem(savedKey) || "");
  }, [savedKey]);
  useEffect(() => {
    if (conversationId) localStorage.setItem(savedKey, conversationId);
    else localStorage.removeItem(savedKey);
  }, [conversationId, savedKey]);
  useEffect(() => {
    if (!detail.data || activeRunId) return;
    const current = detail.data.runs.find((run) => !terminal.has(run.status));
    if (current) {
      setActiveRunId(current.id);
      setStream(current);
    }
  }, [detail.data, activeRunId]);
  const refresh = useCallback(() => {
    setHistoryRevision((n) => n + 1);
    setDetailRevision((n) => n + 1);
  }, []);
  useEffect(() => {
    if (!activeRunId) return;
    const events = new EventSource(
      `/api/projects/${encodeURIComponent(project.id)}/chat/runs/${encodeURIComponent(activeRunId)}/events`,
    );
    events.addEventListener("snapshot", (event) => {
      const run = JSON.parse((event as MessageEvent).data) as Run;
      setStream(run);
      if (terminal.has(run.status)) {
        events.close();
        setActiveRunId("");
        refresh();
      }
    });
    events.onerror = () => {
      /* EventSource reconnects; the saved run remains authoritative. */
    };
    return () => events.close();
  }, [activeRunId, project.id, refresh]);
  async function send() {
    const text = input.trim();
    if (!text || pending || activeRunId) return;
    setPending(true);
    setError("");
    try {
      let id = conversationId;
      if (!id) {
        const created = await post<Conversation>(`${base}/conversations`, {});
        id = created.id;
        setConversationId(id);
      }
      const result = await post<{ runId: string }>(
        `${base}/conversations/${id}/messages`,
        { text, clientRequestId: crypto.randomUUID() },
      );
      setInput("");
      setActiveRunId(result.runId);
      setStream({
        id: result.runId,
        status: "queued",
        partialText: "",
        errorCode: null,
        sequence: 0,
      });
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    } finally {
      setPending(false);
    }
  }
  async function cancel() {
    if (!activeRunId) return;
    try {
      await post(`${base}/runs/${activeRunId}/cancel`, {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cancel failed");
    }
  }
  async function confirm(proposal: Proposal) {
    if (!canEdit) return;
    setPending(true);
    setError("");
    try {
      await post(`${base}/proposals/${proposal.id}/confirm`, {
        version: proposal.version,
        hash: proposal.payloadHash,
        confirmationId: crypto.randomUUID(),
      });
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Confirmation failed");
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    if (
      !detail.data?.proposals.some(
        (proposal) =>
          proposal.status === "confirmed" &&
          ["queued", "running", "retry_scheduled"].includes(
            proposal.action?.status ?? "",
          ),
      )
    )
      return;
    const timer = setInterval(() => setDetailRevision((n) => n + 1), 3000);
    return () => clearInterval(timer);
  }, [detail.data]);
  const proposals =
    detail.data?.proposals.filter(
      (proposal) =>
        !detail.data?.proposals.some(
          (later) =>
            later.groupId === proposal.groupId &&
            later.version > proposal.version,
        ),
    ) ?? [];
  return (
    <>
      <PageHead
        title="Orbit Chat"
        description={
          de
            ? "Projektbezogene Antworten, Quellen und prüfbare Aktionen."
            : "Project answers, sources, and reviewable actions."
        }
      />
      <div className="chat-context">
        <Badge tone="blue">{project.name}</Badge>
        <span>
          {de ? "Privater Verlauf · Projekt" : "Private history · Project"}
        </span>
      </div>
      <div className="chat-shell">
        <aside
          className="chat-history"
          aria-label={de ? "Unterhaltungen" : "Conversations"}
        >
          <Button
            size="sm"
            onClick={() => {
              setConversationId("");
              setActiveRunId("");
              setStream(null);
              setInput("");
            }}
          >
            <Plus aria-hidden="true" />
            {de ? "Neuer Chat" : "New chat"}
          </Button>
          {history.loading && (
            <Loading label={de ? "Lade Verlauf…" : "Loading history…"} />
          )}
          {history.error && <Alert kind="error">{history.error.message}</Alert>}
          <div className="chat-history-list">
            {history.data?.items.map((item) => (
              <button
                key={item.id}
                className={item.id === conversationId ? "chat-selected" : ""}
                onClick={() => {
                  setConversationId(item.id);
                  setActiveRunId("");
                  setStream(null);
                }}
              >
                {item.title}
              </button>
            ))}
          </div>
        </aside>
        <section className="chat-main" aria-label="Orbit Chat">
          <div className="chat-messages" aria-live="polite">
            {!conversationId && (
              <Empty
                icon={MessageCircle}
                title={de ? "Wie kann Orbit helfen?" : "How can Orbit help?"}
                description={
                  de
                    ? "Frage nach dem Projektstand oder plane einen prüfbaren Entwurf."
                    : "Ask about project status or plan a reviewable draft."
                }
              />
            )}
            {detail.loading && conversationId && <Loading />}
            {detail.error && <Alert kind="error">{detail.error.message}</Alert>}
            {detail.data?.messages.map((message) => (
              <article
                key={message.id}
                className={`chat-message chat-${message.role}`}
              >
                <div className="chat-message-text">{message.text}</div>
                {message.cards?.length > 0 && (
                  <div className="chat-cards">
                    {message.cards.map((card, index) => (
                      <div className="chat-card" key={`${card.kind}-${index}`}>
                        <Badge
                          tone={
                            card.status === "stale"
                              ? "warning"
                              : card.kind === "asset"
                                ? "blue"
                                : "neutral"
                          }
                        >
                          {card.status === "stale"
                            ? de
                              ? "Veraltet"
                              : "Stale"
                            : card.kind}
                        </Badge>
                        {card.href ? (
                          <Link href={card.href}>
                            <ExternalLink aria-hidden="true" />
                            {card.label}
                          </Link>
                        ) : (
                          <span>{card.label}</span>
                        )}
                        {card.kind === "asset" &&
                          card.status === "approved" &&
                          card.href && (
                            <Image
                              unoptimized
                              src={card.href}
                              width={160}
                              height={100}
                              alt={card.label}
                            />
                          )}
                      </div>
                    ))}
                  </div>
                )}
              </article>
            ))}
            {stream && !terminal.has(stream.status) && (
              <article className="chat-message chat-assistant">
                <Badge tone="blue">{statusLabel(stream.status, de)}</Badge>
                <div className="chat-message-text">
                  {stream.partialText ||
                    (de ? "Orbit arbeitet…" : "Orbit is working…")}
                </div>
              </article>
            )}
            {stream &&
              terminal.has(stream.status) &&
              stream.status !== "succeeded" && (
                <Alert kind="warning">
                  {statusLabel(stream.status, de)}: {stream.errorCode ?? "—"}
                </Alert>
              )}
            {proposals.map((proposal) => (
              <section key={proposal.id} className="chat-proposal">
                <div className="chat-proposal-head">
                  <strong>{proposal.payload.mission.title}</strong>
                  <div className="chat-proposal-badges">
                    {proposal.status === "proposed" && (
                      <Badge tone="blue">{statusLabel("proposed", de)}</Badge>
                    )}
                    <Badge
                      tone={
                        proposal.status === "confirmed" ? "success" : "warning"
                      }
                    >
                      {statusLabel(
                        proposal.status === "proposed"
                          ? "confirmation_required"
                          : (proposal.action?.status ?? proposal.status),
                        de,
                      )}
                    </Badge>
                  </div>
                </div>
                <p>{proposal.payload.mission.goal}</p>
                <dl>
                  <div>
                    <dt>{de ? "Zeitraum" : "Period"}</dt>
                    <dd>
                      {proposal.payload.mission.startAt} –{" "}
                      {proposal.payload.mission.endAt}
                    </dd>
                  </div>
                  <div>
                    <dt>{de ? "Kanäle / Umfang" : "Channels / scope"}</dt>
                    <dd>
                      {proposal.payload.mission.channels.join(", ")} ·{" "}
                      {proposal.payload.mission.maxContents}
                    </dd>
                  </div>
                  <div>
                    <dt>{de ? "Quellen / Assets" : "Sources / assets"}</dt>
                    <dd>
                      {proposal.payload.sources.length} /{" "}
                      {proposal.payload.assets.length}
                    </dd>
                  </div>
                  <div>
                    <dt>{de ? "Kostenobergrenze" : "Cost ceiling"}</dt>
                    <dd>
                      {usd(proposal.payload.firstDraftMaxMicros)}{" "}
                      {de ? "erster Entwurf" : "first draft"};{" "}
                      {usd(proposal.payload.planMaxMicros)}{" "}
                      {de ? "Plan" : "plan"}
                    </dd>
                  </div>
                </dl>
                {proposal.status === "proposed" && canEdit && (
                  <Button onClick={() => confirm(proposal)} disabled={pending}>
                    {de ? "Vorschlag bestätigen" : "Confirm proposal"}
                  </Button>
                )}
                {proposal.action?.error && (
                  <Alert kind="warning">{proposal.action.error}</Alert>
                )}
                {proposal.missionId && (
                  <div className="chat-links">
                    <Link href="/missions">
                      {de ? "Mission ansehen" : "View mission"}
                    </Link>
                    <Link href="/content">
                      {de ? "Entwürfe ansehen" : "View drafts"}
                    </Link>
                    <Link href="/approvals">
                      {de ? "Freigaben" : "Approvals"}
                    </Link>
                  </div>
                )}
              </section>
            ))}
          </div>
          {error && <Alert kind="error">{error}</Alert>}
          <form
            className="chat-compose"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <label htmlFor="orbit-chat-input">
              {de ? "Nachricht an Orbit" : "Message Orbit"}
            </label>
            <Textarea
              id="orbit-chat-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              maxLength={4000}
              rows={3}
              disabled={pending || Boolean(activeRunId)}
              placeholder={
                de
                  ? "Zum Beispiel: Was blockiert die nächsten Beiträge?"
                  : "For example: What blocks the next posts?"
              }
            />
            <div className="chat-compose-actions">
              {activeRunId && (
                <Button type="button" variant="outline" onClick={cancel}>
                  <Square aria-hidden="true" />
                  {de ? "Abbrechen" : "Cancel"}
                </Button>
              )}
              <Button
                type="submit"
                disabled={!input.trim() || pending || Boolean(activeRunId)}
              >
                <Send aria-hidden="true" />
                {de ? "Senden" : "Send"}
              </Button>
            </div>
          </form>
        </section>
      </div>
    </>
  );
}

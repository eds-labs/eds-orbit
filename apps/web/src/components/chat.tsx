"use client";
import { AssistantTasks } from "@/platform/assistant/tasks";
import { AppLink } from "@/platform/ui/app-link";
import { takeAssistantDraft } from "@/platform/shell/assistant-draft";
import { useCallback, useContext, useEffect, useState } from "react";
import Image from "next/image";
import {
  Archive,
  ArchiveRestore,
  MessageCircle,
  Plus,
  Send,
  Square,
  ExternalLink,
} from "lucide-react";
import {
  action,
  api,
  ApiError,
  collectionPath,
  post,
  useResource,
  usd,
} from "@/lib/api";
import { chatErrorText } from "./chat-errors";
import { runToFollow } from "./chat-resume";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Loading,
  Textarea,
} from "./ui/primitives";
import { PageHead } from "@/platform/ui/collection";
import { ChatMarkdown } from "./chat-markdown";
import { ShellContext } from "@/platform/shell/shell-context";
import type { ChatHost } from "@/platform/assistant/extensions";
import { useWorkspace } from "./workspace-context";

type Conversation = { id: string; title: string; updatedAt: string };
type Card = {
  kind: "source" | "asset" | "link" | "status" | "assignment";
  label: string;
  href?: string;
  status?: string;
  resourceId?: string;
  version?: number;
  // Module cards carry their content by value, e.g. assignments (R16).
  assignment?: Record<string, any>;
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
// Modules add fields such as packages and assignments (WP2.2).
type Detail = {
  conversation: Conversation;
  messages: Message[];
  runs: Run[];
  proposals: Proposal[];
} & Record<string, any>;
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
  const { project, identity, locale, canEdit, isOwner } = useWorkspace();
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
  const [showArchived, setShowArchived] = useState(false);
  const archivedQuery = showArchived ? "&archived=true" : "";
  const history = useResource<{
    items: Conversation[];
    nextCursor: string | null;
  }>(`${base}/conversations?revision=${historyRevision}${archivedQuery}`);
  const [older, setOlder] = useState<{
    items: Conversation[];
    next: string | null;
  }>({ items: [], next: null });
  useEffect(() => {
    setOlder({ items: [], next: history.data?.nextCursor ?? null });
  }, [history.data]);
  // A message typed on the project home opens here for review; never sent
  // automatically.
  useEffect(() => {
    const draft = takeAssistantDraft(project.id);
    if (draft) setInput(draft);
  }, [project.id]);
  async function loadOlder() {
    if (!older.next) return;
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
      setError(cause instanceof Error ? cause.message : "Request failed");
    }
  }
  async function setArchived(id: string, archived: boolean) {
    try {
      await post(`${base}/conversations/${id}/archive`, { archived });
      if (id === conversationId) setConversationId("");
      setHistoryRevision((n) => n + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    }
  }
  const detail = useResource<Detail>(
    conversationId
      ? `${base}/conversations/${conversationId}?revision=${detailRevision}`
      : null,
  );
  useEffect(() => {
    const linked = new URL(window.location.href).searchParams.get(
      "conversation",
    );
    setConversationId(
      linked && /^[a-f0-9-]{36}$/i.test(linked)
        ? linked
        : localStorage.getItem(savedKey) || "",
    );
  }, [savedKey]);
  useEffect(() => {
    if (conversationId) localStorage.setItem(savedKey, conversationId);
    else localStorage.removeItem(savedKey);
  }, [conversationId, savedKey]);
  useEffect(() => {
    const current = runToFollow(detail.data, conversationId, activeRunId);
    if (current) {
      setActiveRunId(current.id);
      setStream(current);
    }
  }, [detail.data, conversationId, activeRunId]);
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
      setError(
        cause instanceof ApiError
          ? chatErrorText(cause.code, de)
          : cause instanceof Error
            ? cause.message
            : "Request failed",
      );
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
  // Module chat parts (WP2.3): message cards, sections below the messages.
  const shell = useContext(ShellContext);
  const extensions = shell?.chat ?? [];
  const templates = extensions.flatMap(
    (extension) =>
      extension.templates?.({
        projectName: project.name,
        de,
        canEdit: extension.access
          ? ["owner", "editor"].includes(extension.access)
          : canEdit,
        features: shell?.features ?? {},
      }) ?? [],
  );
  const moduleCards: Record<
    string,
    NonNullable<(typeof extensions)[number]["messageCards"]>[string]
  > = Object.assign(
    {},
    ...extensions.map((extension) => extension.messageCards ?? {}),
  );
  const host: ChatHost = {
    conversation: detail.data,
    pending,
    de,
    async run(task, failure) {
      setPending(true);
      setError("");
      try {
        const message = await task();
        if (message) setError(message);
        refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : failure);
      } finally {
        setPending(false);
      }
    },
  };
  useEffect(() => {
    if (
      !extensions.some((extension) =>
        Boolean(detail.data && extension.busy?.(detail.data)),
      ) &&
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
      {extensions.map((extension, index) =>
        extension.navigation ? <extension.navigation key={index} /> : null,
      )}
      <AssistantTasks
        open={(id) => {
          setConversationId(id);
          setActiveRunId("");
          setStream(null);
        }}
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
          <label className="chat-history-toggle">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            <span>{de ? "Archivierte anzeigen" : "Show archived"}</span>
          </label>
          <div className="chat-history-list">
            {[...(history.data?.items ?? []), ...older.items].map((item) => (
              <div key={item.id} className="chat-history-item">
                <button
                  className={item.id === conversationId ? "chat-selected" : ""}
                  onClick={() => {
                    setConversationId(item.id);
                    setActiveRunId("");
                    setStream(null);
                  }}
                >
                  {item.title}
                </button>
                <button
                  className="chat-history-archive"
                  aria-label={
                    showArchived
                      ? de
                        ? `Wiederherstellen: ${item.title}`
                        : `Restore: ${item.title}`
                      : de
                        ? `Archivieren: ${item.title}`
                        : `Archive: ${item.title}`
                  }
                  title={
                    showArchived
                      ? de
                        ? "Wiederherstellen"
                        : "Restore"
                      : de
                        ? "Archivieren"
                        : "Archive"
                  }
                  onClick={() => void setArchived(item.id, !showArchived)}
                >
                  {showArchived ? (
                    <ArchiveRestore aria-hidden="true" />
                  ) : (
                    <Archive aria-hidden="true" />
                  )}
                </button>
              </div>
            ))}
            {older.next && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void loadOlder()}
              >
                {de ? "Ältere laden" : "Load older"}
              </Button>
            )}
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
                <div className="chat-message-text">
                  {message.role === "assistant" ? (
                    <ChatMarkdown text={message.text} />
                  ) : (
                    message.text
                  )}
                </div>
                {message.cards
                  ?.filter((card) => moduleCards[card.kind])
                  .map((card, index) => {
                    const Render = moduleCards[card.kind]!;
                    return (
                      <Render
                        key={`${message.id}-${card.kind}-${index}`}
                        card={card}
                        host={host}
                      />
                    );
                  })}
                {message.cards?.some((card) => !moduleCards[card.kind]) && (
                  <div className="chat-cards">
                    {message.cards
                      .filter((card) => !moduleCards[card.kind])
                      .map((card, index) => (
                        <div
                          className="chat-card"
                          key={`${card.kind}-${index}`}
                        >
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
                            <AppLink href={card.href}>
                              <ExternalLink aria-hidden="true" />
                              {card.label}
                            </AppLink>
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
                  <ChatMarkdown
                    text={
                      stream.partialText ||
                      (de ? "Orbit arbeitet…" : "Orbit is working…")
                    }
                  />
                </div>
              </article>
            )}
            {stream &&
              terminal.has(stream.status) &&
              stream.status !== "succeeded" && (
                <Alert kind="warning">
                  {statusLabel(stream.status, de)}:{" "}
                  {chatErrorText(stream.errorCode, de)}
                </Alert>
              )}
            {extensions.map((extension, index) =>
              extension.afterMessages ? (
                <extension.afterMessages key={index} host={host} />
              ) : null,
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
                    <AppLink href="/missions">
                      {de ? "Mission ansehen" : "View mission"}
                    </AppLink>
                    <AppLink href="/content">
                      {de ? "Entwürfe ansehen" : "View drafts"}
                    </AppLink>
                    <AppLink href="/approvals">
                      {de ? "Freigaben" : "Approvals"}
                    </AppLink>
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
            <div
              className="chat-templates"
              aria-label={de ? "Vorlagen" : "Templates"}
            >
              {templates.map((template) => (
                <Button
                  key={template.label}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending || Boolean(activeRunId)}
                  onClick={() => setInput(template.prompt)}
                >
                  {template.label}
                </Button>
              ))}
            </div>
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

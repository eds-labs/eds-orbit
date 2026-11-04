"use client";
import type { ComponentType } from "react";
import {
  Archive,
  ArchiveRestore,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  MessageCircle,
  Plus,
  Send,
  Square,
} from "lucide-react";
import { post, usd } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Loading,
  Textarea,
} from "@/components/ui/primitives";
import { ChatMarkdown } from "@/components/chat-markdown";
import { chatErrorText } from "@/components/chat-errors";
import { AppLink } from "@/platform/ui/app-link";
import type { ChatHost } from "./extensions";
import type { ChatCard, ChatMessage, Proposal, RunStep } from "./api";
import { ContextProposalCard, NoticeBody } from "./context-cards";
import { ChatCardView } from "./project-cards";
import {
  TERMINAL_RUN,
  type AssistantConversation,
} from "./use-assistant-conversation";

// Messages, cards, proposals and the composer of one conversation (WP3.8),
// extracted from the project chat page. The project page and the personal
// assistant's panel and page render the same view over the shared hook.

export function statusLabel(status: string, de: boolean) {
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

/** "support_ticket_list" as "Support ticket list". */
export function toolLabel(tool: string) {
  const words = tool.replace(/[._-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : tool;
}

/** Progress lines of a running personal turn, from the run's `steps[]`. */
export function StepLines({ steps, de }: { steps: RunStep[]; de: boolean }) {
  if (!steps.length) return null;
  return (
    <ul
      className="assistant-steps"
      aria-label={de ? "Fortschritt" : "Progress"}
    >
      {steps.map((step, index) => {
        const Icon =
          step.state === "started"
            ? LoaderCircle
            : step.state === "failed"
              ? CircleAlert
              : CircleCheck;
        const state =
          step.state === "started"
            ? de
              ? "läuft"
              : "running"
            : step.state === "failed"
              ? de
                ? "fehlgeschlagen"
                : "failed"
              : de
                ? "fertig"
                : "done";
        return (
          <li key={`${step.tool}-${index}`} data-state={step.state}>
            <Icon aria-hidden="true" />
            <span>
              {toolLabel(step.tool)}
              {step.projectName ? ` · ${step.projectName}` : ""}
            </span>
            <small>{state}</small>
          </li>
        );
      })}
    </ul>
  );
}

type ModuleCard = ComponentType<{ card: any; host: ChatHost }>;

/** One message: text, then module cards, then the generic cards. */
export function MessageView({
  message,
  de,
  moduleCards = {},
  host,
  onChanged,
}: {
  message: ChatMessage;
  de: boolean;
  moduleCards?: Readonly<Record<string, ModuleCard>>;
  host?: ChatHost;
  onChanged?: () => void;
}) {
  const cards = message.cards ?? [];
  const isModule = (card: ChatCard) => Boolean(host && moduleCards[card.kind]);
  const generic = cards.filter((card) => !isModule(card));
  return (
    <article className={`chat-message chat-${message.role}`}>
      {message.role === "notice" && message.notice ? (
        <NoticeBody notice={message.notice} text={message.text} de={de} />
      ) : (
        <div className="chat-message-text">
          {message.role === "assistant" ? (
            <ChatMarkdown text={message.text} />
          ) : (
            message.text
          )}
        </div>
      )}
      {cards.filter(isModule).map((card, index) => {
        const Render = moduleCards[card.kind]!;
        return (
          <Render
            key={`${message.id}-${card.kind}-${index}`}
            card={card}
            host={host!}
          />
        );
      })}
      {generic.length > 0 && (
        <div className="chat-cards">
          {generic.map((card, index) =>
            card.kind === "context_proposal" ? (
              <ContextProposalCard
                key={`${card.kind}-${index}`}
                card={card}
                de={de}
              />
            ) : (
              <ChatCardView
                key={`${card.kind}-${index}`}
                card={card}
                de={de}
                onDecided={onChanged}
              />
            ),
          )}
        </div>
      )}
    </article>
  );
}

export function ConversationHistory({
  conversation,
  de,
  onOpened,
  onNew,
}: {
  conversation: AssistantConversation;
  de: boolean;
  /** After a conversation was picked or a new one started (panel: back). */
  onOpened?: () => void;
  /** After "New chat" (the project page clears its input). */
  onNew?: () => void;
}) {
  const { history } = conversation;
  return (
    <aside
      className="chat-history"
      aria-label={de ? "Unterhaltungen" : "Conversations"}
    >
      <Button
        size="sm"
        onClick={() => {
          conversation.startNew();
          onNew?.();
          onOpened?.();
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
          checked={history.showArchived}
          onChange={(event) => history.setShowArchived(event.target.checked)}
        />
        <span>{de ? "Archivierte anzeigen" : "Show archived"}</span>
      </label>
      <div className="chat-history-list">
        {history.items.map((item) => (
          <div key={item.id} className="chat-history-item">
            <button
              className={
                item.id === conversation.conversationId ? "chat-selected" : ""
              }
              aria-current={
                item.id === conversation.conversationId ? "true" : undefined
              }
              onClick={() => {
                conversation.open(item.id);
                onOpened?.();
              }}
            >
              {item.title}
            </button>
            <button
              className="chat-history-archive"
              aria-label={
                history.showArchived
                  ? de
                    ? `Wiederherstellen: ${item.title}`
                    : `Restore: ${item.title}`
                  : de
                    ? `Archivieren: ${item.title}`
                    : `Archive: ${item.title}`
              }
              title={
                history.showArchived
                  ? de
                    ? "Wiederherstellen"
                    : "Restore"
                  : de
                    ? "Archivieren"
                    : "Archive"
              }
              onClick={() =>
                void conversation.archive(item.id, !history.showArchived)
              }
            >
              {history.showArchived ? (
                <ArchiveRestore aria-hidden="true" />
              ) : (
                <Archive aria-hidden="true" />
              )}
            </button>
          </div>
        ))}
        {history.hasOlder && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void history.loadOlder()}
          >
            {de ? "Ältere laden" : "Load older"}
          </Button>
        )}
      </div>
    </aside>
  );
}

export type ConversationViewProps = {
  conversation: AssistantConversation;
  de: boolean;
  /** Personal mode: personal error texts and progress lines. */
  personal?: boolean;
  canEdit: boolean;
  input: string;
  setInput: (value: string) => void;
  inputId: string;
  inputLabel: string;
  placeholder: string;
  label: string;
  emptyTitle: string;
  emptyDescription: string;
  templates?: Array<{ label: string; prompt: string }>;
  moduleCards?: Readonly<Record<string, ModuleCard>>;
  afterMessages?: ReadonlyArray<ComponentType<{ host: ChatHost }>>;
  host?: ChatHost;
  className?: string;
};

export function ConversationView(props: ConversationViewProps) {
  const {
    conversation,
    de,
    personal = false,
    canEdit,
    input,
    setInput,
    templates = [],
    moduleCards = {},
    afterMessages = [],
    host,
  } = props;
  const { detail, stream, activeRunId, pending, busy } = conversation;
  const proposals: Proposal[] =
    detail.data?.proposals?.filter(
      (proposal) =>
        !detail.data?.proposals.some(
          (later) =>
            later.groupId === proposal.groupId &&
            later.version > proposal.version,
        ),
    ) ?? [];
  async function confirm(proposal: Proposal) {
    if (!canEdit) return;
    await conversation.run(
      async () => {
        await post(`${conversation.base}/proposals/${proposal.id}/confirm`, {
          version: proposal.version,
          hash: proposal.payloadHash,
          confirmationId: crypto.randomUUID(),
        });
      },
      de ? "Bestätigung fehlgeschlagen" : "Confirmation failed",
    );
  }
  async function submit() {
    if (await conversation.send(input)) setInput("");
  }
  return (
    <section
      className={props.className ? `chat-main ${props.className}` : "chat-main"}
      aria-label={props.label}
    >
      <div className="chat-messages" aria-live="polite">
        {!conversation.conversationId && (
          <Empty
            icon={MessageCircle}
            title={props.emptyTitle}
            description={props.emptyDescription}
          />
        )}
        {detail.loading && conversation.conversationId && <Loading />}
        {detail.error && <Alert kind="error">{detail.error.message}</Alert>}
        {detail.data?.messages.map((message) => (
          <MessageView
            key={message.id}
            message={message}
            de={de}
            moduleCards={moduleCards}
            host={host}
            onChanged={conversation.refresh}
          />
        ))}
        {stream && !TERMINAL_RUN.has(stream.status) && (
          <article className="chat-message chat-assistant">
            <Badge tone="blue">{statusLabel(stream.status, de)}</Badge>
            {stream.steps?.length ? (
              <StepLines steps={stream.steps} de={de} />
            ) : null}
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
          TERMINAL_RUN.has(stream.status) &&
          stream.status !== "succeeded" && (
            <Alert kind="warning">
              {statusLabel(stream.status, de)}:{" "}
              {chatErrorText(stream.errorCode, de, personal)}
            </Alert>
          )}
        {host &&
          afterMessages.map((After, index) => (
            <After key={index} host={host} />
          ))}
        {proposals.map((proposal) => (
          <section key={proposal.id} className="chat-proposal">
            <div className="chat-proposal-head">
              <strong>{proposal.payload.mission.title}</strong>
              <div className="chat-proposal-badges">
                {proposal.status === "proposed" && (
                  <Badge tone="blue">{statusLabel("proposed", de)}</Badge>
                )}
                <Badge
                  tone={proposal.status === "confirmed" ? "success" : "warning"}
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
                  {usd(proposal.payload.planMaxMicros)} {de ? "Plan" : "plan"}
                </dd>
              </div>
            </dl>
            {proposal.status === "proposed" && canEdit && (
              <Button onClick={() => void confirm(proposal)} disabled={pending}>
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
      {conversation.error && <Alert kind="error">{conversation.error}</Alert>}
      <form
        className="chat-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {templates.length > 0 && (
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
                disabled={busy}
                onClick={() => setInput(template.prompt)}
              >
                {template.label}
              </Button>
            ))}
          </div>
        )}
        <label htmlFor={props.inputId}>{props.inputLabel}</label>
        <Textarea
          id={props.inputId}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          maxLength={4000}
          rows={3}
          disabled={busy}
          placeholder={props.placeholder}
        />
        <div className="chat-compose-actions">
          {activeRunId && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void conversation.cancel()}
            >
              <Square aria-hidden="true" />
              {de ? "Abbrechen" : "Cancel"}
            </Button>
          )}
          <Button type="submit" disabled={!input.trim() || busy}>
            <Send aria-hidden="true" />
            {de ? "Senden" : "Send"}
          </Button>
        </div>
      </form>
    </section>
  );
}

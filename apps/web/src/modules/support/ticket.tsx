"use client";
import { useState, type FormEvent } from "react";
import { ArrowLeft, Lock, Paperclip } from "lucide-react";
import { usd, useResource, useMutation, when } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Loading,
  Tabs,
  Textarea,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { cn } from "@/lib/utils";
import {
  PRIORITIES,
  STATUSES,
  patch,
  post,
  slaState,
  supportPath,
  timelineEntries,
  uploadSupportFile,
  type Agent,
  type TicketDetail,
  type TimelineEntry,
} from "./api";
import { supportText, type SupportText } from "./labels";
import { TagPicker, useSupportLists } from "./tags";
import { CustomerAccountCard } from "./customer-context";
import { useShell } from "@/platform/shell/shell-context";

export const SLA_TONE = {
  ok: "success",
  at_risk: "warning",
  breached: "danger",
  paused: "neutral",
  done: "neutral",
} as const;

/** One ticket: header controls, the timeline, the composer and the contact. */
export function TicketView({
  ticketId,
  onBack,
  onChanged,
}: {
  ticketId: string;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { project, locale, canEdit } = useWorkspace();
  const shell = useShell();
  const t = supportText(locale);
  const detail = useResource<TicketDetail>(
    supportPath(project.id, `/tickets/${ticketId}`),
  );
  const agents = useResource<{ items: Agent[] }>(
    supportPath(project.id, "/agents"),
  );
  const refresh = () => {
    detail.refresh();
    onChanged();
  };
  // An AI draft taken over into the composer; n remounts it with the text.
  const [prefill, setPrefill] = useState({ text: "", n: 0 });
  const draftRequest = useMutation();
  if (detail.loading) return <Loading />;
  if (detail.error || !detail.data)
    return <Alert kind="error">{detail.error?.message ?? "—"}</Alert>;
  const { ticket, contact } = detail.data;
  const sla = slaState(ticket);
  return (
    <article className="support-ticket" aria-labelledby="support-ticket-title">
      <header className="support-ticket-head">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="support-back"
        >
          <ArrowLeft aria-hidden /> {t.back}
        </Button>
        <h2 id="support-ticket-title">
          #{ticket.number} {ticket.subject}
        </h2>
        <div className="support-badges">
          <Badge>
            {t.status[ticket.status as keyof SupportText["status"]]}
          </Badge>
          <Badge>
            {t.priority[ticket.priority as keyof SupportText["priority"]]}
          </Badge>
          <Badge tone={SLA_TONE[sla]}>{t.sla[sla]}</Badge>
          {(detail.data.aiCostMicros ?? 0) > 0 && (
            <Badge>
              {t.aiCost}: {usd(detail.data.aiCostMicros)}
            </Badge>
          )}
          {canEdit && detail.data.inbox?.aiMode === "draft" && (
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={draftRequest.pending}
              onClick={() =>
                draftRequest.run(() =>
                  post(
                    supportPath(project.id, `/tickets/${ticketId}/ai-draft`),
                    {},
                  ),
                )
              }
            >
              {t.generateDraft}
            </Button>
          )}
        </div>
        {draftRequest.success && <Alert kind="info">{t.draftQueued}</Alert>}
        {draftRequest.error && <Alert kind="error">{draftRequest.error}</Alert>}
        {canEdit && (
          <TicketControls
            detail={detail.data}
            agents={agents.data?.items ?? []}
            t={t}
            onSaved={refresh}
          />
        )}
      </header>
      <div className="support-ticket-body">
        <ol className="support-timeline" aria-label={t.tickets}>
          {timelineEntries(detail.data.timeline).map((entry) => (
            <TimelineItem
              key={`${entry.entry}-${entry.id}`}
              entry={entry}
              t={t}
              locale={locale}
              timezone={project.timezone}
              projectId={project.id}
              {...(canEdit
                ? {
                    onUseDraft: (text: string) =>
                      setPrefill((p) => ({ text, n: p.n + 1 })),
                  }
                : {})}
            />
          ))}
        </ol>
        {contact && (
          <aside className="support-contact-panel" aria-label={t.contact}>
            <h3>{t.contact}</h3>
            <dl>
              <dt>{t.name}</dt>
              <dd>{contact.name ?? "—"}</dd>
              <dt>{t.email}</dt>
              <dd>{contact.email ?? "—"}</dd>
              {contact.claimedEmail && (
                <>
                  <dt>{t.claimedEmail}</dt>
                  <dd>{contact.claimedEmail}</dd>
                </>
              )}
              {contact.notes && (
                <>
                  <dt>{t.notes}</dt>
                  <dd>{contact.notes}</dd>
                </>
              )}
            </dl>
            {canEdit &&
              shell.features?.customerContext &&
              detail.data.inbox?.customerContext && (
                <CustomerAccountCard ticketId={ticketId} t={t} />
              )}
          </aside>
        )}
      </div>
      {canEdit && (
        <Composer
          key={prefill.n}
          ticketId={ticketId}
          t={t}
          onSent={refresh}
          initialText={prefill.text}
        />
      )}
    </article>
  );
}

export function TimelineItem({
  entry,
  t,
  locale,
  timezone,
  projectId,
  onUseDraft,
}: {
  entry: TimelineEntry;
  t: SupportText;
  locale: string;
  timezone: string;
  projectId: string;
  /** Fills the composer with an AI draft (agents only). */
  onUseDraft?: (text: string) => void;
}) {
  if (entry.entry === "event")
    return (
      <li className="support-event">
        <span>{t.event[entry.type] ?? entry.type}</span>{" "}
        <time>{when(entry.createdAt, locale, timezone)}</time>
      </li>
    );
  return (
    <li
      className={cn(
        "support-message",
        `support-message-${entry.kind}`,
        entry.internal && "support-message-internal",
      )}
    >
      <div className="support-message-meta">
        {entry.internal && <Lock aria-hidden size={14} />}
        <strong>{t.kind[entry.kind] ?? entry.kind}</strong>
        <time>{when(entry.createdAt, locale, timezone)}</time>
        {entry.deliveryState && (
          <Badge>
            {t.delivery[entry.deliveryState] ?? entry.deliveryState}
          </Badge>
        )}
      </div>
      <p className="support-message-text">{entry.bodyText}</p>
      {entry.kind === "ai_draft" && onUseDraft && (
        <Button
          size="sm"
          variant="outline"
          type="button"
          onClick={() => onUseDraft(entry.bodyText)}
        >
          {t.useDraft}
        </Button>
      )}
      {entry.attachments.length > 0 && (
        <ul className="support-attachments">
          {entry.attachments.map((a) => (
            <li key={a.id}>
              <a
                href={`/api/projects/${encodeURIComponent(projectId)}/files/${a.fileId}`}
              >
                <Paperclip aria-hidden size={14} /> {a.name}
              </a>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function TicketControls({
  detail,
  agents,
  t,
  onSaved,
}: {
  detail: TicketDetail;
  agents: Agent[];
  t: SupportText;
  onSaved: () => void;
}) {
  const { project } = useWorkspace();
  const { ticket } = detail;
  const mutation = useMutation(onSaved);
  const update = (data: Record<string, unknown>) =>
    mutation.run(() =>
      patch(supportPath(project.id, `/tickets/${ticket.id}`), data),
    );
  const lists = useSupportLists();
  return (
    <div className="support-controls">
      <label>
        <span>{t.statusLabel}</span>
        <select
          value={ticket.status}
          onChange={(e) => update({ status: e.target.value })}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t.status[s]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t.priorityLabel}</span>
        <select
          value={ticket.priority}
          onChange={(e) => update({ priority: e.target.value })}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {t.priority[p]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t.assignee}</span>
        <select
          value={ticket.assigneeUserId ?? ""}
          onChange={(e) => update({ assigneeUserId: e.target.value || null })}
        >
          <option value="">{t.unassigned}</option>
          {agents.map((a) => (
            <option key={a.userId} value={a.userId}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t.category}</span>
        <select
          value={ticket.category ?? ""}
          onChange={(e) => update({ category: e.target.value || null })}
        >
          <option value="">{t.noCategory}</option>
          {lists.categories.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
          {ticket.category &&
            !lists.categories.some((c) => c.key === ticket.category) && (
              <option value={ticket.category}>{ticket.category}</option>
            )}
        </select>
      </label>
      <div className="support-tags">
        <span>{t.tags}</span>
        <TagPicker
          defs={lists.tags}
          value={ticket.tags}
          t={t}
          disabled={mutation.pending}
          onChange={(tags) => update({ tags })}
        />
      </div>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
    </div>
  );
}

/** The reply or internal-note composer with attachments. */
export function Composer({
  ticketId,
  t,
  onSent,
  initialText = "",
}: {
  ticketId: string;
  t: SupportText;
  onSent: () => void;
  initialText?: string;
}) {
  const { project } = useWorkspace();
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [text, setText] = useState(initialText);
  const [files, setFiles] = useState<File[]>([]);
  const mutation = useMutation(() => {
    setText("");
    setFiles([]);
    onSent();
  });
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    await mutation.run(async () => {
      if (mode === "note")
        return post(supportPath(project.id, `/tickets/${ticketId}/notes`), {
          bodyText: text,
        });
      const fileIds = [];
      for (const file of files)
        fileIds.push((await uploadSupportFile(project.id, file)).id);
      return post(supportPath(project.id, `/tickets/${ticketId}/replies`), {
        bodyText: text,
        fileIds,
      });
    });
  }
  return (
    <form className="support-composer" onSubmit={submit}>
      <Tabs
        tabs={[
          { key: "reply", label: t.reply },
          { key: "note", label: t.note },
        ]}
        value={mode}
        onChange={(v) => setMode(v as "reply" | "note")}
      />
      <p className="support-composer-hint">
        {mode === "note" ? t.noteHint : t.replyHint}
      </p>
      <Textarea
        aria-label={mode === "note" ? t.note : t.reply}
        value={text}
        rows={5}
        onChange={(e) => setText(e.target.value)}
        className={cn(mode === "note" && "support-note-input")}
      />
      <div className="support-composer-actions">
        {mode === "reply" && (
          <label className="support-attach">
            <Paperclip aria-hidden size={16} />
            <span>{t.attach}</span>
            <input
              type="file"
              multiple
              onChange={(e) => setFiles([...(e.target.files ?? [])])}
            />
          </label>
        )}
        <Button type="submit" disabled={mutation.pending || !text.trim()}>
          {mode === "note" ? t.addNote : t.send}
        </Button>
      </div>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
    </form>
  );
}

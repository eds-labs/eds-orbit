"use client";
import { manageHref } from "@/platform/settings-center/routes";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import {
  Archive,
  ArchiveRestore,
  Download,
  Pencil,
  Trash2,
} from "lucide-react";
import { useResource, type Project } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Loading,
  Textarea,
} from "@/components/ui/primitives";
import { chatErrorOf } from "@/components/chat-errors";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { NotFound } from "@/platform/shell/not-found";
import { useStandalone } from "@/platform/shell/standalone-context";
import { useAssistantPanel } from "@/platform/assistant/assistant-context";
import { categoryLabel } from "@/platform/assistant/context-cards";
import { ProjectBadge } from "@/platform/assistant/project-cards";
import { ProactivePreferences } from "./proactive-preferences";
import { VoiceSettingsPanel } from "@/platform/assistant/voice";
import {
  assistantPaths,
  CONTEXT_CATEGORIES,
  CONTEXT_MAX_CHARS,
  contextApiFor,
  type ContextApi,
  type ContextCategory,
  type ContextEntry,
  type ContextList,
} from "@/platform/assistant/api";

// "Mein Kontext" / "My context" (/account/assistant, D-17, WP3.7): the
// user's personal context entries, which only they can see, with editing,
// archiving, deleting and a JSON export; the switch for automatic memory
// (off: the assistant only proposes, a click saves); and whether the
// assistant button shows on every page.

export const contextText = (de: boolean) => ({
  title: de ? "Mein Kontext" : "My context",
  intro: de
    ? "Was sich der Orbit Assistant über deine Arbeitsweise merkt. Nur du siehst diese Einträge: Organisationsinhaber und Administratoren sehen sie nicht, und sie gehen nie an konfigurierte Agenten, Aufträge oder MCP-Clients."
    : "What the Orbit Assistant remembers about how you work. Only you can see these entries: organization owners and administrators cannot, and they never reach configured agents, work orders or MCP clients.",
  autoMemory: de ? "Automatisch merken" : "Remember automatically",
  autoMemoryOn: de
    ? "Der Assistent speichert, was du ihm sagst, und zeigt jedes Mal „Gemerkt: …“ mit Rückgängig."
    : "The assistant saves what you tell it and shows “Remembered: …” with Undo each time.",
  autoMemoryOff: de
    ? "Der Assistent schlägt Einträge nur vor; gespeichert wird erst nach deinem Klick."
    : "The assistant only proposes entries; nothing is saved until you click.",
  bubble: de ? "Assistent-Schaltfläche anzeigen" : "Show the assistant button",
  bubbleHint: de
    ? "Gilt für diesen Browser. Strg+K bzw. ⌘K öffnet den Assistenten immer."
    : "Applies to this browser. Ctrl+K or ⌘K always opens the assistant.",
  add: de ? "Eintrag hinzufügen" : "Add entry",
  text: de ? "Text" : "Text",
  category: de ? "Art" : "Kind",
  project: de ? "Projekt (optional)" : "Project (optional)",
  anyProject: de ? "Alle Projekte" : "All projects",
  save: de ? "Speichern" : "Save",
  cancel: de ? "Abbrechen" : "Cancel",
  edit: de ? "Bearbeiten" : "Edit",
  archive: de ? "Archivieren" : "Archive",
  restore: de ? "Wiederherstellen" : "Restore",
  remove: de ? "Löschen" : "Delete",
  confirmRemove: de
    ? "Diesen Eintrag endgültig löschen?"
    : "Delete this entry for good?",
  export: de ? "Als JSON exportieren" : "Export as JSON",
  empty: de ? "Noch keine Einträge" : "No entries yet",
  emptyHint: de
    ? "Sag dem Assistenten zum Beispiel, wie du Berichte haben möchtest, oder füge hier einen Eintrag hinzu."
    : "Tell the assistant, for example, how you like your reports, or add an entry here.",
  archived: de ? "Archiviert" : "Archived",
  byAssistant: de ? "vom Assistenten" : "by the assistant",
  open: de ? "Assistent öffnen" : "Open the assistant",
  chars: (n: number) => `${n}/${CONTEXT_MAX_CHARS}`,
});

type Actions = Pick<ContextApi, "create" | "update" | "remove" | "settings">;

export function PersonalContextView() {
  const { locale, t: shellText } = useStandalone();
  const de = locale === "de";
  const assistant = useAssistantPanel();
  const available = Boolean(assistant?.available);
  const list = useResource<ContextList>(
    available && assistant?.enabled
      ? assistantPaths.context(assistant.status?.workspaceId)
      : null,
  );
  if (!assistant) return <Loading label={de ? "Wird geladen…" : "Loading…"} />;
  if (!available) return <NotFound t={shellText} project={false} />;
  const t = contextText(de);
  return (
    <div className="account-page">
      <Link className="back-link" href={manageHref({ kind: "account" }, "profile")}>
        ← {de ? "Dein Konto" : "Your account"}
      </Link>
      <PageHead title={t.title} description={t.intro}>
        <Button variant="outline" onClick={() => assistant.openPanel()}>
          {t.open}
        </Button>
      </PageHead>
      {!assistant.enabled ? (
        <Alert kind="warning">
          {chatErrorOf(
            {
              code:
                assistant.status && !assistant.status.enabled
                  ? assistant.status.reason
                  : "ASSISTANT_DISABLED",
            },
            de,
            true,
          )}
        </Alert>
      ) : list.loading && !list.data ? (
        <Loading label={de ? "Wird geladen…" : "Loading…"} />
      ) : !list.data ? (
        <ResourceError error={list.error} retry={list.refresh} />
      ) : (
        <PersonalContextContent
          de={de}
          items={list.data.items}
          autoMemory={list.data.autoMemory}
          projects={assistant.projects}
          bubbleHidden={assistant.bubbleHidden}
          onBubbleHidden={assistant.setBubbleHidden}
          onChanged={list.refresh}
          workspaceId={assistant.status?.workspaceId}
        />
      )}
      {/* Notifications, quiet hours, digest, Telegram, briefing (ADR 0023). */}
      {assistant.enabled && (
        <ProactivePreferences
          de={de}
          workspaceId={assistant.status?.workspaceId}
          projects={assistant.projects}
        />
      )}
    </div>
  );
}

/** The page's content for loaded entries; the actions are injectable for tests. */
export function PersonalContextContent({
  de,
  items,
  autoMemory,
  projects,
  bubbleHidden,
  onBubbleHidden,
  onChanged,
  workspaceId,
  actions,
  initialEditing = null,
}: {
  de: boolean;
  items: ContextEntry[];
  autoMemory: boolean;
  projects: Project[];
  bubbleHidden: boolean;
  onBubbleHidden: (hidden: boolean) => void;
  onChanged: () => void;
  /** The organization of the resolved assistant status (/api/assistant). */
  workspaceId?: string;
  actions?: Actions;
  initialEditing?: string | null;
}) {
  const t = contextText(de);
  const api: Actions = actions ?? contextApiFor(workspaceId);
  const [memory, setMemory] = useState(autoMemory);
  const [editing, setEditing] = useState<string | null>(initialEditing);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function run(task: () => Promise<unknown>) {
    setPending(true);
    setError("");
    try {
      await task();
      onChanged();
      return true;
    } catch (cause) {
      setError(chatErrorOf(cause, de, true));
      return false;
    } finally {
      setPending(false);
    }
  }
  const active = items.filter((item) => item.status === "active");
  const archived = items.filter((item) => item.status === "archived");
  return (
    <div className="admin-stack">
      {error && <Alert kind="error">{error}</Alert>}
      <section className="panel">
        <div className="panel-body personal-context-settings">
          <label className="switch-row">
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={memory}
              disabled={pending}
              onChange={(event) => {
                const next = event.target.checked;
                void run(async () => {
                  await api.settings(next);
                  setMemory(next);
                });
              }}
            />
            <span>
              <strong>{t.autoMemory}</strong>
              <small>{memory ? t.autoMemoryOn : t.autoMemoryOff}</small>
            </span>
          </label>
          <label className="switch-row">
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={!bubbleHidden}
              onChange={(event) => onBubbleHidden(!event.target.checked)}
            />
            <span>
              <strong>{t.bubble}</strong>
              <small>{t.bubbleHint}</small>
            </span>
          </label>
        </div>
      </section>
      <VoiceSettingsPanel workspaceId={workspaceId} de={de} />
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{t.add}</h2>
          </div>
        </div>
        <div className="panel-body">
          <EntryForm
            de={de}
            projects={projects}
            pending={pending}
            submitLabel={t.save}
            onSubmit={(value) => run(() => api.create(value))}
          />
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{t.title}</h2>
            <p>
              {active.length} · {t.archived} {archived.length}
            </p>
          </div>
          <a
            className="button button-outline button-sm"
            href={assistantPaths.contextExport(workspaceId)}
            download="orbit-personal-context.json"
          >
            <Download aria-hidden="true" />
            {t.export}
          </a>
        </div>
        {items.length === 0 ? (
          <Empty title={t.empty} description={t.emptyHint} />
        ) : (
          <ul className="personal-context-list">
            {[...active, ...archived].map((item) => (
              <li key={item.id} data-status={item.status}>
                {editing === item.id ? (
                  <EntryForm
                    de={de}
                    projects={projects}
                    pending={pending}
                    entry={item}
                    submitLabel={t.save}
                    onCancel={() => setEditing(null)}
                    onSubmit={async (value) => {
                      const done = await run(() =>
                        api.update(item, {
                          text: value.text,
                          category: value.category,
                          projectId: value.projectId ?? null,
                        }),
                      );
                      if (done) setEditing(null);
                      return done;
                    }}
                  />
                ) : (
                  <>
                    <div className="personal-context-entry">
                      <div className="chat-card-head">
                        <Badge tone="blue">
                          {categoryLabel(item.category, de)}
                        </Badge>
                        {item.projectId && (
                          <ProjectBadge projectId={item.projectId} />
                        )}
                        {item.status === "archived" && (
                          <Badge tone="neutral">{t.archived}</Badge>
                        )}
                        {item.createdBy !== "user" && (
                          <small>{t.byAssistant}</small>
                        )}
                      </div>
                      <p>{item.text}</p>
                    </div>
                    <div className="row-actions">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`${t.edit}: ${item.text.slice(0, 40)}`}
                        title={t.edit}
                        disabled={pending}
                        onClick={() => setEditing(item.id)}
                      >
                        <Pencil aria-hidden="true" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`${item.status === "active" ? t.archive : t.restore}: ${item.text.slice(0, 40)}`}
                        title={item.status === "active" ? t.archive : t.restore}
                        disabled={pending}
                        onClick={() =>
                          void run(() =>
                            api.update(item, {
                              status:
                                item.status === "active"
                                  ? "archived"
                                  : "active",
                            }),
                          )
                        }
                      >
                        {item.status === "active" ? (
                          <Archive aria-hidden="true" />
                        ) : (
                          <ArchiveRestore aria-hidden="true" />
                        )}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`${t.remove}: ${item.text.slice(0, 40)}`}
                        title={t.remove}
                        disabled={pending}
                        onClick={() => {
                          if (window.confirm(t.confirmRemove))
                            void run(() => api.remove(item.id));
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function EntryForm({
  de,
  projects,
  pending,
  entry,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  de: boolean;
  projects: Project[];
  pending: boolean;
  entry?: ContextEntry;
  submitLabel: string;
  onSubmit: (value: {
    category: ContextCategory;
    text: string;
    projectId?: string;
  }) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const t = contextText(de);
  const prefix = entry ? `context-${entry.id}` : "context-new";
  const [text, setText] = useState(entry?.text ?? "");
  const [category, setCategory] = useState<ContextCategory>(
    entry?.category ?? "preference",
  );
  const [projectId, setProjectId] = useState(entry?.projectId ?? "");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    const done = await onSubmit({
      category,
      text: text.trim(),
      ...(projectId ? { projectId } : {}),
    });
    if (done && !entry) setText("");
  }
  return (
    <form className="settings-form personal-context-form" onSubmit={submit}>
      <label htmlFor={`${prefix}-text`}>{t.text}</label>
      <Textarea
        id={`${prefix}-text`}
        value={text}
        rows={3}
        maxLength={CONTEXT_MAX_CHARS}
        required
        aria-describedby={`${prefix}-count`}
        onChange={(event) => setText(event.target.value)}
      />
      <small id={`${prefix}-count`}>{t.chars(text.length)}</small>
      <div className="personal-context-fields">
        <div>
          <label htmlFor={`${prefix}-category`}>{t.category}</label>
          <select
            id={`${prefix}-category`}
            className="input"
            value={category}
            onChange={(event) =>
              setCategory(event.target.value as ContextCategory)
            }
          >
            {CONTEXT_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {categoryLabel(value, de)}
              </option>
            ))}
          </select>
        </div>
        {projects.length > 0 && (
          <div>
            <label htmlFor={`${prefix}-project`}>{t.project}</label>
            <select
              id={`${prefix}-project`}
              className="input"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">{t.anyProject}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="form-actions">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            {t.cancel}
          </Button>
        )}
        <Button type="submit" disabled={pending || !text.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

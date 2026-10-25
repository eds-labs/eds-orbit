"use client";
import { useState, type FormEvent } from "react";
import { ArrowLeft, Eye, EyeOff, Paperclip, Trash2, X } from "lucide-react";
import { api, ApiError, useMutation, useResource, when } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Input,
  Loading,
  Modal,
  Textarea,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { ResourceError } from "@/platform/ui/collection";
import { AppLink } from "@/platform/ui/app-link";
import {
  PRIORITIES,
  send,
  workPath,
  type Initiative,
  type LinkView,
  type Milestone,
  type Task,
  type TaskDetail,
  type TaskPage,
  type TimelineEntry,
} from "./api";
import { workText, type WorkText } from "./labels";
import { memberName, PriorityBadge, StatusBadge, TaskRow, useWorkAccess, useWorkLists } from "./shared";
import { TaskAgents } from "./pm-task";

// One task with everything that hangs on it (plan §5.2): fields, subtasks,
// checklist, dependencies, links, attachments, comments and history. Every
// change sends the version the member saw; a conflict reloads the task.

const LINK_TYPES = [
  "work.task",
  "work.initiative",
  "support.ticket",
  "marketing.mission",
  "marketing.assignment",
  "knowledge.document",
] as const;

export function TaskDetailView({
  taskId,
  onBack,
  onChanged,
  onOpen,
}: {
  taskId: string;
  onBack: () => void;
  onChanged?: () => void;
  onOpen?: (id: string) => void;
}) {
  const { project, locale } = useWorkspace();
  const t = workText(locale);
  const access = useWorkAccess();
  const lists = useWorkLists();
  const detail = useResource<TaskDetail>(workPath(project.id, `/tasks/${taskId}`));
  const [notice, setNotice] = useState<string | null>(null);
  const changed = () => {
    detail.refresh();
    onChanged?.();
  };
  const mutation = useMutation(changed);
  /** Runs a change; a version conflict reloads the task with a notice. */
  const change = (task: () => Promise<unknown>) =>
    mutation.run(async () => {
      setNotice(null);
      try {
        return await task();
      } catch (error) {
        if (error instanceof ApiError && error.code === "WORK_VERSION_CONFLICT") {
          setNotice(t.conflict);
          changed();
          return undefined;
        }
        throw error;
      }
    });
  if (detail.loading) return <Loading />;
  if (detail.error) return <ResourceError error={detail.error} retry={detail.refresh} />;
  const d = detail.data!;
  const task = d.task;
  const path = (rest: string) => workPath(project.id, rest);
  const patchTask = (fields: Record<string, unknown>) =>
    change(() => send(path(`/tasks/${task.id}`), "PATCH", { expectedVersion: task.version, ...fields }));
  return (
    <article className="support-ticket work-task" aria-labelledby="work-task-title">
      <div className="support-ticket-head">
        <Button variant="ghost" size="sm" className="support-back" onClick={onBack}>
          <ArrowLeft aria-hidden /> {t.back}
        </Button>
        <TitleEditor task={task} t={t} disabled={!access.write || mutation.pending} onSave={(title) => patchTask({ title })} />
        <p className="support-muted">
          {d.initiative && (
            <>
              {d.initiative.key} · {d.initiative.title}
              {d.milestone && ` · ${d.milestone.title}`}
              {" · "}
            </>
          )}
          {d.parent && (
            <>
              ↳{" "}
              <button type="button" className="text-link" onClick={() => onOpen?.(d.parent!.id)}>
                #{d.parent.number} {d.parent.title}
              </button>
              {" · "}
            </>
          )}
          {when(task.createdAt, locale, project.timezone)}
        </p>
        <div className="support-badges">
          <StatusBadge status={task.status} category={task.statusCategory} statuses={lists.statuses} />
          <PriorityBadge priority={task.priority} />
          {task.archivedAt && <Badge>{t.showArchived}</Badge>}
        </div>
      </div>
      {notice && <Alert>{notice}</Alert>}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {!access.write && <p className="support-muted">{t.readOnly}</p>}
      <div className="support-controls">
        <label>
          {t.fields.status}
          <select
            value={task.status}
            disabled={!access.write || mutation.pending}
            onChange={(e) => patchTask({ status: e.target.value })}
          >
            {lists.statuses.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label[locale]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.fields.priority}
          <select
            value={task.priority}
            disabled={!access.write || mutation.pending}
            onChange={(e) => patchTask({ priority: e.target.value })}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t.priority[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.fields.assignee}
          <select
            value={task.assigneeUserId ?? ""}
            disabled={!access.write || mutation.pending}
            onChange={(e) => patchTask({ assigneeUserId: e.target.value || null })}
          >
            <option value="">{t.unassigned}</option>
            {task.assigneeUserId && !lists.members.some((m) => m.userId === task.assigneeUserId) && (
              <option value={task.assigneeUserId}>{t.former}</option>
            )}
            {lists.members
              .filter((m) => m.role !== "viewer")
              .map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          {t.fields.startDate}
          <Input
            type="date"
            value={task.startDate ?? ""}
            disabled={!access.write || mutation.pending}
            onChange={(e) => patchTask({ startDate: e.target.value || null })}
          />
        </label>
        <label>
          {t.fields.dueDate}
          <Input
            type="date"
            value={task.dueDate ?? ""}
            disabled={!access.write || mutation.pending}
            onChange={(e) => patchTask({ dueDate: e.target.value || null })}
          />
        </label>
        <PlacementFields task={task} t={t} disabled={!access.write || mutation.pending} onSave={patchTask} />
      </div>
      <LabelsEditor task={task} t={t} disabled={!access.write || mutation.pending} onSave={(labels) => patchTask({ labels })} />
      <DescriptionEditor task={task} t={t} disabled={!access.write || mutation.pending} onSave={(description) => patchTask({ description })} />

      <TaskAgents taskId={task.id} onChanged={changed} />

      <section className="work-section" aria-labelledby="work-subtasks">
        <h3 id="work-subtasks">{t.subtasks}</h3>
        {d.subtasks.length > 0 && (
          <ul className="support-rows">
            {d.subtasks.map((s) => (
              <TaskRow key={s.id} task={s} statuses={lists.statuses} members={lists.members} onOpen={onOpen} />
            ))}
          </ul>
        )}
        {access.write && !task.parentTaskId && (
          <InlineAdd
            label={t.addSubtask}
            disabled={mutation.pending}
            onAdd={(title) => change(() => send(path("/tasks"), "POST", { title, parentTaskId: task.id }))}
          />
        )}
      </section>

      <section className="work-section" aria-labelledby="work-checklist">
        <h3 id="work-checklist">{t.checklist}</h3>
        <ul className="work-checklist">
          {d.checklist.map((item) => (
            <li key={item.id}>
              <label>
                <input
                  type="checkbox"
                  checked={item.done}
                  disabled={!access.write || mutation.pending}
                  onChange={(e) => change(() => send(path(`/checklist/${item.id}`), "PATCH", { done: e.target.checked }))}
                />
                <span className={item.done ? "work-done" : undefined}>{item.text}</span>
              </label>
              {access.write && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${t.delete}: ${item.text}`}
                  onClick={() => change(() => send(path(`/checklist/${item.id}`), "DELETE"))}
                >
                  <X aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
        {access.write && (
          <InlineAdd label={t.addItem} disabled={mutation.pending} onAdd={(text) => change(() => send(path(`/tasks/${task.id}/checklist`), "POST", { text }))} />
        )}
      </section>

      <Dependencies detail={d} t={t} write={access.write} pending={mutation.pending} change={change} onOpen={onOpen} />
      <Links links={d.links} taskId={task.id} t={t} write={access.write} change={change} />
      <Attachments detail={d} t={t} write={access.write} change={change} />
      <Timeline detail={d} t={t} write={access.write} change={change} members={lists.members} statuses={lists.statuses} />

      <div className="work-actions">
        <Button
          variant="outline"
          size="sm"
          onClick={() => change(() => send(path(`/tasks/${task.id}/watch`), d.watching ? "DELETE" : "POST"))}
        >
          {d.watching ? <EyeOff aria-hidden /> : <Eye aria-hidden />} {d.watching ? t.unwatch : t.watch}
        </Button>
        {access.write && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              change(() => send(path(`/tasks/${task.id}/${task.archivedAt ? "restore" : "archive"}`), "POST", { expectedVersion: task.version }))
            }
          >
            {task.archivedAt ? t.restore : t.archive}
          </Button>
        )}
        {access.remove && <DeleteTask task={task} hasSubtasks={d.subtasks.length > 0} t={t} onDeleted={() => { onChanged?.(); onBack(); }} />}
      </div>
    </article>
  );
}

function TitleEditor({ task, t, disabled, onSave }: { task: Task; t: WorkText; disabled: boolean; onSave: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  if (!editing)
    return (
      <h2 id="work-task-title" className="work-task-title">
        #{task.number} {task.title}
        {!disabled && (
          <Button variant="ghost" size="sm" onClick={() => { setTitle(task.title); setEditing(true); }}>
            {t.edit}
          </Button>
        )}
      </h2>
    );
  return (
    <form
      className="work-inline"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() && title !== task.title) onSave(title.trim());
        setEditing(false);
      }}
    >
      <Input aria-label={t.fields.title} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <Button type="submit" size="sm">{t.save}</Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>{t.cancel}</Button>
    </form>
  );
}

function DescriptionEditor({ task, t, disabled, onSave }: { task: Task; t: WorkText; disabled: boolean; onSave: (value: string | null) => void }) {
  const [value, setValue] = useState<string | null>(null);
  const current = value ?? task.description ?? "";
  return (
    <section className="work-section" aria-labelledby="work-description">
      <h3 id="work-description">{t.fields.description}</h3>
      {disabled ? (
        <p className="support-message-text">{task.description || "—"}</p>
      ) : (
        <form
          className="work-stack"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(current.trim() ? current : null);
            setValue(null);
          }}
        >
          <Textarea aria-label={t.fields.description} rows={5} maxLength={50000} value={current} onChange={(e) => setValue(e.target.value)} />
          {value !== null && value !== (task.description ?? "") && (
            <div className="work-actions">
              <Button type="submit" size="sm">{t.save}</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setValue(null)}>{t.cancel}</Button>
            </div>
          )}
        </form>
      )}
    </section>
  );
}

function LabelsEditor({ task, t, disabled, onSave }: { task: Task; t: WorkText; disabled: boolean; onSave: (labels: string[]) => void }) {
  const [value, setValue] = useState<string | null>(null);
  const current = value ?? task.labels.join(", ");
  return (
    <form
      className="work-inline"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(current.split(",").map((l) => l.trim().toLowerCase()).filter(Boolean));
        setValue(null);
      }}
    >
      <label className="work-grow">
        {t.fields.labels}
        <Input
          value={current}
          disabled={disabled}
          placeholder={t.fields.labelsHint}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      {value !== null && <Button type="submit" size="sm">{t.save}</Button>}
    </form>
  );
}

/** Initiative and milestone of the task. */
function PlacementFields({ task, t, disabled, onSave }: { task: Task; t: WorkText; disabled: boolean; onSave: (fields: Record<string, unknown>) => void }) {
  const { project } = useWorkspace();
  const initiatives = useResource<{ items: Initiative[] }>(workPath(project.id, "/initiatives"));
  const milestones = useResource<{ items: Milestone[] }>(
    task.initiativeId ? workPath(project.id, `/milestones?initiativeId=${task.initiativeId}`) : null,
  );
  return (
    <>
      <label>
        {t.fields.initiative}
        <select
          value={task.initiativeId ?? ""}
          disabled={disabled || Boolean(task.parentTaskId)}
          onChange={(e) => onSave({ initiativeId: e.target.value || null })}
        >
          <option value="">{t.noInitiative}</option>
          {(initiatives.data?.items ?? []).map((i) => (
            <option key={i.id} value={i.id}>
              {i.key} · {i.title}
            </option>
          ))}
        </select>
      </label>
      {task.initiativeId && (
        <label>
          {t.fields.milestone}
          <select value={task.milestoneId ?? ""} disabled={disabled} onChange={(e) => onSave({ milestoneId: e.target.value || null })}>
            <option value="">{t.none}</option>
            {(milestones.data?.items ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}

export function InlineAdd({ label, disabled, onAdd }: { label: string; disabled?: boolean; onAdd: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="work-inline"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!value.trim()) return;
        onAdd(value.trim());
        setValue("");
      }}
    >
      <Input aria-label={label} placeholder={label} value={value} maxLength={300} onChange={(e) => setValue(e.target.value)} />
      <Button type="submit" size="sm" variant="outline" disabled={disabled || !value.trim()}>
        +
      </Button>
    </form>
  );
}

type Change = (task: () => Promise<unknown>) => Promise<unknown>;

function Dependencies({
  detail,
  t,
  write,
  pending,
  change,
  onOpen,
}: {
  detail: TaskDetail;
  t: WorkText;
  write: boolean;
  pending: boolean;
  change: Change;
  onOpen?: (id: string) => void;
}) {
  const { project } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const list = (title: string, items: TaskDetail["dependencies"]["waitsFor"]) =>
    items.length > 0 && (
      <div>
        <h4>{title}</h4>
        <ul className="work-checklist">
          {items.map(({ id, task }) => (
            <li key={id}>
              {task ? (
                <button type="button" className="text-link" onClick={() => onOpen?.(task.id)}>
                  #{task.number} {task.title}
                </button>
              ) : (
                "—"
              )}
              {write && (
                <Button variant="ghost" size="icon" aria-label={t.delete} onClick={() => change(() => send(workPath(project.id, `/dependencies/${id}`), "DELETE"))}>
                  <X aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <section className="work-section" aria-labelledby="work-dependencies">
      <h3 id="work-dependencies">{t.dependencies}</h3>
      {list(t.waitsFor, detail.dependencies.waitsFor)}
      {list(t.blocks, detail.dependencies.blocks)}
      {error && <Alert kind="error">{error}</Alert>}
      {write && (
        <InlineAdd
          label={t.addDependency}
          disabled={pending}
          onAdd={(value) =>
            change(async () => {
              setError(null);
              const number = value.replace(/^#/, "");
              const found = await api<TaskPage>(workPath(project.id, `/tasks?q=%23${encodeURIComponent(number)}&limit=1`));
              const target = found.items.find((i) => String(i.number) === number);
              if (!target) {
                setError(`#${number}?`);
                return;
              }
              await send(workPath(project.id, `/tasks/${detail.task.id}/dependencies`), "POST", { dependsOnTaskId: target.id });
            })
          }
        />
      )}
    </section>
  );
}

function Links({ links, taskId, t, write, change }: { links: LinkView[]; taskId: string; t: WorkText; write: boolean; change: Change }) {
  const { project, locale } = useWorkspace();
  const [type, setType] = useState<string>(LINK_TYPES[1]);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<string | null>(null);
  const targets = useResource<{ items: Array<{ id: string; title: string }> }>(
    search !== null ? workPath(project.id, `/link-targets?type=${encodeURIComponent(type)}&q=${encodeURIComponent(search)}`) : null,
  );
  return (
    <section className="work-section" aria-labelledby="work-links">
      <h3 id="work-links">{t.links}</h3>
      {links.length > 0 && (
        <ul className="work-checklist">
          {links.map((link) => (
            <li key={link.id}>
              <span>
                <Badge>{link.object.label?.[locale] ?? link.object.type}</Badge>{" "}
                {link.object.state === "ok" && link.object.href ? (
                  <AppLink className="text-link" href={link.object.href}>
                    {link.object.title}
                  </AppLink>
                ) : link.object.state === "restricted" ? (
                  t.restricted
                ) : (
                  t.missing
                )}
              </span>
              {write && (
                <Button variant="ghost" size="icon" aria-label={t.delete} onClick={() => change(() => send(workPath(project.id, `/links/${link.id}`), "DELETE"))}>
                  <X aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {write && (
        <form
          className="work-inline"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(query.trim());
          }}
        >
          <select aria-label={t.linkType} value={type} onChange={(e) => { setType(e.target.value); setSearch(null); }}>
            {LINK_TYPES.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <Input aria-label={t.linkSearch} placeholder={t.linkSearch} value={query} onChange={(e) => setQuery(e.target.value)} />
          <Button type="submit" size="sm" variant="outline">
            {t.linkSearch}
          </Button>
        </form>
      )}
      {search !== null && targets.data && (
        <ul className="work-checklist">
          {targets.data.items
            .filter((item) => item.id !== taskId)
            .map((item) => (
              <li key={item.id}>
                <span>{item.title}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    change(async () => {
                      await send(workPath(project.id, `/tasks/${taskId}/links`), "POST", {
                        targetType: type,
                        targetId: item.id,
                        relation: type === "knowledge.document" ? "documents" : "relates_to",
                      });
                      setSearch(null);
                    })
                  }
                >
                  {t.addLink}
                </Button>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

function Attachments({ detail, t, write, change }: { detail: TaskDetail; t: WorkText; write: boolean; change: Change }) {
  const { project } = useWorkspace();
  const upload = (file: File) =>
    change(async () => {
      const stored = await api<{ id: string }>(`/projects/${encodeURIComponent(project.id)}/files?module=work`, {
        method: "POST",
        body: file,
        headers: {
          "Content-Type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
          "x-file-type": file.type || "application/octet-stream",
        },
      });
      await send(workPath(project.id, `/tasks/${detail.task.id}/attachments`), "POST", { fileId: stored.id });
    });
  return (
    <section className="work-section" aria-labelledby="work-attachments">
      <h3 id="work-attachments">{t.attachments}</h3>
      {detail.attachments.length > 0 && (
        <ul className="work-checklist">
          {detail.attachments.map((a) => (
            <li key={a.id}>
              <a className="text-link" href={`/api/projects/${encodeURIComponent(project.id)}/files/${a.fileId}`}>
                <Paperclip aria-hidden size={14} /> {a.name}
              </a>
              {write && (
                <Button variant="ghost" size="icon" aria-label={`${t.delete}: ${a.name}`} onClick={() => change(() => send(workPath(project.id, `/attachments/${a.id}`), "DELETE"))}>
                  <X aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {write && (
        <label className="work-file">
          {t.attach}
          <input
            type="file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload(file);
              e.target.value = "";
            }}
          />
        </label>
      )}
    </section>
  );
}

function Timeline({
  detail,
  t,
  write,
  change,
  members,
  statuses,
}: {
  detail: TaskDetail;
  t: WorkText;
  write: boolean;
  change: Change;
  members: ReturnType<typeof useWorkLists>["members"];
  statuses: ReturnType<typeof useWorkLists>["statuses"];
}) {
  const { project, locale, identity } = useWorkspace();
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const actor = (kind: string, id: string | null) =>
    kind === "user" ? memberName(members, id, locale) : kind === "system" ? t.system : t.agent;
  const statusName = (key: unknown) => statuses.find((s) => s.key === key)?.label[locale] ?? String(key ?? "—");
  const eventText = (e: Extract<TimelineEntry, { kind: "event" }>) => {
    const base = t.event[e.type] ?? e.type;
    if (e.type === "status" && e.before.statusCategory)
      return `${base}: ${t.category[e.before.statusCategory as keyof WorkText["category"]] ?? "—"} → ${t.category[e.after.statusCategory as keyof WorkText["category"]] ?? "—"}`;
    if (e.type === "status") return `${base}: ${statusName(e.before.status)} → ${statusName(e.after.status)}`;
    return base;
  };
  return (
    <section className="work-section" aria-labelledby="work-history">
      <h3 id="work-history">{t.history}</h3>
      <ol className="support-timeline">
        {detail.timeline.map((entry) =>
          entry.kind === "comment" ? (
            <li key={entry.id} className="support-message">
              <div className="support-message-meta">
                <strong>{actor(entry.authorKind, entry.authorUserId)}</strong>
                <span>{when(entry.at, locale, project.timezone)}</span>
                {entry.editedAt && <span>({t.edit})</span>}
              </div>
              <p className="support-message-text">{entry.deletedAt ? "—" : entry.body}</p>
              {!entry.deletedAt && entry.authorUserId === identity.user.id && (
                <Button variant="ghost" size="sm" onClick={() => change(() => send(workPath(project.id, `/comments/${entry.id}`), "DELETE"))}>
                  <Trash2 aria-hidden /> {t.delete}
                </Button>
              )}
            </li>
          ) : (
            <li key={entry.id} className="support-event">
              {actor(entry.actorKind, entry.actorId)} {eventText(entry)} · {when(entry.at, locale, project.timezone)}
            </li>
          ),
        )}
      </ol>
      {write && (
        <form
          className="work-stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!body.trim()) return;
            change(async () => {
              await send(workPath(project.id, `/tasks/${detail.task.id}/comments`), "POST", { body, mentions });
              setBody("");
              setMentions([]);
            });
          }}
        >
          <Textarea aria-label={t.addComment} placeholder={t.addComment} rows={3} maxLength={20000} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="work-inline">
            <label>
              {t.mention}
              <select
                multiple
                value={mentions}
                onChange={(e) => setMentions([...e.target.selectedOptions].map((o) => o.value))}
              >
                {members
                  .filter((m) => m.userId !== identity.user.id)
                  .map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </label>
            <Button type="submit" size="sm" disabled={!body.trim()}>
              {t.comment}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function DeleteTask({ task, hasSubtasks, t, onDeleted }: { task: Task; hasSubtasks: boolean; t: WorkText; onDeleted: () => void }) {
  const { project } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [subtasks, setSubtasks] = useState(false);
  const mutation = useMutation(onDeleted);
  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <Trash2 aria-hidden /> {t.delete}
      </Button>
      {open && (
        <Modal title={t.confirmDelete} onClose={() => setOpen(false)}>
          <p>
            #{task.number} {task.title}
          </p>
          {hasSubtasks && (
            <label className="support-check">
              <input type="checkbox" checked={subtasks} onChange={(e) => setSubtasks(e.target.checked)} /> {t.includeSubtasks}
            </label>
          )}
          {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
          <div className="work-actions">
            <Button
              variant="destructive"
              disabled={mutation.pending || (hasSubtasks && !subtasks)}
              onClick={() =>
                mutation.run(() => send(workPath(project.id, `/tasks/${task.id}${subtasks ? "?includeSubtasks=true" : ""}`), "DELETE"))
              }
            >
              {t.delete}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t.cancel}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

"use client";
import { useEffect, useState } from "react";
import { ArrowLeft, Plus } from "lucide-react";
import { useMutation, useResource } from "@/lib/api";
import { Alert, Badge, Button, Empty, Input, Loading, Modal, Textarea } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import {
  day,
  INITIATIVE_HEALTH,
  INITIATIVE_STATUSES,
  MILESTONE_STATUSES,
  percentDone,
  readParam,
  send,
  workPath,
  writeParam,
  type Initiative,
  type Milestone,
  type TaskPage,
} from "./api";
import { workText, type WorkText } from "./labels";
import { memberName, ProgressBar, TaskRow, useWorkAccess, useWorkLists } from "./shared";
import { TaskForm } from "./tasks";

// Initiatives ("Vorhaben", plan §5.1): the list with progress, and one
// initiative (?initiative=<id>) with its fields, milestones and tasks.

export function InitiativesView() {
  const { project, locale } = useWorkspace();
  const t = workText(locale);
  const access = useWorkAccess();
  const [openId, setOpenId] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => setOpenId(readParam("initiative")), []);
  const open = (id: string | null) => {
    setOpenId(id);
    writeParam("initiative", id);
  };
  const list = useResource<{ items: Initiative[] }>(workPath(project.id, `/initiatives${archived ? "?archived=true" : ""}`));
  if (openId) return <InitiativeDetail id={openId} onBack={() => { open(null); list.refresh(); }} />;
  return (
    <div className="support-page">
      <PageHead title={t.nav.initiatives} description={t.intro}>
        <label className="support-check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> {t.showArchived}
        </label>
        {access.write && (
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden /> {t.newInitiative}
          </Button>
        )}
      </PageHead>
      {creating && (
        <InitiativeForm
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            open(id);
          }}
        />
      )}
      {list.loading ? (
        <Loading />
      ) : list.error ? (
        <ResourceError error={list.error} retry={list.refresh} />
      ) : !list.data?.items.length ? (
        <Empty title={t.noInitiatives} />
      ) : (
        <ul className="work-initiatives">
          {list.data.items.map((i) => (
            <InitiativeCard key={i.id} initiative={i} t={t} onOpen={() => open(i.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function InitiativeCard({ initiative: i, t, onOpen }: { initiative: Initiative; t: WorkText; onOpen: () => void }) {
  const { locale } = useWorkspace();
  const percent = percentDone(i.progress);
  return (
    <li>
      <button type="button" className="support-row work-initiative" onClick={onOpen}>
        <span className="support-row-title">
          {i.key} · {i.title}
        </span>
        <span className="support-row-meta">
          {t.fields.targetDate} {day(i.targetDate, locale)}
          {i.progress && ` · ${i.progress.total} ${t.nav.tasks}`}
          {i.progress && i.progress.overdue > 0 && ` · ${i.progress.overdue} ${t.metrics.overdue}`}
        </span>
        <ProgressBar percent={percent} label={t.progress} />
        <span className="support-row-badges">
          <Badge>{t.initiativeStatus[i.status]}</Badge>
          {i.health !== "unknown" && (
            <Badge tone={i.health === "on_track" ? "success" : i.health === "at_risk" ? "warning" : "danger"}>{t.health[i.health]}</Badge>
          )}
          <span>{percent}%</span>
        </span>
      </button>
    </li>
  );
}

function InitiativeDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { project, locale } = useWorkspace();
  const t = workText(locale);
  const access = useWorkAccess();
  const lists = useWorkLists();
  const detail = useResource<{ initiative: Initiative }>(workPath(project.id, `/initiatives/${id}`));
  const milestones = useResource<{ items: Milestone[] }>(workPath(project.id, `/milestones?initiativeId=${id}`));
  const tasks = useResource<TaskPage>(workPath(project.id, `/tasks?initiative=${id}&parent=none&sort=rank&limit=100`));
  const [editing, setEditing] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const refresh = () => {
    detail.refresh();
    milestones.refresh();
    tasks.refresh();
  };
  const mutation = useMutation(refresh);
  if (detail.loading) return <Loading />;
  if (detail.error) return <ResourceError error={detail.error} retry={detail.refresh} />;
  const i = detail.data!.initiative;
  return (
    <div className="support-page">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft aria-hidden /> {t.back}
      </Button>
      <PageHead title={`${i.key} · ${i.title}`} description={i.description ?? t.intro}>
        {access.write && (
          <>
            <Button variant="outline" onClick={() => setEditing(true)}>
              {t.edit}
            </Button>
            <Button variant="outline" onClick={() => mutation.run(() => send(workPath(project.id, `/initiatives/${i.id}/${i.archivedAt ? "restore" : "archive"}`), "POST", { expectedVersion: i.version }))}>
              {i.archivedAt ? t.restore : t.archive}
            </Button>
          </>
        )}
        {access.remove && (
          <Button variant="destructive" onClick={() => setDeleting(true)}>
            {t.delete}
          </Button>
        )}
      </PageHead>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      <dl className="work-facts">
        <div>
          <dt>{t.fields.status}</dt>
          <dd>{t.initiativeStatus[i.status]}</dd>
        </div>
        <div>
          <dt>{t.fields.health}</dt>
          <dd>{t.health[i.health]}</dd>
        </div>
        <div>
          <dt>{t.fields.owner}</dt>
          <dd>{memberName(lists.members, i.ownerUserId, locale)}</dd>
        </div>
        <div>
          <dt>{t.fields.startDate}</dt>
          <dd>{day(i.startDate, locale)}</dd>
        </div>
        <div>
          <dt>{t.fields.targetDate}</dt>
          <dd>{day(i.targetDate, locale)}</dd>
        </div>
        <div>
          <dt>{t.progress}</dt>
          <dd>
            {percentDone(i.progress)}% · {i.progress?.total ?? 0} {t.nav.tasks}
          </dd>
        </div>
      </dl>
      <ProgressBar percent={percentDone(i.progress)} label={t.progress} />
      <section className="work-section" aria-labelledby="work-milestones-head">
        <h2 id="work-milestones-head">{t.nav.milestones}</h2>
        <MilestoneList milestones={milestones} t={t} write={access.write} />
        {access.write && <MilestoneAdd initiativeId={i.id} t={t} onAdded={milestones.refresh} />}
      </section>
      <section className="work-section" aria-labelledby="work-initiative-tasks">
        <div className="work-section-head">
          <h2 id="work-initiative-tasks">{t.nav.tasks}</h2>
          {access.write && (
            <Button size="sm" onClick={() => setCreatingTask(true)}>
              <Plus aria-hidden /> {t.newTask}
            </Button>
          )}
        </div>
        {tasks.loading ? (
          <Loading />
        ) : tasks.error ? (
          <ResourceError error={tasks.error} retry={tasks.refresh} />
        ) : !tasks.data?.items.length ? (
          <Empty title={t.noTasks} />
        ) : (
          <ul className="support-rows">
            {tasks.data.items.map((task) => (
              <TaskRow key={task.id} task={task} statuses={lists.statuses} members={lists.members} />
            ))}
          </ul>
        )}
      </section>
      {editing && <InitiativeForm initiative={i} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />}
      {creatingTask && <TaskForm initiativeId={i.id} onClose={() => setCreatingTask(false)} onCreated={() => { setCreatingTask(false); refresh(); }} />}
      {deleting && <DeleteInitiative initiative={i} t={t} onClose={() => setDeleting(false)} onDeleted={onBack} />}
    </div>
  );
}

function MilestoneList({ milestones, t, write }: { milestones: ReturnType<typeof useResource<{ items: Milestone[] }>>; t: WorkText; write: boolean }) {
  const { project, locale } = useWorkspace();
  const mutation = useMutation(milestones.refresh);
  if (milestones.loading) return <Loading />;
  if (milestones.error) return <ResourceError error={milestones.error} retry={milestones.refresh} />;
  if (!milestones.data?.items.length) return <p className="support-muted">{t.noMilestones}</p>;
  return (
    <ul className="work-checklist">
      {milestones.data.items.map((m) => (
        <li key={m.id}>
          <span>
            <strong>{m.title}</strong> · {day(m.dueDate, locale)}
            {m.tasks && ` · ${m.tasks.total - m.tasks.open}/${m.tasks.total}`}
          </span>
          {write ? (
            <select
              aria-label={`${t.fields.status}: ${m.title}`}
              value={m.status}
              onChange={(e) => mutation.run(() => send(workPath(project.id, `/milestones/${m.id}`), "PATCH", { expectedVersion: m.version, status: e.target.value }))}
            >
              {MILESTONE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t.milestoneStatus[s]}
                </option>
              ))}
            </select>
          ) : (
            <Badge>{t.milestoneStatus[m.status]}</Badge>
          )}
        </li>
      ))}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
    </ul>
  );
}

function MilestoneAdd({ initiativeId, t, onAdded }: { initiativeId: string; t: WorkText; onAdded: () => void }) {
  const { project } = useWorkspace();
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const mutation = useMutation(() => {
    setTitle("");
    setDueDate("");
    onAdded();
  });
  return (
    <form
      className="work-inline"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        mutation.run(() => send(workPath(project.id, `/initiatives/${initiativeId}/milestones`), "POST", { title, ...(dueDate ? { dueDate } : {}) }));
      }}
    >
      <Input aria-label={t.newMilestone} placeholder={t.newMilestone} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      <Input type="date" aria-label={t.fields.dueDate} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      <Button type="submit" size="sm" variant="outline" disabled={mutation.pending || !title.trim()}>
        +
      </Button>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
    </form>
  );
}

function InitiativeForm({ initiative, onClose, onSaved }: { initiative?: Initiative; onClose: () => void; onSaved: (id: string) => void }) {
  const { project, locale } = useWorkspace();
  const t = workText(locale);
  const lists = useWorkLists();
  const [form, setForm] = useState({
    title: initiative?.title ?? "",
    key: initiative?.key ?? "",
    description: initiative?.description ?? "",
    status: initiative?.status ?? "planned",
    health: initiative?.health ?? "unknown",
    ownerUserId: initiative?.ownerUserId ?? "",
    startDate: initiative?.startDate ?? "",
    targetDate: initiative?.targetDate ?? "",
  });
  const mutation = useMutation();
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));
  const body = {
    title: form.title,
    description: form.description.trim() ? form.description : null,
    status: form.status,
    ownerUserId: form.ownerUserId || null,
    startDate: form.startDate || null,
    targetDate: form.targetDate || null,
  };
  return (
    <Modal title={initiative ? t.edit : t.newInitiative} onClose={onClose}>
      <form
        className="support-form work-stack"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.run(async () => {
            const saved = initiative
              ? await send<Initiative>(workPath(project.id, `/initiatives/${initiative.id}`), "PATCH", { expectedVersion: initiative.version, ...body, health: form.health })
              : await send<Initiative>(workPath(project.id, "/initiatives"), "POST", { ...body, ...(form.key ? { key: form.key.toUpperCase() } : {}) });
            onSaved(saved.id);
          });
        }}
      >
        <label>
          {t.fields.title}
          <Input required maxLength={200} value={form.title} onChange={(e) => set("title")(e.target.value)} autoFocus />
        </label>
        {!initiative && (
          <label>
            {t.fields.key}
            <Input maxLength={10} pattern="[A-Za-z][A-Za-z0-9]{1,9}" value={form.key} onChange={(e) => set("key")(e.target.value)} />
          </label>
        )}
        <label>
          {t.fields.description}
          <Textarea rows={4} maxLength={50000} value={form.description} onChange={(e) => set("description")(e.target.value)} />
        </label>
        <div className="support-controls">
          <label>
            {t.fields.status}
            <select value={form.status} onChange={(e) => set("status")(e.target.value)}>
              {INITIATIVE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t.initiativeStatus[s]}
                </option>
              ))}
            </select>
          </label>
          {initiative && (
            <label>
              {t.fields.health}
              <select value={form.health} onChange={(e) => set("health")(e.target.value)}>
                {INITIATIVE_HEALTH.map((h) => (
                  <option key={h} value={h}>
                    {t.health[h]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            {t.fields.owner}
            <select value={form.ownerUserId} onChange={(e) => set("ownerUserId")(e.target.value)}>
              <option value="">{t.none}</option>
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
            <Input type="date" value={form.startDate} onChange={(e) => set("startDate")(e.target.value)} />
          </label>
          <label>
            {t.fields.targetDate}
            <Input type="date" value={form.targetDate} onChange={(e) => set("targetDate")(e.target.value)} />
          </label>
        </div>
        {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
        <div className="work-actions">
          <Button type="submit" disabled={mutation.pending || !form.title.trim()}>
            {initiative ? t.save : t.create}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t.cancel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteInitiative({ initiative, t, onClose, onDeleted }: { initiative: Initiative; t: WorkText; onClose: () => void; onDeleted: () => void }) {
  const { project } = useWorkspace();
  const mutation = useMutation(onDeleted);
  return (
    <Modal title={t.confirmDeleteInitiative} onClose={onClose}>
      <p>
        {initiative.key} · {initiative.title}
      </p>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      <div className="work-actions">
        <Button
          variant="destructive"
          disabled={mutation.pending}
          onClick={() => mutation.run(() => send(workPath(project.id, `/initiatives/${initiative.id}?detachTasks=true`), "DELETE"))}
        >
          {t.delete}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t.cancel}
        </Button>
      </div>
    </Modal>
  );
}

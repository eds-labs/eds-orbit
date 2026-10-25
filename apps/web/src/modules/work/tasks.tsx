"use client";
import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import { useMutation, useResource } from "@/lib/api";
import { Alert, Button, Empty, Input, Loading, Modal, Textarea } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { cn } from "@/lib/utils";
import {
  PRIORITIES,
  STATUS_CATEGORIES,
  readParam,
  send,
  taskQuery,
  workPath,
  writeParam,
  type Initiative,
  type TaskItem,
  type TaskPage,
} from "./api";
import { workText } from "./labels";
import { TaskRow, useWorkAccess, useWorkLists } from "./shared";
import { TaskDetailView } from "./task-detail";

// The task list (plan §5.1): filters, search, sort and "load more", with the
// open task beside it (?task=<id>). Filters can come from links, such as
// ?category=blocked from an attention item.

const SORTS = ["rank", "due", "priority", "updated", "created", "number"] as const;

/** The task opened in the URL (?task=), kept in sync without a reload. */
export function useOpenTask() {
  const [taskId, setTaskId] = useState<string | null>(null);
  useEffect(() => setTaskId(readParam("task")), []);
  const open = (id: string | null) => {
    setTaskId(id);
    writeParam("task", id);
  };
  return [taskId, open] as const;
}

export function TaskListView() {
  const { project, locale } = useWorkspace();
  const t = workText(locale);
  const access = useWorkAccess();
  const lists = useWorkLists();
  const [taskId, openTask] = useOpenTask();
  const [filters, setFilters] = useState({
    category: "",
    priority: "",
    assignee: "",
    initiative: "",
    sort: "rank",
    archived: "",
    open: "true",
  });
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [pages, setPages] = useState<Array<string | null>>([null]);
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const category = readParam("category");
    if (category && (STATUS_CATEGORIES as readonly string[]).includes(category))
      setFilters((f) => ({ ...f, category, open: "" }));
  }, []);
  useEffect(() => setPages([null]), [filters, search]);
  const initiatives = useResource<{ items: Initiative[] }>(workPath(project.id, "/initiatives"));
  const set = (key: keyof typeof filters) => (value: string) => setFilters((f) => ({ ...f, [key]: value }));
  return (
    <div className="support-page">
      <PageHead title={t.nav.tasks} description={t.intro}>
        {access.write && (
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden /> {t.newTask}
          </Button>
        )}
      </PageHead>
      {creating && (
        <TaskForm
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setRevision((n) => n + 1);
            openTask(id);
          }}
        />
      )}
      <div className={cn("support-layout", taskId && "support-layout-open")}>
        <section className="support-list" aria-label={t.nav.tasks}>
          <form
            className="support-filters"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(q.trim());
            }}
          >
            <label className="support-search">
              <Search aria-hidden size={16} />
              <Input aria-label={t.search} placeholder={t.search} value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <select aria-label={t.fields.status} value={filters.category} onChange={(e) => set("category")(e.target.value)}>
              <option value="">{t.any}</option>
              {STATUS_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t.category[c]}
                </option>
              ))}
            </select>
            <select aria-label={t.fields.priority} value={filters.priority} onChange={(e) => set("priority")(e.target.value)}>
              <option value="">{t.any}</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t.priority[p]}
                </option>
              ))}
            </select>
            <select aria-label={t.fields.assignee} value={filters.assignee} onChange={(e) => set("assignee")(e.target.value)}>
              <option value="">{t.any}</option>
              <option value="me">{t.nav.my}</option>
              <option value="none">{t.unassigned}</option>
              {lists.members
                .filter((m) => m.role !== "viewer")
                .map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
            </select>
            <select aria-label={t.fields.initiative} value={filters.initiative} onChange={(e) => set("initiative")(e.target.value)}>
              <option value="">{t.any}</option>
              <option value="none">{t.noInitiative}</option>
              {(initiatives.data?.items ?? []).map((i) => (
                <option key={i.id} value={i.id}>
                  {i.key} · {i.title}
                </option>
              ))}
            </select>
            <select aria-label={t.sortBy} value={filters.sort} onChange={(e) => set("sort")(e.target.value)}>
              {SORTS.map((s) => (
                <option key={s} value={s}>
                  {t.sort[s]}
                </option>
              ))}
            </select>
            <label className="support-check">
              <input
                type="checkbox"
                checked={filters.open === "true"}
                disabled={Boolean(filters.category)}
                onChange={(e) => set("open")(e.target.checked ? "true" : "")}
              />
              {t.openOnly}
            </label>
            <label className="support-check">
              <input type="checkbox" checked={filters.archived === "true"} onChange={(e) => set("archived")(e.target.checked ? "true" : "")} />
              {t.showArchived}
            </label>
          </form>
          {lists.error && <ResourceError error={lists.error} retry={lists.refresh} />}
          {pages.map((cursor, i) => (
            <Page
              key={`${revision}-${cursor ?? "first"}`}
              path={workPath(
                project.id,
                `/tasks?${taskQuery({ ...filters, open: filters.category ? "" : filters.open, q: search, cursor })}`,
              )}
              selected={taskId}
              onOpen={openTask}
              lists={lists}
              filtered={Boolean(search || filters.category || filters.priority || filters.assignee || filters.initiative)}
              onMore={i === pages.length - 1 ? (next) => setPages([...pages, next]) : undefined}
            />
          ))}
        </section>
        {taskId && (
          <section className="support-detail">
            <TaskDetailView
              key={taskId}
              taskId={taskId}
              onBack={() => openTask(null)}
              onChanged={() => setRevision((n) => n + 1)}
              onOpen={openTask}
            />
          </section>
        )}
      </div>
    </div>
  );
}

function Page({
  path,
  selected,
  onOpen,
  onMore,
  lists,
  filtered,
}: {
  path: string;
  selected: string | null;
  onOpen: (id: string) => void;
  onMore?: (cursor: string) => void;
  lists: ReturnType<typeof useWorkLists>;
  filtered: boolean;
}) {
  const { locale } = useWorkspace();
  const t = workText(locale);
  const page = useResource<TaskPage>(path);
  if (page.loading) return <Loading />;
  if (page.error) return <ResourceError error={page.error} retry={page.refresh} />;
  const items = page.data?.items ?? [];
  if (!items.length && !onMore) return null;
  if (!items.length) return <Empty title={filtered ? t.noTasksFilter : t.noTasks} />;
  return (
    <>
      <ul className="support-rows">
        {items.map((task: TaskItem) => (
          <TaskRow key={task.id} task={task} statuses={lists.statuses} members={lists.members} selected={selected === task.id} onOpen={onOpen} />
        ))}
      </ul>
      {onMore && page.data?.nextCursor && (
        <Button variant="outline" size="sm" onClick={() => onMore(page.data!.nextCursor!)}>
          {t.loadMore}
        </Button>
      )}
    </>
  );
}

/** A new task; the initiative and status may be preset by the caller. */
export function TaskForm({
  onClose,
  onCreated,
  initiativeId,
  status,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  initiativeId?: string;
  status?: string;
}) {
  const { project, locale } = useWorkspace();
  const t = workText(locale);
  const lists = useWorkLists();
  const initiatives = useResource<{ items: Initiative[] }>(workPath(project.id, "/initiatives"));
  const [form, setForm] = useState({
    title: "",
    description: "",
    priority: "none",
    assigneeUserId: "",
    dueDate: "",
    initiativeId: initiativeId ?? "",
  });
  const mutation = useMutation();
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));
  return (
    <Modal title={t.newTask} onClose={onClose}>
      <form
        className="support-form work-stack"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.run(async () => {
            const created = await send<{ id: string }>(workPath(project.id, "/tasks"), "POST", {
              title: form.title,
              ...(form.description.trim() ? { description: form.description } : {}),
              priority: form.priority,
              ...(form.assigneeUserId ? { assigneeUserId: form.assigneeUserId } : {}),
              ...(form.dueDate ? { dueDate: form.dueDate } : {}),
              ...(form.initiativeId ? { initiativeId: form.initiativeId } : {}),
              ...(status ? { status } : {}),
            });
            onCreated(created.id);
          });
        }}
      >
        <label>
          {t.fields.title}
          <Input required maxLength={300} value={form.title} onChange={(e) => set("title")(e.target.value)} autoFocus />
        </label>
        <label>
          {t.fields.description}
          <Textarea rows={4} maxLength={50000} value={form.description} onChange={(e) => set("description")(e.target.value)} />
        </label>
        <div className="support-controls">
          <label>
            {t.fields.priority}
            <select value={form.priority} onChange={(e) => set("priority")(e.target.value)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t.priority[p]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t.fields.assignee}
            <select value={form.assigneeUserId} onChange={(e) => set("assigneeUserId")(e.target.value)}>
              <option value="">{t.unassigned}</option>
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
            {t.fields.dueDate}
            <Input type="date" value={form.dueDate} onChange={(e) => set("dueDate")(e.target.value)} />
          </label>
          <label>
            {t.fields.initiative}
            <select value={form.initiativeId} onChange={(e) => set("initiativeId")(e.target.value)}>
              <option value="">{t.noInitiative}</option>
              {(initiatives.data?.items ?? []).map((i) => (
                <option key={i.id} value={i.id}>
                  {i.key} · {i.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
        <div className="work-actions">
          <Button type="submit" disabled={mutation.pending || !form.title.trim()}>
            {t.create}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t.cancel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

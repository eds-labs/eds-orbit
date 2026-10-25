"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  closestCorners,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, GripVertical, Plus } from "lucide-react";
import { api, ApiError, useResource } from "@/lib/api";
import { Alert, Badge, Button, Loading, Modal } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import {
  day,
  overdue,
  readParam,
  send,
  workPath,
  writeParam,
  type Initiative,
  type TaskItem,
  type TaskPage,
  type WorkStatus,
} from "./api";
import { workText, type WorkText } from "./labels";
import { memberName, PriorityBadge, useWorkAccess, useWorkLists } from "./shared";
import { TaskDetailView } from "./task-detail";
import { TaskForm } from "./tasks";

// The kanban board (plan §5.3): one column per status, cards in board order.
// Cards move by dragging (pointer, touch and keyboard through @dnd-kit) or
// with the Move menu on every card; both send one move with the version the
// member saw. A conflict reloads the board with a notice.

type Columns = Record<string, TaskItem[]>;
const MAX_TASKS = 500;

/** All of the board's tasks, page by page, in board order. */
async function loadTasks(projectId: string, initiative: string) {
  const items: TaskItem[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ sort: "rank", limit: "100" });
    if (initiative) query.set("initiative", initiative);
    if (cursor) query.set("cursor", cursor);
    const page: TaskPage = await api<TaskPage>(workPath(projectId, `/tasks?${query}`));
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && items.length < MAX_TASKS);
  return items;
}

function columnsOf(statuses: WorkStatus[], tasks: TaskItem[]): Columns {
  const columns: Columns = Object.fromEntries(statuses.map((s) => [s.key, [] as TaskItem[]]));
  for (const task of tasks) (columns[task.status] ??= []).push(task);
  return columns;
}

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function BoardView() {
  const { project, locale } = useWorkspace();
  const t = workText(locale);
  const access = useWorkAccess();
  const lists = useWorkLists();
  const initiatives = useResource<{ items: Initiative[] }>(workPath(project.id, "/initiatives"));
  const [initiative, setInitiative] = useState("");
  const [columns, setColumns] = useState<Columns | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const origin = useRef<{ id: string; status: string; index: number } | null>(null);
  const statuses = lists.statuses;

  const reload = useCallback(() => {
    if (!statuses.length) return;
    setError(null);
    loadTasks(project.id, initiative)
      .then((tasks) => setColumns(columnsOf(statuses, tasks)))
      .catch(setError);
  }, [project.id, initiative, statuses]);
  useEffect(() => reload(), [reload]);
  useEffect(() => setOpen(readParam("task")), []);
  const openTask = (id: string | null) => {
    setOpen(id);
    writeParam("task", id);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const containerOf = (id: string, cols: Columns) =>
    id in cols ? id : Object.keys(cols).find((key) => cols[key]!.some((task) => task.id === id));

  /** Sends one move; a refused move reloads the board. */
  const move = async (task: TaskItem, status: string, list: TaskItem[]) => {
    const index = list.findIndex((x) => x.id === task.id);
    setNotice(null);
    try {
      await send(workPath(project.id, `/tasks/${task.id}/move`), "POST", {
        expectedVersion: task.version,
        ...(status !== task.status ? { status } : {}),
        afterTaskId: list[index - 1]?.id ?? null,
        beforeTaskId: list[index + 1]?.id ?? null,
      });
    } catch (e) {
      setNotice(e instanceof ApiError && e.status === 409 ? t.conflict : e instanceof Error ? e.message : String(e));
    }
    reload();
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    if (!columns) return;
    const status = containerOf(String(active.id), columns)!;
    origin.current = { id: String(active.id), status, index: columns[status]!.findIndex((x) => x.id === active.id) };
  };
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!columns || !over) return;
    const from = containerOf(String(active.id), columns);
    const to = containerOf(String(over.id), columns);
    if (!from || !to || from === to) return;
    setColumns((cols) => {
      if (!cols) return cols;
      const task = cols[from]!.find((x) => x.id === active.id)!;
      const target = cols[to]!;
      const overIndex = target.findIndex((x) => x.id === over.id);
      const at = overIndex < 0 ? target.length : overIndex;
      return {
        ...cols,
        [from]: cols[from]!.filter((x) => x.id !== active.id),
        [to]: [...target.slice(0, at), task, ...target.slice(at)],
      };
    });
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const start = origin.current;
    origin.current = null;
    if (!columns || !over || !start) return reload();
    const to = containerOf(String(over.id), columns);
    if (!to) return reload();
    let list = columns[to]!;
    const from = list.findIndex((x) => x.id === active.id);
    const overIndex = list.findIndex((x) => x.id === over.id);
    if (overIndex >= 0 && from !== overIndex) list = arrayMove(list, from, overIndex);
    setColumns({ ...columns, [to]: list });
    const task = list.find((x) => x.id === active.id)!;
    const index = list.indexOf(task);
    if (to === start.status && index === start.index) return;
    void move(task, to, list);
  };

  /** The Move menu: another status (to the end) or one place up or down. */
  const moveBy = (task: TaskItem, status: string, step: -1 | 0 | 1) => {
    if (!columns) return;
    const list = columns[task.status]!.filter((x) => x.id !== task.id);
    if (status !== task.status) {
      const target = [...columns[status]!, task];
      setColumns({ ...columns, [task.status]: list, [status]: target });
      return void move(task, status, target);
    }
    const index = columns[task.status]!.indexOf(task) + step;
    if (index < 0 || index > list.length) return;
    const next = [...list.slice(0, index), task, ...list.slice(index)];
    setColumns({ ...columns, [task.status]: next });
    void move(task, task.status, next);
  };

  return (
    <div className="support-page work-board-page">
      <PageHead title={t.nav.board} description={t.dragHint}>
        <select aria-label={t.fields.initiative} value={initiative} onChange={(e) => setInitiative(e.target.value)}>
          <option value="">{t.any}</option>
          <option value="none">{t.noInitiative}</option>
          {(initiatives.data?.items ?? []).map((i) => (
            <option key={i.id} value={i.id}>
              {i.key} · {i.title}
            </option>
          ))}
        </select>
      </PageHead>
      {notice && <Alert kind="warning">{notice}</Alert>}
      {lists.error && <ResourceError error={lists.error} retry={lists.refresh} />}
      {error && <ResourceError error={error} retry={reload} />}
      {!columns ? (
        !error && <Loading />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={access.write ? onDragStart : undefined}
          onDragOver={access.write ? onDragOver : undefined}
          onDragEnd={access.write ? onDragEnd : undefined}
          onDragCancel={() => reload()}
        >
          <div className="work-board" role="list" aria-label={t.nav.board}>
            {statuses.map((status) => (
              <Column
                key={status.key}
                status={status}
                tasks={columns[status.key] ?? []}
                limit={lists.settings?.wipLimits[status.key]}
                statuses={statuses}
                t={t}
                write={access.write}
                members={lists.members}
                onOpen={openTask}
                onMove={moveBy}
                onAdd={() => setCreating(status.key)}
              />
            ))}
          </div>
        </DndContext>
      )}
      {creating && (
        <TaskForm
          status={creating}
          initiativeId={initiative && initiative !== "none" ? initiative : undefined}
          onClose={() => setCreating(null)}
          onCreated={() => {
            setCreating(null);
            reload();
          }}
        />
      )}
      {open && (
        <Modal title={t.nav.tasks} onClose={() => openTask(null)} wide>
          <TaskDetailView key={open} taskId={open} onBack={() => openTask(null)} onChanged={reload} onOpen={openTask} />
        </Modal>
      )}
    </div>
  );
}

function Column({
  status,
  tasks,
  limit,
  statuses,
  t,
  write,
  members,
  onOpen,
  onMove,
  onAdd,
}: {
  status: WorkStatus;
  tasks: TaskItem[];
  limit?: number;
  statuses: WorkStatus[];
  t: WorkText;
  write: boolean;
  members: ReturnType<typeof useWorkLists>["members"];
  onOpen: (id: string) => void;
  onMove: (task: TaskItem, status: string, step: -1 | 0 | 1) => void;
  onAdd: () => void;
}) {
  const { locale } = useWorkspace();
  const { setNodeRef } = useDroppable({ id: status.key });
  const ids = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const over = limit !== undefined && tasks.length > limit;
  return (
    <section className="work-column" role="listitem" aria-labelledby={`work-col-${status.key}`} data-category={status.category}>
      <header className="work-column-head">
        <h2 id={`work-col-${status.key}`}>{status.label[locale]}</h2>
        <Badge tone={over ? "warning" : "neutral"}>
          {tasks.length}
          {limit !== undefined && ` / ${limit}`}
        </Badge>
        {over && <span className="sr-only">{t.wipOver}</span>}
        {write && (
          <Button variant="ghost" size="icon" aria-label={`${t.newTask}: ${status.label[locale]}`} onClick={onAdd}>
            <Plus aria-hidden />
          </Button>
        )}
      </header>
      <SortableContext id={status.key} items={ids} strategy={verticalListSortingStrategy}>
        <ul ref={setNodeRef} className="work-column-cards">
          {tasks.map((task, index) => (
            <Card
              key={task.id}
              task={task}
              first={index === 0}
              last={index === tasks.length - 1}
              statuses={statuses}
              t={t}
              write={write}
              members={members}
              onOpen={onOpen}
              onMove={onMove}
            />
          ))}
        </ul>
      </SortableContext>
    </section>
  );
}

function Card({
  task,
  first,
  last,
  statuses,
  t,
  write,
  members,
  onOpen,
  onMove,
}: {
  task: TaskItem;
  first: boolean;
  last: boolean;
  statuses: WorkStatus[];
  t: WorkText;
  write: boolean;
  members: ReturnType<typeof useWorkLists>["members"];
  onOpen: (id: string) => void;
  onMove: (task: TaskItem, status: string, step: -1 | 0 | 1) => void;
}) {
  const { locale } = useWorkspace();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: !write,
  });
  const style = {
    transform: CSS.Translate.toString(transform),
    transition: reducedMotion() ? undefined : transition,
  };
  const late = overdue(task);
  return (
    <li ref={setNodeRef} style={style} className="work-card" data-dragging={isDragging || undefined}>
      <div className="work-card-top">
        {write && (
          <button type="button" className="work-card-handle" aria-label={`${t.move}: #${task.number}`} {...attributes} {...listeners}>
            <GripVertical aria-hidden size={16} />
          </button>
        )}
        <button type="button" className="work-card-title" onClick={() => onOpen(task.id)}>
          #{task.number} {task.title}
        </button>
      </div>
      <div className="support-row-meta">
        {memberName(members, task.assigneeUserId, locale, task.assigneeAgentKey)}
        {task.dueDate && (
          <span data-tone={late ? "critical" : undefined}>
            {" · "}
            {day(task.dueDate, locale)}
          </span>
        )}
      </div>
      <div className="support-row-badges">
        <PriorityBadge priority={task.priority} />
        {late && <Badge tone="danger">{t.metrics.overdue}</Badge>}
        {task.counts && task.counts.blockedBy > 0 && <Badge tone="warning">{t.waitsFor} {task.counts.blockedBy}</Badge>}
      </div>
      {write && (
        <div className="work-card-move">
          <label className="sr-only" htmlFor={`work-move-${task.id}`}>
            {t.moveTo}
          </label>
          <select id={`work-move-${task.id}`} value={task.status} onChange={(e) => onMove(task, e.target.value, 0)}>
            {statuses.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label[locale]}
              </option>
            ))}
          </select>
          <Button variant="ghost" size="icon" aria-label={`${t.moveUp}: #${task.number}`} disabled={first} onClick={() => onMove(task, task.status, -1)}>
            <ArrowUp aria-hidden />
          </Button>
          <Button variant="ghost" size="icon" aria-label={`${t.moveDown}: #${task.number}`} disabled={last} onClick={() => onMove(task, task.status, 1)}>
            <ArrowDown aria-hidden />
          </Button>
        </div>
      )}
    </li>
  );
}

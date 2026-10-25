import { api } from "@/lib/api";

// The project management module's client side (ADR 0016): types of the
// /work API and the pure helpers the views share.

export const STATUS_CATEGORIES = [
  "backlog",
  "todo",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "canceled",
] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];
export const OPEN_CATEGORIES: readonly StatusCategory[] = [
  "backlog",
  "todo",
  "in_progress",
  "blocked",
  "in_review",
];
export const PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const INITIATIVE_STATUSES = [
  "planned",
  "active",
  "on_hold",
  "completed",
  "canceled",
] as const;
export const INITIATIVE_HEALTH = ["unknown", "on_track", "at_risk", "off_track"] as const;
export const MILESTONE_STATUSES = ["open", "reached", "missed", "canceled"] as const;

export type WorkStatus = {
  key: string;
  label: { en: string; de: string };
  category: StatusCategory;
  order: number;
};
export type WorkSettings = {
  workflow: { statuses: WorkStatus[]; transitions?: Record<string, string[]> };
  categories: Array<{ key: string; label: string; color: string }>;
  teams: Array<{ key: string; name: string; memberUserIds: string[] }>;
  wipLimits: Record<string, number>;
  notifications: { dueSoonDays: number };
};
export type Member = { userId: string; name: string; role: "owner" | "editor" | "viewer" };

export type Progress = {
  byCategory: Record<StatusCategory, number>;
  total: number;
  overdue: number;
};
export type Initiative = {
  id: string;
  key: string;
  title: string;
  description: string | null;
  status: (typeof INITIATIVE_STATUSES)[number];
  health: (typeof INITIATIVE_HEALTH)[number];
  ownerUserId: string | null;
  startDate: string | null;
  targetDate: string | null;
  version: number;
  archivedAt: string | null;
  progress?: Progress;
};
export type Milestone = {
  id: string;
  initiativeId: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  status: (typeof MILESTONE_STATUSES)[number];
  sortOrder: number;
  version: number;
  tasks?: { total: number; open: number };
};
export type TaskItem = {
  id: string;
  number: number;
  initiativeId: string | null;
  milestoneId: string | null;
  parentTaskId: string | null;
  title: string;
  status: string;
  statusCategory: StatusCategory;
  priority: Priority;
  category: string | null;
  labels: string[];
  assigneeUserId: string | null;
  assigneeAgentKey: string | null;
  teamKey: string | null;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  estimate: number | null;
  rank: string;
  source: string;
  version: number;
  updatedAt: string;
  archivedAt: string | null;
  counts?: {
    subtasks: number;
    subtasksDone: number;
    checklist: number;
    checklistDone: number;
    blockedBy: number;
  };
};
export type Task = TaskItem & { description: string | null; createdBy: string; createdAt: string };
export type TaskRef = {
  id: string;
  number: number;
  title: string;
  status: string;
  statusCategory: StatusCategory;
};
export type LinkView = {
  id: string;
  relation: string;
  direction: "outgoing" | "incoming";
  object: {
    type: string;
    id: string;
    label: { en: string; de: string } | null;
    state: "ok" | "restricted" | "missing";
    title?: string;
    status?: string;
    href?: string;
  };
  createdAt: string;
};
export type TimelineEntry =
  | {
      kind: "event";
      id: string;
      type: string;
      actorKind: string;
      actorId: string | null;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      at: string;
    }
  | {
      kind: "comment";
      id: string;
      authorKind: string;
      authorUserId: string | null;
      body: string;
      mentions: string[];
      editedAt: string | null;
      deletedAt: string | null;
      at: string;
    };
export type TaskDetail = {
  task: Task;
  parent: TaskRef | null;
  initiative: { id: string; key: string; title: string } | null;
  milestone: Milestone | null;
  subtasks: TaskItem[];
  checklist: Array<{ id: string; text: string; done: boolean; sortOrder: number }>;
  dependencies: {
    waitsFor: Array<{ id: string; task: TaskRef | null }>;
    blocks: Array<{ id: string; task: TaskRef | null }>;
  };
  links: LinkView[];
  attachments: Array<{ id: string; fileId: string; name: string; mime: string; size: number }>;
  watchers: string[];
  watching: boolean;
  timeline: TimelineEntry[];
};
export type TaskPage = { items: TaskItem[]; total: number; nextCursor: string | null };
export type Overview = {
  counts: {
    open: number;
    overdue: number;
    dueThisWeek: number;
    blocked: number;
    byCategory: Record<string, number>;
  };
  initiatives: Initiative[];
  myNext: TaskItem[];
};
export type MyTasks = Record<"overdue" | "today" | "week" | "later" | "none", TaskItem[]>;

export const workPath = (projectId: string, rest = "") =>
  `/projects/${encodeURIComponent(projectId)}/work${rest}`;

export const send = <T>(path: string, method: "POST" | "PATCH" | "PUT" | "DELETE", data?: unknown) =>
  api<T>(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });

/** The list query: only set filters, the cursor encoded. */
export function taskQuery(filters: Record<string, string | null | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value !== null && value !== undefined && value !== "") query.set(key, value);
  return query.toString();
}

/** The open item of a list in the URL (?task=, ?initiative=), kept without reload. */
export function readParam(name: string) {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(name);
}
export function writeParam(name: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(name, value);
  else url.searchParams.delete(name);
  window.history.replaceState(null, "", url);
}

/** A date as the member reads it; "—" without one. */
export function day(value: string | null, locale: "en" | "de") {
  if (!value) return "—";
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(locale === "de" ? "de-DE" : "en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** True when an open task's due date has passed. */
export function overdue(task: { dueDate: string | null; statusCategory: string }, today = new Date()) {
  if (!task.dueDate || !OPEN_CATEGORIES.includes(task.statusCategory as StatusCategory)) return false;
  return task.dueDate < today.toISOString().slice(0, 10);
}

/** Percent of finished top-level tasks of a progress count. */
export function percentDone(progress: Progress | undefined) {
  if (!progress || !progress.total) return 0;
  const closed = progress.byCategory.done + progress.byCategory.canceled;
  return Math.round((closed / progress.total) * 100);
}

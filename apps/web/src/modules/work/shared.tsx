"use client";
import { useMemo } from "react";
import { useResource } from "@/lib/api";
import { Badge } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import {
  day,
  overdue,
  workPath,
  type Member,
  type Priority,
  type StatusCategory,
  type TaskItem,
  type WorkSettings,
} from "./api";
import { workText } from "./labels";

// Pieces every project management view shares: what the member may do, the
// project's workflow and members, and how a task looks in a list.

/**
 * What the member may do here. The module role the server advertises wins;
 * without it the project role decides. The server stays authoritative.
 */
export function useWorkAccess() {
  const { isOwner, canEdit } = useWorkspace();
  const access = useShell().modules.find((m) => m.id === "work")?.access;
  const owner = access ? access === "owner" : isOwner;
  const write = access ? ["owner", "editor"].includes(access) : canEdit;
  return { owner, write, remove: owner };
}

/** The project's workflow and members, for labels and pickers. */
export function useWorkLists() {
  const { project } = useWorkspace();
  const settings = useResource<{ settings: WorkSettings; version: number }>(workPath(project.id, "/settings"));
  const membersResource = useResource<{ items: Member[] }>(workPath(project.id, "/members"));
  // Stable while the settings are unchanged, so effects may depend on it.
  const statuses = useMemo(
    () => [...(settings.data?.settings.workflow.statuses ?? [])].sort((a, b) => a.order - b.order),
    [settings.data],
  );
  const members = useMemo(() => membersResource.data?.items ?? [], [membersResource.data]);
  return {
    settings: settings.data?.settings ?? null,
    version: settings.data?.version ?? 1,
    statuses,
    members,
    refresh: () => {
      settings.refresh();
      membersResource.refresh();
    },
    loading: settings.loading || membersResource.loading,
    error: settings.error ?? membersResource.error,
  };
}

const CATEGORY_TONE: Record<StatusCategory, "neutral" | "blue" | "warning" | "success" | "danger"> = {
  backlog: "neutral",
  todo: "neutral",
  in_progress: "blue",
  blocked: "danger",
  in_review: "warning",
  done: "success",
  canceled: "neutral",
};
const PRIORITY_TONE: Record<Priority, "neutral" | "warning" | "danger"> = {
  urgent: "danger",
  high: "warning",
  medium: "neutral",
  low: "neutral",
  none: "neutral",
};

/** A status as the project names it, toned by its category. */
export function StatusBadge({
  status,
  category,
  statuses,
}: {
  status: string;
  category: StatusCategory;
  statuses: WorkSettings["workflow"]["statuses"];
}) {
  const { locale } = useWorkspace();
  const named = statuses.find((s) => s.key === status);
  return <Badge tone={CATEGORY_TONE[category]}>{named?.label[locale] ?? workText(locale).category[category]}</Badge>;
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  const { locale } = useWorkspace();
  if (priority === "none") return null;
  return <Badge tone={PRIORITY_TONE[priority]}>{workText(locale).priority[priority]}</Badge>;
}

/** A member's name, "Unassigned" or "Former member". */
export function memberName(members: Member[], userId: string | null, locale: "en" | "de", agentKey?: string | null) {
  const t = workText(locale);
  if (agentKey) return `${t.agent}: ${agentKey}`;
  if (!userId) return t.unassigned;
  return members.find((m) => m.userId === userId)?.name ?? t.former;
}

/** One task as a list row or link; opens the task's detail. */
export function TaskRow({
  task,
  statuses,
  members,
  selected,
  onOpen,
}: {
  task: TaskItem;
  statuses: WorkSettings["workflow"]["statuses"];
  members: Member[];
  selected?: boolean;
  onOpen?: (id: string) => void;
}) {
  const { locale } = useWorkspace();
  const shell = useShell();
  const t = workText(locale);
  const late = overdue(task);
  const body = (
    <>
      <span className="support-row-title">
        #{task.number} {task.title}
      </span>
      <span className="support-row-meta">
        {memberName(members, task.assigneeUserId, locale, task.assigneeAgentKey)}
        {" · "}
        <span data-tone={late ? "critical" : undefined}>
          {t.fields.dueDate} {day(task.dueDate, locale)}
        </span>
        {task.counts && task.counts.subtasks > 0 && ` · ${task.counts.subtasksDone}/${task.counts.subtasks} ${t.subtasks}`}
        {task.counts && task.counts.checklist > 0 && ` · ☑ ${task.counts.checklistDone}/${task.counts.checklist}`}
      </span>
      <span className="support-row-badges">
        <StatusBadge status={task.status} category={task.statusCategory} statuses={statuses} />
        <PriorityBadge priority={task.priority} />
        {late && <Badge tone="danger">{t.metrics.overdue}</Badge>}
        {task.counts && task.counts.blockedBy > 0 && (
          <Badge tone="warning">
            {t.waitsFor} {task.counts.blockedBy}
          </Badge>
        )}
        {task.labels.map((label) => (
          <Badge key={label}>{label}</Badge>
        ))}
      </span>
    </>
  );
  return (
    <li>
      {onOpen ? (
        <button
          type="button"
          className={selected ? "support-row support-row-active" : "support-row"}
          aria-current={selected ? "true" : undefined}
          onClick={() => onOpen(task.id)}
        >
          {body}
        </button>
      ) : (
        <AppLink className="support-row" href={`${shell.hrefOf("work-tasks")}?task=${encodeURIComponent(task.id)}`}>
          {body}
        </AppLink>
      )}
    </li>
  );
}

/** A bar of the share of finished tasks, with the number for screen readers. */
export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="work-progress" role="img" aria-label={`${label}: ${percent}%`}>
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

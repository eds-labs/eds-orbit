import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  notifyMembers,
  type UserNotificationKind,
} from "../../platform/notifications/members.ts";
import { taskPath } from "./common.ts";

const label = (en: string, de: string) => ({ en, de });

/** Member notification kinds of the module (plan §4.6). */
export const workUserNotifications: Readonly<
  Record<string, UserNotificationKind>
> = {
  work_task_assigned: {
    label: label("Task assigned to me", "Aufgabe mir zugewiesen"),
    emailDefault: true,
  },
  work_task_mentioned: {
    label: label("Mentioned in a task", "In einer Aufgabe erwähnt"),
    emailDefault: true,
  },
  work_task_due: {
    label: label("My task is due or overdue", "Meine Aufgabe ist fällig oder überfällig"),
    emailDefault: false,
  },
  work_task_watched: {
    label: label("A task I watch changed", "Eine beobachtete Aufgabe hat sich geändert"),
    emailDefault: false,
  },
  // AI project manager (ADR 0017).
  work_pm_plan_ready: {
    label: label("A plan I asked for is ready", "Ein angeforderter Plan ist fertig"),
    emailDefault: false,
  },
  work_pm_escalation: {
    label: label("Critical finding in an initiative I lead", "Kritischer Befund in einem meiner Vorhaben"),
    emailDefault: true,
  },
};

type TaskRef = { id: string; number: number; title: string };

/** Notifies members about a task; never the member who caused it. */
export async function notifyTask(
  tx: DbTx,
  scope: Scope,
  kind: keyof typeof workUserNotifications,
  task: TaskRef,
  userIds: readonly (string | null | undefined)[],
  body = "",
) {
  const to = [...new Set(userIds.filter((u): u is string => !!u))].filter(
    (u) => u !== scope.userId,
  );
  if (!to.length) return;
  await notifyMembers(tx, scope, {
    kind,
    userIds: to,
    title: `#${task.number} · ${task.title}`.slice(0, 200),
    body,
    link: taskPath(scope.projectId, task.id),
  });
}

/** The watchers of a task, for change notices. */
export async function watcherIds(tx: DbTx, scope: Scope, taskId: string) {
  const rows = await tx.workTaskWatcher.findMany({
    where: { projectId: scope.projectId, taskId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

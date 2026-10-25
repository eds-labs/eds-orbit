import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  readModuleSettings,
  writeModuleSettings,
} from "../../platform/modules/settings.ts";
import { DomainError } from "../../shared.ts";
import { workDomainEvent, workEvent, type WorkActor } from "./common.ts";

/**
 * The fixed status categories (ADR 0016 D-5). Statuses are configurable
 * keys mapped to one category; progress, overdue checks and automation read
 * categories only.
 */
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
/** Categories whose tasks count as finished. */
export const CLOSED_CATEGORIES: readonly StatusCategory[] = ["done", "canceled"];

/** The colours a task category can have; the web maps each to a token. */
export const CATEGORY_COLORS = [
  "gray",
  "blue",
  "green",
  "yellow",
  "orange",
  "red",
  "purple",
  "pink",
] as const;

const key = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
const label = z
  .object({
    en: z.string().trim().min(1).max(40),
    de: z.string().trim().min(1).max(40),
  })
  .strict();

const unique = <T extends { key: string }>(items: T[]) =>
  new Set(items.map((i) => i.key)).size === items.length;

export const workStatusSchema = z
  .object({ key, label, category: z.enum(STATUS_CATEGORIES), order: z.int().min(0).max(1000) })
  .strict();

export const workSettingsSchema = z
  .object({
    workflow: z
      .object({
        statuses: z
          .array(workStatusSchema)
          .min(2)
          .max(30)
          .refine(unique, "status keys must be unique")
          .refine(
            (s) => s.some((x) => x.category === "done") && s.some((x) => x.category === "canceled"),
            "a done and a canceled status are required",
          ),
        /** Allowed next statuses by status; absent: any change is allowed. */
        transitions: z.record(key, z.array(key).max(30)).optional(),
      })
      .strict()
      .refine(
        (w) =>
          !w.transitions ||
          Object.entries(w.transitions).every(
            ([from, to]) =>
              w.statuses.some((s) => s.key === from) &&
              to.every((t) => w.statuses.some((s) => s.key === t)),
          ),
        "transitions may name known statuses only",
      ),
    categories: z
      .array(
        z
          .object({
            key,
            label: z.string().trim().min(1).max(60),
            color: z.enum(CATEGORY_COLORS),
          })
          .strict(),
      )
      .max(50)
      .refine(unique, "category keys must be unique"),
    teams: z
      .array(
        z
          .object({
            key,
            name: z.string().trim().min(1).max(60),
            memberUserIds: z.array(z.string().min(1).max(100)).max(100),
          })
          .strict(),
      )
      .max(30)
      .refine(unique, "team keys must be unique"),
    /** A board column warns above this many tasks, by status key. */
    wipLimits: z.record(key, z.int().min(1).max(500)).default({}),
    notifications: z
      .object({ dueSoonDays: z.int().min(0).max(14) })
      .strict(),
  })
  .strict();
export type WorkSettings = z.infer<typeof workSettingsSchema>;

const status = (
  k: string,
  en: string,
  de: string,
  category: StatusCategory,
  order: number,
) => ({ key: k, label: { en, de }, category, order });

/** One status per category; owners rename, add and reorder them. */
export const defaultWorkSettings = (): WorkSettings => ({
  workflow: {
    statuses: [
      status("backlog", "Backlog", "Backlog", "backlog", 0),
      status("todo", "To do", "Zu erledigen", "todo", 10),
      status("in_progress", "In progress", "In Arbeit", "in_progress", 20),
      status("blocked", "Blocked", "Blockiert", "blocked", 30),
      status("in_review", "In review", "In Prüfung", "in_review", 40),
      status("done", "Done", "Erledigt", "done", 50),
      status("canceled", "Canceled", "Abgebrochen", "canceled", 60),
    ],
  },
  categories: [],
  teams: [],
  wipLimits: {},
  notifications: { dueSoonDays: 2 },
});

export function readWorkSettings(tx: DbTx, scope: Scope) {
  return readModuleSettings(tx, scope, "work", workSettingsSchema, defaultWorkSettings);
}

/** The status of a key, or undefined. */
export const statusOf = (settings: WorkSettings, k: string) =>
  settings.workflow.statuses.find((s) => s.key === k);

/** The first status of a category, by order: where new tasks of that category land. */
export function firstStatus(settings: WorkSettings, category: StatusCategory) {
  return [...settings.workflow.statuses]
    .filter((s) => s.category === category)
    .sort((a, b) => a.order - b.order)[0];
}

/**
 * Saves the settings when `version` is the stored one. A status that tasks
 * still use cannot be removed, team members must be members of the module,
 * and a status moved to another category takes its tasks along.
 */
export async function saveWorkSettings(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  version: number,
  members: ReadonlySet<string>,
  actor: WorkActor,
) {
  const next = workSettingsSchema.parse(raw);
  const current = (await readWorkSettings(tx, scope)).settings;
  const keys = new Set(next.workflow.statuses.map((s) => s.key));
  const removed = current.workflow.statuses.filter((s) => !keys.has(s.key));
  if (removed.length) {
    const used = await tx.workTask.count({
      where: { projectId: scope.projectId, status: { in: removed.map((s) => s.key) } },
    });
    if (used) throw new DomainError("WORK_STATUS_IN_USE", 409);
  }
  for (const team of next.teams)
    if (team.memberUserIds.some((u) => !members.has(u)))
      throw new DomainError("WORK_TEAM_MEMBER_INVALID", 422);
  const saved = await writeModuleSettings(tx, scope, "work", workSettingsSchema, next, version);
  // A status moved to another category takes its tasks along, each with
  // its history row, completion time and status event.
  const now = new Date();
  for (const status of next.workflow.statuses) {
    const before = statusOf(current, status.key);
    if (!before || before.category === status.category) continue;
    const tasks = await tx.workTask.findMany({
      where: { projectId: scope.projectId, status: status.key },
      select: { id: true, number: true, completedAt: true },
    });
    for (const task of tasks) {
      await tx.workTask.update({
        where: { id: task.id },
        data: {
          statusCategory: status.category,
          completedAt: status.category === "done" ? (task.completedAt ?? now) : null,
          version: { increment: 1 },
        },
      });
      await workEvent(tx, scope, { taskId: task.id }, "status", actor, { statusCategory: before.category }, { statusCategory: status.category }, now);
      await workDomainEvent(tx, scope, "work.task.status_changed", { type: "work.task", id: task.id }, actor, {
        number: task.number,
        from: status.key,
        to: status.key,
        fromCategory: before.category,
        toCategory: status.category,
      });
    }
  }
  return saved;
}

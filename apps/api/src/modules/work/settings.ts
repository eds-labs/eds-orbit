import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { readModuleSettings } from "../../platform/modules/settings.ts";

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

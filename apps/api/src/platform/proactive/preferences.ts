import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, create, data, DomainError, list, update } from "../shared.ts";
import { findPersonalSpace } from "../assistant/personal-space.ts";
import { isTimeZone, localOf, resolveLocalTime } from "../time/zoned-time.ts";
import type { SignalSeverity } from "../signals/types.ts";

// User-level delivery preferences (ADR 0023 item 5): a user-private entity
// `notification_preferences` in the user's personal space, so no migration
// and no project-less table. Quiet hours and the digest time are in the
// user's own time zone; e-mail and Telegram each have a mode per severity.
// A per-project switch that turns a kind off still wins: these settings
// only decide when and where a notice that is sent anyway is delivered.
// The scheduler's marks (last digest, last briefing) live in a separate
// entity `proactive_state`, so a save never races the scheduler.

export const NOTIFICATION_PREFERENCES_KIND = "notification_preferences";
export const PROACTIVE_STATE_KIND = "proactive_state";

/** Off unless ORBIT_PROACTIVE is "true": signals, digests, briefings, per-user Telegram. */
export const proactiveEnabled = () => process.env.ORBIT_PROACTIVE === "true";

const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const localTime = z.string().regex(LOCAL_TIME);
export const deliveryMode = z.enum(["immediate", "digest", "off"]);
export type DeliveryMode = z.infer<typeof deliveryMode>;
const perSeverity = z.strictObject({
  info: deliveryMode,
  attention: deliveryMode,
  urgent: deliveryMode,
});
export const briefingSections = z.strictObject({
  approvals: z.boolean(),
  agentWork: z.boolean(),
  urgentTickets: z.boolean(),
  dueTasks: z.boolean(),
  budget: z.boolean(),
});

export const preferencesSchema = z.strictObject({
  timeZone: z.string().max(64).refine(isTimeZone, "unknown time zone"),
  notifications: z.strictObject({ email: perSeverity, telegram: perSeverity }),
  quietHours: z.strictObject({
    enabled: z.boolean(),
    start: localTime,
    end: localTime,
    /** Urgent notices still go out during quiet hours (off by default). */
    urgentBreaks: z.boolean(),
  }),
  digest: z.strictObject({ time: localTime }),
  briefing: z.strictObject({
    enabled: z.boolean(),
    rhythm: z.enum(["daily", "weekdays"]),
    time: localTime,
    /** null: every business project the user can reach. */
    projectIds: z.array(z.uuid()).max(50).nullable(),
    sections: briefingSections,
    /** No notice when nothing is to report (else "nothing new"). */
    skipEmpty: z.boolean(),
    /** Also by e-mail through the system sender (titles, counts, links). */
    email: z.boolean(),
    /** The opt-in AI summary (2 model calls, USD 0.05, within the user's cap). */
    aiSummary: z.boolean(),
  }),
});
export type Preferences = z.infer<typeof preferencesSchema>;

/**
 * Defaults keep today's behaviour: e-mail as the per-kind choice says,
 * immediately; Telegram for attention and urgent notices once linked; no
 * quiet hours; briefings off.
 */
export const DEFAULT_PREFERENCES: Preferences = {
  timeZone: "UTC",
  notifications: {
    email: { info: "immediate", attention: "immediate", urgent: "immediate" },
    telegram: { info: "off", attention: "immediate", urgent: "immediate" },
  },
  quietHours: { enabled: false, start: "22:00", end: "07:00", urgentBreaks: false },
  digest: { time: "08:00" },
  briefing: {
    enabled: false,
    rhythm: "daily",
    time: "08:00",
    projectIds: null,
    sections: { approvals: true, agentWork: true, urgentTickets: true, dueTasks: true, budget: true },
    skipEmpty: true,
    email: false,
    aiSummary: false,
  },
};

/** A save: any section, with the version read (optimistic locking). */
export const preferencesPatch = z.strictObject({
  version: z.number().int().min(0),
  timeZone: preferencesSchema.shape.timeZone.optional(),
  notifications: preferencesSchema.shape.notifications.optional(),
  quietHours: preferencesSchema.shape.quietHours.optional(),
  digest: preferencesSchema.shape.digest.optional(),
  briefing: preferencesSchema.shape.briefing.optional(),
});

/** Stored values over the defaults; an unreadable section falls back to its default. */
export function normalizePreferences(value: unknown): Preferences {
  const stored = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_PREFERENCES } as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]) {
    const parsed = preferencesSchema.shape[key].safeParse(stored[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as Preferences;
}

async function requirePersonal(tx: DbTx, scope: Scope) {
  const project = await tx.project.findFirst({
    where: { id: scope.projectId, workspaceId: scope.workspaceId },
    select: { kind: true, personalUserId: true },
  });
  if (project?.kind !== "personal" || project.personalUserId !== scope.userId)
    throw new DomainError("NOT_FOUND", 404);
}

/** The user's preferences in their personal space, with the version to save against (0: none). */
export async function readPreferences(tx: DbTx, scope: Scope) {
  const row = (await list(tx, scope, NOTIFICATION_PREFERENCES_KIND))[0];
  return { preferences: normalizePreferences(data(row)), version: row?.version ?? 0 };
}

/** Saves sections of the user's preferences; VERSION_CONFLICT on a stale version. */
export async function savePreferences(tx: DbTx, scope: Scope, raw: unknown) {
  await requirePersonal(tx, scope);
  const input = preferencesPatch.parse(raw);
  const row = (await list(tx, scope, NOTIFICATION_PREFERENCES_KIND))[0];
  if ((row?.version ?? 0) !== input.version) throw new DomainError("VERSION_CONFLICT", 409);
  const { version: _version, ...sections } = input;
  const next = { ...normalizePreferences(data(row)), ...sections };
  const saved = row
    ? await update(tx, scope, row, next)
    : await create(tx, scope, NOTIFICATION_PREFERENCES_KIND, next);
  // Content-free: which sections changed, never their values.
  await audit(tx, scope, "assistant.preferences_changed", scope.projectId, {
    sections: Object.keys(sections).sort(),
  });
  return { preferences: normalizePreferences(saved.data), version: saved.version };
}

export type ProactiveState = {
  /** Digest window start: notices routed to the digest since then. */
  lastDigestAt?: string;
  /** The last digest slot queued (ISO). */
  digestSlot?: string;
  /** The last briefing slot queued (ISO); "" after briefings were switched off. */
  briefingSlot?: string;
  /** The dedicated "Briefings" conversation (T4-1). */
  briefingConversationId?: string;
};

export async function readState(tx: DbTx, scope: Pick<Scope, "workspaceId" | "projectId">) {
  const row = (await list(tx, scope as Scope, PROACTIVE_STATE_KIND))[0];
  return { row: row ?? null, state: data(row) as ProactiveState };
}

export async function writeState(
  tx: DbTx,
  scope: Scope,
  patch: ProactiveState,
) {
  const { row, state } = await readState(tx, scope);
  const next = { ...state, ...patch };
  if (row) await update(tx, scope, row, next);
  else await create(tx, scope, PROACTIVE_STATE_KIND, next);
  return next;
}

// --- Time ------------------------------------------------------------------

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Whether `at` lies in the user's quiet hours (local time, overnight spans allowed). */
export function inQuietHours(prefs: Preferences, at: Date) {
  const q = prefs.quietHours;
  if (!q.enabled || q.start === q.end) return false;
  const now = minutes(localOf(at, prefs.timeZone).slice(11, 16));
  const start = minutes(q.start);
  const end = minutes(q.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export type Channel = "email" | "telegram";

/**
 * Where a notice of `severity`, created at `at`, goes on a channel: the
 * user's mode, with quiet hours turning `immediate` into `digest` unless
 * the user lets urgent notices break them.
 */
export function routeOf(
  prefs: Preferences,
  channel: Channel,
  severity: SignalSeverity,
  at: Date,
): DeliveryMode {
  const mode = prefs.notifications[channel][severity];
  if (mode !== "immediate") return mode;
  if (!inQuietHours(prefs, at)) return "immediate";
  return severity === "urgent" && prefs.quietHours.urgentBreaks ? "immediate" : "digest";
}

const DAY = 86_400_000;

/** The instant a local date and time names (the first minute after a gap, the earlier of two). */
function instantOf(date: string, time: string, timeZone: string) {
  const r = resolveLocalTime(`${date}T${time}`, timeZone);
  return r.kind === "exact" ? r.at : r.kind === "gap" ? r.suggestedAt : r.earlier;
}

function weekday(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/** Local dates around `at` in the zone, oldest first. */
function datesAround(at: Date, timeZone: string, before: number, after: number) {
  const out: string[] = [];
  for (let i = -before; i <= after; i++)
    out.push(localOf(new Date(at.getTime() + i * DAY), timeZone).slice(0, 10));
  return [...new Set(out)];
}

/**
 * The slots of a daily (or weekday) local time: the latest at or before
 * `at`, and the first after it. Across daylight-saving changes the local
 * time keeps its wall-clock meaning.
 */
export function slotsAround(
  at: Date,
  time: string,
  timeZone: string,
  rhythm: "daily" | "weekdays" = "daily",
) {
  const allowed = (date: string) =>
    rhythm === "daily" || (weekday(date) >= 1 && weekday(date) <= 5);
  const instants = datesAround(at, timeZone, 4, 8)
    .filter(allowed)
    .map((date) => instantOf(date, time, timeZone))
    .sort((a, b) => a.getTime() - b.getTime());
  const previous = [...instants].reverse().find((t) => t.getTime() <= at.getTime()) ?? null;
  const next = instants.find((t) => t.getTime() > at.getTime()) ?? null;
  return { previous, next };
}

// --- Reading a user's preferences from another project -----------------------

/**
 * The user's preferences and personal space, read in the personal space's
 * own transaction (never inside another project's). Defaults without a
 * personal space; the scope is null then.
 */
export async function userPreferences(workspaceId: string, userId: string) {
  const space = await findPersonalSpace(workspaceId, userId);
  if (!space) return { personal: null, preferences: DEFAULT_PREFERENCES, state: {} as ProactiveState };
  const personal: Scope = { workspaceId, projectId: space.id, userId, role: "owner" };
  return scoped(workspaceId, space.id, async (tx) => ({
    personal,
    preferences: (await readPreferences(tx, personal)).preferences,
    state: (await readState(tx, personal)).state,
  }));
}

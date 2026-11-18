import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import { audit, create, data, hash, list, update } from "../../../shared.ts";
import { preflight } from "../policy/policy.ts";
import { notify, OWNER_CAUSED } from "../agents/notifications.ts";
import { channelNames } from "../agents/assignment-overview.ts";
import { READINESS_BLOCKERS } from "../readiness/blocker-catalog.ts";
import { registeredUserNotification } from "../../../platform/modules/contributions.ts";
import { notifyMembers } from "../../../platform/notifications/members.ts";
import { resolveRecipients } from "../../../platform/signals/deliver.ts";
import { inProject } from "../../../platform/management/links.ts";

/** Installation flag of the released-post watch (default off). */
export const releasedPostWatchEnabled = () =>
  loadConfig().ORBIT_RELEASED_POST_WATCH === "true";

/** Posts further out than this are not evaluated yet. */
export const WATCH_HORIZON_MS = 48 * 3600000;
/** At most this many posts are evaluated per project and run. */
export const WATCH_CAP = 20;

export type WatchCandidate = {
  id: string;
  slotAt: Date;
  data: Record<string, any>;
};

/**
 * Released posts that still wait for their slot: real (not test) publications
 * that are intended or blocked by a dependency (and not stopped by the owner),
 * with a future slot inside the horizon, soonest first. Read-only.
 * A null horizon or cap means unlimited.
 */
export async function watchCandidates(
  tx: DbTx,
  scope: Scope,
  now: Date,
  opts: { horizonMs?: number | null; cap?: number | null } = {},
): Promise<WatchCandidate[]> {
  const horizonMs =
    opts.horizonMs === undefined ? WATCH_HORIZON_MS : opts.horizonMs;
  const cap = opts.cap === undefined ? WATCH_CAP : opts.cap;
  const found: WatchCandidate[] = [];
  for (const row of await list(tx, scope, "publications")) {
    const d = data(row);
    if (d.test === true) continue;
    if (
      d.status !== "intent_created" &&
      !(d.status === "blocked_dependency" && !d.vetoedAt)
    )
      continue;
    const slotAt = new Date(d.scheduledAt);
    if (!Number.isFinite(slotAt.valueOf()) || slotAt <= now) continue;
    if (horizonMs !== null && slotAt.valueOf() - now.valueOf() > horizonMs)
      continue;
    found.push({ id: row.id, slotAt, data: d });
  }
  found.sort((a, b) => a.slotAt.valueOf() - b.slotAt.valueOf());
  return cap === null ? found : found.slice(0, cap);
}

/**
 * Why a released post would be refused at its slot: sorted unique blocker
 * codes, empty when it would be published. Evaluates the post as it stands
 * once its veto window has ended. Causes the owner made himself (a stop, a
 * pause) are not reported. Read-only.
 */
export async function postRisk(
  tx: DbTx,
  scope: Scope,
  c: WatchCandidate,
): Promise<string[]> {
  const d = c.data;
  const codes = new Set<string>();
  if (d.status === "blocked_dependency") {
    for (const code of [
      d.reason,
      ...(Array.isArray(d.blockers) ? d.blockers : []),
    ])
      if (typeof code === "string") codes.add(code);
  } else {
    const checked = await preflight(tx, scope, d.contentId, {
      test: false,
      at: c.slotAt,
      ignoreApproval: true,
      approvalPublicationId: c.id,
      ...(d.vetoDeadline && d.assignmentRunId
        ? {
            veto: {
              deadline: d.vetoDeadline,
              vetoedAt: null,
              assignmentRunId: d.assignmentRunId,
              // Evaluate the post as it stands once the window has ended.
              handoff: false,
            },
          }
        : {}),
    });
    for (const code of checked.blockers) codes.add(code);
    // The claim refuses a changed package as well (workflow.ts claimPublication).
    if (checked.packageHash !== d.packageHash) codes.add("PACKAGE_CHANGED");
  }
  return [...codes].filter((code) => !OWNER_CAUSED.includes(code)).sort();
}

/** The watch's memory of one released post (kind `publication_watch`); never publishing authority. */
export type WatchState = {
  publicationId: string;
  slotAt: string;
  /** Codes found by the latest pass. */
  codes: string[];
  /** Codes the owners were last warned about; empty when nothing is open. */
  notifiedCodes: string[];
  firstSeenAt: string | null;
  clearedAt: string | null;
  /** The notice (ref) that last reported a change of this post. */
  lastNoticeRef?: string | null;
};

const REASONS: Record<string, { de: string; en: string }> = {
  LIVE_RAG_EVAL_REQUIRED: {
    de: "Der Wissensindex ist nicht geprüft oder nicht mehr gültig",
    en: "The knowledge index is not evaluated or no longer valid",
  },
  CONTENT_CHANGED: {
    de: "Der Inhalt wurde nach der Freigabe geändert",
    en: "The content changed after release",
  },
  PACKAGE_CHANGED: {
    de: "Das Inhaltspaket hat sich geändert",
    en: "The content package changed",
  },
  fact_changed: {
    de: "Eine verwendete Aussage hat sich geändert",
    en: "A fact used in the post changed",
  },
  SLOT_EXPIRED: {
    de: "Der Termin ist abgelaufen",
    en: "The slot has passed",
  },
  AI_LABEL_MISSING: {
    de: "Das KI-Bild trägt keine Kennzeichnung „KI erstellt“",
    en: "The AI image carries no “AI generated” label",
  },
};

/** What a blocker code means for the owner, in plain words. */
export function atRiskReason(code: string, language: "de" | "en"): string {
  const known = REASONS[code];
  if (known) return known[language];
  const entry = READINESS_BLOCKERS[code];
  return entry ? `${entry.cause} ${entry.fix}` : code;
}

const PASS_MS = 15 * 60000;
const NOTICE_BODY_MAX = 2000;
const key = (codes: string[]) => [...codes].sort().join(",");
const clip = (text: string, max: number) =>
  text.length > max ? text.slice(0, max - 1) + "…" : text;

/** A short name for a post: its title or topic; never any of its text. */
export function postTitle(content: Record<string, any>): string {
  const named = content.title ?? content.topic;
  return typeof named === "string" && named.trim() ? clip(named.trim(), 60) : "Post";
}

const localSlot = (at: Date, timezone: string, language: "de" | "en") =>
  new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);

type Pending = {
  c: WatchCandidate;
  row: { id: string; version: number } | null;
  prev: WatchState | null;
  codes: string[];
  kind: "changed" | "cleared";
};

/**
 * One pass over the project's released posts: finds those that would be
 * refused at their slot, warns the owners once per change (member notice and
 * Telegram), and says so when the cause is gone. Changes nothing about the
 * posts themselves. With the flag off it does nothing.
 */
export async function runReleasedPostWatch(
  scope: Scope,
): Promise<{ status?: string; wakeAt?: Date } | void> {
  if (!releasedPostWatchEnabled()) return;
  const now = new Date();
  const found = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const candidates = await watchCandidates(tx, scope, now);
    const states = new Map<string, { id: string; version: number; d: WatchState }>();
    for (const row of await list(tx, scope, "publication_watch")) {
      const d = data(row) as WatchState;
      states.set(d.publicationId, { id: row.id, version: row.version, d });
    }
    return { candidates, states };
  });
  if (!found.candidates.length) return;
  const { states } = found;
  const pending: Pending[] = [];
  const bookkeeping: Array<{ row: { id: string; version: number }; next: WatchState }> = [];
  for (const c of found.candidates) {
    let codes: string[];
    try {
      // Each post is evaluated in its own transaction: a database error in one
      // cannot abort the others.
      codes = await scoped(scope.workspaceId, scope.projectId, (tx) =>
        postRisk(tx, scope, c),
      );
    } catch (error) {
      console.warn(
        `released-post-watch: check of publication ${c.id} failed (${error instanceof Error ? error.name : "error"})`,
      );
      continue;
    }
    const known = states.get(c.id);
    const notified = known?.d.notifiedCodes ?? [];
    if (codes.length && key(codes) !== key(notified))
      pending.push({ c, row: known ?? null, prev: known?.d ?? null, codes, kind: "changed" });
    else if (!codes.length && notified.length && !known?.d.clearedAt)
      pending.push({ c, row: known ?? null, prev: known?.d ?? null, codes, kind: "cleared" });
    else if (known && key(known.d.codes) !== key(codes))
      // Quiet bookkeeping (a code that went away, nothing to tell).
      bookkeeping.push({ row: known, next: { ...known.d, codes, slotAt: c.slotAt.toISOString() } });
  }
  if (!pending.length && !bookkeeping.length) return;
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    for (const b of bookkeeping) await update(tx, scope, b.row, b.next);
    if (!pending.length) return;

    const stamp = now.toISOString();
    const refOf = (kind: Pending["kind"]) => {
      const group = pending
        .filter((p) => p.kind === kind)
        .sort((a, b) => a.c.id.localeCompare(b.c.id));
      return group.length
        ? // The pass time makes the ref specific to this episode: job keys are permanent.
          `${hash(group.map((p) => p.c.id)).slice(0, 12)}:${hash([stamp, ...group.map((p) => key(p.codes))]).slice(0, 12)}`
        : null;
    };
    const refs = { changed: refOf("changed"), cleared: refOf("cleared") };
    for (const p of pending) {
      const next: WatchState =
        p.kind === "changed"
          ? {
              publicationId: p.c.id,
              slotAt: p.c.slotAt.toISOString(),
              codes: p.codes,
              notifiedCodes: p.codes,
              firstSeenAt: p.prev?.notifiedCodes.length ? (p.prev.firstSeenAt ?? stamp) : stamp,
              clearedAt: null,
              lastNoticeRef: refs.changed,
            }
          : {
              publicationId: p.c.id,
              slotAt: p.c.slotAt.toISOString(),
              codes: [],
              notifiedCodes: [],
              firstSeenAt: p.prev?.firstSeenAt ?? null,
              clearedAt: stamp,
              lastNoticeRef: refs.cleared,
            };
      if (p.row) await update(tx, scope, p.row, next);
      else await create(tx, scope, "publication_watch", next);
      if (p.kind === "changed")
        await audit(tx, scope, "publication.at_risk", p.c.id, {
          codes: p.codes,
          assignmentId: p.c.data.assignmentId ?? null,
          assignmentRunId: p.c.data.assignmentRunId ?? null,
        });
    }

    const owners = await resolveRecipients(scope, { roles: ["owner"] }, "marketing");
    const project = await tx.project.findFirstOrThrow({
      where: { id: scope.projectId },
      select: { language: true, timezone: true },
    });
    const language = project.language === "de" ? "de" : "en";
    const channels = await channelNames(tx, scope);
    const kinds = {
      changed: "marketing_post_at_risk",
      cleared: "marketing_post_at_risk_cleared",
    } as const;
    for (const kind of ["changed", "cleared"] as const) {
      const group = pending.filter((p) => p.kind === kind);
      if (!group.length) continue;
      if (owners.length) {
        const room = Math.floor((NOTICE_BODY_MAX - group.length) / group.length);
        const lines: string[] = [];
        for (const p of group) {
          const content = data(
            await tx.entity.findFirst({
              where: { id: p.c.data.contentId, projectId: scope.projectId, kind: "content" },
            }),
          );
          const head = `${postTitle(content)} · ${localSlot(p.c.slotAt, project.timezone, language)} · ${channels.get(String(p.c.data.channel)) ?? p.c.data.channel}`;
          const reasons = p.codes.map((code) => atRiskReason(code, language)).join("; ");
          lines.push(clip(reasons ? `${head}: ${reasons}` : head, room));
        }
        await notifyMembers(tx, scope, {
          kind: kinds[kind],
          userIds: owners.slice(0, 200),
          title: registeredUserNotification(kinds[kind])!.label[language],
          body: lines.join("\n"),
          link: inProject(scope.projectId, "/marketing/approvals"),
        });
      }
      await notify(tx, scope, kind === "changed" ? "at_risk" : "at_risk_cleared", refs[kind]!);
    }
  });
}

/**
 * When the watch next has something to look at: a quarter of an hour from
 * now, or at the next candidate's slot if that is sooner; null when no
 * released post waits inside the horizon.
 */
export async function nextReleasedPostWatchAt(
  tx: DbTx,
  scope: Scope,
): Promise<Date | null> {
  if (!releasedPostWatchEnabled()) return null;
  const now = new Date();
  const [first] = await watchCandidates(tx, scope, now, { cap: 1 });
  if (!first) return null;
  return new Date(Math.min(now.valueOf() + PASS_MS, first.slotAt.valueOf()));
}

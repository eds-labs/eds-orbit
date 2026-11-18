import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import { data, list } from "../../../shared.ts";
import { preflight } from "../policy/policy.ts";
import { OWNER_CAUSED } from "../agents/notifications.ts";

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

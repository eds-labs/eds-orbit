import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { registeredSchedulers } from "../modules/contributions.ts";

/**
 * The per-project sweep (WP1.6): nothing runs for a paused project; else
 * every registered scheduler contribution runs in the sweep transaction.
 */
export async function sweepProject(tx: DbTx, scope: Scope, at = new Date()) {
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  if (project.paused) return { queued: 0 };
  let queued = 0;
  for (const scheduler of registeredSchedulers())
    queued += (await scheduler.sweep(tx, scope, at)).queued;
  return { queued };
}
/**
 * Earliest future time at which sweepProject can change state without any new write.
 * Writes wake a project through database triggers; this covers purely time-based transitions.
 */
export async function nextSweepAt(tx: DbTx, scope: Scope, at = new Date()) {
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  if (project.paused) return null;
  let next: Date | null = null;
  for (const scheduler of registeredSchedulers()) {
    const due = await scheduler.nextDueAt(tx, scope, at);
    if (due && (!next || due < next)) next = due;
  }
  return next;
}

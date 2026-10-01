/**
 * Work-due marker transitions of one pump pass. All writes use the auth
 * client, which may update any project's marker; triggers on Entity, Outbox
 * and Project move the marker earlier when business data changes.
 *
 * A trigger only moves a marker that lies later than the new work. A pass
 * therefore first moves the marker to a short lease in the future: every
 * write committed after the claim, including the pass's own, moves it back
 * and the release no longer matches, so the project stays due. Writes
 * committed before the claim are visible to the pass, which starts after it.
 */
import type { PrismaClient } from "../../../packages/db/src/index.ts";

type MarkerDb = Pick<PrismaClient, "project">;

/** Claims a due project until `leaseUntil`; null when it is no longer due. */
export async function claimProject(
  db: MarkerDb,
  projectId: string,
  leaseUntil: Date,
): Promise<Date | null> {
  const { count } = await db.project.updateMany({
    where: { id: projectId, workDueAt: { lte: new Date() } },
    data: { workDueAt: leaseUntil },
  });
  return count ? leaseUntil : null;
}

/** Ends a pass: sets the next due time unless a write moved the marker since the claim. */
export async function releaseProject(
  db: MarkerDb,
  projectId: string,
  claimed: Date,
  next: Date,
) {
  await db.project.updateMany({
    where: { id: projectId, workDueAt: claimed },
    data: { workDueAt: next },
  });
}

/**
 * After a failed pass, retries the project at `retryAt` instead of waiting
 * for the lease. Without a claim, only a due marker is deferred.
 */
export async function deferAfterFailure(
  db: MarkerDb,
  projectId: string,
  retryAt: Date,
  claimed: Date | null,
) {
  await db.project.updateMany({
    where: { id: projectId, workDueAt: { lte: claimed ?? new Date() } },
    data: { workDueAt: retryAt },
  });
}

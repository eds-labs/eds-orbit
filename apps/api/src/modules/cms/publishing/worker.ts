import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { enqueue } from "../../../platform/jobs/enqueue.ts";
import type { JobDef, PeriodicTask } from "../../../platform/jobs/types.ts";
import { lockEntry } from "../entries/common.ts";
import { cmsActive } from "../gate.ts";
import { readCmsSettings } from "../settings.ts";
import { CMS_PUBLISH_QUEUE, goLive, markLate } from "./publications.ts";

// Scheduled publications on the Orbit worker (ADR 0029 §2.3, CH1.10). A job
// per entry and approval becomes due at the scheduled time and switches the
// live pointer for the entry's due publications. While the module is off the
// publications stay queued; a paused project blocks the job and resuming
// queues it again. More than `lateWindowHours` late (default 24), a
// publication waits for a person instead of appearing at a surprising time.

/** A due publication still queued this long after its time lost its job. */
const STUCK_MS = 10 * 60_000;

/** Publishes the entry's due publications; returns what happened. */
export async function publishDue(scope: Scope, entryId: string, now = new Date()) {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    if (!(await cmsActive(tx, scope))) return { status: "skipped", errorCode: "CMS_DISABLED" };
    const entry = await lockEntry(tx, scope, entryId).catch(() => null);
    if (!entry) return { status: "skipped", errorCode: "CMS_ENTRY_NOT_FOUND" };
    const due = await tx.cmsPublication.findMany({
      where: { projectId: scope.projectId, entryId, status: "queued", scheduledAt: { lte: now } },
      orderBy: { scheduledAt: "asc" },
    });
    if (!due.length) return { status: "nothing_due", errorCode: null };
    const { settings } = await readCmsSettings(tx, scope);
    const late = now.getTime() - due[0]!.scheduledAt.getTime() > settings.lateWindowHours * 3_600_000;
    if (late) {
      await markLate(tx, scope, entry, due.map((p) => p.id));
      return { status: "needs_attention", errorCode: "CMS_PUBLICATION_LATE" };
    }
    const issues = await goLive(tx, scope, entry, due.map((p) => p.id));
    return issues.length ? { status: "needs_attention", errorCode: issues[0]!.code } : { status: "succeeded", errorCode: null };
  });
}

export const cmsPublishJob: JobDef = {
  queueClass: CMS_PUBLISH_QUEUE,
  handler: async ({ scope, job }) => {
    const result = await publishDue(scope, String(job.resourceId));
    // A finished job; what needs a person is on the publication itself.
    return { status: "succeeded", errorCode: result.errorCode };
  },
  // A paused project leaves the publications queued; resuming queues them again.
};

/** Queues a job for every entry with due queued publications. */
async function requeueDue(tx: DbTx, scope: Scope, before: Date, tag: string) {
  const rows = await tx.cmsPublication.findMany({
    where: { projectId: scope.projectId, status: "queued", scheduledAt: { lt: before } },
    select: { entryId: true },
    distinct: ["entryId"],
    take: 50,
  });
  for (const { entryId } of rows) await enqueue(tx, scope, CMS_PUBLISH_QUEUE, entryId, `cms-publish:${entryId}:${tag}`);
  return rows.length;
}

/** Due publications whose job was lost (worker outage, failed job) are queued again. */
export const cmsPublicationSweep: PeriodicTask = {
  name: "cms-publication-sweep",
  async nextDueAt(tx, scope) {
    if (!(await cmsActive(tx, scope))) return null;
    const oldest = await tx.cmsPublication.findFirst({
      where: { projectId: scope.projectId, status: "queued" },
      orderBy: { scheduledAt: "asc" },
      select: { scheduledAt: true },
    });
    return oldest ? new Date(oldest.scheduledAt.getTime() + STUCK_MS) : null;
  },
  async run(scope) {
    const queued = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      if (!(await cmsActive(tx, scope))) return 0;
      const now = Date.now();
      return requeueDue(tx, scope, new Date(now - STUCK_MS), `sweep:${Math.floor(now / STUCK_MS)}`);
    });
    return queued ? { status: `requeued ${queued}` } : undefined;
  },
};

/** After a pause: due publications get a job again (the late window still applies). */
export async function resumePublications(tx: DbTx, scope: Scope, generation: number) {
  if (!(await cmsActive(tx, scope))) return;
  await requeueDue(tx, scope, new Date(), `resume:${generation}`);
}

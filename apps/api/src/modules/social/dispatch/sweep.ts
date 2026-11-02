import { scoped } from "../../../../../../packages/db/src/index.ts";
import type { PeriodicTask } from "../../../platform/jobs/types.ts";
import { enqueue } from "../../../platform/jobs/enqueue.ts";
import { socialActive } from "../gate.ts";
import { markOutcomeUnknown } from "./claim.ts";
import { DELIVER } from "./queues.ts";

// A delivery whose worker never finished it (ADR 0020 §7 "Recovery"):
// writing the result failed after the provider call, or the worker took
// over an expired job without its lease handler. Ten minutes after its
// claim, a publication still being sent may have gone out, so it becomes
// outcome_unknown (never resent); one only claimed made no call and is
// queued again.

const STUCK_MS = 10 * 60_000;

export const socialDeliverySweep: PeriodicTask = {
  name: "social-delivery-sweep",
  async nextDueAt(tx, scope) {
    if (!(await socialActive(tx, scope))) return null;
    const oldest = await tx.socialPublication.findFirst({
      where: { projectId: scope.projectId, status: { in: ["sending", "claimed"] }, claimedAt: { not: null } },
      orderBy: { claimedAt: "asc" },
      select: { claimedAt: true },
    });
    return oldest?.claimedAt ? new Date(oldest.claimedAt.getTime() + STUCK_MS) : null;
  },
  async run(scope) {
    const settled = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const stuck = await tx.socialPublication.findMany({
        where: {
          projectId: scope.projectId,
          status: { in: ["sending", "claimed"] },
          claimedAt: { lt: new Date(Date.now() - STUCK_MS) },
        },
        take: 50,
      });
      for (const pub of stuck) {
        if (pub.status === "sending") await markOutcomeUnknown(tx, scope, pub.id, "SOCIAL_SEND_STUCK");
        else {
          await tx.socialPublication.update({ where: { id: pub.id }, data: { status: "pending", fence: null, version: { increment: 1 } } });
          await enqueue(tx, scope, DELIVER, pub.id, `social-deliver:${pub.id}:s${pub.claimedAt!.getTime()}`);
        }
      }
      return stuck.length;
    });
    return settled ? { status: `settled ${settled}` } : undefined;
  },
};

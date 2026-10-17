import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { PeriodicTask } from "../jobs/types.ts";
import type { RetentionContribution } from "../governance/types.ts";
import { SESSION_HOURS, SESSION_KIND } from "./public-api.ts";
import { WEBHOOK_KIND } from "./webhooks.ts";

// Public ingress keeps nothing longer than it needs (WP4.2 follow-up):
// a public session goes one hour after it expired, a received webhook after
// 30 days. Both rows (and their versions, by cascade) are deleted for good.

export const WEBHOOK_KEEP_DAYS = 30;
const SESSION_GRACE_HOURS = 1;
// One cleanup per project at most this often.
const CLEANUP_MS = 3_600_000;
const lastRun = new Map<string, number>();

/** Deletes expired public sessions and webhooks received before `webhookCutoff`. */
export async function purgeIngress(
  tx: DbTx,
  scope: Scope,
  at: Date,
  webhookCutoff: Date,
) {
  const where = { workspaceId: scope.workspaceId, projectId: scope.projectId };
  // A session expires SESSION_HOURS after its creation.
  const sessionCutoff = new Date(
    at.valueOf() - (SESSION_HOURS + SESSION_GRACE_HOURS) * 3_600_000,
  );
  const sessions = await tx.entity.deleteMany({
    where: { ...where, kind: SESSION_KIND, createdAt: { lt: sessionCutoff } },
  });
  const webhooks = await tx.entity.deleteMany({
    where: { ...where, kind: WEBHOOK_KIND, createdAt: { lt: webhookCutoff } },
  });
  return { publicSessions: sessions.count, inboundWebhooks: webhooks.count };
}

const keepCutoff = (at: Date) =>
  new Date(at.valueOf() - WEBHOOK_KEEP_DAYS * 86_400_000);

/**
 * The project's retention action purges the same way: its period is at
 * least 30 days, so the platform's own limit is never the longer one.
 */
export const ingressRetention: RetentionContribution = async (
  tx,
  scope,
  { at },
) => {
  const counts = await purgeIngress(tx, scope, at, keepCutoff(at));
  return {
    audit: counts,
    result: {
      purgedPublicSessions: counts.publicSessions,
      purgedInboundWebhooks: counts.inboundWebhooks,
    },
  };
};

/** Hourly per project, whatever the flag says: rows from an earlier "on" go too. */
export const ingressCleanup: PeriodicTask = {
  name: "public-ingress-cleanup",
  async run(scope) {
    const now = Date.now();
    if (now - (lastRun.get(scope.projectId) ?? 0) < CLEANUP_MS) return;
    lastRun.set(scope.projectId, now);
    const at = new Date(now);
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      purgeIngress(tx, scope, at, keepCutoff(at)),
    );
  },
};

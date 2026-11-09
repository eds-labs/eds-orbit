import { scoped } from "../../../../../packages/db/src/index.ts";
import type { RetentionContribution } from "../../platform/governance/types.ts";
import type { PeriodicTask } from "../../platform/jobs/types.ts";
import { audit } from "../../shared.ts";
import { removeOrphanedGrants } from "./mailboxes.ts";

// Housekeeping of the webmail tables. Sessions are control-plane rows without
// mail content; a revoked one stays a day so the reason can be looked up.

const EVERY_MS = 3600_000;
const REVOKED_KEPT_MS = 24 * 3600_000;

const nextRun = new Map<string, number>();

/** Deletes finished sessions and the grants of members who left the project. */
export async function purgeWebmail(
  scope: Parameters<PeriodicTask["run"]>[0],
  now = new Date(),
) {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const { count: sessions } = await tx.webmailSession.deleteMany({
      where: {
        projectId: scope.projectId,
        OR: [
          { expiresAt: { lte: now } },
          { handoffConsumedAt: null, handoffExpiresAt: { lte: now } },
          {
            revokedAt: {
              lte: new Date(now.getTime() - REVOKED_KEPT_MS),
            },
          },
        ],
      },
    });
    const grants = await removeOrphanedGrants(tx, scope);
    if (grants)
      await audit(tx, scope, "webmail.grants.purged", scope.projectId, {
        grants,
      });
    return { sessions, grants };
  });
}

export const webmailMaintenance: PeriodicTask = {
  name: "webmail-maintenance",
  async run(scope) {
    const now = Date.now();
    const due = nextRun.get(scope.projectId) ?? 0;
    if (due > now) return { status: "idle", wakeAt: new Date(due) };
    nextRun.set(scope.projectId, now + EVERY_MS);
    const { sessions, grants } = await purgeWebmail(scope);
    return {
      status: `webmail sessions=${sessions} grants=${grants}`,
      wakeAt: new Date(now + EVERY_MS),
    };
  },
};

/** Claims of converted messages hold no mail content; they follow the cutoff. */
export const webmailRetention: RetentionContribution = async (
  tx,
  scope,
  { cutoff },
) => {
  const { count } = await tx.webmailConversion.deleteMany({
    where: {
      projectId: scope.projectId,
      updatedAt: { lt: cutoff },
    },
  });
  // Nothing to report keeps the retention answer as it is without webmail.
  const report: Record<string, number> = count
    ? { webmailConversions: count }
    : {};
  return { audit: report, result: report };
};

import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { PeriodicTask } from "../../../platform/jobs/types.ts";
import { socialActive } from "../gate.ts";
import { MEDIA_RECEIPT_KIND, UPLOAD_SESSION_KIND } from "./upload-sessions.ts";

// Removes the technical rows of MCP media writes (Entity rows, versions by
// cascade): upload sessions a day after they were opened (they expire after
// fifteen minutes; a finished one can be read back by sessionId until then)
// and idempotency receipts after thirty days (the retry window). The
// library images themselves stay.

const DAY = 86_400_000;
export const UPLOAD_SESSION_RETENTION_MS = DAY;
export const MEDIA_RECEIPT_RETENTION_MS = 30 * DAY;

const stale = (scope: Scope, now: number) => ({
  projectId: scope.projectId,
  OR: [
    { kind: UPLOAD_SESSION_KIND, createdAt: { lt: new Date(now - UPLOAD_SESSION_RETENTION_MS) } },
    { kind: MEDIA_RECEIPT_KIND, createdAt: { lt: new Date(now - MEDIA_RECEIPT_RETENTION_MS) } },
  ],
});

/** Deletes the project's stale sessions and receipts; returns how many. */
export async function cleanMediaMcpRows(tx: DbTx, scope: Scope, now = Date.now()) {
  return (await tx.entity.deleteMany({ where: stale(scope, now) })).count;
}

/** Hourly: stale upload sessions and receipts of MCP media writes. */
export const socialMediaMcpCleanup: PeriodicTask = {
  name: "social-media-mcp-cleanup",
  async nextDueAt(tx, scope) {
    if (!(await socialActive(tx, scope))) return null;
    const row = await tx.entity.findFirst({ where: stale(scope, Date.now()), select: { id: true } });
    return row ? new Date() : null;
  },
  async run(scope) {
    const removed = await scoped(scope.workspaceId, scope.projectId, (tx) => cleanMediaMcpRows(tx, scope));
    return { status: `removed ${removed}` };
  },
};

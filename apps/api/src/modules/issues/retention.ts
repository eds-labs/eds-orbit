import { scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { PeriodicTask } from "../../platform/jobs/types.ts";
import { removeLinksFor } from "../../platform/links/links.ts";
import { audit } from "../../shared.ts";
import { ISSUE_TYPE } from "./common.ts";
import { issuesActive } from "./gate.ts";
import { readIssuesSettings } from "./settings.ts";

// Retention (ADR 0018, Q-P3-5): closed and merged issues go with their
// reports, history and deliveries after `closedIssueMonths` (default 36);
// report diagnostics are emptied after `diagnosticsMonths` (default 12).
// Deletions are final; the audit keeps counts only.

const DAY = 86_400_000;
const MONTH = 30 * DAY;
const BATCH = 200;

/** Applies the project's retention once. */
export async function issuesRetention(scope: Scope, now = new Date()) {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    if (!(await issuesActive(tx, scope))) return null;
    const { retention } = (await readIssuesSettings(tx, scope)).settings;
    const closedBefore = new Date(now.getTime() - retention.closedIssueMonths * MONTH);
    const old = await tx.issue.findMany({
      where: { projectId: scope.projectId, status: { in: ["closed", "duplicate"] }, closedAt: { lt: closedBefore } },
      select: { id: true },
      take: BATCH,
    });
    const actor = { kind: "system" as const, id: null };
    for (const issue of old) await removeLinksFor(tx, scope, { type: ISSUE_TYPE, id: issue.id }, actor);
    // Reports, history, deliveries, candidates and references cascade.
    const issues = await tx.issue.deleteMany({ where: { projectId: scope.projectId, id: { in: old.map((i) => i.id) } } });
    const diagnosticsBefore = new Date(now.getTime() - retention.diagnosticsMonths * MONTH);
    const diagnostics = await tx.$executeRaw`
      UPDATE "IssueReport" SET diagnostics = '{}'::jsonb
      WHERE "projectId" = ${scope.projectId}::uuid AND "receivedAt" < ${diagnosticsBefore}
        AND diagnostics <> '{}'::jsonb`;
    await audit(tx, scope, "issues.retention.applied", scope.projectId, { issues: issues.count, diagnostics });
    return { issues: issues.count, diagnostics };
  });
}

/** Runs the retention at most once a day per project. */
export const issuesRetentionTask: PeriodicTask = {
  name: "issues-retention",
  async nextDueAt(tx, scope) {
    if (!(await issuesActive(tx, scope))) return null;
    const last = await tx.auditEvent.findFirst({
      where: { projectId: scope.projectId, action: "issues.retention.applied" },
      orderBy: { createdAt: "desc" },
    });
    return last ? new Date(last.createdAt.getTime() + DAY) : new Date();
  },
  async run(scope) {
    const due = await scoped(scope.workspaceId, scope.projectId, (tx) => issuesRetentionTask.nextDueAt!(tx, scope));
    if (!due || due.getTime() > Date.now()) return { status: "idle" };
    const result = await issuesRetention(scope);
    return {
      status: result ? `retention issues=${result.issues} diagnostics=${result.diagnostics}` : "idle",
      wakeAt: new Date(Date.now() + DAY),
    };
  },
};

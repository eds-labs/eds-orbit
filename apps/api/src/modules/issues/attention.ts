import type { AttentionContribution, AttentionItem } from "../../platform/attention/types.ts";
import { registeredLinkType } from "../../platform/modules/contributions.ts";
import { can } from "../../platform/tenancy/permissions.ts";
import { ISSUE_TYPE } from "./common.ts";
import { issuesActive } from "./gate.ts";
import { ISSUES_READ, ISSUES_TRIAGE } from "./permissions.ts";
import { OPEN_STATUSES, TRIAGE_STATUSES } from "./status.ts";

// What needs a member's attention in the issue center, computed at read
// time and never stored (UI restructure §4.1). Counts only, no titles.
// The last item is sync rule S6: a closed issue whose tasks are still open
// is shown to people; the issue center never changes a task itself.

const OPEN_TASK = new Set(["backlog", "todo", "in_progress", "blocked", "in_review"]);

export const issuesAttention: AttentionContribution = async (tx, scope) => {
  if (!can(scope, ISSUES_READ)) return [];
  if (!(await issuesActive(tx, scope))) return [];
  const p = scope.projectId;
  const base = { moduleId: "issues", params: {} } as const;
  const items: AttentionItem[] = [];
  const [critical, backlog, duplicates, fixReady] = await Promise.all([
    tx.issue.aggregate({ where: { projectId: p, status: { in: [...OPEN_STATUSES] }, severity: "s1_critical" }, _count: { _all: true }, _min: { createdAt: true } }),
    tx.issue.aggregate({ where: { projectId: p, status: { in: [...TRIAGE_STATUSES] } }, _count: { _all: true }, _min: { createdAt: true } }),
    tx.issueDuplicateCandidate.count({ where: { projectId: p, status: "pending" } }),
    tx.issue.aggregate({ where: { projectId: p, status: "fix_ready" }, _count: { _all: true }, _min: { updatedAt: true } }),
  ]);
  if (critical._count._all)
    items.push({ ...base, id: "issues:critical", kind: "issues_critical", severity: "critical", count: critical._count._all, since: critical._min.createdAt?.toISOString(), navKey: "issues-list", link: "/issues/list?severity=s1_critical" });
  const triager = can(scope, ISSUES_TRIAGE);
  if (triager && backlog._count._all)
    items.push({ ...base, id: "issues:triage", kind: "issues_triage_backlog", severity: "warning", count: backlog._count._all, since: backlog._min.createdAt?.toISOString(), navKey: "issues-triage", link: "/issues/triage" });
  if (triager && duplicates)
    items.push({ ...base, id: "issues:duplicates", kind: "issues_duplicates_pending", severity: "info", count: duplicates, navKey: "issues-triage", link: "/issues/triage" });
  if (triager && fixReady._count._all)
    items.push({ ...base, id: "issues:release", kind: "issues_release_unconfirmed", severity: "info", count: fixReady._count._all, since: fixReady._min.updatedAt?.toISOString(), navKey: "issues-releases", link: "/issues/releases" });
  if (triager) {
    const closed = await tx.issue.findMany({
      where: { projectId: p, status: { in: ["wont_fix", "duplicate", "closed"] } },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    const links = closed.length
      ? await tx.objectLink.findMany({
          where: { projectId: p, removedAt: null, relation: "implements", sourceType: "work.task", targetType: ISSUE_TYPE, targetId: { in: closed.map((c) => c.id) } },
          select: { sourceId: true, targetId: true },
        })
      : [];
    const def = registeredLinkType("work.task");
    if (links.length && def) {
      const tasks = await def.resolve(tx, scope, [...new Set(links.map((l) => l.sourceId))]);
      const issues = new Set(links.filter((l) => OPEN_TASK.has(tasks.get(l.sourceId)?.statusCategory ?? "")).map((l) => l.targetId));
      if (issues.size)
        items.push({ ...base, id: "issues:open_tasks", kind: "issues_closed_open_tasks", severity: "warning", count: issues.size, navKey: "issues-list", link: "/issues/list?status=all&hasTasks=true" });
    }
  }
  return items;
};

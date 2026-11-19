import type { AttentionContribution } from "../../platform/attention/types.ts";
import { can } from "../../platform/tenancy/permissions.ts";
import { cmsActive } from "./gate.ts";
import { CMS_READ } from "./permissions.ts";

// What needs attention in the content module (CH1.17), computed at read
// time, counts only. An entry counts when its latest publication of the last
// week stopped for a person (preflight, lateness, changed sites) or when its
// site still did not show it after the last live check. Open publication
// requests are listed by the platform's Decisions, not here.

const WEEK_MS = 7 * 86_400_000;

export const cmsAttention: AttentionContribution = async (tx, scope, now) => {
  if (!can(scope, CMS_READ)) return [];
  if (!(await cmsActive(tx, scope))) return [];
  const recent = await tx.cmsPublication.findMany({
    where: { projectId: scope.projectId, createdAt: { gte: new Date(now.getTime() - WEEK_MS) } },
    select: { entryId: true, status: true, errorCode: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const latest = new Map<string, (typeof recent)[number]>();
  for (const row of recent) if (!latest.has(row.entryId)) latest.set(row.entryId, row);
  const stopped = [...latest.values()].filter((p) => p.status === "needs_attention").length;
  const notShown = [...latest.values()].filter((p) => p.status !== "needs_attention" && p.errorCode === "CMS_LIVE_CHECK_FAILED").length;
  const item = (id: string, kind: string, count: number) => ({
    id: `cms:${id}`,
    moduleId: "cms",
    kind,
    severity: "warning" as const,
    count,
    params: {},
    navKey: "cms",
    link: "/cms",
  });
  return [
    ...(stopped ? [item("stopped", "cms_publication_stopped", stopped)] : []),
    ...(notShown ? [item("live", "cms_live_check_failed", notShown)] : []),
  ];
};

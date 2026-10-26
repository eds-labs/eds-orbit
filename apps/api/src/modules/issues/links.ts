import type { LinkTypeDef } from "../../platform/links/types.ts";
import { issueKey, issuePath } from "./common.ts";
import { ISSUES_READ } from "./permissions.ts";

// Issues as link targets of other modules (ADR 0018): a task implements an
// issue, an issue was reported in a ticket. Issue texts are redacted, so
// tools outside the app may show their titles.

const issue: LinkTypeDef = {
  label: { en: "Issue", de: "Issue" },
  linkPermission: ISSUES_READ,
  async resolve(tx, scope, ids) {
    const rows = await tx.issue.findMany({
      where: { projectId: scope.projectId, id: { in: [...ids] } },
      select: { id: true, number: true, title: true, status: true },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        { title: `${issueKey(r.number)} ${r.title}`, status: r.status, href: issuePath(scope.projectId, r.id) },
      ]),
    );
  },
  async search(tx, scope, query, limit) {
    const number = /^(?:ISS-)?#?(\d{1,9})$/i.exec(query.trim())?.[1];
    const rows = await tx.issue.findMany({
      where: {
        projectId: scope.projectId,
        status: { not: "duplicate" },
        ...(number
          ? { number: Number(number) }
          : { title: { contains: query.trim().slice(0, 100), mode: "insensitive" } }),
      },
      select: { id: true, number: true, title: true },
      orderBy: { lastSeenAt: "desc" },
      take: limit,
    });
    return rows.map((r) => ({ id: r.id, title: `${issueKey(r.number)} ${r.title}` }));
  },
};

export const issuesLinkTypes = { issue };

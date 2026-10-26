import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { linksOf } from "../../platform/links/links.ts";
import { can } from "../../platform/tenancy/permissions.ts";
import { ISSUE_TYPE, ISSUE_TYPES, PRIORITIES, SEVERITIES } from "./common.ts";
import { issueView, loadIssue } from "./issues.ts";
import { ISSUES_DIAGNOSTICS_READ } from "./permissions.ts";
import { REPORT_SOURCES, reportView } from "./reports.ts";
import { ISSUE_STATUSES, OPEN_STATUSES, TRIAGE_STATUSES } from "./status.ts";

// Reads of the issue center (plan §4.2). Texts are redacted at intake;
// diagnostics need issues.diagnostics.read, and linked tickets resolve only
// for members who may read them (restricted placeholders otherwise).

const MAX_MATCHES = 1000;
const SEVERITY_ORDER: Record<string, number> = { s1_critical: 0, s2_major: 1, s3_minor: 2, s4_trivial: 3 };

const listQuery = z
  .object({
    q: z.string().max(200).optional(),
    status: z.union([z.enum(ISSUE_STATUSES), z.enum(["open", "triage", "all"])]).optional(),
    type: z.enum(ISSUE_TYPES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    component: z.string().max(41).optional(),
    source: z.enum(REPORT_SOURCES).optional(),
    assignee: z.string().max(100).optional(),
    hasTasks: z.enum(["true", "false"]).optional(),
    duplicates: z.literal("pending").optional(),
    sort: z.enum(["lastSeen", "reports", "severity", "created", "number", "relevance"]).optional(),
    cursor: z.string().regex(/^\d{1,6}$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

/** Issue ids by full-text relevance over title, summary and components. */
export async function searchIssueIds(tx: DbTx, scope: Scope, q: string, limit = MAX_MATCHES) {
  const words = q.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 8) ?? [];
  if (!words.length) return [];
  const query = words.map((w) => `${w.toLowerCase()}:*`).join(" & ");
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Issue"
    WHERE "projectId" = ${scope.projectId}::uuid
      AND "searchVector" @@ to_tsquery('simple', ${query})
    ORDER BY ts_rank("searchVector", to_tsquery('simple', ${query})) DESC
    LIMIT ${limit}`;
  return rows.map((r) => r.id);
}

/** Active `implements` links per issue (tasks that work on it). */
async function taskCounts(tx: DbTx, scope: Scope, ids: readonly string[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = await tx.objectLink.groupBy({
    by: ["targetId"],
    where: {
      projectId: scope.projectId,
      removedAt: null,
      relation: "implements",
      targetType: ISSUE_TYPE,
      targetId: { in: [...ids] },
    },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.targetId, r._count._all]));
}

async function idsWhere(tx: DbTx, scope: Scope, q: z.infer<typeof listQuery>) {
  const sets: string[][] = [];
  if (q.source)
    sets.push(
      (
        await tx.issueReport.findMany({
          where: { projectId: scope.projectId, sourceKind: q.source },
          select: { issueId: true },
          distinct: ["issueId"],
          take: MAX_MATCHES,
        })
      ).map((r) => r.issueId),
    );
  if (q.duplicates)
    sets.push(
      (
        await tx.issueDuplicateCandidate.findMany({
          where: { projectId: scope.projectId, status: "pending" },
          select: { issueId: true },
          distinct: ["issueId"],
          take: MAX_MATCHES,
        })
      ).map((r) => r.issueId),
    );
  if (q.hasTasks) {
    const linked = (
      await tx.objectLink.findMany({
        where: { projectId: scope.projectId, removedAt: null, relation: "implements", targetType: ISSUE_TYPE },
        select: { targetId: true },
        distinct: ["targetId"],
        take: MAX_MATCHES,
      })
    ).map((r) => r.targetId);
    return { sets, linked, withTasks: q.hasTasks === "true" };
  }
  return { sets };
}

/** The filtered, sorted list with task and ticket counts per issue. */
export async function listIssues(tx: DbTx, scope: Scope, raw: unknown) {
  const q = listQuery.parse(raw ?? {});
  const where: Record<string, unknown> = { projectId: scope.projectId };
  const and: Record<string, unknown>[] = [];
  const status = q.status ?? "open";
  if (status === "open") where.status = { in: [...OPEN_STATUSES] };
  else if (status === "triage") where.status = { in: [...TRIAGE_STATUSES] };
  else if (status !== "all") where.status = status;
  if (q.type) where.type = q.type;
  if (q.severity) where.severity = q.severity;
  if (q.priority) where.priority = q.priority;
  if (q.component) where.components = { has: q.component };
  if (q.assignee === "me") where.assigneeUserId = scope.userId;
  else if (q.assignee === "none") where.assigneeUserId = null;
  else if (q.assignee) where.assigneeUserId = q.assignee;
  const filters = await idsWhere(tx, scope, q);
  for (const ids of filters.sets) and.push({ id: { in: ids } });
  if ("linked" in filters) and.push({ id: filters.withTasks ? { in: filters.linked } : { notIn: filters.linked } });
  let ranked: string[] | null = null;
  if (q.q) {
    ranked = await searchIssueIds(tx, scope, q.q);
    const number = /^(?:ISS-)?#?(\d{1,9})$/i.exec(q.q.trim())?.[1];
    if (number) {
      const hit = await tx.issue.findFirst({ where: { projectId: scope.projectId, number: Number(number) }, select: { id: true } });
      if (hit) ranked = [hit.id, ...ranked.filter((id) => id !== hit.id)];
    }
    and.push({ id: { in: ranked } });
  }
  if (and.length) where.AND = and;
  const sort = q.sort ?? (ranked ? "relevance" : "lastSeen");
  const offset = Number(q.cursor ?? 0);
  const limit = q.limit ?? 50;
  type Row = Awaited<ReturnType<typeof tx.issue.findMany>>[number];
  let page: Row[];
  let total: number;
  if (sort === "relevance" || sort === "severity") {
    // Orders the database cannot express: within the capped matches.
    const rows = await tx.issue.findMany({ where, take: MAX_MATCHES, orderBy: { lastSeenAt: "desc" } });
    if (sort === "relevance") {
      const order = new Map((ranked ?? []).map((id, i) => [id, i]));
      rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    } else rows.sort((a, b) => (SEVERITY_ORDER[a.severity ?? ""] ?? 9) - (SEVERITY_ORDER[b.severity ?? ""] ?? 9));
    page = rows.slice(offset, offset + limit);
    total = rows.length;
  } else {
    const orderBy = {
      lastSeen: [{ lastSeenAt: "desc" }, { number: "desc" }],
      reports: [{ reportCount: "desc" }, { lastSeenAt: "desc" }],
      created: [{ createdAt: "desc" }, { number: "desc" }],
      number: [{ number: "desc" }],
    }[sort];
    [page, total] = await Promise.all([
      tx.issue.findMany({ where, orderBy: orderBy as never, skip: offset, take: limit }),
      tx.issue.count({ where }),
    ]);
  }
  const tasks = await taskCounts(tx, scope, page.map((r) => r.id));
  return {
    items: page.map((r) => ({ ...issueView(r), counts: { tasks: tasks.get(r.id) ?? 0, tickets: r.ticketCount, reports: r.reportCount } })),
    total,
    nextCursor: offset + limit < total ? String(offset + limit) : null,
  };
}

/**
 * An issue with its reports, duplicate candidates, links, deliveries,
 * external references and history. Diagnostics only with
 * issues.diagnostics.read.
 */
export async function issueDetail(tx: DbTx, scope: Scope, id: string) {
  const issue = await loadIssue(tx, scope, id);
  const diagnostics = can(scope, ISSUES_DIAGNOSTICS_READ);
  const where = { projectId: scope.projectId, issueId: issue.id };
  const [reports, candidates, deliveries, refs, events, links] = await Promise.all([
    tx.issueReport.findMany({ where, orderBy: { receivedAt: "desc" }, take: 100 }),
    tx.issueDuplicateCandidate.findMany({
      where: {
        projectId: scope.projectId,
        status: "pending",
        OR: [{ issueId: issue.id }, { candidateIssueId: issue.id }],
      },
      orderBy: { score: "desc" },
      take: 20,
    }),
    tx.issueDelivery.findMany({ where, orderBy: { observedAt: "desc" }, take: 100 }),
    tx.issueExternalRef.findMany({ where, orderBy: { createdAt: "asc" } }),
    tx.issueEvent.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 }),
    linksOf(tx, scope, { type: ISSUE_TYPE, id: issue.id }),
  ]);
  const others = [...new Set(candidates.map((c) => (c.issueId === issue.id ? c.candidateIssueId : c.issueId)))];
  const titles = new Map(
    (
      await tx.issue.findMany({
        where: { projectId: scope.projectId, id: { in: others } },
        select: { id: true, number: true, title: true, status: true, reportCount: true },
      })
    ).map((r) => [r.id, r]),
  );
  const tasks = links.filter((l) => l.relation === "implements" && l.object.type === "work.task");
  return {
    issue: issueView(issue),
    reports: reports.map((r) => reportView(r, { diagnostics })),
    duplicateCandidates: candidates.map((c) => {
      const otherId = c.issueId === issue.id ? c.candidateIssueId : c.issueId;
      const other = titles.get(otherId);
      return {
        id: c.id,
        method: c.method,
        score: Number(c.score),
        reasons: c.reasons,
        issue: other ? { id: other.id, key: `ISS-${other.number}`, title: other.title, status: other.status, reportCount: other.reportCount } : null,
      };
    }),
    links,
    progress: {
      tasks: tasks.length,
      done: tasks.filter((t) => t.object.statusCategory === "done").length,
      restricted: tasks.filter((t) => t.object.state !== "ok").length,
    },
    deliveries: deliveries.map(deliveryView),
    externalRefs: refs.map((r) => ({ id: r.id, system: r.system, externalId: r.externalId, url: r.url, state: r.state })),
    timeline: events.map((e) => ({
      id: e.id,
      type: e.type,
      actorKind: e.actorKind,
      actorId: e.actorId,
      before: e.before,
      after: e.after,
      createdAt: e.createdAt.toISOString(),
    })),
    permissions: { diagnostics },
  };
}

type DeliveryRow = Awaited<ReturnType<DbTx["issueDelivery"]["findMany"]>>[number];
export function deliveryView(d: DeliveryRow) {
  return {
    id: d.id,
    kind: d.kind,
    repository: d.repository,
    prNumber: d.prNumber,
    commitSha: d.commitSha,
    environment: d.environment,
    source: d.source,
    status: d.status,
    observedAt: d.observedAt.toISOString(),
    recordedBy: d.recordedBy,
  };
}

import { Prisma, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type {
  AttentionContribution,
  AttentionItem,
} from "../../platform/attention/types.ts";
import { can } from "../../platform/tenancy/permissions.ts";
import {
  OPEN_STATUSES,
  SLA_ACTIVE_STATUSES,
  SLA_AT_RISK_MINUTES,
  SLA_DUE_AT_SQL,
  slaDueAt,
} from "./common.ts";
import { supportActive } from "./gate.ts";
import { SUPPORT_TICKETS_READ } from "./permissions.ts";

// The support module's attention items (UI restructure §4.1): tickets past or
// close to their SLA due time and the unassigned ones. Params carry the
// ticket number, subject and channel only: never a message body or a
// customer address. Every ticket counts once in the badge (R20).

/** Breached and at-risk tickets are listed one by one up to this many each. */
const SLA_TICKET_LIMIT = 5;

const NAV_KEY = "support-tickets";
const TICKETS = { navKey: NAV_KEY, link: "/support/tickets" } as const;

type SlaKind = "support_sla_breached" | "support_sla_at_risk";

/**
 * The active tickets whose earliest pending due time lies in [from, to),
 * earliest first: the SQL form of the summary's breached and at-risk
 * predicates (a pending clock past due means the earliest is). The first
 * SLA_TICKET_LIMIT ids, how many there are beyond them and the earliest
 * due time of those.
 */
async function dueTickets(
  tx: DbTx,
  scope: Scope,
  range: { from?: Date; to: Date },
) {
  // One row beyond the listed ones carries the rest's earliest due time; the
  // window count is taken before the LIMIT.
  const found = await tx.$queryRaw<
    { id: string; dueAt: Date; total: bigint }[]
  >`
    SELECT "id", ${SLA_DUE_AT_SQL} AS "dueAt", count(*) OVER () AS "total"
      FROM "SupportTicket"
     WHERE "projectId" = ${scope.projectId}::uuid
       AND "mergedIntoTicketId" IS NULL
       AND "status" = ANY(${SLA_ACTIVE_STATUSES}::text[])
       AND ${SLA_DUE_AT_SQL} < ${range.to}::timestamptz
       ${
         range.from
           ? Prisma.sql`AND ${SLA_DUE_AT_SQL} >= ${range.from}::timestamptz`
           : Prisma.empty
       }
     ORDER BY ${SLA_DUE_AT_SQL} ASC, "id" ASC
     LIMIT ${SLA_TICKET_LIMIT + 1}`;
  const rest = found[SLA_TICKET_LIMIT];
  return {
    ids: found.slice(0, SLA_TICKET_LIMIT).map((row) => row.id),
    more: rest
      ? { count: Number(rest.total) - SLA_TICKET_LIMIT, dueAt: rest.dueAt }
      : null,
  };
}

async function slaItems(
  tx: DbTx,
  scope: Scope,
  due: Awaited<ReturnType<typeof dueTickets>>,
  kind: SlaKind,
): Promise<AttentionItem[]> {
  const severity = kind === "support_sla_breached" ? "critical" : "warning";
  const rows = due.ids.length
    ? await tx.supportTicket.findMany({
        where: { projectId: scope.projectId, id: { in: due.ids } },
      })
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  // In due order; a ticket erased between the two reads is left out.
  const items: AttentionItem[] = due.ids.flatMap((id) => {
    const ticket = byId.get(id);
    if (!ticket) return [];
    const dueAt = slaDueAt(ticket);
    return [
      {
        id: `support:sla:${ticket.id}`,
        moduleId: "support",
        kind,
        severity,
        ...(dueAt ? { dueAt: dueAt.toISOString() } : {}),
        params: {
          number: ticket.number,
          subject: ticket.subject,
          channel: ticket.channel,
          assigned: ticket.assigneeUserId !== null,
        },
        navKey: NAV_KEY,
        link: `/support/tickets?ticket=${ticket.id}`,
      } satisfies AttentionItem,
    ];
  });
  // The tickets beyond the listed ones, as one item without names (as R18).
  if (due.more)
    items.push({
      id: `support:sla:${kind === "support_sla_breached" ? "breached" : "at_risk"}:more`,
      moduleId: "support",
      kind,
      severity,
      count: due.more.count,
      dueAt: due.more.dueAt.toISOString(),
      params: {},
      ...TICKETS,
    });
  return items;
}

/**
 * Open, unassigned tickets that are not merged, split into the ones with an
 * SLA item of their own (active and due before `soon`) and the rest, with
 * the rest's oldest creation time.
 */
async function unassignedTickets(tx: DbTx, scope: Scope, soon: Date) {
  const [found] = await tx.$queryRaw<
    { rest: bigint; listed: bigint; since: Date | null }[]
  >`
    WITH "unassigned" AS (
      SELECT "createdAt",
             COALESCE("status" = ANY(${SLA_ACTIVE_STATUSES}::text[])
                      AND ${SLA_DUE_AT_SQL} < ${soon}::timestamptz, false)
               AS "listed"
        FROM "SupportTicket"
       WHERE "projectId" = ${scope.projectId}::uuid
         AND "mergedIntoTicketId" IS NULL
         AND "status" = ANY(${OPEN_STATUSES}::text[])
         AND "assigneeUserId" IS NULL)
    SELECT count(*) FILTER (WHERE NOT "listed") AS "rest",
           count(*) FILTER (WHERE "listed") AS "listed",
           min("createdAt") FILTER (WHERE NOT "listed") AS "since"
      FROM "unassigned"`;
  return {
    rest: Number(found?.rest ?? 0),
    listed: Number(found?.listed ?? 0),
    since: found?.since ?? null,
  };
}

/**
 * Open tickets whose reported product issue was released (ADR 0018) and
 * that no agent answered since: the member's own and the unassigned ones.
 */
async function releasedIssueTickets(tx: DbTx, scope: Scope) {
  const [row] = await tx.$queryRaw<{ n: bigint; since: Date | null }[]>`
    SELECT count(DISTINCT t."id") AS n, min(e."createdAt") AS since
      FROM "SupportTicket" t
      JOIN "SupportTicketEvent" e ON e."projectId" = t."projectId" AND e."ticketId" = t."id" AND e."type" = 'issue_released'
     WHERE t."projectId" = ${scope.projectId}::uuid
       AND t."mergedIntoTicketId" IS NULL
       AND t."status" = ANY(${OPEN_STATUSES}::text[])
       AND (t."assigneeUserId" = ${scope.userId} OR t."assigneeUserId" IS NULL)
       AND NOT EXISTS (
         SELECT 1 FROM "SupportMessage" m
          WHERE m."projectId" = t."projectId" AND m."ticketId" = t."id"
            AND m."kind" = 'agent_reply' AND m."createdAt" > e."createdAt")`;
  return { count: Number(row?.n ?? 0), since: row?.since ?? null };
}

export const supportAttention: AttentionContribution = async (
  tx,
  scope,
  now,
) => {
  if (!can(scope, SUPPORT_TICKETS_READ)) return [];
  if (!(await supportActive(tx, scope))) return [];
  const soon = new Date(now.getTime() + SLA_AT_RISK_MINUTES * 60_000);
  const [breached, atRisk, unassigned, released] = await Promise.all([
    dueTickets(tx, scope, { to: now }),
    dueTickets(tx, scope, { from: now, to: soon }),
    unassignedTickets(tx, scope, soon),
    releasedIssueTickets(tx, scope),
  ]);
  const items = [
    ...(await slaItems(tx, scope, breached, "support_sla_breached")),
    ...(await slaItems(tx, scope, atRisk, "support_sla_at_risk")),
  ];
  // Unassigned tickets with an SLA item are counted there, not again here.
  if (unassigned.rest > 0)
    items.push({
      id: "support:unassigned",
      moduleId: "support",
      kind: "support_unassigned",
      severity: "warning",
      count: unassigned.rest,
      ...(unassigned.since ? { since: unassigned.since.toISOString() } : {}),
      params: unassigned.listed > 0 ? { othersListed: true } : {},
      ...TICKETS,
    });
  if (released.count > 0)
    items.push({
      id: "support:issue_released",
      moduleId: "support",
      kind: "support_issue_released",
      severity: "info",
      count: released.count,
      ...(released.since ? { since: released.since.toISOString() } : {}),
      params: {},
      ...TICKETS,
    });
  return items;
};

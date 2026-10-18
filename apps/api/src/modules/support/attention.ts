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
// customer address.

/** Breached and at-risk tickets are listed one by one up to this many each. */
const SLA_TICKET_LIMIT = 5;

const NAV_KEY = "support-tickets";

/**
 * The ids of active tickets whose earliest pending due time lies in
 * [from, to), earliest first: the SQL form of the summary's breached and
 * at-risk predicates (a pending clock past due means the earliest is).
 */
async function dueTicketIds(
  tx: DbTx,
  scope: Scope,
  range: { from?: Date; to: Date },
) {
  const found = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "SupportTicket"
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
     LIMIT ${SLA_TICKET_LIMIT}`;
  return found.map((row) => row.id);
}

async function slaItems(
  tx: DbTx,
  scope: Scope,
  ids: string[],
  kind: "support_sla_breached" | "support_sla_at_risk",
): Promise<AttentionItem[]> {
  if (!ids.length) return [];
  const rows = await tx.supportTicket.findMany({
    where: { projectId: scope.projectId, id: { in: ids } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  // In due order; a ticket erased between the two reads is left out.
  return ids.flatMap((id) => {
    const ticket = byId.get(id);
    if (!ticket) return [];
    const dueAt = slaDueAt(ticket);
    return [
      {
        id: `support:sla:${ticket.id}`,
        moduleId: "support",
        kind,
        severity: kind === "support_sla_breached" ? "critical" : "warning",
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
}

export const supportAttention: AttentionContribution = async (
  tx,
  scope,
  now,
) => {
  if (!can(scope, SUPPORT_TICKETS_READ)) return [];
  if (!(await supportActive(tx, scope))) return [];
  const soon = new Date(now.getTime() + SLA_AT_RISK_MINUTES * 60_000);
  const [breachedIds, atRiskIds, unassigned] = await Promise.all([
    dueTicketIds(tx, scope, { to: now }),
    dueTicketIds(tx, scope, { from: now, to: soon }),
    tx.supportTicket.aggregate({
      where: {
        projectId: scope.projectId,
        mergedIntoTicketId: null,
        status: { in: OPEN_STATUSES },
        assigneeUserId: null,
      },
      _count: { _all: true },
      _min: { createdAt: true },
    }),
  ]);
  const items = [
    ...(await slaItems(tx, scope, breachedIds, "support_sla_breached")),
    ...(await slaItems(tx, scope, atRiskIds, "support_sla_at_risk")),
  ];
  const count = unassigned._count._all;
  if (count > 0)
    items.push({
      id: "support:unassigned",
      moduleId: "support",
      kind: "support_unassigned",
      severity: "warning",
      count,
      ...(unassigned._min.createdAt
        ? { since: unassigned._min.createdAt.toISOString() }
        : {}),
      params: {},
      navKey: NAV_KEY,
      link: "/support/tickets",
    });
  return items;
};

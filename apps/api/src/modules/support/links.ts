import type { LinkTypeDef } from "../../platform/links/types.ts";
import { SUPPORT_TICKETS_READ } from "./permissions.ts";

// Tickets as link targets of other modules (ADR 0016), such as a task that
// relates to a ticket. A ticket's subject may hold customer data: only
// members who may read tickets see it, and tools outside the app leave it
// out (`sensitive`). Merged and closed tickets still resolve.

const ticket: LinkTypeDef = {
  label: { en: "Support ticket", de: "Support-Ticket" },
  linkPermission: SUPPORT_TICKETS_READ,
  async resolve(tx, scope, ids) {
    const rows = await tx.supportTicket.findMany({
      where: { projectId: scope.projectId, id: { in: [...ids] } },
      select: { id: true, number: true, subject: true, status: true },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        {
          title: `#${r.number} ${r.subject}`,
          status: r.status,
          href: `/p/${scope.projectId}/support/tickets?ticket=${r.id}`,
          sensitive: true,
        },
      ]),
    );
  },
  async search(tx, scope, query, limit) {
    const number = /^#?(\d{1,9})$/.exec(query)?.[1];
    const rows = await tx.supportTicket.findMany({
      where: {
        projectId: scope.projectId,
        mergedIntoTicketId: null,
        ...(number
          ? { number: Number(number) }
          : { subject: { contains: query.slice(0, 100), mode: "insensitive" } }),
      },
      select: { id: true, number: true, subject: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((r) => ({ id: r.id, title: `#${r.number} ${r.subject}` }));
  },
};

export const supportLinkTypes = { ticket };

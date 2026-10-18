import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { SchedulerContribution } from "../../platform/jobs/types.ts";
import type { UserNotificationKind } from "../../platform/notifications/members.ts";
import { notifyMembers } from "../../platform/notifications/members.ts";
import { supportAgents } from "./agents.ts";
import {
  SLA_ACTIVE_STATUSES,
  SLA_AT_RISK_MINUTES,
  supportSettings,
  ticketEvent,
} from "./common.ts";
import { supportActive } from "./gate.ts";
import { effectiveRules } from "./settings.ts";

// Support notifications and automations (WP5.5): who hears about what, auto
// assignment, SLA at-risk and breach events, and auto-close. Notifications
// name the ticket number only, never its subject or text (Q-12a); the link
// opens the ticket. E-mail copies are on by default only for what needs an
// answer from that person (assigned, breached, handoff), to avoid spam.

const label = (en: string, de: string) => ({ en, de });
export const supportUserNotifications: Readonly<
  Record<string, UserNotificationKind>
> = {
  support_ticket_new: {
    label: label("New support ticket", "Neues Support-Ticket"),
    emailDefault: false,
  },
  support_ticket_assigned: {
    label: label("Ticket assigned to me", "Ticket mir zugewiesen"),
    emailDefault: true,
  },
  support_customer_replied: {
    label: label("Customer replied", "Kunde hat geantwortet"),
    emailDefault: false,
  },
  support_sla_at_risk: {
    label: label("SLA at risk", "SLA gefährdet"),
    emailDefault: false,
  },
  support_sla_breached: {
    label: label("SLA breached", "SLA überschritten"),
    emailDefault: true,
  },
  support_ai_handoff: {
    label: label("Customer asked for a human", "Kunde möchte einen Menschen"),
    emailDefault: true,
  },
  support_mention: {
    label: label("Mentioned in a note", "In einer Notiz erwähnt"),
    emailDefault: false,
  },
};

const TITLES: Record<string, { en: string; de: string }> = {
  support_ticket_new: label("New ticket", "Neues Ticket"),
  support_ticket_assigned: label("Assigned to you", "Dir zugewiesen"),
  support_customer_replied: label("Customer replied", "Kunde hat geantwortet"),
  support_sla_at_risk: label("SLA at risk", "SLA gefährdet"),
  support_sla_breached: label("SLA breached", "SLA überschritten"),
  support_ai_handoff: label("Asked for a human", "Möchte einen Menschen"),
  support_mention: label("You were mentioned", "Du wurdest erwähnt"),
};

type TicketRow = Awaited<ReturnType<DbTx["supportTicket"]["findFirstOrThrow"]>>;

async function send(
  tx: DbTx,
  scope: Scope,
  kind: keyof typeof TITLES,
  ticket: TicketRow,
  userIds: string[],
) {
  const to = [...new Set(userIds)].filter(Boolean);
  if (!to.length) return;
  const project = await tx.project.findUnique({
    where: { id: scope.projectId },
    select: { language: true },
  });
  const title = TITLES[kind]![project?.language === "de" ? "de" : "en"];
  await notifyMembers(tx, scope, {
    kind,
    userIds: to,
    title: `#${ticket.number} · ${title}`,
    link: `/p/${scope.projectId}/support?ticket=${ticket.id}`,
  });
}

/** The assignee, or every support agent while nobody has the ticket. */
async function responsible(scope: Scope, ticket: TicketRow) {
  if (ticket.assigneeUserId) return [ticket.assigneeUserId];
  return (await supportAgents(scope)).map((a) => a.userId);
}

/** The agent an inbox's policy picks for a new ticket, if any. */
async function pickAssignee(tx: DbTx, scope: Scope, ticket: TicketRow) {
  const inbox = await tx.supportInbox.findFirst({
    where: { id: ticket.inboxId },
  });
  if (!inbox || inbox.assignmentPolicy === "unassigned") return null;
  const agents = (await supportAgents(scope)).map((a) => a.userId).sort();
  if (!agents.length) return null;
  if (inbox.assignmentPolicy === "fixed")
    return agents.includes(inbox.defaultAssigneeUserId ?? "")
      ? inbox.defaultAssigneeUserId
      : null;
  // Round robin: the agent after the one who got the inbox's last ticket.
  const last = await tx.supportTicket.findFirst({
    where: {
      projectId: scope.projectId,
      inboxId: inbox.id,
      assigneeUserId: { not: null },
      id: { not: ticket.id },
    },
    orderBy: [{ createdAt: "desc" }, { number: "desc" }],
  });
  const at = last ? agents.indexOf(last.assigneeUserId!) : -1;
  return agents[(at + 1) % agents.length]!;
}

/** Runs after a ticket is created: auto-assign, then tell the team. */
export async function afterTicketCreated(
  tx: DbTx,
  scope: Scope,
  ticket: TicketRow,
) {
  const assignee = await pickAssignee(tx, scope, ticket);
  let current = ticket;
  if (assignee) {
    current = await tx.supportTicket.update({
      where: { id: ticket.id },
      data: { assigneeUserId: assignee },
    });
    await ticketEvent(tx, scope, {
      ticketId: ticket.id,
      type: "assignee",
      actorKind: "system",
      actorId: null,
      before: { assigneeUserId: null },
      after: { assigneeUserId: assignee },
    });
    await send(tx, scope, "support_ticket_assigned", current, [assignee]);
  }
  const everyone = (await supportAgents(scope)).map((a) => a.userId);
  await send(
    tx,
    scope,
    "support_ticket_new",
    current,
    everyone.filter((id) => id !== assignee),
  );
}

/** Tells a new assignee, unless they assigned the ticket to themselves. */
export async function notifyAssigned(
  tx: DbTx,
  scope: Scope,
  ticket: TicketRow,
) {
  if (ticket.assigneeUserId && ticket.assigneeUserId !== scope.userId)
    await send(tx, scope, "support_ticket_assigned", ticket, [
      ticket.assigneeUserId,
    ]);
}

export async function notifyCustomerReply(
  tx: DbTx,
  scope: Scope,
  ticket: TicketRow,
) {
  await send(
    tx,
    scope,
    "support_customer_replied",
    ticket,
    await responsible(scope, ticket),
  );
}

export async function notifyHandoff(tx: DbTx, scope: Scope, ticket: TicketRow) {
  await send(
    tx,
    scope,
    "support_ai_handoff",
    ticket,
    await responsible(scope, ticket),
  );
}

/** "@Name" in an internal note tells that agent (not the author). */
export async function notifyMentions(
  tx: DbTx,
  scope: Scope,
  ticket: TicketRow,
  bodyText: string,
) {
  const mentioned = (await supportAgents(scope))
    .filter((a) => a.name && bodyText.includes(`@${a.name}`))
    .map((a) => a.userId)
    .filter((id) => id !== scope.userId);
  await send(tx, scope, "support_mention", ticket, mentioned);
}

const WINDOW = SLA_AT_RISK_MINUTES * 60_000;
const DAY = 24 * 3_600_000;

/** The pending due times of a ticket, by which clock they belong to. */
function pendingDues(ticket: TicketRow) {
  return [
    [
      "first_response",
      ticket.firstRespondedAt ? null : ticket.firstResponseDueAt,
    ],
    ["resolution", ticket.resolvedAt ? null : ticket.resolutionDueAt],
  ].filter((d): d is [string, Date] => d[1] instanceof Date);
}

async function slaSweep(tx: DbTx, scope: Scope, at: Date) {
  const settings = await supportSettings(tx, scope);
  const inboxes = await tx.supportInbox.findMany({
    where: { projectId: scope.projectId },
  });
  const slaOff = inboxes
    .filter((i) => !effectiveRules(settings, i.rules).sla)
    .map((i) => i.id);
  const soon = new Date(at.getTime() + WINDOW);
  const tickets = await tx.supportTicket.findMany({
    where: {
      projectId: scope.projectId,
      mergedIntoTicketId: null,
      status: { in: SLA_ACTIVE_STATUSES },
      inboxId: { notIn: slaOff },
      OR: [
        { firstRespondedAt: null, firstResponseDueAt: { lt: soon } },
        { resolvedAt: null, resolutionDueAt: { lt: soon } },
      ],
    },
    take: 200,
  });
  let raised = 0;
  for (const ticket of tickets)
    for (const [clock, due] of pendingDues(ticket)) {
      const type =
        due.getTime() <= at.getTime()
          ? "sla_breached"
          : due.getTime() < soon.getTime()
            ? "sla_at_risk"
            : null;
      if (!type) continue;
      const seen = await tx.supportTicketEvent.count({
        where: {
          ticketId: ticket.id,
          type,
          after: { path: ["clock"], equals: clock },
        },
      });
      if (seen) continue;
      await ticketEvent(tx, scope, {
        ticketId: ticket.id,
        type,
        actorKind: "system",
        actorId: null,
        after: { clock, dueAt: due.toISOString() },
        createdAt: at,
      });
      await send(
        tx,
        scope,
        type === "sla_breached"
          ? "support_sla_breached"
          : "support_sla_at_risk",
        ticket,
        await responsible(scope, ticket),
      );
      raised++;
    }
  return raised;
}

/** When the ticket started waiting on the customer. */
async function waitingSince(tx: DbTx, ticket: TicketRow) {
  const events = await tx.supportTicketEvent.findMany({
    where: { ticketId: ticket.id, type: "status" },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const entered = events.find(
    (e) => (e.after as { status?: string }).status === "pending_customer",
  );
  return entered?.createdAt ?? ticket.updatedAt;
}

async function autoCloseSweep(tx: DbTx, scope: Scope, at: Date) {
  const settings = await supportSettings(tx, scope);
  const inboxes = await tx.supportInbox.findMany({
    where: { projectId: scope.projectId },
  });
  const tickets = await tx.supportTicket.findMany({
    where: { projectId: scope.projectId, status: "pending_customer" },
    take: 200,
  });
  let closed = 0;
  for (const ticket of tickets) {
    const rules = effectiveRules(
      settings,
      inboxes.find((i) => i.id === ticket.inboxId)?.rules,
    );
    if (!rules.autoClose) continue;
    const since = await waitingSince(tx, ticket);
    if (since.getTime() + rules.autoCloseDays * DAY > at.getTime()) continue;
    await tx.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: "closed",
        closedAt: at,
        resolvedAt: ticket.resolvedAt ?? at,
      },
    });
    await ticketEvent(tx, scope, {
      ticketId: ticket.id,
      type: "status",
      actorKind: "system",
      actorId: null,
      before: { status: "pending_customer" },
      after: { status: "closed", reason: "auto_close" },
      createdAt: at,
    });
    closed++;
  }
  return closed;
}

/** The support part of the per-project sweep (SLA timers, auto-close). */
export const supportScheduler: SchedulerContribution = {
  async sweep(tx, scope, at) {
    if (!(await supportActive(tx, scope))) return { queued: 0 };
    const raised = await slaSweep(tx, scope, at);
    const closed = await autoCloseSweep(tx, scope, at);
    return { queued: raised + closed };
  },
  async nextDueAt(tx, scope, at) {
    if (!(await supportActive(tx, scope))) return null;
    const tickets = await tx.supportTicket.findMany({
      where: {
        projectId: scope.projectId,
        mergedIntoTicketId: null,
        status: { in: [...SLA_ACTIVE_STATUSES, "pending_customer"] },
      },
      take: 500,
    });
    const settings = await supportSettings(tx, scope);
    let next: number | null = null;
    const consider = (t: number) => {
      if (t > at.getTime() && (next === null || t < next)) next = t;
    };
    for (const ticket of tickets) {
      if (ticket.status === "pending_customer") {
        consider(ticket.updatedAt.getTime() + settings.autoCloseDays * DAY);
        continue;
      }
      for (const [, due] of pendingDues(ticket)) {
        consider(due.getTime() - WINDOW);
        consider(due.getTime());
      }
    }
    return next === null ? null : new Date(next);
  },
};

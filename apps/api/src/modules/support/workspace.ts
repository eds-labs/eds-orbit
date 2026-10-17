import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import { supportAgents } from "./agents.ts";
import { deliverMessage } from "./channels/deliver.ts";
import { notifyAssigned, notifyMentions } from "./automations.ts";
import { SUPPORT_DRAFT, ticketAiCost } from "./ai.ts";
import { enqueue } from "../../platform/jobs/enqueue.ts";
import {
  attachFiles,
  dueTimes,
  OPEN_STATUSES,
  SLA_ACTIVE_STATUSES,
  SLA_AT_RISK_MINUTES,
  supportFiles,
  supportSettings,
  ticketEvent,
} from "./common.ts";

// The agent workspace (WP5.2): lists, the timeline, replies and notes, field
// changes, merges and contacts. Audits and events carry ids and field
// values only (Q-12a).

const STATUSES = [
  "new",
  "open",
  "pending_customer",
  "pending_internal",
  "resolved",
  "closed",
] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

const listInput = z
  .object({
    view: z.enum(["mine", "unassigned", "all"]).default("all"),
    status: z.enum(STATUSES).optional(),
    inboxId: z.uuid().optional(),
    category: z.string().max(41).optional(),
    priority: z.enum(PRIORITIES).optional(),
    q: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();

const cursorOf = (row: { updatedAt: Date; id: string }) =>
  Buffer.from(`${row.updatedAt.toISOString()}|${row.id}`).toString("base64url");
function parseCursor(raw: string) {
  const [at, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  const date = new Date(at ?? "");
  if (Number.isNaN(date.getTime()) || !z.uuid().safeParse(id).success)
    throw new DomainError("CURSOR_INVALID", 400);
  return { at: date, id: id! };
}

/** The contacts and message tickets a search term matches. */
async function searchMatches(tx: DbTx, scope: Scope, q: string) {
  const contacts = await tx.supportContact.findMany({
    where: {
      projectId: scope.projectId,
      OR: [
        { email: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
      ],
    },
    select: { id: true },
  });
  const messages = await tx.$queryRaw<{ ticketId: string }[]>`
    SELECT DISTINCT "ticketId" FROM "SupportMessage"
     WHERE "projectId" = ${scope.projectId}::uuid
       AND "searchVector" @@ plainto_tsquery('simple', ${q})`;
  return {
    contactIds: contacts.map((c) => c.id),
    ticketIds: messages.map((m) => m.ticketId),
  };
}

/** Tickets of the project, newest change first, with a keyset cursor. */
export async function listTickets(tx: DbTx, scope: Scope, raw: unknown) {
  const input = listInput.parse(raw);
  const and: object[] = [{ projectId: scope.projectId }];
  if (input.view === "mine") and.push({ assigneeUserId: scope.userId });
  if (input.view === "unassigned") and.push({ assigneeUserId: null });
  if (input.status) and.push({ status: input.status });
  if (input.inboxId) and.push({ inboxId: input.inboxId });
  if (input.category) and.push({ category: input.category });
  if (input.priority) and.push({ priority: input.priority });
  if (input.q) {
    const { contactIds, ticketIds } = await searchMatches(tx, scope, input.q);
    and.push({
      OR: [
        { subject: { contains: input.q, mode: "insensitive" } },
        { contactId: { in: contactIds } },
        { id: { in: ticketIds } },
      ],
    });
  }
  if (input.cursor) {
    const c = parseCursor(input.cursor);
    and.push({
      OR: [{ updatedAt: { lt: c.at } }, { updatedAt: c.at, id: { lt: c.id } }],
    });
  }
  const rows = await tx.supportTicket.findMany({
    where: { AND: and },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
  });
  const page = rows.slice(0, input.limit);
  const contacts = await tx.supportContact.findMany({
    where: { id: { in: [...new Set(page.map((t) => t.contactId))] } },
    select: { id: true, name: true, email: true },
  });
  return {
    items: page.map((t) => ({
      ...t,
      contact: contacts.find((c) => c.id === t.contactId) ?? null,
    })),
    nextCursor: rows.length > input.limit ? cursorOf(page.at(-1)!) : null,
  };
}

async function loadTicket(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.supportTicket.findFirst({
    where: { id, projectId: scope.projectId },
  });
  if (!row) throw new DomainError("TICKET_NOT_FOUND", 404);
  return row;
}

/** A ticket with its contact, inbox and timeline (messages and events). */
export async function ticketDetail(tx: DbTx, scope: Scope, id: string) {
  const ticket = await loadTicket(tx, scope, id);
  const [contact, inbox, messages, events] = await Promise.all([
    tx.supportContact.findFirst({ where: { id: ticket.contactId } }),
    tx.supportInbox.findFirst({
      where: { id: ticket.inboxId },
      select: { id: true, name: true, channels: true, aiMode: true },
    }),
    tx.supportMessage.findMany({
      where: { projectId: scope.projectId, ticketId: id },
    }),
    tx.supportTicketEvent.findMany({
      where: { projectId: scope.projectId, ticketId: id },
    }),
  ]);
  const attachments = await tx.supportAttachment.findMany({
    where: { messageId: { in: messages.map((m) => m.id) } },
  });
  const timeline = [
    ...messages.map((m) => ({
      ...m,
      attachments: attachments.filter((a) => a.messageId === m.id),
      order: 0,
    })),
    ...events.map((e) => ({ ...e, order: 1 })),
  ]
    .sort(
      (x, y) =>
        x.createdAt.getTime() - y.createdAt.getTime() || x.order - y.order,
    )
    .map(({ order: _order, ...item }) => item);
  return {
    ticket,
    contact,
    inbox,
    timeline,
    aiCostMicros: await ticketAiCost(tx, id),
  };
}

const replyInput = z
  .object({
    bodyText: z.string().trim().min(1).max(20_000),
    fileIds: z.array(z.uuid()).max(10).default([]),
  })
  .strict();

/**
 * An agent's reply to the customer. It waits as "pending" for the channel's
 * delivery job (WP5.3, WP5.4); the reply itself never sends anything.
 */
export async function replyToTicket(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
) {
  const input = replyInput.parse(raw);
  const ticket = await loadTicket(tx, scope, id);
  if (ticket.mergedIntoTicketId) throw new DomainError("TICKET_MERGED", 409);
  const files = await supportFiles(tx, scope, input.fileIds);
  const now = new Date();
  const message = await tx.supportMessage.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      ticketId: id,
      kind: "agent_reply",
      authorUserId: scope.userId,
      bodyText: input.bodyText,
      channel: ticket.channel,
      deliveryState: "pending",
      visibleToCustomer: true,
      createdAt: now,
    },
  });
  const attachments = await attachFiles(tx, scope, message.id, files);
  await deliverMessage(tx, scope, ticket, message);
  const status = ["new", "open", "resolved", "closed"].includes(ticket.status)
    ? "pending_customer"
    : ticket.status;
  await tx.supportTicket.update({
    where: { id },
    data: {
      status,
      firstRespondedAt: ticket.firstRespondedAt ?? now,
      ...(status !== ticket.status ? { resolvedAt: null, closedAt: null } : {}),
    },
  });
  if (status !== ticket.status)
    await ticketEvent(tx, scope, {
      ticketId: id,
      type: "status",
      actorKind: "user",
      actorId: scope.userId,
      before: { status: ticket.status },
      after: { status },
      createdAt: now,
    });
  await audit(tx, scope, "support.ticket.replied", id, {
    ticketId: id,
    messageId: message.id,
    attachments: attachments.length,
  });
  const delivered = await tx.supportMessage.findUniqueOrThrow({
    where: { id: message.id },
  });
  return { ...delivered, attachments };
}

const noteInput = z
  .object({ bodyText: z.string().trim().min(1).max(20_000) })
  .strict();

/** An internal note: agents only, never shown to the customer. */
export async function noteOnTicket(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
) {
  const input = noteInput.parse(raw);
  await loadTicket(tx, scope, id);
  const message = await tx.supportMessage.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      ticketId: id,
      kind: "internal_note",
      authorUserId: scope.userId,
      bodyText: input.bodyText,
      channel: "internal",
      visibleToCustomer: false,
    },
  });
  await tx.supportTicket.update({
    where: { id },
    data: { updatedAt: new Date() },
  });
  await notifyMentions(
    tx,
    scope,
    await loadTicket(tx, scope, id),
    input.bodyText,
  );
  await audit(tx, scope, "support.ticket.noted", id, {
    ticketId: id,
    messageId: message.id,
  });
  return { ...message, attachments: [] };
}

const updateInput = z
  .object({
    status: z.enum(STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    category: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,40}$/)
      .nullable()
      .optional(),
    tags: z
      .array(z.string().trim().min(1).max(40))
      .max(20)
      .transform((t) => [...new Set(t)])
      .optional(),
    assigneeUserId: z.string().min(1).max(100).nullable().optional(),
  })
  .strict();

/** Changes ticket fields: one event per changed field, SLA on priority. */
export async function updateTicket(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
) {
  const input = updateInput.parse(raw);
  const ticket = await loadTicket(tx, scope, id);
  const settings = await supportSettings(tx, scope);
  if (
    input.category &&
    !settings.categories.some((c) => c.key === input.category)
  )
    throw new DomainError("CATEGORY_UNKNOWN", 409);
  if (input.assigneeUserId) {
    const agents = await supportAgents(scope);
    if (!agents.some((a) => a.userId === input.assigneeUserId))
      throw new DomainError("ASSIGNEE_NOT_AGENT", 409);
  }
  const data: Record<string, unknown> = {};
  const changed: string[] = [];
  const now = new Date();
  const fields = [
    ["status", "status"],
    ["priority", "priority"],
    ["category", "category"],
    ["tags", "tags"],
    ["assigneeUserId", "assignee"],
  ] as const;
  for (const [field, type] of fields) {
    const next = input[field];
    if (next === undefined) continue;
    const prev = ticket[field];
    if (JSON.stringify(prev) === JSON.stringify(next)) continue;
    data[field] = next;
    changed.push(field);
    await ticketEvent(tx, scope, {
      ticketId: id,
      type,
      actorKind: "user",
      actorId: scope.userId,
      before: { [field]: prev },
      after: { [field]: next },
      createdAt: now,
    });
  }
  if (input.status && changed.includes("status")) {
    if (input.status === "resolved") data.resolvedAt = now;
    else if (input.status === "closed") {
      data.closedAt = now;
      data.resolvedAt = ticket.resolvedAt ?? now;
    } else {
      data.resolvedAt = null;
      data.closedAt = null;
    }
  }
  if (input.priority && changed.includes("priority")) {
    const due = dueTimes(settings, input.priority, ticket.createdAt);
    if (!ticket.firstRespondedAt)
      data.firstResponseDueAt = due.firstResponseDueAt;
    if (!ticket.resolvedAt) data.resolutionDueAt = due.resolutionDueAt;
  }
  if (!changed.length) return ticket;
  const updated = await tx.supportTicket.update({ where: { id }, data });
  if (changed.includes("assigneeUserId"))
    await notifyAssigned(tx, scope, updated);
  await audit(tx, scope, "support.ticket.updated", id, {
    ticketId: id,
    changed,
  });
  return updated;
}

const mergeInput = z.object({ intoTicketId: z.uuid() }).strict();

/** Moves a ticket's messages into another ticket and closes it. */
export async function mergeTicket(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
) {
  const { intoTicketId } = mergeInput.parse(raw);
  if (intoTicketId === id) throw new DomainError("MERGE_INTO_SELF", 409);
  const source = await loadTicket(tx, scope, id);
  const target = await loadTicket(tx, scope, intoTicketId);
  if (source.mergedIntoTicketId || target.mergedIntoTicketId)
    throw new DomainError("TICKET_MERGED", 409);
  // Two customers' conversations never share a ticket: merge the contacts
  // first (review fix 2).
  if (source.contactId !== target.contactId)
    throw new DomainError("MERGE_CONTACT_MISMATCH", 409);
  const now = new Date();
  await tx.supportMessage.updateMany({
    where: { projectId: scope.projectId, ticketId: id },
    data: { ticketId: intoTicketId },
  });
  await tx.supportTicket.update({
    where: { id },
    data: {
      mergedIntoTicketId: intoTicketId,
      status: "closed",
      closedAt: now,
      resolvedAt: source.resolvedAt ?? now,
    },
  });
  await tx.supportTicket.update({
    where: { id: intoTicketId },
    data: { updatedAt: now },
  });
  for (const [ticketId, after] of [
    [id, { mergedInto: intoTicketId }],
    [intoTicketId, { mergedFrom: id }],
  ] as const)
    await ticketEvent(tx, scope, {
      ticketId,
      type: "merge",
      actorKind: "user",
      actorId: scope.userId,
      after,
      createdAt: now,
    });
  await audit(tx, scope, "support.ticket.merged", id, {
    ticketId: id,
    intoTicketId,
  });
  return { ticketId: intoTicketId };
}

const contactListInput = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();

export async function listContacts(tx: DbTx, scope: Scope, raw: unknown) {
  const input = contactListInput.parse(raw);
  const rows = await tx.supportContact.findMany({
    where: {
      projectId: scope.projectId,
      deletedAt: null,
      ...(input.q
        ? {
            OR: [
              { email: { contains: input.q, mode: "insensitive" } },
              { name: { contains: input.q, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(input.cursor ? { id: { lt: input.cursor } } : {}),
    },
    orderBy: { id: "desc" },
    take: input.limit + 1,
  });
  const page = rows.slice(0, input.limit);
  return {
    items: page,
    nextCursor: rows.length > input.limit ? page.at(-1)!.id : null,
  };
}

async function loadContact(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.supportContact.findFirst({
    where: { id, projectId: scope.projectId, deletedAt: null },
  });
  if (!row) throw new DomainError("CONTACT_NOT_FOUND", 404);
  return row;
}

export async function contactDetail(tx: DbTx, scope: Scope, id: string) {
  const contact = await loadContact(tx, scope, id);
  const tickets = await tx.supportTicket.findMany({
    where: { projectId: scope.projectId, contactId: id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      number: true,
      subject: true,
      status: true,
      createdAt: true,
    },
  });
  return { ...contact, tickets };
}

const contactInput = z
  .object({
    name: z.string().trim().max(200).nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    locale: z.string().max(20).nullable().optional(),
  })
  .strict();

export async function updateContact(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
) {
  const input = contactInput.parse(raw);
  await loadContact(tx, scope, id);
  const updated = await tx.supportContact.update({
    where: { id },
    data: input,
  });
  await audit(tx, scope, "support.contact.updated", id, {
    contactId: id,
    changed: Object.keys(input).sort(),
  });
  return updated;
}

const contactMergeInput = z.object({ intoContactId: z.uuid() }).strict();

/** Moves a duplicate contact's tickets and identities, then tombstones it. */
export async function mergeContact(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
) {
  const { intoContactId } = contactMergeInput.parse(raw);
  if (intoContactId === id) throw new DomainError("MERGE_INTO_SELF", 409);
  const source = await loadContact(tx, scope, id);
  const target = await loadContact(tx, scope, intoContactId);
  const where = { projectId: scope.projectId, contactId: id };
  await tx.supportTicket.updateMany({
    where,
    data: { contactId: intoContactId },
  });
  await tx.supportContactIdentity.updateMany({
    where,
    data: { contactId: intoContactId },
  });
  await tx.supportMessage.updateMany({
    where: { projectId: scope.projectId, authorContactId: id },
    data: { authorContactId: intoContactId },
  });
  // The tombstone frees the address before the target takes it over.
  await tx.supportContact.update({
    where: { id },
    data: {
      deletedAt: new Date(),
      email: null,
      claimedEmail: null,
      name: null,
      notes: null,
      locale: null,
    },
  });
  if (!target.email && source.email)
    await tx.supportContact.update({
      where: { id: intoContactId },
      data: { email: source.email },
    });
  await audit(tx, scope, "support.contact.merged", id, {
    contactId: id,
    intoContactId,
  });
  return contactDetail(tx, scope, intoContactId);
}

/**
 * Counts for the home tile: open and unassigned tickets, and tickets whose
 * pending first response or resolution is due within the at-risk window
 * (at risk) or already overdue (breached).
 */
export async function ticketSummary(tx: DbTx, scope: Scope, now = new Date()) {
  const soon = new Date(now.getTime() + SLA_AT_RISK_MINUTES * 60_000);
  const base = { projectId: scope.projectId, mergedIntoTicketId: null };
  const active = { ...base, status: { in: SLA_ACTIVE_STATUSES } };
  const due = (range: object) => ({
    OR: [
      { firstRespondedAt: null, firstResponseDueAt: range },
      { resolvedAt: null, resolutionDueAt: range },
    ],
  });
  const [open, unassigned, breached, atRisk] = await Promise.all([
    tx.supportTicket.count({
      where: { ...base, status: { in: OPEN_STATUSES } },
    }),
    tx.supportTicket.count({
      where: { ...base, status: { in: OPEN_STATUSES }, assigneeUserId: null },
    }),
    tx.supportTicket.count({ where: { ...active, ...due({ lt: now }) } }),
    tx.supportTicket.count({
      where: {
        ...active,
        AND: [due({ gte: now, lt: soon }), { NOT: due({ lt: now }) }],
      },
    }),
  ]);
  return { open, unassigned, atRisk, breached };
}

/** Asks the AI for a new draft of the latest customer message (agents). */
export async function requestDraft(tx: DbTx, scope: Scope, id: string) {
  const ticket = await loadTicket(tx, scope, id);
  const inbox = await tx.supportInbox.findFirst({
    where: { id: ticket.inboxId },
  });
  if (inbox?.aiMode !== "draft") throw new DomainError("AI_OFF", 409);
  const message = await tx.supportMessage.findFirst({
    where: { ticketId: id, kind: "customer" },
    orderBy: { createdAt: "desc" },
  });
  if (!message) throw new DomainError("NOTHING_TO_ANSWER", 409);
  await enqueue(
    tx,
    scope,
    SUPPORT_DRAFT,
    id,
    `support-draft:${message.id}:${Date.now()}`,
  );
  return { queued: true };
}

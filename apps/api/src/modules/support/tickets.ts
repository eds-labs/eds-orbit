import { randomUUID } from "node:crypto";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import type { NormalizedInbound, SupportChannel } from "./channels/adapter.ts";
import { requireSupport } from "./gate.ts";
import { loadInbox } from "./inboxes.ts";
import {
  attachFiles,
  conversationChanged,
  dueTimes,
  supportFiles,
  supportSettings,
  ticketEvent,
} from "./common.ts";

// Ticket creation (WP5.1): the one entry the channels use for a new
// conversation. Runs in the caller's project transaction, which holds the
// project lock, so per-project numbers come from the counter without races.
// Message text, subjects and addresses stay in the support tables; audit and
// event rows carry ids and field values only (Q-12a).

const SUBJECT_MAX = 300;

export type CreatedTicket = {
  ticketId: string;
  number: number;
  contactId: string;
  messageId: string;
  /** True when the channel message was already recorded; nothing changed. */
  duplicate: boolean;
};

/**
 * The contact for an inbound message: by verified identity, then by e-mail.
 * A verified identity joins an existing contact by e-mail only when the
 * channel verified that e-mail too; otherwise anyone who can type an address
 * into the host app could attach themselves to another customer's history.
 */
export async function resolveContact(
  tx: DbTx,
  scope: Scope,
  inboxId: string,
  channel: SupportChannel,
  contact: NormalizedInbound["contact"],
) {
  const email = contact.email?.trim().toLowerCase() || null;
  const base = { workspaceId: scope.workspaceId, projectId: scope.projectId };
  if (contact.externalUserId) {
    const identity = await tx.supportContactIdentity.findFirst({
      where: {
        ...base,
        inboxId,
        channel,
        externalUserId: contact.externalUserId,
      },
    });
    if (identity) {
      const known = await tx.supportContact.findFirst({
        where: { ...base, id: identity.contactId, deletedAt: null },
      });
      if (known) return known.id;
    }
  }
  const matchByEmail =
    Boolean(email) &&
    (!contact.externalUserId || contact.emailVerified === true);
  const existing = matchByEmail
    ? await tx.supportContact.findFirst({
        where: { ...base, email, deletedAt: null },
      })
    : null;
  const id =
    existing?.id ??
    (
      await tx.supportContact.create({
        data: {
          id: randomUUID(),
          ...base,
          ...(matchByEmail || !email
            ? { email }
            : { email: null, claimedEmail: email }),
          name: contact.name?.trim().slice(0, 200) || null,
          locale: contact.locale?.slice(0, 20) || null,
        },
      })
    ).id;
  if (contact.externalUserId)
    await tx.supportContactIdentity.upsert({
      where: {
        projectId_inboxId_channel_externalUserId: {
          projectId: scope.projectId,
          inboxId,
          channel,
          externalUserId: contact.externalUserId,
        },
      },
      create: {
        id: randomUUID(),
        ...base,
        contactId: id,
        inboxId,
        channel,
        externalUserId: contact.externalUserId,
      },
      update: { contactId: id },
    });
  return id;
}

/** Opens a ticket for a customer's first message on a channel. */
export async function createTicket(
  tx: DbTx,
  scope: Scope,
  input: {
    inboxId: string;
    channel: SupportChannel;
    inbound: NormalizedInbound;
    now?: Date;
    /** The contact a channel already resolved (the widget's session). */
    contactId?: string;
  },
): Promise<CreatedTicket> {
  await requireSupport(tx, scope);
  const inbox = await loadInbox(tx, scope, input.inboxId);
  if (inbox.archivedAt) throw new DomainError("INBOX_ARCHIVED", 409);
  if (!inbox.channels.includes(input.channel))
    throw new DomainError("INBOX_CHANNEL_DISABLED", 409);
  const { inbound } = input;
  const base = { workspaceId: scope.workspaceId, projectId: scope.projectId };

  if (inbound.externalId) {
    const seen = await tx.supportMessage.findFirst({
      where: {
        ...base,
        channel: input.channel,
        externalId: inbound.externalId,
      },
    });
    if (seen) {
      const ticket = await tx.supportTicket.findFirstOrThrow({
        where: { ...base, id: seen.ticketId },
      });
      return {
        ticketId: ticket.id,
        number: ticket.number,
        contactId: ticket.contactId,
        messageId: seen.id,
        duplicate: true,
      };
    }
  }

  const now = input.now ?? new Date();
  const contactId =
    input.contactId ??
    (await resolveContact(tx, scope, inbox.id, input.channel, inbound.contact));
  const settings = await supportSettings(tx, scope);
  // Adapters store files first; only live support files of the project count.
  const files = await supportFiles(
    tx,
    scope,
    inbound.attachments.map((a) => a.fileId),
  );
  // Never max(number)+1: a deleted newest ticket must not hand on its number.
  const counter = await tx.supportTicketCounter.upsert({
    where: { projectId: scope.projectId },
    create: { ...base, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });
  const ticket = await tx.supportTicket.create({
    data: {
      id: randomUUID(),
      ...base,
      number: counter.lastNumber,
      inboxId: inbox.id,
      contactId,
      subject: inbound.subject.trim().slice(0, SUBJECT_MAX) || "(no subject)",
      category: inbox.defaultCategory,
      channel: input.channel,
      ...dueTimes(settings, "normal", now),
      lastCustomerMessageAt: now,
      createdAt: now,
    },
  });
  const message = await tx.supportMessage.create({
    data: {
      id: randomUUID(),
      ...base,
      ticketId: ticket.id,
      kind: "customer",
      authorContactId: contactId,
      bodyText: inbound.bodyText,
      bodyHtml: inbound.bodyHtml ?? null,
      channel: input.channel,
      externalId: inbound.externalId,
      visibleToCustomer: true,
      createdAt: now,
    },
  });
  await attachFiles(
    tx,
    scope,
    message.id,
    files.map((file, i) => ({
      ...file,
      name: inbound.attachments[i]!.name || file.name,
    })),
  );
  await ticketEvent(tx, scope, {
    ticketId: ticket.id,
    type: "created",
    actorKind: "contact",
    actorId: contactId,
    after: {
      status: ticket.status,
      priority: ticket.priority,
      category: ticket.category,
    },
    createdAt: now,
  });
  conversationChanged(tx, scope, ticket.id);
  await audit(tx, scope, "support.ticket.created", ticket.id, {
    ticketId: ticket.id,
    number: ticket.number,
    channel: input.channel,
  });
  return {
    ticketId: ticket.id,
    number: ticket.number,
    contactId,
    messageId: message.id,
    duplicate: false,
  };
}

type TicketRow = Awaited<ReturnType<DbTx["supportTicket"]["findFirstOrThrow"]>>;

/**
 * The customer's next message on an existing ticket, from any channel:
 * reopens a ticket waiting on the customer, resolved or closed (unless the
 * message is automatic or `reopenOnReply` is off).
 */
export async function appendCustomerMessage(
  tx: DbTx,
  scope: Scope,
  ticket: TicketRow,
  input: {
    bodyText: string;
    channel: SupportChannel;
    externalId: string | null;
    files?: Array<{ fileId: string; name: string }>;
    automatic?: boolean;
  },
) {
  await requireSupport(tx, scope);
  const now = new Date();
  const message = await tx.supportMessage.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      ticketId: ticket.id,
      kind: "customer",
      authorContactId: ticket.contactId,
      bodyText: input.bodyText,
      channel: input.channel,
      externalId: input.externalId,
      visibleToCustomer: true,
      createdAt: now,
    },
  });
  const files = await supportFiles(
    tx,
    scope,
    (input.files ?? []).map((f) => f.fileId),
  );
  await attachFiles(
    tx,
    scope,
    message.id,
    files.map((file, i) => ({
      ...file,
      name: input.files![i]!.name || file.name,
    })),
  );
  const settings = await supportSettings(tx, scope);
  const reopen =
    !input.automatic &&
    settings.reopenOnReply &&
    ["pending_customer", "resolved", "closed"].includes(ticket.status);
  await tx.supportTicket.update({
    where: { id: ticket.id },
    data: {
      lastCustomerMessageAt: now,
      ...(reopen ? { status: "open", resolvedAt: null, closedAt: null } : {}),
    },
  });
  if (reopen)
    await ticketEvent(tx, scope, {
      ticketId: ticket.id,
      type: "status",
      actorKind: "contact",
      actorId: ticket.contactId,
      before: { status: ticket.status },
      after: { status: "open" },
      createdAt: now,
    });
  conversationChanged(tx, scope, ticket.id);
  return message;
}

import { z } from "zod";
import PostalMime from "postal-mime";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { emailMailboxes } from "../../platform/email/connection.ts";
import { cleanText, normalized } from "../../platform/email/inbound.ts";
import type {
  EmailImportDestination,
  EmailImportMessage,
  EmailImportMode,
  EmailImportPrepared,
  EmailImportRecordHit,
  EmailImportTarget,
} from "../../platform/email/import-contract.ts";
import { connectionVerified } from "../../platform/connections/connections.ts";
import { deleteFile } from "../../platform/files/files.ts";
import { audit, data, DomainError } from "../../shared.ts";
import { storeParsedAttachments } from "./channels/email.ts";
import { inboundExternalId, supportSettings } from "./common.ts";
import { requireSupport, supportActive } from "./gate.ts";
import { SUPPORT_TICKETS_IMPORT } from "./permissions.ts";
import type { SupportPriority } from "./settings.ts";
import {
  appendCustomerMessage,
  createTicket,
  resolveContact,
} from "./tickets.ts";
import { TICKET_PRIORITIES } from "./workspace.ts";

// A member turns one message of a mailbox into a ticket (ADR 0026). `prepare`
// runs outside any project transaction, because storing files takes the
// project lock itself; `commit` runs inside the caller's. The ticket keeps
// `channel: "email"` and carries `importSource`: no AI job, no domain event
// and no mail to the customer come of it.

const IMPORT_SOURCE = "mailbox_import";
const RECORD_LIMIT = 20;
const email = z.email().max(320);

type Payload = {
  inboundId: string;
  messageId: string;
  from: string | null;
  fromName: string | null;
  replyTo: string | null;
  subject: string;
  text: string;
  files: Array<{ fileId: string; name: string; mime: string; size: number }>;
};

/** A parsed address, lowercase, or null when it is not a usable one. */
function address(value: string | null | undefined) {
  const parsed = email.safeParse((value ?? "").trim());
  return parsed.success ? parsed.data.toLowerCase() : null;
}

/** Inboxes a taken-over ticket can be answered from: their own verified mailbox. */
async function replyableInboxes(tx: DbTx, scope: Scope) {
  const mailboxes = (await emailMailboxes(tx, scope)).filter((row) =>
    connectionVerified(data(row).status),
  );
  const inboxes = await tx.supportInbox.findMany({
    where: {
      projectId: scope.projectId,
      archivedAt: null,
      emailConnectionId: { not: null },
    },
    orderBy: { createdAt: "asc" },
  });
  return inboxes.flatMap((inbox) => {
    const mailbox = mailboxes.find((m) => m.id === inbox.emailConnectionId);
    return inbox.channels.includes("email") && mailbox
      ? [{ inbox, address: String(data(mailbox).fromAddress) }]
      : [];
  });
}

/** Follows merges to the ticket that holds the conversation now. */
async function liveTicket(tx: DbTx, scope: Scope, id: string) {
  let ticketId = id;
  for (let i = 0; i < 10; i++) {
    const ticket = await tx.supportTicket.findFirst({
      where: { id: ticketId, projectId: scope.projectId },
    });
    if (!ticket?.mergedIntoTicketId) return ticket;
    ticketId = ticket.mergedIntoTicketId;
  }
  return null;
}

const recordedMessage = (tx: DbTx, scope: Scope, externalId: string) =>
  tx.supportMessage.findFirst({
    where: { projectId: scope.projectId, channel: "email", externalId },
  });

/**
 * What the message is already recorded as. A Message-ID is only a claim: an
 * existing message of another contact stays that contact's, and this one is
 * recorded under its own stand-in id instead of joining their ticket.
 */
async function existingRecord(
  tx: DbTx,
  scope: Scope,
  payload: Payload,
  senders: ReadonlySet<string>,
) {
  const standIn = inboundExternalId(payload.inboundId);
  const repeated = await recordedMessage(tx, scope, standIn);
  if (repeated)
    return {
      ticket: await liveTicket(tx, scope, repeated.ticketId),
      externalId: standIn,
    };
  if (!payload.messageId) return { ticket: null, externalId: standIn };
  const seen = await recordedMessage(tx, scope, payload.messageId);
  if (!seen) return { ticket: null, externalId: payload.messageId };
  const ticket = await liveTicket(tx, scope, seen.ticketId);
  const contact = await tx.supportContact.findFirst({
    where: {
      projectId: scope.projectId,
      id: seen.authorContactId ?? ticket?.contactId,
    },
  });
  const own =
    Boolean(contact?.email && senders.has(contact.email)) ||
    Boolean(contact?.claimedEmail && senders.has(contact.claimedEmail));
  return own
    ? { ticket, externalId: payload.messageId }
    : { ticket: null, externalId: standIn };
}

function validated(
  value: string | undefined,
  allowed: readonly string[],
  code: string,
) {
  if (value !== undefined && !allowed.includes(value))
    throw new DomainError(code, 400);
  return value;
}

async function commitCreate(
  tx: DbTx,
  scope: Scope,
  prepared: EmailImportPrepared,
  payload: Payload,
  mode: Extract<EmailImportMode, { kind: "create" }>,
) {
  const destination = (await replyableInboxes(tx, scope)).find(
    (d) => d.inbox.id === mode.destinationId,
  );
  if (!destination)
    throw new DomainError("EMAIL_IMPORT_DESTINATION_INVALID", 409);
  const settings = await supportSettings(tx, scope);
  const priority = validated(
    mode.priority,
    TICKET_PRIORITIES,
    "EMAIL_IMPORT_PRIORITY_INVALID",
  ) as SupportPriority | undefined;
  if (mode.category)
    validated(
      mode.category,
      settings.categories.map((c) => c.key),
      "EMAIL_IMPORT_CATEGORY_INVALID",
    );
  const from = address(payload.from);
  const answerAt =
    mode.customerAddress === "reply_to" && payload.replyTo
      ? address(payload.replyTo)
      : from;
  // Before any contact exists: a bad address must not become one.
  if (!answerAt) throw new DomainError("EMAIL_IMPORT_ADDRESS_INVALID", 400);
  const senders = new Set([answerAt, ...(from ? [from] : [])]);
  const known = await existingRecord(tx, scope, payload, senders);
  if (known.ticket)
    return {
      recordId: known.ticket.id,
      number: known.ticket.number,
      duplicate: true,
    };
  const created = await createTicket(tx, scope, {
    inboxId: destination.inbox.id,
    channel: "email",
    inbound: {
      externalId: known.externalId,
      contact: {
        email: answerAt,
        ...(payload.fromName ? { name: payload.fromName } : {}),
      },
      subject: cleanText(mode.subject, 300) || payload.subject,
      bodyText: payload.text || "(no text)",
      attachments: payload.files,
    },
    import: {
      source: IMPORT_SOURCE,
      ...(priority ? { priority } : {}),
      ...(mode.category !== undefined
        ? { category: mode.category || null }
        : {}),
    },
  });
  await audit(tx, scope, "support.ticket.imported", created.ticketId, {
    ticketId: created.ticketId,
    inboundId: payload.inboundId,
    skippedAttachments: prepared.skippedAttachments,
  });
  return {
    recordId: created.ticketId,
    number: created.number,
    duplicate: created.duplicate,
  };
}

async function commitAppend(
  tx: DbTx,
  scope: Scope,
  prepared: EmailImportPrepared,
  payload: Payload,
  recordId: string,
) {
  const target = await liveTicket(tx, scope, recordId);
  if (!target) throw new DomainError("TICKET_NOT_FOUND", 404);
  const from = address(payload.from);
  const known = await existingRecord(
    tx,
    scope,
    payload,
    new Set(from ? [from] : []),
  );
  if (known.ticket)
    return {
      recordId: known.ticket.id,
      number: known.ticket.number,
      duplicate: true,
    };
  const contact = await tx.supportContact.findFirst({
    where: { projectId: scope.projectId, id: target.contactId },
  });
  // Someone else writing on this ticket is not its customer writing.
  const author =
    from && contact?.email !== from
      ? await resolveContact(tx, scope, target.inboxId, "email", {
          email: from,
          ...(payload.fromName ? { name: payload.fromName } : {}),
        })
      : from
        ? undefined
        : null;
  await appendCustomerMessage(tx, scope, target, {
    bodyText: payload.text || "(no text)",
    channel: "email",
    externalId: known.externalId,
    files: payload.files,
    import: {
      source: IMPORT_SOURCE,
      ...(author !== undefined ? { authorContactId: author } : {}),
    },
  });
  await audit(tx, scope, "support.ticket.imported", target.id, {
    ticketId: target.id,
    inboundId: payload.inboundId,
    skippedAttachments: prepared.skippedAttachments,
  });
  return { recordId: target.id, number: target.number, duplicate: false };
}

export const ticketImportTarget: EmailImportTarget = {
  label: { en: "Support ticket", de: "Support-Ticket" },
  permission: SUPPORT_TICKETS_IMPORT,
  active: supportActive,

  async destinations(tx, scope): Promise<EmailImportDestination[]> {
    const settings = await supportSettings(tx, scope);
    return (await replyableInboxes(tx, scope)).map(({ inbox, address }) => ({
      id: inbox.id,
      name: inbox.name,
      address,
      categories: settings.categories.map((c) => c.key),
      priorities: TICKET_PRIORITIES,
    }));
  },

  async searchRecords(tx, scope, query): Promise<EmailImportRecordHit[]> {
    const q = query.trim();
    const number = /^#?(\d{1,9})$/.exec(q)?.[1];
    // A record id as well: a replayed takeover finds its number that way,
    // even after that ticket was merged. Searches offer only live tickets.
    const id = z.uuid().safeParse(q).success ? q : null;
    const live = { mergedIntoTicketId: null };
    const tickets = await tx.supportTicket.findMany({
      where: {
        projectId: scope.projectId,
        ...(q
          ? {
              OR: [
                {
                  ...live,
                  subject: { contains: q, mode: "insensitive" as const },
                },
                ...(number ? [{ ...live, number: Number(number) }] : []),
                ...(id ? [{ id }] : []),
              ],
            }
          : live),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: RECORD_LIMIT,
    });
    return tickets.map((t) => ({
      id: t.id,
      number: t.number,
      title: t.subject,
      status: t.status,
    }));
  },

  async prepare(
    scope,
    message: EmailImportMessage,
  ): Promise<EmailImportPrepared> {
    let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
    try {
      parsed = await PostalMime.parse(message.source);
    } catch {
      throw new DomainError("EMAIL_IMPORT_UNREADABLE", 422);
    }
    const fields = normalized(parsed);
    const { files, skipped } = await storeParsedAttachments(scope, parsed);
    const payload: Payload = {
      inboundId: message.inboundId,
      messageId: fields.messageId,
      from: fields.from,
      fromName: fields.fromName,
      replyTo: cleanText(parsed.replyTo?.[0]?.address, 320) || null,
      subject: fields.subject,
      text: fields.text,
      files,
    };
    return {
      fileIds: files.map((f) => f.fileId),
      skippedAttachments: skipped,
      payload,
    };
  },

  async commit(tx, scope, prepared, mode) {
    await requireSupport(tx, scope);
    const payload = prepared.payload as Payload;
    return mode.kind === "create"
      ? commitCreate(tx, scope, prepared, payload, mode)
      : commitAppend(tx, scope, prepared, payload, mode.recordId);
  },

  async discard(scope, prepared) {
    for (const id of prepared.fileIds)
      await deleteFile(scope, id).catch(() => undefined);
  },
};

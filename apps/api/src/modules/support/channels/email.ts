import PostalMime from "postal-mime";
import { randomUUID } from "node:crypto";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  defaultEmailConnection,
  emailEnabled,
  verifiedEmailConnection,
} from "../../../platform/email/connection.ts";
import { INBOUND_KIND } from "../../../platform/email/inbound.ts";
import {
  EMAIL_KIND,
  ORBIT_MESSAGE_ID,
  orbitMessageId,
  queueEmail,
} from "../../../platform/email/send.ts";
import {
  allowedFileTypes,
  deleteFile,
  filesConfig,
  readFile,
  storeFile,
} from "../../../platform/files/files.ts";
import type { PeriodicTask } from "../../../platform/jobs/types.ts";
import { audit, data } from "../../../shared.ts";
import { supportSettings } from "../common.ts";
import { effectiveRules } from "../settings.ts";
import { supportActive } from "../gate.ts";
import { appendCustomerMessage, createTicket } from "../tickets.ts";
import { allowNewTicket } from "../privacy.ts";

// The support e-mail channel (WP5.3) on the project's WP4.7 mailboxes.
// Inbound: the platform polls IMAP per mailbox, stores each message as an
// `inbound_emails` row (with the receiving `connectionId`) and its raw MIME
// as a platform file, and queues `support_email_inbound`; the mail goes to
// the inbox bound to the receiving mailbox. Outbound: replies and
// acknowledgements go through `queueEmail` on the ticket inbox's mailbox,
// whose job never resends after an ambiguous transmit; the periodic sync
// copies the outcome onto the support message.

export const SUPPORT_EMAIL_INBOUND = "support_email_inbound";
const MAX_ATTACHMENTS = 10;
const ACKS_PER_DAY = 3;
const TOKEN = /\[#(\d{1,9})\]/;

const lower = (v: unknown) =>
  typeof v === "string" ? v.trim().toLowerCase() : "";

/** "Re: <subject> [#<number>]", one line, without stacked prefixes. */
export function replySubject(subject: string, number: number) {
  const base = subject
    .replace(/\s*\[#\d+\]\s*/g, " ")
    .replace(/^\s*((re|aw|fwd?|wg)\s*:\s*)+/i, "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 160);
  return `Re: ${base || "Support"} [#${number}]`;
}

type TicketRow = Awaited<ReturnType<DbTx["supportTicket"]["findFirstOrThrow"]>>;
type MessageRow = Awaited<
  ReturnType<DbTx["supportMessage"]["findFirstOrThrow"]>
>;

/**
 * The mailbox a ticket's mail leaves from: its inbox's bound mailbox while
 * that is verified; an inbox without one (widget-only, from before the
 * binding, or archived after its mailbox was removed) uses the default.
 */
async function ticketMailbox(tx: DbTx, scope: Scope, ticket: TicketRow) {
  const inbox = await tx.supportInbox.findFirst({
    where: { id: ticket.inboxId, projectId: scope.projectId },
  });
  return inbox?.emailConnectionId
    ? verifiedEmailConnection(tx, scope, inbox.emailConnectionId)
    : defaultEmailConnection(tx, scope);
}

/**
 * Queues one customer-visible message of an e-mail ticket as mail to its
 * contact, threaded on the ticket's earlier mails, through the inbox's
 * mailbox. Returns the delivery state: "pending" when queued, "not_sent"
 * without e-mail, a verified mailbox or a contact address.
 */
export async function queueEmailMessage(
  tx: DbTx,
  scope: Scope,
  ticket: TicketRow,
  message: MessageRow,
  options: { automatic?: boolean; to?: string } = {},
): Promise<string> {
  const notSent = async () => {
    await tx.supportMessage.update({
      where: { id: message.id },
      data: { deliveryState: "not_sent" },
    });
    return "not_sent";
  };
  if (!emailEnabled()) return notSent();
  const connection = await ticketMailbox(tx, scope, ticket);
  const contact = await tx.supportContact.findFirst({
    where: { id: ticket.contactId, deletedAt: null },
  });
  const to = options.to ?? contact?.email;
  if (!connection || !to) return notSent();
  const thread = await tx.supportMessage.findMany({
    where: {
      projectId: scope.projectId,
      ticketId: ticket.id,
      externalId: { not: null },
    },
    orderBy: { createdAt: "asc" },
  });
  const lastCustomer = thread.filter((m) => m.kind === "customer").at(-1);
  const row = await queueEmail(tx, scope, {
    to: [to],
    subject: replySubject(ticket.subject, ticket.number),
    text: message.bodyText,
    moduleId: "support",
    automatic: options.automatic ?? false,
    ...(lastCustomer?.externalId ? { inReplyTo: lastCustomer.externalId } : {}),
    references: thread.map((m) => m.externalId!).slice(-20),
    connectionId: connection.id,
  });
  await tx.supportMessage.update({
    where: { id: message.id },
    data: {
      deliveryState: "pending",
      externalId: orbitMessageId(row.id, data(connection).fromAddress),
    },
  });
  return "pending";
}

type Inbound = {
  /** The mailbox that received it (platform). */
  connectionId?: string;
  messageId?: string | null;
  from?: string | null;
  fromName?: string | null;
  to?: string[];
  cc?: string[];
  subject?: string;
  text?: string;
  inReplyTo?: string | null;
  references?: string[];
  automatic?: boolean;
  /** Unread mail from before the mailbox's first sync (platform). */
  backlog?: boolean;
  fileId?: string;
};

/** Stores the mail's allowed attachments as support files; counts the rest. */
async function storeAttachments(scope: Scope, fileId: string | undefined) {
  if (!fileId || !filesConfig()) return { files: [], skipped: 0 };
  const { bytes } = await readFile(scope, fileId);
  const parsed = await PostalMime.parse(bytes);
  const allowed = new Set(allowedFileTypes());
  const files: Array<{
    fileId: string;
    name: string;
    mime: string;
    size: number;
  }> = [];
  let skipped = 0;
  for (const attachment of parsed.attachments ?? []) {
    const mime = lower(attachment.mimeType).split(";")[0]!;
    if (files.length >= MAX_ATTACHMENTS || !allowed.has(mime)) {
      skipped++;
      continue;
    }
    const content =
      typeof attachment.content === "string"
        ? Buffer.from(attachment.content)
        : new Uint8Array(attachment.content);
    try {
      const stored = await storeFile(
        { ...scope, userId: "support-email" },
        {
          moduleId: "support",
          bytes: content,
          mime,
          name: attachment.filename ?? "attachment",
        },
      );
      files.push({
        fileId: stored.id,
        name: stored.name ?? "attachment",
        mime: stored.mime,
        size: stored.size,
      });
    } catch {
      skipped++;
    }
  }
  return { files, skipped };
}

/** The ticket an inbound mail answers: by headers, then by subject token. */
async function threadedTicket(tx: DbTx, scope: Scope, mail: Inbound) {
  const ids = [mail.inReplyTo, ...(mail.references ?? [])].filter(
    (v): v is string => Boolean(v),
  );
  let ticketId: string | null = null;
  if (ids.length) {
    const hit = await tx.supportMessage.findFirst({
      where: {
        projectId: scope.projectId,
        externalId: { in: ids },
      },
      orderBy: { createdAt: "desc" },
    });
    ticketId = hit?.ticketId ?? null;
    // Headers are easy to copy: they thread only from the ticket's own
    // contact; anyone else opens a new ticket (review fix 1).
    if (ticketId) {
      const owner = await tx.supportTicket.findFirst({
        where: { id: ticketId },
      });
      const contact = owner
        ? await tx.supportContact.findFirst({ where: { id: owner.contactId } })
        : null;
      if (!contact?.email || contact.email !== lower(mail.from))
        ticketId = null;
    }
  }
  if (!ticketId) {
    const token = TOKEN.exec(mail.subject ?? "");
    if (token) {
      const candidate = await tx.supportTicket.findFirst({
        where: { projectId: scope.projectId, number: Number(token[1]) },
      });
      const contact = candidate
        ? await tx.supportContact.findFirst({
            where: { id: candidate.contactId },
          })
        : null;
      // The token alone is guessable: it counts only from the ticket's contact.
      const from = lower(mail.from);
      if (candidate && from && contact?.email === from) ticketId = candidate.id;
    }
  }
  // Follow merges to the ticket that holds the conversation now.
  for (let i = 0; ticketId && i < 10; i++) {
    const ticket = await tx.supportTicket.findFirst({
      where: { id: ticketId, projectId: scope.projectId },
    });
    if (!ticket?.mergedIntoTicketId) return ticket;
    ticketId = ticket.mergedIntoTicketId;
  }
  return null;
}

/**
 * The live e-mail inbox for a mail: among the inboxes bound to the mailbox
 * that received it, the one it was addressed to, else the only one. The
 * receiving mailbox decides, never an owner-typed address alone (WP5.3).
 * Only while no inbox is bound to it, mail of the default mailbox goes to
 * the unbound inboxes from before the binding, as it did then: the one it
 * was addressed to, else the only one.
 */
async function routedInbox(tx: DbTx, scope: Scope, mail: Inbound) {
  const inboxes = (
    await tx.supportInbox.findMany({
      where: { projectId: scope.projectId, archivedAt: null },
      orderBy: { createdAt: "asc" },
    })
  ).filter((i) => i.channels.includes("email"));
  const recipients = new Set(
    [...(mail.to ?? []), ...(mail.cc ?? [])].map(lower),
  );
  const pick = (candidates: typeof inboxes) =>
    candidates.find((i) => recipients.has(lower(i.emailAddress))) ??
    (candidates.length === 1 ? candidates[0]! : null);
  const bound = inboxes.filter(
    (i) => i.emailConnectionId && i.emailConnectionId === mail.connectionId,
  );
  if (bound.length) return pick(bound);
  const fallback = await defaultEmailConnection(tx, scope);
  if (!fallback || fallback.id !== mail.connectionId) return null;
  return pick(inboxes.filter((i) => !i.emailConnectionId));
}

function ackText(language: string, inbox: string, number: number) {
  return language === "de"
    ? `Danke für Ihre Nachricht an ${inbox}. Wir haben sie erhalten und melden uns so bald wie möglich. Ihre Ticketnummer ist #${number}. Bitte lassen Sie [#${number}] im Betreff, wenn Sie antworten.`
    : `Thank you for contacting ${inbox}. We received your message and will get back to you as soon as we can. Your ticket number is #${number}. Please keep [#${number}] in the subject when you reply.`;
}

/** Sends the automatic acknowledgement of a new ticket, within the limits. */
async function acknowledge(
  tx: DbTx,
  scope: Scope,
  ticketId: string,
  inbox: { name: string; language: string },
) {
  const ticket = await tx.supportTicket.findFirstOrThrow({
    where: { id: ticketId },
  });
  const since = new Date(Date.now() - 24 * 3600_000);
  const recent = await tx.supportMessage.count({
    where: {
      projectId: scope.projectId,
      kind: "system",
      channel: "email",
      createdAt: { gte: since },
      ticketId: {
        in: (
          await tx.supportTicket.findMany({
            where: { projectId: scope.projectId, contactId: ticket.contactId },
            select: { id: true },
          })
        ).map((t) => t.id),
      },
    },
  });
  if (recent >= ACKS_PER_DAY) return false;
  const message = await tx.supportMessage.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      ticketId,
      kind: "system",
      bodyText: ackText(inbox.language, inbox.name, ticket.number),
      channel: "email",
      deliveryState: "pending",
      visibleToCustomer: true,
    },
  });
  await queueEmailMessage(tx, scope, ticket, message, { automatic: true });
  return true;
}

/**
 * The job of one inbound mail: a new ticket, or the next message of the
 * ticket it answers. Automatic mail never opens a ticket, reopens one or
 * gets an acknowledgement, and neither does backlog mail from before the
 * mailbox's first sync. Recorded once per Message-ID.
 */
export async function handleInboundEmail(scope: Scope, inboundId: string) {
  const prepared = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      if (!(await supportActive(tx, scope))) return null;
      const row = await tx.entity.findFirst({
        where: {
          id: inboundId,
          projectId: scope.projectId,
          kind: INBOUND_KIND,
        },
      });
      if (!row) return null;
      const mail = data(row) as Inbound;
      const externalId =
        mail.messageId || `<inbound.${inboundId}@orbit.invalid>`;
      const seen = await tx.supportMessage.findFirst({
        where: { projectId: scope.projectId, channel: "email", externalId },
      });
      return seen ? null : { mail, externalId };
    },
  );
  if (!prepared) return;
  const { mail, externalId } = prepared;
  const { files, skipped } = await storeAttachments(scope, mail.fileId);
  try {
    await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const inbox = await routedInbox(tx, scope, mail);
      if (!inbox) {
        await audit(tx, scope, "support.email.unrouted", inboundId, {
          inboundId,
        });
        throw new UnroutedMail();
      }
      const ticket = await threadedTicket(tx, scope, mail);
      if (!ticket && mail.automatic) {
        await audit(tx, scope, "support.email.ignored_automatic", inboundId, {
          inboundId,
        });
        throw new UnroutedMail();
      }
      if (
        !ticket &&
        mail.from &&
        !(await allowNewTicket(tx, scope, mail.from))
      ) {
        // Abuse cap (WP5.8): too many new tickets from one sender this hour.
        await audit(tx, scope, "support.email.rate_limited", inboundId, {
          inboundId,
        });
        throw new UnroutedMail();
      }
      if (!ticket) {
        const created = await createTicket(tx, scope, {
          inboxId: inbox.id,
          channel: "email",
          inbound: {
            externalId,
            contact: {
              ...(mail.from ? { email: mail.from } : {}),
              ...(mail.fromName ? { name: mail.fromName } : {}),
            },
            subject: mail.subject ?? "",
            bodyText: mail.text || "(no text)",
            attachments: files,
          },
        });
        const settings = await supportSettings(tx, scope);
        // Mail from before the first sync is old: no acknowledgement now.
        if (!mail.backlog && effectiveRules(settings, inbox.rules).autoAck)
          await acknowledge(tx, scope, created.ticketId, inbox);
        await audit(tx, scope, "support.email.received", created.ticketId, {
          ticketId: created.ticketId,
          inboundId,
          skippedAttachments: skipped,
          ...(mail.backlog ? { backlog: true } : {}),
        });
        return;
      }
      await appendCustomerMessage(tx, scope, ticket, {
        bodyText: mail.text || "(no text)",
        channel: "email",
        externalId,
        files,
        automatic: mail.automatic === true,
      });
      await audit(tx, scope, "support.email.received", ticket.id, {
        ticketId: ticket.id,
        inboundId,
        skippedAttachments: skipped,
      });
    });
  } catch (error) {
    // Nothing was recorded: the stored attachments must not linger.
    for (const file of files)
      await deleteFile(scope, file.fileId).catch(() => undefined);
    if (!(error instanceof UnroutedMail)) throw error;
  }
}

class UnroutedMail extends Error {}

const STATE: Record<string, string> = {
  queued: "pending",
  sending: "pending",
  retry: "pending",
  sent: "sent",
  rejected: "rejected",
  failed: "not_sent",
  skipped: "not_sent",
  test_receipt: "not_sent",
  outcome_unknown: "unknown",
};

/**
 * Copies the outcome of queued support mail onto its messages: the
 * `email_messages` row named by the Orbit Message-ID decides, and a later
 * bounce wins over "sent".
 */
export async function syncEmailDelivery(scope: Scope) {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    if (!(await supportActive(tx, scope))) return { status: "inactive" };
    const messages = await tx.supportMessage.findMany({
      where: {
        projectId: scope.projectId,
        channel: { in: ["email", "widget"] },
        kind: { not: "customer" },
        externalId: { startsWith: "<orbit." },
        // Pending always; sent ones only while a bounce can still come
        // (30 days), newest first, so the sync never starves (review fix 9).
        OR: [
          { deliveryState: "pending" },
          {
            deliveryState: "sent",
            createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    let changed = 0;
    for (const message of messages) {
      const rowId = [...message.externalId!.matchAll(ORBIT_MESSAGE_ID)][0]?.[1];
      if (!rowId) continue;
      const row = await tx.entity.findFirst({
        where: { id: rowId, projectId: scope.projectId, kind: EMAIL_KIND },
      });
      if (!row) continue;
      const mail = data(row);
      const next =
        mail.deliveryState === "bounced"
          ? "bounced"
          : (STATE[String(mail.status)] ?? message.deliveryState);
      const externalId =
        typeof mail.messageId === "string"
          ? mail.messageId
          : message.externalId;
      if (next === message.deliveryState && externalId === message.externalId)
        continue;
      await tx.supportMessage.update({
        where: { id: message.id },
        data: { deliveryState: next, externalId },
      });
      changed++;
    }
    return { status: changed ? `synced ${changed}` : "idle" };
  });
}

/** The periodic task that keeps delivery states current. */
export const supportEmailDelivery: PeriodicTask = {
  name: "support-email-delivery",
  async run(scope) {
    const result = await syncEmailDelivery(scope);
    return { status: result.status };
  },
};

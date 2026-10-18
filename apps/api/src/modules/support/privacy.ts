import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { INBOUND_KIND } from "../../platform/email/inbound.ts";
import { EMAIL_KIND, ORBIT_MESSAGE_ID } from "../../platform/email/send.ts";
import { deleteFile, filesConfig } from "../../platform/files/files.ts";
import type { PeriodicTask } from "../../platform/jobs/types.ts";
import { audit, data, DomainError, update } from "../../shared.ts";
import { supportSettings } from "./common.ts";
import { requireSupport, supportActive } from "./gate.ts";
import { WIDGET_SESSION_KIND } from "./widget.ts";

// Support privacy and operations (WP5.8; Q-12b): export and erasure per
// contact, retention by the project's settings, and abuse caps. Erasure
// removes the support rows and their files, the widget sessions, and the
// mailbox rows of the contact's mails (sent and received) with their raw
// files. Audits count, never name.

const DAY = 86_400_000;
const MONTH = 30 * DAY;
export const NEW_TICKETS_PER_SENDER_HOUR = 10;

/** The contact's data for a data-subject request (owners). */
export async function exportContact(tx: DbTx, scope: Scope, contactId: string) {
  await requireSupport(tx, scope);
  const contact = await tx.supportContact.findFirst({
    where: { id: contactId, projectId: scope.projectId },
  });
  if (!contact) throw new DomainError("CONTACT_NOT_FOUND", 404);
  const [identities, tickets] = await Promise.all([
    tx.supportContactIdentity.findMany({ where: { contactId } }),
    tx.supportTicket.findMany({
      where: { projectId: scope.projectId, contactId },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const messages = await tx.supportMessage.findMany({
    where: { ticketId: { in: tickets.map((t) => t.id) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const attachments = await tx.supportAttachment.findMany({
    where: { messageId: { in: messages.map((m) => m.id) } },
  });
  await audit(tx, scope, "support.contact.exported", contactId, {
    contactId,
    tickets: tickets.length,
  });
  return {
    exportedAt: new Date().toISOString(),
    contact,
    identities: identities.map((i) => ({
      inboxId: i.inboxId,
      channel: i.channel,
      externalUserId: i.externalUserId,
      createdAt: i.createdAt,
    })),
    tickets: tickets.map((t) => ({
      id: t.id,
      number: t.number,
      subject: t.subject,
      status: t.status,
      createdAt: t.createdAt,
      messages: messages
        .filter((m) => m.ticketId === t.id)
        .map((m) => ({
          kind: m.kind,
          internal: !m.visibleToCustomer,
          bodyText: m.bodyText,
          createdAt: m.createdAt,
          attachments: attachments
            .filter((a) => a.messageId === m.id)
            .map((a) => ({
              fileId: a.fileId,
              name: a.name,
              mime: a.mime,
              size: a.size,
            })),
        })),
    })),
  };
}

/**
 * Deletes tickets with their messages, attachments and events, and the
 * mailbox rows of their mails. Returns the files to remove afterwards.
 */
async function deleteTickets(tx: DbTx, scope: Scope, ticketIds: string[]) {
  if (!ticketIds.length) return { files: [] as string[], mails: 0 };
  const messages = await tx.supportMessage.findMany({
    where: { ticketId: { in: ticketIds } },
    select: { id: true, externalId: true, channel: true },
  });
  const attachments = await tx.supportAttachment.findMany({
    where: { messageId: { in: messages.map((m) => m.id) } },
    select: { fileId: true },
  });
  const externalIds = messages
    .map((m) => m.externalId)
    .filter((v): v is string => Boolean(v));
  // Sent mail: the Orbit Message-ID names the platform's mail row.
  const sentIds = externalIds.flatMap((id) =>
    [...id.matchAll(ORBIT_MESSAGE_ID)].map((m) => m[1]!),
  );
  // Received mail: the mailbox row with the same Message-ID, and its raw file.
  const received = externalIds.length
    ? await tx.entity.findMany({
        where: {
          projectId: scope.projectId,
          kind: INBOUND_KIND,
          OR: externalIds.map((id) => ({
            data: { path: ["messageId"], equals: id },
          })),
        },
      })
    : [];
  const mailRows = await tx.entity.deleteMany({
    where: {
      projectId: scope.projectId,
      OR: [
        { kind: EMAIL_KIND, id: { in: sentIds } },
        { kind: INBOUND_KIND, id: { in: received.map((r) => r.id) } },
      ],
    },
  });
  await tx.supportTicket.updateMany({
    where: { mergedIntoTicketId: { in: ticketIds } },
    data: { mergedIntoTicketId: null },
  });
  await tx.supportTicket.deleteMany({ where: { id: { in: ticketIds } } });
  return {
    files: [
      ...attachments.map((a) => a.fileId),
      ...received
        .map((r) => data(r).fileId)
        .filter((v): v is string => typeof v === "string"),
    ],
    mails: mailRows.count,
  };
}

async function removeFiles(scope: Scope, ids: string[]) {
  if (!filesConfig()) return 0;
  let removed = 0;
  for (const id of new Set(ids))
    removed += await deleteFile(scope, id).then(
      () => 1,
      () => 0,
    );
  return removed;
}

async function widgetSessionsOf(tx: DbTx, scope: Scope, contactIds: string[]) {
  if (!contactIds.length) return [];
  return tx.entity.findMany({
    where: {
      projectId: scope.projectId,
      kind: WIDGET_SESSION_KIND,
      OR: contactIds.map((id) => ({
        data: { path: ["contactId"], equals: id },
      })),
    },
    select: { id: true },
  });
}

/** Erases a contact and everything support holds about them (owners). */
export async function eraseContact(scope: Scope, contactId: string) {
  const result = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      await requireSupport(tx, scope);
      const contact = await tx.supportContact.findFirst({
        where: { id: contactId, projectId: scope.projectId },
      });
      if (!contact) throw new DomainError("CONTACT_NOT_FOUND", 404);
      const tickets = await tx.supportTicket.findMany({
        where: { projectId: scope.projectId, contactId },
        select: { id: true },
      });
      const removed = await deleteTickets(
        tx,
        scope,
        tickets.map((t) => t.id),
      );
      const sessions = await widgetSessionsOf(tx, scope, [contactId]);
      await tx.entity.deleteMany({
        where: { id: { in: sessions.map((s) => s.id) } },
      });
      // What they wrote in other tickets goes too (review fix 2).
      const authored = await tx.supportMessage.findMany({
        where: { authorContactId: contactId },
        select: { id: true },
      });
      const authoredFiles = await tx.supportAttachment.findMany({
        where: { messageId: { in: authored.map((m) => m.id) } },
        select: { fileId: true },
      });
      await tx.supportMessage.deleteMany({
        where: { authorContactId: contactId },
      });
      // Mail from their addresses that never became a message (review fix 8).
      const addresses = [contact.email, contact.claimedEmail].filter(
        (v): v is string => Boolean(v),
      );
      const unlinked = addresses.length
        ? await tx.entity.findMany({
            where: {
              projectId: scope.projectId,
              kind: INBOUND_KIND,
              OR: addresses.map((a) => ({
                data: { path: ["from"], equals: a },
              })),
            },
          })
        : [];
      await tx.entity.deleteMany({
        where: { id: { in: unlinked.map((r) => r.id) } },
      });
      removed.files.push(
        ...authoredFiles.map((a) => a.fileId),
        ...unlinked
          .map((r) => data(r).fileId)
          .filter((v): v is string => typeof v === "string"),
      );
      await tx.supportContact.delete({ where: { id: contactId } });
      await audit(tx, scope, "support.contact.erased", contactId, {
        contactId,
        tickets: tickets.length,
        mails: removed.mails,
        sessions: sessions.length,
      });
      return {
        tickets: tickets.length,
        mails: removed.mails,
        files: removed.files,
      };
    },
  );
  const files = await removeFiles(scope, result.files);
  return { tickets: result.tickets, mails: result.mails, files };
}

/** Applies the project's retention (Q-12b) once; see docs/SUPPORT.md. */
export async function supportRetention(scope: Scope, now = new Date()) {
  const result = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      if (!(await supportActive(tx, scope))) return null;
      const { retention } = await supportSettings(tx, scope);
      const closedBefore = new Date(
        now.getTime() - retention.closedTicketMonths * MONTH,
      );
      const old = await tx.supportTicket.findMany({
        where: {
          projectId: scope.projectId,
          status: "closed",
          closedAt: { lt: closedBefore },
        },
        select: { id: true, contactId: true },
        take: 500,
      });
      const removed = await deleteTickets(
        tx,
        scope,
        old.map((t) => t.id),
      );
      const drafts = await tx.supportMessage.deleteMany({
        where: {
          projectId: scope.projectId,
          kind: "ai_draft",
          createdAt: {
            lt: new Date(now.getTime() - retention.aiDraftDays * DAY),
          },
        },
      });
      const sessionCutoff = new Date(
        now.getTime() - retention.widgetSessionDays * DAY,
      ).toISOString();
      const sessions = (
        await tx.entity.findMany({
          where: { projectId: scope.projectId, kind: WIDGET_SESSION_KIND },
          select: { id: true, data: true, createdAt: true },
        })
      ).filter(
        (s) =>
          String(
            (s.data as { lastSeenAt?: string }).lastSeenAt ??
              s.createdAt.toISOString(),
          ) < sessionCutoff,
      );
      await tx.entity.deleteMany({
        where: { id: { in: sessions.map((s) => s.id) } },
      });
      // Contacts left without tickets: those of removed tickets, and old orphans.
      const candidates = await tx.supportContact.findMany({
        where: {
          projectId: scope.projectId,
          OR: [
            { id: { in: old.map((t) => t.contactId) } },
            { createdAt: { lt: new Date(sessionCutoff) } },
          ],
        },
        select: { id: true },
      });
      const withTickets = new Set(
        (
          await tx.supportTicket.findMany({
            where: { contactId: { in: candidates.map((c) => c.id) } },
            select: { contactId: true },
          })
        ).map((t) => t.contactId),
      );
      const orphans = candidates
        .filter((c) => !withTickets.has(c.id))
        .map((c) => c.id);
      const orphanSessions = await widgetSessionsOf(tx, scope, orphans);
      await tx.entity.deleteMany({
        where: { id: { in: orphanSessions.map((s) => s.id) } },
      });
      await tx.supportMessage.updateMany({
        where: { authorContactId: { in: orphans } },
        data: { authorContactId: null },
      });
      const contacts = await tx.supportContact.deleteMany({
        where: { id: { in: orphans } },
      });
      // Raw mail of messages support recorded: the file goes, the row keeps
      // only what dedupe needs.
      const rawCutoff = new Date(now.getTime() - retention.rawEmailDays * DAY);
      // Mailbox rows of recorded mail not yet reduced, oldest first, so the
      // pass never stalls on rows it already handled (review fix 7).
      const rawRows = await tx.$queryRaw<Array<{ id: string; data: unknown }>>`
        SELECT e.id, e.data FROM "Entity" e
         WHERE e."projectId" = ${scope.projectId}::uuid
           AND e.kind = ${INBOUND_KIND}
           AND NOT (e.data ? 'retainedUntil')
           AND e.data->>'messageId' IN (
             SELECT m."externalId" FROM "SupportMessage" m
              WHERE m."projectId" = ${scope.projectId}::uuid
                AND m.channel = 'email' AND m.kind = 'customer'
                AND m."createdAt" < ${rawCutoff})
         ORDER BY e."createdAt"
         LIMIT 500`;
      const rawFiles: string[] = [];
      for (const row of rawRows) {
        const d = row.data as Record<string, unknown>;
        if (typeof d.fileId === "string") rawFiles.push(d.fileId);
        // Only what dedupe needs stays; the history goes with the rest.
        await tx.entity.update({
          where: { id: row.id },
          data: {
            data: {
              messageId: d.messageId ?? null,
              connectionId: d.connectionId ?? null,
              uid: d.uid ?? null,
              uidValidity: d.uidValidity ?? null,
              retainedUntil: now.toISOString(),
            },
          },
        });
        await tx.entityVersion.deleteMany({ where: { entityId: row.id } });
      }
      const counts = {
        tickets: old.length,
        drafts: drafts.count,
        sessions: sessions.length + orphanSessions.length,
        contacts: contacts.count,
        rawMails: rawFiles.length,
        mails: removed.mails,
      };
      await audit(
        tx,
        scope,
        "support.retention.applied",
        scope.projectId,
        counts,
      );
      return { counts, files: [...removed.files, ...rawFiles] };
    },
  );
  if (!result)
    return {
      tickets: 0,
      drafts: 0,
      sessions: 0,
      contacts: 0,
      rawMails: 0,
      mails: 0,
      files: 0,
    };
  const files = await removeFiles(scope, result.files);
  return { ...result.counts, files };
}

/** Runs the retention at most once a day per project. */
export const supportRetentionTask: PeriodicTask = {
  name: "support-retention",
  async nextDueAt(tx, scope) {
    if (!(await supportActive(tx, scope))) return null;
    const last = await tx.auditEvent.findFirst({
      where: {
        projectId: scope.projectId,
        action: "support.retention.applied",
      },
      orderBy: { createdAt: "desc" },
    });
    return last ? new Date(last.createdAt.getTime() + DAY) : new Date();
  },
  async run(scope) {
    const due = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      supportRetentionTask.nextDueAt!(tx, scope),
    );
    if (!due || due.getTime() > Date.now()) return { status: "idle" };
    const result = await supportRetention(scope);
    return {
      status: `retention tickets=${result.tickets} contacts=${result.contacts}`,
      wakeAt: new Date(Date.now() + DAY),
    };
  },
};

/** At most NEW_TICKETS_PER_SENDER_HOUR new tickets per sender address per hour. */
export async function allowNewTicket(tx: DbTx, scope: Scope, email: string) {
  const address = email.trim().toLowerCase();
  const contacts = await tx.supportContact.findMany({
    where: {
      projectId: scope.projectId,
      OR: [{ email: address }, { claimedEmail: address }],
    },
    select: { id: true },
  });
  if (!contacts.length) return true;
  const recent = await tx.supportTicket.count({
    where: {
      projectId: scope.projectId,
      contactId: { in: contacts.map((c) => c.id) },
      createdAt: { gte: new Date(Date.now() - 3_600_000) },
    },
  });
  return recent < NEW_TICKETS_PER_SENDER_HOUR;
}

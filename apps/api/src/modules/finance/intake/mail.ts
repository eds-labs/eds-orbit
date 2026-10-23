import PostalMime from "postal-mime";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { audit, data, DomainError } from "../../../shared.ts";
import { requestInboundArchive } from "../../../platform/email/archive.ts";
import { INBOUND_KIND } from "../../../platform/email/send.ts";
import { readFile, storeFile } from "../../../platform/files/files.ts";
import { financeActive } from "../gate.ts";
import { readFinanceSettings } from "../settings.ts";
import {
  recordDocument,
  retainUntilFor,
  type IngestResult,
} from "./documents.ts";

// Receipts from a mailbox bound to finance (mailboxes.ts). Each accepted
// attachment becomes a document; a mail without one becomes a document
// itself. Mail is archived only after finance is done with it.

const ACCEPTED = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/xml",
]);
/** Parts with a Content-ID below this size are signature logos, not receipts. */
const INLINE_MAX_BYTES = 32 * 1024;
const MAX_ATTACHMENTS = 10;

type Inbound = {
  connectionId?: string;
  uid?: number;
  uidValidity?: string | number;
  messageId?: string | null;
  automatic?: boolean;
  unreadable?: boolean;
  fileId?: string;
};

export async function handleMailReceipt(
  scope: Scope,
  inboundEmailId: string,
): Promise<void> {
  const prepared = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const row = await tx.entity.findFirst({
        where: {
          id: inboundEmailId,
          projectId: scope.projectId,
          kind: INBOUND_KIND,
        },
      });
      if (!row) throw new DomainError("NOT_FOUND", 404);
      if (!(await financeActive(tx, scope))) return null;
      const mail = data(row) as Inbound;
      const mailbox = mail.connectionId
        ? await tx.financeMailbox.findFirst({
            where: {
              projectId: scope.projectId,
              emailConnectionId: mail.connectionId,
              active: true,
            },
          })
        : null;
      if (!mailbox || !mail.fileId) return null;
      if (mail.unreadable) {
        // Left in the inbox so that a person sees it.
        await audit(tx, scope, "finance.mail.unreadable", inboundEmailId, {
          inboundEmailId,
        });
        return null;
      }
      if (mail.automatic) return null;
      const messageId = mail.messageId || `uid:${mail.uidValidity}:${mail.uid}`;
      const seen = await tx.financeDocument.findFirst({
        where: { projectId: scope.projectId, messageId },
        select: { id: true },
      });
      if (seen) return null;
      const { settings } = await readFinanceSettings(tx, scope);
      return { mail, mailbox, messageId, settings };
    },
  );
  if (!prepared) return;
  const { mail, mailbox, messageId, settings } = prepared;

  const { bytes } = await readFile(scope, mail.fileId!);
  const retainUntil = retainUntilFor(settings.retentionYears);
  // Our own retained copy of the mail, the source of every document from it.
  const eml = await storeFile(scope, {
    moduleId: "finance",
    bytes,
    mime: "message/rfc822",
    name: "message.eml",
    retainUntil,
  });
  const base = {
    source: "email" as const,
    mailboxId: mailbox.id,
    inboundEmailId,
    messageId,
    emailFileId: eml.id,
  };

  const parsed = await PostalMime.parse(bytes);
  const results: IngestResult[] = [];
  for (const attachment of parsed.attachments ?? []) {
    if (results.length >= MAX_ATTACHMENTS) break;
    const mime = (attachment.mimeType ?? "")
      .toLowerCase()
      .split(";")[0]!
      .trim();
    if (!ACCEPTED.has(mime)) continue;
    const content =
      typeof attachment.content === "string"
        ? Buffer.from(attachment.content)
        : new Uint8Array(attachment.content);
    if (attachment.contentId && content.byteLength < INLINE_MAX_BYTES) continue;
    const name = attachment.filename ?? "attachment";
    try {
      const stored = await storeFile(scope, {
        moduleId: "finance",
        bytes: content,
        mime,
        name,
        retainUntil,
      });
      results.push(
        await recordDocument(scope, stored, { ...base, mime, name }),
      );
    } catch (error) {
      // An attachment that fails the platform's type or size check is skipped.
      if (!(error instanceof DomainError) || error.status >= 500) throw error;
    }
  }
  if (!results.length)
    results.push(
      await recordDocument(scope, eml, {
        ...base,
        mime: "message/rfc822",
        name: "message.eml",
      }),
    );

  if (
    settings.archiveAfter === "extracted" &&
    !results.some((r) => r.status === "received")
  )
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      requestInboundArchive(
        tx,
        scope,
        inboundEmailId,
        mailbox.archiveFolder,
        "finance",
      ),
    );
}

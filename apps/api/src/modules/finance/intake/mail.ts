import { createHash } from "node:crypto";
import PostalMime from "postal-mime";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
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
      // Documents of an earlier (possibly interrupted) pass over this message.
      const earlier = await tx.financeDocument.findMany({
        where: { projectId: scope.projectId, messageId },
        select: { sha256: true, status: true, emailFileId: true },
      });
      const { settings } = await readFinanceSettings(tx, scope);
      return { mail, mailbox, messageId, settings, earlier };
    },
  );
  if (!prepared) return;
  const { mail, mailbox, messageId, settings, earlier } = prepared;

  const { bytes } = await readFile(scope, mail.fileId!);
  const retainUntil = retainUntilFor(settings.retentionYears);
  const parsed = await PostalMime.parse(bytes);
  // Parts are idempotent by (message, content): a retry handles only what an
  // interrupted pass did not record, and a second inbound row of the same
  // message adds nothing but its own archive request.
  const held = new Map(earlier.map((d) => [d.sha256, d.status]));
  // Our own retained copy of the mail, kept across retries.
  let emlFileId = earlier.find((d) => d.emailFileId)?.emailFileId ?? null;
  let eml: { id: string; sha256: string } | null = null;
  const ensureEml = async () => {
    eml ??= await storeFile(scope, {
      moduleId: "finance",
      bytes,
      mime: "message/rfc822",
      name: "message.eml",
      retainUntil,
    });
    emlFileId = eml.id;
    return eml;
  };
  if (!emlFileId) await ensureEml();
  const base = () => ({
    source: "email" as const,
    mailboxId: mailbox.id,
    inboundEmailId,
    messageId,
    emailFileId: emlFileId!,
  });

  let handled = 0;
  let failed = 0;
  let skipped = 0;
  for (const attachment of parsed.attachments ?? []) {
    if (handled >= MAX_ATTACHMENTS) break;
    const mime = (attachment.mimeType ?? "")
      .toLowerCase()
      .split(";")[0]!
      .trim();
    const content =
      typeof attachment.content === "string"
        ? Buffer.from(attachment.content)
        : new Uint8Array(attachment.content);
    // A small image with a Content-ID is a signature logo, not a receipt.
    if (
      mime.startsWith("image/") &&
      attachment.contentId &&
      content.byteLength < INLINE_MAX_BYTES
    )
      continue;
    if (!ACCEPTED.has(mime)) {
      skipped++;
      continue;
    }
    handled++;
    const sha = createHash("sha256").update(content).digest("hex");
    if (held.has(sha)) continue;
    const name = attachment.filename ?? "attachment";
    try {
      const stored = await storeFile(scope, {
        moduleId: "finance",
        bytes: content,
        mime,
        name,
        retainUntil,
      });
      const result = await recordDocument(scope, stored, {
        ...base(),
        mime,
        name,
      });
      held.set(sha, result.status);
    } catch (error) {
      // A failed type or size check is audited; anything else is retried.
      if (!(error instanceof DomainError) || error.status >= 500) throw error;
      failed++;
      await scoped(scope.workspaceId, scope.projectId, (tx) =>
        audit(tx, scope, "finance.mail.attachment_failed", inboundEmailId, {
          reason: error.code,
        }),
      );
    }
  }
  if (skipped)
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      audit(tx, scope, "finance.mail.attachment_skipped", inboundEmailId, {
        count: skipped,
      }),
    );
  if (!handled) {
    // No usable attachment: the mail itself is the document.
    const mailSha = createHash("sha256").update(bytes).digest("hex");
    if (!held.has(mailSha)) {
      const stored = emlFileId
        ? { id: emlFileId, sha256: mailSha }
        : await ensureEml();
      const result = await recordDocument(scope, stored, {
        ...base(),
        mime: "message/rfc822",
        name: "message.eml",
      });
      held.set(mailSha, result.status);
    }
  }

  // A mail with a failed part stays in the inbox for a person to see.
  if (!failed)
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      archiveMailWhenDone(tx, scope, {
        inboundEmailId,
        mailboxId: mailbox.id,
        messageId,
      }),
    );
}

/**
 * Asks the platform to archive a finance mail once finance is done with it:
 * its mailbox is still bound, no document of the message still waits for
 * extraction or failed it (with `archiveAfter` "booked", none still waits
 * for review either), and no accepted part of this inbound mail failed.
 * Extraction calls it after each document, review after booking and
 * rejection. Returns whether the archive was requested.
 */
export async function archiveMailWhenDone(
  tx: DbTx,
  scope: Scope,
  mail: { inboundEmailId: string; mailboxId: string; messageId: string },
) {
  const { settings } = await readFinanceSettings(tx, scope);
  // A failed extraction is not finished: a person retries it.
  const unfinished = ["received", "extracting", "failed"];
  if (settings.archiveAfter === "booked") unfinished.push("needs_review");
  const mailbox = await tx.financeMailbox.findFirst({
    where: { id: mail.mailboxId, projectId: scope.projectId, active: true },
  });
  if (!mailbox) return false;
  const waiting = await tx.financeDocument.count({
    where: {
      projectId: scope.projectId,
      messageId: mail.messageId,
      status: { in: unfinished },
    },
  });
  if (waiting) return false;
  const failed = await tx.auditEvent.count({
    where: {
      projectId: scope.projectId,
      action: "finance.mail.attachment_failed",
      resourceId: mail.inboundEmailId,
    },
  });
  if (failed) return false;
  await requestInboundArchive(
    tx,
    scope,
    mail.inboundEmailId,
    mailbox.archiveFolder,
    "finance",
  );
  return true;
}

import { randomUUID } from "node:crypto";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../../shared.ts";
import { storeFile } from "../../../platform/files/files.ts";
import { enqueue } from "../../../platform/jobs/enqueue.ts";
import { notifyReviewNeeded } from "../notifications.ts";
import { readFinanceSettings } from "../settings.ts";

// Document intake: every original (upload or mail attachment) is stored as a
// platform file under retention, then recorded as a FinanceDocument. An exact
// copy of a live document (same SHA-256) becomes a `duplicate` that points at
// the original and is never extracted.

export const FINANCE_MAIL_RECEIPT = "finance_mail_receipt";
export const FINANCE_EXTRACT = "finance_extract";

/** Types a finance document may have: the mail itself, scans, e-invoices. */
export const DOCUMENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/xml",
  "message/rfc822",
] as const;

export type DocumentInput = {
  source: "email" | "upload";
  bytes: Uint8Array;
  mime: string;
  name?: string;
  mailboxId?: string;
  inboundEmailId?: string;
  messageId?: string;
  emailFileId?: string;
};

export type IngestResult = {
  id: string;
  status: string;
  duplicateOfId?: string;
};

/** `now` plus whole calendar years (UTC), the end of the retention lock. */
export function retainUntilFor(years: number, now = new Date()) {
  const until = new Date(now);
  until.setUTCFullYear(until.getUTCFullYear() + years);
  return until;
}

type Stored = { id: string; sha256: string };

/**
 * Records an already stored file as a document. The project lock held by
 * `scoped` serializes the duplicate check; a lost race on the unique index
 * is retried once and then finds the winner.
 */
export async function recordDocument(
  scope: Scope,
  stored: Stored,
  input: Omit<DocumentInput, "bytes">,
): Promise<IngestResult> {
  const attempt = () =>
    scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const original = await tx.financeDocument.findFirst({
        where: {
          projectId: scope.projectId,
          sha256: stored.sha256,
          status: { notIn: ["rejected", "duplicate"] },
        },
        orderBy: { createdAt: "asc" },
      });
      const { settings } = await readFinanceSettings(tx, scope);
      const aiOn = settings.aiExtraction === "on";
      const status = original
        ? "duplicate"
        : aiOn
          ? "received"
          : "needs_review";
      const row = await tx.financeDocument.create({
        data: {
          id: randomUUID(),
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          fileId: stored.id,
          sha256: stored.sha256,
          source: input.source,
          mailboxId: input.mailboxId ?? null,
          inboundEmailId: input.inboundEmailId ?? null,
          messageId: input.messageId ?? null,
          emailFileId: input.emailFileId ?? null,
          originalName: input.name ?? null,
          mimeType: input.mime,
          status,
          flags: !original && !aiOn ? ["ai_off"] : [],
          duplicateOfId: original?.id ?? null,
        },
      });
      // Mail that skips AI waits for a person at once; an upload was handed in
      // by one. The row is created once, so the notice is too.
      if (!original && !aiOn && input.source === "email")
        await notifyReviewNeeded(tx, scope, row.id);
      if (status === "received")
        await enqueue(
          tx,
          scope,
          FINANCE_EXTRACT,
          row.id,
          `finance-extract:${row.id}`,
        );
      await audit(tx, scope, "finance.document.received", row.id, {
        source: input.source,
        ...(original ? { duplicate: true } : {}),
      });
      return {
        id: row.id,
        status,
        ...(original ? { duplicateOfId: original.id } : {}),
      };
    });
  try {
    return await attempt();
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    return attempt();
  }
}

/** Stores the original under retention and records it as a document. */
export async function ingestDocument(
  scope: Scope,
  input: DocumentInput,
): Promise<IngestResult> {
  const mime = input.mime.split(";")[0]!.trim().toLowerCase();
  if (!(DOCUMENT_TYPES as readonly string[]).includes(mime))
    throw new DomainError("FINANCE_DOCUMENT_TYPE_UNSUPPORTED", 415);
  const { settings } = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    readFinanceSettings(tx, scope),
  );
  const stored = await storeFile(scope, {
    moduleId: "finance",
    bytes: input.bytes,
    mime,
    ...(input.name ? { name: input.name } : {}),
    retainUntil: retainUntilFor(settings.retentionYears),
  });
  return recordDocument(scope, stored, { ...input, mime });
}

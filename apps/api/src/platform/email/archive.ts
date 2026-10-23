import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, data, DomainError, entity, update } from "../shared.ts";
import {
  CONNECTION_KIND,
  decryptCredential,
} from "../connections/connections.ts";
import { enqueue } from "../jobs/enqueue.ts";
import { accountOf, verifiedEmailConnection } from "./connection.ts";
import { mailboxOwner } from "./ownership.ts";
import { INBOUND_KIND } from "./send.ts";
import { mailFactories, MailSendError } from "./transport.ts";

// Archiving after acknowledgement: the module that owns a mailbox
// (ownership.ts) asks, once it has processed an inbound message, to have it
// moved into an archive folder. Orbit never moves mail on its own. The move
// is the `email_archive` job; the outcome is recorded on the inbound row
// (`archivedAt`, `archiveFolder`, `archiveError`). A vanished message or a
// changed UIDVALIDITY ends the job (nothing to retry); a refused login is
// permanent, other IMAP errors are retried.

export const ARCHIVE_QUEUE = "email_archive";
export type ArchiveError =
  "IMAP_AUTH" | "IMAP_ERROR" | "MISSING" | "UID_VALIDITY_CHANGED";

/**
 * Asks for an inbound message to be moved into `folder`. Only the module
 * that owns the message's mailbox may ask (403 EMAIL_ARCHIVE_NOT_OWNER).
 * Asking again is harmless: one job per message.
 */
export async function requestInboundArchive(
  tx: DbTx,
  scope: Scope,
  inboundEmailId: string,
  folder: string,
  moduleId: string,
) {
  const name = folder.trim();
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name))
    throw new DomainError("EMAIL_ARCHIVE_FOLDER_INVALID", 400);
  const row = await entity(tx, scope, INBOUND_KIND, inboundEmailId);
  const d = data(row);
  const connection = await entity(
    tx,
    scope,
    CONNECTION_KIND,
    String(d.connectionId),
  ).catch(() => null);
  if (!connection || mailboxOwner(data(connection)) !== moduleId)
    throw new DomainError("EMAIL_ARCHIVE_NOT_OWNER", 403);
  if (d.archivedAt) return;
  await update(tx, scope, row, {
    ...d,
    archiveFolder: name,
    archiveError: null,
  });
  await audit(tx, scope, "email.archive.requested", inboundEmailId, {
    inboundEmailId,
    connectionId: String(d.connectionId),
    moduleId,
  });
  await enqueue(
    tx,
    scope,
    ARCHIVE_QUEUE,
    inboundEmailId,
    `email-archive:${inboundEmailId}`,
  );
}

/**
 * Runs one `email_archive` job. Throws a retryable error for a transient
 * IMAP failure and EMAIL_ARCHIVE_AUTH_REQUIRED (permanent, see the worker's
 * error pattern) when the login is refused.
 */
export async function archiveInboundEmail(
  scope: Scope,
  inboundEmailId: string,
) {
  const record = (patch: Record<string, unknown>) =>
    scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const row = await entity(tx, scope, INBOUND_KIND, inboundEmailId);
      await update(tx, scope, row, { ...data(row), ...patch });
    });
  const prepared = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const d = data(await entity(tx, scope, INBOUND_KIND, inboundEmailId));
      if (d.archivedAt || !d.archiveFolder) return null;
      const connection = await verifiedEmailConnection(
        tx,
        scope,
        String(d.connectionId),
      );
      if (!connection) throw new Error("EMAIL_ARCHIVE_NOT_CONNECTED");
      return {
        folder: String(d.archiveFolder),
        state: { uidValidity: String(d.uidValidity), uid: Number(d.uid) },
        account: accountOf(data(connection)),
        password: decryptCredential(data(connection)),
      };
    },
  );
  if (!prepared) return;
  let outcome: "moved" | "missing" | "uid_validity_changed";
  try {
    outcome = await mailFactories()
      .mailbox(prepared.account, prepared.password)
      .move(prepared.state, prepared.folder);
  } catch (error) {
    const auth = error instanceof MailSendError && error.code === "IMAP_AUTH";
    await record({ archiveError: auth ? "IMAP_AUTH" : "IMAP_ERROR" });
    throw new Error(
      auth ? "EMAIL_ARCHIVE_AUTH_REQUIRED" : "EMAIL_ARCHIVE_IMAP_ERROR",
    );
  }
  if (outcome === "moved") {
    await record({ archivedAt: new Date().toISOString(), archiveError: null });
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      audit(tx, scope, "email.archived", inboundEmailId, { inboundEmailId }),
    );
  } else
    await record({
      archiveError: (outcome === "missing"
        ? "MISSING"
        : "UID_VALIDITY_CHANGED") satisfies ArchiveError,
    });
}

/**
 * The most recent archive error of a mailbox (null when its latest archive
 * attempt succeeded or none was made): one bounded query.
 */
export async function lastArchiveError(
  tx: DbTx,
  scope: Scope,
  connectionId: string,
): Promise<string | null> {
  const latest = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: INBOUND_KIND,
      AND: [
        { data: { path: ["connectionId"], equals: connectionId } },
        // Rows with a requested archive only.
        { data: { path: ["archiveFolder"], string_starts_with: "" } },
      ],
    },
    orderBy: { updatedAt: "desc" },
  });
  return latest ? ((data(latest).archiveError as string | null) ?? null) : null;
}

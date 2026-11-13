import { createHash } from "node:crypto";
import {
  scoped,
  scopedRead,
  type DbTx,
} from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, create, data, DomainError, update } from "../shared.ts";
import { decryptCredential } from "../connections/connections.ts";
import { deleteFile, filesConfig, storeFile } from "../files/files.ts";
import { ensureBacklogSnapshot } from "./backlog-snapshot.ts";
import {
  accountOf,
  sharedClientActive,
  verifiedEmailConnection,
} from "./connection.ts";
import {
  cursorOf,
  failureCode,
  ingestMessage,
  mailboxHasConsumer,
  normalized,
  oldMessage,
  parseMessage,
  patchState,
  stateOf,
} from "./inbound.ts";
import { withMailboxLock, type MailboxLock } from "./mailbox-lock.ts";
import { mailboxRow } from "./ownership.ts";
import { INBOUND_KIND } from "./send.ts";
import {
  assertPublicMailHost,
  mailFactories,
  MailSendError,
  type FetchedMessage,
  type MailboxReader,
  type TlsMode,
} from "./transport.ts";

// Mailboxes that a second IMAP client works on as well (ADR 0026). Everything
// here is for mailboxes carrying the webmail marker while ORBIT_WEBMAIL is on;
// without both, the fetch path behaves exactly as before.

export { sharedClientActive };

/** One message of a mailbox folder; a uid only means something with its uidValidity. */
export type MailboxMessageRef = {
  folder: string;
  uid: number;
  uidValidity: string;
};

/** A mail server for one request, with the address already vetted. */
export type MailServerTarget = {
  host: string;
  tlsPeerName: string;
  port: number;
  tlsMode: "ssl" | "tls" | "none";
  user: string;
  password: string;
};

export type IngestSelection = { uids: readonly number[] } | { all: true };

type Connection = NonNullable<
  Awaited<ReturnType<typeof verifiedEmailConnection>>
>;

const INGEST_TIMEOUT_MS = 8000;
const INGEST_MAX_MESSAGES = 50;
const IMPORT_LOCK_WAIT_MS = 5000;
const MAX_BYTES = 10 * 1024 * 1024;

/** Sets or clears the marker; a re-save of the connection keeps it. */
export async function setSharedClient(
  tx: DbTx,
  scope: Scope,
  connectionId: string,
  on: boolean,
): Promise<void> {
  const row = await mailboxRow(tx, scope, connectionId);
  const { webmailClient, ...rest } = data(row);
  if ((webmailClient === true) === on) return;
  await update(tx, scope, row, on ? { ...rest, webmailClient: true } : rest);
  await audit(tx, scope, "email.mailbox.webmail_client_set", connectionId, {
    connectionId,
    on,
  });
}

function tlsMode(mode: TlsMode | "none"): MailServerTarget["tlsMode"] {
  if (mode === "implicit") return "ssl";
  if (mode === "starttls") return "tls";
  if (mode === "none") return "none";
  throw new MailSendError("MAIL_TLS_INVALID");
}

/** The vetted IMAP and SMTP targets of a connection, with its password. */
export async function mailServerTargets(
  connectionData: Record<string, unknown>,
): Promise<{ imap: MailServerTarget; smtp: MailServerTarget }> {
  const account = accountOf(connectionData);
  const password = decryptCredential(connectionData);
  const target = async (
    host: string,
    port: number,
    mode: TlsMode,
  ): Promise<MailServerTarget> => ({
    host: await assertPublicMailHost(host),
    tlsPeerName: host,
    port,
    tlsMode: tlsMode(mode),
    user: account.username,
    password,
  });
  const [imap, smtp] = await Promise.all([
    target(account.imapHost, account.imapPort, account.imapTls),
    target(account.smtpHost, account.smtpPort, account.smtpTls),
  ]);
  return { imap, smtp };
}

class IngestRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Waits for an IMAP call at most until the deadline; it may finish later. */
function beforeDeadline<T>(deadline: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new IngestRefused("busy")),
        Math.max(0, deadline - Date.now()),
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Which of these UIDs already have a row under this UIDVALIDITY. */
async function uidsWithRows(
  scope: Scope,
  connectionId: string,
  uidValidity: string,
  uids: number[],
) {
  if (!uids.length) return new Set<number>();
  const rows = await scopedRead(
    scope.workspaceId,
    scope.projectId,
    (tx) => tx.$queryRaw<Array<{ uid: number }>>`
      SELECT (data->>'uid')::int AS uid FROM "Entity"
       WHERE "projectId" = ${scope.projectId}::uuid
         AND kind = ${INBOUND_KIND}
         AND data->>'connectionId' = ${connectionId}
         AND data->>'uidValidity' = ${uidValidity}
         AND (data->>'uid')::int = ANY(${uids}::int[])`,
  );
  return new Set(rows.map((row) => row.uid));
}

/**
 * Before a client removes INBOX messages: ingests exactly those not yet read
 * by Orbit, leaving the cursor alone. `ok` only when each has been ingested or
 * was deliberately skipped; every other outcome is a refusal.
 */
export async function ensureIngested(
  scope: Scope,
  connectionId: string,
  selection: IngestSelection,
  options?: { timeoutMs?: number },
): Promise<{ status: "ok" } | { status: "retry"; reason: string }> {
  const deadline = Date.now() + (options?.timeoutMs ?? INGEST_TIMEOUT_MS);
  const retry = (reason: string) => ({ status: "retry" as const, reason });
  // Without the project lock: a client's delete must not wait behind writers
  // when there is nothing to write.
  const setup = await scopedRead(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const connection = await verifiedEmailConnection(tx, scope, connectionId);
      return connection
        ? {
            connection,
            receives: await mailboxHasConsumer(tx, scope, connection),
          }
        : null;
    },
  );
  if (!setup || !sharedClientActive(data(setup.connection)))
    return retry("ingest_failed");
  // No module would ever read it: nothing can be lost by removing it.
  if (!setup.receives) return { status: "ok" };
  const files = filesConfig();
  if (!files) {
    await patchState(scope, connectionId, {
      lastError: "FILES_NOT_CONFIGURED",
    });
    return retry("ingest_failed");
  }
  try {
    const locked = await withMailboxLock(
      connectionId,
      Math.max(0, deadline - Date.now()),
      async (lock) => {
        await ingestPending(
          scope,
          setup.connection,
          selection,
          Math.min(MAX_BYTES, files.maxBytes),
          deadline,
          lock,
        );
      },
    );
    return locked.acquired ? { status: "ok" } : retry("busy");
  } catch (error) {
    if (error instanceof IngestRefused) return retry(error.reason);
    if (error instanceof MailSendError && error.code === "LOCK_UNAVAILABLE")
      return retry("busy");
    await patchState(scope, connectionId, {
      lastError: failureCode(error),
    });
    return retry(
      error instanceof MailSendError ? "imap_error" : "ingest_failed",
    );
  }
}

/** The barrier's work under the lock; throws a refusal, never moves the cursor. */
async function ingestPending(
  scope: Scope,
  connection: Connection,
  selection: IngestSelection,
  maxBytes: number,
  deadline: number,
  lock: MailboxLock,
) {
  const d = data(connection);
  const stateRow = await scopedRead(scope.workspaceId, scope.projectId, (tx) =>
    stateOf(tx, scope, connection.id),
  );
  const cursor = stateRow ? data(stateRow) : {};
  const state = {
    ...cursorOf(cursor),
    checkedAt: cursor.checkedAt as string | undefined,
  };
  const reader: MailboxReader = mailFactories().mailbox(
    accountOf(d),
    decryptCredential(d),
  );
  const scan = await beforeDeadline(deadline, reader.scan());
  // During a backlog, or before one has started, only its list can be pending
  // below the watermark. Without one, only what the cursor has not passed.
  const snapshot =
    state.uidValidity !== scan.uidValidity || state.backlogUntil !== undefined
      ? await ensureBacklogSnapshot(scope, connection.id, reader, scan, state)
      : null;
  const floor = snapshot ? snapshot.until : state.lastUid;
  const listed = new Set(snapshot?.uids ?? []);
  // UIDs above the end of a capped list may have been cut off from it.
  const cutFrom = snapshot?.overflow ? (snapshot.uids.at(-1) ?? 0) : null;
  const inBacklog = (uid: number) =>
    listed.has(uid) ||
    (cutFrom !== null && uid > cutFrom && uid <= snapshot!.until);
  const fetched: FetchedMessage[] = [];
  const oversize: number[] = [];
  if ("all" in selection) {
    if (snapshot?.overflow) throw new IngestRefused("too_many");
    const missing = await pendingUids(scope, connection.id, scan, [...listed]);
    const above = await beforeDeadline(
      deadline,
      reader.fetchNew(
        { uidValidity: scan.uidValidity, lastUid: floor },
        {
          max: INGEST_MAX_MESSAGES + 1,
          maxBytes,
          internalDate: true,
        },
      ),
    );
    fetched.push(...above.messages);
    oversize.push(...above.skipped);
    if (missing.length + fetched.length + oversize.length > INGEST_MAX_MESSAGES)
      throw new IngestRefused("too_many");
    if (missing.length) {
      const got = await beforeDeadline(
        deadline,
        reader.fetchUids(missing, maxBytes, { internalDate: true }),
      );
      fetched.push(...got.messages);
      oversize.push(...got.skipped);
    }
  } else {
    const requested = [...new Set(selection.uids)].filter(
      (uid) =>
        Number.isInteger(uid) && uid > 0 && (inBacklog(uid) || uid > floor),
    );
    const missing = await pendingUids(scope, connection.id, scan, requested);
    if (missing.length > INGEST_MAX_MESSAGES)
      throw new IngestRefused("too_many");
    if (missing.length) {
      const got = await beforeDeadline(
        deadline,
        reader.fetchUids(missing, maxBytes, { internalDate: true }),
      );
      fetched.push(...got.messages);
      oversize.push(...got.skipped);
    }
  }
  let stored = 0;
  let bounced = 0;
  const now = Date.now();
  for (const message of fetched) {
    if (Date.now() >= deadline || !lock.held()) throw new IngestRefused("busy");
    const result = await ingestMessage(
      scope,
      connection,
      message,
      {
        uidValidity: scan.uidValidity,
        backlog: inBacklog(message.uid) || oldMessage(message, now),
      },
      { shared: true },
    );
    if (result.stored) stored++;
    bounced += result.bounced;
  }
  if (stored || oversize.length)
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      audit(tx, scope, "email.inbound", connection.id, {
        stored,
        bounced,
        skipped: oversize.length,
      }),
    );
}

async function pendingUids(
  scope: Scope,
  connectionId: string,
  scan: { uidValidity: string },
  uids: number[],
) {
  const known = await uidsWithRows(scope, connectionId, scan.uidValidity, uids);
  return uids.filter((uid) => !known.has(uid)).sort((a, b) => a - b);
}

/**
 * Reads one message of any folder, read-only; null when it is gone. Throws
 * 409 WEBMAIL_UID_VALIDITY_CHANGED when the UID no longer names that message.
 */
export async function readMailboxMessage(
  scope: Scope,
  connectionId: string,
  ref: MailboxMessageRef,
  maxBytes: number,
): Promise<{ source: Uint8Array } | null> {
  const connection = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    verifiedEmailConnection(tx, scope, connectionId),
  );
  if (!connection) throw new DomainError("EMAIL_MAILBOX_NOT_FOUND", 404);
  const d = data(connection);
  const reader = mailFactories().mailbox(accountOf(d), decryptCredential(d));
  const result = reader.fetchFolderMessage
    ? await reader.fetchFolderMessage(ref, maxBytes)
    : await legacyFolderMessage(reader, ref, maxBytes);
  if (result === "too_large")
    throw new DomainError("WEBMAIL_MESSAGE_TOO_LARGE", 413);
  if (result === "uid_validity_changed")
    throw new DomainError("WEBMAIL_UID_VALIDITY_CHANGED", 409);
  return result;
}

/** A reader without folder access can still read its INBOX. */
async function legacyFolderMessage(
  reader: MailboxReader,
  ref: MailboxMessageRef,
  maxBytes: number,
) {
  if (ref.folder.toUpperCase() !== "INBOX") return null;
  const scan = await reader.scan();
  if (scan.uidValidity !== ref.uidValidity)
    return "uid_validity_changed" as const;
  const { messages, skipped } = await reader.fetchUids([ref.uid], maxBytes);
  if (skipped.includes(ref.uid)) return "too_large" as const;
  const message = messages.find((m) => m.uid === ref.uid);
  return message ? { source: message.source } : null;
}

/** A row without its raw file (reduced by retention) gets the original back. */
async function withOriginal(scope: Scope, rowId: string, source: Buffer) {
  const row = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    tx.entity.findFirstOrThrow({
      where: { id: rowId, projectId: scope.projectId, kind: INBOUND_KIND },
    }),
  );
  const fileId = data(row).fileId;
  if (typeof fileId === "string")
    return { inboundId: rowId, fileId, created: false };
  const file = await storeOriginal(scope, source);
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const current = await tx.entity.findFirstOrThrow({
      where: { id: rowId, projectId: scope.projectId, kind: INBOUND_KIND },
    });
    const { retainedUntil: _reduced, ...rest } = data(current);
    await update(tx, scope, current, { ...rest, fileId: file.id });
  });
  return { inboundId: rowId, fileId: file.id, created: false };
}

const storeOriginal = (scope: Scope, source: Buffer) =>
  storeFile(
    { ...scope, userId: "email-inbound" },
    {
      moduleId: "platform",
      bytes: source,
      mime: "message/rfc822",
      name: "imported.eml",
    },
  );

/**
 * The `inbound_emails` row holding this message's original, for a takeover:
 * an INBOX message goes through the normal ingest so no module misses it; one
 * of another folder gets a row retention can follow but polling cannot match.
 * `created` says this call made the row (see `discardImportedRow`).
 */
export async function inboundRowForImport(
  scope: Scope,
  connectionId: string,
  ref: MailboxMessageRef,
  source: Uint8Array,
): Promise<{ inboundId: string; fileId: string; created: boolean }> {
  const raw = Buffer.from(source);
  const connection = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    verifiedEmailConnection(tx, scope, connectionId),
  );
  if (!connection) throw new DomainError("EMAIL_MAILBOX_NOT_FOUND", 404);
  if (ref.folder.toUpperCase() === "INBOX") {
    const locked = await withMailboxLock(
      connectionId,
      IMPORT_LOCK_WAIT_MS,
      () =>
        ingestMessage(
          scope,
          connection,
          { uid: ref.uid, source: raw },
          // Taken over by a person: the mail may be old, and no module should
          // answer it on the strength of this ingest.
          { uidValidity: ref.uidValidity, backlog: true },
          { shared: true },
        ),
    ).catch((error: unknown) => {
      if (error instanceof MailSendError) return { acquired: false as const };
      throw error;
    });
    if (!locked.acquired) throw new DomainError("EMAIL_MAILBOX_BUSY", 409);
    return {
      ...(await withOriginal(scope, locked.value.rowId, raw)),
      created: locked.value.stored,
    };
  }
  const parsed = await parseMessage(raw);
  const fields = normalized(parsed);
  const rawSha256 = fields.messageId
    ? null
    : createHash("sha256").update(raw).digest("hex");
  const known = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    tx.entity.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: INBOUND_KIND,
        AND: [
          {
            OR: [
              { data: { path: ["connectionId"], equals: connectionId } },
              {
                data: {
                  path: ["importedFromConnectionId"],
                  equals: connectionId,
                },
              },
            ],
          },
          rawSha256
            ? { data: { path: ["rawSha256"], equals: rawSha256 } }
            : { data: { path: ["messageId"], equals: fields.messageId } },
        ],
      },
    }),
  );
  if (known) return withOriginal(scope, known.id, raw);
  const file = await storeOriginal(scope, raw);
  const row = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    create(tx, scope, INBOUND_KIND, {
      importedFromConnectionId: connectionId,
      ...fields,
      bounceOf: [],
      ...(rawSha256 ? { rawSha256 } : {}),
      fileId: file.id,
      receivedAt: new Date().toISOString(),
    }),
  );
  return { inboundId: row.id, fileId: file.id, created: true };
}

/**
 * Undoes a takeover's row from a folder other than the INBOX, with its stored
 * original. An INBOX row is left alone whatever the takeover did: modules
 * have it and polling relies on it. The file goes first, so a failure leaves
 * a row to retry with, never an original nothing points at.
 */
export async function discardImportedRow(
  scope: Scope,
  inboundId: string,
): Promise<void> {
  const row = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    tx.entity.findFirst({
      where: {
        id: inboundId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: INBOUND_KIND,
      },
    }),
  );
  if (!row) return;
  const d = data(row);
  if (typeof d.importedFromConnectionId !== "string" || d.connectionId) return;
  if (typeof d.fileId === "string") await deleteFile(scope, d.fileId);
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await tx.entity.deleteMany({
      where: {
        id: inboundId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: INBOUND_KIND,
      },
    });
    await audit(tx, scope, "email.inbound.import_discarded", inboundId, {
      inboundId,
    });
  });
}

import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";

// Mailboxes that a second IMAP client works on as well (ADR 0026). Everything
// here is for mailboxes carrying the webmail marker while ORBIT_WEBMAIL is on;
// without both, the fetch path behaves exactly as before.

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

/** Whether this connection is under the shared-client rules right now. */
export function sharedClientActive(
  _connectionData: Record<string, unknown>,
): boolean {
  throw new Error("WEBMAIL_NOT_IMPLEMENTED");
}

/** Sets or clears the marker; a re-save of the connection keeps it. */
export async function setSharedClient(
  _tx: DbTx,
  _scope: Scope,
  _connectionId: string,
  _on: boolean,
): Promise<void> {
  throw new Error("WEBMAIL_NOT_IMPLEMENTED");
}

/** The vetted IMAP and SMTP targets of a connection, with its password. */
export async function mailServerTargets(
  _connectionData: Record<string, unknown>,
): Promise<{ imap: MailServerTarget; smtp: MailServerTarget }> {
  throw new Error("WEBMAIL_NOT_IMPLEMENTED");
}

/**
 * Before a client removes INBOX messages: ingests exactly those not yet read
 * by Orbit, leaving the cursor alone. `ok` only when each has been ingested or
 * was deliberately skipped; every other outcome is a refusal.
 */
export async function ensureIngested(
  _scope: Scope,
  _connectionId: string,
  _selection: IngestSelection,
  _options?: { timeoutMs?: number },
): Promise<{ status: "ok" } | { status: "retry"; reason: string }> {
  throw new Error("WEBMAIL_NOT_IMPLEMENTED");
}

/** Reads one message of any folder, read-only; null when it is gone. */
export async function readMailboxMessage(
  _scope: Scope,
  _connectionId: string,
  _ref: MailboxMessageRef,
  _maxBytes: number,
): Promise<{ source: Uint8Array } | null> {
  throw new Error("WEBMAIL_NOT_IMPLEMENTED");
}

/**
 * The `inbound_emails` row holding this message's original, for a takeover:
 * an INBOX message goes through the normal ingest so no module misses it; one
 * of another folder gets a row retention can follow but polling cannot match.
 */
export async function inboundRowForImport(
  _scope: Scope,
  _connectionId: string,
  _ref: MailboxMessageRef,
  _source: Uint8Array,
): Promise<{ inboundId: string; fileId: string }> {
  throw new Error("WEBMAIL_NOT_IMPLEMENTED");
}

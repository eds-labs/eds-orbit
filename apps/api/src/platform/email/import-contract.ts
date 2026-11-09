import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";

/**
 * A module that can take over one message of a mailbox by explicit member
 * action (ADR 0026), such as Support turning it into a ticket. The module
 * handing the message over names only this contract, never the receiving
 * module. Registered as "<module>.<name>".
 *
 * The work has three steps because attachment files cannot be stored inside a
 * project transaction: `prepare` runs outside one, `commit` inside the
 * caller's, and `discard` removes what `prepare` stored when the commit fails
 * or finds the message already imported.
 */
export type EmailImportTarget = {
  label: { en: string; de: string };
  /**
   * What the member must be allowed in the receiving module. The caller checks
   * it with a scope derived for that module, never the scope of its own route:
   * a role in the handing module grants nothing in the receiving one.
   */
  permission: PermissionDef;
  /** True while the receiving module may run in the project. */
  active(tx: DbTx, scope: Scope): Promise<boolean>;
  /** Where a new record may go, such as the inboxes that can reply by mail. */
  destinations(tx: DbTx, scope: Scope): Promise<EmailImportDestination[]>;
  /** Existing records a message may be added to, matching the query. */
  searchRecords(
    tx: DbTx,
    scope: Scope,
    query: string,
  ): Promise<EmailImportRecordHit[]>;
  /** Parses the message and stores its attachments; no project lock held. */
  prepare(scope: Scope, message: EmailImportMessage): Promise<EmailImportPrepared>;
  /** Creates or extends the record in the caller's transaction. */
  commit(
    tx: DbTx,
    scope: Scope,
    prepared: EmailImportPrepared,
    mode: EmailImportMode,
  ): Promise<EmailImportResult>;
  /** Removes what `prepare` stored. */
  discard(scope: Scope, prepared: EmailImportPrepared): Promise<void>;
};

/** The message, always read again from the mailbox by the server. */
export type EmailImportMessage = {
  /** The raw RFC 822 message. */
  source: Uint8Array;
  connectionId: string;
  /** The `inbound_emails` row holding the original, which retention follows. */
  inboundId: string;
};

export type EmailImportDestination = {
  id: string;
  name: string;
  /** The address replies leave from. */
  address: string | null;
  categories: readonly string[];
  priorities: readonly string[];
};

export type EmailImportRecordHit = {
  id: string;
  number: number | null;
  title: string;
  status: string;
};

/** What the member chose in the dialog; validated against the receiving module. */
export type EmailImportMode =
  | {
      kind: "create";
      destinationId: string;
      subject?: string;
      priority?: string;
      category?: string | null;
      /** Which address of the message the customer is answered at. */
      customerAddress?: "from" | "reply_to";
    }
  | { kind: "append"; recordId: string };

/** Opaque between `prepare` and `commit`, apart from the stored files. */
export type EmailImportPrepared = {
  fileIds: readonly string[];
  skippedAttachments: number;
  payload: unknown;
};

export type EmailImportResult = {
  /** The record, in the receiving module's terms. */
  recordId: string;
  number: number | null;
  /** True when the message was already there and nothing new was written. */
  duplicate: boolean;
};

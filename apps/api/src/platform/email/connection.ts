import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  encrypt,
  list,
  publicEntity,
  update,
} from "../shared.ts";
import { registeredEmailInbound } from "../modules/contributions.ts";
import {
  connectionsOf,
  connectionVerified,
  CONNECTION_KIND,
  type ConnectionProvider,
} from "../connections/connections.ts";
import { mailboxOwner } from "./ownership.ts";
import {
  mailFactories,
  MailSendError,
  type EmailAccount,
} from "./transport.ts";

// The project's e-mail connections (WP4.7): existing mailboxes, each
// reached over SMTP (sending) and IMAP (receiving). Stored like every
// connection, as a `connectors` row with provider "email"; the password is
// only kept encrypted. No new e-mail provider and no DNS change by Orbit:
// SPF, DKIM and DMARC are the mailbox provider's, so Orbit sends only as the
// mailbox's own address.
//
// A project has one mailbox per address. Connecting another address adds a
// mailbox; connecting a known address again updates that mailbox in place
// (it needs a new login check). The default mailbox, which sends mail that
// names none (member notifications), is the verified mailbox connected
// first. Older installations may hold several rows of one address; the
// mailbox is then its oldest verified row (the one used so far), else its
// oldest row, and the other rows are ignored.

export const EMAIL_PROVIDER = "email";
/** Receiving state per mailbox, keyed by `connectionId` (inbound.ts). */
export const INBOUND_STATE_KIND = "email_inbound_state";

export function emailEnabled() {
  return loadConfig().ORBIT_EMAIL === "true";
}

/** Real delivery only in live mode with external writes; else a receipt. */
export function liveSending() {
  const c = loadConfig();
  return c.EXECUTION_MODE === "live" && c.ENABLE_EXTERNAL_WRITES === "true";
}

const host = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const port = z.number().int().min(1).max(65535);
const tls = z.enum(["implicit", "starttls"]);

export const emailConnectionInput = z
  .object({
    smtpHost: host,
    smtpPort: port.default(465),
    smtpTls: tls.default("implicit"),
    imapHost: host,
    imapPort: port.default(993),
    imapTls: tls.default("implicit"),
    username: z.string().trim().min(1).max(320),
    fromAddress: z.email().max(320),
    fromName: z.string().trim().min(1).max(100).optional(),
    password: z.string().min(1).max(1000),
  })
  .strict();

/** The account fields of a stored connection row's data. */
export function accountOf(d: Record<string, any>): EmailAccount {
  return {
    smtpHost: d.smtpHost,
    smtpPort: d.smtpPort,
    smtpTls: d.smtpTls,
    imapHost: d.imapHost,
    imapPort: d.imapPort,
    imapTls: d.imapTls,
    username: d.username,
    fromAddress: d.fromAddress,
    ...(d.fromName ? { fromName: d.fromName } : {}),
  };
}

const addressOf = (row: { data: unknown }) =>
  String(data(row).fromAddress ?? "").toLowerCase();

/**
 * The project's mailboxes, one per address (see the file comment), in the
 * order they were connected; verified or not.
 */
export async function emailMailboxes(tx: DbTx, scope: Scope) {
  const rows = (await connectionsOf(tx, scope, EMAIL_PROVIDER)).sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  const byAddress = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const known = byAddress.get(addressOf(row));
    if (
      !known ||
      (!connectionVerified(data(known).status) &&
        connectionVerified(data(row).status))
    )
      byAddress.set(addressOf(row), row);
  }
  return [...byAddress.values()].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
}

/** The verified mailbox connected first: it sends mail that names none. */
export async function defaultEmailConnection(tx: DbTx, scope: Scope) {
  return (
    (await emailMailboxes(tx, scope)).find((row) =>
      connectionVerified(data(row).status),
    ) ?? null
  );
}

/**
 * A verified mailbox of the project: the one `connectionId` names, or the
 * default mailbox without an id. Null when it is not (or no longer) one.
 */
export async function verifiedEmailConnection(
  tx: DbTx,
  scope: Scope,
  connectionId?: string | null,
) {
  if (!connectionId) return defaultEmailConnection(tx, scope);
  return (
    (await emailMailboxes(tx, scope)).find(
      (row) => row.id === connectionId && connectionVerified(data(row).status),
    ) ?? null
  );
}

/**
 * Owner only: connects a mailbox. A new address adds one; a known address
 * updates its mailbox in place, which then needs a new login check.
 */
export async function connectEmail(tx: DbTx, scope: Scope, raw: unknown) {
  if (!emailEnabled()) throw new DomainError("NOT_FOUND", 404);
  const { password, ...account } = emailConnectionInput.parse(raw);
  for (const name of [account.smtpHost, account.imapHost])
    try {
      await mailFactories().checkHost(name);
    } catch (error) {
      throw new DomainError(
        error instanceof MailSendError ? error.code : "MAIL_HOST_INVALID",
      );
    }
  const fields = {
    provider: EMAIL_PROVIDER,
    ...account,
    encryptedCredential: encrypt(password, loadConfig().CREDENTIAL_KEY),
    status: "configured",
    capabilities: [],
  };
  const known = (await emailMailboxes(tx, scope)).find(
    (row) => addressOf(row) === account.fromAddress.toLowerCase(),
  );
  // A re-save keeps the mailbox's owner module (ownership.ts).
  const owner = known ? mailboxOwner(data(known)) : null;
  const row = known
    ? await update(tx, scope, known, {
        ...fields,
        ...(owner ? { ownerModule: owner } : {}),
      })
    : await create(tx, scope, CONNECTION_KIND, fields);
  await audit(tx, scope, known ? "email.updated" : "email.connected", row.id, {
    smtpHost: account.smtpHost,
    imapHost: account.imapHost,
  });
  return publicEntity(row);
}

/**
 * Owner only: removes a mailbox (every row of its address) with its
 * receiving state. Refused while a module still uses it, such as a live
 * support inbox; modules let go of archived uses first.
 */
export async function disconnectEmail(tx: DbTx, scope: Scope, raw: unknown) {
  if (!emailEnabled()) throw new DomainError("NOT_FOUND", 404);
  const { connectorId } = z
    .object({ connectorId: z.uuid() })
    .strict()
    .parse(raw);
  const mailbox = (await emailMailboxes(tx, scope)).find(
    (row) => row.id === connectorId,
  );
  if (!mailbox) throw new DomainError("EMAIL_MAILBOX_NOT_FOUND", 404);
  for (const { mailboxUse } of registeredEmailInbound())
    if (mailboxUse && (await mailboxUse.inUse(tx, scope, mailbox.id)) > 0)
      throw new DomainError("EMAIL_MAILBOX_IN_USE", 409);
  for (const { mailboxUse } of registeredEmailInbound())
    await mailboxUse?.release(tx, scope, mailbox.id);
  const rows = (await connectionsOf(tx, scope, EMAIL_PROVIDER)).filter(
    (row) => addressOf(row) === addressOf(mailbox),
  );
  const ids = rows.map((row) => row.id);
  const states = (await list(tx, scope, INBOUND_STATE_KIND)).filter((row) =>
    ids.includes(String(data(row).connectionId)),
  );
  await tx.entity.deleteMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      id: { in: [...ids, ...states.map((row) => row.id)] },
    },
  });
  await audit(tx, scope, "email.disconnected", mailbox.id, {
    rows: ids.length,
  });
  return { removed: mailbox.id };
}

/**
 * Logs in to SMTP and IMAP without sending anything: `read_verified`.
 * `write_verified` would need a real test message, which needs approval.
 */
export const emailConnectionProvider: ConnectionProvider = {
  async check(connection, password) {
    // No login to the mailbox while e-mail is off, even for an old row.
    if (!emailEnabled()) throw new DomainError("NOT_FOUND", 404);
    const account = accountOf(connection);
    const factories = mailFactories();
    // Which side failed, as a code only (no server text).
    const refuse = (side: string) => (error: unknown) => {
      const code = error instanceof MailSendError ? error.code : "ERROR";
      throw new DomainError(
        `${side}_${code.replace(/[^A-Z0-9_]/gi, "_").toUpperCase()}`,
        409,
      );
    };
    const transport = factories.transport(account, password);
    try {
      await transport.verify().catch(refuse("SMTP"));
    } finally {
      transport.close();
    }
    await factories.mailbox(account, password).verify().catch(refuse("IMAP"));
    return {
      status: "read_verified",
      capabilities: ["smtp_login", "imap_read"],
      checkedAt: new Date().toISOString(),
    };
  },
};

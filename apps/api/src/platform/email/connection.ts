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
  publicEntity,
} from "../shared.ts";
import {
  connectionsOf,
  connectionVerified,
  CONNECTION_KIND,
  type ConnectionProvider,
} from "../connections/connections.ts";
import {
  mailFactories,
  MailSendError,
  type EmailAccount,
} from "./transport.ts";

// The project's e-mail connection (WP4.7): one existing mailbox, reached
// over SMTP (sending) and IMAP (receiving). Stored like every connection,
// as a `connectors` row with provider "email"; the password is only kept
// encrypted. No new e-mail provider and no DNS change by Orbit: SPF, DKIM
// and DMARC are the mailbox provider's, so Orbit sends only as the
// mailbox's own address.

export const EMAIL_PROVIDER = "email";

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

/** Owner only: a new e-mail connection replaces nothing; checks follow. */
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
  const row = await create(tx, scope, CONNECTION_KIND, {
    provider: EMAIL_PROVIDER,
    ...account,
    encryptedCredential: encrypt(password, loadConfig().CREDENTIAL_KEY),
    status: "configured",
    capabilities: [],
  });
  await audit(tx, scope, "email.connected", row.id, {
    smtpHost: account.smtpHost,
    imapHost: account.imapHost,
  });
  return publicEntity(row);
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

/** The project's newest verified e-mail connection, or null. */
export async function verifiedEmailConnection(tx: DbTx, scope: Scope) {
  const rows = (await connectionsOf(tx, scope, EMAIL_PROVIDER)).filter((row) =>
    connectionVerified(data(row).status),
  );
  return rows.at(-1) ?? null;
}

import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { create, credentialKey, encrypt } from "../../src/shared.ts";
import { createInbox } from "../../src/modules/support/inboxes.ts";

/**
 * A verified e-mail mailbox row of the project, as a login check leaves
 * it, for tests that need an e-mail inbox but no SMTP or IMAP stubs.
 * Returns its connection id.
 */
export async function verifiedMailbox(tx: DbTx, scope: Scope, address: string) {
  const row = await create(tx, scope, "connectors", {
    provider: "email",
    smtpHost: "smtp.mailbox.example.com",
    smtpPort: 465,
    smtpTls: "implicit",
    imapHost: "imap.mailbox.example.com",
    imapPort: 993,
    imapTls: "implicit",
    username: address,
    fromAddress: address,
    encryptedCredential: encrypt("synthetic-mailbox-password", credentialKey()),
    status: "read_verified",
    capabilities: ["smtp_login", "imap_read"],
  });
  return row.id;
}

/**
 * Creates an e-mail inbox bound to a new verified mailbox of its
 * `emailAddress` (every e-mail inbox answers from its own mailbox).
 */
export async function createMailInbox(
  tx: DbTx,
  scope: Scope,
  input: Record<string, unknown> & { emailAddress: string },
) {
  const { emailAddress, ...rest } = input;
  return createInbox(tx, scope, {
    ...rest,
    emailConnectionId: await verifiedMailbox(tx, scope, emailAddress),
  });
}

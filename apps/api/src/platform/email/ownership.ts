import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, data, DomainError, entity, update } from "../shared.ts";
import { CONNECTION_KIND } from "../connections/connections.ts";

// Mailbox ownership: a mailbox may name one module as its owner
// (`ownerModule` in the connection row's data). Inbound mail of an owned
// mailbox goes only to that module's `emailInbound` consumer; an unowned
// mailbox keeps broadcasting to every consumer. The owner is a module id
// string and is not validated against the registry here, so a module that is
// unavailable keeps its claim.

/** The owner module of a mailbox connection's data, or null when unowned. */
export function mailboxOwner(
  connectionData: Record<string, unknown>,
): string | null {
  const owner = connectionData.ownerModule;
  return typeof owner === "string" && owner ? owner : null;
}

async function mailboxRow(tx: DbTx, scope: Scope, connectionId: string) {
  const row = await entity(tx, scope, CONNECTION_KIND, connectionId);
  if (data(row).provider !== "email")
    throw new DomainError("EMAIL_MAILBOX_NOT_FOUND", 404);
  return row;
}

/** Throws 409 EMAIL_MAILBOX_OWNED when another module owns the mailbox. */
export async function assertMailboxUnowned(
  tx: DbTx,
  scope: Scope,
  connectionId: string,
  moduleId: string,
) {
  const owner = mailboxOwner(data(await mailboxRow(tx, scope, connectionId)));
  if (owner && owner !== moduleId)
    throw new DomainError("EMAIL_MAILBOX_OWNED", 409);
}

/**
 * Claims a mailbox for a module, or releases it with `null`. Another
 * module's claim is refused; the audit names ids only.
 */
export async function setMailboxOwner(
  tx: DbTx,
  scope: Scope,
  connectionId: string,
  moduleId: string | null,
) {
  const row = await mailboxRow(tx, scope, connectionId);
  const current = data(row);
  const owner = mailboxOwner(current);
  if (owner && moduleId !== null && owner !== moduleId)
    throw new DomainError("EMAIL_MAILBOX_OWNED", 409);
  if (owner === moduleId) return;
  const { ownerModule: _removed, ...rest } = current;
  await update(
    tx,
    scope,
    row,
    moduleId ? { ...rest, ownerModule: moduleId } : rest,
  );
  await audit(tx, scope, "email.mailbox.owner_set", connectionId, {
    connectionId,
    ownerModule: moduleId,
  });
}

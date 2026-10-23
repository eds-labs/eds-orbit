import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, data, DomainError, entity } from "../../shared.ts";
import { CONNECTION_KIND } from "../../platform/connections/connections.ts";
import { mailboxOwner, setMailboxOwner } from "../../platform/email/ownership.ts";
import type { MailboxUse } from "../../platform/modules/contributions.ts";

// E-mail connections bound to finance. A binding claims the mailbox for the
// finance module (platform/email/ownership.ts), so its mail reaches finance
// only; Support's claim and finance's exclude each other.

export const bindMailboxInput = z
  .object({
    emailConnectionId: z.uuid(),
    archiveFolder: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\u0000-\u001f]+$/, "Invalid folder")
      .optional(),
  })
  .strict();

export function listMailboxBindings(tx: DbTx, scope: Scope) {
  return tx.financeMailbox.findMany({
    where: { projectId: scope.projectId },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Claims an e-mail connection of the project for finance. The platform
 * refuses a mailbox another module owns (409 EMAIL_MAILBOX_OWNED) and one
 * that is not an e-mail connection (404). A binding that was switched off
 * by an earlier unbind is reactivated.
 */
export async function bindMailbox(tx: DbTx, scope: Scope, raw: unknown) {
  const input = bindMailboxInput.parse(raw);
  const existing = await tx.financeMailbox.findFirst({
    where: {
      projectId: scope.projectId,
      emailConnectionId: input.emailConnectionId,
    },
  });
  if (existing?.active) throw new DomainError("FINANCE_MAILBOX_BOUND", 409);
  await setMailboxOwner(tx, scope, input.emailConnectionId, "finance");
  let row;
  if (existing) {
    row = await tx.financeMailbox.update({
      where: { id: existing.id },
      data: {
        active: true,
        ...(input.archiveFolder ? { archiveFolder: input.archiveFolder } : {}),
        version: { increment: 1 },
      },
    });
  } else {
    row = await tx.financeMailbox.create({
      data: {
        id: randomUUID(),
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        emailConnectionId: input.emailConnectionId,
        ...(input.archiveFolder ? { archiveFolder: input.archiveFolder } : {}),
      },
    });
  }
  await audit(tx, scope, "finance.mailbox.bound", row.id, {
    mailboxId: row.id,
    connectionId: input.emailConnectionId,
  });
  return row;
}

/**
 * Releases the mailbox. A binding documents point at is switched off so the
 * documents keep their source; an unreferenced one is deleted.
 */
export async function unbindMailbox(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.financeMailbox.findFirst({
    where: { id, projectId: scope.projectId },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  // An already switched-off binding has nothing left to release; the
  // mailbox may belong to another module by now.
  if (!row.active) return;
  const connection = await entity(
    tx,
    scope,
    CONNECTION_KIND,
    row.emailConnectionId,
  );
  if (mailboxOwner(data(connection)) === "finance")
    await setMailboxOwner(tx, scope, row.emailConnectionId, null);
  const documents = await tx.financeDocument.count({
    where: { projectId: scope.projectId, mailboxId: id },
  });
  if (documents > 0)
    await tx.financeMailbox.update({
      where: { id },
      data: { active: false, version: { increment: 1 } },
    });
  else await tx.financeMailbox.delete({ where: { id } });
  await audit(tx, scope, "finance.mailbox.unbound", id, {
    mailboxId: id,
    connectionId: row.emailConnectionId,
  });
}

/**
 * Finance's use of a mailbox: an active binding blocks removing it.
 * Switched-off bindings let go when the mailbox is removed; documents keep
 * their text, the link to the binding is cleared by the database.
 */
export const financeMailboxUse: MailboxUse = {
  inUse: (tx, scope, connectionId) =>
    tx.financeMailbox.count({
      where: {
        projectId: scope.projectId,
        emailConnectionId: connectionId,
        active: true,
      },
    }),
  async release(tx, scope, connectionId) {
    await tx.financeMailbox.deleteMany({
      where: { projectId: scope.projectId, emailConnectionId: connectionId },
    });
  },
};

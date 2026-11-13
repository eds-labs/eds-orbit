import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authDb, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  connectionVerified,
  CONNECTION_KIND,
} from "../../platform/connections/connections.ts";
import {
  emailMailboxes,
  INBOUND_STATE_KIND,
} from "../../platform/email/connection.ts";
import { mailboxOwner } from "../../platform/email/ownership.ts";
import { setSharedClient } from "../../platform/email/shared-client.ts";
import type { MailboxUse } from "../../platform/modules/contributions.ts";
import { actorScope } from "../../platform/tenancy/member-scope.ts";
import { can } from "../../platform/tenancy/permissions.ts";
import { audit, data, DomainError, entity, list } from "../../shared.ts";
import {
  capabilitiesOf,
  effectiveCapabilities,
  grantOf,
  loadMailbox,
  mailboxNotFound,
  memberAdmitted,
  operatingState,
  type GrantFlags,
} from "./access.ts";
import { WEBMAIL_SETTINGS } from "./permissions.ts";
import {
  revokeMailboxSessions,
  revokeMemberSessions,
  webmailOrigin,
} from "./sessions.ts";

// The mailboxes of a project opened for webmail, and who holds which grant.

const displayName = z.string().trim().min(1).max(100);

export const openMailboxInput = z
  .object({
    connectionId: z.uuid(),
    displayName: displayName.optional(),
    sensitive: z.boolean().optional(),
  })
  .strict();

export const updateMailboxInput = z
  .object({
    version: z.number().int().positive(),
    enabled: z.boolean().optional(),
    displayName: displayName.nullable().optional(),
    sensitive: z.boolean().optional(),
  })
  .strict();

export const grantInput = z
  .object({
    canRead: z.boolean(),
    canSend: z.boolean(),
    canOrganize: z.boolean(),
    canConvert: z.boolean(),
    canManage: z.boolean(),
  })
  .strict();

const flagsOf = (grant: GrantFlags): GrantFlags => ({
  canRead: grant.canRead,
  canSend: grant.canSend,
  canOrganize: grant.canOrganize,
  canConvert: grant.canConvert,
  canManage: grant.canManage,
});

/** The mailboxes the member can read or manage, with their current state. */
export async function listMemberMailboxes(tx: DbTx, scope: Scope) {
  const grants = await tx.webmailMailboxGrant.findMany({
    where: {
      projectId: scope.projectId,
      userId: scope.userId,
      OR: [{ canRead: true }, { canManage: true }],
    },
  });
  const states = await list(tx, scope, INBOUND_STATE_KIND);
  const operating = await operatingState(tx, scope);
  const mailboxes = [];
  for (const grant of grants) {
    const found = await loadMailbox(tx, scope, grant.mailboxId);
    if (!found || !(await memberAdmitted(scope, found.connection))) continue;
    const { mailbox, connection } = found;
    const state = states.find(
      (row) => data(row).connectionId === mailbox.emailConnectionId,
    );
    const lastError =
      (state && (data(state).lastError as string | null | undefined)) ?? null;
    const verified = connectionVerified(connection.status);
    mailboxes.push({
      id: mailbox.id,
      address: String(connection.fromAddress ?? ""),
      displayName: mailbox.displayName,
      sensitive: mailbox.sensitive,
      capabilities: effectiveCapabilities(capabilitiesOf(grant), operating),
      status: !mailbox.enabled ? "disabled" : verified ? "ok" : "error",
      sync: lastError
        ? "error"
        : state && data(state).backlogUntil != null
          ? "backlog"
          : "ok",
      lastError: lastError ?? (verified ? null : "CONNECTION_NOT_VERIFIED"),
    });
  }
  return { origin: webmailOrigin(), mailboxes };
}

const mailboxView = (row: {
  id: string;
  emailConnectionId: string;
  displayName: string | null;
  enabled: boolean;
  sensitive: boolean;
  version: number;
}) => ({
  id: row.id,
  connectionId: row.emailConnectionId,
  displayName: row.displayName,
  enabled: row.enabled,
  sensitive: row.sensitive,
  version: row.version,
});

/** The project's mailboxes and which of them are open for webmail. */
export async function webmailSettings(tx: DbTx, scope: Scope) {
  const opened = await tx.webmailMailbox.findMany({
    where: { projectId: scope.projectId },
  });
  return {
    connections: (await emailMailboxes(tx, scope)).map((row) => {
      const mailbox = opened.find((m) => m.emailConnectionId === row.id);
      return {
        connectionId: row.id,
        address: String(data(row).fromAddress ?? ""),
        owner: mailboxOwner(data(row)),
        opened: mailbox
          ? {
              id: mailbox.id,
              enabled: mailbox.enabled,
              sensitive: mailbox.sensitive,
              displayName: mailbox.displayName,
              version: mailbox.version,
            }
          : null,
      };
    }),
  };
}

/** Opens a mailbox; one another module owns needs that module's permission. */
export async function openMailbox(tx: DbTx, scope: Scope, raw: unknown) {
  const input = openMailboxInput.parse(raw);
  const connection = data(
    await entity(tx, scope, CONNECTION_KIND, input.connectionId),
  );
  if (connection.provider !== "email")
    throw new DomainError("EMAIL_MAILBOX_NOT_FOUND", 404);
  if (!(await memberAdmitted(scope, connection)))
    throw new DomainError("FORBIDDEN", 403);
  const existing = await tx.webmailMailbox.findFirst({
    where: {
      projectId: scope.projectId,
      emailConnectionId: input.connectionId,
    },
  });
  if (existing) throw new DomainError("WEBMAIL_MAILBOX_ALREADY_OPEN", 409);
  await setSharedClient(tx, scope, input.connectionId, true);
  const row = await tx.webmailMailbox.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      emailConnectionId: input.connectionId,
      displayName: input.displayName ?? null,
      sensitive: Boolean(input.sensitive) || mailboxOwner(connection) !== null,
      createdBy: scope.userId,
    },
  });
  await audit(tx, scope, "webmail.mailbox.opened", row.id, {
    connectionId: input.connectionId,
  });
  return mailboxView(row);
}

/** A mailbox of the settings routes; another module's needs its permission. */
async function settingsMailbox(tx: DbTx, scope: Scope, mailboxId: string) {
  const found = await loadMailbox(tx, scope, mailboxId);
  if (!found || !(await memberAdmitted(scope, found.connection)))
    throw mailboxNotFound();
  return found;
}

export async function updateMailbox(
  tx: DbTx,
  scope: Scope,
  mailboxId: string,
  raw: unknown,
) {
  const input = updateMailboxInput.parse(raw);
  const { mailbox, connection } = await settingsMailbox(tx, scope, mailboxId);
  const { count } = await tx.webmailMailbox.updateMany({
    where: {
      id: mailboxId,
      projectId: scope.projectId,
      version: input.version,
    },
    data: {
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.displayName === undefined
        ? {}
        : { displayName: input.displayName }),
      ...(input.sensitive === undefined
        ? {}
        : { sensitive: input.sensitive || mailboxOwner(connection) !== null }),
      version: { increment: 1 },
    },
  });
  if (count !== 1) throw new DomainError("VERSION_CONFLICT", 409);
  const switched =
    input.enabled !== undefined && input.enabled !== mailbox.enabled;
  if (switched) {
    await setSharedClient(tx, scope, mailbox.emailConnectionId, input.enabled!);
    if (!input.enabled)
      await revokeMailboxSessions(tx, scope, mailboxId, "mailbox_disabled");
  }
  await audit(
    tx,
    scope,
    switched
      ? input.enabled
        ? "webmail.mailbox.opened"
        : "webmail.mailbox.closed"
      : "webmail.mailbox.updated",
    mailboxId,
    { connectionId: mailbox.emailConnectionId },
  );
  return mailboxView(
    await tx.webmailMailbox.findUniqueOrThrow({ where: { id: mailboxId } }),
  );
}

/** Closes a mailbox for good: its grants, sessions and claims go with it. */
export async function closeMailbox(tx: DbTx, scope: Scope, mailboxId: string) {
  const { mailbox } = await settingsMailbox(tx, scope, mailboxId);
  await setSharedClient(tx, scope, mailbox.emailConnectionId, false);
  await tx.webmailMailbox.delete({ where: { id: mailboxId } });
  await audit(tx, scope, "webmail.mailbox.closed", mailboxId, {
    connectionId: mailbox.emailConnectionId,
    deleted: true,
  });
}

/** Settings or `canManage`; everyone else sees a mailbox that does not exist. */
async function managedMailbox(tx: DbTx, scope: Scope, mailboxId: string) {
  const found = await loadMailbox(tx, scope, mailboxId);
  if (!found) throw mailboxNotFound();
  const settings = can(scope, WEBMAIL_SETTINGS);
  if (!settings) {
    const grant = await grantOf(tx, scope, mailboxId, scope.userId);
    if (!grant?.canManage) throw mailboxNotFound();
  }
  if (!(await memberAdmitted(scope, found.connection))) throw mailboxNotFound();
  return { ...found, settings };
}

/** Who has access to the project, for the grant list. */
async function projectPeople(projectId: string) {
  const user = { select: { id: true, name: true, email: true, banned: true } };
  const project = await authDb.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      kind: true,
      members: { select: { user } },
      workspace: {
        select: { members: { where: { role: "owner" }, select: { user } } },
      },
    },
  });
  const rows = [
    ...project.members,
    ...(project.kind === "personal" ? [] : project.workspace.members),
  ];
  const people = new Map(
    rows.filter((r) => !r.user.banned).map((r) => [r.user.id, r.user]),
  );
  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function listGrants(tx: DbTx, scope: Scope, mailboxId: string) {
  await managedMailbox(tx, scope, mailboxId);
  const grants = await tx.webmailMailboxGrant.findMany({
    where: { projectId: scope.projectId, mailboxId },
  });
  return {
    members: (await projectPeople(scope.projectId)).map((person) => {
      const grant = grants.find((row) => row.userId === person.id);
      return {
        userId: person.id,
        name: person.name,
        email: person.email,
        grant: grant ? flagsOf(grant) : null,
      };
    }),
  };
}

/**
 * Sets a member's grant, or removes it when every right is false. Their open
 * sessions on the mailbox end at once. `canManage` is meant to administer a
 * mailbox without reading it, so a manager without the settings permission
 * can neither change their own grant, nor hand out `canManage`, nor touch the
 * grant of another manager: two managers could grant each other read.
 */
export async function setGrant(
  tx: DbTx,
  scope: Scope,
  mailboxId: string,
  userId: string,
  raw: unknown,
) {
  const input = grantInput.parse(raw);
  const { settings } = await managedMailbox(tx, scope, mailboxId);
  if (!settings) {
    if (userId === scope.userId)
      throw new DomainError("WEBMAIL_SELF_GRANT_FORBIDDEN", 403);
    const current = await grantOf(tx, scope, mailboxId, userId);
    if (input.canManage || current?.canManage)
      throw new DomainError("WEBMAIL_MANAGE_RIGHT_FORBIDDEN", 403);
  }
  const member = await actorScope(scope.workspaceId, scope.projectId, userId);
  if (!member) throw new DomainError("MEMBER_NOT_FOUND", 404);
  const key = {
    projectId_mailboxId_userId: {
      projectId: scope.projectId,
      mailboxId,
      userId,
    },
  };
  if (Object.values(input).some(Boolean))
    await tx.webmailMailboxGrant.upsert({
      where: key,
      create: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        mailboxId,
        userId,
        ...input,
        grantedBy: scope.userId,
      },
      update: { ...input, grantedBy: scope.userId },
    });
  else
    await tx.webmailMailboxGrant.deleteMany({
      where: { projectId: scope.projectId, mailboxId, userId },
    });
  await revokeMemberSessions(tx, scope, mailboxId, userId, "grant_changed");
  await audit(tx, scope, "webmail.grant.changed", mailboxId, {
    userId,
    self: userId === scope.userId,
    ...input,
  });
  return { userId, ...input };
}

/** Grants of members who lost the project go; so do their sessions. */
export async function removeOrphanedGrants(tx: DbTx, scope: Scope) {
  const grants = await tx.webmailMailboxGrant.findMany({
    where: { projectId: scope.projectId },
    select: { mailboxId: true, userId: true },
  });
  let removed = 0;
  const access = new Map<string, boolean>();
  for (const { mailboxId, userId } of grants) {
    if (!access.has(userId))
      access.set(
        userId,
        (await actorScope(scope.workspaceId, scope.projectId, userId)) !== null,
      );
    if (access.get(userId)) continue;
    await tx.webmailMailboxGrant.deleteMany({
      where: { projectId: scope.projectId, mailboxId, userId },
    });
    await revokeMemberSessions(tx, scope, mailboxId, userId, "access_lost");
    removed++;
  }
  return removed;
}

/**
 * Webmail never blocks removing a mailbox. A connection that goes away takes
 * the webmail mailbox along, and webmail itself stores no mail.
 */
export const webmailMailboxUse: MailboxUse = {
  inUse: async () => 0,
  receivesMail: async () => false,
  async release(tx, scope, connectionId) {
    const row = await tx.webmailMailbox.findFirst({
      where: { projectId: scope.projectId, emailConnectionId: connectionId },
    });
    if (!row) return;
    await setSharedClient(tx, scope, connectionId, false);
    await tx.webmailMailbox.delete({ where: { id: row.id } });
    await audit(tx, scope, "webmail.mailbox.closed", row.id, {
      connectionId,
      connectionRemoved: true,
    });
  },
};

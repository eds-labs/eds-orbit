import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  publicOrigin,
  revokePublicKey,
  setPublicKeyOrigins,
} from "../../platform/http/public-api.ts";
import {
  audit,
  credentialKey,
  data,
  DomainError,
  encrypt,
} from "../../shared.ts";
import {
  defaultEmailConnection,
  emailMailboxes,
  verifiedEmailConnection,
} from "../../platform/email/connection.ts";
import { assertMailboxUnowned } from "../../platform/email/ownership.ts";
import { connectionVerified } from "../../platform/connections/connections.ts";
import { customerContextConnections } from "../../platform/customer-context/connection.ts";
import type { MailboxUse } from "../../platform/modules/contributions.ts";
import { inboxRulesSchema } from "./settings.ts";

// Support inboxes (06 §2.1): one entry point each, an e-mail address and/or
// a widget. The widget's HMAC secret is generated here, stored encrypted and
// shown only in the create and rotate answers. Audits name fields, never
// values, so neither secrets nor addresses reach the audit log.
//
// An e-mail inbox is bound to one verified mailbox of the project (its
// `emailConnectionId`) and its address is that mailbox's own address: an
// inbox never claims an address on the strength of what an owner typed
// (WP5.3), and no two live inboxes share a mailbox (also a partial unique
// index). Inboxes from before the binding may be unbound; channels/email.ts
// keeps their single-mailbox behaviour until they are saved again.

const fields = {
  name: z.string().trim().min(1).max(80),
  channels: z
    .array(z.enum(["email", "widget"]))
    .min(1)
    .max(2)
    .refine((c) => new Set(c).size === c.length, "Channels must be unique"),
  emailAddress: z.email().max(254).nullable(),
  emailConnectionId: z.uuid().nullable(),
  allowedOrigins: z.array(publicOrigin).max(10),
  defaultCategory: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,40}$/)
    .nullable(),
  assignmentPolicy: z.enum(["unassigned", "round_robin", "fixed"]),
  defaultAssigneeUserId: z.string().min(1).max(100).nullable(),
  language: z.enum(["en", "de"]),
  // "widget_answer" follows with WP5.6, after Q-17.
  aiMode: z.enum(["off", "draft"]),
  rules: inboxRulesSchema,
};
const createInput = z
  .object({
    name: fields.name,
    channels: fields.channels,
    emailAddress: fields.emailAddress.optional(),
    emailConnectionId: fields.emailConnectionId.optional(),
    allowedOrigins: fields.allowedOrigins.optional(),
    defaultCategory: fields.defaultCategory.optional(),
    assignmentPolicy: fields.assignmentPolicy.optional(),
    defaultAssigneeUserId: fields.defaultAssigneeUserId.optional(),
    language: fields.language.optional(),
    aiMode: fields.aiMode.optional(),
    rules: fields.rules.optional(),
  })
  .strict();
const updateInput = z
  .object({
    version: z.number().int().min(1),
    name: fields.name.optional(),
    channels: fields.channels.optional(),
    emailAddress: fields.emailAddress.optional(),
    emailConnectionId: fields.emailConnectionId.optional(),
    allowedOrigins: fields.allowedOrigins.optional(),
    defaultCategory: fields.defaultCategory.optional(),
    assignmentPolicy: fields.assignmentPolicy.optional(),
    defaultAssigneeUserId: fields.defaultAssigneeUserId.optional(),
    language: fields.language.optional(),
    aiMode: fields.aiMode.optional(),
    rules: fields.rules.optional(),
  })
  .strict();

type InboxRow = Awaited<ReturnType<DbTx["supportInbox"]["findFirstOrThrow"]>>;
export type InboxView = Omit<InboxRow, "widgetSecretEnc"> & {
  hasWidgetSecret: boolean;
};

/** An inbox as members see it: everything but the encrypted secret. */
export function inboxView(row: InboxRow): InboxView {
  const { widgetSecretEnc, ...rest } = row;
  return { ...rest, hasWidgetSecret: Boolean(widgetSecretEnc) };
}

/** A channel needs its entry point: origins for the widget (mailbox below). */
function assertChannels(row: { channels: string[]; allowedOrigins: string[] }) {
  const issues: string[] = [];
  if (row.channels.includes("widget") && !row.allowedOrigins.length)
    issues.push("A widget inbox needs at least one allowed origin");
  if (issues.length)
    throw new z.ZodError(
      issues.map((message) => ({
        code: "custom",
        message,
        path: [],
        input: row,
      })),
    );
}

/**
 * The mailbox fields of an inbox: for the e-mail channel, a verified
 * mailbox of the project that no other live inbox answers from, and the
 * mailbox's own address (an address given must be that one); without the
 * e-mail channel, no mailbox and the address is left alone. `current` is
 * the inbox being saved: its unchanged mailbox may be unverified for the
 * moment (a login check pending), so other fields stay editable.
 */
async function mailboxFields(
  tx: DbTx,
  scope: Scope,
  row: {
    channels: string[];
    emailAddress?: string | null;
    emailConnectionId?: string | null;
  },
  current?: { id: string; emailConnectionId: string | null },
) {
  if (!row.channels.includes("email")) return { emailConnectionId: null };
  const id = row.emailConnectionId;
  const connection = id
    ? id === current?.emailConnectionId
      ? ((await emailMailboxes(tx, scope)).find((m) => m.id === id) ?? null)
      : await verifiedEmailConnection(tx, scope, id)
    : null;
  if (!connection) throw new DomainError("INBOX_MAILBOX_INVALID", 400);
  await assertMailboxUnowned(tx, scope, connection.id, "support");
  const address = String(data(connection).fromAddress);
  if (
    row.emailAddress &&
    row.emailAddress.toLowerCase() !== address.toLowerCase()
  )
    throw new DomainError("INBOX_ADDRESS_NOT_MAILBOX", 400);
  const others = await tx.supportInbox.findMany({
    where: {
      projectId: scope.projectId,
      archivedAt: null,
      ...(current ? { id: { not: current.id } } : {}),
    },
  });
  if (
    others.some(
      (other) =>
        other.emailConnectionId === connection.id ||
        (other.channels.includes("email") &&
          other.emailAddress?.toLowerCase() === address.toLowerCase()),
    )
  )
    throw new DomainError("INBOX_MAILBOX_TAKEN", 409);
  return { emailConnectionId: connection.id, emailAddress: address };
}

/**
 * A customer context binding must name an integration of this project
 * (ADR 0011). Whether it is verified is checked on every read, so an
 * unchanged binding stays saveable while its check is pending.
 */
async function assertCustomerContextBinding(
  tx: DbTx,
  scope: Scope,
  rules: { customerContext?: { connectionId: string } | null } | undefined,
  current?: unknown,
) {
  const id = rules?.customerContext?.connectionId;
  if (!id) return;
  const before = inboxRulesSchema.safeParse(current ?? {});
  if (before.success && before.data.customerContext?.connectionId === id)
    return;
  const known = (await customerContextConnections(tx, scope)).some(
    (row) => row.id === id,
  );
  if (!known) throw new DomainError("INBOX_CUSTOMER_CONTEXT_INVALID", 400);
}

/**
 * The project's mailboxes as the inbox form offers them: address, sender
 * name, whether verified and the default, and the live inbox bound to it.
 * Never a credential or server setting.
 */
export async function listMailboxes(tx: DbTx, scope: Scope) {
  const fallback = await defaultEmailConnection(tx, scope);
  const inboxes = await tx.supportInbox.findMany({
    where: {
      projectId: scope.projectId,
      archivedAt: null,
      emailConnectionId: { not: null },
    },
  });
  return (await emailMailboxes(tx, scope)).map((row) => ({
    id: row.id,
    address: String(data(row).fromAddress),
    name: (data(row).fromName as string | undefined) ?? null,
    verified: connectionVerified(data(row).status),
    isDefault: row.id === fallback?.id,
    inboxId: inboxes.find((i) => i.emailConnectionId === row.id)?.id ?? null,
  }));
}

/** Live inboxes answering from a mailbox: they keep it from being removed. */
export const supportMailboxUse: MailboxUse = {
  inUse: (tx, scope, connectionId) =>
    tx.supportInbox.count({
      where: {
        projectId: scope.projectId,
        emailConnectionId: connectionId,
        archivedAt: null,
      },
    }),
  // Archived inboxes let go; their tickets' mail falls back to the default
  // mailbox (channels/email.ts).
  async release(tx, scope, connectionId) {
    await tx.supportInbox.updateMany({
      where: { projectId: scope.projectId, emailConnectionId: connectionId },
      data: { emailConnectionId: null },
    });
  },
};

const newSecret = () => randomBytes(32).toString("base64url");

/** Loads a live inbox of the project, or 404. */
export async function loadInbox(tx: DbTx, scope: Scope, id: string) {
  const row = await tx.supportInbox.findFirst({
    where: { id, workspaceId: scope.workspaceId, projectId: scope.projectId },
  });
  if (!row) throw new DomainError("INBOX_NOT_FOUND", 404);
  return row;
}

export async function listInboxes(tx: DbTx, scope: Scope) {
  const rows = await tx.supportInbox.findMany({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(inboxView);
}

export async function createInbox(tx: DbTx, scope: Scope, raw: unknown) {
  const input = createInput.parse(raw);
  const base = {
    ...input,
    emailAddress: input.emailAddress ?? null,
    allowedOrigins: input.allowedOrigins ?? [],
  };
  assertChannels(base);
  await assertCustomerContextBinding(tx, scope, input.rules);
  const row = { ...base, ...(await mailboxFields(tx, scope, base)) };
  const widgetSecret = row.channels.includes("widget")
    ? newSecret()
    : undefined;
  const created = await tx.supportInbox.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      ...row,
      widgetSecretEnc: widgetSecret
        ? encrypt(widgetSecret, credentialKey())
        : null,
      createdBy: scope.userId,
    },
  });
  await audit(tx, scope, "support.inbox.created", created.id, {
    inboxId: created.id,
    version: created.version,
    channels: created.channels,
  });
  return {
    inbox: inboxView(created),
    ...(widgetSecret ? { widgetSecret } : {}),
  };
}

export async function updateInbox(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
) {
  const { version, ...changes } = updateInput.parse(raw);
  const current = await loadInbox(tx, scope, id);
  if (current.archivedAt) throw new DomainError("INBOX_ARCHIVED", 409);
  if (current.version !== version)
    throw new DomainError("INBOX_VERSION_CONFLICT", 409);
  const next = { ...current, ...changes };
  assertChannels(next);
  await assertCustomerContextBinding(tx, scope, changes.rules, current.rules);
  const mailbox = await mailboxFields(
    tx,
    scope,
    // A legacy inbox's unchanged address is not a claim: the mailbox's wins.
    { ...next, emailAddress: changes.emailAddress ?? null },
    current,
  );
  // Removing the widget drops its secret, so a re-added widget never revives
  // an old (possibly leaked) one; a new secret is shown by a rotation.
  const widgetSecretEnc = !next.channels.includes("widget")
    ? null
    : current.channels.includes("widget") && current.widgetSecretEnc
      ? current.widgetSecretEnc
      : encrypt(newSecret(), credentialKey());
  const updated = await tx.supportInbox.updateMany({
    where: { id, projectId: scope.projectId, version },
    data: { ...changes, ...mailbox, widgetSecretEnc, version: version + 1 },
  });
  if (updated.count !== 1) throw new DomainError("INBOX_VERSION_CONFLICT", 409);
  await syncWidgetKey(tx, scope, current, next);
  await audit(tx, scope, "support.inbox.updated", id, {
    inboxId: id,
    version: version + 1,
    changed: Object.keys(changes).sort(),
  });
  return inboxView(await loadInbox(tx, scope, id));
}

/** Replaces the widget secret; the old one stops working. Shown once. */
export async function rotateWidgetSecret(tx: DbTx, scope: Scope, id: string) {
  const current = await loadInbox(tx, scope, id);
  if (current.archivedAt) throw new DomainError("INBOX_ARCHIVED", 409);
  if (!current.channels.includes("widget"))
    throw new DomainError("INBOX_HAS_NO_WIDGET", 409);
  const widgetSecret = newSecret();
  await tx.supportInbox.update({
    where: { id },
    data: {
      widgetSecretEnc: encrypt(widgetSecret, credentialKey()),
      version: current.version + 1,
    },
  });
  await audit(tx, scope, "support.inbox.secret_rotated", id, {
    inboxId: id,
    version: current.version + 1,
  });
  return { widgetSecret };
}

/** Archives an inbox: it takes no new tickets; existing ones stay. */
export async function archiveInbox(tx: DbTx, scope: Scope, id: string) {
  const current = await loadInbox(tx, scope, id);
  if (current.archivedAt) return inboxView(current);
  const archived = await tx.supportInbox.update({
    where: { id },
    data: { archivedAt: new Date(), version: current.version + 1 },
  });
  await audit(tx, scope, "support.inbox.archived", id, {
    inboxId: id,
    version: archived.version,
  });
  return inboxView(archived);
}

/**
 * Keeps the inbox's widget key in step (review fix 10): new origins go to
 * the key; without the widget channel the key is revoked and forgotten,
 * so a re-added widget never revives it.
 */
async function syncWidgetKey(
  tx: DbTx,
  scope: Scope,
  current: InboxRow,
  next: { channels: string[]; allowedOrigins: string[] },
) {
  if (!current.publicClientKeyId) return;
  if (!next.channels.includes("widget") || !next.allowedOrigins.length) {
    await revokePublicKey(scope, current.publicClientKeyId, tx).catch(
      () => undefined,
    );
    await tx.supportInbox.update({
      where: { id: current.id },
      data: { publicClientKeyId: null },
    });
    return;
  }
  if (
    JSON.stringify(next.allowedOrigins) !==
    JSON.stringify(current.allowedOrigins)
  )
    await setPublicKeyOrigins(
      scope,
      current.publicClientKeyId,
      next.allowedOrigins,
      tx,
    );
}

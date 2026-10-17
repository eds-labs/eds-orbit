import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { publicOrigin } from "../../platform/http/public-api.ts";
import { audit, credentialKey, DomainError, encrypt } from "../../shared.ts";

// Support inboxes (06 §2.1): one entry point each, an e-mail address and/or
// a widget. The widget's HMAC secret is generated here, stored encrypted and
// shown only in the create and rotate answers. Audits name fields, never
// values, so neither secrets nor addresses reach the audit log.

const fields = {
  name: z.string().trim().min(1).max(80),
  channels: z
    .array(z.enum(["email", "widget"]))
    .min(1)
    .max(2)
    .refine((c) => new Set(c).size === c.length, "Channels must be unique"),
  emailAddress: z.email().max(254).nullable(),
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
};
const createInput = z
  .object({
    name: fields.name,
    channels: fields.channels,
    emailAddress: fields.emailAddress.optional(),
    allowedOrigins: fields.allowedOrigins.optional(),
    defaultCategory: fields.defaultCategory.optional(),
    assignmentPolicy: fields.assignmentPolicy.optional(),
    defaultAssigneeUserId: fields.defaultAssigneeUserId.optional(),
    language: fields.language.optional(),
    aiMode: fields.aiMode.optional(),
  })
  .strict();
const updateInput = z
  .object({
    version: z.number().int().min(1),
    name: fields.name.optional(),
    channels: fields.channels.optional(),
    emailAddress: fields.emailAddress.optional(),
    allowedOrigins: fields.allowedOrigins.optional(),
    defaultCategory: fields.defaultCategory.optional(),
    assignmentPolicy: fields.assignmentPolicy.optional(),
    defaultAssigneeUserId: fields.defaultAssigneeUserId.optional(),
    language: fields.language.optional(),
    aiMode: fields.aiMode.optional(),
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

/** A channel needs its entry point: an address for e-mail, origins for the widget. */
function assertChannels(row: {
  channels: string[];
  emailAddress: string | null;
  allowedOrigins: string[];
}) {
  const issues: string[] = [];
  if (row.channels.includes("email") && !row.emailAddress)
    issues.push("An e-mail inbox needs an address");
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
  const row = {
    ...input,
    emailAddress: input.emailAddress ?? null,
    allowedOrigins: input.allowedOrigins ?? [],
  };
  assertChannels(row);
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
  // A widget added later gets its secret now; it is shown by a rotation.
  const widgetSecretEnc =
    next.channels.includes("widget") && !current.widgetSecretEnc
      ? encrypt(newSecret(), credentialKey())
      : current.widgetSecretEnc;
  const updated = await tx.supportInbox.updateMany({
    where: { id, projectId: scope.projectId, version },
    data: { ...changes, widgetSecretEnc, version: version + 1 },
  });
  if (updated.count !== 1) throw new DomainError("INBOX_VERSION_CONFLICT", 409);
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

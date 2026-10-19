import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { registeredPublicView } from "./modules/contributions.ts";
import type { DbTx, Prisma } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
export class DomainError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function data(
  entity: { data: unknown } | null | undefined,
): Record<string, any> {
  return (entity?.data as Record<string, any>) ?? {};
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export function hash(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function constantEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
/**
 * The key that encrypts stored credentials (AES-256-GCM, see encrypt).
 * The one place that reads it raw from the environment; loadConfig() users
 * read the same value through the validated config.
 */
export function credentialKey() {
  return process.env.CREDENTIAL_KEY!;
}
export function encrypt(value: string, key: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((x) => x.toString("base64"))
    .join(".");
}
export function decrypt(value: string, key: string) {
  const parts = value.split(".");
  if (parts.length !== 3) throw new DomainError("INVALID_ENCRYPTED_CREDENTIAL");
  const buffers = parts.map((x) => {
    const b = Buffer.from(x, "base64");
    if (b.toString("base64") !== x)
      throw new DomainError("INVALID_ENCRYPTED_CREDENTIAL");
    return b;
  });
  const [iv, tag, ciphertext] = buffers;
  if (iv!.length !== 12 || tag!.length !== 16)
    throw new DomainError("INVALID_ENCRYPTED_CREDENTIAL");
  const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv!);
  cipher.setAuthTag(tag!);
  return Buffer.concat([cipher.update(ciphertext!), cipher.final()]).toString(
    "utf8",
  );
}
export async function entity(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  kind: string,
  id: string,
) {
  const row = await tx.entity.findFirst({
    where: {
      id,
      kind,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
    },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
}
export async function list(tx: DbTx, scope: Scope, kind: string) {
  return tx.entity.findMany({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId, kind },
    orderBy: { createdAt: "desc" },
  });
}
export async function create(
  tx: DbTx,
  scope: Scope,
  kind: string,
  value: Record<string, unknown>,
) {
  const row = await tx.entity.create({
    data: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind,
      data: value as Prisma.InputJsonValue,
    },
  });
  await tx.entityVersion.create({
    data: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      entityId: row.id,
      version: 1,
      data: row.data as Prisma.InputJsonValue,
    },
  });
  return row;
}
export async function update(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  row: { id: string; version: number },
  value: Record<string, unknown>,
) {
  const result = await tx.entity.updateMany({
    where: {
      id: row.id,
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
      version: row.version,
    },
    data: { version: { increment: 1 }, data: value as Prisma.InputJsonValue },
  });
  if (result.count !== 1) throw new DomainError("VERSION_CONFLICT", 409);
  await tx.entityVersion.create({
    data: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      entityId: row.id,
      version: row.version + 1,
      data: value as Prisma.InputJsonValue,
    },
  });
  return tx.entity.findUniqueOrThrow({ where: { id: row.id } });
}
export async function audit(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId" | "userId">,
  action: string,
  resourceId: string,
  metadata: Record<string, unknown> = {},
) {
  return tx.auditEvent.create({
    data: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      actorId: scope.userId,
      action,
      resourceId,
      metadata: metadata as Prisma.InputJsonValue,
    },
  });
}
export async function exception(
  tx: DbTx,
  scope: Scope,
  code: string,
  resourceId: string,
) {
  const existing = (await list(tx, scope, "exceptions")).find(
    (x) => data(x).code === code && data(x).status === "open",
  );
  if (existing)
    return update(tx, scope, existing, {
      ...data(existing),
      count: (data(existing).count ?? 1) + 1,
      lastSeenAt: new Date().toISOString(),
      resourceIds: [
        ...new Set([...(data(existing).resourceIds ?? []), resourceId]),
      ].slice(-100),
    });
  return create(tx, scope, "exceptions", {
    code,
    status: "open",
    count: 1,
    resourceIds: [resourceId],
    lastSeenAt: new Date().toISOString(),
  });
}
/**
 * The requester of an action request as members see it (D-M5-8): an MCP
 * proposal names its user and client only, never the grant, the run or the
 * argument hash, which stay on the stored request for audit and dedupe.
 * Used by the owner's inbox list and the project export.
 */
export function listedRequester(by: unknown): unknown {
  if (
    typeof by === "object" &&
    by !== null &&
    (by as { kind?: unknown }).kind === "mcp"
  ) {
    const { kind, userId, clientId } = by as Record<string, unknown>;
    return { kind, userId, clientId };
  }
  return by;
}
export function publicEntity(row: any) {
  if (row.kind === "drive_connection" || row.kind === "drive_oauth_state")
    return { ...row, data: { connected: row.kind === "drive_connection" } };
  // Bot credential, webhook secret and link code never leave the server.
  if (row.kind === "telegram_connections")
    return {
      ...row,
      data: {
        status: data(row).status,
        linkedAt: data(row).linkedAt ?? null,
      },
    };
  // Delegated operation bodies and receipts can contain customer text. The
  // approval inbox and connection-owned result API read them explicitly;
  // project-wide exports receive identifiers and status only.
  if (row.kind === "action_requests" && (String(data(row).actionType).includes(".mcp.") || data(row).actionType === "platform.task.start")) {
    const d = data(row);
    return {...row, data: {actionType: d.actionType, status: d.status, packageHash: d.packageHash, expiresAt: d.expiresAt, requestedBy: listedRequester(d.requestedBy)}};
  }
  // The export is open to every member: trim an MCP requester (review M3).
  if (row.kind === "action_requests" && data(row).requestedBy !== undefined)
    return {
      ...row,
      data: {
        ...data(row),
        requestedBy: listedRequester(data(row).requestedBy),
      },
    };
  if (row.kind === "connectors") {
    const { encryptedCredential, ...safe } = data(row);
    return { ...row, data: safe };
  }
  // A module's own kinds are projected by the module (WP1.6).
  const view = registeredPublicView(row.kind);
  return view ? view(row) : row;
}

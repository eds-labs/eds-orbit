import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { DbTx, Prisma } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
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
export async function entity(tx: DbTx, scope: Scope, kind: string, id: string) {
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
  scope: Scope,
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
  scope: Scope,
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
export function publicEntity(row: any) {
  if (row.kind === "connectors") {
    const { encryptedCredential, ...safe } = data(row);
    return { ...row, data: safe };
  }
  if (row.kind === "assets") {
    const { base64, ...safe } = data(row);
    return {
      ...row,
      data: {
        ...safe,
        hasContent: typeof base64 === "string" && base64.length > 0,
      },
    };
  }
  return row;
}

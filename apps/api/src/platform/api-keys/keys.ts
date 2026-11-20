import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { authDb, scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { audit, DomainError } from "../shared.ts";
import { moduleAvailable, registeredApiScopes } from "../modules/contributions.ts";

// Project API keys (ADR 0029, CH1.1): machine credentials for the versioned
// /api/v1 routes. A key belongs to one project, carries scopes that modules
// registered (`apiScopes`) and an optional resource filter (e.g. site ids),
// and is shown once. Only the SHA-256 of the token is stored: the secret has
// 256 random bits, so a slow hash adds nothing. Owners manage keys; a key
// never acts as a member and can never decide an approval.

/** `ok_` plus 12 base32 characters: the public, unique part shown in lists. */
const PREFIX = /^ok_[a-z2-7]{12}$/;
/** The full token: prefix, `_`, 43 base64url characters (32 random bytes). */
export const API_TOKEN = /^ok_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/;
/** Throttle for lastUsedAt writes: one per key and minute is enough. */
const LAST_USED_GRANULARITY_MS = 60_000;

/** True while the versioned API and key management exist (ORBIT_API_V1). */
export const apiV1Enabled = () => loadConfig().ORBIT_API_V1 === "true";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const base32 = (bytes: Buffer, length: number) =>
  Array.from(bytes, (byte) => BASE32[byte & 31]).join("").slice(0, length);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Creates a new token; exported for tests. */
export function newToken() {
  const prefix = `ok_${base32(randomBytes(12), 12)}`;
  const token = `${prefix}_${randomBytes(32).toString("base64url")}`;
  return { prefix, token, secretHash: sha256(token) };
}

const resourceFilter = z
  .object({
    /** Restricts the key to these Content sites (CH1.11). */
    siteIds: z.array(z.uuid()).min(1).max(20).optional(),
  })
  .strict();

const createInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(z.string()).min(1).max(20),
    resourceFilter: resourceFilter.default({}),
    /** Days until the key expires; null never (owners decide). */
    expiresInDays: z.int().min(1).max(730).nullable().default(365),
    /** Owners confirm keys that may write (scope access "write"). */
    confirmWrite: z.boolean().default(false),
  })
  .strict();

type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  resourceFilter: unknown;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

const view = (row: KeyRow, now = new Date()) => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  scopes: row.scopes,
  resourceFilter: row.resourceFilter,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  lastUsedAt: row.lastUsedAt,
  revokedAt: row.revokedAt,
  status: row.revokedAt
    ? ("revoked" as const)
    : row.expiresAt && row.expiresAt <= now
      ? ("expired" as const)
      : ("active" as const),
});

const requireOwner = (scope: Scope) => {
  if (!apiV1Enabled()) throw new DomainError("NOT_FOUND", 404);
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
};

/** Scopes a new key may carry: registered by a module available now. */
export function grantableApiScopes() {
  return [...registeredApiScopes().values()]
    .filter((def) => moduleAvailable(def.owner))
    .map((def) => ({ key: def.key, module: def.owner, access: def.access, description: def.description }));
}

/** Creates a key; the token is in this answer only. Audited without secrets. */
export async function createApiKey(scope: Scope, raw: unknown) {
  requireOwner(scope);
  const input = createInput.parse(raw);
  const grantable = new Map(grantableApiScopes().map((def) => [def.key, def]));
  const scopes = [...new Set(input.scopes)].sort();
  const unknown = scopes.filter((key) => !grantable.has(key));
  if (unknown.length) throw new DomainError("API_KEY_SCOPE_UNKNOWN", 400);
  if (scopes.some((key) => grantable.get(key)!.access === "write") && !input.confirmWrite)
    throw new DomainError("API_KEY_WRITE_CONFIRMATION_REQUIRED", 409);
  const { prefix, token, secretHash } = newToken();
  const now = new Date();
  const row = await authDb.apiKey.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      name: input.name,
      prefix,
      secretHash,
      scopes,
      resourceFilter: input.resourceFilter,
      createdBy: scope.userId,
      createdAt: now,
      expiresAt: input.expiresInDays === null ? null : new Date(now.getTime() + input.expiresInDays * 86_400_000),
    },
  });
  await scoped(scope.workspaceId, scope.projectId, (tx) =>
    audit(tx, scope, "api_key.created", row.id, {
      prefix,
      scopes,
      resourceFilter: input.resourceFilter,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    }),
  );
  return { ...view(row, now), token };
}

/** The project's keys, newest first; never a secret or hash. */
export async function listApiKeys(scope: Scope) {
  requireOwner(scope);
  const rows = await authDb.apiKey.findMany({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId },
    orderBy: { createdAt: "desc" },
  });
  const now = new Date();
  return rows.map((row) => view(row, now));
}

/** Revokes a key at once; revoking twice keeps the first time. Audited. */
export async function revokeApiKey(scope: Scope, id: string) {
  requireOwner(scope);
  const row = await authDb.apiKey.findFirst({
    where: { id, workspaceId: scope.workspaceId, projectId: scope.projectId },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  if (row.revokedAt) return view(row);
  const revoked = await authDb.apiKey.update({
    where: { id },
    data: { revokedAt: new Date(), revokedBy: scope.userId },
  });
  await scoped(scope.workspaceId, scope.projectId, (tx) =>
    audit(tx, scope, "api_key.revoked", id, { prefix: row.prefix }),
  );
  return view(revoked);
}

/** What a v1 handler knows about the caller. */
export type ApiPrincipal = {
  keyId: string;
  prefix: string;
  workspaceId: string;
  projectId: string;
  scopes: readonly string[];
  resourceFilter: { siteIds?: string[] };
  /** A project scope for `scoped()`: never a member, never an owner. */
  scope: Scope;
};

const unauthenticated = () => new DomainError("API_KEY_INVALID", 401);

/**
 * Resolves `Authorization: Bearer ok_…` to its key. Every failure (missing,
 * malformed, unknown, wrong secret, revoked, expired) is the same 401, so a
 * caller learns nothing about which keys exist. The hash comparison is
 * constant-time.
 */
export async function resolveApiKey(authorization: string | undefined, now = new Date()): Promise<ApiPrincipal> {
  if (!apiV1Enabled()) throw new DomainError("NOT_FOUND", 404);
  const match = /^Bearer (\S+)$/.exec(authorization ?? "");
  const token = match?.[1];
  if (!token || !API_TOKEN.test(token)) throw unauthenticated();
  const prefix = token.slice(0, 15);
  if (!PREFIX.test(prefix)) throw unauthenticated();
  const row = await authDb.apiKey.findUnique({ where: { prefix } });
  const given = Buffer.from(sha256(token), "hex");
  // Compare against a dummy when the key is unknown, so timing does not tell.
  const stored = Buffer.from(row?.secretHash ?? "0".repeat(64), "hex");
  const same = timingSafeEqual(given, stored);
  if (!row || !same || row.revokedAt || (row.expiresAt && row.expiresAt <= now)) throw unauthenticated();
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_GRANULARITY_MS)
    await authDb.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: now } });
  // A stored filter this version cannot read restricts nothing it could
  // name, so the key is refused rather than widened to every resource.
  const filter = resourceFilter.safeParse(row.resourceFilter);
  if (!filter.success) throw unauthenticated();
  return {
    keyId: row.id,
    prefix: row.prefix,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    scopes: row.scopes,
    resourceFilter: filter.data,
    scope: {
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      userId: `api_key:${row.id}`,
      role: "viewer",
    },
  };
}

/**
 * Throws 403 API_KEY_SCOPE_MISSING unless the key carries the scope and the
 * scope's module is available (switching a module off disables its scopes).
 */
export function requireApiScope(principal: ApiPrincipal, key: string) {
  const def = registeredApiScopes().get(key);
  if (!def) throw new Error(`unregistered api scope ${key}`);
  if (!moduleAvailable(def.owner)) throw new DomainError("NOT_FOUND", 404);
  if (!principal.scopes.includes(key)) throw new DomainError("API_KEY_SCOPE_MISSING", 403);
}

/** The member who created a key of the project (four-eyes, ADR 0029 §4.6). */
export async function apiKeyCreator(keyId: string, scope: Pick<Scope, "workspaceId" | "projectId">) {
  const row = await authDb.apiKey.findFirst({
    where: { id: keyId, workspaceId: scope.workspaceId, projectId: scope.projectId },
    select: { createdBy: true },
  });
  return row?.createdBy;
}

/**
 * True while a key may still have its proposals executed: it exists in the
 * project, is not revoked and has not expired (ADR 0029, CH1.13).
 */
export async function apiKeyStillProposes(keyId: string, scope: Pick<Scope, "workspaceId" | "projectId">, now = new Date()) {
  const row = await authDb.apiKey.findFirst({
    where: { id: keyId, workspaceId: scope.workspaceId, projectId: scope.projectId },
    select: { revokedAt: true, expiresAt: true },
  });
  return Boolean(row && !row.revokedAt && !(row.expiresAt && row.expiresAt <= now));
}

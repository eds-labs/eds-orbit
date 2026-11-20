import { createHash, randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { Prisma, scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import { canonical, DomainError } from "../shared.ts";
import { registeredApiScopes } from "../modules/contributions.ts";
import { assertModuleEnabled } from "../modules/enforcement.ts";
import type { PeriodicTask } from "../jobs/types.ts";
import { requireApiScope, resolveApiKey, type ApiPrincipal } from "../api-keys/keys.ts";
import { clientIp } from "../../client-ip.ts";

// The versioned machine API frame (ADR 0029, CH1.2). Modules mount routes
// under /api/v1/<module>/... and build them from these helpers:
// - `inV1`: API key, scope, module availability and enablement, one project transaction;
// - `v1RateLimit`: per-address limit before and per-key limit after authentication;
// - `sendCached`: ETag and Cache-Control instead of the global no-store;
// - `idempotent`: Idempotency-Key replay, stored in the write's own transaction;
// - `pageParams` / `page`: keyset pagination with opaque cursors.
// Breaking changes go to /api/v2 with at least six months in parallel;
// additive changes keep the version.

export const V1_PREFIX = "/api/v1";

/** Requests per minute and key, by kind of route. */
export const V1_LIMITS = { delivery: 600, management: 120, preview: 60 } as const;
export type V1Kind = keyof typeof V1_LIMITS;

/**
 * Route config of a v1 route. Two limits apply, both with the kind's rate:
 * - per client address, before authentication, so failed or forged keys
 *   cannot pick their own bucket (this replaces the global per-address limit
 *   for the route, as @fastify/rate-limit uses either the route's or the
 *   global limit);
 * - per authenticated key, in `inV1` after the key resolved, so nobody can
 *   spend another key's quota by sending its public prefix.
 */
export const v1RateLimit = (kind: V1Kind) => ({
  v1Kind: kind,
  rateLimit: {
    max: V1_LIMITS[kind],
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => `v1:${kind}:ip:${clientIp(req)}`,
  },
});

type KeyLimiter = (req: FastifyRequest) => Promise<{ isExceeded: boolean }>;
const keyLimiters = new WeakMap<object, Map<V1Kind, KeyLimiter>>();
const limitedKey = Symbol("v1LimitedKey");

/** The per-key limiter of a kind, sharing the rate-limit plugin's store. */
function keyLimiter(req: FastifyRequest, kind: V1Kind): KeyLimiter | null {
  const server = req.server as unknown as {
    createRateLimit?: (options: unknown) => KeyLimiter;
  };
  if (typeof server.createRateLimit !== "function") return null;
  let byKind = keyLimiters.get(server);
  if (!byKind) keyLimiters.set(server, (byKind = new Map()));
  let limiter = byKind.get(kind);
  if (!limiter) {
    limiter = server.createRateLimit({
      max: V1_LIMITS[kind],
      timeWindow: "1 minute",
      keyGenerator: (r: FastifyRequest) => `v1key:${kind}:${(r as unknown as Record<symbol, string>)[limitedKey]}`,
    });
    byKind.set(kind, limiter);
  }
  return limiter;
}

/** Counts a request against its authenticated key; 429 RATE_LIMITED beyond the kind's rate. */
export async function limitKey(req: FastifyRequest, keyId: string) {
  const kind = (req.routeOptions?.config as { v1Kind?: V1Kind } | undefined)?.v1Kind;
  if (!kind) return;
  const limiter = keyLimiter(req, kind);
  if (!limiter) return;
  (req as unknown as Record<symbol, string>)[limitedKey] = keyId;
  const result = await limiter(req);
  if (result.isExceeded) throw new DomainError("RATE_LIMITED", 429);
}

/**
 * Authenticates the key, applies its rate limit, checks the scope, the scope
 * module's availability and its enablement in the key's project, then runs
 * `work` in one project transaction with the key's scope (never a member).
 */
export async function inV1<T>(
  req: FastifyRequest,
  scopeKey: string,
  work: (tx: DbTx, principal: ApiPrincipal) => Promise<T>,
): Promise<T> {
  const principal = await resolveApiKey(req.headers.authorization);
  await limitKey(req, principal.keyId);
  requireApiScope(principal, scopeKey);
  const owner = registeredApiScopes().get(scopeKey)!.owner;
  return scoped(principal.workspaceId, principal.projectId, async (tx) => {
    await assertModuleEnabled(tx, principal.scope, owner);
    return work(tx, principal);
  });
}

/** Cache-Control of cacheable v1 reads: short freshness, long stale fallbacks. */
export const V1_CACHE_CONTROL = "private, max-age=60, stale-while-revalidate=86400, stale-if-error=604800";

const etagOf = (body: unknown) =>
  `"${createHash("sha256").update(canonical(body)).digest("base64url").slice(0, 32)}"`;

/** True when an If-None-Match header names the tag (or `*`). */
export function etagMatches(header: string | string[] | undefined, etag: string) {
  const value = Array.isArray(header) ? header.join(",") : (header ?? "");
  return value
    .split(",")
    .map((part) => part.trim().replace(/^W\//, ""))
    .some((part) => part === etag || part === "*");
}

/**
 * Sends a cacheable read: a strong ETag over the canonical body (or the
 * given version tag), 304 without a body when the client has it.
 */
export function sendCached(
  req: FastifyRequest,
  reply: FastifyReply,
  body: unknown,
  options: { etag?: string; cacheControl?: string } = {},
) {
  const etag = options.etag ? `"${options.etag.replace(/"/g, "")}"` : etagOf(body);
  reply.header("ETag", etag);
  reply.header("Cache-Control", options.cacheControl ?? V1_CACHE_CONTROL);
  reply.header("Vary", "Authorization");
  if (etagMatches(req.headers["if-none-match"], etag)) return reply.code(304).send();
  return reply.send(body);
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
/** How long a stored answer is replayed. */
export const IDEMPOTENCY_HOURS = 24;
/** Answers larger than this are not stored; the write still happens once. */
const MAX_STORED_BODY = 64_000;

export type V1Result = { status: number; body: unknown };

/**
 * Runs a v1 write once per `Idempotency-Key`: inside the caller's project
 * transaction, the stored answer is replayed for the same request (header
 * `Idempotency-Replayed: true`), a different request with the same key is
 * 422 IDEMPOTENCY_KEY_REUSED. The answer is stored in the same transaction
 * as the write, so a write without its stored answer cannot exist. Without
 * the header the write simply runs. A concurrent first use loses on the
 * unique key and is answered 409 IDEMPOTENCY_KEY_IN_USE; its retry replays.
 */
export async function idempotent(
  tx: DbTx,
  principal: ApiPrincipal,
  req: FastifyRequest,
  reply: FastifyReply,
  write: () => Promise<V1Result>,
) {
  const header = req.headers["idempotency-key"];
  if (header === undefined) {
    const result = await write();
    return reply.code(result.status).send(result.body);
  }
  const key = String(header);
  if (!IDEMPOTENCY_KEY.test(key)) throw new DomainError("IDEMPOTENCY_KEY_INVALID", 400);
  const requestHash = createHash("sha256")
    .update(`${req.method} ${req.routeOptions.url ?? req.url}\n${canonical(req.params ?? {})}\n${canonical(req.body ?? null)}`)
    .digest("hex");
  const now = new Date();
  const stored = await tx.apiIdempotencyKey.findUnique({
    where: { apiKeyId_key: { apiKeyId: principal.keyId, key } },
  });
  if (stored && stored.expiresAt > now) {
    if (stored.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_KEY_REUSED", 422);
    reply.header("Idempotency-Replayed", "true");
    return reply.code(stored.responseStatus).send(stored.responseBody);
  }
  if (stored) await tx.apiIdempotencyKey.delete({ where: { id: stored.id } });
  const result = await write();
  // Server errors are not stored: the client may retry them.
  if (result.status < 500) {
    const json = JSON.stringify(result.body ?? null);
    try {
      await tx.apiIdempotencyKey.create({
        data: {
          id: randomUUID(),
          workspaceId: principal.workspaceId,
          projectId: principal.projectId,
          apiKeyId: principal.keyId,
          key,
          requestHash,
          responseStatus: result.status,
          responseBody: json.length <= MAX_STORED_BODY ? (result.body as Prisma.InputJsonValue) ?? null : { stored: false },
          createdAt: now,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_HOURS * 3_600_000),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new DomainError("IDEMPOTENCY_KEY_IN_USE", 409);
      throw error;
    }
  }
  return reply.code(result.status).send(result.body);
}

/** Keyset pagination input: `limit` up to `max`, an opaque `cursor`. */
export function pageParams(query: unknown, max: number, fallback = Math.min(20, max)) {
  const input = z
    .object({
      limit: z.coerce.number().int().min(1).max(max).default(fallback),
      cursor: z.string().max(512).optional(),
    })
    .passthrough()
    .parse(query ?? {});
  let after: Record<string, unknown> | null = null;
  if (input.cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
      if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) throw new Error();
      after = decoded;
    } catch {
      throw new DomainError("CURSOR_INVALID", 400);
    }
  }
  return { limit: input.limit, after };
}

/**
 * One page from `limit + 1` fetched rows: `nextCursor` encodes what
 * `cursorOf` returns for the last row shown.
 */
export function page<Row, Item>(
  rows: readonly Row[],
  limit: number,
  toItem: (row: Row) => Item,
  cursorOf: (row: Row) => Record<string, unknown>,
) {
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return {
    items: shown.map(toItem),
    nextCursor:
      rows.length > limit && last !== undefined
        ? Buffer.from(JSON.stringify(cursorOf(last)), "utf8").toString("base64url")
        : null,
  };
}

// Expired stored answers go hourly, per project; the key of a revoked API
// key goes with it by cascade only when the project is deleted.
const CLEANUP_MS = 3_600_000;
const lastCleanup = new Map<string, number>();

export const idempotencyCleanup: PeriodicTask = {
  name: "api-idempotency-cleanup",
  async run(scope) {
    const now = Date.now();
    if (now - (lastCleanup.get(scope.projectId) ?? 0) < CLEANUP_MS) return;
    lastCleanup.set(scope.projectId, now);
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.apiIdempotencyKey.deleteMany({
        where: { workspaceId: scope.workspaceId, projectId: scope.projectId, expiresAt: { lt: new Date(now) } },
      }),
    );
  },
};


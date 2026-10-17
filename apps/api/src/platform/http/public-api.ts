import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  authDb,
  scoped,
  type DbTx,
} from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, create, data, DomainError } from "../shared.ts";
import {
  moduleAvailable,
  registeredPublicRoutes,
  registeredRegistry,
} from "../modules/contributions.ts";
import { assertModuleEnabled } from "../modules/enforcement.ts";
import { publicIngressEnabled } from "./webhooks.ts";
import { serveEventStream } from "../realtime/sse.ts";

// A module's public API (WP4.2b): browsers on a key's allowed origins call
// /api/public/<module>/:publicKey/... with a public session's bearer token.
// No cookie is read, no credentialed CORS is allowed. Off unless
// ORBIT_PUBLIC_INGRESS is "true".

export const SESSION_KIND = "public_sessions";
export const SESSION_HOURS = 12;
const MAX_BODY = 65_536;
/** A public API path: module, key, then the route. */
export const PUBLIC_URL =
  /^\/api\/public\/[a-z][a-z0-9_]{1,30}\/pk_[A-Za-z0-9_-]{32,64}(\/[a-z0-9-]+){1,4}(\?.*)?$/;

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

type ResolvedKey = {
  id: string;
  workspaceId: string;
  projectId: string;
  moduleId: string;
  allowedOrigins: string[];
};

const scopeOf = (key: ResolvedKey, who: string): Scope => ({
  workspaceId: key.workspaceId,
  projectId: key.projectId,
  userId: who,
  role: "viewer",
});

/**
 * Resolves the key of the request and checks the Origin. A missing,
 * revoked or foreign key is a 404; a browser origin outside the key's list
 * a 403 (audited); a request without Origin (a server) passes.
 */
async function resolve(
  req: FastifyRequest,
  reply: FastifyReply,
  moduleId: string,
): Promise<ResolvedKey> {
  if (!publicIngressEnabled()) throw new DomainError("NOT_FOUND", 404);
  const { publicKey } = req.params as { publicKey: string };
  const row = await authDb.publicClientKey.findUnique({ where: { publicKey } });
  if (!row || row.revokedAt || row.moduleId !== moduleId)
    throw new DomainError("NOT_FOUND", 404);
  const key: ResolvedKey = {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    moduleId: row.moduleId,
    allowedOrigins: row.allowedOrigins,
  };
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (!key.allowedOrigins.includes(origin)) {
      await scoped(key.workspaceId, key.projectId, (tx) =>
        audit(tx, scopeOf(key, "public"), "public.origin_rejected", key.id, {
          origin: origin.slice(0, 200),
        }),
      );
      throw new DomainError("ORIGIN_NOT_ALLOWED", 403);
    }
    // Never with credentials: a public client authenticates by token only.
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Vary", "Origin");
  }
  // A switched-off module has no public API either (WP2.4).
  await scoped(key.workspaceId, key.projectId, (tx) =>
    assertModuleEnabled(tx, scopeOf(key, "public"), key.moduleId),
  );
  return key;
}

const tokenOf = (req: FastifyRequest) => {
  const header = String(req.headers.authorization ?? "");
  return /^Bearer [A-Za-z0-9_-]{43}$/.test(header) ? header.slice(7) : null;
};

/** Registers every module's public API in one scope with its own limits. */
export async function registerPublicApi(app: FastifyInstance) {
  await app.register(async (child) => {
    child.removeContentTypeParser("application/json");
    child.addContentTypeParser(
      "application/json",
      { parseAs: "string", bodyLimit: MAX_BODY },
      (_req, body, done) => {
        try {
          done(null, body ? JSON.parse(String(body)) : {});
        } catch {
          done(new DomainError("PUBLIC_PAYLOAD_INVALID", 400));
        }
      },
    );
    for (const [moduleId, routes] of registeredPublicRoutes()) {
      const base = `/api/public/${moduleId}/:publicKey`;
      // Preflight: answered for allowed origins only.
      child.options(`${base}/*`, async (req, reply) => {
        await resolve(req, reply, moduleId);
        return reply
          .code(204)
          .header("Access-Control-Allow-Methods", "GET, POST")
          .header(
            "Access-Control-Allow-Headers",
            "authorization, content-type, last-event-id",
          )
          .header("Access-Control-Max-Age", "600")
          .send();
      });
      // A new session: its token is shown once and stored as a hash.
      child.post(
        `${base}/session`,
        {
          bodyLimit: MAX_BODY,
          config: {
            rateLimit: {
              max: 20,
              timeWindow: "1 minute",
              keyGenerator: (req: FastifyRequest) =>
                `public-session:${(req.params as { publicKey?: string }).publicKey}:${req.ip}`,
            },
          },
        },
        async (req, reply) => {
          const key = await resolve(req, reply, moduleId);
          const token = randomBytes(32).toString("base64url");
          const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);
          const publicScope = scopeOf(key, "public");
          const session = await scoped(key.workspaceId, key.projectId, (tx) =>
            create(tx, publicScope, SESSION_KIND, {
              keyId: key.id,
              tokenHash: sha256(token),
              createdAt: new Date().toISOString(),
              expiresAt: expiresAt.toISOString(),
            }),
          );
          return reply
            .code(201)
            .send({ sessionId: session.id, token, expiresAt });
        },
      );
      for (const route of routes)
        child.route({
          method: route.method,
          url: `${base}${route.path}`,
          bodyLimit: MAX_BODY,
          config: {
            rateLimit: {
              max: 120,
              timeWindow: "1 minute",
              // Per session token, whatever address the browser has.
              keyGenerator: (req: FastifyRequest) =>
                `public:${sha256(tokenOf(req) ?? `anonymous:${req.ip}`).slice(0, 32)}`,
            },
          },
          handler: async (req, reply) => {
            const key = await resolve(req, reply, moduleId);
            const token = tokenOf(req);
            if (!token) throw new DomainError("UNAUTHORIZED", 401);
            const session = await scoped(key.workspaceId, key.projectId, (tx) =>
              tx.entity.findFirst({
                where: {
                  workspaceId: key.workspaceId,
                  projectId: key.projectId,
                  kind: SESSION_KIND,
                  AND: [
                    { data: { path: ["tokenHash"], equals: sha256(token) } },
                    { data: { path: ["keyId"], equals: key.id } },
                  ],
                },
              }),
            );
            if (
              !session ||
              Date.parse(String(data(session).expiresAt)) <= Date.now()
            )
              throw new DomainError("UNAUTHORIZED", 401);
            const ctx = {
              scope: scopeOf(key, `public:${session.id}`),
              session: { id: session.id, keyId: key.id },
              body: req.body ?? {},
              query: Object.fromEntries(
                Object.entries(
                  (req.query as Record<string, unknown>) ?? {},
                ).map(([k, v]) => [k, String(v)]),
              ),
            };
            if (route.stream && route.method === "GET") {
              const stream = await route.stream(ctx);
              const headers = Object.fromEntries(
                Object.entries(reply.getHeaders())
                  .filter(([name]) => /^(access-control-|vary$)/i.test(name))
                  .map(([name, value]) => [name, String(value)]),
              );
              return serveEventStream(req, reply, { ...stream, headers });
            }
            return route.handler(ctx);
          },
        });
    }
  });
}

// Owners manage their project's keys (while the flag is on).

/** A browser origin such as https://example.com: https, or http on localhost. */
export const publicOrigin = z
  .string()
  .max(200)
  .refine((value) => {
    try {
      const url = new URL(value);
      const local = ["localhost", "127.0.0.1"].includes(url.hostname);
      return (
        (url.protocol === "https:" || (local && url.protocol === "http:")) &&
        url.origin === value
      );
    } catch {
      return false;
    }
  }, "An origin such as https://example.com, without a path");
export const publicKeyInput = z
  .object({
    moduleId: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
    allowedOrigins: z.array(publicOrigin).min(1).max(10),
  })
  .strict();

const requireOwner = (scope: Scope) => {
  if (!publicIngressEnabled()) throw new DomainError("NOT_FOUND", 404);
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
};
const publicView = (row: {
  id: string;
  moduleId: string;
  publicKey: string;
  allowedOrigins: string[];
  createdAt: Date;
  revokedAt: Date | null;
}) => ({
  id: row.id,
  moduleId: row.moduleId,
  publicKey: row.publicKey,
  allowedOrigins: row.allowedOrigins,
  createdAt: row.createdAt,
  revokedAt: row.revokedAt,
});

/** Creates a key for a module that has a public API; audited. */
export async function createPublicKey(scope: Scope, raw: unknown) {
  requireOwner(scope);
  const input = publicKeyInput.parse(raw);
  if (!publicApiModules().includes(input.moduleId))
    throw new DomainError("MODULE_HAS_NO_PUBLIC_API", 409);
  const row = await authDb.publicClientKey.create({
    data: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      moduleId: input.moduleId,
      publicKey: `pk_${randomBytes(24).toString("base64url")}`,
      allowedOrigins: input.allowedOrigins,
      createdBy: scope.userId,
    },
  });
  await scoped(scope.workspaceId, scope.projectId, (tx) =>
    audit(tx, scope, "public_key.created", row.id, {
      moduleId: row.moduleId,
      allowedOrigins: row.allowedOrigins,
    }),
  );
  return publicView(row);
}

/**
 * The modules a key can be issued for: registered with a public API and
 * available for the installation (support needs ORBIT_SUPPORT, WP5.4).
 */
export function publicApiModules() {
  return registeredRegistry().order.filter(
    (id) => registeredPublicRoutes().has(id) && moduleAvailable(id),
  );
}

export async function listPublicKeys(scope: Scope) {
  requireOwner(scope);
  const rows = await authDb.publicClientKey.findMany({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(publicView);
}

/**
 * Replaces a key's allowed origins, for a module that keeps them in step
 * with its own settings (support inboxes, WP5.4); audited.
 */
export async function setPublicKeyOrigins(
  scope: Scope,
  id: string,
  allowedOrigins: string[],
  /** The caller's project transaction, when it holds one (no second lock). */
  tx?: DbTx,
) {
  const origins = z.array(publicOrigin).min(1).max(10).parse(allowedOrigins);
  const row = await authDb.publicClientKey.findFirst({
    where: { id, workspaceId: scope.workspaceId, projectId: scope.projectId },
  });
  if (!row || row.revokedAt) return null;
  await authDb.publicClientKey.update({
    where: { id },
    data: { allowedOrigins: origins },
  });
  const write = (t: DbTx) =>
    audit(t, scope, "public_key.origins_changed", id, {
      allowedOrigins: origins,
    });
  if (tx) await write(tx);
  else await scoped(scope.workspaceId, scope.projectId, write);
  return { id, allowedOrigins: origins };
}

/** Revokes a key: its API answers 404 from now on; audited. */
export async function revokePublicKey(
  scope: Scope,
  id: string,
  /** The caller's project transaction, when it holds one (no second lock). */
  tx?: DbTx,
) {
  requireOwner(scope);
  const row = await authDb.publicClientKey.findFirst({
    where: { id, workspaceId: scope.workspaceId, projectId: scope.projectId },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  const revoked = row.revokedAt
    ? row
    : await authDb.publicClientKey.update({
        where: { id },
        data: { revokedAt: new Date() },
      });
  const write = (t: DbTx) =>
    audit(t, scope, "public_key.revoked", id, { moduleId: row.moduleId });
  if (tx) await write(tx);
  else await scoped(scope.workspaceId, scope.projectId, write);
  return publicView(revoked);
}

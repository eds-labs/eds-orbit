import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { scoped } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, create, data, DomainError, list } from "../shared.ts";
import {
  CONNECTION_KIND,
  decryptCredential,
} from "../connections/connections.ts";
import { registeredWebhook } from "../modules/contributions.ts";
import { enqueue } from "../jobs/enqueue.ts";

// Public ingress for signed provider webhooks (WP4.2a). No session, no
// cookie, no Origin: the connection's secret authenticates the provider.
// Off unless ORBIT_PUBLIC_INGRESS is "true".

export const WEBHOOK_KIND = "inbound_webhooks";
export const WEBHOOK_PATH =
  "/api/hooks/:provider/:workspaceId/:projectId/:connectionId";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** The plain webhook path only: a provider name and three lowercase UUIDs. */
export const WEBHOOK_URL = new RegExp(
  `^/api/hooks/[a-z][a-z0-9_-]{1,30}/${UUID}/${UUID}/${UUID}$`,
);
const MAX_BYTES = 262_144;

export function publicIngressEnabled() {
  return loadConfig().ORBIT_PUBLIC_INGRESS === "true";
}

const params = z
  .object({
    provider: z.string().regex(/^[a-z][a-z0-9_-]{1,30}$/),
    workspaceId: z.uuid(),
    projectId: z.uuid(),
    connectionId: z.uuid(),
  })
  .strict();

const headersOf = (raw: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(",") : (value as string | undefined),
    ]),
  );

/** Registers the webhook route in its own scope with a raw-body JSON parser. */
export async function registerWebhookRoutes(app: FastifyInstance) {
  await app.register(async (child) => {
    // The signature covers the exact bytes, so the body stays a string here.
    child.removeContentTypeParser("application/json");
    child.addContentTypeParser(
      "application/json",
      { parseAs: "string", bodyLimit: MAX_BYTES },
      (_req, body, done) => done(null, body),
    );
    child.post(
      WEBHOOK_PATH,
      {
        bodyLimit: MAX_BYTES,
        config: {
          rateLimit: {
            max: 120,
            timeWindow: "1 minute",
            // Per connection, whatever address the provider sends from.
            keyGenerator: (req: import("fastify").FastifyRequest) =>
              `hook:${(req.params as { connectionId?: string }).connectionId ?? "?"}`,
          },
        },
      },
      async (req, reply) => {
        if (!publicIngressEnabled()) throw new DomainError("NOT_FOUND", 404);
        const contentType = String(req.headers["content-type"] ?? "");
        if (!/^application\/json(\s*;|$)/i.test(contentType))
          throw new DomainError("UNSUPPORTED_MEDIA_TYPE", 415);
        const p = params.parse(req.params);
        const provider = registeredWebhook(p.provider);
        if (!provider) throw new DomainError("NOT_FOUND", 404);
        const rawBody = typeof req.body === "string" ? req.body : "";
        const headers = headersOf(req.headers as Record<string, unknown>);
        const scope: Scope = {
          workspaceId: p.workspaceId,
          projectId: p.projectId,
          userId: `webhook:${p.provider}`,
          role: "viewer",
        };
        const result = await scoped(p.workspaceId, p.projectId, async (tx) => {
          const connection = (await list(tx, scope, CONNECTION_KIND)).find(
            (row) =>
              row.id === p.connectionId &&
              data(row).provider === provider.connectionProvider,
          );
          if (!connection) return { status: 404 as const };
          let valid = false;
          try {
            valid = provider.verify({
              rawBody,
              headers,
              credential: decryptCredential(data(connection)),
              now: new Date(),
            });
          } catch {
            valid = false;
          }
          if (!valid) {
            await audit(tx, scope, "webhook.rejected", connection.id, {
              provider: p.provider,
              reason: "signature",
            });
            return { status: 401 as const };
          }
          let body: unknown;
          try {
            body = JSON.parse(rawBody);
          } catch {
            return { status: 400 as const, code: "WEBHOOK_PAYLOAD_INVALID" };
          }
          const messageId = provider.messageId({ body, headers });
          if (!messageId || messageId.length > 200)
            return {
              status: 400 as const,
              code: "WEBHOOK_MESSAGE_ID_REQUIRED",
            };
          // The project lock serializes deliveries, so this check is exact.
          const seen = await tx.entity.findFirst({
            where: {
              workspaceId: p.workspaceId,
              projectId: p.projectId,
              kind: WEBHOOK_KIND,
              AND: [
                { data: { path: ["connectionId"], equals: connection.id } },
                { data: { path: ["messageId"], equals: messageId } },
              ],
            },
          });
          if (seen) {
            await audit(tx, scope, "webhook.duplicate", connection.id, {
              provider: p.provider,
              messageId,
            });
            return { status: 409 as const };
          }
          const stored = await create(tx, scope, WEBHOOK_KIND, {
            provider: p.provider,
            connectionId: connection.id,
            messageId,
            receivedAt: new Date().toISOString(),
            body,
            status: "queued",
          });
          await enqueue(
            tx,
            scope,
            provider.queueClass,
            stored.id,
            `webhook:${p.provider}:${connection.id}:${messageId}`,
          );
          return { status: 200 as const };
        });
        if (result.status === 200) return reply.code(200).send({ ok: true });
        const code =
          ("code" in result && result.code) ||
          { 401: "UNAUTHORIZED", 404: "NOT_FOUND", 409: "DUPLICATE_MESSAGE" }[
            result.status as 401 | 404 | 409
          ];
        return reply
          .code(result.status)
          .send({ error: { code, message: code.replaceAll("_", " ") } });
      },
    );
  });
}

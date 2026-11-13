import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { bridgeLogger } from "./bridge-bootstrap.ts";
import {
  handoffConsumeRequest,
  sessionAuthorizeRequest,
  sessionBarrierRequest,
  sessionEndRequest,
  WEBMAIL_BRIDGE_PREFIX as PREFIX,
} from "./bridge-contract.ts";
import {
  authorizeSession,
  BridgeRefusal,
  consumeHandoff,
  endSession,
  sessionBarrier,
} from "./sessions.ts";

// The internal bridge between Roundcube's plugin and Orbit (ADR 0026, E3),
// reachable only on the private webmail network. No CORS, no cookies, and
// nothing a request carries is ever logged: the answers hold mail passwords.

// A barrier names up to 5000 uids or ranges; nothing else comes close.
const BODY_LIMIT = 256 * 1024;
const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant time over digests, so the comparison shows no length either. */
export function bearerMatches(header: unknown, secret: string) {
  if (!secret || typeof header !== "string") return false;
  const [scheme, token, extra] = header.split(" ");
  if (scheme !== "Bearer" || !token || extra !== undefined) return false;
  return timingSafeEqual(digest(token), digest(secret));
}

export async function buildBridgeApp(options: {
  bridgeSecret: string;
}): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: BODY_LIMIT,
    trustProxy: false,
    logger: bridgeLogger,
  });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    if (String(req.url).split("?")[0] === "/healthz") return;
    if (!bearerMatches(req.headers.authorization, options.bridgeSecret))
      return reply.code(401).send({ ok: false, error: "unauthorized" });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ ok: false, error: "not_found" }),
  );
  // A refusal keeps its contract code; anything else stays generic, so an
  // error message cannot carry a host, a login or a token to the plugin.
  app.setErrorHandler((error: Error, req, reply) => {
    if (error instanceof BridgeRefusal)
      return reply.code(error.status).send({ ok: false, error: error.code });
    const status = (error as { statusCode?: number }).statusCode;
    if (error instanceof z.ZodError || (status && status < 500))
      return reply
        .code(status ?? 400)
        .send({ ok: false, error: "bad_request" });
    req.log.error({ errorName: error.name }, "webmail bridge request failed");
    return reply.code(500).send({ ok: false, error: "internal" });
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.post(`${PREFIX}/handoff/consume`, async (req) =>
    consumeHandoff(handoffConsumeRequest.parse(req.body)),
  );
  app.post(`${PREFIX}/session/authorize`, async (req) =>
    authorizeSession(sessionAuthorizeRequest.parse(req.body)),
  );
  app.post(`${PREFIX}/session/barrier`, async (req) =>
    sessionBarrier(sessionBarrierRequest.parse(req.body)),
  );
  app.post(`${PREFIX}/session/end`, async (req) =>
    endSession(sessionEndRequest.parse(req.body)),
  );
  return app;
}

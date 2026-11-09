/**
 * Composition of the webmail bridge process (ADR 0026), like
 * platform/mcp/bootstrap.ts: with webmail off the process stays up as a
 * health-only app, so its compose service never crash-loops. That path loads
 * Fastify and the guard only: no database, no modules, no credentials. The
 * real bridge is imported dynamically, and only when webmail is on.
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "../../../../../packages/config/src/index.ts";
import { webmailConfigured } from "./guard.ts";

/** What the enabled bridge needs closed (in order) after its app. */
export type BridgeLoad = {
  app: FastifyInstance;
  closers: readonly (() => Promise<unknown>)[];
};

export type BridgeProcess = BridgeLoad & { mode: "enabled" | "disabled" };

/** Path only: tokens travel in bodies, and neither bodies nor headers are logged. */
export const bridgeLogger = {
  level: process.env.LOG_LEVEL ?? "info",
  serializers: {
    req: (req: { method: string; url?: string }) => ({
      method: req.method,
      path: String(req.url).split("?")[0],
    }),
    res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
  },
};

/** The minimal app of a disabled bridge: a health check and nothing else. */
export async function buildDisabledBridgeApp(): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 1024,
    trustProxy: false,
    logger: bridgeLogger,
  });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    // Answered before Fastify reads or parses a body, so no parse or size
    // error can tell this app from a plain 404.
    const path = String(req.url).split("?")[0];
    if (path === "/healthz" && (req.method === "GET" || req.method === "HEAD"))
      return;
    return reply.code(404).send();
  });
  app.get("/healthz", async () => ({ status: "disabled" }));
  return app;
}

/**
 * The app of the bridge process. `register` loads the module registry and is
 * supplied by the entrypoint, the one place allowed to name it. `loadEnabled`
 * is a test seam.
 */
export async function createWebmailBridgeProcess(
  config: Pick<
    Config,
    "ORBIT_WEBMAIL" | "APP_ORIGIN" | "WEBMAIL_ORIGIN" | "WEBMAIL_BRIDGE_SECRET"
  >,
  seams: {
    register?: () => Promise<unknown>;
    loadEnabled?: () => Promise<BridgeLoad>;
  } = {},
): Promise<BridgeProcess> {
  if (!webmailConfigured(config))
    return {
      mode: "disabled",
      app: await buildDisabledBridgeApp(),
      closers: [],
    };
  const load =
    seams.loadEnabled ??
    (async (): Promise<BridgeLoad> => {
      const { buildBridgeApp } = await import("./bridge.ts");
      const { closeDatabase } =
        await import("../../../../../packages/db/src/index.ts");
      // A broken manifest stops the bridge before it serves anything, and
      // the inbound fetch of the barrier needs the registered consumers.
      await seams.register?.();
      return {
        app: await buildBridgeApp({
          bridgeSecret: config.WEBMAIL_BRIDGE_SECRET,
        }),
        closers: [() => closeDatabase()],
      };
    });
  return { mode: "enabled", ...(await load()) };
}

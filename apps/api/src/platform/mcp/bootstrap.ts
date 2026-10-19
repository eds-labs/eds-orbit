/**
 * Composition of the MCP gateway process (Track M, WP-M5, D-M5-1).
 *
 * A compose service whose process exits on a disabled flag would crash-loop
 * and fail health checks, so with ORBIT_MCP_GATEWAY or ORBIT_MCP_OAUTH off the
 * process stays up as a health-only app: `GET /healthz` answers
 * `{status:"disabled"}`, everything else is 404. That path imports only
 * Fastify and the guard: no auth, no database client, no MCP SDK, no modules.
 * The enabled path is loaded dynamically, and only when both flags are "true".
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "../../../../../packages/config/src/index.ts";
import { mcpGatewayEnabled } from "./gateway-guard.ts";

/** What the enabled gateway needs closed (in order) after its app. */
export type McpGatewayLoad = {
  app: FastifyInstance;
  closers: readonly (() => Promise<unknown>)[];
};

export type McpGatewayProcess = McpGatewayLoad & {
  mode: "enabled" | "disabled";
};

/** The minimal app of a disabled gateway: a health check and nothing else. */
export async function buildDisabledMcpApp(): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 1024,
    trustProxy: false,
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      serializers: {
        // Path only (no query string), no headers, no bodies.
        req: (req: { method: string; url?: string }) => ({
          method: req.method,
          path: String(req.url).split("?")[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    },
  });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    // Everything but the health check is answered here, before Fastify reads
    // or parses a body: no JSON parse error (400), size error (413) or other
    // default error body can distinguish this app from a plain 404.
    const path = String(req.url).split("?")[0];
    if (path === "/healthz" && (req.method === "GET" || req.method === "HEAD"))
      return;
    return reply.code(404).send();
  });
  app.get("/healthz", async () => ({ status: "disabled" }));
  return app;
}

/** The enabled gateway: registers the modules, builds the app, owns the database. */
async function loadEnabledGateway(): Promise<McpGatewayLoad> {
  const { registerModules } = await import("../../modules/registry.ts");
  const { buildMcpServer } = await import("./server.ts");
  const { closeDatabase } =
    await import("../../../../../packages/db/src/index.ts");
  // A broken module manifest stops the gateway before it serves anything.
  registerModules();
  return { app: await buildMcpServer(), closers: [() => closeDatabase()] };
}

/**
 * The app of the gateway process: the real gateway when both flags are
 * "true", the health-only app otherwise. `loadEnabled` is a test seam.
 */
export async function createMcpGatewayProcess(
  config: Pick<Config, "ORBIT_MCP_GATEWAY" | "ORBIT_MCP_OAUTH">,
  seams: { loadEnabled?: () => Promise<McpGatewayLoad> } = {},
): Promise<McpGatewayProcess> {
  if (!mcpGatewayEnabled(config))
    return { mode: "disabled", app: await buildDisabledMcpApp(), closers: [] };
  const loaded = await (seams.loadEnabled ?? loadEnabledGateway)();
  return { mode: "enabled", ...loaded };
}

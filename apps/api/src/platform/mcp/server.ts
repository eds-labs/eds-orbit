/**
 * The MCP gateway's HTTP app (Track M, WP-M2, plans/orbit-modularization/09
 * §3.1, §3.2): `POST /mcp` bridged to the MCP TypeScript SDK behind Better
 * Auth's `requireMcpAuth`, the protected resource metadata, and a health
 * check. It runs in its own process (mcp-main.ts), never inside the API.
 *
 * Per request: Origin policy (D-M2-6), token verification by the library
 * (signature via JWKS, `iss`, `aud` ⊇ MCP_RESOURCE, `exp`, DPoP), the rate
 * limits keyed from the verified claims, then the principal resolved again
 * from the grant (never cached), then the SDK handler with a server built
 * for that principal (adapter.ts).
 * The caller registers the modules first (mcp-main.ts is the composition root).
 */
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { requireMcpAuth } from "@better-auth/mcp";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import type { JWTPayload } from "better-auth";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { isTrustedPeer } from "../../client-ip.ts";
import { sendWebResponse } from "../mcp-auth/http.ts";
import { ORBIT_WORKSPACE_CLAIM } from "../mcp-auth/plugins.ts";
import { makeAuth } from "../tenancy/auth.ts";
import {
  mcpServerFor,
  type McpCallObserver,
  type McpRequestState,
} from "./adapter.ts";
import { createMcpObserver, startMcpRun } from "./audit.ts";
import {
  batchRefusedResponse,
  methodNotFoundResponse,
  rateLimitedResponse,
  rpcErrorResponse,
  unauthenticatedResponse,
} from "./errors.ts";
import {
  assertMcpGatewayEnabled,
  parseAllowedOrigins,
} from "./gateway-guard.ts";
import {
  MCP_RATE_LIMITS,
  McpRateLimiter,
  type McpRateLimits,
} from "./limits.ts";
import { resolvePrincipal } from "./principal.ts";

/** Request body limit of the gateway (bytes). */
export const MCP_BODY_LIMIT = 256 * 1024;
/** The scopes the resource itself serves; identity scopes stay with the authorization server. */
export const MCP_RESOURCE_SCOPES = ["orbit:read", "orbit:propose"] as const;
const PRM_PATH = "/.well-known/oauth-protected-resource";

export type McpServerOptions = {
  /** Test seam: the CIMD metadata transport (see makeAuth). */
  cimdFetch?: typeof fetch;
  /**
   * Where requireMcpAuth fetches the signing keys; default (Better Auth)
   * `${APP_ORIGIN}/api/auth/jwks`. Test seam and the knob for an internal URL.
   */
  jwksUrl?: string;
  /** Called after the built-in audit and telemetry for every finished tool call (tests). */
  observe?: McpCallObserver;
  /** Test seam: replaces MCP_RATE_LIMITS (limits.ts), key by key. */
  rateLimits?: Partial<McpRateLimits>;
  /** Test seam: the clock for rate-limit windows and the lastUsedAt pacing. */
  clock?: () => number;
  /** Test seam: replaces the 25 s tool timeout (adapter.ts). */
  toolTimeoutMs?: number;
  /** Test seam: where the logger writes (default stdout). */
  logStream?: { write(line: string): void };
};

// "::ffff:10.0.0.5" and "10.0.0.5" are the same client.
function normalizeIp(address: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return (mapped ? mapped[1]! : address).toLowerCase();
}

/**
 * The client address: the right-most X-Forwarded-For entry (the one the
 * proxy in front, Traefik, appended) when the TCP peer is trusted
 * (isTrustedPeer), otherwise the TCP peer itself.
 */
export function mcpClientIp(req: FastifyRequest): string {
  const peer = normalizeIp(req.socket.remoteAddress ?? req.ip);
  if (!isTrustedPeer(req)) return peer;
  const header = req.headers["x-forwarded-for"];
  const last = (Array.isArray(header) ? header.join(",") : (header ?? ""))
    .split(",")
    .at(-1)
    ?.trim();
  const forwarded = last ? normalizeIp(last) : "";
  return isIP(forwarded) ? forwarded : peer;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const LISTEN_METHOD = "subscriptions/listen";
/** The native tool with its own rate bucket (limits.ts, WP-M3 Task 3). */
const SEARCH_TOOL = "search";

type PeekedMessage = {
  method?: string;
  toolName?: string;
  /** The raw `arguments` of a tools/call (hashed for audit, never stored). */
  args?: unknown;
  id: string | number | null;
  /** The body asks for subscriptions/listen. */
  listen: boolean;
  /** The body is a JSON-RPC batch (an array), which the gateway refuses. */
  batch: boolean;
};

/** The JSON-RPC method, tool name and arguments of a request body, when it is a single message. */
function peekMessage(body: string): PeekedMessage {
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return { id: null, listen: false, batch: false };
  }
  if (Array.isArray(message)) return { id: null, listen: false, batch: true };
  if (!isRecord(message)) return { id: null, listen: false, batch: false };
  const params = isRecord(message.params) ? message.params : undefined;
  const id =
    typeof message.id === "string" || typeof message.id === "number"
      ? message.id
      : null;
  return {
    id,
    listen: message.method === LISTEN_METHOD,
    batch: false,
    ...(typeof message.method === "string" ? { method: message.method } : {}),
    ...(typeof params?.name === "string" ? { toolName: params.name } : {}),
    ...(params && "arguments" in params ? { args: params.arguments } : {}),
  };
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * Builds the gateway app. Throws unless ORBIT_MCP_GATEWAY and ORBIT_MCP_OAUTH
 * are both "true", and on an invalid ORBIT_MCP_ALLOWED_ORIGINS.
 */
export async function buildMcpServer(
  options: McpServerOptions = {},
): Promise<FastifyInstance> {
  const config = loadConfig();
  assertMcpGatewayEnabled(config);
  const allowedOrigins = new Set(
    parseAllowedOrigins(config.ORBIT_MCP_ALLOWED_ORIGINS),
  );
  const resource = config.MCP_RESOURCE;
  const issuer = `${config.APP_ORIGIN}/api/auth`;
  const auth = makeAuth({ cimdFetch: options.cimdFetch });
  const limits = { ...MCP_RATE_LIMITS, ...options.rateLimits };
  const limiter = new McpRateLimiter(options.clock);

  const app = Fastify({
    bodyLimit: MCP_BODY_LIMIT,
    // req.ip stays the TCP peer; mcpClientIp() decides about forwarding.
    trustProxy: false,
    // Never trust or echo client-supplied request ids.
    genReqId: () => randomUUID(),
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      ...(options.logStream ? { stream: options.logStream } : {}),
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie"],
        censor: "[redacted]",
      },
      // Path only (no query string), no headers, no bodies.
      serializers: {
        req: (req: { id: string; method: string; url?: string }) => ({
          id: req.id,
          method: req.method,
          path: String(req.url).split("?")[0],
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    },
  });

  // The SDK parses and checks the body itself (content type, JSON-RPC
  // shape); Fastify only enforces the size limit and hands the text over.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) =>
    done(null, body),
  );

  app.addHook("onRequest", async (req, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    // D-M2-6: a browser request (it carries Origin) is refused before its
    // token is looked at, unless the origin is explicitly allowed.
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(String(origin)))
      return sendWebResponse(
        reply,
        rpcErrorResponse(403, "Origin not allowed"),
      );
  });

  app.setErrorHandler(
    (error: { statusCode?: number; code?: string }, req, reply) => {
      const status =
        typeof error.statusCode === "number" && error.statusCode >= 400
          ? error.statusCode
          : 500;
      req.log[status >= 500 ? "error" : "warn"](
        { code: error.code ?? "REQUEST_FAILED", status },
        "mcp request failed",
      );
      const message =
        status === 413
          ? "Request body too large"
          : status < 500
            ? "Bad request"
            : "Internal error";
      return sendWebResponse(reply, rpcErrorResponse(status, message));
    },
  );

  // Audit and telemetry first, then the optional test observer; neither can
  // fail a call (the built-in one handles its own errors, notify the rest).
  const builtIn = createMcpObserver({ log: app.log, now: options.clock });
  const observe: McpCallObserver = async (record) => {
    await builtIn(record);
    await options.observe?.(record);
  };
  const states = new WeakMap<AuthInfo, McpRequestState>();
  const handler = createMcpHandler(
    (ctx) => mcpServerFor(ctx.authInfo && states.get(ctx.authInfo)),
    {
      // D-M2-7: 2026-07-28 and 2025-era traffic, both without sessions.
      legacy: "stateless",
      onerror: (error) =>
        app.log.warn({ errorName: error.name }, "mcp handler error"),
    },
  );
  app.addHook("onClose", async () => handler.close());

  /** Per verified request: charge the limits, resolve the principal again, then hand over to the SDK. */
  const serve = (req: FastifyRequest, startedAt: number) =>
    requireMcpAuth(
      auth,
      async (request: Request, claims: JWTPayload) => {
        // Authenticated requests are counted per grant, user and client,
        // keyed from the verified claims and charged before the principal is
        // resolved: a refused request costs no database read. The grant
        // bucket is the tuple activeGrantForToken looks the grant up by.
        const userId = text(claims.sub);
        const clientId = text(claims.azp);
        const workspaceClaim = text(claims[ORBIT_WORKSPACE_CLAIM]);
        const peek = peekMessage(typeof req.body === "string" ? req.body : "");
        const grantKey = `${userId}|${clientId}|${workspaceClaim}`;
        const verdict = limiter.take([
          {
            key: `grant:${grantKey}`,
            max: limits.perGrant,
            label: "grant",
          },
          // The paid read has its own bucket, charged for its calls only (D-M3-10).
          ...(peek.method === "tools/call" && peek.toolName === SEARCH_TOOL
            ? [
                {
                  key: `search:${grantKey}`,
                  max: limits.searchPerGrant,
                  label: "search",
                },
              ]
            : []),
          { key: `user:${userId}`, max: limits.perUser, label: "user" },
          { key: `client:${clientId}`, max: limits.perClient, label: "client" },
        ]);
        if (!verdict.allowed) {
          req.log.warn(
            { code: "MCP_RATE_LIMITED", bucket: verdict.label },
            "mcp request rate limited",
          );
          return rateLimitedResponse(verdict.retryAfterSeconds);
        }
        // MCP dropped JSON-RPC batching (2025-06-18) and no target client
        // batches: a batch would carry calls past the per-call checks
        // (search bucket, audit, per-call keys), so it is refused whole,
        // before the principal is resolved or the SDK sees it.
        if (peek.batch) return batchRefusedResponse();
        const principal = await resolvePrincipal(claims);
        // Without an active grant only a tool call gets an answer, as an
        // isError result carrying the challenge; everything else is a 401.
        if (!principal && peek.method !== "tools/call")
          return unauthenticatedResponse(resource);
        // subscriptions/listen would keep a stream open that never checks
        // the principal again; the gateway offers no notifications.
        if (peek.listen) return methodNotFoundResponse(peek.id);
        const authInfo: AuthInfo = {
          // The raw bearer token stays out of the SDK.
          token: principal ? `grant:${principal.grantId}` : "grant:none",
          clientId,
          scopes: principal ? [...principal.scopes] : [],
          ...(typeof claims.exp === "number" ? { expiresAt: claims.exp } : {}),
          resource: new URL(resource),
        };
        states.set(authInfo, {
          requestId: req.id,
          userId,
          startedAt,
          clientId,
          clientIp: mcpClientIp(req),
          principal,
          ...(peek.method ? { method: peek.method } : {}),
          ...(peek.toolName ? { toolName: peek.toolName } : {}),
          ...("args" in peek ? { args: peek.args } : {}),
          resource,
          log: req.log,
          observe,
          startRun: startMcpRun,
          ...(options.toolTimeoutMs !== undefined
            ? { toolTimeoutMs: options.toolTimeoutMs }
            : {}),
        });
        return handler.fetch(request, { authInfo });
      },
      {
        resource,
        issuer,
        ...(options.jwksUrl ? { jwksUrl: options.jwksUrl } : {}),
      },
    );

  app.post("/mcp", async (req, reply) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      // Cookies are never a credential here.
      if (name === "cookie" || value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value])
        headers.append(name, item);
    }
    // The public resource URL, so DPoP proofs (htu) match what the client signed.
    const request = new Request(resource, {
      method: "POST",
      headers,
      body: typeof req.body === "string" ? req.body : "",
    });
    // Requests without a usable token are counted per client address: those
    // without credentials before anything is looked at, those whose token
    // fails verification (a 401) afterwards.
    const credentials = Boolean(req.headers.authorization);
    const ipRule = {
      key: `ip:${mcpClientIp(req)}`,
      max: limits.unauthenticatedPerIp,
      label: "ip",
    };
    const refuse = (verdict: ReturnType<typeof limiter.take>) => {
      if (verdict.allowed) return null;
      req.log.warn(
        { code: "MCP_RATE_LIMITED", bucket: verdict.label },
        "mcp request rate limited",
      );
      return rateLimitedResponse(verdict.retryAfterSeconds);
    };
    if (!credentials) {
      const refused = refuse(limiter.take([ipRule]));
      if (refused) return sendWebResponse(reply, refused);
    }
    let response: Response;
    try {
      response = await serve(req, Date.now())(request);
      if (credentials && response.status === 401)
        response = refuse(limiter.take([ipRule])) ?? response;
    } catch (error) {
      // Key-set outages and other failures outside a challenge: no detail.
      req.log.error(
        { code: "MCP_REQUEST_FAILED", errorName: (error as Error)?.name },
        "mcp request failed",
      );
      response = rpcErrorResponse(503, "Service unavailable");
    }
    return sendWebResponse(reply, response);
  });

  // Stateless serving (D-M2-7): no event stream, no session to delete.
  for (const method of ["GET", "DELETE"] as const)
    app.route({
      method,
      url: "/mcp",
      handler: async (_req, reply) => {
        reply.header("allow", "POST");
        return sendWebResponse(
          reply,
          rpcErrorResponse(405, "Method not allowed."),
        );
      },
    });

  // RFC 9728: the path-inserted location of the resource and the root one
  // some clients probe; both describe the same resource.
  const metadata = {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...MCP_RESOURCE_SCOPES],
    bearer_methods_supported: ["header"],
  };
  const resourcePath = new URL(resource).pathname.replace(/\/$/, "");
  for (const path of new Set([`${PRM_PATH}${resourcePath}`, PRM_PATH]))
    app.get(path, async () => metadata);

  app.get("/healthz", async () => ({ status: "ok" }));
  return app;
}

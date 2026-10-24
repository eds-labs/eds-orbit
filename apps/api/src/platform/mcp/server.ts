import { TaskSubscriptions } from "./task-resources.ts";
import { mcp2Enabled } from "../tasks/operation-tools.ts";
/**
 * The MCP gateway's HTTP app (Track M, WP-M2, plans/orbit-modularization/09
 * §3.1, §3.2): `POST /mcp` bridged to the MCP TypeScript SDK behind Better
 * Auth's `requireMcpAuth`, the protected resource metadata, and a health
 * check. It runs in its own process (mcp-main.ts), never inside the API.
 *
 * Per request: Origin policy (D-M2-6), the per-address limit for a request
 * without a token this process verified (before verification, D-M5-6),
 * token verification by the library (signature via JWKS, `iss`, `aud` ⊇
 * MCP_RESOURCE, `exp`, DPoP), the rate limits keyed from the verified
 * claims, then the principal resolved again from the grant (never cached),
 * then the SDK handler with a server built for that principal (adapter.ts).
 * The caller registers the modules first (mcp-main.ts is the composition root).
 */
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { requireMcpAuth } from "@better-auth/mcp";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import type { JWTPayload } from "better-auth";
import {
  DPOP_SIGNING_ALGORITHMS,
  parseAccessTokenAuthorization,
} from "better-auth/oauth2";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { isTrustedPeer } from "../../client-ip.ts";
import { sendWebResponse } from "../mcp-auth/http.ts";
import { ORBIT_WORKSPACE_CLAIM } from "../mcp-auth/plugins.ts";
import { makeAuth } from "../tenancy/auth.ts";
import { registeredTools } from "../modules/contributions.ts";
import {
  assertMcpToolContracts,
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
  ipBucket,
  MCP_RATE_LIMITS,
  McpProjectSlots,
  McpRateLimiter,
  McpVerifiedTokens,
  type McpProjectConcurrency,
  type McpRateLimits,
} from "./limits.ts";
import { resolvePrincipal } from "./principal.ts";
import { McpProposalDayCache } from "./proposals.ts";

/** Request body limit of the gateway (bytes). */
export const MCP_BODY_LIMIT = 256 * 1024;
/** The scopes the resource itself serves; identity scopes stay with the authorization server. */
export const MCP_RESOURCE_SCOPES = [
  "orbit:read",
  "orbit:propose",
  "orbit:write",
  "orbit:support",
  "orbit:finance.read",
  "orbit:finance.extract",
] as const;
const PRM_PATH = "/.well-known/oauth-protected-resource";

export type McpServerOptions = {
  /** Test seam for bounded subscription replay/lifetime. */
  taskSubscriptions?: { pollMs?: number; lifetimeMs?: number };
  /** Test seam: the CIMD metadata transport (see makeAuth). */
  cimdFetch?: typeof fetch;
  /**
   * Where requireMcpAuth fetches the signing keys; default MCP_JWKS_URL, then
   * (Better Auth) `${APP_ORIGIN}/api/auth/jwks`. Wins over the environment.
   */
  jwksUrl?: string;
  /** Called after the built-in audit and telemetry for every finished tool call (tests). */
  observe?: McpCallObserver;
  /** Test seam: replaces MCP_RATE_LIMITS (limits.ts), key by key. */
  rateLimits?: Partial<McpRateLimits>;
  /** Test seam: replaces MCP_PROJECT_CONCURRENCY (limits.ts, R-10), key by key. */
  projectConcurrency?: Partial<McpProjectConcurrency>;
  /** Test seam: the project slots themselves (wins over projectConcurrency). */
  projectSlots?: McpProjectSlots;
  /** Test seam: the size cap of the per-address limiter (MCP_RATE_LIMITER_MAX_KEYS). */
  ipLimiterMaxKeys?: number;
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
  // A tool whose MCP contract is broken stops the gateway before it serves
  // anything (D-M5-8); registration has refused it already.
  assertMcpToolContracts(registeredTools());
  const allowedOrigins = new Set(
    parseAllowedOrigins(config.ORBIT_MCP_ALLOWED_ORIGINS),
  );
  const resource = config.MCP_RESOURCE;
  const issuer = `${config.APP_ORIGIN}/api/auth`;
  const jwksUrl = options.jwksUrl ?? config.MCP_JWKS_URL;
  const auth = makeAuth({ cimdFetch: options.cimdFetch });
  const limits = { ...MCP_RATE_LIMITS, ...options.rateLimits };
  // Two limiters with their own size caps: the per-address buckets anyone
  // can create without a token, and the buckets of verified requests
  // (grant, user, client, search, proposals). A flood of new addresses
  // fills only the first, so it can never refuse authenticated traffic.
  const limiter = new McpRateLimiter(options.clock);
  const ipLimiter = new McpRateLimiter(options.clock, options.ipLimiterMaxKeys);
  const verifiedTokens = new McpVerifiedTokens(options.clock);
  const projectSlots =
    options.projectSlots ?? new McpProjectSlots(options.projectConcurrency);
  // Keys whose daily proposal quota is used up, until UTC midnight (D-M5-8).
  const proposalsUsedUp = new McpProposalDayCache();

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
  const subscriptions = new TaskSubscriptions(options.taskSubscriptions);
  app.addHook("onClose", async () => subscriptions.close());
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
  const serve = (
    req: FastifyRequest,
    startedAt: number,
    token: string | undefined,
  ) =>
    requireMcpAuth(
      auth,
      async (request: Request, claims: JWTPayload) => {
        // Verified: later requests with this token skip the per-address
        // count before verification.
        if (token)
          verifiedTokens.remember(
            token,
            typeof claims.exp === "number" ? claims.exp : undefined,
          );
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
        if (peek.listen) {
          if (
            !principal ||
            !mcp2Enabled() ||
            req.headers["mcp-protocol-version"] !== "2026-07-28"
          )
            return methodNotFoundResponse(peek.id);
          try {
            return await subscriptions.listen(
              JSON.parse(String(req.body)),
              principal,
              async () => {
                if (
                  typeof claims.exp !== "number" ||
                  claims.exp * 1000 <= Date.now()
                )
                  return null;
                return resolvePrincipal(claims);
              },
            );
          } catch {
            return rpcErrorResponse(400, "Subscription not available");
          }
        }
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
          proposalQuota: {
            limiter,
            perHour: limits.proposalsPerHour,
            perDay: limits.proposalsPerDay,
            now: options.clock ?? Date.now,
            usedUp: proposalsUsedUp,
          },
          projectSlots,
          ...(options.toolTimeoutMs !== undefined
            ? { toolTimeoutMs: options.toolTimeoutMs }
            : {}),
        });
        return handler.fetch(request, { authInfo });
      },
      {
        resource,
        issuer,
        ...(jwksUrl ? { jwksUrl } : {}),
      },
    );

  // The endpoint lives at /mcp; a proxy that strips that prefix delivers the
  // same request at "/" (WP-M5, D-M5-3). Both behave identically.
  const ENDPOINT_PATHS = ["/mcp", "/"];
  const handlePost = async (req: FastifyRequest, reply: FastifyReply) => {
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
    // Requests without a token this process verified are counted per
    // client address (an IPv6 client by its /64) before the token is looked
    // at, so a burst of bad tokens is refused without verification work
    // (D-M5-6). A known token is verified as always but not counted here;
    // a request that still ends in 401 is counted afterwards. When the
    // address limiter is full (capacity, not the address's own limit), a
    // request with a token is verified anyway: an address flood must not
    // lock out clients whose token this process has not seen yet.
    const header = req.headers.authorization;
    const token =
      parseAccessTokenAuthorization(
        typeof header === "string" ? header : undefined,
      )?.token || undefined;
    const ipRule = {
      key: `ip:${ipBucket(mcpClientIp(req))}`,
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
    let counted = false;
    if (!(token && verifiedTokens.has(token))) {
      const verdict = ipLimiter.take([ipRule]);
      if (verdict.allowed) counted = true;
      else if (!(token && verdict.label === "capacity"))
        return sendWebResponse(reply, refuse(verdict)!);
    }
    let response: Response;
    try {
      response = await serve(req, Date.now(), token)(request);
      if (response.status === 401) {
        // The token is no longer good (its grant is gone): count it again.
        if (token) verifiedTokens.forget(token);
        if (!counted) response = refuse(ipLimiter.take([ipRule])) ?? response;
      }
    } catch (error) {
      // Key-set outages and other failures outside a challenge: no detail.
      req.log.error(
        { code: "MCP_REQUEST_FAILED", errorName: (error as Error)?.name },
        "mcp request failed",
      );
      response = rpcErrorResponse(503, "Service unavailable");
    }
    return sendWebResponse(reply, response);
  };
  for (const url of ENDPOINT_PATHS) app.post(url, handlePost);

  // Stateless serving (D-M2-7): no event stream, no session to delete.
  for (const url of ENDPOINT_PATHS)
    for (const method of ["GET", "DELETE"] as const)
      app.route({
        method,
        url,
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
  // DPoP is verified by requireMcpAuth with Better Auth's default
  // algorithms (no signingAlgorithms are configured), the list Better
  // Auth's own resource metadata advertises.
  const metadata = {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...MCP_RESOURCE_SCOPES],
    bearer_methods_supported: ["header"],
    dpop_signing_alg_values_supported: [...DPOP_SIGNING_ALGORITHMS],
  };
  const resourcePath = new URL(resource).pathname.replace(/\/$/, "");
  for (const path of new Set([`${PRM_PATH}${resourcePath}`, PRM_PATH]))
    app.get(path, async () => metadata);

  app.get("/healthz", async () => ({ status: "ok" }));
  return app;
}

/**
 * The MCP gateway's HTTP app (Track M, WP-M2, plans/orbit-modularization/09
 * §3.1, §3.2): `POST /mcp` bridged to the MCP TypeScript SDK behind Better
 * Auth's `requireMcpAuth`, the protected resource metadata, and a health
 * check. It runs in its own process (mcp-main.ts), never inside the API.
 *
 * Per request: Origin policy (D-M2-6), token verification by the library
 * (signature via JWKS, `iss`, `aud` ⊇ MCP_RESOURCE, `exp`, DPoP), then the
 * principal resolved again from the grant (never cached), then the SDK
 * handler with a server built for that principal (adapter.ts).
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
import { makeAuth } from "../tenancy/auth.ts";
import {
  mcpServerFor,
  type McpCallObserver,
  type McpRequestState,
} from "./adapter.ts";
import { rpcErrorResponse, unauthenticatedResponse } from "./errors.ts";
import {
  assertMcpGatewayEnabled,
  parseAllowedOrigins,
} from "./gateway-guard.ts";
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
  /** The audit/telemetry hook for finished tool calls (Task 4). */
  observe?: McpCallObserver;
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

/** The JSON-RPC method and tool name of a request body, when it is a single message. */
function peekMessage(body: string): { method?: string; toolName?: string } {
  try {
    const message = JSON.parse(body) as {
      method?: unknown;
      params?: { name?: unknown };
    };
    if (!message || typeof message !== "object" || Array.isArray(message))
      return {};
    return {
      ...(typeof message.method === "string" ? { method: message.method } : {}),
      ...(typeof message.params?.name === "string"
        ? { toolName: message.params.name }
        : {}),
    };
  } catch {
    return {};
  }
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

  const app = Fastify({
    bodyLimit: MCP_BODY_LIMIT,
    // req.ip stays the TCP peer; mcpClientIp() decides about forwarding.
    trustProxy: false,
    // Never trust or echo client-supplied request ids.
    genReqId: () => randomUUID(),
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
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

  /** Per verified request: resolve the principal again, then hand over to the SDK. */
  const serve = (req: FastifyRequest) =>
    requireMcpAuth(
      auth,
      async (request: Request, claims: JWTPayload) => {
        const principal = await resolvePrincipal(claims);
        const peek = peekMessage(typeof req.body === "string" ? req.body : "");
        // Without an active grant only a tool call gets an answer, as an
        // isError result carrying the challenge; everything else is a 401.
        if (!principal && peek.method !== "tools/call")
          return unauthenticatedResponse(resource);
        const authInfo: AuthInfo = {
          // The raw bearer token stays out of the SDK.
          token: principal ? `grant:${principal.grantId}` : "grant:none",
          clientId: text(claims.azp),
          scopes: principal ? [...principal.scopes] : [],
          ...(typeof claims.exp === "number" ? { expiresAt: claims.exp } : {}),
          resource: new URL(resource),
        };
        states.set(authInfo, {
          requestId: req.id,
          clientId: text(claims.azp),
          clientIp: mcpClientIp(req),
          principal,
          ...peek,
          resource,
          log: req.log,
          ...(options.observe ? { observe: options.observe } : {}),
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
    let response: Response;
    try {
      response = await serve(req)(request);
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

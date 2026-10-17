import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import type { Config } from "../../../../../packages/config/src/index.ts";
import { oauthApi } from "./plugins.ts";

// HTTP surface of the OAuth authorization server (Track M, WP-M1): which
// /api/auth paths are reachable, which skip the browser Origin check, and the
// discovery route. All of it is inert while ORBIT_MCP_OAUTH is false.

type OAuthFlags = Pick<Config, "ORBIT_MCP_OAUTH" | "ORBIT_MCP_DCR">;

/** RFC 8414 location for the issuer `${APP_ORIGIN}/api/auth` (path inserted after /.well-known/...). */
export const OAUTH_METADATA_PATH =
  "/.well-known/oauth-authorization-server/api/auth";

/** Machine-to-machine endpoints: callers are OAuth clients, not browsers, so they send no Origin. */
export const ORIGIN_EXEMPT_OAUTH =
  /^\/api\/auth\/oauth2\/(token|revoke|introspect|register)$/;

/** The /api/auth paths opened by the OAuth server; empty while the flag is off. */
export function oauthAuthPaths(config: OAuthFlags): readonly string[] {
  if (config.ORBIT_MCP_OAUTH !== "true") return [];
  return [
    ...["authorize", "token", "consent", "continue", "userinfo"].map(
      (name) => `/api/auth/oauth2/${name}`,
    ),
    "/api/auth/oauth2/revoke",
    "/api/auth/oauth2/introspect",
    "/api/auth/jwks",
    "/api/auth/.well-known/openid-configuration",
    "/api/auth/.well-known/oauth-authorization-server",
    ...(config.ORBIT_MCP_DCR === "true" ? ["/api/auth/oauth2/register"] : []),
  ];
}

/** The URL path without its query string; the only part the allowlist and exemption look at. */
export const pathOf = (url: string) => url.split("?")[0]!;

/** Whether a request skips the browser Origin check as an OAuth client call. */
export function isOriginExemptOAuth(
  config: OAuthFlags,
  method: string,
  url: string,
) {
  const path = pathOf(url);
  return (
    method === "POST" &&
    ORIGIN_EXEMPT_OAUTH.test(path) &&
    oauthAuthPaths(config).includes(path)
  );
}

/**
 * The body to hand to Better Auth. Form bodies (the OAuth token, revoke and
 * introspect requests) arrive as the raw string and stay untouched; JSON
 * bodies are parsed by Fastify and serialised again. Form passthrough applies
 * only while the OAuth server is on, so the flag off changes nothing.
 */
export function authRequestBody(
  config: OAuthFlags,
  req: Pick<FastifyRequest, "body" | "headers">,
) {
  if (!req.body) return undefined;
  const type = req.headers["content-type"] ?? "";
  if (
    config.ORBIT_MCP_OAUTH === "true" &&
    typeof req.body === "string" &&
    type.toLowerCase().startsWith("application/x-www-form-urlencoded")
  )
    return req.body;
  return JSON.stringify(req.body);
}

/** Sends a Web `Response` through Fastify; cookies keep their separate headers. */
export async function sendWebResponse(reply: FastifyReply, response: Response) {
  reply.code(response.status);
  response.headers.forEach((v, k) => {
    if (k !== "set-cookie") reply.header(k, v);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) reply.header("set-cookie", cookies);
  return reply.send(await response.text());
}

/** Registers the discovery route; nothing exists while the flag is off (Fastify answers 404). */
export function registerOAuthDiscovery(
  app: FastifyInstance,
  auth: Parameters<typeof oauthApi>[0],
  config: OAuthFlags & Pick<Config, "APP_ORIGIN">,
) {
  if (config.ORBIT_MCP_OAUTH !== "true") return;
  const metadata = oauthProviderAuthServerMetadata({ api: oauthApi(auth) });
  app.get(OAUTH_METADATA_PATH, async (req, reply) =>
    sendWebResponse(
      reply,
      await metadata(
        new Request(new URL(OAUTH_METADATA_PATH, config.APP_ORIGIN), {
          method: "GET",
          headers: fromNodeHeaders(req.headers),
        }),
      ),
    ),
  );
}

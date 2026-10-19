import { isIP } from "node:net";
import type { NextRequest } from "next/server";

// Shared by the web app's route handlers that forward to the Orbit API
// (/api/* and /.well-known/*): upstream checks, header forwarding and the
// client address for the API's rate limits.

const hopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
];

// The browser's address for the API's rate limits (apps/api/src/client-ip.ts).
// Traefik appends the address it accepted the connection from as the last
// X-Forwarded-For entry, and Next.js sets the header from the socket when it
// is missing, so only the right-most entry is trusted: anything left of it
// came from the client. This assumes web is reachable only through Traefik.
export function clientIp(request: NextRequest) {
  const hops = request.headers.get("x-forwarded-for")?.split(",");
  const last = hops?.at(-1)?.trim();
  return last && isIP(last) ? last : undefined;
}

/** An upstream origin; throws on a non-HTTP or credentialed value. */
function upstreamTarget(origin: string) {
  const target = new URL(origin);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password
  )
    throw new Error("Invalid upstream configuration");
  return target;
}

type Upstream = {
  origin: string;
  /**
   * The API's own upstream: the proxy-only request headers (client address,
   * Sec-Fetch-Mode) are sent and its Set-Cookie headers reach the browser.
   * Any other upstream gets neither, so it can never set an Orbit cookie.
   */
  api: boolean;
  /** How long a request may wait for the upstream before it answers 502. */
  timeoutMs: number;
};

/** Cookie-setting response headers; only the API's reach the browser. */
const cookieHeaders = ["set-cookie", "set-cookie2"];

/**
 * Forwards `request` to `pathname` on `upstream`. Only the listed request
 * headers are passed on; hop-by-hop headers are dropped from the response, and
 * its cookies are passed on for the API only. Failures answer 502
 * API_UNAVAILABLE.
 */
async function forward(
  upstreamOrigin: Upstream,
  request: NextRequest,
  pathname: string,
  forwardedHeaders: readonly string[],
) {
  try {
    const target = upstreamTarget(upstreamOrigin.origin);
    target.pathname = pathname;
    target.search = request.nextUrl.search;
    const headers = new Headers();
    for (const name of forwardedHeaders) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (upstreamOrigin.api) {
      // Set by the proxy only; a value sent by the browser is not on the list.
      const client = clientIp(request);
      if (client) headers.set("x-orbit-client-ip", client);
      // Node's fetch always sends `Sec-Fetch-Mode: cors` upstream, which makes
      // Better Auth answer JSON instead of a 302 to a browser navigation. The
      // browser's real value travels in a proxy-only header (sent for every
      // path; the API reads it only under /api/auth/* with the OAuth server on).
      const mode = request.headers.get("sec-fetch-mode");
      if (mode) headers.set("x-orbit-sec-fetch-mode", mode);
    }
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      duplex: "half",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(upstreamOrigin.timeoutMs),
      ]),
    } as RequestInit & { duplex: "half" });
    const returned = new Headers(upstream.headers);
    for (const name of hopHeaders) returned.delete(name);
    for (const name of cookieHeaders) returned.delete(name);
    if (upstreamOrigin.api)
      for (const cookie of upstream.headers.getSetCookie())
        returned.append("set-cookie", cookie);
    returned.set("Cache-Control", "no-store, max-age=0");
    returned.set("X-Content-Type-Options", "nosniff");
    return new Response(upstream.body, {
      status: upstream.status,
      headers: returned,
    });
  } catch {
    return Response.json(
      {
        error: {
          code: "API_UNAVAILABLE",
          message: "The workspace service is unavailable. Try again shortly.",
        },
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/**
 * Forwards `request` to `pathname` on the API (ORBIT_API_ORIGIN). Only the
 * listed request headers are passed on, plus the proxy-only client address
 * and Sec-Fetch-Mode headers.
 */
export function forwardToApi(
  request: NextRequest,
  pathname: string,
  forwardedHeaders: readonly string[],
) {
  return forward(
    {
      origin: process.env.ORBIT_API_ORIGIN || "http://127.0.0.1:4311",
      api: true,
      timeoutMs: 45000,
    },
    request,
    pathname,
    forwardedHeaders,
  );
}

/**
 * Forwards `request` to `pathname` on the MCP gateway (ORBIT_MCP_ORIGIN,
 * default the compose service). Only the listed request headers are passed on,
 * and no cookie the gateway sets reaches the browser. It serves two small
 * static documents, so a hung gateway answers 502 after 5 s instead of
 * holding the web request for the API's 45 s.
 */
export function forwardToMcp(
  request: NextRequest,
  pathname: string,
  forwardedHeaders: readonly string[],
) {
  return forward(
    {
      origin: process.env.ORBIT_MCP_ORIGIN || "http://mcp:4312",
      api: false,
      timeoutMs: 5000,
    },
    request,
    pathname,
    forwardedHeaders,
  );
}

import { isIP } from "node:net";
import type { NextRequest } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
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
function clientIp(request: NextRequest) {
  const hops = request.headers.get("x-forwarded-for")?.split(",");
  const last = hops?.at(-1)?.trim();
  return last && isIP(last) ? last : undefined;
}
async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await context.params;
    if (
      path.some(
        (segment) =>
          segment === "." || segment === ".." || segment.includes("\0"),
      )
    )
      return Response.json(
        { error: { code: "INVALID_PATH", message: "Invalid API path." } },
        { status: 400 },
      );
    const target = new URL(
      process.env.ORBIT_API_ORIGIN || "http://127.0.0.1:4311",
    );
    if (
      !["http:", "https:"].includes(target.protocol) ||
      target.username ||
      target.password
    )
      throw new Error("Invalid upstream configuration");
    target.pathname = `/api/${path.map((segment) => encodeURIComponent(segment)).join("/")}`;
    target.search = request.nextUrl.search;
    const headers = new Headers();
    for (const name of [
      "accept",
      "content-type",
      "cookie",
      // A reconnecting EventSource resumes after its last event (WP4.3 Part B).
      "last-event-id",
      "origin",
      "user-agent",
      "x-csrf-token",
      "x-slack-signature",
      "x-slack-request-timestamp",
      // Telegram authenticates its webhook calls with this header.
      "x-telegram-bot-api-secret-token",
    ]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    // Set by the proxy only; a value sent by the browser is not on the list.
    const client = clientIp(request);
    if (client) headers.set("x-orbit-client-ip", client);
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      duplex: "half",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(45000)]),
    } as RequestInit & { duplex: "half" });
    const returned = new Headers(upstream.headers);
    for (const name of hopHeaders) returned.delete(name);
    returned.delete("set-cookie");
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
export {
  proxy as GET,
  proxy as POST,
  proxy as PATCH,
  proxy as PUT,
  proxy as DELETE,
  proxy as OPTIONS,
  proxy as HEAD,
};

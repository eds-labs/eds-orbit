import type { NextRequest } from "next/server";
import { forwardToApi } from "@/lib/api-upstream";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const forwardedHeaders = [
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
];
/**
 * OAuth clients (MCP) authenticate token, revoke and introspect calls with it;
 * public API clients send their session's bearer token in it (WP4.2b).
 */
const oauthHeaders = [...forwardedHeaders, "authorization"];
// A provider's webhook (WP4.2a) is signed with headers of its own choosing
// (x-hub-signature-256, stripe-signature, webhook-id ...), so under
// /api/hooks/ every header passes except these. The hooks route reads no
// cookie or session, and the client address is set by the proxy alone.
const hookDropped = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "cookie",
  "expect",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-real-ip",
]);
const hookHeaders = (request: NextRequest) =>
  [...request.headers.keys()].filter(
    (name) =>
      !hookDropped.has(name) &&
      !/^(x-orbit-|x-forwarded-|x-middleware-|x-nextjs-|sec-)/.test(name),
  );
async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
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
  // Authorization only under /api/auth/oauth2/ and /api/public/: nowhere
  // else does the API read it.
  const bearer =
    (path[0] === "auth" && path[1] === "oauth2") || path[0] === "public";
  return forwardToApi(
    request,
    `/api/${path.map((segment) => encodeURIComponent(segment)).join("/")}`,
    path[0] === "hooks"
      ? hookHeaders(request)
      : bearer
        ? oauthHeaders
        : forwardedHeaders,
  );
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

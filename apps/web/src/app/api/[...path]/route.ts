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
/** OAuth clients (MCP) and public sessions (widgets) authenticate with it. */
const oauthHeaders = [...forwardedHeaders, "authorization"];
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
  // Authorization only where the API reads it: OAuth clients under
  // /api/auth/oauth2/ and public sessions under /api/public/ (WP4.2b, WP5.4).
  const oauth = path[0] === "auth" && path[1] === "oauth2";
  const publicApi = path[0] === "public";
  return forwardToApi(
    request,
    `/api/${path.map((segment) => encodeURIComponent(segment)).join("/")}`,
    oauth || publicApi ? oauthHeaders : forwardedHeaders,
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

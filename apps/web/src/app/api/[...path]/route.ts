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
  // A platform file upload's type and name (WP4.6); the API validates both.
  "x-file-name",
  "x-file-type",
  "x-slack-signature",
  "x-slack-request-timestamp",
  // Telegram authenticates its webhook calls with this header.
  "x-telegram-bot-api-secret-token",
];
/** OAuth clients (MCP) authenticate token, revoke and introspect calls with it. */
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
  // Authorization only under /api/auth/oauth2/: nowhere else does the API read it.
  const oauth = path[0] === "auth" && path[1] === "oauth2";
  return forwardToApi(
    request,
    `/api/${path.map((segment) => encodeURIComponent(segment)).join("/")}`,
    oauth ? oauthHeaders : forwardedHeaders,
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

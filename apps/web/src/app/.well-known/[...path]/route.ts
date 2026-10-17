import type { NextRequest } from "next/server";
import { forwardToApi } from "@/lib/api-upstream";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Only the authorization server metadata for the issuer ${APP_ORIGIN}/api/auth
// (RFC 8414). WP-M2 adds the protected-resource metadata paths here.
const FORWARDED = ["oauth-authorization-server/api/auth"];
async function wellKnown(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const joined = path.join("/");
  if (path.length !== 3 || !FORWARDED.includes(joined))
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  return forwardToApi(request, `/.well-known/${joined}`, [
    "accept",
    "user-agent",
  ]);
}
export { wellKnown as GET, wellKnown as HEAD };

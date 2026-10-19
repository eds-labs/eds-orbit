import type { NextRequest } from "next/server";
import { forwardToApi, forwardToMcp } from "@/lib/api-upstream";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Exactly these well-known documents are forwarded, each path segment by
// segment (a segment containing "/" or ".." never matches):
// - the authorization server metadata for the issuer ${APP_ORIGIN}/api/auth
//   (RFC 8414) goes to the API;
// - the protected resource metadata of the MCP gateway (RFC 9728, root and
//   path-inserted location) goes to the gateway service (WP-M5, D-M5-4), so
//   Traefik needs no route outside /mcp.
const FORWARDED = [
  { segments: ["oauth-authorization-server", "api", "auth"], to: "api" },
  { segments: ["oauth-protected-resource"], to: "mcp" },
  { segments: ["oauth-protected-resource", "mcp"], to: "mcp" },
] as const;
async function wellKnown(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const match = FORWARDED.find(
    ({ segments }) =>
      segments.length === path.length &&
      segments.every((segment, index) => segment === path[index]),
  );
  if (!match)
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  const forward = match.to === "api" ? forwardToApi : forwardToMcp;
  return forward(request, `/.well-known/${path.join("/")}`, [
    "accept",
    "user-agent",
  ]);
}
export { wellKnown as GET, wellKnown as HEAD };

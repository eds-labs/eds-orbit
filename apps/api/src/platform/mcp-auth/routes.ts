import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { fromNodeHeaders } from "better-auth/node";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { authDb } from "../../../../../packages/db/src/index.ts";
import type { Config } from "../../../../../packages/config/src/index.ts";
import * as schemas from "../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../shared.ts";
import { sessionFor, userFor, type Auth } from "../tenancy/auth.ts";
import {
  connectWorkspaces,
  listGrants,
  recordSelection,
  revokeGrant,
  selectionView,
  setGrantProposals,
} from "./grants.ts";

// The /connect page's API (Track M, WP-M1): the signed OAuth request, the
// workspace/project selection and the consent answer, plus listing and
// revoking grants for the settings page. Session required;
// non-GET requests pass the usual browser Origin check. None of these routes
// exists while ORBIT_MCP_OAUTH is off (Fastify answers 404).

const oauthQuery = z.string().min(1).max(8192);
const selectionInput = z
  .object({
    oauthQuery,
    workspaceId: schemas.id,
    projectIds: z.union([
      z.literal("all_current"),
      z.array(schemas.id).min(1).max(500),
    ]),
  })
  .strict();
const grantPatch = z.object({ proposals: z.literal(false) }).strict();
const consentInput = z
  .object({
    oauthQuery,
    accept: z.boolean(),
    scopes: z.array(z.string().min(1).max(100)).max(20),
  })
  .strict();

/**
 * Checks the signed query Better Auth put on the /connect URL. Expiry is
 * checked first so an idle page gets OAUTH_REQUEST_EXPIRED; any other
 * failure (tampered, unsigned) is OAUTH_REQUEST_INVALID.
 */
export async function readOAuthRequest(auth: Auth, query: string) {
  const params = new URLSearchParams(query);
  const exp = params.get("exp");
  if (exp && /^\d+$/.test(exp) && Number(exp) * 1000 < Date.now())
    throw new DomainError("OAUTH_REQUEST_EXPIRED", 400);
  const clientId = params.get("client_id");
  if (
    !clientId ||
    !(await verifyOAuthQueryParams(query, (await auth.$context).secret))
  )
    throw new DomainError("OAUTH_REQUEST_INVALID", 400);
  return {
    clientId,
    scopes: (params.get("scope") ?? "").split(" ").filter(Boolean),
  };
}

/**
 * Calls a provider endpoint on the browser's behalf through Better Auth's
 * handler (the authorize passes need a real request), answered as JSON.
 * Returns the redirect URL or throws the OAuth error as an Orbit error code.
 */
async function providerRedirect(
  auth: Auth,
  appOrigin: string,
  req: FastifyRequest,
  path: "/oauth2/continue" | "/oauth2/consent",
  body: Record<string, unknown>,
) {
  const headers = fromNodeHeaders(req.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  const response = await auth.handler(
    new Request(new URL(`/api/auth${path}`, appOrigin), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
  const result = (await response.json().catch(() => null)) as {
    url?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok) {
    const error = typeof result?.error === "string" ? result.error : "";
    throw new DomainError(
      error === "invalid_signature"
        ? "OAUTH_REQUEST_INVALID"
        : `OAUTH_${error.toUpperCase() || "REQUEST_FAILED"}`.slice(0, 64),
      response.status >= 400 && response.status < 500 ? response.status : 502,
    );
  }
  if (typeof result?.url !== "string")
    throw new DomainError("OAUTH_NO_REDIRECT", 502);
  return result.url;
}

export function registerMcpConnectRoutes(
  app: FastifyInstance,
  auth: Auth,
  config: Pick<Config, "ORBIT_MCP_OAUTH" | "APP_ORIGIN">,
) {
  if (config.ORBIT_MCP_OAUTH !== "true") return;

  app.get("/api/mcp-connect/request", async (req) => {
    const { user, session } = await sessionFor(auth, req);
    const request = await readOAuthRequest(auth, req.url.split("?")[1] ?? "");
    const client = await authDb.oauthClient.findUnique({
      where: { clientId: request.clientId },
      select: { clientId: true, name: true, uri: true, disabled: true },
    });
    if (!client || client.disabled)
      throw new DomainError("OAUTH_REQUEST_INVALID", 400);
    return {
      client: { id: client.clientId, name: client.name, uri: client.uri },
      scopes: request.scopes,
      // The selection this session already made (consent step), else null.
      selection: await selectionView(session.id, request.clientId),
      workspaces: await connectWorkspaces(user.id),
    };
  });

  app.post("/api/mcp-connect/selection", async (req) => {
    const { user, session } = await sessionFor(auth, req);
    const input = selectionInput.parse(req.body);
    const request = await readOAuthRequest(auth, input.oauthQuery);
    await recordSelection({
      userId: user.id,
      sessionId: session.id,
      clientId: request.clientId,
      workspaceId: input.workspaceId,
      projectIds: input.projectIds,
    });
    const next = await providerRedirect(
      auth,
      config.APP_ORIGIN,
      req,
      "/oauth2/continue",
      { postLogin: true, oauth_query: input.oauthQuery },
    );
    return { next };
  });

  app.post("/api/mcp-connect/consent", async (req) => {
    await sessionFor(auth, req);
    const input = consentInput.parse(req.body);
    await readOAuthRequest(auth, input.oauthQuery);
    // Grant activation or denial happens in the provider's consent hook
    // (plugins.ts mcpAuthHooks), so a direct consent call behaves the same.
    const redirect = await providerRedirect(
      auth,
      config.APP_ORIGIN,
      req,
      "/oauth2/consent",
      {
        accept: input.accept,
        oauth_query: input.oauthQuery,
        ...(input.accept && input.scopes.length
          ? { scope: input.scopes.join(" ") }
          : {}),
      },
    );
    return { redirect };
  });

  app.get("/api/mcp-grants", async (req) => {
    const user = await userFor(auth, req);
    return { grants: await listGrants({ userId: user.id }, { mine: true }) };
  });

  app.get<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId/mcp-grants",
    async (req) => {
      const user = await userFor(auth, req);
      return {
        grants: await listGrants(
          { userId: user.id },
          { workspaceId: req.params.workspaceId },
        ),
      };
    },
  );

  app.delete<{ Params: { grantId: string } }>(
    "/api/mcp-grants/:grantId",
    async (req, reply) => {
      const user = await userFor(auth, req);
      await revokeGrant({ userId: user.id }, req.params.grantId, req.log);
      return reply.code(204).send();
    },
  );

  // Stops the grant from proposing (WP-M4); proposing comes back only with a
  // new consent, so `proposals: true` is not accepted.
  app.patch<{ Params: { grantId: string } }>(
    "/api/mcp-grants/:grantId",
    async (req, reply) => {
      const user = await userFor(auth, req);
      const body = grantPatch.parse(req.body);
      await setGrantProposals(
        { userId: user.id },
        req.params.grantId,
        body.proposals,
        req.log,
      );
      return reply.code(204).send();
    },
  );
}

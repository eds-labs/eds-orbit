import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin } from "better-auth/plugins";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";
import { authDb } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { DomainError } from "../shared.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { projectMembership } from "./member-scope.ts";
import { moduleScope } from "./module-roles.ts";
import { authorize, PROJECT_READ } from "./permissions.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
import { CLIENT_IP_HEADER } from "../../client-ip.ts";
import {
  mcpAuthDeps,
  mcpAuthHooks,
  mcpAuthPlugins,
} from "../mcp-auth/plugins.ts";
import {
  grantClientDeps,
  grantHookDeps,
  grantPostLogin,
} from "../mcp-auth/grants.ts";
import { captureResetToken } from "./reset-capture.ts";
// `cimdFetch` is a test seam for the Client ID Metadata Document transport.
export function makeAuth(options: { cimdFetch?: typeof fetch } = {}) {
  const config = loadConfig();
  const oauth = config.ORBIT_MCP_OAUTH === "true";
  return betterAuth({
    database: prismaAdapter(authDb, { provider: "postgresql" }),
    secret: config.AUTH_SECRET,
    baseURL: config.APP_ORIGIN,
    basePath: "/api/auth",
    trustedOrigins: [config.APP_ORIGIN],
    // jwt() would otherwise expose a session JWT at GET /api/auth/token.
    disabledPaths: ["/token"],
    // The admin plugin supplies the system administrator role and the ban
    // state (ADR 0012): banned users cannot sign in or get a session. Its
    // HTTP routes stay unreachable (server.ts allowlist); Orbit's own admin
    // routes call it server-side.
    plugins: [
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      ...(oauth
        ? mcpAuthPlugins(config, {
            ...mcpAuthDeps(options),
            ...grantPostLogin(),
            clientEvents: grantClientDeps(),
          })
        : []),
    ],
    // Global hooks exist only for the OAuth server; flag off keeps none.
    ...(oauth ? { hooks: mcpAuthHooks(config, grantHookDeps()) } : {}),
    // The provider reports a refused authorization (such as an unregistered
    // redirect_uri) here; /api/auth/error is not reachable through Orbit's
    // allowlist, so the web app shows the message at /connect/error. Absolute,
    // like the provider's default, so redirect responses keep their shape.
    ...(oauth
      ? { onAPIError: { errorURL: `${config.APP_ORIGIN}/connect/error` } }
      : {}),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: false,
      // Reset tokens are handed to the Orbit route that asked for them
      // (reset-capture.ts), which mails them or shows the link once.
      sendResetPassword: async ({ token }) => captureResetToken(token),
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
    },
    user: {
      additionalFields: {
        // Written only by PATCH /api/account, never by Better Auth input.
        locale: { type: "string", required: false, input: false },
      },
    },
    // Reset tokens are stored hashed; other flows keep their format.
    verification: {
      storeIdentifier: {
        default: "plain",
        overrides: { "reset-password:": "hashed" },
      },
    },
    session: {
      expiresIn: 8 * 3600,
      updateAge: 1800,
      cookieCache: { enabled: false },
    },
    advanced: {
      cookiePrefix: "orbit",
      useSecureCookies: config.APP_ORIGIN.startsWith("https:"),
      database: { generateId: () => randomUUID() },
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      // Only the header the API pins to the resolved client address on every
      // request (client-ip.ts), never X-Forwarded-For from the caller.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    rateLimit: { enabled: true, window: 60, max: 30 },
    // The client address is for rate limiting only. Sessions keep storing an
    // empty address, as they did while the proxy forwarded none.
    databaseHooks: {
      session: {
        create: { before: async () => ({ data: { ipAddress: "" } }) },
      },
    },
    logger: { disabled: true },
  });
}
export type Auth = ReturnType<typeof makeAuth>;
// A session renewed while checking a request must reach the browser too, or
// its cookie ends 8 hours after sign-in although the session slides.
const renewedCookies = new WeakMap<FastifyRequest, string[]>();
/** The caller's session and user; UNAUTHENTICATED (401) without a session. */
export async function sessionFor(auth: Auth, req: FastifyRequest) {
  const { headers, response: session } = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
    returnHeaders: true,
  });
  const cookies = headers?.getSetCookie() ?? [];
  if (cookies.length) renewedCookies.set(req, cookies);
  if (!session) throw new DomainError("UNAUTHENTICATED", 401);
  // A deactivated user's sessions are deleted; this also refuses any left.
  if ((session.user as { banned?: boolean | null }).banned)
    throw new DomainError("UNAUTHENTICATED", 401);
  return session;
}
export async function userFor(auth: Auth, req: FastifyRequest) {
  return (await sessionFor(auth, req)).user;
}
export function renewedSessionCookies(req: FastifyRequest) {
  return renewedCookies.get(req) ?? [];
}
/**
 * The caller's scope in a project: NOT_FOUND (404) without membership,
 * FORBIDDEN (403) when the project role lacks `required`.
 */
export async function scopeFor(
  auth: Auth,
  req: FastifyRequest,
  projectId: string,
  required: PermissionDef = PROJECT_READ,
): Promise<Scope> {
  const user = await userFor(auth, req);
  const membership = await projectMembership(projectId, user.id);
  if (!membership) throw new DomainError("NOT_FOUND", 404);
  const role = membership.role;
  if (!role) throw new DomainError("FORBIDDEN", 403);
  const scope: Scope = {
    workspaceId: membership.workspaceId,
    projectId,
    userId: user.id,
    role,
    ...(membership.moduleRoles ? { moduleRoles: membership.moduleRoles } : {}),
  };
  // A module's route runs with the member's role in that module (WP4.5).
  const effective = moduleScope(
    scope,
    (req as { orbitModule?: string }).orbitModule,
  );
  authorize(effective, required);
  return effective;
}
export { fromNodeHeaders };

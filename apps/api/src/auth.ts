import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";
import { authDb } from "../../../packages/db/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { DomainError } from "./shared.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { projectMembership } from "./modules/member-scope.ts";
export function makeAuth() {
  const config = loadConfig();
  return betterAuth({
    database: prismaAdapter(authDb, { provider: "postgresql" }),
    secret: config.AUTH_SECRET,
    baseURL: config.APP_ORIGIN,
    basePath: "/api/auth",
    trustedOrigins: [config.APP_ORIGIN],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: false,
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
    },
    rateLimit: { enabled: true, window: 60, max: 30 },
    logger: { disabled: true },
  });
}
export type Auth = ReturnType<typeof makeAuth>;
export async function userFor(auth: Auth, req: FastifyRequest) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  if (!session) throw new DomainError("UNAUTHENTICATED", 401);
  return session.user;
}
export async function scopeFor(
  auth: Auth,
  req: FastifyRequest,
  projectId: string,
  write = false,
  owner = false,
): Promise<Scope> {
  const user = await userFor(auth, req);
  const membership = await projectMembership(projectId, user.id);
  if (!membership) throw new DomainError("NOT_FOUND", 404);
  const role = membership.role;
  if (!role || (write && role === "viewer") || (owner && role !== "owner"))
    throw new DomainError("FORBIDDEN", 403);
  return {
    workspaceId: membership.workspaceId,
    projectId,
    userId: user.id,
    role,
  };
}
export { fromNodeHeaders };

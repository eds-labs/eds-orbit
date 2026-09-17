import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";
import { authDb } from "../../../packages/db/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { DomainError } from "./shared.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
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
  const project = await authDb.project.findFirst({
    where: {
      id: projectId,
      OR: [
        {
          workspace: { members: { some: { userId: user.id, role: "owner" } } },
        },
        { members: { some: { userId: user.id } } },
      ],
    },
    include: {
      members: { where: { userId: user.id } },
      workspace: { include: { members: { where: { userId: user.id } } } },
    },
  });
  if (!project) throw new DomainError("NOT_FOUND", 404);
  const role = project.workspace.members.find((x) => x.role === "owner")
    ? "owner"
    : (project.members[0]?.role as Scope["role"]);
  if (!role || (write && role === "viewer") || (owner && role !== "owner"))
    throw new DomainError("FORBIDDEN", 403);
  return {
    workspaceId: project.workspaceId,
    projectId,
    userId: user.id,
    role: role as Scope["role"],
  };
}
export { fromNodeHeaders };

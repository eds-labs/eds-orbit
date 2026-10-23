import type { FastifyRequest } from "fastify";
import { authDb } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { DomainError } from "../shared.ts";
import { scopeFor, sessionFor, type Auth } from "../tenancy/auth.ts";
import { PROJECT_OWN } from "../tenancy/permissions.ts";
import type { Actor } from "./memberships.ts";

// Who may administer what (ADR 0013), read from the database on every
// request. A caller who may not use an administration route gets the same
// 404 as when the feature is off, so the routes reveal nothing.

export const administrationEnabled = () =>
  loadConfig().ORBIT_ADMINISTRATION === "true";
export const accountEnabled = () => loadConfig().ORBIT_ACCOUNT === "true";

/** Whether a user is an active system administrator. */
export async function isSystemAdmin(userId: string) {
  return Boolean(
    await authDb.user.findFirst({
      where: { id: userId, role: "admin", banned: false },
      select: { id: true },
    }),
  );
}

/** The calling system administrator; 401 without a session, else 404. */
export async function systemAdminFor(auth: Auth, req: FastifyRequest) {
  const session = await sessionFor(auth, req);
  if (!(await isSystemAdmin(session.user.id)))
    throw new DomainError("NOT_FOUND", 404);
  return { userId: session.user.id, sessionId: session.session.id };
}

/** A system administrator or an owner of the organization; else 404. */
export async function organizationManagerFor(
  auth: Auth,
  req: FastifyRequest,
  workspaceId: string,
): Promise<Actor> {
  const session = await sessionFor(auth, req);
  const userId = session.user.id;
  if (await isSystemAdmin(userId)) return { userId, kind: "admin" };
  const owner = await authDb.workspaceMember.findFirst({
    where: { workspaceId, userId, role: "owner" },
  });
  if (!owner) throw new DomainError("NOT_FOUND", 404);
  return { userId, kind: "org_owner" };
}

/** A project owner (or the organization's owner) of `projectId`. */
export async function projectManagerFor(
  auth: Auth,
  req: FastifyRequest,
  projectId: string,
) {
  const scope = await scopeFor(auth, req, projectId, PROJECT_OWN);
  const ownsWorkspace = await authDb.workspaceMember.findFirst({
    where: { workspaceId: scope.workspaceId, userId: scope.userId, role: "owner" },
  });
  const actor: Actor = {
    userId: scope.userId,
    kind: ownsWorkspace ? "org_owner" : "project_owner",
  };
  return { scope, actor };
}

/**
 * An active owner of the organization, for what only owners manage (their
 * organization's own connections, ADR 0014 E3); administrators are not
 * owners here. 404 otherwise.
 */
export async function workspaceOwnerFor(
  auth: Auth,
  req: FastifyRequest,
  workspaceId: string,
) {
  const session = await sessionFor(auth, req);
  const owner = await authDb.workspaceMember.findFirst({
    where: { workspaceId, userId: session.user.id, role: "owner" },
  });
  if (!owner) throw new DomainError("NOT_FOUND", 404);
  return { userId: session.user.id, workspaceId };
}

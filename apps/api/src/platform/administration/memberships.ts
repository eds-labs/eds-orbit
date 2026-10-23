import { z } from "zod";
import {
  authDb,
  type DbTx,
} from "../../../../../packages/db/src/index.ts";
import { DomainError } from "../shared.ts";
import { revokeUserGrants } from "../mcp-auth/grants.ts";
import { moduleRole, writeModuleRoles } from "../tenancy/module-roles.ts";
import { systemAudit } from "./audit.ts";

// Organization and project memberships across the installation (ADR 0013).
// One service for the system administration, the organization settings and
// project owners; the routes authorize the actor first. Every change runs
// in one control-plane transaction holding the organization's lock, so the
// last-owner guard cannot race, and is effective on the next request: no
// role is cached anywhere (member-scope.ts reads them per check).

/** Who acts: a system administrator, the organization's owner or a project owner. */
export type Actor = {
  userId: string;
  kind: "admin" | "org_owner" | "project_owner";
};

export const workspaceRoleInput = z
  .object({ role: z.enum(["owner", "member"]) })
  .strict();

export const projectMemberInput = z
  .object({
    role: z.enum(["owner", "editor", "viewer"]),
    moduleRoles: z.record(z.string(), moduleRole.nullable()).optional(),
  })
  .strict();

/** The stored workspace role for an organization role. */
export const storedWorkspaceRole = (role: "owner" | "member") =>
  role === "owner" ? "owner" : "viewer";

/** Serializes membership changes of one organization. */
export async function lockWorkspace(tx: DbTx, workspaceId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"orbit:workspace:" + workspaceId}, 0))`;
}

/** LAST_OWNER (409) when `userId` is the organization's last active owner. */
export async function assertOtherOwner(
  tx: DbTx,
  workspaceId: string,
  userId: string,
) {
  const others = await tx.workspaceMember.count({
    where: {
      workspaceId,
      role: "owner",
      userId: { not: userId },
      user: { banned: false },
    },
  });
  if (!others) throw new DomainError("LAST_OWNER", 409);
}

async function membership(tx: DbTx, workspaceId: string, userId: string) {
  const row = await tx.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!row) throw new DomainError("MEMBER_NOT_FOUND", 404);
  return row;
}

/** Changes a member's organization role (owner or member). */
export async function setWorkspaceRole(
  actor: Actor,
  workspaceId: string,
  userId: string,
  raw: unknown,
) {
  if (actor.kind === "project_owner")
    throw new DomainError("WORKSPACE_OWNER_REQUIRED", 403);
  const { role } = workspaceRoleInput.parse(raw);
  const stored = storedWorkspaceRole(role);
  return authDb.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const current = await membership(tx, workspaceId, userId);
    const from = current.role === "owner" ? "owner" : "member";
    if (from === role) return { userId, role };
    if (from === "owner") await assertOtherOwner(tx, workspaceId, userId);
    await tx.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId } },
      data: { role: stored },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "workspace_member.role_changed",
        targetType: "user",
        targetId: userId,
        workspaceId,
        metadata: { from, to: role, by: actor.kind },
      },
      tx,
    );
    return { userId, role };
  });
}

/**
 * Removes a user from an organization with all their project memberships
 * there (foreign-key cascade) and ends their MCP grants for it.
 */
export async function removeWorkspaceMember(
  actor: Actor,
  workspaceId: string,
  userId: string,
) {
  if (actor.kind === "project_owner")
    throw new DomainError("WORKSPACE_OWNER_REQUIRED", 403);
  await authDb.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const current = await membership(tx, workspaceId, userId);
    if (current.role === "owner")
      await assertOtherOwner(tx, workspaceId, userId);
    const projects = await tx.projectMember.count({
      where: { workspaceId, userId },
    });
    await tx.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "workspace_member.removed",
        targetType: "user",
        targetId: userId,
        workspaceId,
        metadata: { role: current.role, projects, by: actor.kind },
      },
      tx,
    );
  });
  await revokeUserGrants({ userId, actorId: actor.userId, workspaceId });
  return { removed: true };
}

async function projectInWorkspace(
  tx: DbTx,
  workspaceId: string,
  projectId: string,
) {
  const project = await tx.project.findFirst({
    where: { id: projectId, workspaceId },
    select: { id: true },
  });
  if (!project) throw new DomainError("NOT_FOUND", 404);
}

/**
 * Applies a project role (and optional module roles) inside `tx`. A user
 * outside the organization joins it as a member. Granting "owner" needs a
 * system administrator or the organization's owner; module overrides are
 * refused for project owners, as in the project settings.
 */
export async function applyProjectMembership(
  tx: DbTx,
  actor: Actor,
  target: { workspaceId: string; projectId: string; userId: string },
  input: z.infer<typeof projectMemberInput>,
) {
  const { workspaceId, projectId, userId } = target;
  const previous = await tx.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  if (
    actor.kind === "project_owner" &&
    (input.role === "owner" || previous?.role === "owner")
  )
    throw new DomainError("WORKSPACE_OWNER_REQUIRED", 403);
  const moduleRoles = input.moduleRoles ?? {};
  if (input.role === "owner" && Object.keys(moduleRoles).length)
    throw new DomainError("OWNER_HAS_NO_MODULE_ROLES", 409);
  await tx.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId, userId } },
    create: { workspaceId, userId, role: "viewer" },
    update: {},
  });
  await tx.projectMember.upsert({
    where: { projectId_userId: { projectId, userId } },
    create: { workspaceId, projectId, userId, role: input.role },
    update: { role: input.role },
  });
  // An owner keeps their role in every module.
  if (input.role === "owner")
    await tx.projectMemberModuleRole.deleteMany({
      where: { projectId, userId },
    });
  else await writeModuleRoles(tx, target, moduleRoles, actor.userId);
  return previous?.role ?? null;
}

/** Sets a user's role (and module roles) in one project of an organization. */
export async function setProjectMember(
  actor: Actor,
  target: { workspaceId: string; projectId: string; userId: string },
  raw: unknown,
) {
  const input = projectMemberInput.parse(raw);
  return authDb.$transaction(async (tx) => {
    await lockWorkspace(tx, target.workspaceId);
    await projectInWorkspace(tx, target.workspaceId, target.projectId);
    const user = await tx.user.findUnique({
      where: { id: target.userId },
      select: { banned: true },
    });
    if (!user) throw new DomainError("USER_NOT_FOUND", 404);
    if (user.banned) throw new DomainError("USER_DEACTIVATED", 409);
    const previousRole = await applyProjectMembership(tx, actor, target, input);
    await systemAudit(
      {
        actorId: actor.userId,
        action: "project_member.set",
        targetType: "user",
        targetId: target.userId,
        workspaceId: target.workspaceId,
        projectId: target.projectId,
        metadata: {
          role: input.role,
          previousRole,
          modules: Object.keys(input.moduleRoles ?? {}),
          by: actor.kind,
        },
      },
      tx,
    );
    return { userId: target.userId, role: input.role };
  });
}

/** Removes a user's membership (and module roles) in one project. */
export async function removeProjectMember(
  actor: Actor,
  target: { workspaceId: string; projectId: string; userId: string },
) {
  return authDb.$transaction(async (tx) => {
    await lockWorkspace(tx, target.workspaceId);
    await projectInWorkspace(tx, target.workspaceId, target.projectId);
    const current = await tx.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId: target.projectId,
          userId: target.userId,
        },
      },
    });
    if (!current) throw new DomainError("MEMBER_NOT_FOUND", 404);
    if (actor.kind === "project_owner" && current.role === "owner")
      throw new DomainError("WORKSPACE_OWNER_REQUIRED", 403);
    await tx.projectMember.delete({
      where: {
        projectId_userId: {
          projectId: target.projectId,
          userId: target.userId,
        },
      },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "project_member.removed",
        targetType: "user",
        targetId: target.userId,
        workspaceId: target.workspaceId,
        projectId: target.projectId,
        metadata: { role: current.role, by: actor.kind },
      },
      tx,
    );
    return { removed: true };
  });
}

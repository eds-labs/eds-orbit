import { z } from "zod";
import {
  authDb,
  type DbTx,
} from "../../../../../packages/db/src/index.ts";
import { DomainError } from "../shared.ts";
import { revokeUserGrants } from "../mcp-auth/grants.ts";
import { systemAudit } from "./audit.ts";

// User lifecycle for system administrators (ADR 0013): deactivation,
// reactivation, session revocation and the administrator role. The ban
// fields are the Better Auth admin plugin's, so sign-in and new sessions
// refuse a deactivated user; the membership check refuses them as well.

const ADMIN_LOCK = 0x0a5d_0012;

/** Serializes changes that can remove an administrator. */
async function lockAdmins(tx: DbTx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_LOCK})`;
}

/** LAST_ADMIN (409) when `userId` is the last active administrator. */
async function assertOtherAdmin(tx: DbTx, userId: string) {
  const others = await tx.user.count({
    where: { role: "admin", banned: false, id: { not: userId } },
  });
  if (!others) throw new DomainError("LAST_ADMIN", 409);
}

async function target(tx: DbTx, userId: string) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, banned: true },
  });
  if (!user) throw new DomainError("USER_NOT_FOUND", 404);
  return user;
}

/** LAST_OWNER (409) when the user is an organization's last active owner. */
async function assertNoSoleOwnership(tx: DbTx, userId: string) {
  const owned = await tx.workspaceMember.findMany({
    where: { userId, role: "owner" },
    select: { workspaceId: true },
  });
  for (const { workspaceId } of owned) {
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
}

export const deactivateInput = z
  .object({ reason: z.enum(["left", "security", "other"]).optional() })
  .strict();

/**
 * Deactivates a user: banned (no sign-in, no session), sessions deleted,
 * open invitations they sent revoked and MCP grants ended. An administrator
 * cannot deactivate themselves, the last administrator or the last owner of
 * an organization.
 */
export async function deactivateUser(
  actorId: string,
  userId: string,
  raw: unknown,
) {
  const { reason } = deactivateInput.parse(raw ?? {});
  if (userId === actorId) throw new DomainError("CANNOT_DEACTIVATE_SELF", 409);
  const sessions = await authDb.$transaction(async (tx) => {
    await lockAdmins(tx);
    const user = await target(tx, userId);
    if (user.banned) return null;
    if (user.role === "admin") await assertOtherAdmin(tx, userId);
    await assertNoSoleOwnership(tx, userId);
    await tx.user.update({
      where: { id: userId },
      data: { banned: true, banReason: reason ?? "other", banExpires: null },
    });
    const { count } = await tx.session.deleteMany({ where: { userId } });
    await tx.invitation.updateMany({
      where: { invitedBy: userId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await systemAudit(
      {
        actorId,
        action: "user.deactivated",
        targetType: "user",
        targetId: userId,
        metadata: { reason: reason ?? "other", sessions: count },
      },
      tx,
    );
    return count;
  });
  if (sessions === null) return { deactivated: true, changed: false };
  const grants = await revokeUserGrants({ userId, actorId });
  return { deactivated: true, changed: true, sessions, grants };
}

/** Reactivates a user; they sign in again (no session is restored). */
export async function reactivateUser(actorId: string, userId: string) {
  return authDb.$transaction(async (tx) => {
    const user = await target(tx, userId);
    if (!user.banned) return { reactivated: true, changed: false };
    await tx.user.update({
      where: { id: userId },
      data: { banned: false, banReason: null, banExpires: null },
    });
    await systemAudit(
      {
        actorId,
        action: "user.reactivated",
        targetType: "user",
        targetId: userId,
      },
      tx,
    );
    return { reactivated: true, changed: true };
  });
}

/** Signs a user out everywhere. */
export async function revokeUserSessions(actorId: string, userId: string) {
  return authDb.$transaction(async (tx) => {
    await target(tx, userId);
    const { count } = await tx.session.deleteMany({ where: { userId } });
    await systemAudit(
      {
        actorId,
        action: "user.sessions_revoked",
        targetType: "user",
        targetId: userId,
        metadata: { sessions: count },
      },
      tx,
    );
    return { revoked: count };
  });
}

export const systemRoleInput = z
  .object({
    role: z.enum(["user", "admin"]),
    // The acting administrator's password (step-up); checked by the route.
    password: z.string().min(1).max(128),
  })
  .strict();

/**
 * Grants or removes the system administrator role. Nobody removes their
 * own role, and the last active administrator keeps theirs.
 */
export async function setSystemRole(
  actorId: string,
  userId: string,
  role: "user" | "admin",
) {
  return authDb.$transaction(async (tx) => {
    await lockAdmins(tx);
    const user = await target(tx, userId);
    if (user.role === role) return { userId, role, changed: false };
    if (role === "admin" && user.banned)
      throw new DomainError("USER_DEACTIVATED", 409);
    if (role === "user") {
      if (userId === actorId) throw new DomainError("CANNOT_DEMOTE_SELF", 409);
      await assertOtherAdmin(tx, userId);
    }
    await tx.user.update({ where: { id: userId }, data: { role } });
    await systemAudit(
      {
        actorId,
        action: role === "admin" ? "system_admin.granted" : "system_admin.revoked",
        targetType: "user",
        targetId: userId,
      },
      tx,
    );
    return { userId, role, changed: true };
  });
}

/**
 * Grants or revokes the administrator role from the command line
 * (`scripts/system-admin.ts`), the recovery path for an installation
 * without an active administrator. Audited as `system:cli`.
 */
export async function setSystemRoleByEmail(
  email: string,
  role: "user" | "admin",
) {
  const user = await authDb.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { id: true },
  });
  if (!user) throw new DomainError("USER_NOT_FOUND", 404);
  return authDb.$transaction(async (tx) => {
    await lockAdmins(tx);
    const current = await target(tx, user.id);
    if (current.role === role) return { userId: user.id, role, changed: false };
    if (role === "admin" && current.banned)
      throw new DomainError("USER_DEACTIVATED", 409);
    if (role === "user") await assertOtherAdmin(tx, user.id);
    await tx.user.update({ where: { id: user.id }, data: { role } });
    await systemAudit(
      {
        actorId: "system:cli",
        action: role === "admin" ? "system_admin.granted" : "system_admin.revoked",
        targetType: "user",
        targetId: user.id,
      },
      tx,
    );
    return { userId: user.id, role, changed: true };
  });
}

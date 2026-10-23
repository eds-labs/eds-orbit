import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  authDb,
  type DbTx,
} from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { DomainError } from "../shared.ts";
import { moduleRole } from "../tenancy/module-roles.ts";
import {
  sendSystemMail,
  systemMailTexts,
} from "../email/system-mail.ts";
import { systemAudit } from "./audit.ts";
import {
  applyProjectMembership,
  lockWorkspace,
  storedWorkspaceRole,
  type Actor,
} from "./memberships.ts";

// Invitations (ADR 0013) replace owner-chosen passwords: the invited person
// receives a single-use link valid for seven days and sets their own
// password. Only the sha256 of the 32-byte token is stored; the token is in
// the link's fragment, so it reaches neither server logs nor referrers.
// Without system mail the inviter receives the link once instead. Grants
// are checked again on acceptance: the inviter must still be allowed to
// give them and every project must still belong to the organization.

const VALID_DAYS = 7;

export const invitationInput = z
  .object({
    email: z.email().max(254),
    role: z.enum(["owner", "member"]).default("member"),
    projects: z
      .array(
        z
          .object({
            projectId: z.uuid(),
            role: z.enum(["owner", "editor", "viewer"]),
            moduleRoles: z
              .record(z.string(), moduleRole.nullable())
              .optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    locale: z.enum(["en", "de"]).optional(),
  })
  .strict();
export type InvitationInput = z.infer<typeof invitationInput>;

const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const expiry = () => new Date(Date.now() + VALID_DAYS * 24 * 3600 * 1000);
const linkOf = (token: string) =>
  `${new URL(loadConfig().APP_ORIGIN).origin}/invite#${token}`;

/** What a project owner (not organization owner) may grant. */
function assertWithinActor(
  actor: Actor,
  input: Pick<InvitationInput, "role" | "projects">,
  projectId?: string,
) {
  if (actor.kind !== "project_owner") return;
  if (
    input.role !== "member" ||
    input.projects.length !== 1 ||
    input.projects[0]!.projectId !== projectId ||
    input.projects[0]!.role === "owner"
  )
    throw new DomainError("WORKSPACE_OWNER_REQUIRED", 403);
}

async function assertProjects(
  tx: DbTx,
  workspaceId: string,
  projects: InvitationInput["projects"],
) {
  const ids = [...new Set(projects.map((p) => p.projectId))];
  if (ids.length !== projects.length)
    throw new DomainError("DUPLICATE_PROJECT", 400);
  const found = await tx.project.count({
    where: { workspaceId, id: { in: ids } },
  });
  if (found !== ids.length) throw new DomainError("NOT_FOUND", 404);
  for (const p of projects)
    if (p.role === "owner" && Object.keys(p.moduleRoles ?? {}).length)
      throw new DomainError("OWNER_HAS_NO_MODULE_ROLES", 409);
}

/** Mails an invitation link, or returns it when no system mail went out. */
async function deliver(
  token: string,
  invitation: { email: string; expiresAt: Date; locale: string | null },
  organization: string,
) {
  const link = linkOf(token);
  const mail = systemMailTexts.invitation(
    invitation.locale === "de" ? "de" : "en",
    { organization, link, expiresAt: invitation.expiresAt },
  );
  const result = await sendSystemMail({ to: invitation.email, ...mail });
  return result.status === "sent"
    ? { delivery: "email" as const }
    : {
        delivery: "link" as const,
        link,
        ...(result.status === "failed" ? { mailError: result.code } : {}),
      };
}

/**
 * Invites someone to an organization (and projects in it). An existing
 * active account is added directly instead; a deactivated one is refused.
 * `projectId` limits a project owner to their own project.
 */
export async function createInvitation(
  actor: Actor,
  workspaceId: string,
  raw: unknown,
  projectId?: string,
) {
  const input = invitationInput.parse(raw);
  assertWithinActor(actor, input, projectId);
  const email = input.email.trim().toLowerCase();
  const token = newToken();
  const outcome = await authDb.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const workspace = await tx.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true },
    });
    if (!workspace) throw new DomainError("NOT_FOUND", 404);
    await assertProjects(tx, workspaceId, input.projects);
    const existing = await tx.user.findUnique({
      where: { email },
      select: { id: true, banned: true },
    });
    if (existing?.banned) throw new DomainError("USER_DEACTIVATED", 409);
    // Someone outside the organization accepts first (an administrator
    // adds directly): no one joins an organization without consent, and the
    // answer does not reveal accounts elsewhere in the installation.
    const inWorkspace =
      existing &&
      (actor.kind === "admin" ||
        (await tx.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId, userId: existing.id } },
        })));
    if (existing && inWorkspace) {
      await grant(tx, actor, workspaceId, existing.id, input);
      await systemAudit(
        {
          actorId: actor.userId,
          action: "workspace_member.added",
          targetType: "user",
          targetId: existing.id,
          workspaceId,
          metadata: {
            role: input.role,
            projects: input.projects.map((p) => p.projectId),
            by: actor.kind,
          },
        },
        tx,
      );
      return { status: "added" as const, userId: existing.id };
    }
    // A newer invitation replaces an open one for the same address.
    await tx.invitation.updateMany({
      where: { workspaceId, email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const invitation = await tx.invitation.create({
      data: {
        tokenHash: hash(token),
        email,
        workspaceId,
        workspaceRole: storedWorkspaceRole(input.role),
        invitedBy: actor.userId,
        locale: input.locale ?? null,
        expiresAt: expiry(),
        projects: {
          create: input.projects.map((p) => ({
            workspaceId,
            projectId: p.projectId,
            role: p.role,
            moduleRoles: p.moduleRoles ?? {},
          })),
        },
      },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "invitation.created",
        targetType: "invitation",
        targetId: invitation.id,
        workspaceId,
        metadata: {
          role: input.role,
          projects: input.projects.map((p) => p.projectId),
          by: actor.kind,
        },
      },
      tx,
    );
    return {
      status: "invited" as const,
      invitation,
      organization: workspace.name,
    };
  });
  if (outcome.status === "added") return outcome;
  return {
    status: outcome.status,
    invitationId: outcome.invitation.id,
    expiresAt: outcome.invitation.expiresAt,
    ...(await deliver(token, outcome.invitation, outcome.organization)),
  };
}

async function grant(
  tx: DbTx,
  actor: Actor,
  workspaceId: string,
  userId: string,
  input: Pick<InvitationInput, "role" | "projects">,
) {
  const current = await tx.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  // An invitation never demotes an owner.
  if (!current || (input.role === "owner" && current.role !== "owner"))
    await tx.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { workspaceId, userId, role: storedWorkspaceRole(input.role) },
      update: { role: storedWorkspaceRole(input.role) },
    });
  for (const p of input.projects)
    await applyProjectMembership(
      tx,
      actor,
      { workspaceId, projectId: p.projectId, userId },
      { role: p.role, moduleRoles: p.moduleRoles },
    );
}

async function openInvitation(tx: DbTx, invitationId: string) {
  const invitation = await tx.invitation.findFirst({
    where: {
      id: z.uuid().parse(invitationId),
      acceptedAt: null,
      revokedAt: null,
    },
    include: { projects: true, workspace: { select: { name: true } } },
  });
  if (!invitation) throw new DomainError("NOT_FOUND", 404);
  return invitation;
}

/**
 * A project owner manages only invitations to their project that they could
 * have created themselves; organization owners and administrators manage all
 * invitations of the organization.
 */
function assertManageable(
  actor: Actor,
  invitation: Awaited<ReturnType<typeof openInvitation>>,
  workspaceId: string,
  projectId?: string,
) {
  if (invitation.workspaceId !== workspaceId)
    throw new DomainError("NOT_FOUND", 404);
  if (actor.kind === "project_owner")
    assertWithinActor(
      actor,
      {
        role: invitation.workspaceRole === "owner" ? "owner" : "member",
        projects: invitation.projects.map((p) => ({
          projectId: p.projectId,
          role: p.role as "owner" | "editor" | "viewer",
        })),
      },
      projectId,
    );
}

/** Issues a new link (the old one stops working) and a new expiry. */
export async function resendInvitation(
  actor: Actor,
  workspaceId: string,
  invitationId: string,
  projectId?: string,
) {
  const token = newToken();
  const invitation = await authDb.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const current = await openInvitation(tx, invitationId);
    assertManageable(actor, current, workspaceId, projectId);
    const updated = await tx.invitation.update({
      where: { id: current.id },
      data: { tokenHash: hash(token), expiresAt: expiry() },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "invitation.resent",
        targetType: "invitation",
        targetId: current.id,
        workspaceId,
        metadata: { by: actor.kind },
      },
      tx,
    );
    return { ...updated, organization: current.workspace.name };
  });
  return {
    invitationId: invitation.id,
    expiresAt: invitation.expiresAt,
    ...(await deliver(token, invitation, invitation.organization)),
  };
}

export async function revokeInvitation(
  actor: Actor,
  workspaceId: string,
  invitationId: string,
  projectId?: string,
) {
  await authDb.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const current = await openInvitation(tx, invitationId);
    assertManageable(actor, current, workspaceId, projectId);
    await tx.invitation.update({
      where: { id: current.id },
      data: { revokedAt: new Date() },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "invitation.revoked",
        targetType: "invitation",
        targetId: current.id,
        workspaceId,
        metadata: { by: actor.kind },
      },
      tx,
    );
  });
  return { revoked: true };
}

const tokenInput = z.string().min(20).max(200);

async function usable(tx: DbTx, token: string) {
  const invitation = await tx.invitation.findUnique({
    where: { tokenHash: hash(tokenInput.parse(token)) },
    include: {
      projects: { include: { project: { select: { name: true } } } },
      workspace: { select: { name: true } },
    },
  });
  // Unknown, used, revoked and expired look the same.
  if (
    !invitation ||
    invitation.acceptedAt ||
    invitation.revokedAt ||
    invitation.expiresAt <= new Date()
  )
    throw new DomainError("INVITATION_NOT_FOUND", 404);
  return invitation;
}

/** What the holder of a link sees before accepting. */
export async function viewInvitation(token: string) {
  const invitation = await usable(authDb as unknown as DbTx, token);
  const account = await authDb.user.findUnique({
    where: { email: invitation.email },
    select: { id: true },
  });
  return {
    email: invitation.email,
    organization: invitation.workspace.name,
    role: invitation.workspaceRole === "owner" ? "owner" : "member",
    projects: invitation.projects.map((p) => ({
      name: p.project.name,
      role: p.role,
    })),
    expiresAt: invitation.expiresAt,
    existingAccount: Boolean(account),
    locale: invitation.locale,
  };
}

/**
 * Whether the inviter may still give these grants: an active administrator,
 * an active owner of the organization, or (member grants only) an active
 * explicit owner of every granted project.
 */
async function inviterStillAllowed(
  tx: DbTx,
  invitation: Awaited<ReturnType<typeof usable>>,
) {
  const inviter = await tx.user.findUnique({
    where: { id: invitation.invitedBy },
    select: { role: true, banned: true },
  });
  if (!inviter || inviter.banned) return false;
  if (inviter.role === "admin") return true;
  const owner = await tx.workspaceMember.findFirst({
    where: {
      workspaceId: invitation.workspaceId,
      userId: invitation.invitedBy,
      role: "owner",
    },
  });
  if (owner) return true;
  if (
    invitation.workspaceRole === "owner" ||
    !invitation.projects.length ||
    invitation.projects.some((p) => p.role === "owner")
  )
    return false;
  const owned = await tx.projectMember.count({
    where: {
      userId: invitation.invitedBy,
      role: "owner",
      projectId: { in: invitation.projects.map((p) => p.projectId) },
    },
  });
  return owned === invitation.projects.length;
}

/**
 * Accepts an invitation for `userId` (a new account just created for the
 * invited address, or the signed-in user whose address matches): consumes
 * the token and applies the grants in one transaction.
 */
export async function acceptInvitation(token: string, userId: string) {
  return authDb.$transaction(async (tx) => {
    const found = await usable(tx, token);
    await lockWorkspace(tx, found.workspaceId);
    const invitation = await usable(tx, token);
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { email: true, banned: true },
    });
    if (!user || user.banned) throw new DomainError("USER_DEACTIVATED", 409);
    if (user.email.toLowerCase() !== invitation.email)
      throw new DomainError("INVITATION_EMAIL_MISMATCH", 403);
    if (!(await inviterStillAllowed(tx, invitation)))
      throw new DomainError("INVITATION_NO_LONGER_VALID", 409);
    const consumed = await tx.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date(), acceptedUserId: userId },
    });
    if (!consumed.count) throw new DomainError("INVITATION_NOT_FOUND", 404);
    // The grants were checked against the inviter; they apply as such.
    const actor: Actor = { userId: invitation.invitedBy, kind: "admin" };
    await grant(tx, actor, invitation.workspaceId, userId, {
      role: invitation.workspaceRole === "owner" ? "owner" : "member",
      projects: invitation.projects.map((p) => ({
        projectId: p.projectId,
        role: p.role as "owner" | "editor" | "viewer",
        moduleRoles: p.moduleRoles as Record<
          string,
          "editor" | "viewer" | "none" | null
        >,
      })),
    });
    // Receiving the link proves the address.
    await tx.user.update({
      where: { id: userId },
      data: { emailVerified: true },
    });
    await systemAudit(
      {
        actorId: userId,
        action: "invitation.accepted",
        targetType: "invitation",
        targetId: invitation.id,
        workspaceId: invitation.workspaceId,
        metadata: { invitedBy: invitation.invitedBy },
      },
      tx,
    );
    return { workspaceId: invitation.workspaceId };
  });
}

/** The invited address of a usable link (for creating the account). */
export async function invitationEmail(token: string) {
  return (await usable(authDb as unknown as DbTx, token)).email;
}

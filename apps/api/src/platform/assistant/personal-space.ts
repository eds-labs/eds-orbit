import { authDb, scoped } from "../../../../../packages/db/src/index.ts";
import type { ValidatedRegistry } from "../../../../../packages/module-contracts/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { entitled, entitlementsFor } from "../entitlements/entitlements.ts";
import type { PeriodicTask } from "../jobs/types.ts";
import { audit, DomainError } from "../shared.ts";

// The personal space (ADR 0022 D-08): one project of kind `personal` per
// user and organization, holding the personal assistant's conversations,
// jobs, budget projection and personal context. Its only member is its user;
// organization owners and system administrators get no implicit access
// (`accessibleProjectsWhere`). It is created on first assistant use and
// deleted 30 days after the user left the organization, or with the user.

export const PERSONAL_SPACE_NAME = "Personal space";
/** How long a personal space outlives its user's organization membership. */
export const PERSONAL_SPACE_GRACE_DAYS = 30;
const DAY = 86_400_000;

export const personalAssistantEnabled = () =>
  process.env.ORBIT_PERSONAL_ASSISTANT === "true";

/**
 * Why the user may not use the personal assistant in this organization, or
 * null: the flag, an active account and membership, the organization's
 * entitlement and the owner's per-member switch.
 */
export async function personalAssistantRefusal(
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  if (!personalAssistantEnabled()) return "ASSISTANT_DISABLED";
  const member = await authDb.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { assistantEnabled: true, user: { select: { banned: true } } },
  });
  if (!member || member.user.banned) return "WORKSPACE_FORBIDDEN";
  if (!entitled(await entitlementsFor(workspaceId), "assistantPersonal"))
    return "ASSISTANT_ENTITLEMENT";
  if (!member.assistantEnabled) return "ASSISTANT_DISABLED_FOR_MEMBER";
  return null;
}

/** The user's personal space in the organization, without creating it. */
export async function findPersonalSpace(workspaceId: string, userId: string) {
  return authDb.project.findFirst({
    where: { workspaceId, kind: "personal", personalUserId: userId },
    select: { id: true, workspaceId: true, personalLeftAt: true, paused: true },
  });
}

/**
 * The user's personal space, created on first use; idempotent under
 * parallel calls (the partial unique index decides). A space kept after the
 * user left and rejoined gets its membership back. Every business module is
 * recorded as off, so registry defaults never activate one there.
 */
export async function ensurePersonalSpace(
  workspaceId: string,
  userId: string,
  registry: ValidatedRegistry,
): Promise<{ projectId: string; workspaceId: string; created: boolean }> {
  const refusal = await personalAssistantRefusal(workspaceId, userId);
  if (refusal)
    throw new DomainError(refusal, refusal === "WORKSPACE_FORBIDDEN" ? 404 : 403);
  const existing = await findPersonalSpace(workspaceId, userId);
  if (existing) {
    await restoreMembership(existing.id, workspaceId, userId);
    return { projectId: existing.id, workspaceId, created: false };
  }
  let projectId: string;
  try {
    const project = await authDb.project.create({
      data: {
        workspaceId,
        name: PERSONAL_SPACE_NAME,
        kind: "personal",
        personalUserId: userId,
        members: { create: { userId, role: "owner" } },
      },
      select: { id: true },
    });
    projectId = project.id;
  } catch (error) {
    // A parallel first use created it; the unique index kept one row.
    if ((error as { code?: string }).code !== "P2002") throw error;
    const raced = await findPersonalSpace(workspaceId, userId);
    if (!raced) throw error;
    await restoreMembership(raced.id, workspaceId, userId);
    return { projectId: raced.id, workspaceId, created: false };
  }
  const scope: Scope = { workspaceId, projectId, userId, role: "owner" };
  await scoped(workspaceId, projectId, async (tx) => {
    await tx.projectModule.createMany({
      data: registry.modules.map((m) => ({
        workspaceId,
        projectId,
        moduleId: m.id,
        enabled: false,
        moduleVersion: m.version,
        changedBy: userId,
      })),
      skipDuplicates: true,
    });
    await audit(tx, scope, "personal_space.created", projectId, {});
  });
  return { projectId, workspaceId, created: true };
}

async function restoreMembership(
  projectId: string,
  workspaceId: string,
  userId: string,
) {
  await authDb.$transaction(async (tx) => {
    await tx.projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      create: { workspaceId, projectId, userId, role: "owner" },
      update: { role: "owner" },
    });
    await tx.project.updateMany({
      where: { id: projectId, personalLeftAt: { not: null } },
      data: { personalLeftAt: null },
    });
  });
}

/**
 * Marks the user's personal space in the organization for deletion after
 * the grace period; called when the user leaves the organization. The
 * project membership is already gone with the workspace membership.
 */
export async function markPersonalSpaceLeft(
  workspaceId: string,
  userId: string,
  now = new Date(),
) {
  await authDb.project.updateMany({
    where: {
      workspaceId,
      kind: "personal",
      personalUserId: userId,
      personalLeftAt: null,
    },
    data: { personalLeftAt: now },
  });
}

/** Whether a personal space's grace period after its user left is over. */
export function personalSpaceExpired(
  space: { personalLeftAt: Date | null },
  now = new Date(),
) {
  return Boolean(
    space.personalLeftAt &&
      now.getTime() - space.personalLeftAt.getTime() >=
        PERSONAL_SPACE_GRACE_DAYS * DAY,
  );
}

/**
 * The daily clean-up (ADR 0022): a personal space whose user is no member
 * of the organization any more is marked; 30 days after that it is
 * deleted with everything in it (foreign-key cascade). A user who rejoined
 * in time keeps it. Runs for personal spaces only.
 */
export const personalSpaceCleanup: PeriodicTask = {
  name: "personal-space-cleanup",
  async nextDueAt(tx, scope) {
    const project = await tx.project.findFirst({
      where: { id: scope.projectId, kind: "personal" },
      select: { personalLeftAt: true },
    });
    if (!project) return null;
    return project.personalLeftAt
      ? new Date(
          project.personalLeftAt.getTime() + PERSONAL_SPACE_GRACE_DAYS * DAY,
        )
      : new Date(Date.now() + DAY);
  },
  async run(scope) {
    const now = new Date();
    const space = await authDb.project.findFirst({
      where: { id: scope.projectId, kind: "personal" },
      select: { id: true, workspaceId: true, personalUserId: true, personalLeftAt: true },
    });
    if (!space?.personalUserId) return;
    const member = await authDb.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: space.workspaceId,
          userId: space.personalUserId,
        },
      },
      select: { userId: true },
    });
    if (member) {
      if (space.personalLeftAt)
        await authDb.project.update({
          where: { id: space.id },
          data: { personalLeftAt: null },
        });
      return { status: "kept" };
    }
    if (!space.personalLeftAt) {
      await markPersonalSpaceLeft(space.workspaceId, space.personalUserId, now);
      return { status: "marked" };
    }
    if (!personalSpaceExpired(space, now)) return { status: "grace" };
    await authDb.project.delete({ where: { id: space.id } });
    return { status: "deleted" };
  },
};

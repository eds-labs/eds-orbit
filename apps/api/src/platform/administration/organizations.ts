import { z } from "zod";
import { authDb } from "../../../../../packages/db/src/index.ts";
import { DomainError } from "../shared.ts";
import { systemAudit } from "./audit.ts";
import { createInvitation } from "./invitations.ts";
import { lockWorkspace, type Actor } from "./memberships.ts";

// Organizations (workspaces) for system administrators and their owners
// (ADR 0012). Only administrators create organizations; a SaaS
// registration policy can widen that later (plan phase 4).

const name = z.string().trim().min(1).max(100);
export const organizationInput = z
  .object({ name, ownerEmail: z.email().max(254) })
  .strict();
export const renameInput = z.object({ name }).strict();

/**
 * Creates an organization. An existing active account becomes its owner at
 * once; anyone else receives an owner invitation.
 */
export async function createOrganization(actor: Actor, raw: unknown) {
  if (actor.kind !== "admin") throw new DomainError("NOT_FOUND", 404);
  const input = organizationInput.parse(raw);
  const email = input.ownerEmail.trim().toLowerCase();
  const owner = await authDb.user.findUnique({
    where: { email },
    select: { id: true, banned: true },
  });
  if (owner?.banned) throw new DomainError("USER_DEACTIVATED", 409);
  const workspace = await authDb.$transaction(async (tx) => {
    const created = await tx.workspace.create({
      data: {
        name: input.name,
        ...(owner
          ? { members: { create: { userId: owner.id, role: "owner" } } }
          : {}),
      },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "workspace.created",
        targetType: "workspace",
        targetId: created.id,
        workspaceId: created.id,
        metadata: { owner: owner ? owner.id : "invited" },
      },
      tx,
    );
    return created;
  });
  const invitation = owner
    ? null
    : await createInvitation(actor, workspace.id, { email, role: "owner" });
  return { id: workspace.id, name: workspace.name, invitation };
}

export async function renameOrganization(
  actor: Actor,
  workspaceId: string,
  raw: unknown,
) {
  const input = renameInput.parse(raw);
  return authDb.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const updated = await tx.workspace.updateMany({
      where: { id: workspaceId },
      data: { name: input.name },
    });
    if (!updated.count) throw new DomainError("NOT_FOUND", 404);
    await systemAudit(
      {
        actorId: actor.userId,
        action: "workspace.renamed",
        targetType: "workspace",
        targetId: workspaceId,
        workspaceId,
        metadata: { by: actor.kind },
      },
      tx,
    );
    return { id: workspaceId, name: input.name };
  });
}

import { z } from "zod";
import { authDb, scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { Auth } from "./auth.ts";
import { audit, DomainError } from "../shared.ts";

export const addMemberInput = z
  .object({
    email: z.email(),
    name: z.string().min(1).max(100),
    password: z.string().min(12).max(128),
    role: z.enum(["owner", "editor", "viewer"]),
  })
  .strict();

/**
 * Adds a user to the caller's project, creating the account when the
 * address is unknown. A project owner who does not own the workspace may
 * only add people already in the workspace (or new accounts), may not grant
 * "owner" and may not change another owner's role; workspace owners may do
 * all of that. The audit is written in the project transaction before the
 * membership, so a failed audit leaves the membership unchanged, and a
 * failed membership write rolls the audit back.
 */
export async function addProjectMember(auth: Auth, scope: Scope, raw: unknown) {
  const input = addMemberInput.parse(raw);
  const { workspaceId, projectId } = scope;
  const ownsWorkspace = Boolean(
    await authDb.workspaceMember.findFirst({
      where: { workspaceId, userId: scope.userId, role: "owner" },
    }),
  );
  // Refused before anything is created, so a refusal leaves no account behind.
  if (input.role === "owner" && !ownsWorkspace)
    throw new DomainError("WORKSPACE_OWNER_REQUIRED", 403);
  const existing = await authDb.user.findUnique({
    where: { email: input.email },
    include: {
      memberships: { where: { workspaceId } },
      projectMemberships: { where: { projectId } },
    },
  });
  const previousRole = existing?.projectMemberships[0]?.role ?? null;
  if (
    existing &&
    !ownsWorkspace &&
    (!existing.memberships.length || previousRole === "owner")
  )
    throw new DomainError("WORKSPACE_OWNER_REQUIRED", 403);
  const userId =
    existing?.id ??
    (
      await auth.api.signUpEmail({
        body: {
          email: input.email,
          name: input.name,
          password: input.password,
        },
      })
    ).user.id;
  await scoped(workspaceId, projectId, async (tx) => {
    // Ids only: the audit trail keeps no e-mail addresses.
    await audit(tx, scope, "project_member.add", userId, {
      role: input.role,
      previousRole,
      createdUser: !existing,
    });
    await authDb.$transaction(async (atx) => {
      await atx.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId, userId } },
        create: { workspaceId, userId, role: "viewer" },
        update: {},
      });
      await atx.projectMember.upsert({
        where: { projectId_userId: { projectId, userId } },
        create: { workspaceId, projectId, userId, role: input.role },
        update: { role: input.role },
      });
    });
  });
  return { added: true };
}

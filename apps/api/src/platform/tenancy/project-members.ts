import { z } from "zod";
import { authDb, scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../shared.ts";
import { moduleRole } from "./module-roles.ts";
import { createInvitation } from "../administration/invitations.ts";
import { administrationEnabled } from "../administration/authz.ts";

export const addMemberInput = z
  .object({
    email: z.email().max(254),
    role: z.enum(["owner", "editor", "viewer"]),
    moduleRoles: z.record(z.string(), moduleRole.nullable()).optional(),
    locale: z.enum(["en", "de"]).optional(),
  })
  .strict();

/**
 * Adds someone to the caller's project (ADR 0012). A member of the
 * organization joins at once; anyone else receives an invitation and sets
 * their own password; no owner chooses a password any more. A project owner
 * who does not own the organization may not grant or change "owner". The
 * project audit keeps ids only, never the address.
 */
export async function addProjectMember(scope: Scope, raw: unknown) {
  const input = addMemberInput.parse(raw);
  const { workspaceId, projectId } = scope;
  const ownsWorkspace = Boolean(
    await authDb.workspaceMember.findFirst({
      where: { workspaceId, userId: scope.userId, role: "owner" },
    }),
  );
  if (input.role === "owner" && !ownsWorkspace)
    throw new DomainError("WORKSPACE_OWNER_REQUIRED", 403);
  const email = input.email.trim().toLowerCase();
  // Without the administration feature there is no invitation link to
  // accept, so only organization members can be added.
  if (!administrationEnabled()) {
    const member = await authDb.workspaceMember.findFirst({
      where: { workspaceId, user: { email } },
    });
    if (!member) throw new DomainError("INVITATIONS_DISABLED", 409);
  }
  const result = await createInvitation(
    { userId: scope.userId, kind: ownsWorkspace ? "org_owner" : "project_owner" },
    workspaceId,
    {
      email,
      role: "member",
      projects: [
        {
          projectId,
          role: input.role,
          ...(input.moduleRoles ? { moduleRoles: input.moduleRoles } : {}),
        },
      ],
      ...(input.locale ? { locale: input.locale } : {}),
    },
    projectId,
  );
  await scoped(workspaceId, projectId, (tx) =>
    result.status === "added"
      ? audit(tx, scope, "project_member.add", result.userId, {
          role: input.role,
        })
      : audit(tx, scope, "project_member.invite", result.invitationId, {
          role: input.role,
        }),
  );
  return result;
}

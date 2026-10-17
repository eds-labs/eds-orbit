import { authDb } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { moduleRolesEnabled } from "../../platform/tenancy/module-roles.ts";

/**
 * The project's support agents: members whose role in the support module is
 * owner or editor (workspace owners count as owners; module roles apply
 * while ORBIT_MODULE_ROLES is on).
 */
export async function supportAgents(scope: Scope) {
  const [owners, members] = await Promise.all([
    authDb.workspaceMember.findMany({
      where: { workspaceId: scope.workspaceId, role: "owner" },
    }),
    authDb.projectMember.findMany({
      where: { projectId: scope.projectId },
      ...(moduleRolesEnabled()
        ? { include: { moduleRoles: { where: { moduleId: "support" } } } }
        : {}),
    }),
  ]);
  const agents = new Set(owners.map((o) => o.userId));
  for (const member of members) {
    const override = (member as { moduleRoles?: Array<{ role: string }> })
      .moduleRoles?.[0]?.role;
    const role = member.role === "owner" ? "owner" : (override ?? member.role);
    if (role === "owner" || role === "editor") agents.add(member.userId);
  }
  const users = await authDb.user.findMany({
    where: { id: { in: [...agents] } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return users.map((u) => ({ userId: u.id, name: u.name }));
}

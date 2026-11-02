import type { AttentionContribution } from "../../platform/attention/types.ts";
import { can } from "../../platform/tenancy/permissions.ts";
import { socialActive } from "./gate.ts";
import { SOCIAL_READ } from "./permissions.ts";

// What needs attention in the social module, computed at read time.
// Counts only, no handles.

export const socialAttention: AttentionContribution = async (tx, scope) => {
  if (!can(scope, SOCIAL_READ)) return [];
  if (!(await socialActive(tx, scope))) return [];
  const reconnect = await tx.socialAccount.count({
    where: { projectId: scope.projectId, status: "reconnect_required" },
  });
  return reconnect
    ? [
        {
          id: "social:reconnect",
          moduleId: "social",
          kind: "social_account_reconnect",
          severity: "warning",
          count: reconnect,
          params: {},
          navKey: "social.accounts",
          link: "/social/accounts",
        },
      ]
    : [];
};

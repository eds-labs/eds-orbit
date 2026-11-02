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
  // Publications a person has to look at: an unclear send, a blocked one,
  // or one that failed for good (S5).
  const problems = await tx.socialPublication.count({
    where: {
      projectId: scope.projectId,
      OR: [{ status: { in: ["outcome_unknown", "blocked"] } }, { status: "failed", nextAttemptAt: null }],
    },
  });
  return [
    ...(reconnect
      ? [
          {
            id: "social:reconnect",
            moduleId: "social",
            kind: "social_account_reconnect",
            severity: "warning" as const,
            count: reconnect,
            params: {},
            navKey: "social.accounts",
            link: "/social/accounts",
          },
        ]
      : []),
    ...(problems
      ? [
          {
            id: "social:publications",
            moduleId: "social",
            kind: "social_publication_problem",
            severity: "warning" as const,
            count: problems,
            params: {},
            navKey: "social.posts",
            link: "/social/posts",
          },
        ]
      : []),
  ];
};

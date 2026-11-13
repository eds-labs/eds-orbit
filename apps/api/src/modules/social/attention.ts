import type { AttentionContribution } from "../../platform/attention/types.ts";
import { can } from "../../platform/tenancy/permissions.ts";
import { socialActive } from "./gate.ts";
import { SOCIAL_READ } from "./permissions.ts";
import { socialAccountsLink } from "./links.ts";

// What needs attention in the social module, computed at read time.
// Counts only, no handles.

const WEEK_MS = 7 * 86_400_000;
const LATE_MS = 30 * 60_000;

export const socialAttention: AttentionContribution = async (tx, scope, now) => {
  if (!can(scope, SOCIAL_READ)) return [];
  if (!(await socialActive(tx, scope))) return [];
  const reconnect = await tx.socialAccount.count({
    where: { projectId: scope.projectId, status: "reconnect_required" },
  });
  // Publications a person has to look at: an unclear send, a blocked one,
  // or one that failed for good (S5).
  // A failure counts for a week and until the owner settled it.
  const problems = await tx.socialPublication.count({
    where: {
      projectId: scope.projectId,
      // History mirrored from Postiz (S10) is no one's work here.
      legacyEntityId: null,
      OR: [
        { status: { in: ["outcome_unknown", "blocked"] } },
        { status: "failed", nextAttemptAt: null, resolution: null, updatedAt: { gte: new Date(now.getTime() - WEEK_MS) } },
      ],
    },
  });
  // Approved posts whose time passed more than 30 minutes ago without being
  // sent (a pause, for example): they wait for a new time (S5).
  const late = new Date(now.getTime() - LATE_MS);
  const missed = await tx.socialPost.count({
    where: {
      projectId: scope.projectId,
      OR: [
        { status: "scheduled", scheduledAt: { lt: late } },
        { status: "approved", scheduleMode: "now", approvedAt: { lt: late } },
      ],
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
            link: socialAccountsLink(scope.projectId),
          },
        ]
      : []),
    ...(missed
      ? [
          {
            id: "social:missed",
            moduleId: "social",
            kind: "social_post_missed",
            severity: "warning" as const,
            count: missed,
            params: {},
            navKey: "social.posts",
            link: "/social/posts",
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

import { authDb, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { notifyMembers } from "../../platform/notifications/members.ts";
import type { UserNotificationKind } from "../../platform/notifications/members.ts";
import { moduleRolesEnabled } from "../../platform/tenancy/module-roles.ts";

// The finance module's member notifications. The text is generic on purpose:
// a notice never carries an amount, a name or a word of the document.

export const FINANCE_REVIEW_NEEDED = "finance_review_needed";

export const financeUserNotifications: Readonly<
  Record<string, UserNotificationKind>
> = {
  [FINANCE_REVIEW_NEEDED]: {
    label: {
      en: "A finance document needs review",
      de: "Ein Finanzbeleg muss geprüft werden",
    },
    emailDefault: false,
  },
};

/**
 * The members who may review documents (finance.write: owner and editor in
 * the finance module; workspace owners count as owners; module roles apply
 * while ORBIT_MODULE_ROLES is on). Mirrors Support's agent selection.
 */
export async function financeReviewers(scope: Scope): Promise<string[]> {
  const [owners, members] = await Promise.all([
    authDb.workspaceMember.findMany({
      where: { workspaceId: scope.workspaceId, role: "owner" },
    }),
    authDb.projectMember.findMany({
      where: { projectId: scope.projectId },
      ...(moduleRolesEnabled()
        ? { include: { moduleRoles: { where: { moduleId: "finance" } } } }
        : {}),
    }),
  ]);
  const users = new Set(owners.map((o) => o.userId));
  for (const member of members) {
    const override = (member as { moduleRoles?: Array<{ role: string }> })
      .moduleRoles?.[0]?.role;
    const role = member.role === "owner" ? "owner" : (override ?? member.role);
    if (role === "owner" || role === "editor") users.add(member.userId);
  }
  return [...users];
}

const TITLE = {
  en: "A receipt needs review",
  de: "Ein Beleg muss geprüft werden",
};
const BODY = {
  en: "Open the review queue to check it.",
  de: "Öffne die Prüfliste, um ihn zu prüfen.",
};

/**
 * Tells the reviewers that a document reached `needs_review` or `failed`.
 * The caller sends it once, on the transition out of `received` (extraction's
 * guarded update), so a repeated job never notifies twice.
 */
export async function notifyReviewNeeded(
  tx: DbTx,
  scope: Scope,
  documentId: string,
) {
  const userIds = await financeReviewers(scope);
  if (!userIds.length) return;
  const project = await tx.project.findUnique({
    where: { id: scope.projectId },
    select: { language: true },
  });
  const lang = project?.language === "de" ? "de" : "en";
  await notifyMembers(tx, scope, {
    kind: FINANCE_REVIEW_NEEDED,
    userIds: userIds.slice(0, 200),
    title: TITLE[lang],
    body: BODY[lang],
    link: `/p/${scope.projectId}/finance/review?document=${documentId}`,
  });
}

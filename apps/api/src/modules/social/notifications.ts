import { authDb, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { notifyMembers, type UserNotificationKind } from "../../platform/notifications/members.ts";
import { socialAccountsLink } from "./links.ts";

// The social module's member notifications. Generic texts: never a handle,
// a token or a provider message.

export const SOCIAL_ACCOUNT_RECONNECT = "social_account_reconnect";

export const socialUserNotifications: Readonly<Record<string, UserNotificationKind>> = {
  [SOCIAL_ACCOUNT_RECONNECT]: {
    label: { en: "A social account needs to be reconnected", de: "Ein Social-Media-Konto muss neu verbunden werden" },
    emailDefault: true,
  },
};

/** The project's owners (organization owners count as owners). */
export async function socialOwners(scope: Scope): Promise<string[]> {
  const [orgOwners, members] = await Promise.all([
    authDb.workspaceMember.findMany({ where: { workspaceId: scope.workspaceId, role: "owner" } }),
    authDb.projectMember.findMany({ where: { projectId: scope.projectId, role: "owner" } }),
  ]);
  return [...new Set([...orgOwners, ...members].map((m) => m.userId))];
}

const TITLE = {
  en: "A social account needs to be reconnected",
  de: "Ein Social-Media-Konto muss neu verbunden werden",
};
const BODY = {
  en: "Open the social accounts to connect it again. Nothing is published to it until then.",
  de: "Öffne die Social-Media-Konten, um es neu zu verbinden. Bis dahin wird nichts darüber veröffentlicht.",
};

/** Tells the owners once, on the transition to reconnect_required. */
export async function notifyReconnectRequired(tx: DbTx, scope: Scope) {
  const userIds = await socialOwners(scope);
  if (!userIds.length) return;
  const project = await tx.project.findUnique({ where: { id: scope.projectId }, select: { language: true } });
  const lang = project?.language === "de" ? "de" : "en";
  await notifyMembers(tx, scope, {
    kind: SOCIAL_ACCOUNT_RECONNECT,
    userIds: userIds.slice(0, 200),
    title: TITLE[lang],
    body: BODY[lang],
    link: socialAccountsLink(scope.projectId),
  });
}

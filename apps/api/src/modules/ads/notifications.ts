import { authDb, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { notifyMembers, type UserNotificationKind } from "../../platform/notifications/members.ts";

// The ads module's member notifications. Generic texts: never an account
// name or id, a token or a provider message.

export const ADS_ACCOUNT_RECONNECT = "ads_account_reconnect";
export const ADS_TOKEN_EXPIRING = "ads_token_expiring";

export const adsUserNotifications: Readonly<Record<string, UserNotificationKind>> = {
  [ADS_ACCOUNT_RECONNECT]: {
    label: { en: "An ad account needs to be reconnected", de: "Ein Werbekonto muss neu verbunden werden" },
    emailDefault: true,
  },
  [ADS_TOKEN_EXPIRING]: {
    label: { en: "Meta access for ads expires soon", de: "Der Meta-Zugang für Werbung läuft bald ab" },
    emailDefault: true,
  },
};

/** The project's owners (organization owners count as owners). */
async function adsOwners(scope: Scope): Promise<string[]> {
  const [orgOwners, members] = await Promise.all([
    authDb.workspaceMember.findMany({ where: { workspaceId: scope.workspaceId, role: "owner" } }),
    authDb.projectMember.findMany({ where: { projectId: scope.projectId, role: "owner" } }),
  ]);
  return [...new Set([...orgOwners, ...members].map((m) => m.userId))];
}

const RECONNECT = {
  en: {
    title: "An ad account needs to be reconnected",
    body: "Open the ad accounts to connect Meta again. Ads are not read or changed until then.",
  },
  de: {
    title: "Ein Werbekonto muss neu verbunden werden",
    body: "Öffne die Werbekonten, um Meta erneut zu verbinden. Bis dahin werden keine Anzeigen gelesen oder geändert.",
  },
};
const EXPIRING = {
  en: {
    title: "Meta access for ads expires soon",
    body: "Open the ad accounts and connect Meta again before the access ends, so nothing is interrupted.",
  },
  de: {
    title: "Der Meta-Zugang für Werbung läuft bald ab",
    body: "Öffne die Werbekonten und verbinde Meta erneut, bevor der Zugang endet, damit nichts unterbrochen wird.",
  },
};

async function send(tx: DbTx, scope: Scope, kind: string, text: typeof RECONNECT) {
  const userIds = await adsOwners(scope);
  if (!userIds.length) return;
  const project = await tx.project.findUnique({ where: { id: scope.projectId }, select: { language: true } });
  const lang = project?.language === "de" ? "de" : "en";
  await notifyMembers(tx, scope, {
    kind,
    userIds: userIds.slice(0, 200),
    title: text[lang].title,
    body: text[lang].body,
    link: `/p/${scope.projectId}/ads/accounts`,
  });
}

/** Tells the owners that at least one ad account needs a reconnect. */
export const notifyAdsReconnect = (tx: DbTx, scope: Scope) => send(tx, scope, ADS_ACCOUNT_RECONNECT, RECONNECT);

/** Tells the owners the Meta access ends soon. The date is not in the text; the caller notifies once per date. */
export const notifyAdsTokenExpiring = (tx: DbTx, scope: Scope, _expiresAt: Date) =>
  send(tx, scope, ADS_TOKEN_EXPIRING, EXPIRING);

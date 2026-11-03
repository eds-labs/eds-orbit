import { refreshOAuthToken } from "@opencoredev/social-sdk/server";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { connectionSecret } from "../../../platform/connections/central.ts";
import { withProjectSecret } from "../../../platform/connections/project-secrets.ts";
import { audit, DomainError } from "../../../shared.ts";
import { notifyReconnectRequired } from "../notifications.ts";
import { appCredentials } from "./apps.ts";
import { providerFailure } from "./errors.ts";
import { statusRecordingFetch } from "./http.ts";
import type { SocialPlatform } from "./store.ts";
import { xAccountSecret, xAccountSecretOf, type XAccountSecret } from "./x.ts";

// A connected account's credentials (ADR 0020). An X token that expires
// within five minutes is refreshed under the connection's lock, so two
// callers never spend the same single-use refresh token. A refusal marks
// the account for a reconnect; an outage changes nothing.

const EARLY_MS = 5 * 60_000;

export type AccountCredentials = {
  platform: SocialPlatform;
  accessToken: string;
  externalId: string;
  pageId?: string;
  /** The connection's non-secret settings (ids such as chatId or pageId). */
  config: Record<string, unknown>;
};

const reconnect = () => new DomainError("SOCIAL_ACCOUNT_RECONNECT_REQUIRED", 409);
const expiring = (secret: XAccountSecret) =>
  secret.expiresAt !== null && Date.parse(secret.expiresAt) - Date.now() < EARLY_MS;
const parse = (raw: string) => {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new DomainError("SOCIAL_ACCOUNT_SECRET_INVALID", 500);
  }
};

/** Marks an active account for a reconnect; audits and tells the owners once. */
export async function markReconnectRequired(tx: DbTx, scope: Scope, accountId: string, code: string) {
  const changed = await tx.socialAccount.updateMany({
    where: { id: accountId, projectId: scope.projectId, status: "active" },
    data: { status: "reconnect_required", version: { increment: 1 } },
  });
  if (changed.count !== 1) return;
  await audit(tx, scope, "social.account.reconnect_required", accountId, { code });
  await notifyReconnectRequired(tx, scope);
}

async function refreshX(scope: Scope, accountId: string, connectionId: string): Promise<XAccountSecret> {
  try {
    // Lock order: project before connection. The app is read before the
    // connection lock, so no project transaction waits inside it.
    const app = await scoped(scope.workspaceId, scope.projectId, (tx) => appCredentials(tx, scope, "x"));
    return await withProjectSecret(scope, { moduleId: "social", connectionId }, async (current) => {
      const secret = xAccountSecret.parse(parse(current.secret));
      // Another caller may have refreshed while this one waited.
      if (!expiring(secret)) return { result: secret };
      if (!secret.refreshToken) throw reconnect();
      let token;
      const recorder = statusRecordingFetch();
      try {
        token = await refreshOAuthToken(
          "x",
          { clientId: app.x!.clientId, clientSecret: app.x!.clientSecret, fetch: recorder.fetch },
          {
            accessToken: secret.accessToken,
            refreshToken: secret.refreshToken,
            ...(secret.expiresAt ? { expiresAt: secret.expiresAt } : {}),
            scopes: secret.scopes,
          },
        );
      } catch (error) {
        throw providerFailure(error, recorder.lastStatus());
      }
      const fresh = xAccountSecretOf(token);
      return { result: fresh, secret: JSON.stringify(fresh) };
    });
  } catch (error) {
    const failure = providerFailure(error);
    // Only a refusal of this account's grant needs a reconnect; a refused
    // developer app or an outage leaves the account as it is.
    if (failure.code === "SOCIAL_PROVIDER_REJECTED" || failure.code === "SOCIAL_ACCOUNT_RECONNECT_REQUIRED") {
      await scoped(scope.workspaceId, scope.projectId, (tx) =>
        markReconnectRequired(tx, scope, accountId, failure.code),
      );
      throw reconnect();
    }
    throw failure;
  }
}

/** The account's usable credentials; refreshes an X token close to expiry. */
export async function accountCredentials(
  scope: Scope,
  accountId: string,
  options: { allowReconnect?: boolean } = {},
): Promise<AccountCredentials> {
  const loaded = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const account = await tx.socialAccount.findFirst({ where: { id: accountId, projectId: scope.projectId } });
    if (!account) throw new DomainError("NOT_FOUND", 404);
    if (account.status === "reconnect_required" && !options.allowReconnect) throw reconnect();
    if (account.status === "disabled") throw new DomainError("SOCIAL_ACCOUNT_DISABLED", 409);
    const raw = await connectionSecret(tx, account.connectionId);
    const connection = await tx.connection.findUnique({
      where: { id: account.connectionId },
      select: { config: true },
    });
    return { account, raw, config: (connection?.config ?? {}) as Record<string, unknown> };
  });
  const { account, raw, config } = loaded;
  if (raw === null) {
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      markReconnectRequired(tx, scope, account.id, "SOCIAL_ACCOUNT_SECRET_MISSING"),
    );
    throw reconnect();
  }
  const platform = account.platform as SocialPlatform;
  const base = { platform, externalId: account.externalId, config };
  const secret = parse(raw);
  if (platform === "x") {
    const parsed = xAccountSecret.parse(secret);
    const usable = expiring(parsed) ? await refreshX(scope, account.id, account.connectionId) : parsed;
    return { ...base, accessToken: usable.accessToken };
  }
  if (platform === "telegram") return { ...base, accessToken: String(secret.botToken ?? "") };
  return {
    ...base,
    accessToken: String(secret.pageToken ?? ""),
    ...(typeof config.pageId === "string" ? { pageId: config.pageId } : {}),
  };
}

import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { revokeProjectConnection } from "../../../platform/connections/project-secrets.ts";
import { audit, DomainError } from "../../../shared.ts";
import { adsProvider } from "../providers/registry.ts";
import { AdsProviderError, type ProviderAccount, type ProviderApp } from "../providers/types.ts";
import { adsAppCredentials, adsRedirectUri } from "./app.ts";
import { beginAdsOAuthState, type ConsumedAdsState } from "./oauth-state.ts";
import { FORGET_PERSON, saveGrant } from "./vault.ts";

// Connecting Meta through Facebook Login for Business (ADR 0025). The routes
// own the state checks; this turns a consumed state and the provider's code
// into a saved grant. Provider calls run outside any project transaction.

const REREAD_LIMIT = 20;
const NOT_GRANTED = "ADS_META_ACCOUNT_NOT_GRANTED";

const metaConnect = () => adsProvider("meta")!.connect!;

/** Starts the authorization: the state is stored, the URL carries no secret. */
export async function beginMetaConnect(tx: DbTx, scope: Scope): Promise<{ authorizeUrl: string }> {
  const app = await adsAppCredentials(tx, scope);
  const { state } = await beginAdsOAuthState(tx, scope, {
    provider: "meta",
    appConnectionId: app.connectionId,
    redirectAfter: `/p/${scope.projectId}/ads/accounts`,
  });
  const authorizeUrl = metaConnect().authorizeUrl({
    app: { clientId: app.clientId, clientSecret: app.clientSecret, configId: app.configId },
    redirectUri: adsRedirectUri(loadConfig()),
    state,
  });
  return { authorizeUrl };
}

/** A provider failure becomes a DomainError carrying only its code. */
function asDomainError(error: unknown): unknown {
  return error instanceof AdsProviderError ? new DomainError(error.failure.code, 502) : error;
}

/** Exchanges the code, saves the grant and, on a reconnect, re-checks the accounts that needed it. */
export async function finishMetaConnect(
  scope: Scope,
  input: { code: string; attempt: ConsumedAdsState },
): Promise<{ connectionId: string }> {
  const credentials = await scoped(scope.workspaceId, scope.projectId, (tx) => adsAppCredentials(tx, scope));
  if (credentials.connectionId !== input.attempt.appConnectionId) throw new DomainError("ADS_META_APP_CHANGED", 409);
  const app: ProviderApp = {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    configId: credentials.configId,
  };
  const connect = metaConnect();
  let grant;
  try {
    grant = await connect.finish({ app, redirectUri: adsRedirectUri(loadConfig()), code: input.code });
  } catch (error) {
    throw asDomainError(error);
  }
  const saved = await saveGrant(scope, grant, credentials.connectionId);
  try {
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      audit(tx, scope, "ads.account.connected", saved.connectionId, {
        connectionId: saved.connectionId,
        reconnect: saved.reconnect,
        tokenType: grant.tokenType,
      }),
    );
  } catch (error) {
    // A new connection nobody can see would be an orphan: revoke it.
    if (!saved.reconnect)
      await revokeProjectConnection(scope, { moduleId: "ads", connectionId: saved.connectionId, reason: "connect_not_recorded", forget: FORGET_PERSON });
    throw error;
  }
  if (saved.reconnect)
    await recheckAccounts(scope, { app, connectionId: saved.connectionId, accessToken: grant.accessToken, grantedScopes: grant.grantedScopes });
  return { connectionId: saved.connectionId };
}

/**
 * Re-reads (at most 20 of) the connection's accounts that were waiting for a
 * reconnect: readable ones take the provider's status again, refused ones
 * keep waiting with a health note, and every other one is due for a check
 * right now. A row that changed meanwhile (an owner unlinked it, say) is
 * left as it is: the restore only applies to a row still waiting on this
 * connection.
 */
async function recheckAccounts(
  scope: Scope,
  input: { app: ProviderApp; connectionId: string; accessToken: string; grantedScopes: string[] },
) {
  const waiting = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    tx.adAccount.findMany({
      where: { projectId: scope.projectId, connectionId: input.connectionId, status: "reconnect_required" },
      select: { id: true, externalId: true },
      orderBy: { createdAt: "asc" },
    }),
  );
  const restored: Array<{ id: string; read: ProviderAccount }> = [];
  const refused: string[] = [];
  for (const account of waiting.slice(0, REREAD_LIMIT)) {
    try {
      const read = await metaConnect().readAccount({ ...input, externalId: account.externalId });
      restored.push({ id: account.id, read });
    } catch (error) {
      if (error instanceof AdsProviderError && (error.failure.kind === "auth" || error.failure.kind === "permission"))
        refused.push(account.id);
    }
  }
  const refusedIds = new Set(refused);
  const restoredIds = new Set(restored.map((r) => r.id));
  const rest = waiting.filter((a) => !refusedIds.has(a.id) && !restoredIds.has(a.id)).map((a) => a.id);
  const now = new Date();
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    for (const { id, read } of restored) {
      const still = { projectId: scope.projectId, id, connectionId: input.connectionId, status: "reconnect_required" };
      const row = await tx.adAccount.findFirst({ where: still, select: { capability: true } });
      if (!row) continue;
      // As health does: write_verified stays only while writing is possible.
      const capability = read.canWrite ? (row.capability === "write_verified" ? "write_verified" : "write_ready") : "read_verified";
      const changed = await tx.adAccount.updateMany({
        where: still,
        data: {
          status: read.status,
          providerStatus: read.providerStatus,
          capability,
          ...(capability === "read_verified" || read.status !== "active" ? { writesEnabled: false } : {}),
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) continue;
      await tx.adSyncState.updateMany({
        where: { projectId: scope.projectId, accountId: id, stream: "health" },
        data: { lastErrorCode: null, consecutiveFailures: 0, nextRunAt: now },
      });
      await audit(tx, scope, "ads.account.restored", id, { connectionId: input.connectionId });
    }
    for (const id of refused)
      await tx.adSyncState.upsert({
        where: { projectId_accountId_stream: { projectId: scope.projectId, accountId: id, stream: "health" } },
        create: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          accountId: id,
          stream: "health",
          nextRunAt: now,
          lastErrorCode: NOT_GRANTED,
        },
        update: { lastErrorCode: NOT_GRANTED },
      });
    if (rest.length)
      await tx.adSyncState.updateMany({
        where: { projectId: scope.projectId, accountId: { in: rest }, stream: "health" },
        data: { nextRunAt: now },
      });
  });
}

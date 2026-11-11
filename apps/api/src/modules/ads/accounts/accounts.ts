import { randomUUID } from "node:crypto";
import { authDb, scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  claimExclusiveConfigValue,
  releaseExclusiveConfigValue,
  revokeProjectConnection,
} from "../../../platform/connections/project-secrets.ts";
import { audit, DomainError } from "../../../shared.ts";
import { adsProvider } from "../providers/registry.ts";
import { AdsProviderError, type ProviderAccount } from "../providers/types.ts";
import { adsAppReadiness, type AdsAppReadiness } from "./app.ts";
import { adAccountSettingsPatchSchema, readAdAccountSettings, type AdAccountSettings } from "./account-settings.ts";
import { grantCredentials } from "./vault.ts";

// Ad accounts of a project (ADR 0025, A3): which of a connection's Meta ad
// accounts the project uses. One account belongs to one project per
// organization; the exclusivity is a claim on the connection (see
// claimExclusiveConfigValue). Provider calls and claims run outside the
// project transaction: they open their own auth transactions with locks.

const PROVIDER = "ads.account.meta";
const MODULE = "ads";
const CLAIM_KEY = "assignedAdAccounts";
const HEALTH_INTERVAL_MS = 6 * 3_600_000;
const connect = () => adsProvider("meta")!.connect!;

export type AdAccountView = {
  id: string;
  provider: string;
  externalId: string;
  name: string;
  currency: string;
  timezone: string;
  status: string;
  capability: string;
  writesEnabled: boolean;
  providerStatus: string | null;
  spendCapMicros: string | null;
  amountSpentMicros: string | null;
  businessId: string | null;
  settings: AdAccountSettings;
  health: { lastCheckedAt: string | null; lastErrorCode: string | null; nextCheckAt: string | null };
  connection: { id: string; tokenType: string; tokenExpiresAt: string | null } | null;
  version: number;
};
export type ProviderAccountView = Omit<ProviderAccount, "spendCapMicros" | "amountSpentMicros"> & {
  spendCapMicros: string | null;
  amountSpentMicros: string | null;
};
export type AdConnectionView = {
  id: string;
  label: string;
  tokenType: string;
  tokenExpiresAt: string | null;
  grantedScopes: string[];
  accountCount: number;
  createdAt: string;
};

const str = (v: bigint | null) => (v === null ? null : v.toString());
const iso = (v: Date | null | undefined) => (v ? v.toISOString() : null);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const tokenType = (config: Record<string, unknown>) => (config.tokenType === "system_user" ? "system_user" : "user");
const expiry = (config: Record<string, unknown>) => (typeof config.tokenExpiresAt === "string" ? config.tokenExpiresAt : null);

/** A refused provider call becomes a code of ours; nothing of the provider's text or token. */
function providerError(error: unknown, read: boolean): unknown {
  if (!(error instanceof AdsProviderError)) return error;
  const { kind, code } = error.failure;
  if (code === "ADS_ACCOUNT_ID_INVALID") return new DomainError(code, 400);
  if (kind === "auth") return new DomainError("ADS_ACCOUNT_RECONNECT_REQUIRED", 409);
  if (read && (kind === "permission" || kind === "validation")) return new DomainError("ADS_ACCOUNT_NOT_GRANTED", 409);
  return new DomainError(code, 502);
}

/** The project's own live Meta connection; any other id (other project, revoked, other provider) is 404. */
async function ownConnection(scope: Scope, connectionId: string, options: { allowDisabled?: boolean } = {}) {
  const row = await authDb.connection.findFirst({
    where: {
      id: connectionId,
      provider: PROVIDER,
      scope: "project",
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      revokedAt: null,
      ...(options.allowDisabled ? {} : { disabledAt: null }),
    },
    select: { id: true, label: true, config: true, createdAt: true },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  return row;
}

type Row = Awaited<ReturnType<DbTx["adAccount"]["findFirstOrThrow"]>>;

async function toViews(tx: DbTx, scope: Scope, rows: Row[]): Promise<AdAccountView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const health = await tx.adSyncState.findMany({ where: { projectId: scope.projectId, accountId: { in: ids }, stream: "health" } });
  const connections = await authDb.connection.findMany({
    where: {
      id: { in: [...new Set(rows.map((r) => r.connectionId))] },
      provider: PROVIDER,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      revokedAt: null,
    },
    select: { id: true, config: true },
  });
  const byConnection = new Map(connections.map((c) => [c.id, record(c.config)]));
  const byAccount = new Map(health.map((h) => [h.accountId, h]));
  return rows.map((r) => {
    const h = byAccount.get(r.id);
    const config = byConnection.get(r.connectionId);
    return {
      id: r.id,
      provider: r.provider,
      externalId: r.externalId,
      name: r.name,
      currency: r.currency,
      timezone: r.timezone,
      status: r.status,
      capability: r.capability,
      writesEnabled: r.writesEnabled,
      providerStatus: r.providerStatus,
      spendCapMicros: str(r.spendCapMicros),
      amountSpentMicros: str(r.amountSpentMicros),
      businessId: r.businessId,
      settings: readAdAccountSettings(r.settings),
      health: { lastCheckedAt: iso(h?.lastSuccessAt), lastErrorCode: h?.lastErrorCode ?? null, nextCheckAt: iso(h?.nextRunAt) },
      connection: config ? { id: r.connectionId, tokenType: tokenType(config), tokenExpiresAt: expiry(config) } : null,
      version: r.version,
    };
  });
}

export async function listAdAccounts(tx: DbTx, scope: Scope): Promise<AdAccountView[]> {
  const rows = await tx.adAccount.findMany({
    where: { projectId: scope.projectId, status: { not: "unlinked" } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return toViews(tx, scope, rows);
}

export async function listConnections(
  tx: DbTx,
  scope: Scope,
): Promise<{ app: AdsAppReadiness; connections: AdConnectionView[] }> {
  const app = await adsAppReadiness(tx, scope);
  const rows = await authDb.connection.findMany({
    where: { provider: PROVIDER, scope: "project", workspaceId: scope.workspaceId, projectId: scope.projectId, revokedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, label: true, config: true, createdAt: true },
  });
  const counts = await tx.adAccount.groupBy({
    by: ["connectionId"],
    where: { projectId: scope.projectId, status: { not: "unlinked" } },
    _count: { _all: true },
  });
  const countOf = new Map(counts.map((c) => [c.connectionId, c._count._all]));
  return {
    app,
    connections: rows.map((r) => {
      const config = record(r.config);
      return {
        id: r.id,
        label: r.label,
        tokenType: tokenType(config),
        tokenExpiresAt: expiry(config),
        grantedScopes: strings(config.grantedScopes),
        accountCount: countOf.get(r.id) ?? 0,
        createdAt: r.createdAt.toISOString(),
      };
    }),
  };
}

const view = (a: ProviderAccount): ProviderAccountView => ({
  ...a,
  spendCapMicros: str(a.spendCapMicros),
  amountSpentMicros: str(a.amountSpentMicros),
});

/**
 * The accounts the connection's Meta user can reach, marked "here" (already
 * used by this project) or "elsewhere" (claimed by another project of the
 * organization). The other projects' connections are read as a boolean only:
 * neither their id nor their name leaves this function.
 */
export async function availableAccounts(
  scope: Scope,
  connectionId: string,
): Promise<{ accounts: (ProviderAccountView & { assigned: "here" | "elsewhere" | null })[]; truncated: boolean }> {
  await ownConnection(scope, connectionId);
  const credentials = await grantCredentials(scope, connectionId);
  let listed;
  try {
    listed = await connect().listAccounts({
      app: credentials.app,
      accessToken: credentials.accessToken,
      grantedScopes: credentials.config.grantedScopes,
    });
  } catch (error) {
    throw providerError(error, false);
  }
  const here = new Set(
    (
      await scoped(scope.workspaceId, scope.projectId, (tx) =>
        tx.adAccount.findMany({
          where: { projectId: scope.projectId, provider: "meta", status: { not: "unlinked" } },
          select: { externalId: true },
        }),
      )
    ).map((a) => a.externalId),
  );
  // A claim holds until its connection is revoked (disabled ones keep it).
  const others = await authDb.connection.findMany({
    where: { provider: PROVIDER, scope: "project", workspaceId: scope.workspaceId, projectId: { not: scope.projectId }, revokedAt: null },
    select: { config: true },
  });
  const elsewhere = new Set(others.flatMap((c) => strings(record(c.config)[CLAIM_KEY])));
  return {
    accounts: listed.accounts.map((a) => ({
      ...view(a),
      assigned: here.has(a.externalId) ? "here" : elsewhere.has(a.externalId) ? "elsewhere" : null,
    })),
    truncated: listed.truncated,
  };
}

const quietNotFound = (error: unknown) => {
  if (error instanceof DomainError && error.code === "NOT_FOUND") return;
  throw error;
};

/** Releases a claim of the project's connection; a connection that is already revoked holds none. */
async function release(scope: Scope, connectionId: string, externalId: string) {
  await releaseExclusiveConfigValue(scope, { moduleId: MODULE, connectionId, key: CLAIM_KEY, value: externalId }).catch(quietNotFound);
}

export async function assignAdAccount(
  scope: Scope,
  input: { connectionId: string; externalId: string },
): Promise<AdAccountView> {
  const connection = await ownConnection(scope, input.connectionId);
  const alreadyClaimed = strings(record(connection.config)[CLAIM_KEY]).includes(input.externalId);
  const credentials = await grantCredentials(scope, input.connectionId);
  let read: ProviderAccount;
  try {
    read = await connect().readAccount({
      app: credentials.app,
      accessToken: credentials.accessToken,
      grantedScopes: credentials.config.grantedScopes,
      externalId: input.externalId,
    });
  } catch (error) {
    throw providerError(error, true);
  }
  if (!read.currencySupported) throw new DomainError("ADS_CURRENCY_UNSUPPORTED", 409);
  try {
    await claimExclusiveConfigValue(scope, { moduleId: MODULE, connectionId: input.connectionId, key: CLAIM_KEY, value: read.externalId });
  } catch (error) {
    if (error instanceof DomainError && error.code === "CONNECTION_VALUE_CLAIMED") throw new DomainError("ADS_ACCOUNT_ASSIGNED_ELSEWHERE", 409);
    throw error;
  }
  let outcome: { view: AdAccountView; movedFrom: string | null };
  try {
    outcome = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const existing = await tx.adAccount.findFirst({
        where: { projectId: scope.projectId, provider: "meta", externalId: read.externalId },
      });
      const fresh = !existing || existing.status === "unlinked" || existing.connectionId !== input.connectionId;
      const capability = read.canWrite ? (existing?.capability === "write_verified" && !fresh ? "write_verified" : "write_ready") : "read_verified";
      const facts = {
        name: read.name,
        currency: read.currency,
        timezone: read.timezone,
        status: read.status,
        capability,
        connectionId: input.connectionId,
        businessId: read.businessId,
        providerStatus: read.providerStatus,
        spendCapMicros: read.spendCapMicros,
        amountSpentMicros: read.amountSpentMicros,
        writesEnabled: fresh || capability === "read_verified" || read.status !== "active" ? false : existing!.writesEnabled,
      };
      const row = existing
        ? await tx.adAccount.update({
            where: { projectId_id: { projectId: scope.projectId, id: existing.id } },
            data: { ...facts, version: { increment: 1 } },
          })
        : await tx.adAccount.create({
            data: { id: randomUUID(), workspaceId: scope.workspaceId, projectId: scope.projectId, provider: "meta", externalId: read.externalId, createdBy: scope.userId, ...facts },
          });
      await tx.adSyncState.upsert({
        where: { projectId_accountId_stream: { projectId: scope.projectId, accountId: row.id, stream: "health" } },
        create: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          accountId: row.id,
          stream: "health",
          nextRunAt: new Date(Date.now() + HEALTH_INTERVAL_MS),
        },
        update: {},
      });
      await audit(tx, scope, "ads.account.assigned", row.id, { provider: "meta", connectionId: input.connectionId });
      const [created] = await toViews(tx, scope, [row]);
      return {
        view: created!,
        movedFrom: existing && existing.status !== "unlinked" && existing.connectionId !== input.connectionId ? existing.connectionId : null,
      };
    });
  } catch (error) {
    // A claim this call added must not outlive the failure (unless the
    // project holds the account on this connection through another call).
    if (!alreadyClaimed) {
      const holds = await scoped(scope.workspaceId, scope.projectId, (tx) =>
        tx.adAccount.count({
          where: { projectId: scope.projectId, provider: "meta", externalId: read.externalId, connectionId: input.connectionId, status: { not: "unlinked" } },
        }),
      ).catch(() => 1);
      if (holds === 0) await release(scope, input.connectionId, read.externalId).catch(() => undefined);
    }
    throw error;
  }
  if (outcome.movedFrom) await release(scope, outcome.movedFrom, read.externalId);
  return outcome.view;
}

export async function updateAdAccount(
  tx: DbTx,
  scope: Scope,
  accountId: string,
  input: { settings?: unknown; writesEnabled?: boolean; version: number },
): Promise<AdAccountView> {
  const account = await tx.adAccount.findFirst({ where: { id: accountId, projectId: scope.projectId, status: { not: "unlinked" } } });
  if (!account) throw new DomainError("NOT_FOUND", 404);
  if (account.version !== input.version) throw new DomainError("ADS_VERSION_CONFLICT", 409);
  const data: { settings?: AdAccountSettings; writesEnabled?: boolean } = {};
  if (input.settings !== undefined) {
    const patch = adAccountSettingsPatchSchema.parse(input.settings);
    data.settings = { ...readAdAccountSettings(account.settings), ...patch };
  }
  if (input.writesEnabled === true && !account.writesEnabled) {
    if ((account.capability !== "write_ready" && account.capability !== "write_verified") || account.status !== "active")
      throw new DomainError("ADS_ACCOUNT_NOT_WRITE_READY", 409);
    data.writesEnabled = true;
  } else if (input.writesEnabled === false && account.writesEnabled) {
    data.writesEnabled = false;
  }
  const changed = await tx.adAccount.updateMany({
    where: { projectId: scope.projectId, id: account.id, version: input.version },
    data: { ...data, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw new DomainError("ADS_VERSION_CONFLICT", 409);
  if (data.writesEnabled !== undefined) await audit(tx, scope, "ads.account.writes_enabled", account.id, { enabled: data.writesEnabled });
  const row = await tx.adAccount.findFirstOrThrow({ where: { id: account.id, projectId: scope.projectId } });
  return (await toViews(tx, scope, [row]))[0]!;
}

/** Marks the row unlinked and drops its sync state, in one transaction. */
async function markUnlinked(scope: Scope, accountId: string, version: number | null) {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const account = await tx.adAccount.findFirst({ where: { id: accountId, projectId: scope.projectId, status: { not: "unlinked" } } });
    if (!account) throw new DomainError("NOT_FOUND", 404);
    const expected = version ?? account.version;
    if (account.version !== expected) throw new DomainError("ADS_VERSION_CONFLICT", 409);
    const changed = await tx.adAccount.updateMany({
      where: { projectId: scope.projectId, id: account.id, version: expected },
      data: { status: "unlinked", writesEnabled: false, version: { increment: 1 } },
    });
    if (changed.count !== 1) throw new DomainError("ADS_VERSION_CONFLICT", 409);
    await tx.adSyncState.deleteMany({ where: { projectId: scope.projectId, accountId: account.id } });
    await audit(tx, scope, "ads.account.unlinked", account.id, { provider: account.provider, connectionId: account.connectionId });
    return { connectionId: account.connectionId, externalId: account.externalId };
  });
}

/** True when no account of the project that is still linked uses the connection. */
const connectionUnused = (scope: Scope, connectionId: string) =>
  scoped(scope.workspaceId, scope.projectId, async (tx) =>
    (await tx.adAccount.count({ where: { projectId: scope.projectId, connectionId, status: { not: "unlinked" } } })) === 0,
  );

const revokeConnection = (scope: Scope, connectionId: string, reason: string) =>
  revokeProjectConnection(scope, { moduleId: MODULE, connectionId, reason }).catch(quietNotFound);

export async function unlinkAdAccount(
  scope: Scope,
  accountId: string,
  input: { version: number },
): Promise<{ id: string; status: "unlinked"; connectionRevoked: boolean }> {
  const done = await markUnlinked(scope, accountId, input.version);
  await release(scope, done.connectionId, done.externalId);
  const unused = await connectionUnused(scope, done.connectionId);
  if (unused) await revokeConnection(scope, done.connectionId, "no_accounts");
  return { id: accountId, status: "unlinked", connectionRevoked: unused };
}

/** Unlinks every account that uses the connection, then revokes it (its token is wiped). */
export async function revokeAdsConnection(
  scope: Scope,
  connectionId: string,
  /** `audit`: one extra audit row per unlinked account (the data-deletion request records its code). */
  options: { reason?: string; audit?: { action: string; metadata: Record<string, unknown> } } = {},
): Promise<{ id: string; accountsUnlinked: number }> {
  await ownConnection(scope, connectionId, { allowDisabled: true });
  const accounts = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    tx.adAccount.findMany({
      where: { projectId: scope.projectId, connectionId, status: { not: "unlinked" } },
      select: { id: true },
    }),
  );
  for (const account of accounts) {
    const done = await markUnlinked(scope, account.id, null);
    await release(scope, done.connectionId, done.externalId);
    const extra = options.audit;
    if (extra) await scoped(scope.workspaceId, scope.projectId, (tx) => audit(tx, scope, extra.action, account.id, extra.metadata));
  }
  await revokeProjectConnection(scope, { moduleId: MODULE, connectionId, reason: options.reason ?? "revoked_by_owner" });
  return { id: connectionId, accountsUnlinked: accounts.length };
}

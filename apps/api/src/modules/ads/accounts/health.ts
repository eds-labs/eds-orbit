import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { withProjectSecret } from "../../../platform/connections/project-secrets.ts";
import type { PeriodicTask } from "../../../platform/jobs/types.ts";
import { audit, DomainError } from "../../../shared.ts";
import { adsActive } from "../gate.ts";
import { notifyAdsTokenExpiring } from "../notifications.ts";
import { adsProvider } from "../providers/registry.ts";
import { AdsProviderError, type ProviderAccount } from "../providers/types.ts";
import { grantCredentials, markReconnectRequired, type GrantConfig } from "./vault.ts";

// Ad account health (ADR 0025, A3): a read per account proves the stored
// token still works. A refusal marks the account for a reconnect; an outage
// is only recorded and never notifies. Runs on demand and every six hours,
// at most 10 accounts and 30 seconds per project and run, and one scope
// check per connection and run. Codes only: no token, account name or
// provider message reaches an audit row, an event or a notification.

const MODULE = "ads";
const EVERY_MS = 6 * 3_600_000;
const WARN_MS = 14 * 24 * 3_600_000;
const PER_RUN = 10;
const BUDGET_MS = 30_000;
const PROBED = ["active", "disabled", "reconnect_required"];
const connect = () => adsProvider("meta")!.connect!;

export type HealthResult = { ok: true } | { ok: false; code: string };
type Probed = { id: string; connectionId: string; externalId: string; status: string; capability: string };
type Failure = { kind: string; code: string };

const failureOf = (error: unknown): Failure => {
  if (error instanceof AdsProviderError) return { kind: error.failure.kind, code: error.failure.code };
  if (error instanceof DomainError) return { kind: "domain", code: error.code };
  return { kind: "unknown", code: "ADS_HEALTH_FAILED" };
};
const nextRun = () => new Date(Date.now() + EVERY_MS);

/** Moves the health streams on: next check in six hours, the code of the last failure (or none). */
async function touch(tx: DbTx, scope: Scope, ids: string[], code: string | null, extra: { failed?: boolean } = {}) {
  await tx.adSyncState.updateMany({
    where: { projectId: scope.projectId, accountId: { in: ids }, stream: "health" },
    data: { nextRunAt: nextRun(), lastErrorCode: code, ...(extra.failed ? { consecutiveFailures: { increment: 1 } } : {}) },
  });
}

/** A refusal: the accounts that were active wait for a reconnect; those that already do change only their stream. */
async function refuse(scope: Scope, ids: string[], code: string) {
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await markReconnectRequired(tx, scope, ids, code);
    await touch(tx, scope, ids, code);
  });
}

/** An outage or unexpected answer: record only. */
async function outage(scope: Scope, ids: string[], code: string) {
  await scoped(scope.workspaceId, scope.projectId, (tx) => touch(tx, scope, ids, code, { failed: true }));
}

/** A successful read: refreshes the facts and restores an account that waited for a reconnect. */
async function succeed(scope: Scope, account: Probed, read: ProviderAccount) {
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await tx.adAccount.findFirst({ where: { id: account.id, projectId: scope.projectId, status: { not: "unlinked" } } });
    if (!row) return;
    const capability = read.canWrite ? (row.capability === "write_verified" ? "write_verified" : "write_ready") : "read_verified";
    const facts = {
      name: read.name,
      providerStatus: read.providerStatus,
      status: read.status,
      capability,
      spendCapMicros: read.spendCapMicros,
      amountSpentMicros: read.amountSpentMicros,
      // Writing stays allowed only while it is possible.
      writesEnabled: capability === "read_verified" || read.status !== "active" ? false : row.writesEnabled,
    };
    const changed = (Object.keys(facts) as (keyof typeof facts)[]).some((k) => row[k] !== facts[k]);
    if (changed)
      await tx.adAccount.updateMany({
        where: { id: row.id, projectId: scope.projectId, status: { not: "unlinked" } },
        data: { ...facts, version: { increment: 1 } },
      });
    await tx.adSyncState.updateMany({
      where: { projectId: scope.projectId, accountId: row.id, stream: "health" },
      data: { nextRunAt: nextRun(), lastSuccessAt: new Date(), lastErrorCode: null, consecutiveFailures: 0 },
    });
    if (row.status === "reconnect_required") await audit(tx, scope, "ads.account.restored", row.id, {});
  });
}

/** Warns the owners once per expiry date; the claim on the date is taken first, so a repeat stays silent. */
async function warnExpiring(scope: Scope, connectionId: string, expiresAt: string) {
  const claimed = await withProjectSecret(scope, { moduleId: MODULE, connectionId }, async ({ config }) => {
    if (config.expiryWarnedFor === expiresAt) return { result: false };
    return { result: true, config: { expiryWarnedFor: expiresAt } };
  });
  if (!claimed) return;
  try {
    await scoped(scope.workspaceId, scope.projectId, (tx) => notifyAdsTokenExpiring(tx, scope, new Date(expiresAt)));
  } catch (error) {
    // Not told: release the claim so the next run tries again.
    await withProjectSecret(scope, { moduleId: MODULE, connectionId }, async () => ({ result: null, config: { expiryWarnedFor: null } })).catch(() => undefined);
    throw error;
  }
}

/** Checks the accounts of one connection with one scope call. Accounts left unchecked (budget) are not in the map. */
async function checkConnection(
  scope: Scope,
  connectionId: string,
  accounts: Probed[],
  deadline: number,
): Promise<Map<string, HealthResult>> {
  const results = new Map<string, HealthResult>();
  const ids = accounts.map((a) => a.id);
  const refuseAll = async (code: string) => {
    // A refused token is the connection's fault: every account of it flips in
    // one call (the owners hear once), not only those due in this run.
    const all = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.adAccount.findMany({
        where: { projectId: scope.projectId, connectionId, status: { not: "unlinked" } },
        select: { id: true },
      }),
    );
    await refuse(scope, [...new Set([...ids, ...all.map((a) => a.id)])], code);
    for (const id of ids) results.set(id, { ok: false, code });
    return results;
  };
  let credentials: Awaited<ReturnType<typeof grantCredentials>>;
  try {
    credentials = await grantCredentials(scope, connectionId);
  } catch (error) {
    const { code } = failureOf(error);
    if (code === "ADS_ACCOUNT_RECONNECT_REQUIRED") return refuseAll(code);
    if (code === "ADS_CONNECTION_DISABLED") {
      // An administrator's reversible switch: noted on the streams; nothing
      // flips, no failure is counted and nobody is told.
      await scoped(scope.workspaceId, scope.projectId, (tx) => touch(tx, scope, ids, code));
      for (const id of ids) results.set(id, { ok: false, code });
      return results;
    }
    await outage(scope, ids, code);
    for (const id of ids) results.set(id, { ok: false, code });
    return results;
  }
  const config: GrantConfig = credentials.config;
  const expiresAt = config.tokenExpiresAt;
  if (expiresAt !== null) {
    const left = Date.parse(expiresAt) - Date.now();
    if (left <= 0) return refuseAll("ADS_META_TOKEN_EXPIRED");
    if (left <= WARN_MS && config.expiryWarnedFor !== expiresAt) await warnExpiring(scope, connectionId, expiresAt);
  }
  let granted: string[];
  try {
    granted = await connect().scopes({ app: credentials.app, accessToken: credentials.accessToken });
  } catch (error) {
    const failure = failureOf(error);
    if (failure.kind === "auth") return refuseAll("ADS_META_TOKEN_INVALID");
    if (failure.kind === "permission") return refuseAll("ADS_META_PERMISSION_MISSING");
    await outage(scope, ids, failure.code);
    for (const id of ids) results.set(id, { ok: false, code: failure.code });
    return results;
  }
  // `scopes` reports what is granted; no ads permission left is a refusal too.
  if (!granted.includes("ads_read") && !granted.includes("ads_management")) return refuseAll("ADS_META_PERMISSION_MISSING");
  const notGranted: string[] = [];
  for (const account of accounts) {
    if (Date.now() > deadline) break;
    let read: ProviderAccount;
    try {
      read = await connect().readAccount({
        app: credentials.app,
        accessToken: credentials.accessToken,
        grantedScopes: granted,
        externalId: account.externalId,
      });
    } catch (error) {
      const failure = failureOf(error);
      if (failure.kind === "auth" || failure.kind === "permission") {
        notGranted.push(account.id);
        results.set(account.id, { ok: false, code: "ADS_META_ACCOUNT_NOT_GRANTED" });
      } else {
        await outage(scope, [account.id], failure.code);
        results.set(account.id, { ok: false, code: failure.code });
      }
      continue;
    }
    // Outside the provider's try: Orbit's own failure is no outage; it is thrown.
    await succeed(scope, account, read);
    results.set(account.id, { ok: true });
  }
  // One flip call: the owners hear about the refused accounts once.
  if (notGranted.length > 0) await refuse(scope, notGranted, "ADS_META_ACCOUNT_NOT_GRANTED");
  return results;
}

async function checkAccounts(scope: Scope, accounts: Probed[], deadline: number): Promise<Map<string, HealthResult>> {
  const byConnection = new Map<string, Probed[]>();
  for (const account of accounts) byConnection.set(account.connectionId, [...(byConnection.get(account.connectionId) ?? []), account]);
  const results = new Map<string, HealthResult>();
  for (const [connectionId, group] of byConnection) {
    if (Date.now() > deadline) break;
    for (const [id, result] of await checkConnection(scope, connectionId, group, deadline)) results.set(id, result);
  }
  return results;
}

/**
 * Checks one account; never throws for a provider answer. An owner's check
 * (`manual`) also reads an account that awaits a reconnect and restores it
 * when it is readable with the current token.
 */
export async function checkAdAccount(scope: Scope, accountId: string, options: { manual?: boolean } = {}): Promise<HealthResult> {
  const account = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    tx.adAccount.findFirst({
      where: { id: accountId, projectId: scope.projectId, status: { not: "unlinked" } },
      select: { id: true, connectionId: true, externalId: true, status: true, capability: true },
    }),
  );
  if (!account) throw new DomainError("NOT_FOUND", 404);
  if (account.status === "reconnect_required" && options.manual !== true)
    return { ok: false, code: "ADS_ACCOUNT_RECONNECT_REQUIRED" };
  const results = await checkAccounts(scope, [account], Number.POSITIVE_INFINITY);
  return results.get(account.id) ?? { ok: false, code: "ADS_HEALTH_FAILED" };
}

/** The earliest next check of an account the task reads (null when there is none). */
async function earliestCheck(tx: DbTx, scope: Scope): Promise<Date | null> {
  const accounts = await tx.adAccount.findMany({
    where: { projectId: scope.projectId, status: { in: PROBED } },
    select: { id: true },
  });
  if (accounts.length === 0) return null;
  const first = await tx.adSyncState.findFirst({
    where: { projectId: scope.projectId, stream: "health", accountId: { in: accounts.map((a) => a.id) } },
    orderBy: { nextRunAt: "asc" },
    select: { nextRunAt: true },
  });
  return first?.nextRunAt ?? null;
}

export const adsAccountHealth: PeriodicTask = {
  name: "ads-account-health",
  async nextDueAt(tx, scope) {
    if (!(await adsActive(tx, scope))) return null;
    return earliestCheck(tx, scope);
  },
  async run(scope) {
    // The periodic run acts as the system, not as a member.
    const system: Scope = { ...scope, userId: "ads-health", role: "owner" };
    const started = Date.now();
    const due = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      if (!(await adsActive(tx, scope))) return null;
      const streams = await tx.adSyncState.findMany({
        where: { projectId: scope.projectId, stream: "health", nextRunAt: { lte: new Date() } },
        orderBy: { nextRunAt: "asc" },
        take: PER_RUN * 5,
        select: { accountId: true },
      });
      const rows = await tx.adAccount.findMany({
        where: { projectId: scope.projectId, id: { in: streams.map((s) => s.accountId) }, status: { in: PROBED } },
        select: { id: true, connectionId: true, externalId: true, status: true, capability: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      return streams.flatMap((s) => byId.get(s.accountId) ?? []).slice(0, PER_RUN);
    });
    if (due === null) return;
    const results = await checkAccounts(system, due, started + BUDGET_MS);
    const failed = [...results.values()].filter((r) => !r.ok).length;
    const next = await scoped(scope.workspaceId, scope.projectId, (tx) => earliestCheck(tx, scope));
    // Accounts left over (cap or budget) are still due: look again shortly.
    const wakeAt = next ? new Date(Math.max(next.getTime(), Date.now() + 60_000)) : undefined;
    return { status: `checked ${results.size}, failed ${failed}`, ...(wakeAt ? { wakeAt } : {}) };
  },
};

import { authDb, scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { releaseExclusiveConfigValue, revokeProjectConnection } from "../../../platform/connections/project-secrets.ts";
import type { PeriodicTask } from "../../../platform/jobs/types.ts";
import { DomainError } from "../../../shared.ts";
import { adsActive } from "../gate.ts";
import { FORGET_PERSON } from "./vault.ts";

// Clean-up (ADR 0025, A3): OAuth states that expired more than a day ago go;
// a Meta connection that no ad account uses and that holds no claim is
// revoked 24 hours after its creation and 10 minutes after its last change
// (its token is wiped, the person forgotten); a claim on an ad account that
// no row backs is released (a crash between the unlink steps, or a failed
// release after a move).

const PROVIDER = "ads.account.meta";
const MODULE = "ads";
const CLAIM_KEY = "assignedAdAccounts";
const DAY_MS = 24 * 3_600_000;
/** A claim is added just before its account row; connections changed more recently are left alone. */
const CLAIM_GRACE_MS = 10 * 60_000;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const quietNotFound = (error: unknown) => {
  if (error instanceof DomainError && error.code === "NOT_FOUND") return;
  throw error;
};

async function inspect(tx: DbTx, scope: Scope) {
  const connections = await authDb.connection.findMany({
    where: { provider: PROVIDER, scope: "project", workspaceId: scope.workspaceId, projectId: scope.projectId, revokedAt: null },
    select: { id: true, createdAt: true, updatedAt: true, config: true },
  });
  const accounts = await tx.adAccount.findMany({
    where: { projectId: scope.projectId, provider: "meta", status: { not: "unlinked" } },
    select: { connectionId: true, externalId: true },
  });
  const held = new Map<string, Set<string>>();
  for (const a of accounts) held.set(a.connectionId, (held.get(a.connectionId) ?? new Set()).add(a.externalId));
  const unused = connections.filter((c) => !held.has(c.id));
  const stale = connections.flatMap((c) => {
    const values = strings((c.config as Record<string, unknown> | null)?.[CLAIM_KEY]).filter((v) => !held.get(c.id)?.has(v));
    return values.length > 0 ? [{ connectionId: c.id, values, updatedAt: c.updatedAt }] : [];
  });
  return { unused, stale };
}

/**
 * Due-driven (nextDueAt names the next state, connection or claim to handle;
 * the worker also runs it on its other passes of the project): removes old
 * OAuth states, unused connections and claims no account backs.
 */
export const adsOAuthStateCleanup: PeriodicTask = {
  name: "ads-oauth-state-cleanup",
  async nextDueAt(tx, scope) {
    if (!(await adsActive(tx, scope))) return null;
    const times: number[] = [];
    const state = await tx.adOAuthState.findFirst({
      where: { projectId: scope.projectId },
      orderBy: { expiresAt: "asc" },
      select: { expiresAt: true },
    });
    if (state) times.push(state.expiresAt.getTime() + DAY_MS);
    const { unused, stale } = await inspect(tx, scope);
    if (unused.length > 0) times.push(Math.min(...unused.map((c) => Math.max(c.createdAt.getTime() + DAY_MS, c.updatedAt.getTime() + CLAIM_GRACE_MS))));
    if (stale.length > 0) times.push(Math.min(...stale.map((s) => s.updatedAt.getTime())) + CLAIM_GRACE_MS);
    return times.length > 0 ? new Date(Math.min(...times)) : null;
  },
  async run(scope) {
    const system: Scope = { ...scope, userId: "ads-cleanup", role: "owner" };
    const now = Date.now();
    const plan = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      if (!(await adsActive(tx, scope))) return null;
      const removed = await tx.adOAuthState.deleteMany({
        where: { projectId: scope.projectId, expiresAt: { lt: new Date(now - DAY_MS) } },
      });
      return { removed: removed.count, ...(await inspect(tx, scope)) };
    });
    if (!plan) return;
    let revoked = 0;
    const gone = new Set<string>();
    for (const c of plan.unused) {
      // A claim in flight (or just released) updates the connection: wait.
      if (c.createdAt.getTime() > now - DAY_MS || c.updatedAt.getTime() > now - CLAIM_GRACE_MS) continue;
      // Not while it holds a claim: an assignment may be writing its row.
      const result = await revokeProjectConnection(system, {
        moduleId: MODULE,
        connectionId: c.id,
        reason: "unused",
        forget: FORGET_PERSON,
        onlyIfConfigEmpty: CLAIM_KEY,
      }).catch(quietNotFound);
      if (result?.revoked === false) continue;
      gone.add(c.id);
      if (result) revoked++;
    }
    let released = 0;
    for (const s of plan.stale) {
      if (gone.has(s.connectionId) || s.updatedAt.getTime() > now - CLAIM_GRACE_MS) continue;
      for (const value of s.values) {
        await releaseExclusiveConfigValue(system, { moduleId: MODULE, connectionId: s.connectionId, key: CLAIM_KEY, value }).catch(quietNotFound);
        released++;
      }
    }
    return { status: `removed ${plan.removed} states, revoked ${revoked}, released ${released}` };
  },
};

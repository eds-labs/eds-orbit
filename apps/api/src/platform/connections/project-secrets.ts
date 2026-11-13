import { authDb } from "../../../../../packages/db/src/index.ts";
import type { Prisma } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { systemAudit } from "../administration/audit.ts";
import { registeredConnectionProvider } from "../modules/contributions.ts";
import { DomainError } from "../shared.ts";
import { openSecret, sealSecret } from "./secrets.ts";

// Project connections a module manages itself (ADR 0020), such as a social
// account's tokens. The business role may only read connections, so these
// rows are written through the auth role, like channel assignments, and a
// project grant makes them readable inside the project's transaction
// (central.ts connectionSecret). Secret updates take an advisory lock per
// connection, so concurrent token refreshes run one after the other.
// Lock order: the claim lock (claimExclusiveConfigValue), then the
// connection lock. A caller may hold a project transaction when it takes the
// connection lock, but `work` must never open one (scoped() waits for the
// project-wide lock while this auth connection and the lock are held).
// Calling claimExclusiveConfigValue or releaseExclusiveConfigValue from
// inside `work` on the same connection waits for the connection lock this
// call holds, until the 45 s transaction timeout. A `config` returned from
// `work` is merged over the stored one: it overwrites claim keys it names.

export type JsonConfig = Record<string, string | number | boolean | null | string[]>;

const TX = { timeout: 45_000, maxWait: 10_000 };

function managed(provider: string, moduleId: string) {
  const def = registeredConnectionProvider(provider);
  if (!def?.managedByModule || def.owner !== moduleId)
    throw new DomainError("PROVIDER_NOT_MANAGED", 400);
}

/** Creates the connection, its first secret and the project grant. */
export async function createProjectConnection(
  scope: Scope,
  input: {
    moduleId: string;
    provider: string;
    label: string;
    config: JsonConfig;
    secret: string;
    purposes: string[];
  },
): Promise<{ connectionId: string; grantId: string }> {
  managed(input.provider, input.moduleId);
  const sealed = sealSecret(input.secret);
  return authDb.$transaction(async (atx) => {
    const connection = await atx.connection.create({
      data: {
        provider: input.provider,
        scope: "project",
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        label: input.label,
        config: input.config as Prisma.InputJsonValue,
        createdBy: scope.userId,
        secrets: {
          create: { version: 1, ...sealed, state: "active", createdBy: scope.userId },
        },
      },
    });
    const grant = await atx.connectionGrant.create({
      data: {
        connectionId: connection.id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        purposes: input.purposes,
        modules: [input.moduleId],
        createdBy: scope.userId,
      },
    });
    await systemAudit(
      {
        actorId: scope.userId,
        action: "connection.created",
        targetType: "connection",
        targetId: connection.id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        metadata: { provider: input.provider, scope: "project", module: input.moduleId },
      },
      atx,
    );
    return { connectionId: connection.id, grantId: grant.id };
  }, TX);
}

type Locked = Prisma.TransactionClient;

async function owned(
  atx: Locked,
  scope: Scope,
  input: { moduleId: string; connectionId: string },
) {
  const connection = await atx.connection.findFirst({
    where: {
      id: input.connectionId,
      scope: "project",
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      revokedAt: null,
    },
  });
  const def = connection && registeredConnectionProvider(connection.provider);
  if (!connection || !def?.managedByModule || def.owner !== input.moduleId)
    throw new DomainError("NOT_FOUND", 404);
  return connection;
}

/**
 * Runs `work` with the connection's active secret while holding the
 * connection's lock. A returned `secret` becomes the next version (the old
 * one is retired); a returned `config` is merged into the connection.
 */
export async function withProjectSecret<T>(
  scope: Scope,
  input: { moduleId: string; connectionId: string },
  work: (current: {
    secret: string;
    config: JsonConfig;
    secretVersion: number;
  }) => Promise<{ result: T; secret?: string; config?: JsonConfig }>,
): Promise<T> {
  return authDb.$transaction(async (atx) => {
    await atx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`project-secret:${input.connectionId}`}))`;
    const connection = await owned(atx, scope, input);
    const active = await atx.connectionSecret.findFirst({
      where: { connectionId: connection.id, state: "active" },
    });
    if (!active) throw new DomainError("NOT_FOUND", 404);
    const config = connection.config as JsonConfig;
    const next = await work({
      secret: openSecret(active),
      config,
      secretVersion: active.version,
    });
    if (next.secret !== undefined) {
      await atx.connectionSecret.update({
        where: { id: active.id },
        data: { state: "retired", retiredAt: new Date() },
      });
      await atx.connectionSecret.create({
        data: {
          connectionId: connection.id,
          version: active.version + 1,
          ...sealSecret(next.secret),
          state: "active",
          createdBy: scope.userId,
        },
      });
      await systemAudit(
        {
          actorId: scope.userId,
          action: "connection.secret_rotated",
          targetType: "connection",
          targetId: connection.id,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          metadata: { version: active.version + 1 },
        },
        atx,
      );
    }
    if (next.config)
      await atx.connection.update({
        where: { id: connection.id },
        data: {
          config: { ...config, ...next.config } as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
      });
    return next.result;
  }, TX);
}

const CLAIM_KEY = /^[a-zA-Z][a-zA-Z0-9]{1,40}$/;
const CLAIM_VALUE = /^[A-Za-z0-9_:.-]{1,100}$/;
const MAX_CLAIMS = 500;

type ClaimInput = { moduleId: string; connectionId: string; key: string; value: string };

function validClaim(input: ClaimInput) {
  if (!CLAIM_KEY.test(input.key) || !CLAIM_VALUE.test(input.value))
    throw new DomainError("CONNECTION_CLAIM_INVALID", 400);
}

function claimed(config: unknown, key: string): string[] {
  const list = (config as Record<string, unknown> | null)?.[key];
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Exclusive claim of a config value (an ad account, say) across the projects
 * of one organization: the tables of a module cannot be read across projects
 * by the auth role, so the exclusivity lives on the connection's config. The
 * value is appended to `config[key]`; another non-revoked connection (disabled
 * ones keep their claims, since an admin may re-enable them) of the same
 * provider and organization in another project that holds it refuses the
 * claim. Connections of the same project do not block. A disabled connection
 * cannot take new claims; it may still release.
 */
export async function claimExclusiveConfigValue(scope: Scope, input: ClaimInput): Promise<void> {
  validClaim(input);
  await authDb.$transaction(async (atx) => {
    // The provider is needed for the lock name, so read it first; the
    // ownership check below runs again under the locks.
    const probe = await atx.connection.findFirst({
      where: { id: input.connectionId, workspaceId: scope.workspaceId, projectId: scope.projectId },
      select: { provider: true },
    });
    if (!probe) throw new DomainError("NOT_FOUND", 404);
    await atx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`connection-claim:${probe.provider}:${scope.workspaceId}:${input.key}:${input.value}`}))`;
    await atx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`project-secret:${input.connectionId}`}))`;
    const connection = await owned(atx, scope, input);
    if (connection.disabledAt) throw new DomainError("CONNECTION_DISABLED", 409);
    const taken = await atx.connection.findFirst({
      where: {
        provider: connection.provider,
        scope: "project",
        workspaceId: scope.workspaceId,
        projectId: { not: scope.projectId },
        revokedAt: null,
        config: { path: [input.key], array_contains: [input.value] },
      },
      select: { id: true },
    });
    if (taken) throw new DomainError("CONNECTION_VALUE_CLAIMED", 409);
    const current = claimed(connection.config, input.key);
    if (current.includes(input.value)) return;
    if (current.length >= MAX_CLAIMS) throw new DomainError("CONNECTION_CLAIMS_FULL", 409);
    await atx.connection.update({
      where: { id: connection.id },
      data: {
        config: {
          ...(connection.config as JsonConfig),
          [input.key]: [...current, input.value],
        } as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });
    await systemAudit(
      {
        actorId: scope.userId,
        action: "connection.config_claimed",
        targetType: "connection",
        targetId: connection.id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        metadata: { provider: connection.provider, key: input.key },
      },
      atx,
    );
  }, TX);
}

/** Removes a claimed config value; absent values are not an error. */
export async function releaseExclusiveConfigValue(scope: Scope, input: ClaimInput): Promise<void> {
  validClaim(input);
  await authDb.$transaction(async (atx) => {
    await atx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`project-secret:${input.connectionId}`}))`;
    const connection = await owned(atx, scope, input);
    const current = claimed(connection.config, input.key);
    if (!current.includes(input.value)) return;
    await atx.connection.update({
      where: { id: connection.id },
      data: {
        config: {
          ...(connection.config as JsonConfig),
          [input.key]: current.filter((v) => v !== input.value),
        } as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });
    await systemAudit(
      {
        actorId: scope.userId,
        action: "connection.config_released",
        targetType: "connection",
        targetId: connection.id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        metadata: { provider: connection.provider, key: input.key },
      },
      atx,
    );
  }, TX);
}

/**
 * Revokes the connection, retires its secrets and ends the project grant.
 * With `onlyIfConfigEmpty`, the connection is left alone (`revoked: false`)
 * while `config[key]` is a non-empty array, checked under the connection
 * lock: an "unused" revocation cannot race a claim taken just before it.
 */
export async function revokeProjectConnection(
  scope: Scope,
  input: {
    moduleId: string;
    connectionId: string;
    reason: string;
    /**
     * In the same transaction the label becomes this neutral one and the
     * listed config keys become null, so the revoked row no longer names
     * the person. Other config keys stay.
     */
    forget?: { label: string; configKeys: string[] };
    onlyIfConfigEmpty?: string;
  },
): Promise<{ revoked: boolean }> {
  const forget = input.forget;
  if (
    forget &&
    (forget.label.length < 1 ||
      forget.configKeys.length < 1 ||
      forget.configKeys.length > 20 ||
      forget.configKeys.some((k) => k.length < 1))
  )
    throw new DomainError("CONNECTION_FORGET_INVALID", 400);
  return authDb.$transaction(async (atx) => {
    await atx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`project-secret:${input.connectionId}`}))`;
    const connection = await owned(atx, scope, input);
    const kept = (connection.config ?? {}) as Record<string, unknown>;
    if (input.onlyIfConfigEmpty !== undefined) {
      const held = kept[input.onlyIfConfigEmpty];
      if (Array.isArray(held) && held.length > 0) return { revoked: false };
    }
    const now = new Date();
    await atx.connection.update({
      where: { id: connection.id },
      data: {
        revokedAt: now,
        version: { increment: 1 },
        ...(forget
          ? {
              label: forget.label,
              config: {
                ...kept,
                ...Object.fromEntries(forget.configKeys.map((k) => [k, null])),
              } as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
    await atx.connectionSecret.updateMany({
      where: { connectionId: connection.id, state: "active" },
      data: { state: "retired", retiredAt: now },
    });
    // A revoked module-managed connection forgets its tokens (a Page token,
    // for one, never expires): only the version history stays.
    await atx.connectionSecret.updateMany({
      where: { connectionId: connection.id },
      data: { keyId: "wiped", ciphertext: "" },
    });
    await atx.connectionGrant.updateMany({
      where: { connectionId: connection.id, revokedAt: null },
      data: { revokedAt: now, revokedBy: scope.userId },
    });
    await systemAudit(
      {
        actorId: scope.userId,
        action: "connection.revoked",
        targetType: "connection",
        targetId: connection.id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        metadata: { provider: connection.provider, reason: input.reason },
      },
      atx,
    );
    return { revoked: true };
  }, TX);
}

/** Active project connections of a provider whose config has `key = value`. */
export async function projectConnectionsByConfig(
  provider: string,
  key: string,
  value: string,
): Promise<Array<{ connectionId: string; workspaceId: string; projectId: string }>> {
  const rows = await authDb.connection.findMany({
    where: {
      provider,
      scope: "project",
      revokedAt: null,
      config: { path: [key], equals: value },
    },
    select: { id: true, workspaceId: true, projectId: true },
  });
  return rows.map((r) => ({
    connectionId: r.id,
    workspaceId: r.workspaceId!,
    projectId: r.projectId!,
  }));
}

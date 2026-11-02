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

/** Revokes the connection, retires its secrets and ends the project grant. */
export async function revokeProjectConnection(
  scope: Scope,
  input: { moduleId: string; connectionId: string; reason: string },
): Promise<void> {
  await authDb.$transaction(async (atx) => {
    await atx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`project-secret:${input.connectionId}`}))`;
    const connection = await owned(atx, scope, input);
    const now = new Date();
    await atx.connection.update({
      where: { id: connection.id },
      data: { revokedAt: now, version: { increment: 1 } },
    });
    await atx.connectionSecret.updateMany({
      where: { connectionId: connection.id, state: "active" },
      data: { state: "retired", retiredAt: now },
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

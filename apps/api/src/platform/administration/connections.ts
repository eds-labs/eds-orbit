import { z } from "zod";
import {
  authDb,
  type DbTx,
  type Prisma,
} from "../../../../../packages/db/src/index.ts";
import { DomainError } from "../shared.ts";
import {
  providerScopes,
  type ConnectionProvider,
} from "../connections/connections.ts";
import { openSecret, sealSecret } from "../connections/secrets.ts";
import {
  registeredConnectionProvider,
  registeredConnectionProviderIds,
} from "../modules/contributions.ts";
import { systemAudit } from "./audit.ts";

// Central connections and their grants (ADR 0014), managed on the control
// plane. A system connection belongs to the system administrators; an
// organization connection to that organization's owners, and system
// administrators see its metadata but never manage its secret. No answer
// ever contains a secret. Every change is audited with ids and codes only.

export type ConnectionActor =
  | { userId: string; role: "admin" }
  | { userId: string; role: "owner"; workspaceId: string };

const AI_PURPOSES = ["text", "image"];

const configValue = z.union([
  z.string().max(500),
  z.number(),
  z.boolean(),
  z.array(z.string().max(200)).max(50),
]);
export const connectionInput = z
  .object({
    provider: z.string().min(1).max(64),
    label: z.string().trim().min(1).max(100),
    config: z.record(z.string().max(64), configValue).default({}),
    secret: z.string().min(8).max(8000),
    monthlyBudgetMicros: z.number().int().min(0).max(1e13).optional(),
  })
  .strict();
export const connectionUpdate = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    config: z.record(z.string().max(64), configValue).optional(),
    monthlyBudgetMicros: z.number().int().min(0).max(1e13).nullable().optional(),
  })
  .strict();
export const grantInput = z
  .object({
    workspaceId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    purposes: z.array(z.string().min(1).max(32)).max(20).default([]),
    modules: z.array(z.string().min(1).max(64)).max(20).default([]),
    settings: z.record(z.string().max(64), configValue).default({}),
    monthlyBudgetMicros: z.number().int().min(0).max(1e13).optional(),
  })
  .strict();

function provider(id: string): ConnectionProvider {
  const found = registeredConnectionProvider(id);
  if (!found) throw new DomainError("PROVIDER_NOT_FOUND", 404);
  return found;
}

/** Providers a central connection can use, for the administration forms. */
export function centralProviders() {
  return registeredConnectionProviderIds()
    .map((id) => ({ id, def: registeredConnectionProvider(id)! }))
    .filter(({ def }) => providerScopes(def).some((s) => s !== "project"))
    .map(({ id, def }) => ({
      id,
      label: def.label ?? { en: id, de: id },
      scopes: providerScopes(def),
      purposes: def.purposes ?? [],
      checkable: Boolean(def.check),
    }));
}

/** Whether a grant of this provider spends money (E2: budget required). */
const paid = (def: ConnectionProvider) =>
  (def.purposes ?? []).some((p) => AI_PURPOSES.includes(p));

function normalizeConfig(def: ConnectionProvider, config: Record<string, unknown>) {
  const normalize = def.normalizeCentral ?? def.normalize;
  const out = normalize?.(config) ?? config;
  const base = out.baseUrl;
  if (base !== undefined) {
    let url: URL;
    try {
      url = new URL(String(base));
    } catch {
      throw new DomainError("HTTPS_REQUIRED", 400);
    }
    if (url.protocol !== "https:") throw new DomainError("HTTPS_REQUIRED", 400);
  }
  return out as Prisma.InputJsonValue;
}

/** A connection the actor manages; 404 otherwise. */
export async function owned(
  tx: DbTx,
  actor: ConnectionActor,
  id: string,
) {
  const connection = await tx.connection.findFirst({
    where: { id: z.uuid().parse(id), revokedAt: null },
  });
  if (!connection) throw new DomainError("NOT_FOUND", 404);
  const mine =
    actor.role === "admin"
      ? connection.scope === "system"
      : connection.scope === "workspace" &&
        connection.workspaceId === actor.workspaceId;
  if (!mine) throw new DomainError("NOT_FOUND", 404);
  return connection;
}

function view(
  c: Prisma.ConnectionGetPayload<{
    include: { secrets: true; grants: true };
  }>,
) {
  const active = c.secrets.find((s) => s.state === "active");
  return {
    id: c.id,
    provider: c.provider,
    scope: c.scope,
    workspaceId: c.workspaceId,
    label: c.label,
    config: c.config,
    status: c.disabledAt ? "disabled" : c.status,
    health: c.health,
    monthlyBudgetMicros:
      c.monthlyBudgetMicros === null ? null : Number(c.monthlyBudgetMicros),
    secretVersion: active?.version ?? null,
    secretUpdatedAt: active?.createdAt ?? null,
    activeGrants: c.grants.filter((g) => !g.revokedAt).length,
    disabled: Boolean(c.disabledAt),
    createdAt: c.createdAt,
  };
}

/**
 * Connections visible to the actor: administrators see every system and
 * organization connection (metadata); owners see their organization's own
 * connections and the system connections granted to it.
 */
export async function listConnections(
  actor: ConnectionActor,
  filter: { scope?: "system" | "workspace"; workspaceId?: string } = {},
) {
  const where: Prisma.ConnectionWhereInput =
    actor.role === "admin"
      ? {
          revokedAt: null,
          scope: filter.scope ?? { in: ["system", "workspace"] },
          ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
        }
      : {
          revokedAt: null,
          OR: [
            { scope: "workspace", workspaceId: actor.workspaceId },
            {
              scope: "system",
              grants: {
                some: {
                  workspaceId: actor.workspaceId,
                  projectId: null,
                  revokedAt: null,
                },
              },
            },
          ],
        };
  const rows = await authDb.connection.findMany({
    where,
    include: { secrets: true, grants: true },
    orderBy: [{ scope: "asc" }, { label: "asc" }],
  });
  return {
    // An owner sees only its own organization's share of a system connection.
    items: rows.map((row) =>
      actor.role === "admin" || row.scope === "workspace"
        ? view(row)
        : {
            ...view({
              ...row,
              grants: row.grants.filter(
                (g) => g.workspaceId === actor.workspaceId,
              ),
            }),
            monthlyBudgetMicros: null,
          },
    ),
    providers: centralProviders(),
  };
}

/** Creates a system connection (administrators) or an organization one (owners). */
export async function createConnection(actor: ConnectionActor, raw: unknown) {
  const input = connectionInput.parse(raw);
  const def = provider(input.provider);
  const scope = actor.role === "admin" ? "system" : "workspace";
  if (!providerScopes(def).includes(scope))
    throw new DomainError("PROVIDER_SCOPE_NOT_ALLOWED", 409);
  const config = normalizeConfig(def, input.config);
  const sealed = sealSecret(input.secret);
  return authDb.$transaction(async (tx) => {
    const created = await tx.connection.create({
      data: {
        provider: input.provider,
        scope,
        workspaceId: actor.role === "owner" ? actor.workspaceId : null,
        label: input.label,
        config,
        createdBy: actor.userId,
        ...(input.monthlyBudgetMicros !== undefined
          ? { monthlyBudgetMicros: BigInt(input.monthlyBudgetMicros) }
          : {}),
        secrets: {
          create: {
            version: 1,
            ...sealed,
            state: "active",
            createdBy: actor.userId,
          },
        },
      },
      include: { secrets: true, grants: true },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "connection.created",
        targetType: "connection",
        targetId: created.id,
        workspaceId: created.workspaceId,
        metadata: { provider: input.provider, scope },
      },
      tx,
    );
    return view(created);
  });
}

export async function updateConnection(
  actor: ConnectionActor,
  id: string,
  raw: unknown,
) {
  const input = connectionUpdate.parse(raw);
  return authDb.$transaction(async (tx) => {
    const current = await owned(tx, actor, id);
    const def = provider(current.provider);
    const updated = await tx.connection.update({
      where: { id: current.id },
      data: {
        ...(input.label ? { label: input.label } : {}),
        ...(input.config ? { config: normalizeConfig(def, input.config) } : {}),
        ...(input.monthlyBudgetMicros !== undefined
          ? {
              monthlyBudgetMicros:
                input.monthlyBudgetMicros === null
                  ? null
                  : BigInt(input.monthlyBudgetMicros),
            }
          : {}),
        version: { increment: 1 },
      },
      include: { secrets: true, grants: true },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "connection.updated",
        targetType: "connection",
        targetId: current.id,
        workspaceId: current.workspaceId,
        metadata: { fields: Object.keys(input) },
      },
      tx,
    );
    return view(updated);
  });
}

/** Runs a provider check with a plain secret; fields to record on success. */
async function runCheck(
  def: ConnectionProvider,
  connection: { id: string; provider: string; config: unknown },
  secret: string,
) {
  if (!def.check) return null;
  const result = await def.check(
    { ...(connection.config as object), provider: connection.provider },
    secret,
    { connectionId: connection.id },
  );
  return {
    status: typeof result.status === "string" ? result.status : "read_verified",
    health: {
      at: new Date().toISOString(),
      ok: true,
      ...(Array.isArray(result.capabilities)
        ? { capabilities: result.capabilities }
        : {}),
      ...(typeof result.models === "number" ? { models: result.models } : {}),
    },
  };
}

const failureCode = (error: unknown) =>
  error instanceof DomainError ? error.code : "CHECK_FAILED";

/**
 * Replaces the secret. A checkable provider must accept the new secret
 * first; then it becomes active and the old one retired in one step, so
 * users switch on their next transaction without a restart.
 */
export async function rotateSecret(
  actor: ConnectionActor,
  id: string,
  raw: unknown,
) {
  const { secret } = z
    .object({ secret: z.string().min(8).max(8000) })
    .strict()
    .parse(raw);
  const current = await authDb.$transaction((tx) => owned(tx, actor, id));
  const def = provider(current.provider);
  let checked: Awaited<ReturnType<typeof runCheck>>;
  try {
    checked = await runCheck(def, current, secret);
  } catch (error) {
    throw new DomainError(failureCode(error), 409);
  }
  const sealed = sealSecret(secret);
  return authDb.$transaction(async (tx) => {
    await owned(tx, actor, id);
    const latest = await tx.connectionSecret.findFirst({
      where: { connectionId: current.id },
      orderBy: { version: "desc" },
    });
    await tx.connectionSecret.updateMany({
      where: { connectionId: current.id, state: "active" },
      data: { state: "retired", retiredAt: new Date() },
    });
    await tx.connectionSecret.create({
      data: {
        connectionId: current.id,
        version: (latest?.version ?? 0) + 1,
        ...sealed,
        state: "active",
        createdBy: actor.userId,
      },
    });
    const updated = await tx.connection.update({
      where: { id: current.id },
      data: {
        version: { increment: 1 },
        ...(checked
          ? { status: checked.status, health: checked.health }
          : { status: "configured", health: {} }),
      },
      include: { secrets: true, grants: true },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "connection.secret_rotated",
        targetType: "connection",
        targetId: current.id,
        workspaceId: current.workspaceId,
        metadata: { checked: Boolean(checked) },
      },
      tx,
    );
    return view(updated);
  });
}

/** Checks a connection with its active secret and records the result. */
export async function checkConnection(actor: ConnectionActor, id: string) {
  const current = await authDb.$transaction((tx) => owned(tx, actor, id));
  const def = provider(current.provider);
  if (!def.check)
    throw new DomainError(def.checkUnsupported ?? "CONNECTOR_CHECK_UNSUPPORTED", 409);
  const stored = await authDb.connectionSecret.findFirst({
    where: { connectionId: current.id, state: "active" },
  });
  if (!stored) throw new DomainError("SECRET_MISSING", 409);
  let result: { status: string; health: Prisma.InputJsonValue };
  try {
    result = (await runCheck(def, current, openSecret(stored)))!;
  } catch (error) {
    result = {
      status: "failed",
      health: { at: new Date().toISOString(), ok: false, code: failureCode(error) },
    };
  }
  return authDb.$transaction(async (tx) => {
    const updated = await tx.connection.update({
      where: { id: current.id },
      data: { status: result.status, health: result.health },
      include: { secrets: true, grants: true },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "connection.checked",
        targetType: "connection",
        targetId: current.id,
        workspaceId: current.workspaceId,
        metadata: { status: result.status },
      },
      tx,
    );
    return view(updated);
  });
}

/**
 * Disables or enables a connection. Administrators may disable any
 * connection in an emergency; owners their organization's own.
 */
export async function setConnectionDisabled(
  actor: ConnectionActor,
  id: string,
  disabled: boolean,
) {
  return authDb.$transaction(async (tx) => {
    const current =
      actor.role === "admin"
        ? await tx.connection.findFirst({
            where: { id: z.uuid().parse(id), revokedAt: null },
          })
        : await owned(tx, actor, id);
    if (!current) throw new DomainError("NOT_FOUND", 404);
    const updated = await tx.connection.update({
      where: { id: current.id },
      data: { disabledAt: disabled ? new Date() : null, version: { increment: 1 } },
      include: { secrets: true, grants: true },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: disabled ? "connection.disabled" : "connection.enabled",
        targetType: "connection",
        targetId: current.id,
        workspaceId: current.workspaceId,
      },
      tx,
    );
    return view(updated);
  });
}

/** Removes a connection nobody holds a grant for any more. */
export async function removeConnection(actor: ConnectionActor, id: string) {
  await authDb.$transaction(async (tx) => {
    const current = await owned(tx, actor, id);
    const grants = await tx.connectionGrant.count({
      where: { connectionId: current.id, revokedAt: null },
    });
    if (grants) throw new DomainError("CONNECTION_IN_USE", 409);
    await tx.connection.update({
      where: { id: current.id },
      data: { revokedAt: new Date(), disabledAt: new Date() },
    });
    await tx.connectionSecret.updateMany({
      where: { connectionId: current.id, state: { not: "retired" } },
      data: { state: "retired", retiredAt: new Date() },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "connection.removed",
        targetType: "connection",
        targetId: current.id,
        workspaceId: current.workspaceId,
      },
      tx,
    );
  });
  return { removed: true };
}

const grantView = (
  g: Prisma.ConnectionGrantGetPayload<{
    include: { project: { select: { name: true } }; workspace: { select: { name: true } } };
  }>,
) => ({
  id: g.id,
  connectionId: g.connectionId,
  workspaceId: g.workspaceId,
  workspaceName: g.workspace.name,
  projectId: g.projectId,
  projectName: g.project?.name ?? null,
  parentGrantId: g.parentGrantId,
  purposes: g.purposes,
  modules: g.modules,
  settings: g.settings,
  monthlyBudgetMicros:
    g.monthlyBudgetMicros === null ? null : Number(g.monthlyBudgetMicros),
  createdAt: g.createdAt,
});

/** A connection's active grants with this month's spend per grant. */
export async function connectionUsage(actor: ConnectionActor, id: string) {
  const connection = await authDb.connection.findFirst({
    where: { id: z.uuid().parse(id), revokedAt: null },
  });
  if (!connection) throw new DomainError("NOT_FOUND", 404);
  const visible =
    actor.role === "admin" ||
    (connection.scope === "workspace" &&
      connection.workspaceId === actor.workspaceId) ||
    (connection.scope === "system" &&
      (await authDb.connectionGrant.count({
        where: {
          connectionId: connection.id,
          workspaceId: actor.workspaceId,
          revokedAt: null,
        },
      })) > 0);
  if (!visible) throw new DomainError("NOT_FOUND", 404);
  const grants = await authDb.connectionGrant.findMany({
    where: {
      connectionId: connection.id,
      revokedAt: null,
      ...(actor.role === "owner" ? { workspaceId: actor.workspaceId } : {}),
    },
    include: {
      project: { select: { name: true } },
      workspace: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const period = monthStart(new Date());
  const counters = await authDb.spendCounter.findMany({
    where: {
      connectionId: connection.id,
      periodStart: period,
      scopeKey: { in: grants.map((g) => `grant:${g.id}`) },
    },
  });
  return {
    periodStart: period,
    grants: grants.map((g) => {
      const counter = counters.find((c) => c.scopeKey === `grant:${g.id}`);
      return {
        ...grantView(g),
        reservedMicros: Number(counter?.reservedMicros ?? 0),
        settledMicros: Number(counter?.settledMicros ?? 0),
      };
    }),
  };
}

export function monthStart(at: Date) {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/**
 * Grants a connection:
 * - a system connection to an organization (administrators; paid
 *   providers need a monthly budget, E2),
 * - a system connection, already granted to the organization, to one of its
 *   projects (owners or administrators; within the organization grant),
 * - an organization connection to one of its projects (owners).
 */
export async function grantConnection(
  actor: ConnectionActor,
  connectionId: string,
  raw: unknown,
) {
  const input = grantInput.parse(raw);
  return authDb.$transaction(async (tx) => {
    const connection = await tx.connection.findFirst({
      where: { id: z.uuid().parse(connectionId), revokedAt: null },
    });
    if (!connection) throw new DomainError("NOT_FOUND", 404);
    const def = provider(connection.provider);
    const allowed = def.purposes ?? [];
    if (input.purposes.some((p) => allowed.length && !allowed.includes(p)))
      throw new DomainError("PURPOSE_NOT_OFFERED", 400);
    const workspaceId =
      actor.role === "owner" ? actor.workspaceId : input.workspaceId;
    if (!workspaceId) throw new DomainError("WORKSPACE_REQUIRED", 400);
    if (actor.role === "owner" && input.workspaceId && input.workspaceId !== workspaceId)
      throw new DomainError("NOT_FOUND", 404);
    let parentGrantId: string | null = null;
    if (!input.projectId) {
      // Organization grant: only for system connections, by administrators.
      if (connection.scope !== "system" || actor.role !== "admin")
        throw new DomainError("NOT_FOUND", 404);
      if (paid(def) && input.monthlyBudgetMicros === undefined)
        throw new DomainError("ORGANIZATION_BUDGET_REQUIRED", 400);
      if (!(await tx.workspace.findUnique({ where: { id: workspaceId } })))
        throw new DomainError("NOT_FOUND", 404);
    } else {
      const project = await tx.project.findFirst({
        where: { id: input.projectId, workspaceId },
      });
      if (!project) throw new DomainError("NOT_FOUND", 404);
      if (connection.scope === "system") {
        const parent = await tx.connectionGrant.findFirst({
          where: {
            connectionId: connection.id,
            workspaceId,
            projectId: null,
            revokedAt: null,
          },
        });
        if (!parent) throw new DomainError("ORGANIZATION_GRANT_REQUIRED", 409);
        if (
          parent.purposes.length &&
          input.purposes.some((p) => !parent.purposes.includes(p))
        )
          throw new DomainError("PURPOSE_NOT_GRANTED", 409);
        if (
          parent.modules.length &&
          input.modules.some((m) => !parent.modules.includes(m))
        )
          throw new DomainError("MODULE_NOT_GRANTED", 409);
        parentGrantId = parent.id;
      } else if (connection.scope === "workspace") {
        if (connection.workspaceId !== workspaceId)
          throw new DomainError("NOT_FOUND", 404);
        // Administrators never hand out an organization's own connection.
        if (actor.role !== "owner") throw new DomainError("NOT_FOUND", 404);
      } else if (connection.projectId !== input.projectId)
        throw new DomainError("NOT_FOUND", 404);
    }
    // A newer grant for the same consumer replaces the old one.
    await tx.connectionGrant.updateMany({
      where: {
        connectionId: connection.id,
        workspaceId,
        projectId: input.projectId ?? null,
        userId: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date(), revokedBy: actor.userId },
    });
    const created = await tx.connectionGrant.create({
      data: {
        connectionId: connection.id,
        workspaceId,
        projectId: input.projectId ?? null,
        parentGrantId,
        purposes: input.purposes,
        modules: input.modules,
        settings: input.settings as Prisma.InputJsonValue,
        createdBy: actor.userId,
        ...(input.monthlyBudgetMicros !== undefined
          ? { monthlyBudgetMicros: BigInt(input.monthlyBudgetMicros) }
          : {}),
      },
      include: {
        project: { select: { name: true } },
        workspace: { select: { name: true } },
      },
    });
    // Project grants under a replaced organization grant follow it.
    if (!input.projectId)
      await tx.connectionGrant.updateMany({
        where: {
          connectionId: connection.id,
          workspaceId,
          projectId: { not: null },
          revokedAt: null,
        },
        data: { parentGrantId: created.id },
      });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "connection.granted",
        targetType: "grant",
        targetId: created.id,
        workspaceId,
        projectId: input.projectId ?? null,
        metadata: {
          connectionId: connection.id,
          purposes: input.purposes,
          modules: input.modules,
          budget: input.monthlyBudgetMicros !== undefined,
        },
      },
      tx,
    );
    return grantView(created);
  });
}

/** Revokes a grant; revoking an organization grant revokes its project grants. */
export async function revokeConnectionGrant(
  actor: ConnectionActor,
  grantId: string,
) {
  await authDb.$transaction(async (tx) => {
    const grant = await tx.connectionGrant.findFirst({
      where: { id: z.uuid().parse(grantId), revokedAt: null },
      include: { connection: true },
    });
    if (!grant) throw new DomainError("NOT_FOUND", 404);
    const allowed =
      actor.role === "admin"
        ? grant.connection.scope === "system"
        : grant.workspaceId === actor.workspaceId && grant.projectId !== null;
    if (!allowed) throw new DomainError("NOT_FOUND", 404);
    const now = new Date();
    await tx.connectionGrant.updateMany({
      where: {
        OR: [{ id: grant.id }, { parentGrantId: grant.id }],
        revokedAt: null,
      },
      data: { revokedAt: now, revokedBy: actor.userId },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "connection.grant_revoked",
        targetType: "grant",
        targetId: grant.id,
        workspaceId: grant.workspaceId,
        projectId: grant.projectId,
        metadata: { connectionId: grant.connectionId },
      },
      tx,
    );
  });
  return { revoked: true };
}

/** The connections a project may choose from (names and purposes only). */
export async function projectConnections(workspaceId: string, projectId: string) {
  const grants = await authDb.connectionGrant.findMany({
    where: {
      workspaceId,
      projectId,
      revokedAt: null,
      userId: null,
      connection: { revokedAt: null, disabledAt: null },
    },
    include: { connection: true },
  });
  return {
    items: grants.map((g) => ({
      grantId: g.id,
      connectionId: g.connectionId,
      provider: g.connection.provider,
      scope: g.connection.scope,
      label: g.connection.label,
      status: g.connection.status,
      purposes: g.purposes,
      modules: g.modules,
    })),
  };
}

export const workflowInput = z
  .object({
    contract: z.enum(["automation.v1", "customer_context.v1"]),
    workflowRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/_-]{0,199}$/),
    label: z.string().trim().min(1).max(100),
  })
  .strict();

/** The workflows bound to an automation connection the actor manages. */
export async function listWorkflows(actor: ConnectionActor, connectionId: string) {
  const connection = await authDb.$transaction((tx) => owned(tx, actor, connectionId));
  const rows = await authDb.workflowBinding.findMany({
    where: { connectionId: connection.id, revokedAt: null },
    orderBy: { createdAt: "asc" },
  });
  return {
    items: rows.map((b) => ({
      id: b.id,
      contract: b.contract,
      workflowRef: b.workflowRef,
      label: b.label,
      createdAt: b.createdAt,
    })),
  };
}

export async function bindWorkflow(
  actor: ConnectionActor,
  connectionId: string,
  raw: unknown,
) {
  const input = workflowInput.parse(raw);
  return authDb.$transaction(async (tx) => {
    const connection = await owned(tx, actor, connectionId);
    if (!(provider(connection.provider).purposes ?? []).includes("automation"))
      throw new DomainError("NOT_AN_AUTOMATION_CONNECTION", 409);
    const binding = await tx.workflowBinding.create({
      data: { connectionId: connection.id, ...input, createdBy: actor.userId },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "workflow.bound",
        targetType: "connection",
        targetId: connection.id,
        workspaceId: connection.workspaceId,
        metadata: { bindingId: binding.id, contract: input.contract },
      },
      tx,
    );
    return binding;
  });
}

export async function unbindWorkflow(actor: ConnectionActor, bindingId: string) {
  await authDb.$transaction(async (tx) => {
    const binding = await tx.workflowBinding.findFirst({
      where: { id: z.uuid().parse(bindingId), revokedAt: null },
    });
    if (!binding) throw new DomainError("NOT_FOUND", 404);
    const connection = await owned(tx, actor, binding.connectionId);
    await tx.workflowBinding.update({
      where: { id: binding.id },
      data: { revokedAt: new Date() },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "workflow.unbound",
        targetType: "connection",
        targetId: connection.id,
        workspaceId: connection.workspaceId,
        metadata: { bindingId: binding.id },
      },
      tx,
    );
  });
  return { removed: true };
}

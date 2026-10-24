import { z } from "zod";
import { authDb, scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, create, data, DomainError, list, update } from "../shared.ts";
import { systemAudit } from "../administration/audit.ts";
import type { ConnectionActor } from "../administration/connections.ts";
import { registeredConnectionProvider } from "../modules/contributions.ts";
import { assertModuleEnabled } from "../modules/enforcement.ts";
import {
  CONNECTION_KIND,
  connectionVerified,
  cutoverEnabled,
} from "./connections.ts";

// Channel assignment of a central connection (ADR 0014): a provider whose
// check lists channels (Postiz: social accounts) is connected once for the
// organization, and its owners hand each channel to exactly one project.
// The project grant carries the project's channels (`settings.channels`);
// the project's bound connection mirrors them as `allowedChannelIds`, which
// the owning module reads. A project without channels loses its grant.
// Changes narrow the projects first, then the grants, then widen the
// projects, so a failure never leaves a project with more than it holds.

const CHANNEL_ID = /^[A-Za-z0-9_-]{1,200}$/;

export const channelAssignmentInput = z
  .object({
    workspaceId: z.uuid().optional(),
    // Channel id -> project id; a channel left out is unassigned.
    assignments: z
      .record(z.string().regex(CHANNEL_ID), z.uuid())
      .refine((m) => Object.keys(m).length <= 200, "too many channels"),
  })
  .strict();

type Channel = { id: string; name: string; identifier: string; disabled: boolean };

const channelsOf = (health: unknown): Channel[] => {
  const list = (health as { channels?: unknown } | null)?.channels;
  return Array.isArray(list) ? (list as Channel[]) : [];
};
const grantChannels = (settings: unknown): string[] => {
  const ids = (settings as { channels?: unknown } | null)?.channels;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
};

/**
 * The connection the actor may assign channels of, in `workspaceId`:
 * an organization's own connection (its owners), or a system connection
 * granted to the organization (its owners and administrators).
 */
async function assignable(
  tx: Pick<DbTx, "connection" | "connectionGrant">,
  actor: ConnectionActor,
  connectionId: string,
  workspaceId: string,
) {
  const connection = await tx.connection.findFirst({
    where: { id: z.uuid().parse(connectionId), revokedAt: null },
  });
  if (!connection) throw new DomainError("NOT_FOUND", 404);
  const orgGrant =
    connection.scope === "system"
      ? await tx.connectionGrant.findFirst({
          where: {
            connectionId: connection.id,
            workspaceId,
            projectId: null,
            revokedAt: null,
          },
        })
      : null;
  const allowed =
    actor.role === "admin"
      ? connection.scope === "system" && !!orgGrant
      : (connection.scope === "workspace" && connection.workspaceId === workspaceId) ||
        (connection.scope === "system" && !!orgGrant);
  if (!allowed) throw new DomainError("NOT_FOUND", 404);
  const def = registeredConnectionProvider(connection.provider);
  if (!def?.channelAssignment)
    throw new DomainError("CHANNELS_NOT_SUPPORTED", 409);
  return { connection, orgGrant, def };
}

const workspaceOf = (actor: ConnectionActor, requested?: string) => {
  const workspaceId = actor.role === "owner" ? actor.workspaceId : requested;
  if (!workspaceId) throw new DomainError("WORKSPACE_REQUIRED", 400);
  if (actor.role === "owner" && requested && requested !== workspaceId)
    throw new DomainError("NOT_FOUND", 404);
  return workspaceId;
};

/** The connection's channels, the organization's projects and who has what. */
export async function channelAssignments(
  actor: ConnectionActor,
  connectionId: string,
  requestedWorkspaceId?: string,
) {
  const workspaceId = workspaceOf(actor, requestedWorkspaceId);
  const { connection } = await assignable(authDb, actor, connectionId, workspaceId);
  const [projects, grants] = await Promise.all([
    authDb.project.findMany({
      where: { workspaceId, kind: "project" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    authDb.connectionGrant.findMany({
      where: { connectionId: connection.id, projectId: { not: null }, revokedAt: null },
      select: { workspaceId: true, projectId: true, settings: true },
    }),
  ]);
  const assignments: Record<string, string> = {};
  const elsewhere: string[] = [];
  for (const g of grants)
    for (const id of grantChannels(g.settings))
      if (g.workspaceId === workspaceId) assignments[id] = g.projectId!;
      else elsewhere.push(id);
  return {
    connectionId: connection.id,
    workspaceId,
    cutover: cutoverEnabled(connection.provider),
    checkedAt: (connection.health as { at?: string } | null)?.at ?? null,
    channels: channelsOf(connection.health),
    projects,
    assignments,
    // Channels another organization's project holds (system connections).
    unavailable: [...new Set(elsewhere)].sort(),
  };
}

/**
 * Replaces the organization's channel assignment of one connection. Every
 * channel goes to at most one project, across all organizations sharing a
 * system connection; the check holds under a lock per connection.
 */
export async function assignChannels(
  actor: ConnectionActor,
  connectionId: string,
  raw: unknown,
) {
  const input = channelAssignmentInput.parse(raw);
  const workspaceId = workspaceOf(actor, input.workspaceId);
  const { connection } = await assignable(authDb, actor, connectionId, workspaceId);
  if (!cutoverEnabled(connection.provider))
    throw new DomainError("CUTOVER_NOT_ENABLED", 409);
  if (connection.disabledAt) throw new DomainError("CONNECTION_DISABLED", 409);
  const catalog = channelsOf(connection.health);
  const usable = new Set(catalog.filter((c) => !c.disabled).map((c) => c.id));
  if (Object.keys(input.assignments).some((id) => !usable.has(id)))
    throw new DomainError("CHANNEL_UNKNOWN", 409);
  const projectIds = [...new Set(Object.values(input.assignments))];
  const projects = await authDb.project.findMany({
    where: { id: { in: projectIds }, workspaceId, kind: "project" },
    select: { id: true },
  });
  if (projects.length !== projectIds.length) throw new DomainError("NOT_FOUND", 404);
  const desired = new Map<string, string[]>();
  for (const [channel, project] of Object.entries(input.assignments))
    desired.set(project, [...(desired.get(project) ?? []), channel].sort());

  const current = await authDb.connectionGrant.findMany({
    where: { connectionId: connection.id, workspaceId, projectId: { not: null }, revokedAt: null },
  });
  const before = new Map(current.map((g) => [g.projectId!, grantChannels(g.settings)]));
  const touched = [...new Set([...before.keys(), ...desired.keys()])];

  // 1. Narrow: projects lose channels before their grants do.
  for (const projectId of touched) {
    const keep = desired.get(projectId) ?? [];
    if ((before.get(projectId) ?? []).some((id) => !keep.includes(id)))
      await mirror(actor, workspaceId, projectId, connection, catalog, keep, false);
  }

  // 2. Grants, exclusive per channel across organizations.
  await authDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`channels:${connection.id}`}))`;
    const { orgGrant } = await assignable(tx, actor, connection.id, workspaceId);
    const others = await tx.connectionGrant.findMany({
      where: {
        connectionId: connection.id,
        workspaceId: { not: workspaceId },
        projectId: { not: null },
        revokedAt: null,
      },
      select: { settings: true },
    });
    const taken = new Set(others.flatMap((g) => grantChannels(g.settings)));
    if (Object.keys(input.assignments).some((id) => taken.has(id)))
      throw new DomainError("CHANNEL_ASSIGNED_ELSEWHERE", 409);
    const grants = await tx.connectionGrant.findMany({
      where: { connectionId: connection.id, workspaceId, projectId: { not: null }, revokedAt: null },
    });
    for (const projectId of touched) {
      const channels = desired.get(projectId) ?? [];
      const grant = grants.find((g) => g.projectId === projectId);
      if (!channels.length) {
        if (grant)
          await tx.connectionGrant.update({
            where: { id: grant.id },
            data: { revokedAt: new Date(), revokedBy: actor.userId },
          });
      } else if (grant)
        await tx.connectionGrant.update({
          where: { id: grant.id },
          data: { settings: { ...(grant.settings as object), channels } },
        });
      else
        await tx.connectionGrant.create({
          data: {
            connectionId: connection.id,
            workspaceId,
            projectId,
            parentGrantId: orgGrant?.id ?? null,
            settings: { channels },
            createdBy: actor.userId,
          },
        });
    }
    await systemAudit(
      {
        actorId: actor.userId,
        action: "connection.channels_assigned",
        targetType: "connection",
        targetId: connection.id,
        workspaceId,
        metadata: { projects: desired.size, channels: Object.keys(input.assignments).length },
      },
      tx,
    );
  });

  // 3. Widen: bind each project with channels and give it its channels.
  const attached: Record<string, boolean> = {};
  for (const [projectId, channels] of desired)
    attached[projectId] = await mirror(
      actor,
      workspaceId,
      projectId,
      connection,
      catalog,
      channels,
      true,
    );
  return { ...(await channelAssignments(actor, connection.id, workspaceId)), attached };
}

/**
 * Mirrors a project's channels onto its bound connection; with `bind`,
 * creates the binding when the owning module is on. False when the project
 * has no binding (yet).
 */
async function mirror(
  actor: ConnectionActor,
  workspaceId: string,
  projectId: string,
  connection: { id: string; provider: string; config: unknown; status: string },
  catalog: Channel[],
  channels: string[],
  bind: boolean,
) {
  const scope = { workspaceId, projectId, userId: actor.userId, role: "owner" } as Scope;
  const def = registeredConnectionProvider(connection.provider)!;
  return scoped(workspaceId, projectId, async (tx) => {
    const fields = {
      channels: catalog.filter((c) => channels.includes(c.id)),
      allowedChannelIds: channels,
    };
    const row = (await list(tx, scope, CONNECTION_KIND)).find(
      (r) => data(r).centralConnectionId === connection.id,
    );
    if (row) {
      await update(tx, scope, row, { ...data(row), ...fields });
      await audit(tx, scope, "connector.channels_assigned", row.id, {
        connectionId: connection.id,
        channels,
      });
      return true;
    }
    if (!bind || !channels.length) return false;
    try {
      await assertModuleEnabled(tx, scope, (def as { owner?: string }).owner ?? "");
    } catch {
      return false;
    }
    const created = await create(tx, scope, CONNECTION_KIND, {
      ...(connection.config as object),
      provider: connection.provider,
      centralConnectionId: connection.id,
      status: connectionVerified(connection.status) ? "read_verified" : "configured",
      capabilities: [],
      ...fields,
    });
    await audit(tx, scope, "connector.attached", created.id, {
      provider: connection.provider,
      connectionId: connection.id,
      channels,
    });
    return true;
  });
}

/**
 * The connection actor a user is in an organization: a system
 * administrator, else an owner of it; null for everyone else.
 */
export async function organizationActor(
  userId: string,
  workspaceId: string,
): Promise<ConnectionActor | null> {
  const user = await authDb.user.findFirst({
    where: { id: userId, role: "admin", banned: false },
    select: { id: true },
  });
  if (user) return { userId, role: "admin" };
  const owner = await authDb.workspaceMember.findFirst({
    where: { workspaceId, userId, role: "owner" },
    select: { userId: true },
  });
  return owner ? { userId, role: "owner", workspaceId } : null;
}

/**
 * The central channel connections an organization manager could give this
 * project channels of, with each channel's holder: this project, another
 * project (never offered), or free. Empty for other members.
 */
export async function projectChannelOptions(scope: Scope) {
  const actor = await organizationActor(scope.userId, scope.workspaceId);
  if (!actor) return [];
  const candidates = await authDb.connection.findMany({
    where: {
      revokedAt: null,
      OR: [
        { scope: "workspace", workspaceId: scope.workspaceId },
        {
          scope: "system",
          grants: {
            some: { workspaceId: scope.workspaceId, projectId: null, revokedAt: null },
          },
        },
      ],
    },
  });
  const out = [];
  for (const connection of candidates) {
    if (!registeredConnectionProvider(connection.provider)?.channelAssignment) continue;
    try {
      await assignable(authDb, actor, connection.id, scope.workspaceId);
    } catch {
      continue;
    }
    const grants = await authDb.connectionGrant.findMany({
      where: { connectionId: connection.id, projectId: { not: null }, revokedAt: null },
      select: { projectId: true, settings: true },
    });
    const holder = new Map<string, string>();
    for (const g of grants)
      for (const id of grantChannels(g.settings)) holder.set(id, g.projectId!);
    out.push({
      connectionId: connection.id,
      provider: connection.provider,
      label: connection.label,
      status: connection.status,
      disabled: Boolean(connection.disabledAt),
      cutover: cutoverEnabled(connection.provider),
      channels: channelsOf(connection.health).map((c) => ({
        id: c.id,
        name: c.name,
        platform: c.identifier,
        disabled: c.disabled,
        holder: !holder.has(c.id)
          ? "free"
          : holder.get(c.id) === scope.projectId
            ? "this_project"
            : "other_project",
      })),
    });
  }
  return out;
}

/**
 * Gives the project more channels of a central connection from inside its
 * own transaction (MCP administration): free channels or the project's own
 * only, never another project's. The grant is widened first under the
 * connection's lock, then the project's bound connection mirrors it, so a
 * failure leaves the project with no more than it holds.
 */
export async function grantChannelsToProject(
  tx: DbTx,
  scope: Scope,
  actor: ConnectionActor,
  connectionId: string,
  channelIds: string[],
) {
  const workspaceId = scope.workspaceId;
  const { connection } = await assignable(authDb, actor, connectionId, workspaceId);
  if (!cutoverEnabled(connection.provider))
    throw new DomainError("CUTOVER_NOT_ENABLED", 409);
  if (connection.disabledAt) throw new DomainError("CONNECTION_DISABLED", 409);
  const catalog = channelsOf(connection.health);
  const usable = new Set(catalog.filter((c) => !c.disabled).map((c) => c.id));
  if (channelIds.some((id) => !usable.has(id)))
    throw new DomainError("CHANNEL_UNKNOWN", 409);
  let channels: string[] = [];
  await authDb.$transaction(async (atx) => {
    await atx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`channels:${connection.id}`}))`;
    const { orgGrant } = await assignable(atx, actor, connection.id, workspaceId);
    const grants = await atx.connectionGrant.findMany({
      where: { connectionId: connection.id, projectId: { not: null }, revokedAt: null },
    });
    const own = grants.find(
      (g) => g.workspaceId === workspaceId && g.projectId === scope.projectId,
    );
    const taken = new Set(
      grants.filter((g) => g !== own).flatMap((g) => grantChannels(g.settings)),
    );
    if (channelIds.some((id) => taken.has(id)))
      throw new DomainError("CHANNEL_ASSIGNED_ELSEWHERE", 409);
    channels = [...new Set([...grantChannels(own?.settings), ...channelIds])].sort();
    if (own)
      await atx.connectionGrant.update({
        where: { id: own.id },
        data: { settings: { ...(own.settings as object), channels } },
      });
    else
      await atx.connectionGrant.create({
        data: {
          connectionId: connection.id,
          workspaceId,
          projectId: scope.projectId,
          parentGrantId: orgGrant?.id ?? null,
          settings: { channels },
          createdBy: actor.userId,
        },
      });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "connection.channels_assigned",
        targetType: "connection",
        targetId: connection.id,
        workspaceId,
        metadata: { projects: 1, channels: channels.length, source: "mcp" },
      },
      atx,
    );
  });
  const fields = {
    channels: catalog.filter((c) => channels.includes(c.id)),
    allowedChannelIds: channels,
  };
  const row = (await list(tx, scope, CONNECTION_KIND)).find(
    (r) => data(r).centralConnectionId === connection.id,
  );
  if (row) {
    await update(tx, scope, row, { ...data(row), ...fields });
    await audit(tx, scope, "connector.channels_assigned", row.id, {
      connectionId: connection.id,
      channels,
    });
    return { connectorId: row.id, connectionId: connection.id, channels };
  }
  const def = registeredConnectionProvider(connection.provider)!;
  await assertModuleEnabled(tx, scope, (def as { owner?: string }).owner ?? "");
  const created = await create(tx, scope, CONNECTION_KIND, {
    ...(connection.config as object),
    provider: connection.provider,
    centralConnectionId: connection.id,
    status: connectionVerified(connection.status) ? "read_verified" : "configured",
    capabilities: [],
    ...fields,
  });
  await audit(tx, scope, "connector.attached", created.id, {
    provider: connection.provider,
    connectionId: connection.id,
    channels,
  });
  return { connectorId: created.id, connectionId: connection.id, channels };
}

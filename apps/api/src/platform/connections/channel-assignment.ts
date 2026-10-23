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

import { createHmac } from "node:crypto";
import { authDb, scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, data, DomainError, list, update } from "../shared.ts";
import { systemAudit } from "../administration/audit.ts";
import { channelCatalog } from "../administration/connections.ts";
import { registeredConnectionProvider } from "../modules/contributions.ts";
import { CONNECTION_KIND, decryptCredential } from "./connections.ts";
import { sealSecret } from "./secrets.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";

// Moving project connections to central ones (ADR 0014, WP3.5). Nothing
// here runs on its own: an operator runs the scripts, which default to a
// dry run. Keys are never printed; a keyed fingerprint (HMAC with the
// master key) tells which projects hold the same key. A project's own key
// is kept on its connection, so a rollback only unbinds it again.

const ACTOR = "system:migration";

/** A keyed fingerprint of a plain secret: equal keys, equal prints. */
export function fingerprint(plain: string) {
  return createHmac("sha256", loadConfig().CREDENTIAL_KEY)
    .update(plain)
    .digest("hex")
    .slice(0, 12);
}

export type InventoryRow = {
  workspaceId: string;
  projectId: string;
  projectName: string;
  connectorId: string;
  provider: string;
  status: string;
  baseUrl: string | null;
  ownKey: boolean;
  fingerprint: string | null;
  centralConnectionId: string | null;
  /** The channels the project uses, for providers with channel assignment. */
  channelIds: string[];
};

const hasChannels = (provider: string) =>
  Boolean(registeredConnectionProvider(provider)?.channelAssignment);

/** Every project connection with its key fingerprint; read-only. */
export async function connectionInventory(filter: { workspaceId?: string } = {}) {
  const projects = await authDb.project.findMany({
    where: filter.workspaceId ? { workspaceId: filter.workspaceId } : {},
    select: { id: true, name: true, workspaceId: true },
    orderBy: { createdAt: "asc" },
  });
  const rows: InventoryRow[] = [];
  for (const project of projects) {
    const scope = {
      workspaceId: project.workspaceId,
      projectId: project.id,
    } as Scope;
    const connectors = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      list(tx, scope, CONNECTION_KIND),
    );
    for (const row of connectors) {
      const d = data(row);
      let print: string | null = null;
      if (d.encryptedCredential)
        try {
          print = fingerprint(decryptCredential(d));
        } catch {
          print = "unreadable";
        }
      rows.push({
        workspaceId: project.workspaceId,
        projectId: project.id,
        projectName: project.name,
        connectorId: row.id,
        provider: String(d.provider),
        status: String(d.status ?? ""),
        baseUrl: typeof d.baseUrl === "string" ? d.baseUrl : null,
        ownKey: Boolean(d.encryptedCredential),
        fingerprint: print,
        centralConnectionId: (d.centralConnectionId as string) ?? null,
        channelIds:
          hasChannels(String(d.provider)) && Array.isArray(d.assignedIntegrationIds)
            ? (d.assignedIntegrationIds as string[]).filter((x) => typeof x === "string")
            : [],
      });
    }
  }
  // Groups of projects in one organization that share a key.
  const shared = new Map<string, InventoryRow[]>();
  for (const row of rows)
    if (row.fingerprint && row.fingerprint !== "unreadable") {
      const key = `${row.workspaceId}:${row.provider}:${row.fingerprint}`;
      shared.set(key, [...(shared.get(key) ?? []), row]);
    }
  return {
    rows,
    candidates: [...shared.values()]
      .filter((group) => group.length > 1)
      .map((group) => ({
        workspaceId: group[0]!.workspaceId,
        provider: group[0]!.provider,
        fingerprint: group[0]!.fingerprint,
        projects: group.map((g) => ({
          projectId: g.projectId,
          connectorId: g.connectorId,
        })),
      })),
  };
}

export type ConsolidationPlan = {
  workspaceId: string;
  provider: string;
  source: { projectId: string; connectorId: string };
  /** Each project's channels; a channel goes to the first project using it. */
  bind: Array<{ projectId: string; connectorId: string; channels: string[] }>;
  skipped: Array<{ projectId: string; connectorId: string; reason: string }>;
  /** Channels several projects used; only the first one keeps them. */
  channelConflicts: Array<{ channelId: string; projectIds: string[] }>;
};

/**
 * Plans one organization connection from a project's key, bound to the
 * projects that hold the same key (or that are named explicitly and have
 * no key of their own). Never across organizations.
 */
export async function planConsolidation(input: {
  workspaceId: string;
  provider: string;
  sourceConnectorId: string;
  projectIds?: string[];
}): Promise<ConsolidationPlan> {
  const { rows } = await connectionInventory({ workspaceId: input.workspaceId });
  const ofProvider = rows.filter(
    (r) => r.provider === input.provider && !r.centralConnectionId,
  );
  const source = ofProvider.find((r) => r.connectorId === input.sourceConnectorId);
  if (!source?.fingerprint || source.fingerprint === "unreadable")
    throw new DomainError("SOURCE_CONNECTION_NOT_FOUND", 404);
  const bind: ConsolidationPlan["bind"] = [];
  const skipped: ConsolidationPlan["skipped"] = [];
  const owners = new Map<string, string[]>();
  // The source project first, so it keeps its channels.
  // The source first, then per project its most useful connection: one
  // that a check verified and that has channels.
  const rank = (r: InventoryRow) =>
    (/verified/.test(r.status) ? 2 : 0) + (r.channelIds.length ? 1 : 0);
  const ordered = [
    source,
    ...ofProvider.filter((r) => r !== source).sort((a, b) => rank(b) - rank(a)),
  ];
  for (const row of ordered) {
    const named = input.projectIds?.includes(row.projectId);
    if (input.projectIds && !named && row.connectorId !== source.connectorId)
      continue;
    // A project is bound with one connection; a second one of the same
    // provider (an older duplicate) keeps its own key and stays as it is.
    if (bind.some((b) => b.projectId === row.projectId)) {
      skipped.push({
        projectId: row.projectId,
        connectorId: row.connectorId,
        reason: "project_already_bound",
      });
      continue;
    }
    if (row.fingerprint === source.fingerprint) {
      const channels: string[] = [];
      for (const id of row.channelIds) {
        const users = owners.get(id) ?? [];
        if (!users.length) channels.push(id);
        owners.set(id, [...users, row.projectId]);
      }
      bind.push({
        projectId: row.projectId,
        connectorId: row.connectorId,
        channels: channels.sort(),
      });
    }
    else
      skipped.push({
        projectId: row.projectId,
        connectorId: row.connectorId,
        reason: row.ownKey ? "different_key" : "no_key",
      });
  }
  return {
    workspaceId: input.workspaceId,
    provider: input.provider,
    source: { projectId: source.projectId, connectorId: source.connectorId },
    bind,
    skipped,
    channelConflicts: [...owners]
      .filter(([, projects]) => projects.length > 1)
      .map(([channelId, projectIds]) => ({ channelId, projectIds })),
  };
}

/**
 * Applies a plan: creates the organization connection from the source's
 * key, grants it to every bound project and binds their connections. The
 * projects keep their own keys, so `rollbackConsolidation` can undo it.
 */
export async function applyConsolidation(plan: ConsolidationPlan, label: string) {
  const sourceScope = {
    workspaceId: plan.workspaceId,
    projectId: plan.source.projectId,
  } as Scope;
  const source = await scoped(sourceScope.workspaceId, sourceScope.projectId, (tx) =>
    list(tx, sourceScope, CONNECTION_KIND),
  ).then((rows) => rows.find((r) => r.id === plan.source.connectorId));
  if (!source) throw new DomainError("SOURCE_CONNECTION_NOT_FOUND", 404);
  const d = data(source);
  const plain = decryptCredential(d);
  const config: Record<string, unknown> = {};
  for (const key of ["baseUrl", "sourceSystem", "timeoutMs"])
    if (d[key] !== undefined) config[key] = d[key];
  const channels = hasChannels(plan.provider);
  const connection = await authDb.$transaction(async (tx) => {
    const created = await tx.connection.create({
      data: {
        provider: plan.provider,
        scope: "workspace",
        workspaceId: plan.workspaceId,
        label,
        config: config as never,
        status: String(d.status ?? "configured"),
        // The source's known channels, to assign them centrally later.
        ...(channels && Array.isArray(d.channels)
          ? {
              health: {
                at: String(d.verifiedAt ?? new Date().toISOString()),
                ok: true,
                channels: channelCatalog(d.channels),
              },
            }
          : {}),
        createdBy: ACTOR,
        legacyRef: { connectorId: source.id, projectId: plan.source.projectId },
        secrets: {
          create: { version: 1, ...sealSecret(plain), state: "active", createdBy: ACTOR },
        },
      },
    });
    for (const target of plan.bind)
      await tx.connectionGrant.create({
        data: {
          connectionId: created.id,
          workspaceId: plan.workspaceId,
          projectId: target.projectId,
          ...(channels ? { settings: { channels: target.channels } } : {}),
          createdBy: ACTOR,
        },
      });
    await systemAudit(
      {
        actorId: ACTOR,
        action: "connection.consolidated",
        targetType: "connection",
        targetId: created.id,
        workspaceId: plan.workspaceId,
        metadata: { provider: plan.provider, projects: plan.bind.map((b) => b.projectId) },
      },
      tx,
    );
    return created;
  });
  for (const target of plan.bind) {
    const scope = {
      workspaceId: plan.workspaceId,
      projectId: target.projectId,
      userId: ACTOR,
      role: "owner",
    } as Scope;
    await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const row = (await list(tx, scope, CONNECTION_KIND)).find(
        (r) => r.id === target.connectorId,
      );
      if (!row) return;
      await update(tx, scope, row, {
        ...data(row),
        centralConnectionId: connection.id,
        ...(channels ? { allowedChannelIds: target.channels } : {}),
        adoptedAt: new Date().toISOString(),
      });
      await audit(tx, scope, "connector.adopted", row.id, {
        connectionId: connection.id,
      });
    });
  }
  return { connectionId: connection.id, bound: plan.bind.length };
}

/**
 * Undoes a consolidation: unbinds every project connection that kept its
 * own key, revokes the grants and disables the central connection. A bound
 * project without its own key is reported, never left half-working.
 */
export async function rollbackConsolidation(connectionId: string) {
  const connection = await authDb.connection.findFirst({
    where: { id: connectionId, scope: "workspace" },
    include: { grants: true },
  });
  if (!connection?.workspaceId) throw new DomainError("NOT_FOUND", 404);
  const unbound: string[] = [];
  const keyless: string[] = [];
  for (const grant of connection.grants.filter((g) => g.projectId)) {
    const scope = {
      workspaceId: connection.workspaceId,
      projectId: grant.projectId!,
      userId: ACTOR,
      role: "owner",
    } as Scope;
    await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      for (const row of await list(tx, scope, CONNECTION_KIND)) {
        const d = data(row);
        if (d.centralConnectionId !== connectionId) continue;
        if (!d.encryptedCredential) {
          keyless.push(row.id);
          continue;
        }
        const {
          centralConnectionId: _c,
          adoptedAt: _a,
          allowedChannelIds: _ch,
          ...rest
        } = d;
        await update(tx, scope, row, rest);
        await audit(tx, scope, "connector.unbound", row.id, { connectionId });
        unbound.push(row.id);
      }
    });
  }
  if (!keyless.length)
    await authDb.$transaction(async (tx) => {
      await tx.connectionGrant.updateMany({
        where: { connectionId, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: ACTOR },
      });
      await tx.connection.update({
        where: { id: connectionId },
        data: { disabledAt: new Date() },
      });
      await systemAudit(
        {
          actorId: ACTOR,
          action: "connection.consolidation_rolled_back",
          targetType: "connection",
          targetId: connectionId,
          workspaceId: connection.workspaceId,
          metadata: { unbound: unbound.length },
        },
        tx,
      );
    });
  return { unbound: unbound.length, keyless };
}

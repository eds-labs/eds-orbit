import { z } from "zod";
import { authDb } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { DomainError } from "../shared.ts";
import {
  revokeClientGrants,
  revokeGrantByAdministration,
} from "../mcp-auth/grants.ts";
import { systemAudit } from "./audit.ts";

// Orbit's MCP server in the system administration (ADR 0013, WP3.6): the
// gateway's state, the OAuth clients, every active grant as metadata, a
// client disable and grant revocation. Every rule of the gateway stays: a
// grant never widens what its user may do, projects outside it answer 404,
// and a client's own confirmation is never Orbit authorization.

/** Gateway flags and public settings; never a key or a token. */
export function mcpStatus() {
  const c = loadConfig();
  return {
    oauth: c.ORBIT_MCP_OAUTH === "true",
    gateway: c.ORBIT_MCP_GATEWAY === "true",
    proposals: c.ORBIT_MCP_PROPOSALS === "true",
    tasks: c.ORBIT_MCP_TASKS === "true",
    dynamicRegistration: c.ORBIT_MCP_DCR === "true",
    resource: c.MCP_RESOURCE,
    metadataDocumentHosts: (c.ORBIT_MCP_CIMD_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  };
}

export async function listMcpClients() {
  const [clients, grants] = await Promise.all([
    authDb.oauthClient.findMany({
      select: {
        clientId: true,
        name: true,
        uri: true,
        disabled: true,
        createdAt: true,
        tokenEndpointAuthMethod: true,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    authDb.mcpGrant.groupBy({
      by: ["clientId"],
      where: { status: "active" },
      _count: { _all: true },
      _max: { lastUsedAt: true },
    }),
  ]);
  return {
    status: mcpStatus(),
    clients: clients.map((c) => {
      const g = grants.find((x) => x.clientId === c.clientId);
      return {
        clientId: c.clientId,
        name: c.name ?? c.clientId,
        uri: c.uri,
        disabled: Boolean(c.disabled),
        createdAt: c.createdAt,
        authMethod: c.tokenEndpointAuthMethod,
        activeGrants: g?._count._all ?? 0,
        lastUsedAt: g?._max.lastUsedAt ?? null,
      };
    }),
  };
}

/** Every active grant, optionally of one organization (metadata only). */
export async function listAllMcpGrants(raw: unknown) {
  const filter = z
    .object({ workspaceId: z.uuid().optional(), clientId: z.string().max(500).optional() })
    .strict()
    .parse(raw ?? {});
  const grants = await authDb.mcpGrant.findMany({
    where: {
      status: "active",
      ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
      ...(filter.clientId ? { clientId: filter.clientId } : {}),
    },
    include: {
      user: { select: { name: true, email: true } },
      workspace: { select: { name: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: 500,
  });
  const clients = await authDb.oauthClient.findMany({
    where: { clientId: { in: [...new Set(grants.map((g) => g.clientId))] } },
    select: { clientId: true, name: true },
  });
  const names = new Map(clients.map((c) => [c.clientId, c.name]));
  return {
    items: grants.map((g) => ({
      id: g.id,
      clientId: g.clientId,
      clientName: names.get(g.clientId) || g.clientId,
      userId: g.userId,
      userName: g.user.name,
      userEmail: g.user.email,
      workspaceId: g.workspaceId,
      workspaceName: g.workspace.name,
      projects: g.allCurrentProjects ? "all" : g.projectIds.length,
      scopes: g.scopes,
      modules: g.modules,
      createdAt: g.createdAt,
      lastUsedAt: g.lastUsedAt,
    })),
  };
}

/**
 * Disables a client: it can no longer be authorized, and every grant it
 * holds is revoked with its stored tokens. Enabling allows new consents;
 * revoked grants stay revoked.
 */
export async function setMcpClientDisabled(
  actorId: string,
  clientId: string,
  disabled: boolean,
) {
  const id = z.string().min(1).max(500).parse(clientId);
  const updated = await authDb.oauthClient.updateMany({
    where: { clientId: id },
    data: { disabled },
  });
  if (!updated.count) throw new DomainError("NOT_FOUND", 404);
  const revoked = disabled ? await revokeClientGrants(id, "client_disabled") : 0;
  await systemAudit({
    actorId,
    action: disabled ? "mcp_client.disabled" : "mcp_client.enabled",
    targetType: "connection",
    targetId: id.slice(0, 200),
    metadata: { revokedGrants: revoked },
  });
  return { clientId: id, disabled, revokedGrants: revoked };
}

export async function revokeMcpGrant(actorId: string, grantId: string) {
  await revokeGrantByAdministration(grantId, actorId);
  await systemAudit({
    actorId,
    action: "mcp_grant.revoked",
    targetType: "grant",
    targetId: grantId,
  });
  return { revoked: true };
}

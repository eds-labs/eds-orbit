import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import * as schemas from "../../../../../packages/schemas/src/index.ts";
import { audit, create, data, DomainError, entity, list, update } from "../shared.ts";
import { registeredConnectionProvider } from "../modules/contributions.ts";
import { assertModuleEnabled } from "../modules/enforcement.ts";
import { grantedConnections } from "./central.ts";
import {
  CONNECTION_KIND,
  connectionAccess,
  cutoverEnabled,
  providerScopes,
} from "./connections.ts";

// A project's own connections: binding a granted central one and checking
// one with its provider. The `connector-attach` and `connector-health`
// actions and the MCP administration tools share them.

export const attachInput = z
  .object({
    connectionId: z.uuid(),
    siteId: z.string().max(100).optional(),
    channelId: z.string().max(100).optional(),
  })
  .strict();

/**
 * Binds a granted central connection to the project (ADR 0014, WP3.4): a
 * project connection without its own key, whose project settings
 * (channels, site, verification) stay here. Needs the provider's cutover.
 * An existing binding is returned unchanged.
 */
export async function attachGrantedConnection(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
) {
  const c = attachInput.parse(raw);
  const granted = (await grantedConnections(tx, scope)).find(
    (g) => g.connection.id === c.connectionId,
  );
  if (!granted) throw new DomainError("CONNECTION_NOT_GRANTED", 404);
  const providerId = granted.connection.provider;
  const provider = registeredConnectionProvider(providerId);
  if (!provider || !providerScopes(provider).includes("project"))
    throw new DomainError("PROVIDER_NOT_ATTACHABLE", 409);
  if (!cutoverEnabled(providerId))
    throw new DomainError("CUTOVER_NOT_ENABLED", 409);
  await assertModuleEnabled(tx, scope, provider.owner);
  const existing = (await list(tx, scope, CONNECTION_KIND)).find(
    (row) => data(row).centralConnectionId === c.connectionId,
  );
  if (existing) return existing;
  const row = await create(tx, scope, CONNECTION_KIND, {
    // The central connection's non-secret settings, then the project's.
    ...granted.connection.config,
    provider: providerId,
    ...(c.siteId ? { siteId: c.siteId } : {}),
    ...(c.channelId ? { channelId: c.channelId } : {}),
    centralConnectionId: c.connectionId,
    status: "configured",
    capabilities: [],
  });
  await audit(tx, scope, "connector.attached", row.id, {
    provider: providerId,
    connectionId: c.connectionId,
  });
  return row;
}

/**
 * Checks a connection with its provider and records what it can do; the
 * provider call runs outside any transaction (WP2.5c). Read checks only:
 * no provider check publishes anything.
 */
export async function checkProjectConnection(scope: Scope, connectorId: string) {
  const c = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const row = await entity(
        tx,
        scope,
        CONNECTION_KIND,
        schemas.id.parse(connectorId),
      );
      const provider = registeredConnectionProvider(String(data(row).provider));
      if (provider) await assertModuleEnabled(tx, scope, provider.owner);
      // A project connection bound to a central one checks with its key.
      return { row, access: await connectionAccess(tx, scope, data(row)) };
    }),
    d = data(c.row);
  const credential = c.access.credential;
  const provider = registeredConnectionProvider(String(d.provider));
  if (!provider?.check)
    throw new DomainError(
      provider?.checkUnsupported ?? "CONNECTOR_CHECK_UNSUPPORTED",
    );
  const result = await provider.check(
    { ...d, ...(c.access.baseUrl ? { baseUrl: c.access.baseUrl } : {}) },
    credential,
    { connectionId: c.row.id },
  );
  // A bound connection keeps only the channels its organization assigned.
  if (Array.isArray(d.allowedChannelIds) && Array.isArray(result.channels))
    result.channels = result.channels.filter(
      (ch: any) => typeof ch?.id === "string" && d.allowedChannelIds.includes(ch.id),
    );
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const current = await entity(tx, scope, CONNECTION_KIND, c.row.id);
    if (current.version !== c.row.version)
      throw new DomainError("CONNECTOR_CHANGED");
    return update(tx, scope, current, {
      ...d,
      ...result,
      verifiedAt: new Date().toISOString(),
    });
  });
}

import type { DbTx } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { openSecret } from "./secrets.ts";

// Using a central connection inside a project (ADR 0014). Everything here
// runs in the project's own transaction as the business role, so row-level
// security shows only connections this project holds an active grant for;
// a revoked grant or a disabled connection is gone on the next transaction.
// Off (ORBIT_CONNECTIONS=false) nothing central is used.

export const connectionsEnabled = () =>
  loadConfig().ORBIT_CONNECTIONS === "true";

export type GrantedConnection = {
  connection: {
    id: string;
    provider: string;
    scope: string;
    label: string;
    config: Record<string, unknown>;
    status: string;
    monthlyBudgetMicros: bigint | null;
  };
  grant: {
    id: string;
    parentGrantId: string | null;
    purposes: string[];
    modules: string[];
    settings: Record<string, unknown>;
    monthlyBudgetMicros: bigint | null;
  };
  parent: { id: string; monthlyBudgetMicros: bigint | null } | null;
};

const ORDER = { project: 0, workspace: 1, system: 2 } as Record<string, number>;

/**
 * The connections the project may use, optionally for one provider,
 * purpose and module: the project's own first, then the organization's,
 * then the system's.
 */
export async function grantedConnections(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  query: { provider?: string; purpose?: string; module?: string } = {},
): Promise<GrantedConnection[]> {
  if (!connectionsEnabled()) return [];
  const grants = await tx.connectionGrant.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      revokedAt: null,
      userId: null,
    },
  });
  if (!grants.length) return [];
  const connections = await tx.connection.findMany({
    where: {
      id: { in: grants.map((g) => g.connectionId) },
      ...(query.provider ? { provider: query.provider } : {}),
    },
  });
  const parents = await tx.connectionGrant.findMany({
    where: {
      id: {
        in: grants.map((g) => g.parentGrantId).filter((x): x is string => !!x),
      },
      revokedAt: null,
    },
  });
  const out: GrantedConnection[] = [];
  for (const grant of grants) {
    const connection = connections.find((c) => c.id === grant.connectionId);
    if (!connection) continue;
    const parent = grant.parentGrantId
      ? parents.find((p) => p.id === grant.parentGrantId)
      : null;
    // A project grant under a revoked organization grant is not usable.
    if (grant.parentGrantId && !parent) continue;
    if (
      query.purpose &&
      grant.purposes.length &&
      !grant.purposes.includes(query.purpose)
    )
      continue;
    if (
      query.module &&
      grant.modules.length &&
      !grant.modules.includes(query.module)
    )
      continue;
    out.push({
      connection: {
        id: connection.id,
        provider: connection.provider,
        scope: connection.scope,
        label: connection.label,
        config: connection.config as Record<string, unknown>,
        status: connection.status,
        monthlyBudgetMicros: connection.monthlyBudgetMicros,
      },
      grant: {
        id: grant.id,
        parentGrantId: grant.parentGrantId,
        purposes: grant.purposes,
        modules: grant.modules,
        settings: grant.settings as Record<string, unknown>,
        monthlyBudgetMicros: grant.monthlyBudgetMicros,
      },
      parent: parent
        ? { id: parent.id, monthlyBudgetMicros: parent.monthlyBudgetMicros }
        : null,
    });
  }
  return out.sort(
    (a, b) => ORDER[a.connection.scope]! - ORDER[b.connection.scope]!,
  );
}

/** The first usable connection for a provider and purpose, or null. */
export async function resolveConnection(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  query: { provider: string; purpose?: string; module?: string },
) {
  return (await grantedConnections(tx, scope, query))[0] ?? null;
}

/**
 * The plain active secret of a granted connection, read in the same
 * transaction. Use it only right before the provider call.
 */
export async function connectionSecret(tx: DbTx, connectionId: string) {
  const secret = await tx.connectionSecret.findFirst({
    where: { connectionId, state: "active" },
  });
  return secret ? openSecret(secret) : null;
}

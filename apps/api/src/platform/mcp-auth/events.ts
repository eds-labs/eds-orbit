import {
  authDb,
  Prisma,
  type DbTx,
} from "../../../../../packages/db/src/index.ts";

// Append-only audit of MCP grant and client changes (Track M, WP-M1).
// Events never carry token values, authorization codes, PKCE verifiers or
// secrets: callers pass identifiers and short codes only.

export type GrantEventAction =
  | "grant.selected"
  | "grant.activated"
  | "grant.denied"
  | "grant.revoked"
  | "client.registered"
  | "client.refreshed"
  | "token.refresh_replay";

export type GrantEvent = {
  action: GrantEventAction;
  userId: string;
  clientId: string;
  grantId?: string;
  workspaceId?: string;
  detail?: Record<string, string | number | boolean | null | string[]>;
};

/** Writes one event; inside a transaction when `tx` is given. */
export async function recordGrantEvent(
  event: GrantEvent,
  tx: DbTx | typeof authDb = authDb,
): Promise<void> {
  await tx.mcpGrantEvent.create({
    data: {
      action: event.action,
      userId: event.userId,
      clientId: event.clientId,
      grantId: event.grantId ?? null,
      workspaceId: event.workspaceId ?? null,
      detail: (event.detail ?? {}) as Prisma.InputJsonObject,
    },
  });
}

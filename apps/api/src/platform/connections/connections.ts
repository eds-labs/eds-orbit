import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import {
  credentialKey,
  data,
  decrypt,
  DomainError,
  list,
} from "../shared.ts";
import {
  connectionSecret,
  connectionsEnabled,
  grantedConnections,
} from "./central.ts";

/**
 * Connections to external providers (WP2.5c, plan 02 "Integrations and
 * connections"). The platform owns the credential vault and the capability
 * states; a module owns what a provider means (publishing, analytics) and
 * contributes the provider: its form fields, how its base URL is normalized
 * and how it is checked (`connections.providers`).
 *
 * Storage is unchanged: one `connectors` entity per connection with
 * `provider`, `status`, `capabilities`, provider fields and the credential
 * only as `encryptedCredential` (AES-GCM with CREDENTIAL_KEY), which no
 * client view ever returns.
 */
export const CONNECTION_KIND = "connectors";

/** Capability states a connection goes through. */
export type ConnectionStatus =
  "configured" | "read_verified" | "write_verified" | (string & {});

/** True for a connection a check has verified, for reading or writing. */
export function connectionVerified(status: unknown) {
  return status === "read_verified" || status === "write_verified";
}

/** The project's connections of one provider, in the collection's order. */
export async function connectionsOf(tx: DbTx, scope: Scope, provider: string) {
  return (await list(tx, scope, CONNECTION_KIND)).filter(
    (row) => data(row).provider === provider,
  );
}

/**
 * The plain credential of a connection (its row data). Use it only right
 * before a provider call; never store, log or return it.
 */
export function decryptCredential(connection: Record<string, any>) {
  return decrypt(connection.encryptedCredential, credentialKey());
}

/** Whether a provider's project connections may use central ones (WP3.4). */
export function cutoverEnabled(provider: string) {
  if (!connectionsEnabled()) return false;
  return (loadConfig().ORBIT_CONNECTIONS_CUTOVER ?? "")
    .split(",")
    .includes(provider);
}

/**
 * What a provider call needs from a project connection (ADR 0014): its
 * plain credential and base URL. A connection bound to a central one
 * (`centralConnectionId`) reads the central secret inside this project
 * transaction, so it works only while the project holds an active grant;
 * row-level security enforces that. Otherwise the project's own key is
 * used, as before. Use the result right before the provider call; never
 * store, log or return it.
 */
export async function connectionAccess(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  connection: Record<string, any>,
): Promise<{ credential: string; baseUrl?: string }> {
  const central = connection.centralConnectionId as string | undefined;
  if (central && cutoverEnabled(String(connection.provider))) {
    const granted = (
      await grantedConnections(tx, scope, {
        provider: String(connection.provider),
      })
    ).find((g) => g.connection.id === central);
    const secret = granted ? await connectionSecret(tx, central) : null;
    if (!granted || !secret)
      throw new DomainError("CONNECTION_NOT_GRANTED", 409);
    const baseUrl = granted.connection.config.baseUrl;
    return {
      credential: secret,
      baseUrl: typeof baseUrl === "string" ? baseUrl : connection.baseUrl,
    };
  }
  if (!connection.encryptedCredential)
    throw new DomainError("CONNECTION_NOT_GRANTED", 409);
  return {
    credential: decryptCredential(connection),
    ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
  };
}

/**
 * A provider a module contributes. `check` calls the provider with the
 * plain credential and returns the fields to record on the connection (its
 * new `status`, `capabilities` and provider details); without `check`, a
 * health check answers `checkUnsupported`.
 */
export type ConnectionProvider = {
  /** Normalizes the provider fields of a new connection (e.g. its base URL). */
  normalize?: (fields: Record<string, any>) => Record<string, any>;
  /**
   * Normalizes the non-secret settings of a central connection (ADR 0014),
   * for providers whose project connections are created by their own
   * action; defaults to `normalize`.
   */
  normalizeCentral?: (fields: Record<string, any>) => Record<string, any>;
  check?: (
    connection: Record<string, any>,
    credential: string,
    context?: { connectionId: string },
  ) => Promise<Record<string, unknown>>;
  /** Error code of a health check this provider cannot run. */
  checkUnsupported?: string;
  /**
   * Where a connection of this provider may be owned (ADR 0014). Default
   * ["project"]: the project's own connectors only. "system" and
   * "workspace" providers are managed centrally and granted to projects.
   */
  scopes?: ReadonlyArray<"system" | "workspace" | "project">;
  /** What a grant may allow, such as "text" or "embedding" for AI. */
  purposes?: readonly string[];
  /** Display name for the administration. */
  label?: { en: string; de: string };
  /**
   * The provider's check returns `channels` (accounts such as social
   * profiles) that a central connection hands out to projects one by one,
   * each to exactly one project (channel-assignment.ts).
   */
  channelAssignment?: boolean;
};

/** The owner scopes a provider allows. */
export const providerScopes = (provider: ConnectionProvider) =>
  provider.scopes ?? (["project"] as const);

/** Connection providers a module contributes, by provider id. */
export type ConnectionsContribution = {
  providers: Readonly<Record<string, ConnectionProvider>>;
};

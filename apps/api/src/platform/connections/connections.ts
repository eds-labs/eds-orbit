import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { credentialKey, data, decrypt, list } from "../shared.ts";

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

/**
 * A provider a module contributes. `check` calls the provider with the
 * plain credential and returns the fields to record on the connection (its
 * new `status`, `capabilities` and provider details); without `check`, a
 * health check answers `checkUnsupported`.
 */
export type ConnectionProvider = {
  /** Normalizes the provider fields of a new connection (e.g. its base URL). */
  normalize?: (fields: Record<string, any>) => Record<string, any>;
  check?: (
    connection: Record<string, any>,
    credential: string,
  ) => Promise<Record<string, unknown>>;
  /** Error code of a health check this provider cannot run. */
  checkUnsupported?: string;
};

/** Connection providers a module contributes, by provider id. */
export type ConnectionsContribution = {
  providers: Readonly<Record<string, ConnectionProvider>>;
};

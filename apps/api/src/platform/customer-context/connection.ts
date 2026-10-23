import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  decrypt,
  DomainError,
  encrypt,
  publicEntity,
  update,
} from "../shared.ts";
import {
  connectionsOf,
  connectionVerified,
  CONNECTION_KIND,
  type ConnectionProvider,
} from "../connections/connections.ts";
import {
  customerContextTimeout,
  customerContextUrl,
  lookupCustomerContext,
  type CustomerContextTarget,
} from "./client.ts";
import { CUSTOMER_CONTEXT_LIMITS } from "../../../../../packages/schemas/src/customer-context.ts";

// Customer context integrations (ADR 0011): one `connectors` row per
// provider endpoint, provider "customer_context", in exactly one project
// (RLS). The row keeps the base URL, the source system's slug and the
// timeout; the bearer token and the signing secret are kept only encrypted,
// together, and never returned. A module binds an integration where it
// needs one (Support: per inbox). Nothing here knows a product.

export const CUSTOMER_CONTEXT_PROVIDER = "customer_context";
/** Reserved subject of the connection check; providers answer "not found". */
export const CUSTOMER_CONTEXT_CHECK_SUBJECT = "orbit-connection-check";

export function customerContextEnabled() {
  return loadConfig().ORBIT_CUSTOMER_CONTEXT === "true";
}

const secret = (min: number) => z.string().min(min).max(500).regex(/^\S+$/);

export const customerContextConnectionInput = z
  .object({
    /** Replaces the endpoint and secrets of this integration (rotation). */
    connectorId: z.uuid().optional(),
    label: z.string().trim().min(1).max(80),
    baseUrl: z.url().max(500),
    sourceSystem: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
    timeoutMs: z
      .int()
      .min(CUSTOMER_CONTEXT_LIMITS.minTimeoutMs)
      .max(CUSTOMER_CONTEXT_LIMITS.maxTimeoutMs)
      .default(CUSTOMER_CONTEXT_LIMITS.defaultTimeoutMs),
    token: secret(16),
    signingSecret: secret(32),
  })
  .strict();

const credentialShape = z
  .object({ token: z.string().min(1), signingSecret: z.string().min(1) })
  .strict();

function assertEnabled() {
  if (!customerContextEnabled()) throw new DomainError("NOT_FOUND", 404);
}

/** What the client needs from a stored row; the credential decrypted. */
export function customerContextTarget(
  connectionId: string,
  d: Record<string, any>,
  credential = decrypt(
    String(d.encryptedCredential),
    loadConfig().CREDENTIAL_KEY,
  ),
): CustomerContextTarget {
  return {
    connectionId,
    baseUrl: String(d.baseUrl),
    timeoutMs: customerContextTimeout(d.timeoutMs),
    credential: credentialShape.parse(JSON.parse(credential)),
  };
}

/** The project's customer context integrations, newest first. */
export function customerContextConnections(tx: DbTx, scope: Scope) {
  return connectionsOf(tx, scope, CUSTOMER_CONTEXT_PROVIDER);
}

/**
 * The integration `id` names, if it is one of this project's and its last
 * check passed; else null. Callers treat null as "no integration".
 */
export async function verifiedCustomerContextConnection(
  tx: DbTx,
  scope: Scope,
  id: string,
) {
  const row = (await customerContextConnections(tx, scope)).find(
    (r) => r.id === id,
  );
  return row && connectionVerified(data(row).status) ? row : null;
}

/**
 * Owner only: adds an integration, or replaces one's endpoint and secrets.
 * A replaced integration needs a new check before it is used again.
 */
export async function connectCustomerContext(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
) {
  assertEnabled();
  const { connectorId, token, signingSecret, ...fields } =
    customerContextConnectionInput.parse(raw);
  try {
    customerContextUrl(fields.baseUrl);
  } catch {
    throw new DomainError("HTTPS_REQUIRED");
  }
  const value = {
    provider: CUSTOMER_CONTEXT_PROVIDER,
    ...fields,
    baseUrl: fields.baseUrl.replace(/\/+$/, ""),
    encryptedCredential: encrypt(
      JSON.stringify({ token, signingSecret }),
      loadConfig().CREDENTIAL_KEY,
    ),
    status: "configured",
    capabilities: [],
  };
  const known = connectorId
    ? (await customerContextConnections(tx, scope)).find(
        (r) => r.id === connectorId,
      )
    : undefined;
  if (connectorId && !known)
    throw new DomainError("CUSTOMER_CONTEXT_CONNECTION_NOT_FOUND", 404);
  const row = known
    ? await update(tx, scope, known, value)
    : await create(tx, scope, CONNECTION_KIND, value);
  await audit(
    tx,
    scope,
    known ? "customer_context.updated" : "customer_context.connected",
    row.id,
    { sourceSystem: fields.sourceSystem, timeoutMs: fields.timeoutMs },
  );
  return publicEntity(row);
}

/** Owner only: removes an integration. Bindings to it then fail closed. */
export async function disconnectCustomerContext(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
) {
  assertEnabled();
  const { connectorId } = z
    .object({ connectorId: z.uuid() })
    .strict()
    .parse(raw);
  const row = (await customerContextConnections(tx, scope)).find(
    (r) => r.id === connectorId,
  );
  if (!row) throw new DomainError("CUSTOMER_CONTEXT_CONNECTION_NOT_FOUND", 404);
  await tx.entity.deleteMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      id: row.id,
    },
  });
  await audit(tx, scope, "customer_context.disconnected", row.id, {
    sourceSystem: data(row).sourceSystem,
  });
  return { removed: row.id };
}

/**
 * The connection check (`connector-health`): one signed lookup of the
 * reserved subject. A provider that verifies the signature and answers per
 * contract ("not found", "not verified" or a context) is `read_verified`;
 * anything else is refused with the reason, never the provider's text.
 */
export const customerContextConnectionProvider: ConnectionProvider = {
  // Integrations are created with their own action, which validates the
  // source system and keeps both secrets together.
  normalize() {
    throw new DomainError("CUSTOMER_CONTEXT_CONNECT_REQUIRED");
  },
  // One gateway (such as n8n) can serve several projects (ADR 0014). The
  // secret is the JSON {token, signingSecret}, checked when it is used.
  scopes: ["project", "workspace", "system"],
  label: { en: "Customer context", de: "Kundenkontext" },
  normalizeCentral: (fields) =>
    customerContextConnectionInput
      .pick({ baseUrl: true, sourceSystem: true, timeoutMs: true })
      .strict()
      .parse(fields),
  async check(connection, credential, context) {
    assertEnabled();
    if (!context) throw new DomainError("CUSTOMER_CONTEXT_CHECK_MISCONFIGURED");
    const { result, durationMs } = await lookupCustomerContext(
      customerContextTarget(context.connectionId, connection, credential),
      { id: CUSTOMER_CONTEXT_CHECK_SUBJECT, verifiedAt: new Date() },
    );
    if (result.status === "unavailable" || result.status === "forbidden")
      throw new DomainError(
        `CUSTOMER_CONTEXT_CHECK_${result.reason.toUpperCase()}`,
        409,
      );
    return {
      status: "read_verified",
      capabilities: ["customer_context.read"],
      checkedAt: new Date().toISOString(),
      checkDurationMs: durationMs,
    };
  },
};

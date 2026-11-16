import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { scoped, type DbTx, Prisma } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { boundedFetch, ConnectorError, type FetchLike } from "../../../../../packages/connectors/src/http.ts";
import { audit, credentialKey, decrypt, DomainError, encrypt } from "../shared.ts";
import { enqueue } from "../jobs/enqueue.ts";
import type { JobDef, PeriodicTask } from "../jobs/types.ts";
import { moduleAvailable, registeredWebhookEvents } from "../modules/contributions.ts";
import { liveSending } from "../email/connection.ts";

// Outbound webhooks (ADR 0029, CH1.3). A module emits an event inside its own
// project transaction; every active endpoint of that module subscribed to the
// type gets a delivery row and a job in the same transaction. The worker signs
// and sends it, retries with backoff and disables endpoints that keep failing
// or answer 410. Receivers deduplicate by event id, so a retry after an
// unclear answer is safe: the payload names what changed, never content.

export const WEBHOOK_QUEUE = "webhook_delivery";
/** The platform's own event, sent to one endpoint by "Send test". */
export const PING_EVENT = "orbit.ping";
export const MAX_ATTEMPTS = 12;
/** Consecutive failed deliveries after which an endpoint is disabled. */
export const DISABLE_AFTER_FAILURES = 20;
/** After a rotation the previous secret also signs this long. */
export const PREVIOUS_SECRET_HOURS = 24;
export const DELIVERY_KEEP_DAYS = 30;
const TIMEOUT_MS = 10_000;
const BACKOFF_MINUTES = [1, 5, 15, 60, 180, 360, 720, 1440, 1440, 1440, 1440];

/** True while outbound webhooks exist (ORBIT_WEBHOOKS). */
export const webhooksEnabled = () => loadConfig().ORBIT_WEBHOOKS === "true";

let fetcher: FetchLike = boundedFetch;
/** Test hook: the real transport refuses private addresses by design. */
export function setWebhookFetchForTests(next: FetchLike | null) {
  fetcher = next ?? boundedFetch;
}

/** `v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>`, the platform's scheme. */
export function signWebhook(secret: string, timestamp: string, body: string) {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

const newSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;
const newEventId = () => `evt_${randomBytes(18).toString("base64url")}`;

const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.hostname.length > 0;
    } catch {
      return false;
    }
  }, "HTTPS URL without credentials, query or fragment")
  .transform((value) => new URL(value).toString());

const createInput = z
  .object({
    ownerModule: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
    name: z.string().trim().min(1).max(80),
    url: httpsUrl,
    eventTypes: z.array(z.string()).min(1).max(50),
  })
  .strict();

const updateInput = z
  .object({
    version: z.int().min(1),
    name: z.string().trim().min(1).max(80).optional(),
    url: httpsUrl.optional(),
    eventTypes: z.array(z.string()).min(1).max(50).optional(),
    /** Re-enables a disabled endpoint, or disables an active one. */
    status: z.enum(["active", "disabled"]).optional(),
  })
  .strict();

type EndpointRow = Prisma.WebhookEndpointGetPayload<object>;
type DeliveryRow = Prisma.WebhookDeliveryGetPayload<object>;

const endpointView = (row: EndpointRow) => ({
  id: row.id,
  ownerModule: row.ownerModule,
  name: row.name,
  url: row.url,
  eventTypes: row.eventTypes,
  status: row.status,
  consecutiveFailures: row.consecutiveFailures,
  disabledReason: row.disabledReason,
  disabledAt: row.disabledAt,
  previousSecretUntil: row.previousSecretUntil,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  version: row.version,
});

const deliveryView = (row: DeliveryRow) => ({
  id: row.id,
  endpointId: row.endpointId,
  eventId: row.eventId,
  eventType: row.eventType,
  status: row.status,
  attempts: row.attempts,
  nextAttemptAt: row.nextAttemptAt,
  lastStatus: row.lastStatus,
  lastErrorCode: row.lastErrorCode,
  durationMs: row.durationMs,
  deliveredAt: row.deliveredAt,
  createdAt: row.createdAt,
});

const requireOwner = (scope: Scope) => {
  if (!webhooksEnabled()) throw new DomainError("NOT_FOUND", 404);
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
};

/** Event types an endpoint of `ownerModule` may subscribe to; the ping always comes. */
function checkEventTypes(ownerModule: string, types: readonly string[]) {
  if (!moduleAvailable(ownerModule)) throw new DomainError("WEBHOOK_MODULE_UNAVAILABLE", 409);
  const registered = registeredWebhookEvents();
  const unique = [...new Set(types)].sort();
  if (!unique.every((type) => registered.get(type)?.owner === ownerModule))
    throw new DomainError("WEBHOOK_EVENT_UNKNOWN", 400);
  return unique;
}

/** Event types a module offers, for the settings UI. */
export function webhookEventCatalog() {
  return [...registeredWebhookEvents().values()]
    .filter((def) => moduleAvailable(def.owner))
    .map((def) => ({ type: def.type, module: def.owner, description: def.description }));
}

const audited = (tx: DbTx, scope: Scope, action: string, row: EndpointRow, extra: Record<string, unknown> = {}) =>
  audit(tx, scope, action, row.id, {
    ownerModule: row.ownerModule,
    // The host only: a path may carry a receiver's own token.
    host: new URL(row.url).host,
    eventTypes: row.eventTypes,
    status: row.status,
    ...extra,
  });

/** Creates an endpoint; the signing secret is in this answer only. */
export async function createWebhookEndpoint(tx: DbTx, scope: Scope, raw: unknown) {
  requireOwner(scope);
  const input = createInput.parse(raw);
  const eventTypes = checkEventTypes(input.ownerModule, input.eventTypes);
  const secret = newSecret();
  const row = await tx.webhookEndpoint.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      ownerModule: input.ownerModule,
      name: input.name,
      url: input.url,
      eventTypes,
      secretCipher: encrypt(secret, credentialKey()),
      createdBy: scope.userId,
    },
  });
  await audited(tx, scope, "webhook_endpoint.created", row);
  return { ...endpointView(row), secret };
}

export async function listWebhookEndpoints(tx: DbTx, scope: Scope) {
  requireOwner(scope);
  const rows = await tx.webhookEndpoint.findMany({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(endpointView);
}

async function lockEndpoint(tx: DbTx, scope: Scope, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "WebhookEndpoint" WHERE id = ${id}::uuid AND "projectId" = ${scope.projectId}::uuid FOR UPDATE`;
  if (!rows.length) throw new DomainError("NOT_FOUND", 404);
  return tx.webhookEndpoint.findUniqueOrThrow({ where: { id } });
}

/** Changes name, URL, event types or status with the expected version. */
export async function updateWebhookEndpoint(tx: DbTx, scope: Scope, id: string, raw: unknown) {
  requireOwner(scope);
  const input = updateInput.parse(raw);
  const row = await lockEndpoint(tx, scope, id);
  if (row.version !== input.version) throw new DomainError("WEBHOOK_ENDPOINT_STALE", 409);
  const eventTypes = input.eventTypes ? checkEventTypes(row.ownerModule, input.eventTypes) : undefined;
  const now = new Date();
  const status =
    input.status === "active"
      ? { status: "active", disabledReason: null, disabledAt: null, consecutiveFailures: 0 }
      : input.status === "disabled" && row.status !== "disabled"
        ? { status: "disabled", disabledReason: "BY_OWNER", disabledAt: now }
        : {};
  const updated = await tx.webhookEndpoint.update({
    where: { id },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(eventTypes ? { eventTypes } : {}),
      ...status,
      version: { increment: 1 },
    },
  });
  await audited(tx, scope, "webhook_endpoint.updated", updated);
  return endpointView(updated);
}

/** A new signing secret, shown once; the previous one also signs for 24 hours. */
export async function rotateWebhookSecret(tx: DbTx, scope: Scope, id: string) {
  requireOwner(scope);
  const row = await lockEndpoint(tx, scope, id);
  const secret = newSecret();
  const updated = await tx.webhookEndpoint.update({
    where: { id },
    data: {
      secretCipher: encrypt(secret, credentialKey()),
      previousSecretCipher: row.secretCipher,
      previousSecretUntil: new Date(Date.now() + PREVIOUS_SECRET_HOURS * 3_600_000),
      version: { increment: 1 },
    },
  });
  await audited(tx, scope, "webhook_endpoint.secret_rotated", updated);
  return { ...endpointView(updated), secret };
}

async function addDelivery(tx: DbTx, scope: Scope, endpoint: EndpointRow, eventId: string, type: string, payload: Record<string, unknown>) {
  const id = randomUUID();
  await tx.webhookDelivery.create({
    data: {
      id,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      endpointId: endpoint.id,
      eventId,
      eventType: type,
      payload: payload as Prisma.InputJsonValue,
    },
  });
  await enqueue(tx, scope, WEBHOOK_QUEUE, id, `webhook:${id}:0`);
  return id;
}

/**
 * Emits an event of a registered type to the project's active endpoints of
 * its module, in the caller's transaction (no delivery without the change,
 * no change without its deliveries). Returns the event id, or null when
 * webhooks are off or nobody subscribed.
 */
export async function emitWebhookEvent(tx: DbTx, scope: Scope, type: string, payload: Record<string, unknown>) {
  const def = registeredWebhookEvents().get(type);
  if (!def) throw new Error(`unregistered webhook event ${type}`);
  if (!webhooksEnabled()) return null;
  const endpoints = await tx.webhookEndpoint.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      ownerModule: def.owner,
      status: "active",
      eventTypes: { has: type },
    },
  });
  if (!endpoints.length) return null;
  const eventId = newEventId();
  for (const endpoint of endpoints) await addDelivery(tx, scope, endpoint, eventId, type, payload);
  return eventId;
}

/** Sends a ping to one endpoint, also a disabled one is refused. */
export async function pingWebhookEndpoint(tx: DbTx, scope: Scope, id: string) {
  requireOwner(scope);
  const endpoint = await lockEndpoint(tx, scope, id);
  if (endpoint.status !== "active") throw new DomainError("WEBHOOK_ENDPOINT_DISABLED", 409);
  const deliveryId = await addDelivery(tx, scope, endpoint, newEventId(), PING_EVENT, { endpointId: endpoint.id });
  return { deliveryId };
}

/** The endpoint's deliveries, newest first, keyset by creation time. */
export async function listWebhookDeliveries(tx: DbTx, scope: Scope, endpointId: string, raw: unknown) {
  requireOwner(scope);
  const input = z
    .object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
    .parse(raw ?? {});
  await lockEndpoint(tx, scope, endpointId);
  const rows = await tx.webhookDelivery.findMany({
    where: { endpointId, ...(input.before ? { createdAt: { lt: new Date(input.before) } } : {}) },
    orderBy: { createdAt: "desc" },
    take: input.limit,
  });
  return rows.map(deliveryView);
}

/** Sends a finished delivery again under its event id; audited. */
export async function replayWebhookDelivery(tx: DbTx, scope: Scope, deliveryId: string) {
  requireOwner(scope);
  const delivery = await tx.webhookDelivery.findFirst({ where: { id: deliveryId, projectId: scope.projectId } });
  if (!delivery) throw new DomainError("NOT_FOUND", 404);
  if (delivery.status === "pending") throw new DomainError("WEBHOOK_DELIVERY_PENDING", 409);
  const endpoint = await lockEndpoint(tx, scope, delivery.endpointId);
  if (endpoint.status !== "active") throw new DomainError("WEBHOOK_ENDPOINT_DISABLED", 409);
  const updated = await tx.webhookDelivery.update({
    where: { id: deliveryId },
    data: { status: "pending", attempts: 0, nextAttemptAt: null, lastErrorCode: null },
  });
  await enqueue(tx, scope, WEBHOOK_QUEUE, deliveryId, `webhook:${deliveryId}:replay:${Date.now()}`);
  await audit(tx, scope, "webhook_delivery.replayed", deliveryId, { endpointId: endpoint.id, eventType: delivery.eventType });
  return deliveryView(updated);
}

const backoff = (attempt: number) => {
  const minutes = BACKOFF_MINUTES[Math.min(attempt - 1, BACKOFF_MINUTES.length - 1)]!;
  const jitter = 0.8 + Math.random() * 0.4;
  return new Date(Date.now() + Math.round(minutes * 60_000 * jitter));
};

/**
 * The worker's job: sends one pending delivery. The network call runs outside
 * any transaction; the outcome is written afterwards.
 */
export async function deliverWebhook(scope: Scope, deliveryId: string) {
  const prepared = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const delivery = await tx.webhookDelivery.findFirst({ where: { id: deliveryId, projectId: scope.projectId } });
    if (!delivery || delivery.status !== "pending") return null;
    const endpoint = await tx.webhookEndpoint.findUniqueOrThrow({ where: { id: delivery.endpointId } });
    if (endpoint.status !== "active") {
      await tx.webhookDelivery.update({ where: { id: deliveryId }, data: { status: "failed", lastErrorCode: "ENDPOINT_DISABLED" } });
      return null;
    }
    if (!webhooksEnabled() || !liveSending()) {
      await tx.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: "skipped", lastErrorCode: webhooksEnabled() ? "TEST_MODE" : "WEBHOOKS_DISABLED" },
      });
      return null;
    }
    const key = credentialKey();
    const secrets = [decrypt(endpoint.secretCipher, key)];
    if (endpoint.previousSecretCipher && endpoint.previousSecretUntil && endpoint.previousSecretUntil > new Date())
      secrets.push(decrypt(endpoint.previousSecretCipher, key));
    const body = JSON.stringify({
      id: delivery.eventId,
      type: delivery.eventType,
      occurredAt: delivery.createdAt.toISOString(),
      projectId: delivery.projectId,
      data: delivery.payload,
    });
    return { delivery, endpoint, secrets, body };
  });
  if (!prepared) return;
  const { delivery, endpoint, secrets, body } = prepared;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const started = Date.now();
  let status: number | null = null;
  let errorCode: string | null = null;
  try {
    const response = await fetcher(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "EDS-Orbit-Webhooks/1",
        "X-Orbit-Event-Id": delivery.eventId,
        "X-Orbit-Event-Type": delivery.eventType,
        "X-Orbit-Timestamp": timestamp,
        "X-Orbit-Signature": secrets.map((secret) => signWebhook(secret, timestamp, body)).join(","),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = response.status;
    if (!response.ok) errorCode = `HTTP_${response.status}`;
  } catch (error) {
    errorCode = error instanceof ConnectorError ? error.code : "NETWORK_ERROR";
  }
  const durationMs = Date.now() - started;
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const attempts = delivery.attempts + 1;
    const delivered = status !== null && status >= 200 && status < 300;
    const gone = status === 410;
    const dead = !delivered && (gone || attempts >= MAX_ATTEMPTS);
    const nextAttemptAt = delivered || dead ? null : backoff(attempts);
    await tx.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempts,
        lastStatus: status,
        lastErrorCode: errorCode,
        durationMs,
        status: delivered ? "delivered" : dead ? "dead" : "pending",
        deliveredAt: delivered ? new Date() : null,
        nextAttemptAt,
      },
    });
    if (nextAttemptAt) await enqueue(tx, scope, WEBHOOK_QUEUE, delivery.id, `webhook:${delivery.id}:${attempts}:${nextAttemptAt.getTime()}`, nextAttemptAt);
    const failures = delivered ? 0 : endpoint.consecutiveFailures + 1;
    const disable = gone ? "GONE" : failures >= DISABLE_AFTER_FAILURES ? "FAILURES" : null;
    await tx.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: {
        consecutiveFailures: delivered ? 0 : { increment: 1 },
        ...(disable ? { status: "disabled", disabledReason: disable, disabledAt: new Date(), version: { increment: 1 } } : {}),
      },
    });
    if (disable)
      await audit(tx, scope, "webhook_endpoint.disabled", endpoint.id, { reason: disable, ownerModule: endpoint.ownerModule });
  });
}

export const webhookDeliveryJob: JobDef = {
  queueClass: WEBHOOK_QUEUE,
  concurrency: 4,
  leaseMs: 60_000,
  handler: ({ scope, job }) => deliverWebhook(scope, String(job.resourceId)),
  /** A paused project holds its deliveries; the owner can replay them later. */
  async onBlockedByPause(tx, job) {
    await tx.webhookDelivery.updateMany({
      where: { id: String(job.resourceId), status: "pending" },
      data: { status: "failed", lastErrorCode: "PROJECT_PAUSED" },
    });
  },
};

const CLEANUP_MS = 3_600_000;
const lastCleanup = new Map<string, number>();

/** Hourly per project: deliveries older than 30 days are deleted (not pending ones). */
export const webhookDeliveryCleanup: PeriodicTask = {
  name: "webhook-delivery-cleanup",
  async run(scope) {
    const now = Date.now();
    if (now - (lastCleanup.get(scope.projectId) ?? 0) < CLEANUP_MS) return;
    lastCleanup.set(scope.projectId, now);
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.webhookDelivery.deleteMany({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          status: { not: "pending" },
          createdAt: { lt: new Date(now - DELIVERY_KEEP_DAYS * 86_400_000) },
        },
      }),
    );
  },
};

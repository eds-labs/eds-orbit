import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  ConnectorError,
  type FetchLike,
} from "../../../../../packages/connectors/src/index.ts";
import { audit, data, entity, exception, update } from "../shared.ts";
import {
  linkedTelegramConnection,
  telegramEnabled,
  telegramSender,
} from "../connections/telegram.ts";
import {
  ownerEnabled,
  registeredNotification,
} from "../modules/contributions.ts";
import { enabledModules } from "../modules/enforcement.ts";

/**
 * Renders and sends one queued `telegram_notification` job to the owner's
 * bot (WP2.5b; Orbit Agents, spec §10). The job's idempotency key
 * `notify:<kind>:<ref>` says what to send; the module that registered the
 * kind renders the message when the job runs, from the state then (a stale
 * preview is skipped). A project without a bound owner gets nothing and
 * nothing is retried (R61, R63).
 *
 * Delivery is tried once and retried three times with growing waits, but only
 * for network trouble and temporary Telegram errors. A delivery that still
 * fails is recorded on the job, audited and opened as the exception
 * `TELEGRAM_DELIVERY_FAILED` (kind and reference, never the token or the chat
 * id). It changes nothing about publishing. The outcome (`sent`, `skipped`,
 * `failed`) is kept on the job as `notification`, which also makes a second
 * call for the same job a no-op.
 */
const BACKOFF_MS = [1000, 3000, 9000];
// Telegram's limit under a photo; a longer text follows in its own message.
const CAPTION_MAX = 1024;
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
// An unclear answer (`INVALID_PROVIDER_RESPONSE`, usually after an HTTP 200) is no reason to
// send again: the message may be out already, and a retry would duplicate it.
const TRANSIENT_CODES = new Set([
  "NETWORK_ERROR",
  "REQUEST_TIMEOUT",
  "DNS_TIMEOUT",
]);
// The longest wait Telegram's `retry_after` may impose on a notification.
const RETRY_AFTER_MAX_MS = 30_000;

export type NotificationOptions = {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
};

const maybe = async <T>(work: () => Promise<T>) => {
  try {
    return await work();
  } catch {
    return null;
  }
};

/** The kind and reference of a job key, with the kind's registration. */
function parseKey(key: unknown) {
  const match = /^notify:([a-z_]+):(.+)$/s.exec(String(key ?? ""));
  const registered = match ? registeredNotification(match[1]!) : undefined;
  return match && registered
    ? { kind: match[1]!, ref: match[2]!, ...registered }
    : null;
}

/** Network trouble and temporary Telegram answers are tried again; a refusal that will not change is not. */
function transient(error: unknown) {
  if (!(error instanceof ConnectorError)) return false;
  if (error.status !== undefined)
    return error.status === 408 || error.status === 429 || error.status >= 500;
  return TRANSIENT_CODES.has(error.code);
}

/** One step of a delivery; `fallback` takes its place when Telegram refuses it for good. */
type Step = {
  send: () => Promise<unknown>;
  fallback?: () => Promise<unknown>;
};

/** Telegram's own wait after a 429 (at most 30 s), else the growing backoff. */
function waitBefore(error: unknown, attempt: number) {
  if (
    error instanceof ConnectorError &&
    error.status === 429 &&
    error.retryAfterMs
  )
    return Math.min(error.retryAfterMs, RETRY_AFTER_MAX_MS);
  return BACKOFF_MS[attempt]!;
}

async function withRetries(
  send: () => Promise<unknown>,
  sleep: (ms: number) => Promise<void>,
) {
  for (let attempt = 0; ; attempt++)
    try {
      return await send();
    } catch (error) {
      if (attempt >= BACKOFF_MS.length || !transient(error)) throw error;
      await sleep(waitBefore(error, attempt));
    }
}

async function deliver(steps: Step[], sleep: (ms: number) => Promise<void>) {
  for (const step of steps)
    try {
      await withRetries(step.send, sleep);
    } catch (error) {
      // A photo Telegram refuses for good (not a temporary error, not a revoked bot)
      // must not cost the owner the preview: the text goes out instead.
      if (
        !step.fallback ||
        !(error instanceof ConnectorError) ||
        transient(error) ||
        error.code === "PROVIDER_AUTH"
      )
        throw error;
      await withRetries(step.fallback, sleep);
    }
}

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function record(
  scope: Scope,
  jobId: string,
  notification: Record<string, unknown>,
  inTx?: (tx: DbTx) => Promise<void>,
) {
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const job = await entity(tx, scope, "jobs", jobId);
    await update(tx, scope, job, {
      ...data(job),
      notification: { ...notification, at: new Date().toISOString() },
    });
    await inTx?.(tx);
  });
}

/**
 * Sends the notification of a `telegram_notification` job. Never throws for a
 * delivery problem: it is recorded (see the file comment). Database errors
 * propagate so that the worker retries the job; an outcome already recorded
 * makes the call a no-op, so a retry never sends twice.
 */
export async function sendNotification(
  scope: Scope,
  jobId: string,
  options: NotificationOptions = {},
) {
  const sleep = options.sleep ?? wait;
  const prepared = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const job = await entity(tx, scope, "jobs", jobId);
      const d = data(job);
      if (d.notification) return null;
      const skip = async (reason: string) => {
        await update(tx, scope, job, {
          ...d,
          notification: {
            outcome: "skipped",
            reason,
            at: new Date().toISOString(),
          },
        });
        return null;
      };
      const key = parseKey(d.idempotencyKey);
      if (!key) return skip("UNKNOWN_KIND");
      if (!telegramEnabled()) return skip("DISABLED");
      // A disabled module's notices are not sent (WP2.4).
      if (!ownerEnabled(key.owner, await enabledModules(tx, scope)))
        return skip("MODULE_DISABLED");
      // Only a bot bound to a current owner (R61); anything else is not retried.
      const connection = await linkedTelegramConnection(tx, scope);
      if (!connection) return skip("NO_BOT");
      const sender = telegramSender(connection, { fetch: options.fetch });
      if (!sender) return skip("NO_BOT");
      const built = await key.render(tx, scope, key.kind, key.ref);
      if ("skip" in built) return skip(built.skip);
      return { kind: key.kind, ref: key.ref, sender, message: built };
    },
  );
  if (!prepared) return;
  const { kind, ref, sender, message } = prepared;
  // The image is read outside the transaction (it may live in Drive); without it the text goes alone.
  const image = message.image ? await maybe(message.image) : null;
  const photo = image && image.byteLength <= PHOTO_MAX_BYTES ? image : null;
  const text = () =>
    sender.client.sendMessage(sender.chatId, message.text, message.buttons);
  const steps: Step[] = [];
  if (photo && message.text.length <= CAPTION_MAX)
    steps.push({
      send: () =>
        sender.client.sendPhoto(
          sender.chatId,
          photo,
          message.text,
          message.buttons,
        ),
      fallback: text,
    });
  else if (photo) {
    // The text follows in its own message, so a refused photo is simply left out.
    steps.push({
      send: () => sender.client.sendPhoto(sender.chatId, photo, message.header),
      fallback: async () => undefined,
    });
    steps.push({ send: text });
  } else steps.push({ send: text });
  try {
    await deliver(steps, sleep);
  } catch (error) {
    const code = error instanceof ConnectorError ? error.code : "UNEXPECTED";
    const status =
      error instanceof ConnectorError ? (error.status ?? null) : null;
    await record(scope, jobId, { outcome: "failed", code }, async (tx) => {
      await exception(tx, scope, "TELEGRAM_DELIVERY_FAILED", `${kind}:${ref}`);
      await audit(tx, scope, "telegram.delivery_failed", jobId, {
        kind,
        ref,
        code,
        status,
      });
    });
    return;
  }
  await record(scope, jobId, { outcome: "sent" });
}

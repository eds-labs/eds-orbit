import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { MailSendError } from "./transport.ts";

// One worker at a time per mailbox a second client works on (ADR 0026): the
// polling pass, the barrier before a client removes mail and a takeover from
// the INBOX all hold this. The lock lives in Redis with a short expiry that a
// timer renews, so a crashed holder frees it by itself. A holder whose renewal
// fails stops at the next message (see `held`).

const TTL_MS = 30_000;
const RENEW_MS = 10_000;
const POLL_MS = 100;

const RELEASE = `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
const EXTEND = `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("pexpire",KEYS[1],ARGV[2]) else return 0 end`;

type LockClient = Redis & {
  mailLockRelease(key: string, token: string): Promise<number>;
  mailLockExtend(key: string, token: string, ttl: number): Promise<number>;
};

let redis: LockClient | undefined;
function client() {
  if (!redis) {
    const created = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 2000,
      retryStrategy: () => null,
      lazyConnect: true,
    }) as LockClient;
    created.defineCommand("mailLockRelease", { numberOfKeys: 1, lua: RELEASE });
    created.defineCommand("mailLockExtend", { numberOfKeys: 1, lua: EXTEND });
    created.on("error", () => {});
    created.on("end", () => {
      if (redis === created) redis = undefined;
    });
    redis = created;
  }
  return redis;
}

const lockKey = (connectionId: string) =>
  `orbit:mail-lock:${process.env.PUBLISHER_INSTANCE_ID || "local"}:${connectionId}`;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export type MailboxLock = {
  /** False once the lock may belong to someone else. */
  held(): boolean;
};

/**
 * Runs `work` under the mailbox's lock, waiting at most `waitMs` for it.
 * `acquired: false` when it stayed busy; throws MailSendError LOCK_UNAVAILABLE
 * when Redis cannot be reached, so nobody works unlocked.
 */
export async function withMailboxLock<T>(
  connectionId: string,
  waitMs: number,
  work: (lock: MailboxLock) => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const key = lockKey(connectionId);
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  try {
    for (;;) {
      const got = await client().set(key, token, "PX", TTL_MS, "NX");
      if (got === "OK") break;
      if (Date.now() >= deadline) return { acquired: false };
      await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
    }
  } catch {
    throw new MailSendError("LOCK_UNAVAILABLE");
  }
  let renewedAt = Date.now();
  let lost = false;
  const timer = setInterval(() => {
    client()
      .mailLockExtend(key, token, TTL_MS)
      .then((extended) => {
        if (extended === 1) renewedAt = Date.now();
        else lost = true;
      })
      .catch(() => undefined);
  }, RENEW_MS);
  timer.unref();
  try {
    const value = await work({
      held: () => !lost && Date.now() - renewedAt < TTL_MS,
    });
    return { acquired: true, value };
  } finally {
    clearInterval(timer);
    await client()
      .mailLockRelease(key, token)
      .catch(() => undefined);
  }
}

/** Ends the Redis connection (tests, so the process can exit). */
export function closeMailboxLocks() {
  redis?.disconnect();
  redis = undefined;
}

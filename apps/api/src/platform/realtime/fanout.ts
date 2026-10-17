import Redis, { type RedisOptions } from "ioredis";
import { loadConfig } from "../../../../../packages/config/src/index.ts";

/**
 * Real-time fan-out (WP4.3 Part B, plan 06 S-R5). A writer publishes a
 * change on a Redis channel per project and stream after its transaction
 * committed; SSE endpoints wait on that channel instead of polling the
 * database under the project lock.
 *
 * A message is only a wake-up with the stream's new cursor, never content:
 * the database stays the single source of truth, and no chat or support
 * text passes through Redis. Pub/sub delivers at most once, so a subscriber
 * replays from the database on every wake-up, after (re)subscribing and
 * after Redis comes back; a missed wake-up costs latency, never an event.
 */

/** Off unless ORBIT_REALTIME is "true"; then writers publish and chat SSE waits on Redis. */
export function realtimeEnabled() {
  return loadConfig().ORBIT_REALTIME === "true";
}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
// "<kind>:<uuid>", for example "chat-run:<run id>".
const STREAM =
  /^[a-z][a-z0-9-]{0,39}:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** The Redis channel of one stream in one project, separated per Orbit instance. */
export function realtimeChannel(projectId: string, stream: string) {
  if (!UUID.test(projectId) || !STREAM.test(stream))
    throw new Error("Invalid realtime channel");
  const instance = process.env.PUBLISHER_INSTANCE_ID || "local";
  return `orbit:rt:${instance}:${projectId}:${stream}`;
}

/** The cursor a message carries; null when absent or malformed (replay anyway). */
export function parseWake(message: string): number | null {
  try {
    const cursor = (JSON.parse(message) as { cursor?: unknown }).cursor;
    return Number.isSafeInteger(cursor) ? (cursor as number) : null;
  } catch {
    return null;
  }
}

const reconnect = (attempt: number) => Math.min(attempt * 250, 3000);

let publisher: Redis | undefined;
function publisherClient() {
  if (!publisher) {
    publisher = new Redis(process.env.REDIS_URL!, {
      // A write never waits long on Redis: a queued publish fails after one
      // reconnect attempt, and nobody awaits it on the write path.
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 1000,
      retryStrategy: reconnect,
      lazyConnect: true,
    });
    publisher.on("error", () => {});
  }
  return publisher;
}

/**
 * Publishes a committed change of one stream. Call it after the transaction
 * returned, never inside it: a subscriber that reads before the commit would
 * miss the change until its next replay. Never rejects; a lost message only
 * delays delivery until the subscriber's next replay.
 */
export async function publishChange(
  projectId: string,
  stream: string,
  cursor?: number,
): Promise<void> {
  if (!realtimeEnabled()) return;
  try {
    await publisherClient().publish(
      realtimeChannel(projectId, stream),
      JSON.stringify(cursor === undefined ? {} : { cursor }),
    );
  } catch {
    // Best effort: the database still holds the change.
  }
}

/** One stream's subscriber inside this process. */
export type RealtimeListener = {
  /** A change was published; `cursor` is null when unknown. */
  wake(cursor: number | null): void;
  /** Redis went down (true) or came back and resubscribed (false). */
  degraded(down: boolean): void;
};

export type RealtimeSubscription = {
  /** Whether Redis delivers wake-ups for this subscription right now. */
  readonly live: boolean;
  unsubscribe(): void;
};

/**
 * One subscriber connection per process, shared by all open streams. Each
 * channel is subscribed once, however many streams wait on it, and dropped
 * with its last listener.
 */
export class RealtimeHub {
  private readonly redis: Redis;
  private readonly channels = new Map<string, Set<RealtimeListener>>();
  // Per channel: the SUBSCRIBE of the current connection, true once confirmed.
  private readonly subscribed = new Map<string, Promise<boolean>>();
  private up = false;
  private closed = false;
  private readonly ready: Promise<void>;

  constructor(url: string, options: RedisOptions = {}) {
    this.redis = new Redis(url, {
      connectTimeout: 2000,
      retryStrategy: reconnect,
      // Resubscribing is ours, so every stream replays after an outage.
      autoResubscribe: false,
      // Only SUBSCRIBE and UNSUBSCRIBE go out, and only while connected.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
      ...options,
    });
    this.redis.on("error", () => {});
    this.redis.on("message", (channel: string, message: string) => {
      const cursor = parseWake(message);
      for (const listener of this.channels.get(channel) ?? [])
        listener.wake(cursor);
    });
    this.redis.on("ready", () => void this.restore());
    this.redis.on("close", () => this.lost());
    this.ready = this.redis.connect().catch(() => {});
  }

  /** Whether wake-ups arrive right now. */
  get healthy() {
    return this.up;
  }

  private lost() {
    this.subscribed.clear();
    if (!this.up) return;
    this.up = false;
    for (const listeners of this.channels.values())
      for (const listener of listeners) listener.degraded(true);
  }

  private ensure(channel: string): Promise<boolean> {
    const known = this.subscribed.get(channel);
    if (known) return known;
    const confirmed: Promise<boolean> = this.redis.subscribe(channel).then(
      () => true,
      () => {
        // A failed SUBSCRIBE is retried, never remembered.
        if (this.subscribed.get(channel) === confirmed)
          this.subscribed.delete(channel);
        return false;
      },
    );
    this.subscribed.set(channel, confirmed);
    return confirmed;
  }

  // After a (re)connect, subscribe every open channel again before anyone
  // replays, so no change between the replay and the subscription is missed.
  private async restore() {
    if (this.closed) return;
    const all = await Promise.all(
      [...this.channels.keys()].map((c) => this.ensure(c)),
    );
    if (this.redis.status !== "ready" || this.up || this.closed) return;
    if (all.includes(false)) {
      setTimeout(() => void this.restore(), 1000).unref();
      return;
    }
    this.up = true;
    // Each channel's listeners replay once its subscription is confirmed;
    // that includes channels added while restoring.
    for (const channel of this.channels.keys())
      void this.ensure(channel).then((ok) => {
        if (!ok || !this.up) return;
        for (const listener of this.channels.get(channel) ?? [])
          listener.degraded(false);
      });
  }

  /**
   * Adds a listener and resolves once Redis confirmed the subscription, or
   * with `live: false` when Redis is down; the listener then hears
   * `degraded(false)` once it is back and subscribed.
   */
  async subscribe(
    channel: string,
    listener: RealtimeListener,
    waitMs = 1000,
  ): Promise<RealtimeSubscription> {
    if (this.closed) throw new Error("REALTIME_CLOSED");
    // A fresh hub connects first; a down one does not hold the stream up.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.ready,
      new Promise((resolve) => (timer = setTimeout(resolve, waitMs))),
    ]);
    clearTimeout(timer);
    let listeners = this.channels.get(channel);
    if (!listeners) this.channels.set(channel, (listeners = new Set()));
    listeners.add(listener);
    const live = this.up && (await this.ensure(channel));
    const hub = this;
    let active = true;
    return {
      get live() {
        return active && live && hub.up;
      },
      unsubscribe() {
        if (!active) return;
        active = false;
        const set = hub.channels.get(channel);
        if (!set) return;
        set.delete(listener);
        if (set.size) return;
        hub.channels.delete(channel);
        hub.subscribed.delete(channel);
        if (hub.up) hub.redis.unsubscribe(channel).catch(() => {});
      },
    };
  }

  /** The number of channels this process is subscribed to (tests, health). */
  get channelCount() {
    return this.channels.size;
  }

  async close() {
    this.closed = true;
    this.lost();
    this.channels.clear();
    this.redis.disconnect();
  }
}

let hub: RealtimeHub | undefined;
/** The process's shared hub, created on first use. */
export function realtimeHub() {
  if (!hub) hub = new RealtimeHub(process.env.REDIS_URL!);
  return hub;
}

export async function closeRealtime() {
  const open = hub;
  hub = undefined;
  publisher?.disconnect();
  publisher = undefined;
  await open?.close();
}

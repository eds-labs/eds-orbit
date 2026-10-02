import Redis from "ioredis";
import { postizQueueHealth } from "./postiz-queue-watch.ts";
let redis: Redis | undefined;
function client() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 2000,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    redis.on("error", () => {});
  }
  return redis;
}
/** Aggregated worker queue check results; "unknown" when no fresh check exists. */
export async function postizQueueState() {
  try {
    return postizQueueHealth(
      await client().hgetall(
        "orbit:postiz-queue:" + process.env.PUBLISHER_INSTANCE_ID,
      ),
      new Date(),
    );
  } catch {
    return "unknown" as const;
  }
}
export async function runtimeHealth() {
  try {
    const raw = await client().get(
      "orbit:worker:health:" + process.env.PUBLISHER_INSTANCE_ID,
    );
    const heartbeat = raw ? JSON.parse(raw) : null;
    return {
      worker:
        heartbeat && Date.now() - heartbeat.checkedAt < 30000
          ? "ready"
          : "unavailable",
      lastHeartbeat: heartbeat
        ? new Date(heartbeat.checkedAt).toISOString()
        : null,
      queues: heartbeat?.queues ?? [],
      observedAt: new Date().toISOString(),
    };
  } catch {
    return {
      worker: "unavailable",
      lastHeartbeat: null,
      queues: [],
      observedAt: new Date().toISOString(),
    };
  }
}
export function closeRuntime() {
  redis?.disconnect();
  redis = undefined;
}

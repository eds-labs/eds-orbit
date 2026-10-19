import Redis from "ioredis";
import { registeredPeriodicTask } from "../platform/modules/contributions.ts";
let redis: Redis | undefined;
function client() {
  if (!redis) {
    const created = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 2000,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    created.on("error", () => {});
    // Without retries an ended connection stays closed: drop it, so the next
    // read connects afresh instead of reporting the worker down until restart.
    created.on("end", () => {
      if (redis === created) redis = undefined;
    });
    redis = created;
  }
  return redis;
}
/**
 * The health a periodic worker task published (WP2.1), folded over all
 * projects; "unknown" when no fresh result exists.
 */
export async function periodicTaskHealth(name: string) {
  const summarize = registeredPeriodicTask(name)?.health?.summarize;
  if (!summarize) return "unknown";
  try {
    return summarize(
      await client().hgetall(
        `orbit:${name}:` + process.env.PUBLISHER_INSTANCE_ID,
      ),
      new Date(),
    );
  } catch {
    return "unknown";
  }
}
/** Aggregated worker queue check results; "unknown" when no fresh check exists. */
export const postizQueueState = () => periodicTaskHealth("postiz-queue");
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

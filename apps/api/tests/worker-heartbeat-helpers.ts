import Redis from "ioredis";

// The worker's Redis heartbeat as `runtimeHealth()` reads it
// (apps/api/src/modules/runtime.ts): tests that read the project attention
// write a fresh beat so `platform_worker_down` appears only where a test
// wants the worker gone.

let redis: Redis | undefined;
const key = () => "orbit:worker:health:" + process.env.PUBLISHER_INSTANCE_ID;
const client = () => (redis ??= new Redis(process.env.REDIS_URL!));

/** A heartbeat the API counts as a ready worker for the next 45 seconds. */
export async function workerBeat() {
  await client().set(
    key(),
    JSON.stringify({ checkedAt: Date.now(), queues: [] }),
    "EX",
    45,
  );
}

/** No heartbeat: the API reports the worker unavailable. */
export async function workerSilent() {
  await client().del(key());
}

export function closeWorkerHeartbeat() {
  redis?.disconnect();
  redis = undefined;
}

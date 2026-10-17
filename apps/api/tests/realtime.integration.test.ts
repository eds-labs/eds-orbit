import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import net from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import {
  closeRealtime,
  publishChange,
  RealtimeHub,
} from "../src/platform/realtime/fanout.ts";
import {
  serveEventStream,
  type StreamEvent,
} from "../src/platform/realtime/sse.ts";
import { openStream, p95 } from "./support/sse-client.ts";

/**
 * The real-time fan-out on its own (WP4.3 Part B): an in-memory event log
 * stands in for the database, so every replay is counted. Needs Redis.
 */
const enabled = Boolean(process.env.REDIS_URL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A TCP relay in front of Redis that a test can cut and restore. */
function redisRelay(target: URL) {
  const sockets = new Set<net.Socket>();
  let server: net.Server | undefined;
  let port = 0;
  const relay = {
    url: "",
    async start() {
      server = net.createServer((client) => {
        const upstream = net.connect(
          Number(target.port || 6379),
          target.hostname,
        );
        for (const s of [client, upstream]) {
          sockets.add(s);
          s.on("close", () => sockets.delete(s));
          s.on("error", () => {});
        }
        client.pipe(upstream).pipe(client);
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
      });
      await new Promise<void>((resolve) =>
        server!.listen(port, "127.0.0.1", resolve),
      );
      port = (server.address() as net.AddressInfo).port;
      const url = new URL(target);
      url.hostname = "127.0.0.1";
      url.port = String(port);
      relay.url = url.toString();
    },
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    },
  };
  return relay;
}

describe.skipIf(!enabled)("real-time fan-out", () => {
  const projectId = randomUUID();
  let app: FastifyInstance;
  let base: string;
  let hub: RealtimeHub;
  const logs = new Map<string, StreamEvent[]>();
  const replays = new Map<string, number>();
  const settings = { fallbackPollMs: 200, maxDurationMs: 39000 };

  /** Appends events ("commits") and publishes after each one, like a writer. */
  async function write(stream: string, count = 1, done = false) {
    const log = logs.get(stream)!;
    const written: Array<{ id: number; at: number }> = [];
    for (let i = 0; i < count; i++) {
      const id = (log.at(-1)?.id ?? 0) + 1;
      log.push({
        id,
        event: done && i === count - 1 ? "end" : "message",
        data: { n: id },
      });
      written.push({ id, at: performance.now() });
      await publishChange(projectId, stream, id);
    }
    return written;
  }
  function newStream() {
    const stream = `test:${randomUUID()}`;
    logs.set(stream, []);
    replays.set(stream, 0);
    return stream;
  }

  beforeAll(async () => {
    process.env.ORBIT_REALTIME = "true";
    hub = new RealtimeHub(process.env.REDIS_URL!);
    app = Fastify();
    app.get("/streams/:stream", async (req, reply) => {
      const { stream } = req.params as { stream: string };
      const query = req.query as { hub?: string };
      return serveEventStream(req, reply, {
        projectId,
        stream,
        hub: query.hub === "down" ? downHub! : (activeHub ?? hub),
        ...settings,
        async replay(after) {
          replays.set(stream, (replays.get(stream) ?? 0) + 1);
          const log = logs.get(stream) ?? [];
          const events = log.filter((e) => after === null || e.id > after);
          return { events, done: log.at(-1)?.event === "end" };
        },
      });
    });
    base = await app.listen({ port: 0, host: "127.0.0.1" });
  });
  let downHub: RealtimeHub | undefined;
  let activeHub: RealtimeHub | undefined;
  afterEach(() => {
    settings.fallbackPollMs = 200;
    settings.maxDurationMs = 39000;
    activeHub = undefined;
  });
  afterAll(async () => {
    await app?.close();
    await hub?.close();
    await downHub?.close();
    await closeRealtime();
    delete process.env.ORBIT_REALTIME;
  });

  it("delivers to many concurrent subscribers under 1 s p95 without polling", async () => {
    const stream = newStream();
    const clients = Array.from({ length: 20 }, () =>
      openStream(`${base}/streams/${stream}`),
    );
    // Every client replayed once on connect and is subscribed.
    await expect
      .poll(() => replays.get(stream), { timeout: 5000 })
      .toBe(clients.length);
    await sleep(100);
    const written: Array<{ id: number; at: number }> = [];
    for (let round = 0; round < 25; round++) {
      written.push(...(await write(stream)));
      await sleep(20);
    }
    for (const client of clients)
      expect(await client.until((e) => e.length === written.length)).toBe(true);
    const latencies = clients.flatMap((client) =>
      client.events.map((event, i) => {
        expect(event.id).toBe(written[i]!.id);
        return event.at - written[i]!.at;
      }),
    );
    if (process.env.REALTIME_REPORT)
      appendFileSync(
        process.env.REALTIME_REPORT,
        `fan-out p95 ${p95(latencies).toFixed(1)} ms over ${latencies.length} deliveries` +
          "\n",
      );
    expect(p95(latencies)).toBeLessThan(1000);
    // No database read without a change: two idle seconds, no replay.
    const before = replays.get(stream)!;
    await sleep(2000);
    expect(replays.get(stream)).toBe(before);
    // Wake-ups only: at most one replay per client and write, never a poll.
    expect(before).toBeLessThanOrEqual(clients.length * (1 + written.length));
    expect(hub.channelCount).toBe(1);
    await Promise.all(clients.map((c) => c.close()));
    await expect.poll(() => hub.channelCount).toBe(0);
  });

  it("keeps order and loses nothing under concurrent writers", async () => {
    const stream = newStream();
    const clients = Array.from({ length: 5 }, () =>
      openStream(`${base}/streams/${stream}`),
    );
    await expect
      .poll(() => replays.get(stream), { timeout: 5000 })
      .toBe(clients.length);
    // Writers interleave; the log is the order of commit.
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let i = 0; i < 15; i++) {
          await write(stream);
          await sleep(Math.random() * 10);
        }
      }),
    );
    const ids = logs.get(stream)!.map((e) => e.id);
    for (const client of clients) {
      expect(await client.until((e) => e.length >= ids.length)).toBe(true);
      expect(client.events.map((e) => e.id)).toEqual(ids);
    }
    await Promise.all(clients.map((c) => c.close()));
  });

  it("resumes after Last-Event-ID across repeated cuts and loses no event", async () => {
    settings.maxDurationMs = 400; // Stands in for the 39 s cut before the proxy's 45 s.
    const stream = newStream();
    const received: number[] = [];
    let last: number | null = null;
    let stop = false;
    const writer = (async () => {
      while (!stop) {
        await write(stream);
        await sleep(15);
      }
    })();
    const reconnects = { count: 0 };
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const client = openStream(
        `${base}/streams/${stream}`,
        last === null ? {} : { "last-event-id": String(last) },
      );
      await client.ended;
      for (const event of client.events) received.push(event.id!);
      last = received.at(-1) ?? last;
      reconnects.count++;
      // A pause before reconnecting, as a browser's retry delay.
      await sleep(30);
    }
    stop = true;
    await writer;
    const final = openStream(`${base}/streams/${stream}`, {
      "last-event-id": String(last),
    });
    const total = logs.get(stream)!.length;
    await final.until((e) => (last ?? 0) + e.length >= total);
    await final.close();
    for (const event of final.events) received.push(event.id!);
    expect(reconnects.count).toBeGreaterThanOrEqual(5);
    // Exactly every event once, in order, despite the cuts.
    expect(received).toEqual(logs.get(stream)!.map((e) => e.id));
  });

  it("ignores a malformed Last-Event-ID and replays from the start", async () => {
    const stream = newStream();
    await write(stream, 3, true);
    const client = openStream(`${base}/streams/${stream}`, {
      "last-event-id": "1; DROP",
    });
    await client.ended;
    expect(client.events.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("falls back to slow polling while Redis is unreachable", async () => {
    // Nothing listens on this port; the hub never becomes healthy.
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    downHub = new RealtimeHub(`redis://127.0.0.1:${port}`);
    expect(downHub.healthy).toBe(false);
    const stream = newStream();
    const client = openStream(`${base}/streams/${stream}?hub=down`);
    await expect.poll(() => replays.get(stream)).toBeGreaterThan(0);
    await write(stream, 2);
    expect(await client.until((e) => e.length === 2, 3000)).toBe(true);
    // It polls: about one replay per fallback interval.
    const before = replays.get(stream)!;
    await sleep(1000);
    const polls = replays.get(stream)! - before;
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(polls).toBeLessThanOrEqual(7);
    await write(stream, 1, true);
    await client.ended;
    expect(client.events.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("degrades to polling when Redis drops mid-stream and recovers without loss", async () => {
    const relay = redisRelay(new URL(process.env.REDIS_URL!));
    await relay.start();
    const relayed = new RealtimeHub(relay.url);
    activeHub = relayed;
    await expect.poll(() => relayed.healthy).toBe(true);
    const stream = newStream();
    const client = openStream(`${base}/streams/${stream}`);
    await expect.poll(() => replays.get(stream)).toBe(1);
    await write(stream, 2);
    expect(await client.until((e) => e.length === 2, 2000)).toBe(true);
    const live = replays.get(stream)!;

    // Redis is cut: wake-ups are lost, the stream polls the log instead.
    await relay.stop();
    await expect.poll(() => relayed.healthy).toBe(false);
    await write(stream, 3);
    expect(await client.until((e) => e.length === 5, 3000)).toBe(true);
    expect(replays.get(stream)! - live).toBeGreaterThanOrEqual(1);

    // Redis is back: the hub resubscribes, the stream replays and stops polling.
    await relay.start();
    await expect.poll(() => relayed.healthy, { timeout: 8000 }).toBe(true);
    await write(stream, 2);
    expect(await client.until((e) => e.length === 7, 3000)).toBe(true);
    const settled = replays.get(stream)!;
    await sleep(1000);
    expect(replays.get(stream)).toBe(settled);
    expect(client.events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await client.close();
    await relayed.close();
    await relay.stop();
  });

  it("publishes nothing while ORBIT_REALTIME is off", async () => {
    const stream = newStream();
    const client = openStream(`${base}/streams/${stream}`);
    await expect.poll(() => replays.get(stream)).toBe(1);
    process.env.ORBIT_REALTIME = "false";
    try {
      await write(stream, 2);
      await sleep(500);
      expect(replays.get(stream)).toBe(1);
      expect(client.events).toHaveLength(0);
    } finally {
      process.env.ORBIT_REALTIME = "true";
    }
    await client.close();
  });
});

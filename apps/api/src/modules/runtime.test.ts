import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// A stand-in for ioredis: every client is recorded, `get` answers a fresh
// heartbeat until the client ended (as ioredis' CONNECTION_CLOSED does).
const clients: FakeRedis[] = [];
class FakeRedis extends EventEmitter {
  ended = false;
  constructor(
    readonly url: string,
    readonly options: Record<string, unknown>,
  ) {
    super();
    clients.push(this);
  }
  async get() {
    if (this.ended) throw new Error("Connection is closed.");
    return JSON.stringify({ checkedAt: Date.now(), queues: [] });
  }
  disconnect() {
    this.ended = true;
  }
}
vi.mock("ioredis", () => ({ default: FakeRedis }));

const { closeRuntime, runtimeHealth } = await import("./runtime.ts");

afterEach(() => {
  closeRuntime();
  clients.length = 0;
});

describe("runtime Redis client", () => {
  it("reuses one client while it is open", async () => {
    expect((await runtimeHealth()).worker).toBe("ready");
    expect((await runtimeHealth()).worker).toBe("ready");
    expect(clients).toHaveLength(1);
  });

  it("creates a new client after the old one ended", async () => {
    await runtimeHealth();
    // A Redis blip: without retries ioredis ends the connection for good.
    clients[0]!.ended = true;
    clients[0]!.emit("end");
    expect((await runtimeHealth()).worker).toBe("ready");
    expect(clients).toHaveLength(2);
    // The new client keeps the bounded timeouts and no retries.
    expect(clients[1]!.options).toMatchObject({
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 2000,
    });
    expect((clients[1]!.options.retryStrategy as () => unknown)()).toBeNull();
  });
});

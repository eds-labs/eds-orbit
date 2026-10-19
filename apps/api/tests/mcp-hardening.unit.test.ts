import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../../packages/config/src/index.ts";
import {
  MAX_TOOL_INPUT_ELEMENTS,
  sdkAcceptsArguments,
} from "../src/platform/mcp/adapter.ts";
import {
  busyResult,
  McpBusyError,
  toolFailure,
} from "../src/platform/mcp/errors.ts";
import {
  ipBucket,
  MCP_OUTPUT_LIMIT_BYTES,
  MCP_PROJECT_CONCURRENCY,
  MCP_RATE_LIMITER_MAX_KEYS,
  McpProjectSlots,
  McpRateLimiter,
  McpVerifiedTokens,
} from "../src/platform/mcp/limits.ts";
import {
  itemUrl,
  MCP_URL_MAX_CHARS,
} from "../src/platform/mcp/native/knowledge.ts";
import { fitSearchResults } from "../src/platform/mcp/native/search.ts";
import {
  MCP_SHUTDOWN_TIMEOUT_MS,
  makeShutdown,
} from "../src/platform/mcp/shutdown.ts";
import {
  clipJsonText,
  jsonTextBytes,
} from "../src/platform/knowledge/mcp-read.ts";

// Track M WP-M5, Task 2 (D-M5-6): the gateway hardening items that need no
// database. The gateway-level tests are in mcp-gateway-audit and
// mcp-read-surface.

afterEach(() => {
  vi.useRealTimers();
});

describe("ipBucket (IPv6 /64 keying)", () => {
  it("keeps IPv4 addresses as they are", () => {
    expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
  });

  it("keys IPv6 by its /64 prefix, whatever the notation", () => {
    const a = ipBucket("2001:db8:aa:bb:1:2:3:4");
    expect(a).toBe("2001:db8:aa:bb::/64");
    expect(ipBucket("2001:0DB8:00aa:00bb:ffff:ffff:ffff:ffff")).toBe(a);
    expect(ipBucket("2001:db8:aa:bb::9")).toBe(a);
    expect(ipBucket("[2001:db8:aa:bb::9]")).toBe(a);
    expect(ipBucket("2001:db8:aa:bb::9%eth0")).toBe(a);
    // Another /64 of the same /48 is another bucket.
    expect(ipBucket("2001:db8:aa:bc::1")).toBe("2001:db8:aa:bc::/64");
    expect(ipBucket("::1")).toBe("0:0:0:0::/64");
  });

  it("maps IPv4-mapped IPv6 to the IPv4 address, in either notation", () => {
    expect(ipBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket("::FFFF:cb00:7107")).toBe("203.0.113.7");
    expect(ipBucket("0:0:0:0:0:ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("leaves anything that is not an address as one opaque key", () => {
    expect(ipBucket("not-an-ip")).toBe("not-an-ip");
  });
});

describe("rate limiter size cap", () => {
  it("defaults to 50 000 buckets", () => {
    expect(MCP_RATE_LIMITER_MAX_KEYS).toBe(50_000);
  });

  it("refuses requests that need a new bucket when full, never evicting live windows", () => {
    let now = 1_000_000;
    const limiter = new McpRateLimiter(() => now, 3);
    for (const key of ["a", "b", "c"])
      expect(limiter.take([{ key, max: 5 }])).toEqual({ allowed: true });
    const refused = limiter.take([{ key: "d", max: 5 }]);
    expect(refused).toMatchObject({ allowed: false, label: "capacity" });
    expect(
      (refused as { retryAfterSeconds: number }).retryAfterSeconds,
    ).toBeGreaterThan(0);
    // A refusal counts nothing anywhere: "a" is not charged by a mixed request.
    expect(
      limiter.take([
        { key: "a", max: 5 },
        { key: "e", max: 5 },
      ]),
    ).toMatchObject({ allowed: false, label: "capacity" });
    expect(limiter.size).toBe(3);
    // Existing buckets keep counting (and keep their counts).
    for (let i = 0; i < 4; i++)
      expect(limiter.take([{ key: "a", max: 5 }])).toEqual({ allowed: true });
    expect(limiter.take([{ key: "a", max: 5 }])).toMatchObject({
      allowed: false,
    });
    // Once windows expire there is room again, without waiting for the sweep.
    now += 60_000;
    expect(limiter.take([{ key: "d", max: 5 }])).toEqual({ allowed: true });
  });

  it("check() never refuses for capacity (it adds nothing)", () => {
    const limiter = new McpRateLimiter(() => 0, 1);
    limiter.take([{ key: "a", max: 5 }]);
    expect(limiter.check([{ key: "b", max: 5 }])).toEqual({ allowed: true });
  });
});

describe("verified tokens", () => {
  it("remembers a verified token until its expiry, by hash only", () => {
    let now = 1_000_000;
    const tokens = new McpVerifiedTokens(() => now, 10);
    expect(tokens.has("tok-1")).toBe(false);
    tokens.remember("tok-1", Math.floor(now / 1000) + 60);
    expect(tokens.has("tok-1")).toBe(true);
    expect(JSON.stringify([...tokens.keys()])).not.toContain("tok-1");
    now += 61_000;
    expect(tokens.has("tok-1")).toBe(false);
    tokens.remember("tok-2", Math.floor(now / 1000) + 60);
    tokens.forget("tok-2");
    expect(tokens.has("tok-2")).toBe(false);
    // Without an expiry nothing is remembered.
    tokens.remember("tok-3", undefined);
    expect(tokens.has("tok-3")).toBe(false);
  });

  it("is bounded: the oldest entry makes room", () => {
    const tokens = new McpVerifiedTokens(() => 0, 2);
    for (const token of ["a", "b", "c"]) tokens.remember(token, 3600);
    expect(tokens.size).toBe(2);
    expect(tokens.has("a")).toBe(false);
    expect(tokens.has("c")).toBe(true);
  });
});

describe("project slots (R-10)", () => {
  it("keeps the documented numbers in one place", () => {
    expect(MCP_PROJECT_CONCURRENCY).toEqual({
      perProject: 2,
      waitMs: 10_000,
      queuePerProject: 16,
    });
  });

  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  it("runs two calls per project, queues the next and answers BUSY after the wait", async () => {
    vi.useFakeTimers();
    const slots = new McpProjectSlots();
    const gates: Array<() => void> = [];
    const started: string[] = [];
    const hold = (name: string) => () => {
      started.push(name);
      return new Promise<string>((resolve) => gates.push(() => resolve(name)));
    };
    const first = slots.run("p1", hold("first"));
    const second = slots.run("p1", hold("second"));
    const third = slots.run("p1", hold("third"));
    // Another project is not affected.
    await expect(slots.run("p2", async () => "other")).resolves.toBe("other");
    await flush();
    expect(started).toEqual(["first", "second"]);

    // A slot frees up within the wait: the queued call takes it.
    await vi.advanceTimersByTimeAsync(MCP_PROJECT_CONCURRENCY.waitMs - 1);
    gates[0]!();
    await expect(first).resolves.toBe("first");
    await flush();
    expect(started).toEqual(["first", "second", "third"]);

    // Both slots are held: the next call waits 10 s, then BUSY.
    const busy = slots.run("p1", hold("busy")).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(MCP_PROJECT_CONCURRENCY.waitMs - 1);
    expect(started).not.toContain("busy");
    await vi.advanceTimersByTimeAsync(1);
    expect(await busy).toBeInstanceOf(McpBusyError);
    expect(started).not.toContain("busy");

    gates[1]!();
    gates[2]!();
    await expect(second).resolves.toBe("second");
    await expect(third).resolves.toBe("third");
    // Idle projects are forgotten.
    expect(slots.size).toBe(0);
  });

  it("refuses at once when the queue is full, and frees the slot on failure", async () => {
    vi.useFakeTimers();
    const slots = new McpProjectSlots({
      perProject: 1,
      waitMs: 1000,
      queuePerProject: 1,
    });
    let release!: () => void;
    const running = slots.run(
      "p",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const queued = slots.run("p", async () => "queued");
    await expect(slots.run("p", async () => "x")).rejects.toBeInstanceOf(
      McpBusyError,
    );
    release();
    await running;
    await expect(queued).resolves.toBe("queued");
    await expect(
      slots.run("p", async () => {
        throw new Error("tool failed");
      }),
    ).rejects.toThrow("tool failed");
    await expect(slots.run("p", async () => "after")).resolves.toBe("after");
    expect(slots.size).toBe(0);
  });

  it("a shared deadline bounds the wait: once it has passed, a busy project fails at once", async () => {
    vi.useFakeTimers();
    const slots = new McpProjectSlots({ perProject: 1, waitMs: 1000 });
    let release!: () => void;
    const held = slots.run(
      "p",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const deadline = slots.deadline();
    const first = slots
      .run("p", async () => "x", { deadline })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toBeInstanceOf(McpBusyError);
    // The deadline has passed: no waiting at all now.
    await expect(
      slots.run("p", async () => "y", { deadline }),
    ).rejects.toBeInstanceOf(McpBusyError);
    // A free project still runs past the deadline.
    await expect(slots.run("q", async () => "z", { deadline })).resolves.toBe(
      "z",
    );
    release();
    await held;
    expect(slots.size).toBe(0);
  });

  it("BUSY is fixed text, retryable for reads only", () => {
    expect(busyResult("R0_read").structuredContent).toEqual({
      code: "BUSY",
      message:
        "too many tool calls are running in this project; try again shortly",
      retryable: true,
    });
    expect(busyResult("P_proposal").structuredContent).toMatchObject({
      retryable: false,
    });
    expect(busyResult("W0_internal").structuredContent).toMatchObject({
      retryable: false,
    });
    expect(toolFailure(new McpBusyError(), "req", "R0_read")).toEqual({
      result: busyResult("R0_read"),
      code: "BUSY",
    });
  });
});

describe("shutdown forced exit", () => {
  it("exits 1 after 10 s when a close step hangs, and only once", async () => {
    vi.useFakeTimers();
    expect(MCP_SHUTDOWN_TIMEOUT_MS).toBe(10_000);
    const exit = vi.fn();
    const logged: unknown[][] = [];
    let finish!: () => void;
    const shutdown = makeShutdown({
      steps: [() => new Promise<void>((resolve) => (finish = resolve))],
      exit,
      log: (...args) => logged.push(args),
    });
    void shutdown();
    await vi.advanceTimersByTimeAsync(MCP_SHUTDOWN_TIMEOUT_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.stringify(logged)).toContain("timed out");
    // The hung step finishing late does not exit a second time.
    finish();
    await vi.advanceTimersByTimeAsync(0);
    await shutdown();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("clears the timer when the steps finish in time (exit 0, no forced exit)", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const shutdown = makeShutdown({
      steps: [async () => {}],
      exit,
      log: () => {},
    });
    await shutdown();
    await vi.advanceTimersByTimeAsync(MCP_SHUTDOWN_TIMEOUT_MS * 2);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("does not keep the process alive (unref'd timer)", async () => {
    const unref = vi.fn();
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      const timer = real(fn, ms);
      const original = timer.unref.bind(timer);
      timer.unref = () => {
        unref();
        return original();
      };
      return timer;
    }) as typeof setTimeout);
    try {
      const shutdown = makeShutdown({
        steps: [async () => {}],
        exit: () => {},
        log: () => {},
      });
      await shutdown();
      expect(unref).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("pre-validation follows the SDK's own check", () => {
  const listSchema = z.object({ items: z.array(z.number()) }).strict();

  it("refuses arguments above the element cap the SDK enforces", async () => {
    expect(MAX_TOOL_INPUT_ELEMENTS).toBe(1000);
    const ok = { items: Array.from({ length: 999 }, () => 1) };
    // 1 key + 1000 array items = 1001 elements.
    const over = { items: Array.from({ length: 1000 }, () => 1) };
    expect(await sdkAcceptsArguments(listSchema, ok)).toBe(true);
    expect(listSchema.safeParse(over).success).toBe(true);
    expect(await sdkAcceptsArguments(listSchema, over)).toBe(false);
  });

  it("evaluates async refinements instead of throwing", async () => {
    const schema = z
      .object({ name: z.string() })
      .strict()
      .refine(async (value) => value.name !== "taken");
    expect(() => schema.safeParse({ name: "free" })).toThrow();
    expect(await sdkAcceptsArguments(schema, { name: "free" })).toBe(true);
    expect(await sdkAcceptsArguments(schema, { name: "taken" })).toBe(false);
    // A refinement that throws is a refusal, never an exception.
    const broken = z
      .object({})
      .strict()
      .refine(async () => {
        throw new Error("refinement failed");
      });
    expect(await sdkAcceptsArguments(broken, {})).toBe(false);
  });

  it("treats missing arguments as an empty object, like the SDK", async () => {
    expect(await sdkAcceptsArguments(z.object({}).strict(), undefined)).toBe(
      true,
    );
  });
});

describe("output clipping", () => {
  it("a canonical URL longer than 2048 characters falls back to the deep link", () => {
    expect(MCP_URL_MAX_CHARS).toBe(2048);
    const projectId = "00000000-0000-4000-8000-000000000001";
    const deepLink = `${new URL(loadConfig().APP_ORIGIN).origin}/p/${projectId}/knowledge/library`;
    const fits = `https://docs.example.com/${"a".repeat(2048 - 25)}`;
    expect(fits).toHaveLength(2048);
    expect(itemUrl(projectId, "chunk", fits)).toBe(fits);
    expect(itemUrl(projectId, "chunk", `${fits}b`)).toBe(deepLink);
  });

  it("measures text the way it is sent: JSON-escaped UTF-8", () => {
    expect(jsonTextBytes('a"\\\n')).toBe(1 + 2 + 2 + 2);
    expect(jsonTextBytes("\u0001")).toBe(6);
    expect(jsonTextBytes("é🚀")).toBe(2 + 4);
    // A lone surrogate is escaped by JSON.stringify.
    expect(jsonTextBytes("\ud800")).toBe(6);
    for (const text of ['x"\\\n\t\u0001é🚀\ud800€', "plain"])
      expect(jsonTextBytes(text)).toBe(
        Buffer.byteLength(JSON.stringify(text)) - 2,
      );
  });

  it("clips escape-heavy text to a JSON-escaped budget on a character boundary", () => {
    const text = `${'"\\\u0001'.repeat(20_000)}🚀`;
    const clipped = clipJsonText(text, 1000);
    expect(jsonTextBytes(clipped)).toBeLessThanOrEqual(1000);
    expect(jsonTextBytes(clipped)).toBeGreaterThan(1000 - 6);
    expect(text.startsWith(clipped)).toBe(true);
    expect(clipJsonText("short", 1000)).toBe("short");
    // Never splits a surrogate pair.
    const emoji = "🚀".repeat(10);
    expect(clipJsonText(emoji, 6)).toBe("🚀");
  });

  it("search results always fit the 64 KB output cap", () => {
    const projectId = "00000000-0000-4000-8000-000000000002";
    const heavyTitle = "\u0001".repeat(160);
    const results = Array.from({ length: 30 }, (_, i) => ({
      id: `p:${projectId}:chunk:00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      title: heavyTitle,
      url: `https://docs.example.com/${String(i).padStart(4, "0")}${"u".repeat(2000)}`,
      deepLink: `https://orbit.example/p/${projectId}/knowledge/library`,
    }));
    const naive = JSON.stringify({
      results: results.map(({ deepLink: _, ...r }) => r),
    });
    expect(Buffer.byteLength(naive)).toBeGreaterThan(MCP_OUTPUT_LIMIT_BYTES);
    const fitted = fitSearchResults(results);
    expect(
      Buffer.byteLength(JSON.stringify({ results: fitted })),
    ).toBeLessThanOrEqual(MCP_OUTPUT_LIMIT_BYTES);
    expect(fitted).toHaveLength(30);
    expect(Object.keys(fitted[0]!).sort()).toEqual(["id", "title", "url"]);
    // Only as many URLs as needed fell back; the rest keep their citation.
    expect(
      fitted.some((r) => r.url.startsWith("https://docs.example.com/")),
    ).toBe(true);
    expect(fitted.some((r) => r.url.includes("/knowledge/library"))).toBe(true);
    // Results that already fit are unchanged.
    const small = results.slice(0, 2);
    expect(fitSearchResults(small).map((r) => r.url)).toEqual(
      small.map((r) => r.url),
    );
  });
});

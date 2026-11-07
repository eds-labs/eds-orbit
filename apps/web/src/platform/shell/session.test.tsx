import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, patchNoContent, post, remove } from "@/lib/api";
import {
  connectSessionCache,
  initialSession,
  sessionCache,
  sessionReducer,
  sessionView,
} from "./session";

type Me = { user: { id: string } };
const me: Me = { user: { id: "u1" } };
const other: Me = { user: { id: "u2" } };

// A fetch that answers every request with `status` and `body`.
function answer(status: number, body: unknown = {}) {
  const fetch = vi.fn(
    async () =>
      new Response(status === 204 ? null : JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sessionCache", () => {
  it("reuses an answer within 30 s and shows it stale afterwards", async () => {
    const cache = sessionCache();
    const fetcher = vi.fn(async () => me);
    expect(cache.peek("/me", 0)).toBeUndefined();
    expect(await cache.load("/me", fetcher, 0)).toBe(me);
    expect(cache.peek("/me", 29_999)).toEqual({ data: me, fresh: true });
    // Expired: still shown on a remount, but a load asks again.
    expect(cache.peek("/me", 30_000)).toEqual({ data: me, fresh: false });
    await cache.load("/me", fetcher, 30_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Each path has its own entry.
    expect(cache.peek("/setup", 1)).toBeUndefined();
  });

  it("shares a request in flight", async () => {
    const cache = sessionCache();
    const fetcher = vi.fn(async () => me);
    const [a, b] = [cache.load("/me", fetcher, 0), cache.load("/me", fetcher)];
    expect(cache.peek("/me", 0)).toBeUndefined();
    expect(await a).toBe(await b);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not cache errors and keeps the last answer stale", async () => {
    const cache = sessionCache();
    const down = async (): Promise<Me> => {
      throw new Error("down");
    };
    await expect(cache.load("/me", down, 0)).rejects.toThrow("down");
    expect(cache.peek("/me", 1)).toBeUndefined();
    await cache.load("/me", async () => me, 1);
    await expect(cache.load("/me", down, 30_001)).rejects.toThrow("down");
    expect(cache.peek("/me", 30_002)).toEqual({ data: me, fresh: false });
    // The failed request is not shared with the next load.
    expect(await cache.load("/me", async () => other, 30_003)).toBe(other);
  });

  it("a write makes every answer ask again, requests in flight included", async () => {
    const cache = sessionCache();
    await cache.load("/setup", async () => ({ configured: true }), 0);
    let resolve!: (value: Me) => void;
    const pending = cache.load(
      "/me",
      () => new Promise<Me>((r) => (resolve = r)),
      0,
    );
    cache.stale();
    resolve(me);
    await pending;
    // Answered, but possibly before the write: shown, not trusted.
    expect(cache.peek("/me", 1)).toEqual({ data: me, fresh: false });
    expect(cache.peek("/setup", 1)?.fresh).toBe(false);
    // The next answer is fresh again.
    await cache.load("/me", async () => other, 2);
    expect(cache.peek("/me", 3)).toEqual({ data: other, fresh: true });
  });

  it("a refresh drops the answer and a request in flight", async () => {
    const cache = sessionCache();
    await cache.load("/me", async () => me, 0);
    await cache.load("/setup", async () => ({ configured: true }), 0);
    cache.drop("/me");
    expect(cache.peek("/me", 1)).toBeUndefined();
    expect(cache.peek("/setup", 1)?.fresh).toBe(true);
    let resolve!: (value: Me) => void;
    const old = cache.load("/me", () => new Promise<Me>((r) => (resolve = r)));
    cache.drop("/me");
    const fetcher = vi.fn(async () => other);
    expect(await cache.load("/me", fetcher, 2)).toBe(other);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // The dropped request does not overwrite the newer answer.
    resolve(me);
    await old;
    expect(cache.peek("/me", 3)).toEqual({ data: other, fresh: true });
  });

  it("clear() forgets everything; a request in flight does not refill it", async () => {
    const cache = sessionCache();
    await cache.load("/setup", async () => ({ configured: true }), 0);
    let resolve!: (value: Me) => void;
    const pending = cache.load(
      "/me",
      () => new Promise<Me>((r) => (resolve = r)),
      0,
    );
    cache.clear();
    resolve(me);
    await pending;
    expect(cache.peek("/me", 1)).toBeUndefined();
    expect(cache.peek("/setup", 1)).toBeUndefined();
  });
});

describe("connectSessionCache", () => {
  async function connected() {
    const cache = sessionCache();
    await cache.load("/me", async () => me);
    const channel = { postMessage: vi.fn(), onmessage: null };
    const disconnect = connectSessionCache(cache, channel);
    return { cache, channel, disconnect };
  }

  it("a 401 from any read forgets the session in every tab", async () => {
    const { cache, channel, disconnect } = await connected();
    answer(401, { error: { code: "UNAUTHENTICATED" } });
    await expect(api("/projects/p1/dashboard")).rejects.toMatchObject({
      status: 401,
    });
    expect(cache.peek("/me")).toBeUndefined();
    expect(channel.postMessage).toHaveBeenCalledTimes(1);
    disconnect();
  });

  it("signing out or in forgets the session in every tab", async () => {
    for (const path of ["/auth/sign-out", "/auth/sign-in/email"]) {
      const { cache, channel, disconnect } = await connected();
      answer(200, { ok: true });
      await post(path, {});
      expect(cache.peek("/me")).toBeUndefined();
      expect(channel.postMessage).toHaveBeenCalledTimes(1);
      disconnect();
    }
  });

  it("another tab's change forgets the session here", async () => {
    const { cache, channel, disconnect } = await connected();
    (channel.onmessage as unknown as () => void)();
    expect(cache.peek("/me")).toBeUndefined();
    // Hearing it does not send it on.
    expect(channel.postMessage).not.toHaveBeenCalled();
    disconnect();
  });

  it("any other write makes the next mount ask again", async () => {
    const { cache, channel, disconnect } = await connected();
    answer(200, { id: "w2" });
    await post("/workspaces", { name: "New" });
    expect(cache.peek("/me")).toEqual({ data: me, fresh: false });
    await cache.load("/me", async () => me);
    answer(204);
    await remove("/projects/p1/assets/a1");
    expect(cache.peek("/me")?.fresh).toBe(false);
    await cache.load("/me", async () => me);
    answer(204);
    await patchNoContent("/projects/p1/notes/n1", {});
    expect(cache.peek("/me")?.fresh).toBe(false);
    expect(channel.postMessage).not.toHaveBeenCalled();
    disconnect();
  });

  it("reads leave the cache alone, and a 401 of remove() counts", async () => {
    const { cache, channel, disconnect } = await connected();
    answer(200, me);
    await api("/me");
    await api("/projects/p1/attention", { method: "GET" });
    expect(cache.peek("/me")?.fresh).toBe(true);
    answer(401);
    await expect(remove("/projects/p1/assets/a1")).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(cache.peek("/me")).toBeUndefined();
    expect(channel.postMessage).toHaveBeenCalledTimes(1);
    disconnect();
  });
});

describe("session state", () => {
  const error = (status: number) => new ApiError("X", status);

  it("starts from a cached answer without the boot screen, else loading", () => {
    expect(sessionView(initialSession("/me", me), "/me")).toEqual({
      data: me,
      error: null,
      loading: false,
      cached: true,
    });
    expect(sessionView(initialSession("/me", undefined), "/me")).toEqual({
      data: null,
      error: null,
      loading: true,
      cached: false,
    });
    // No path (the installation is not set up): nothing to load.
    expect(sessionView(initialSession(null, undefined), null)).toEqual({
      data: null,
      error: null,
      loading: false,
      cached: false,
    });
  });

  it("a load confirms the cached answer", () => {
    const loaded = sessionReducer(initialSession("/me", me), {
      type: "loaded",
      path: "/me",
      data: other,
    });
    expect(sessionView(loaded, "/me")).toEqual({
      data: other,
      error: null,
      loading: false,
      cached: false,
    });
  });

  it("a refresh shows nothing until it is answered", () => {
    const loaded = sessionReducer(initialSession<Me>("/me", undefined), {
      type: "loaded",
      path: "/me",
      data: me,
    });
    const refreshing = sessionReducer(loaded, { type: "loading", path: "/me" });
    expect(sessionView(refreshing, "/me")).toMatchObject({
      data: null,
      loading: true,
    });
  });

  it("a failed check keeps the cached answer, except after a 401", () => {
    const cached = initialSession("/me", me);
    expect(
      sessionReducer(cached, {
        type: "failed",
        path: "/me",
        error: error(503),
      }),
    ).toBe(cached);
    expect(
      sessionView(
        sessionReducer(cached, {
          type: "failed",
          path: "/me",
          error: error(401),
        }),
        "/me",
      ),
    ).toEqual({ data: null, error: error(401), loading: false, cached: false });
    // Without a cached answer the error shows, as before.
    expect(
      sessionView(
        sessionReducer(initialSession<Me>("/me", undefined), {
          type: "failed",
          path: "/me",
          error: error(503),
        }),
        "/me",
      ),
    ).toMatchObject({ data: null, loading: false, error: error(503) });
  });

  it("a cached hit keeps the state object", () => {
    const cached = initialSession("/me", me);
    expect(
      sessionReducer(cached, { type: "cached", path: "/me", data: me }),
    ).toBe(cached);
  });

  it("shows nothing of another path", () => {
    const loaded = initialSession("/me", me);
    expect(sessionView(loaded, null)).toEqual({
      data: null,
      error: null,
      loading: false,
      cached: false,
    });
    expect(sessionView(initialSession<Me>(null, undefined), "/me")).toEqual({
      data: null,
      error: null,
      loading: true,
      cached: false,
    });
  });
});

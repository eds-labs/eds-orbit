"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, onApiEvent, type ApiEvent } from "@/lib/api";

// The shell's session reads, GET /api/setup and GET /api/me, through a client
// cache that outlives the shell's remount on every navigation (ruling R15),
// like the attention cache (attention.tsx). Without it each click showed the
// boot screen until both reads returned again.

/** How long a loaded answer is used without asking the server again. */
const TTL_MS = 30_000;

type Entry = {
  /** The last successful answer, if any. */
  data?: unknown;
  /** Until when `data` is used without asking the server. */
  freshUntil: number;
  /** The request in flight, shared by every load. */
  request?: Promise<unknown>;
};

/**
 * The client cache of the session reads, one entry per path. A fresh answer
 * (within the TTL) is reused without a request; an older one is still shown
 * while a load asks again. A request in flight is shared. A failed request
 * keeps the last answer, stale. `stale()` (after a write) makes every answer
 * ask again, requests in flight included; `drop(path)` (a refresh) and
 * `clear()` (sign-out, 401) forget answers and requests in flight.
 */
export function sessionCache(ttlMs = TTL_MS) {
  const entries = new Map<string, Entry>();
  // Bumped by `stale()` and `clear()`: a request in flight then stores its
  // answer as stale, since it may have been answered before the change.
  let epoch = 0;
  return {
    /** The stored answer and whether it is fresh. */
    peek<T>(
      path: string,
      now = Date.now(),
    ): { data: T; fresh: boolean } | undefined {
      const entry = entries.get(path);
      return entry?.data === undefined
        ? undefined
        : { data: entry.data as T, fresh: now < entry.freshUntil };
    },
    load<T>(path: string, fetcher: () => Promise<T>, now = Date.now()) {
      const last = entries.get(path);
      if (last?.request) return last.request as Promise<T>;
      const started = epoch;
      const request = fetcher();
      const entry: Entry = {
        data: last?.data,
        freshUntil: last?.freshUntil ?? -Infinity,
        request,
      };
      entries.set(path, entry);
      request.then(
        (data) => {
          if (entries.get(path) !== entry) return;
          entries.set(path, {
            data,
            freshUntil: epoch === started ? now + ttlMs : -Infinity,
          });
        },
        () => {
          if (entries.get(path) === entry) delete entry.request;
        },
      );
      return request;
    },
    stale() {
      epoch++;
      for (const entry of entries.values()) entry.freshUntil = -Infinity;
    },
    drop(path: string) {
      entries.delete(path);
    },
    clear() {
      epoch++;
      entries.clear();
    },
  };
}

export type SessionCache = ReturnType<typeof sessionCache>;

type Channel = Pick<BroadcastChannel, "postMessage" | "onmessage">;

/**
 * Keeps `cache` in step with the API's answers. A 401 or an /auth write
 * (sign-in, sign-out) forgets every answer, in this tab and, through
 * `channel`, in the browser's other tabs, which share the session cookie.
 * Any other write may have changed the identity (a new organization, a
 * role): the next mount asks again.
 */
export function connectSessionCache(
  cache: SessionCache,
  channel: Channel | null,
): () => void {
  if (channel) channel.onmessage = () => cache.clear();
  return onApiEvent((event: ApiEvent) => {
    if (event.type === "write" && !event.path.startsWith("/auth/"))
      cache.stale();
    else {
      cache.clear();
      channel?.postMessage("changed");
    }
  });
}

const shared = sessionCache();

// Only in the browser: the server never loads the session reads.
if (typeof window !== "undefined")
  connectSessionCache(
    shared,
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel("orbit.session"),
  );

/** Forgets every cached session answer: the user signed out. */
export function clearSessionCache() {
  shared.clear();
}

type SessionState<T> = {
  path: string | null;
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  cached: boolean;
};

export type SessionEvent<T> =
  | { type: "cached"; path: string; data: T }
  | { type: "loading"; path: string }
  | { type: "loaded"; path: string; data: T }
  | { type: "failed"; path: string; error: ApiError };

/** The first state: a cached answer if any, fresh or not (no boot screen). */
export function initialSession<T>(
  path: string | null,
  cached: T | undefined,
): SessionState<T> {
  return {
    path,
    data: cached ?? null,
    error: null,
    loading: Boolean(path) && cached === undefined,
    cached: cached !== undefined,
  };
}

/**
 * The state transitions. A failed load keeps a cached answer it was checking,
 * except for a 401: the session is gone.
 */
export function sessionReducer<T>(
  last: SessionState<T>,
  event: SessionEvent<T>,
): SessionState<T> {
  switch (event.type) {
    case "cached":
      return last.path === event.path &&
        last.data === event.data &&
        last.cached &&
        !last.loading
        ? last
        : {
            path: event.path,
            data: event.data,
            error: null,
            loading: false,
            cached: true,
          };
    case "loading":
      return {
        path: event.path,
        data: null,
        error: null,
        loading: true,
        cached: false,
      };
    case "loaded":
      return {
        path: event.path,
        data: event.data,
        error: null,
        loading: false,
        cached: false,
      };
    case "failed":
      return last.path === event.path &&
        last.cached &&
        event.error?.status !== 401
        ? last
        : {
            path: event.path,
            data: null,
            error: event.error,
            loading: false,
            cached: false,
          };
  }
}

/** What the hook shows for `path`: nothing that belongs to another path. */
export function sessionView<T>(
  state: SessionState<T>,
  path: string | null,
): Omit<SessionState<T>, "path"> {
  const { path: owner, ...view } = state;
  return owner === path
    ? view
    : { data: null, error: null, loading: Boolean(path), cached: false };
}

/**
 * `useResource` for the shell's session reads, through the cache: a remount
 * shows the cached answer at once and asks the server again only once it is
 * stale. `cached` says the answer has not been confirmed since this mount.
 * `refresh()` forgets the answer and loads it again, with `loading` set as on
 * the first load.
 */
export function useSessionResource<T>(path: string | null) {
  const [state, setState] = useState(() =>
    initialSession<T>(path, path ? shared.peek<T>(path)?.data : undefined),
  );
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!path) return;
    const dispatch = (event: SessionEvent<T>) =>
      setState((last) => sessionReducer(last, event));
    const hit = shared.peek<T>(path);
    dispatch(
      hit
        ? { type: "cached", path, data: hit.data }
        : { type: "loading", path },
    );
    if (hit?.fresh) return;
    let live = true;
    shared
      .load(path, () => api<T>(path))
      .then(
        (data) => {
          if (live) dispatch({ type: "loaded", path, data });
        },
        (error: ApiError) => {
          if (live) dispatch({ type: "failed", path, error });
        },
      );
    return () => {
      live = false;
    };
  }, [path, revision]);
  const refresh = useCallback(() => {
    if (path) shared.drop(path);
    setRevision((n) => n + 1);
  }, [path]);
  return useMemo(
    () => ({ ...sessionView(state, path), refresh }),
    [state, path, refresh],
  );
}

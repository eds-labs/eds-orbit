"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, type AttentionItem, type AttentionResponse } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { useShell, type AttentionState } from "./shell-context";
import type {
  AttentionRenderer,
  AttentionText,
  Label,
  WebRegistry,
} from "./types";

// The project's attention items in the web (UI restructure §4.3, §4.4): one
// load in the shell, shared through ShellContext by the sidebar badges and
// the home page, and the texts the modules and the platform give each kind.

export type { AttentionState } from "./shell-context";

/** How long a loaded response is reused (§4.4: at most every 30 s). */
const TTL_MS = 30_000;

type CacheEntry = {
  revision: number;
  at: number;
  request: Promise<AttentionResponse>;
  data?: AttentionResponse;
};

/**
 * Whose attention: the signed-in user and the open project. The response is
 * filtered by the member's roles, so it is never shared between users.
 */
export function attentionKey(
  userId: string | undefined,
  projectId: string | undefined,
): string | undefined {
  return userId && projectId ? `${userId}:${projectId}` : undefined;
}

/**
 * The client cache of attention responses, one entry per user and project
 * (ruling R15): the shell remounts on every navigation, so its state cannot
 * throttle the reload. A load within the TTL for the same key and workspace
 * revision reuses the stored response or the request in flight; another
 * revision or an expired entry fetches again. A failed request is dropped,
 * and `clear()` (on sign-out) drops everything, requests in flight included.
 */
export function attentionCache(ttlMs = TTL_MS) {
  const entries = new Map<string, CacheEntry>();
  const fresh = (key: string, revision: number, now: number) => {
    const entry = entries.get(key);
    return entry && entry.revision === revision && now - entry.at < ttlMs
      ? entry
      : undefined;
  };
  return {
    /** The stored response, if loaded and still fresh. */
    peek(key: string, revision: number, now = Date.now()) {
      return fresh(key, revision, now)?.data;
    },
    load(
      key: string,
      revision: number,
      fetcher: () => Promise<AttentionResponse>,
      now = Date.now(),
    ): Promise<AttentionResponse> {
      const hit = fresh(key, revision, now);
      if (hit) return hit.request;
      const entry: CacheEntry = { revision, at: now, request: fetcher() };
      entries.set(key, entry);
      entry.request.then(
        (data) => {
          entry.data = data;
        },
        () => {
          if (entries.get(key) === entry) entries.delete(key);
        },
      );
      return entry.request;
    },
    clear() {
      entries.clear();
    },
  };
}

const shared = attentionCache();

/** Forgets every cached response: the user signed out or is signed out. */
export function clearAttentionCache() {
  shared.clear();
}

/** The shell's attention state with the key it belongs to. */
export type AttentionLoad = AttentionState & { key?: string };

export type AttentionEvent =
  | { type: "cached"; key: string; data: AttentionResponse }
  | { type: "loading"; key: string }
  | { type: "loaded"; key: string; data: AttentionResponse }
  | { type: "failed"; key: string; error: unknown };

/** The first state: the cached response if any (no flicker on a remount). */
export function initialAttention(
  key: string | undefined,
  cached: AttentionResponse | undefined,
): AttentionLoad {
  return { key, data: cached, loading: Boolean(key) && !cached };
}

/**
 * The state transitions: while reloading, the last data stays only for the
 * same user and project; an error replaces the data.
 */
export function attentionReducer(
  last: AttentionLoad,
  event: AttentionEvent,
): AttentionLoad {
  switch (event.type) {
    case "cached":
      return last.key === event.key &&
        last.data === event.data &&
        !last.error &&
        !last.loading
        ? last
        : { key: event.key, data: event.data, loading: false };
    case "loading":
      return {
        key: event.key,
        data: last.key === event.key ? last.data : undefined,
        loading: true,
      };
    case "loaded":
      return { key: event.key, data: event.data, loading: false };
    case "failed":
      return { key: event.key, error: event.error, loading: false };
  }
}

/** What the shell shows for `key`: nothing that belongs to another key. */
export function attentionView(
  state: AttentionLoad,
  key: string | undefined,
): AttentionState {
  return key && state.key === key
    ? { data: state.data, error: state.error, loading: state.loading }
    : { loading: Boolean(key) };
}

/**
 * Loads the open project's attention for the signed-in user: again when the
 * workspace revision changes and on navigation, both through the 30 s cache.
 */
export function useAttentionLoad(
  userId: string | undefined,
  projectId: string | undefined,
  revision: number,
  pathname: string,
): AttentionState {
  const key = attentionKey(userId, projectId);
  const [state, setState] = useState<AttentionLoad>(() =>
    initialAttention(key, key ? shared.peek(key, revision) : undefined),
  );
  useEffect(() => {
    if (!key || !projectId) return;
    const dispatch = (event: AttentionEvent) =>
      setState((last) => attentionReducer(last, event));
    const cached = shared.peek(key, revision);
    if (cached) {
      dispatch({ type: "cached", key, data: cached });
      return;
    }
    let live = true;
    dispatch({ type: "loading", key });
    shared
      .load(key, revision, () =>
        api<AttentionResponse>(
          `/projects/${encodeURIComponent(projectId)}/attention?revision=${revision}`,
        ),
      )
      .then(
        (data) => {
          if (live) dispatch({ type: "loaded", key, data });
        },
        (error: unknown) => {
          if (live) dispatch({ type: "failed", key, error });
        },
      );
    return () => {
      live = false;
    };
  }, [key, projectId, revision, pathname]);
  return useMemo(() => attentionView(state, key), [state, key]);
}

/** The open project's attention items, as the shell loaded them. */
export function useAttention(): AttentionState {
  return useShell().attention;
}

/**
 * The sidebar badges: counts per navKey, which is the route key of the nav
 * entry, and the keys with a critical item. Nothing while loading or after a
 * failed load: the navigation works without them.
 */
export function navBadges(attention: AttentionState): {
  counts: Readonly<Record<string, number>>;
  urgent: ReadonlySet<string>;
} {
  if (attention.error || !attention.data)
    return { counts: {}, urgent: new Set() };
  return {
    counts: attention.data.counts,
    urgent: new Set(
      attention.data.items
        .filter((item) => item.severity === "critical")
        .map((item) => item.navKey),
    ),
  };
}

/**
 * The badge of the bottom bar's "More" button: the counts of the sidebar
 * entries the bar does not show (such as Operations), urgent if any of them
 * is. Keys without a visible entry are left out, as in the sidebar.
 */
export function overflowBadge(
  badges: ReturnType<typeof navBadges>,
  visibleKeys: readonly string[],
  barKeys: readonly string[],
): { count: number; urgent: boolean } {
  const hidden = visibleKeys.filter(
    (key) => !barKeys.includes(key) && (badges.counts[key] ?? 0) > 0,
  );
  return {
    count: hidden.reduce((sum, key) => sum + badges.counts[key]!, 0),
    urgent: hidden.some((key) => badges.urgent.has(key)),
  };
}

/** Every attention renderer by kind: the platform's and each module's. */
export function attentionRenderers(
  registry: WebRegistry,
): Readonly<Record<string, AttentionRenderer>> {
  return Object.assign(
    {},
    registry.attention ?? {},
    ...registry.modules.map((m) => m.attention ?? {}),
  );
}

type ModuleName = { id: string; displayName: Label };

const OPEN: Label = { en: "Open", de: "Öffnen" };

/**
 * The text of an item: its kind's renderer, or for a kind this web build does
 * not know (a newer API) the module's name and the kind.
 */
export function renderAttention(
  item: AttentionItem,
  renderers: Readonly<Record<string, AttentionRenderer>>,
  locale: Locale,
  modules: readonly ModuleName[] = [],
): AttentionText {
  const render = renderers[item.kind];
  if (render) return render(item, locale);
  const module = modules.find((m) => m.id === item.moduleId);
  return {
    title:
      module?.displayName[locale] ??
      (item.moduleId === "platform" ? "Orbit" : item.moduleId),
    detail: item.kind,
    action: OPEN,
  };
}

/** A plain row for an item of an unknown kind: module, kind and a link. */
export function GenericAttentionRow({
  item,
  href,
  locale,
  modules,
}: {
  item: AttentionItem;
  /** The item's `link` inside the open project. */
  href: string;
  locale: Locale;
  modules: readonly ModuleName[];
}) {
  const text = renderAttention(item, {}, locale, modules);
  return (
    <div className="attention-row">
      <span className="attention-title">{text.title}</span>
      <span className="attention-detail">{text.detail}</span>
      <Link className="attention-action" href={href}>
        {text.action[locale]}
        <span className="sr-only">{`: ${text.title}`}</span>
      </Link>
    </div>
  );
}

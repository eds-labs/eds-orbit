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
 * The client cache of attention responses, one entry per project (ruling
 * R15): the shell remounts on every navigation, so its state cannot throttle
 * the reload. A load within the TTL for the same project and workspace
 * revision reuses the stored response or the request in flight; another
 * revision or an expired entry fetches again. A failed request is dropped.
 */
export function attentionCache(ttlMs = TTL_MS) {
  const entries = new Map<string, CacheEntry>();
  const fresh = (projectId: string, revision: number, now: number) => {
    const entry = entries.get(projectId);
    return entry && entry.revision === revision && now - entry.at < ttlMs
      ? entry
      : undefined;
  };
  return {
    /** The stored response, if loaded and still fresh. */
    peek(projectId: string, revision: number, now = Date.now()) {
      return fresh(projectId, revision, now)?.data;
    },
    load(
      projectId: string,
      revision: number,
      fetcher: () => Promise<AttentionResponse>,
      now = Date.now(),
    ): Promise<AttentionResponse> {
      const hit = fresh(projectId, revision, now);
      if (hit) return hit.request;
      const entry: CacheEntry = { revision, at: now, request: fetcher() };
      entries.set(projectId, entry);
      entry.request.then(
        (data) => {
          entry.data = data;
        },
        () => {
          if (entries.get(projectId) === entry) entries.delete(projectId);
        },
      );
      return entry.request;
    },
  };
}

const shared = attentionCache();

/**
 * Loads the open project's attention for the shell: again when the workspace
 * revision changes and on navigation, both through the 30 s cache. While it
 * reloads, the last response stays shown; a failure shows none.
 */
export function useAttentionLoad(
  projectId: string | undefined,
  revision: number,
  pathname: string,
): AttentionState {
  type Loaded = AttentionState & { projectId?: string };
  const [state, setState] = useState<Loaded>(() => {
    // A remount within the TTL starts with the cached response: no flicker.
    const data = projectId ? shared.peek(projectId, revision) : undefined;
    return { projectId, data, loading: Boolean(projectId) && !data };
  });
  useEffect(() => {
    if (!projectId) return;
    const cached = shared.peek(projectId, revision);
    if (cached) {
      setState((last) =>
        last.projectId === projectId && last.data === cached
          ? last
          : { projectId, data: cached, loading: false },
      );
      return;
    }
    let live = true;
    setState((last) => ({
      projectId,
      data: last.projectId === projectId ? last.data : undefined,
      loading: true,
    }));
    shared
      .load(projectId, revision, () =>
        api<AttentionResponse>(
          `/projects/${encodeURIComponent(projectId)}/attention?revision=${revision}`,
        ),
      )
      .then(
        (data) => {
          if (live) setState({ projectId, data, loading: false });
        },
        (error: unknown) => {
          if (live) setState({ projectId, error, loading: false });
        },
      );
    return () => {
      live = false;
    };
  }, [projectId, revision, pathname]);
  return useMemo(
    () =>
      projectId && state.projectId === projectId
        ? { data: state.data, error: state.error, loading: state.loading }
        : { loading: Boolean(projectId) },
    [projectId, state],
  );
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

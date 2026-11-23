"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Route } from "./routes";

export type NavigationCount = {
  total: number;
  complete: boolean;
  counts: Readonly<Record<string, number | null>>;
};

export type NavigationCounts = Readonly<Record<string, NavigationCount>>;

export function useNavigationCounts(
  userId: string | undefined,
  projectId: string | undefined,
  routes: readonly Route[],
) {
  const scope =
    userId && projectId && routes.length
      ? JSON.stringify([
          userId,
          projectId,
          routes.flatMap(({ key, nav }) =>
            nav?.count ? [[key, nav.count.path(projectId)]] : [],
          ),
        ])
      : null;
  const [loaded, setLoaded] = useState<{
    scope: string;
    counts: NavigationCounts;
  }>();
  const [revision, setRevision] = useState(0);
  const refreshNavCounts = useCallback(() => setRevision((n) => n + 1), []);

  useEffect(() => {
    if (!scope) {
      setLoaded(undefined);
      return;
    }
    const [, , endpoints] = JSON.parse(scope) as [
      string,
      string,
      [string, string][],
    ];
    const controller = new AbortController();
    let pending = false;
    const poll = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      const counts = await Promise.all(
        endpoints.map(async ([key, path]) => {
          try {
            return [
              [
                key,
                await api<NavigationCount>(path, { signal: controller.signal }),
              ] as const,
            ];
          } catch {
            return [];
          }
        }),
      );
      pending = false;
      if (!controller.signal.aborted)
        setLoaded({ scope, counts: Object.fromEntries(counts.flat()) });
    };
    void poll();
    const timer = window.setInterval(poll, 60_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [scope, revision]);

  return {
    navCounts: loaded?.scope === scope ? loaded?.counts : undefined,
    refreshNavCounts,
  };
}

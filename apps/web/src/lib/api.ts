import { useCallback, useEffect, useRef, useState } from "react";
import type { EntityView } from "../../../../packages/schemas/src/index";
export type Entity = EntityView;
export type Project = {
  id: string;
  workspaceId: string;
  name: string;
  timezone: string;
  language: "en" | "de";
  mode: string;
  paused: boolean;
  generation: number;
  role?: "owner" | "editor" | "viewer";
};
export type Identity = {
  user: { id: string; name: string; email: string };
  projects: Project[];
  workspaces: Array<{ id: string; name: string; role?: string }>;
};
export type Dashboard = {
  project: Project;
  counts: Record<string, number>;
  exceptions: Entity[];
  publications: Entity[];
  jobs: Entity[];
  budget: {
    reservedMicros: number;
    spentMicros: number;
    dailyLimitMicros: number | null;
    monthlyLimitMicros: number | null;
  };
  readiness: {
    state: string;
    blockers: string[];
    capabilities?: Record<string, { state: string; liveBlocker?: string }>;
    actions?: Record<
      string,
      {
        state: "ready" | "blocked" | "not_configured";
        effect: "internal" | "external";
        blockers: string[];
      }
    >;
  };
};
/**
 * One thing that needs attention (UI restructure §4.1), as
 * GET /api/projects/:id/attention returns it. Hand-written like `Dashboard`;
 * the server type is apps/api/src/platform/attention/types.ts.
 */
export type AttentionItem = {
  /** Stable per object, such as "support:sla:<ticketId>". */
  id: string;
  /** The owning module, or "platform". */
  moduleId: string;
  /** Such as "support_sla_at_risk"; the web renders the text. */
  kind: string;
  severity: "critical" | "warning" | "info";
  /** For aggregated items ("2 unassigned tickets"). */
  count?: number;
  /** ISO time the item becomes worse or expires. */
  dueAt?: string;
  /** ISO time the item started waiting. */
  since?: string;
  params: Record<string, string | number | boolean>;
  /** The nav entry (route key) the item belongs to, for badges. */
  navKey: string;
  /** In-app path below /p/:id, such as "/support/tickets?ticket=<id>". */
  link: string;
};
export type AttentionResponse = {
  /** Sorted, at most 50. */
  items: AttentionItem[];
  /** Per navKey: `count ?? 1` summed over all items before the cap. */
  counts: Record<string, number>;
  status: {
    paused: boolean;
    mode?: string;
    /** The UTC month's AI spend and the active policy's monthly limit. */
    aiMonth: { spentMicros: number; limitMicros: number | null };
  };
};
export { ApiError } from "@orbit/api-client";
import { request, ApiError } from "@orbit/api-client";
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  return request<T>(`/api${path}`, options);
}
export function post<T>(path: string, data: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(data) });
}
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState<ApiError | null>(null),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setData(null);
    setError(null);
    api<T>(path, { signal: controller.signal })
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, revision]);
  return { data, error, loading, refresh };
}
export function useMutation(onSuccess?: () => void) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null),
    [success, setSuccess] = useState(false);
  const lock = useRef(false);
  async function run<T>(task: () => Promise<T>): Promise<T | undefined> {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    setSuccess(false);
    try {
      const result = await task();
      setSuccess(true);
      onSuccess?.();
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
      return undefined;
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  return {
    run,
    pending,
    error,
    success,
    clear: () => {
      setError(null);
      setSuccess(false);
    },
  };
}
export const collectionPath = (projectId: string, name: string) =>
  `/projects/${encodeURIComponent(projectId)}/${name}`;
export const action = <T>(projectId: string, name: string, data: unknown) =>
  post<T>(collectionPath(projectId, `actions/${name}`), data);
export const value = (entity: Entity, key: string, fallback = "—") =>
  entity.data[key] === null || entity.data[key] === undefined
    ? fallback
    : String(entity.data[key]);
export const when = (
  input: unknown,
  locale = "en",
  timezone = "Europe/Berlin",
) =>
  typeof input === "string" && !Number.isNaN(Date.parse(input))
    ? new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: timezone,
      }).format(new Date(input))
    : "—";
export const usd = (micros: number | null | undefined) =>
  micros === null || micros === undefined
    ? "—"
    : new Intl.NumberFormat("en", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(micros / 1_000_000);

/**
 * Assets for the library and the pickers: without composed assignment
 * banners (R78), which are bound to their reviewed post (`boundTo`).
 */
export const libraryAssets = (items: Entity[] | undefined) =>
  (items ?? []).filter((asset) => !asset.data.boundTo);
/**
 * A DELETE whose success answers 204 with no body, which `api` would fail to
 * parse as JSON. Sends no Content-Type: there is no body to describe.
 */
export async function remove(path: string): Promise<void> {
  const response = await fetch(`/api${path}`, {
    method: "DELETE",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.ok) return;
  const value = await response.json().catch(() => null);
  throw new ApiError(value?.error?.code ?? "REQUEST_FAILED", response.status);
}

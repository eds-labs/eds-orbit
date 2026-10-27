import { useRef, useState } from "react";
import { collectionPath, useResource } from "@/lib/api";

// Types and calls of the Creative Studio routes (docs/API_CONTRACT.md,
// "Creative Studio"). Hand-written like the other web types; the server
// types are in apps/api/src/modules/marketing/creative/.

export type FormatId = "feed_portrait" | "square" | "story" | "landscape";
export type TextScale = "s" | "m" | "l";
export type LogoPlacement =
  "auto" | "top_left" | "top_right" | "bottom_left" | "bottom_right";
export type CreativeStatus =
  "composed" | "needs_owner" | "needs_rights" | "attached" | "superseded";
export type CreativeCopy = {
  eyebrow?: string;
  headline: string;
  subline?: string;
  cta?: string;
};
export type CreativeCheck = {
  code: string;
  passed: boolean;
  severity: "blocker" | "warning";
  detail?: Record<string, number | string>;
};
export type CreativeRendition = {
  format: FormatId;
  variant?: string;
  channel?: string;
  assetId: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  href: string;
};
export type CreativeView = {
  id: string;
  version: number;
  contentId?: string;
  template: string;
  variant: string;
  options: { logoPlacement: LogoPlacement; textScale: TextScale };
  copy: CreativeCopy;
  components: {
    artAssetId?: string;
    logo: { assetId: string; sha256: string };
    products: Array<{ assetId: string; sha256: string }>;
  };
  renditions: CreativeRendition[];
  qa: {
    checks: CreativeCheck[];
    vision?: Record<string, unknown>;
    /** Quality; `status` is the lifecycle (R5a): an attached creative can need the owner. */
    verdict: "pass" | "corrected" | "needs_owner";
  };
  corrections: Array<{ kind: string; costMicros?: number }>;
  cost?: {
    reservationIds: string[];
    settledMicros: number;
    unknownMicros: number;
  };
  status: CreativeStatus;
};
export type CreativeTemplateOffer = {
  id: string;
  variants: Record<string, string[]>;
  needs: { art: boolean; product: boolean };
  copyLimits: Record<keyof CreativeCopy, number>;
};
export type CreativeOptions = {
  templates: CreativeTemplateOffer[];
  formats: Record<string, { id: string; width: number; height: number }>;
  defaultChannelFormats: Record<string, FormatId[]>;
  /** The project's resolved settings; null while its brand kit cannot compose. */
  config: {
    enabledTemplates?: string[];
    maxArtCorrections?: number;
    [key: string]: unknown;
  } | null;
};

export const useCreativeOptions = (projectId: string) =>
  useResource<CreativeOptions>(collectionPath(projectId, "creative/options"));
/** The post's newest creative, or `null` (the route answers the literal null). */
export const useContentCreative = (projectId: string, contentId: string) =>
  useResource<CreativeView | null>(
    collectionPath(
      projectId,
      `content/${encodeURIComponent(contentId)}/creative`,
    ),
  );

/** A refused creative request with the `detail` of the JSON error body (R56). */
export class CreativeRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly detail: Record<string, unknown> | null,
  ) {
    super(code.replaceAll("_", " "));
  }
}

/** POST to a creative route; unlike `post` it keeps the error's `detail`. */
export async function creativePost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new CreativeRequestError(
      value?.error?.code ?? "REQUEST_FAILED",
      response.status,
      value?.error?.detail ?? null,
    );
  return value as T;
}

/** One action at a time: a second call while one runs is ignored. */
export function useCreativeAction(onDone: () => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lock = useRef(false);
  async function run<T>(task: () => Promise<T>): Promise<T | undefined> {
    if (lock.current) return undefined;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await task();
      onDone();
      return result;
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  return { run, pending, error };
}

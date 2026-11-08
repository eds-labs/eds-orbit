import type { FailureInput, ProviderFailure } from "../types.ts";
import { parseMetaUsage } from "./usage.ts";

/**
 * Starts from the token-word pattern of `providerDetail` in packages/connectors/src/http.ts (not exported there),
 * but is stricter: that pattern stops at whitespace, so "Bearer EAAB..." would leave the token itself behind.
 * Tokens must never appear in a ProviderFailure, so "bearer <value>" and Meta-token-shaped runs are removed too.
 */
const BEARER = /bearer\s+\S+/gi;
const META_TOKEN = /EAA[A-Za-z0-9]{20,}/g;
const TOKEN_WORDS = /(bearer|token|key|secret|password)\S*/gi;
const clean = (text: unknown): string | undefined => {
  if (typeof text !== "string") return undefined;
  const out = text.replace(BEARER, "[redacted]").replace(META_TOKEN, "[redacted]").replace(TOKEN_WORDS, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 300);
  return out || undefined;
};

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const inRange = (code: number | undefined, lo: number, hi: number) => code !== undefined && code >= lo && code <= hi;
const RATE_CODES = new Set([4, 17, 32, 341, 613]);

type GraphError = { code?: number; subcode?: number; isTransient: boolean; title?: string; message?: string; traceId?: string; blame: string[][] };

function graphError(body: unknown): GraphError | undefined {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (!error || typeof error !== "object") return undefined;
  const e = error as Record<string, unknown>;
  const specs = (e.error_data as { blame_field_specs?: unknown } | undefined)?.blame_field_specs;
  const blame = Array.isArray(specs)
    ? specs.map(s => (Array.isArray(s) ? s.filter((p): p is string => typeof p === "string") : typeof s === "string" ? [s] : [])).filter(p => p.length)
    : [];
  return {
    code: num(e.code), subcode: num(e.error_subcode), isTransient: e.is_transient === true,
    title: clean(e.error_user_title), message: clean(e.error_user_msg),
    traceId: typeof e.fbtrace_id === "string" ? e.fbtrace_id.slice(0, 100) : undefined, blame,
  };
}

/** Classifies a Meta Graph failure. Rules are evaluated in the documented order; the first match wins. */
export function classifyMetaFailure(input: FailureInput): ProviderFailure {
  const { write, httpStatus, transport } = input;
  if (transport) {
    return { kind: "transient", code: "ADS_PROVIDER_UNAVAILABLE", outcome: transport.outcome, retryable: transport.outcome === "not_sent", fieldPaths: [], ...(httpStatus !== undefined ? { httpStatus } : {}) };
  }
  const g = graphError(input.body);
  const base = {
    fieldPaths: [] as string[],
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(g?.code !== undefined ? { providerCode: g.code } : {}),
    ...(g?.subcode !== undefined ? { providerSubcode: g.subcode } : {}),
    ...(g?.traceId ? { traceId: g.traceId } : {}),
  };
  const code = g?.code;
  const rejected = { outcome: "rejected" as const };
  const ambiguous = write ? { outcome: "unknown" as const, retryable: false } : { outcome: "rejected" as const, retryable: true, retryAfterMs: 5_000 };

  if (code === 190 || code === 102 || (httpStatus === 401 && code === undefined)) return { ...base, ...rejected, kind: "auth", code: "ADS_META_TOKEN_INVALID", retryable: false };
  if (code === 10 || inRange(code, 200, 299)) return { ...base, ...rejected, kind: "permission", code: "ADS_META_PERMISSION_MISSING", retryable: false };
  if (code === 613 && g?.subcode === 4841018) return { ...base, ...rejected, kind: "rate_limited", code: "ADS_META_CONCURRENT_EDIT", retryable: true, retryAfterMs: 30_000 };
  if (code === 368) return { ...base, ...rejected, kind: "rate_limited", code: "ADS_META_TEMPORARILY_BLOCKED", retryable: true, retryAfterMs: 3_600_000 };
  if ((code !== undefined && RATE_CODES.has(code)) || inRange(code, 80000, 80014) || httpStatus === 429) {
    const regain = Math.max(0, ...(input.headers ? parseMetaUsage(input.headers).buckets.map(b => b.regainMs ?? 0) : []));
    return { ...base, ...rejected, kind: "rate_limited", code: "ADS_META_RATE_LIMITED", retryable: true, retryAfterMs: regain > 0 ? regain : 60_000 };
  }
  if (code === 100 || (g && g.blame.length)) {
    return {
      ...base, ...rejected, kind: "validation", code: "ADS_PROVIDER_VALIDATION", retryable: false,
      fieldPaths: g!.blame.map(p => p.join(".")),
      ...(g!.title ? { userTitle: g!.title } : {}), ...(g!.message ? { userMessage: g!.message } : {}),
    };
  }
  if (code === 1 || code === 2 || g?.isTransient || (httpStatus !== undefined && httpStatus >= 500)) return { ...base, ...ambiguous, kind: "transient", code: "ADS_PROVIDER_UNAVAILABLE" };
  if (g && httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
    return { ...base, ...rejected, kind: "validation", code: "ADS_PROVIDER_REJECTED", retryable: false, ...(g.title ? { userTitle: g.title } : {}), ...(g.message ? { userMessage: g.message } : {}) };
  }
  return { ...base, ...ambiguous, kind: "unknown", code: "ADS_PROVIDER_RESPONSE_INVALID" };
}

import type { ThrottleHint } from "../types.ts";

type Bucket = ThrottleHint["buckets"][number];

function json(headers: Headers, name: string): unknown {
  const raw = headers.get(name);
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

function put(buckets: Map<string, Bucket>, bucket: string, usagePct: number, regainMs?: number) {
  const existing = buckets.get(bucket);
  if (!existing) { buckets.set(bucket, { bucket, usagePct, ...(regainMs ? { regainMs } : {}) }); return; }
  existing.usagePct = Math.max(existing.usagePct, usagePct);
  if (regainMs) existing.regainMs = Math.max(existing.regainMs ?? 0, regainMs);
}

function tier(value: unknown): ThrottleHint["accessTier"] {
  if (typeof value !== "string") return undefined;
  if (value === "development_access" || value.startsWith("limited")) return "limited";
  if (value === "standard_access" || value.startsWith("full")) return "full";
  return undefined;
}

/** Reads Meta's rate-limit headers into provider-neutral buckets. Never throws; malformed headers are skipped. */
export function parseMetaUsage(headers: Headers): ThrottleHint {
  const buckets = new Map<string, Bucket>();
  let accessTier: ThrottleHint["accessTier"];
  try {
    const bucUsage = record(json(headers, "x-business-use-case-usage"));
    if (bucUsage) {
      for (const entries of Object.values(bucUsage)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          const e = record(entry);
          if (!e || typeof e.type !== "string") continue;
          const minutes = num(e.estimated_time_to_regain_access);
          put(buckets, `meta_${e.type}`, Math.max(num(e.call_count), num(e.total_cputime), num(e.total_time)), minutes > 0 ? minutes * 60_000 : undefined);
          accessTier ??= tier(e.ads_api_access_tier);
        }
      }
    }
    const account = record(json(headers, "x-ad-account-usage"));
    if (account) {
      const seconds = num(account.reset_time_duration);
      put(buckets, "meta_ad_account", num(account.acc_id_util_pct), seconds > 0 ? seconds * 1000 : undefined);
    }
    const app = record(json(headers, "x-app-usage"));
    if (app) put(buckets, "meta_app", Math.max(num(app.call_count), num(app.total_cputime), num(app.total_time)));
    const insights = record(json(headers, "x-fb-ads-insights-throttle"));
    if (insights) put(buckets, "meta_insights_throttle", Math.max(num(insights.app_id_util_pct), num(insights.acc_id_util_pct)));
  } catch { /* never throws */ }
  return { buckets: [...buckets.values()], ...(accessTier ? { accessTier } : {}) };
}

// Source freshness (UI restructure §4.2): when a source's last successful
// sync stops counting as current. Pure and import-free; the web's knowledge
// overview keeps its own copy (Ruling R14), and
// apps/web/src/modules/knowledge/freshness-parity.test.tsx keeps both equal.

const HOUR = 3_600_000;
/** A source counts as expiring this close to the end of its maximum age. */
export const EXPIRING_HOURS = 48;
/** The schema default of `maxAgeHours` (packages/schemas source). */
export const DEFAULT_MAX_AGE_HOURS = 168;

export type SourceExpiry = {
  expiresAt: Date | null;
  state: "fresh" | "expiring" | "stale" | "manual";
};

/**
 * Manually maintained verified facts do not require synchronization.
 * Stale without a sync or past `lastSuccessfulSyncAt + maxAgeHours` (the rule
 * of /knowledge-health `staleSources`), expiring within 48 h of that. A
 * missing or non-positive `maxAgeHours` falls back to the schema default.
 */
export function sourceExpiry(
  source: {
    type?: unknown;
    lastSuccessfulSyncAt?: unknown;
    maxAgeHours?: unknown;
  },
  now: number,
): SourceExpiry {
  // Verified facts are maintained by their owners, not by a sync job.
  // Their individual validity and verification checks remain authoritative.
  if (source.type === "verified_facts")
    return { expiresAt: null, state: "manual" };
  const synced =
    typeof source.lastSuccessfulSyncAt === "string"
      ? Date.parse(source.lastSuccessfulSyncAt)
      : Number.NaN;
  if (Number.isNaN(synced)) return { expiresAt: null, state: "stale" };
  const maxAge =
    typeof source.maxAgeHours === "number" && source.maxAgeHours > 0
      ? source.maxAgeHours
      : DEFAULT_MAX_AGE_HOURS;
  const expires = synced + maxAge * HOUR;
  return {
    expiresAt: new Date(expires),
    state:
      now > expires
        ? "stale"
        : expires - now <= EXPIRING_HOURS * HOUR
          ? "expiring"
          : "fresh",
  };
}

/** Whether a source's freshness matters: a revoked one never syncs again. */
export function tracksFreshness(source: { status?: unknown }): boolean {
  return source.status !== "revoked";
}

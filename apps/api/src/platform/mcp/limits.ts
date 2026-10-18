/**
 * In-process rate limits of the MCP gateway (Track M, WP-M2, D-M2-5,
 * plans/orbit-modularization/09 §7). One gateway process holds all counters;
 * a Redis-backed variant is a WP-M5 item if more than one gateway runs.
 *
 * Authenticated requests are counted per grant, per user and per client;
 * requests without a usable token per client address. All numbers live here.
 */

/** Requests per minute, per bucket. Change them here only. */
export const MCP_RATE_LIMITS = {
  /** One grant: one user's connection of one client to one workspace. */
  perGrant: 120,
  /** One user across all of their grants. */
  perUser: 240,
  /** One client id across all users. */
  perClient: 600,
  /** One client address while it sends no valid token. */
  unauthenticatedPerIp: 30,
  /**
   * `tools/call` of the native `search` per grant, on top of perGrant
   * (09 §7, D-M3-10): the tool reads and ranks knowledge, the costliest read.
   */
  searchPerGrant: 30,
  /**
   * Proposals one grant may create per hour (WP-M4, D-M4-8). Counted by the
   * in-process limiter in a one-hour window; only creations count.
   */
  proposalsPerHourPerGrant: 20,
  /**
   * Proposals one grant may create per UTC day. Not a limiter bucket: the
   * adapter counts the grant's `mcp.proposal` events since the day started,
   * so the number survives restarts and several gateway processes.
   */
  proposalsPerDayPerGrant: 100,
};
export type McpRateLimits = typeof MCP_RATE_LIMITS;
/** The length of a counting window unless a rule names its own. */
export const MCP_RATE_WINDOW_MS = 60_000;
/** The window of the proposal rule: one hour. */
export const MCP_PROPOSAL_WINDOW_MS = 3_600_000;

/**
 * One bucket a request is counted in. `label` names it in logs (never an
 * id); `windowMs` is the rule's own window (default MCP_RATE_WINDOW_MS).
 */
export type RateRule = {
  key: string;
  max: number;
  label?: string;
  windowMs?: number;
};
export type RateVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; label?: string };

/** Fixed-window counters keyed by string; expired windows are dropped lazily. */
export class McpRateLimiter {
  private readonly windows = new Map<
    string,
    { start: number; count: number; windowMs: number }
  >();
  private lastSweep: number;

  constructor(private readonly now: () => number = Date.now) {
    this.lastSweep = now();
  }

  /** Buckets currently held (tests, memory watch). */
  get size(): number {
    return this.windows.size;
  }

  private sweep(now: number) {
    if (now - this.lastSweep < MCP_RATE_WINDOW_MS) return;
    this.lastSweep = now;
    for (const [key, window] of this.windows)
      if (now - window.start >= window.windowMs) this.windows.delete(key);
  }

  /** Whether any bucket is full, and how long the longest wait is. Counts nothing. */
  private verdict(rules: readonly RateRule[], now: number): RateVerdict {
    let wait = 0;
    let label: string | undefined;
    for (const rule of rules) {
      const window = this.windows.get(rule.key);
      const windowMs = rule.windowMs ?? MCP_RATE_WINDOW_MS;
      if (window && now - window.start < windowMs && window.count >= rule.max) {
        const remaining = Math.max(
          1,
          Math.ceil((window.start + windowMs - now) / 1000),
        );
        if (remaining > wait) {
          wait = remaining;
          label = rule.label;
        }
      }
    }
    return wait > 0
      ? {
          allowed: false,
          retryAfterSeconds: wait,
          ...(label ? { label } : {}),
        }
      : { allowed: true };
  }

  private count(rules: readonly RateRule[], now: number) {
    for (const rule of rules) {
      const windowMs = rule.windowMs ?? MCP_RATE_WINDOW_MS;
      const window = this.windows.get(rule.key);
      if (window && now - window.start < windowMs) window.count++;
      else this.windows.set(rule.key, { start: now, count: 1, windowMs });
    }
  }

  /**
   * Counts one request in every bucket, or in none when any bucket is full:
   * a refused request does not use up the other buckets.
   */
  take(rules: readonly RateRule[]): RateVerdict {
    const now = this.now();
    this.sweep(now);
    const verdict = this.verdict(rules, now);
    if (verdict.allowed) this.count(rules, now);
    return verdict;
  }

  /** Like take, but counts nothing: whether the next request would pass. */
  check(rules: readonly RateRule[]): RateVerdict {
    const now = this.now();
    this.sweep(now);
    return this.verdict(rules, now);
  }

  /** Counts one use in every bucket without looking at the limits (after the work happened). */
  charge(rules: readonly RateRule[]): void {
    const now = this.now();
    this.sweep(now);
    this.count(rules, now);
  }
}

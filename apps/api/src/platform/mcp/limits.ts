/**
 * In-process limits of the MCP gateway (Track M, WP-M2, D-M2-5, WP-M5,
 * plans/orbit-modularization/09 §7). One gateway process holds all counters;
 * a Redis-backed variant is needed only if more than one gateway runs.
 *
 * Authenticated requests are counted per grant, per user and per client;
 * requests without a token this process verified per client address (an
 * IPv6 client by its /64), before their token is verified. Tool executions
 * are bounded per project (R-10). All numbers live here.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { McpBusyError } from "./errors.ts";

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
/**
 * Most buckets the limiter holds (memory bound). When it is full, a request
 * that needs a new bucket is refused (429, label "capacity") until windows
 * expire: live windows are never evicted, so a flood of new keys cannot
 * reset anyone's count.
 */
export const MCP_RATE_LIMITER_MAX_KEYS = 50_000;
/** Most token hashes the gateway remembers as verified (McpVerifiedTokens). */
export const MCP_VERIFIED_TOKENS_MAX = 10_000;
/** Largest JSON result a tool may return (09 §5.1, ADR 0007 §2). */
export const MCP_OUTPUT_LIMIT_BYTES = 64 * 1024;
/**
 * Concurrent tool executions per project and gateway process (R-10, D-M5-6):
 * every `scoped()` call takes the project's advisory lock, so a burst of
 * calls in one project waits here instead of on the lock. A call over the
 * limit waits up to `waitMs` in a queue of at most `queuePerProject`, then
 * gets BUSY.
 */
export const MCP_PROJECT_CONCURRENCY = {
  perProject: 2,
  waitMs: 10_000,
  queuePerProject: 16,
};
export type McpProjectConcurrency = typeof MCP_PROJECT_CONCURRENCY;
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

/** How often a full limiter looks for expired windows outside the regular sweep. */
const FULL_SWEEP_INTERVAL_MS = 1000;

/**
 * Fixed-window counters keyed by string; expired windows are dropped lazily,
 * and at most `maxKeys` buckets are held (MCP_RATE_LIMITER_MAX_KEYS).
 */
export class McpRateLimiter {
  private readonly windows = new Map<
    string,
    { start: number; count: number; windowMs: number }
  >();
  private lastSweep: number;
  private lastFullSweep = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys: number = MCP_RATE_LIMITER_MAX_KEYS,
  ) {
    this.lastSweep = now();
  }

  /** Buckets currently held (tests, memory watch). */
  get size(): number {
    return this.windows.size;
  }

  private sweep(now: number) {
    if (now - this.lastSweep < MCP_RATE_WINDOW_MS) return;
    this.lastSweep = now;
    this.dropExpired(now);
  }

  private dropExpired(now: number) {
    for (const [key, window] of this.windows)
      if (now - window.start >= window.windowMs) this.windows.delete(key);
  }

  /**
   * Refuses (fail closed) when counting `rules` would need more buckets than
   * the limiter may hold. A full limiter first drops expired windows, at most
   * once a second, so a flood of new keys costs no full scan per request.
   */
  private capacity(rules: readonly RateRule[], now: number): RateVerdict {
    const fresh = () =>
      new Set(rules.map((rule) => rule.key).filter((k) => !this.windows.has(k)))
        .size;
    if (this.windows.size + fresh() <= this.maxKeys) return { allowed: true };
    if (now - this.lastFullSweep >= FULL_SWEEP_INTERVAL_MS) {
      this.lastFullSweep = now;
      this.dropExpired(now);
      if (this.windows.size + fresh() <= this.maxKeys) return { allowed: true };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(MCP_RATE_WINDOW_MS / 1000),
      label: "capacity",
    };
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
    if (!verdict.allowed) return verdict;
    const room = this.capacity(rules, now);
    if (room.allowed) this.count(rules, now);
    return room;
  }

  /**
   * Like take, but counts nothing: whether the next request would pass its
   * limits. It adds no bucket, so the size cap does not apply.
   */
  check(rules: readonly RateRule[]): RateVerdict {
    const now = this.now();
    this.sweep(now);
    return this.verdict(rules, now);
  }

  /**
   * Counts one use in every bucket without looking at the limits (after the
   * work happened). It may add a bucket past the size cap: the work is done,
   * and only proposals are charged this way (rate-limited before they run).
   */
  charge(rules: readonly RateRule[]): void {
    const now = this.now();
    this.sweep(now);
    this.count(rules, now);
  }
}

/** The 16-bit groups of an IPv6 address (zone and brackets dropped), or null. */
function ipv6Groups(address: string): number[] | null {
  let text = address.trim().toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (isIP(text) !== 6) return null;
  // An embedded IPv4 tail ("::ffff:192.0.2.1") becomes two groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const [a, b, c, d] = tail.split(".").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split("::") as [string, string | undefined];
  const parse = (part: string) =>
    part ? part.split(":").map((group) => parseInt(group, 16)) : [];
  const left = parse(head);
  const right = rest === undefined ? [] : parse(rest);
  const zeros = rest === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<number>(zeros).fill(0), ...right];
}

/**
 * The address part of an unauthenticated rate bucket (D-M5-6): an IPv4
 * address as it is; an IPv4-mapped IPv6 address as its IPv4 address; any
 * other IPv6 address by its /64 prefix, the usual delegation to one
 * subscriber, so rotating addresses inside it share one bucket. Anything
 * else (never from mcpClientIp) stays one opaque key.
 */
export function ipBucket(address: string): string {
  if (isIP(address) === 4) return address;
  const groups = ipv6Groups(address);
  if (!groups) return address;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff)
    return [
      groups[6]! >> 8,
      groups[6]! & 255,
      groups[7]! >> 8,
      groups[7]! & 255,
    ]
      .map(String)
      .join(".");
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("base64url");

/**
 * Access tokens this gateway process verified, by SHA-256 hash, until their
 * `exp` (D-M5-6). A request carrying one is not counted per client address
 * before verification, so clients behind a shared address keep working once
 * their token is known. It is no part of authentication: every request is
 * verified again. Bounded by `maxEntries`; the oldest entry makes room
 * (an evicted token is only counted per address again).
 */
export class McpVerifiedTokens {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries: number = MCP_VERIFIED_TOKENS_MAX,
  ) {}

  /** Entries held (tests, memory watch). */
  get size(): number {
    return this.entries.size;
  }

  /** The stored hashes (tests: never the token itself). */
  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  has(token: string): boolean {
    const key = tokenHash(token);
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt > this.now()) return true;
    this.entries.delete(key);
    return false;
  }

  /** Remembers a verified token until `expiresAtSeconds` (its `exp` claim); without one, not at all. */
  remember(token: string, expiresAtSeconds: number | undefined): void {
    if (typeof expiresAtSeconds !== "number") return;
    const expiresAt = expiresAtSeconds * 1000;
    if (expiresAt <= this.now()) return;
    const key = tokenHash(token);
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const now = this.now();
      for (const [stored, at] of this.entries)
        if (at <= now) this.entries.delete(stored);
      while (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
    this.entries.set(key, expiresAt);
  }

  forget(token: string): void {
    this.entries.delete(tokenHash(token));
  }
}

type ProjectQueue = { active: number; waiting: Array<() => void> };

/**
 * At most `perProject` tool executions per project at a time in this process
 * (R-10, MCP_PROJECT_CONCURRENCY). A call over the limit waits in a bounded
 * queue (first come, first served) for up to `waitMs`, then fails with
 * McpBusyError; a full queue fails at once. A finished call hands its slot
 * straight to the next waiter. Idle projects are forgotten.
 */
export class McpProjectSlots {
  private readonly projects = new Map<string, ProjectQueue>();
  private readonly limits: McpProjectConcurrency;

  constructor(limits: Partial<McpProjectConcurrency> = {}) {
    this.limits = { ...MCP_PROJECT_CONCURRENCY, ...limits };
  }

  /** Projects with running or waiting calls (tests, memory watch). */
  get size(): number {
    return this.projects.size;
  }

  /**
   * When a wait that starts now would end: the deadline one call shares
   * over several projects (a multi-project search waits `waitMs` in total,
   * not per project).
   */
  deadline(): number {
    return Date.now() + this.limits.waitMs;
  }

  /**
   * Runs `work` in one of the project's slots; McpBusyError when none frees
   * up in time. With `deadline` the wait ends then at the latest (at once
   * when it has passed), never later than `waitMs`.
   */
  async run<T>(
    projectId: string,
    work: () => Promise<T>,
    options: { deadline?: number } = {},
  ): Promise<T> {
    const waitMs =
      options.deadline === undefined
        ? this.limits.waitMs
        : Math.min(this.limits.waitMs, options.deadline - Date.now());
    await this.acquire(projectId, waitMs);
    try {
      return await work();
    } finally {
      this.release(projectId);
    }
  }

  private acquire(projectId: string, waitMs: number): Promise<void> {
    let queue = this.projects.get(projectId);
    if (!queue) {
      queue = { active: 0, waiting: [] };
      this.projects.set(projectId, queue);
    }
    if (queue.active < this.limits.perProject) {
      queue.active++;
      return Promise.resolve();
    }
    if (waitMs <= 0 || queue.waiting.length >= this.limits.queuePerProject)
      return Promise.reject(new McpBusyError());
    const waiting = queue;
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = waiting.waiting.indexOf(grant);
        if (index >= 0) waiting.waiting.splice(index, 1);
        reject(new McpBusyError());
      }, waitMs);
      waiting.waiting.push(grant);
    });
  }

  private release(projectId: string) {
    const queue = this.projects.get(projectId);
    if (!queue) return;
    const next = queue.waiting.shift();
    // The slot passes to the next waiter; the count stays the same.
    if (next) return next();
    queue.active--;
    if (queue.active <= 0) this.projects.delete(projectId);
  }
}

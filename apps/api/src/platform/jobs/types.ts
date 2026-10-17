import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";

/** A claimed job as the worker hands it to its handler. */
export type JobContext = {
  /** The worker's own scope (role owner, user "worker"). */
  scope: Scope;
  jobId: string;
  /** The job entity's data at claim time. */
  job: Record<string, any>;
  /** EXECUTION_MODE of the worker. */
  executionMode: "test" | "live";
};

/**
 * One queue class (`<QUEUE_NAMESPACE>-<queueClass>`), contributed by the
 * platform or a module (plans/orbit-modularization 03 §7). The worker owns
 * claiming, leases, retries and failure handling; the definition says what
 * differs per class.
 */
export type JobDef = {
  queueClass: string;
  /** Runs the job; a chat-style handler may return its own terminal status. */
  handler(
    ctx: JobContext,
  ): Promise<{ status: string; errorCode: string | null } | void>;
  /** Parallel jobs of this class per worker (default 1). */
  concurrency?: number;
  /** Runs even while the project is paused (default false). */
  runWhilePaused?: boolean;
  /** Lease of a claimed job in ms (default 120 s). */
  leaseMs?: number;
  /** Called when a claimed job's lease expired, before it is retried or stopped. */
  onLeaseExpired?(
    tx: DbTx,
    scope: Scope,
    job: Record<string, any>,
  ): Promise<void>;
  /** Called when a paused project blocks the job (it is never retried then). */
  onBlockedByPause?(
    tx: DbTx,
    job: Record<string, any>,
    scope: Scope,
  ): Promise<void>;
};

/** A module's contribution to the per-project sweep (plans 03 §7). */
export type SchedulerContribution = {
  /** Time-based work for the project; runs inside the sweep transaction. */
  sweep(tx: DbTx, scope: Scope, at: Date): Promise<{ queued: number }>;
  /** Earliest future time the sweep could change something without a write. */
  nextDueAt(tx: DbTx, scope: Scope, at: Date): Promise<Date | null>;
};

/**
 * Work the worker does for each due project after it dispatched the
 * project's jobs, outside the sweep transaction (WP2.1). Read-only checks and
 * self-scheduled imports belong here; they do not stop while the project is
 * paused.
 */
export type PeriodicTask = {
  /** Unique name; also the Redis key `orbit:<name>:<instance>` of `health`. */
  name: string;
  /** Inside the sweep transaction: when the task is next due, for the project's wake-up. */
  nextDueAt?(tx: DbTx, scope: Scope): Promise<Date | null>;
  /**
   * Runs the task; errors are swallowed by the worker. A returned status is
   * published; a returned `wakeAt` wakes the project again then (WP2.5d).
   */
  run(scope: Scope): Promise<{ status?: string; wakeAt?: Date } | void>;
  /** Folds the published statuses of all projects into one health state. */
  health?: { summarize(entries: Record<string, string>, now: Date): string };
};

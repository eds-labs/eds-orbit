import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";

/**
 * How a module takes part in a project pause or resume (WP1.8). The platform
 * fences the project (generation bump), stops waiting chat replies and audits;
 * the hooks run inside the same transaction, in registry order, at the points
 * the steps ran before the split.
 */
export type ProjectHooks = {
  /** Pause: right after the generation bump, before chat replies stop. */
  onProjectPause?(
    tx: DbTx,
    scope: Scope,
    ctx: { generation: number },
  ): Promise<void>;
  /**
   * Pause: after the platform audited it. `notify` is false when the request
   * came from a channel that confirms the pause itself (the owner's bot).
   */
  afterProjectPause?(
    tx: DbTx,
    scope: Scope,
    ctx: { generation: number; notify: boolean },
  ): Promise<void>;
  /** Resume: after waiting chat replies ended, before the audit. */
  onProjectResume?(
    tx: DbTx,
    scope: Scope,
    ctx: { generation: number },
  ): Promise<void>;
};

/**
 * A module's part of the retention action: purge what expired before
 * `cutoff`. `audit` is merged into the platform's audit entry, `result` into
 * the response.
 */
export type RetentionContribution = (
  tx: DbTx,
  scope: Scope,
  ctx: { cutoff: Date; at: Date },
) => Promise<{
  audit: Record<string, number>;
  result: Record<string, number>;
}>;

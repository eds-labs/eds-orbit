import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";

// The project's attention items (UI restructure §4.1): what needs a member's
// attention now, from every enabled module the member may use and from the
// platform. The web renders the text from `kind` and `params`.

export type AttentionSeverity = "critical" | "warning" | "info";

/** One thing that needs attention, owned by a module or the platform. */
export type AttentionItem = {
  /** Stable per object, such as "support:sla:<ticketId>". */
  id: string;
  /** The owning module, or "platform". */
  moduleId: string;
  /** Such as "support_sla_at_risk"; the web renders the text. */
  kind: string;
  severity: AttentionSeverity;
  /** For aggregated items ("2 unassigned tickets"). */
  count?: number;
  /** ISO time the item becomes worse or expires. */
  dueAt?: string;
  /** ISO time the item started waiting. */
  since?: string;
  /** Ids, subjects, channel names: nothing the member may not already read. */
  params: Record<string, string | number | boolean>;
  /** The web nav entry the item belongs to (for badges). */
  navKey: string;
  /** In-app path below /p/:id, such as "/support/tickets?ticket=<id>". */
  link: string;
};

/** GET /api/projects/:projectId/attention. */
export type AttentionResponse = {
  /** Sorted, at most 50. */
  items: AttentionItem[];
  /** Per navKey: `count ?? 1` summed over all items before the cap. */
  counts: Record<string, number>;
  status: AttentionStatus;
};

/** The project's state the home page's status strip shows. */
export type AttentionStatus = {
  paused: boolean;
  /** The active marketing policy's mode, while marketing is usable. */
  mode?: string;
  /**
   * The AI spend of the UTC calendar month as the budget enforcement counts
   * it (settled, reserved, in flight and unclear reservations), and the
   * active policy's monthly limit or null.
   */
  aiMonth?: { spentMicros: number; limitMicros: number | null };
};

/**
 * A module's attention items for the member, read in the route's project
 * transaction with the member's role in that module. It may drop items the
 * role may not see (owner-only items for non-owners).
 */
export type AttentionContribution = (
  tx: DbTx,
  scope: Scope,
  now: Date,
) => Promise<AttentionItem[]>;

/**
 * A module's part of the response's `status` (only `mode` today), read like
 * its items: while the module is enabled and visible to the member, with the
 * member's role in the module.
 */
export type AttentionStatusContribution = (
  tx: DbTx,
  scope: Scope,
  now: Date,
) => Promise<Pick<AttentionStatus, "mode">>;

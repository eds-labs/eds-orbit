import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type {
  PermissionDef,
} from "../../../../../packages/module-contracts/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { DomainEventView } from "../events/types.ts";

// Proactive signals (ADR 0023, plan agent-platform-phase-4 §2.2). A signal
// is a deterministic detector a module or the platform contributes: it
// costs no AI and writes ordinary, project-scoped member notifications with
// a dedupe key. Existing notification senders are not detected again: a
// mapping only gives their kinds a severity, so they join the feed, the
// digest and per-user Telegram through their own senders.

export const SIGNAL_SEVERITIES = ["info", "attention", "urgent"] as const;
export type SignalSeverity = (typeof SIGNAL_SEVERITIES)[number];

/** Who a finding goes to; each is checked again with current access. */
export type SignalRecipients = {
  /** Named users (sponsor, requester, assignee). */
  userIds?: readonly string[];
  /** Members of the project with one of these roles in the kind's module. */
  roles?: readonly ("owner" | "editor" | "viewer")[];
  /** Members of the project with this permission in the kind's module. */
  permission?: PermissionDef;
  /** Owners of the organization (organization budgets). */
  organizationOwners?: boolean;
};

/** Parameters of a title: ids, counts and codes only, never free text. */
export type SignalParams = Readonly<Record<string, string | number | boolean>>;

/** One thing a detector found. */
export type SignalFinding = {
  /** The dedupe key with its period bucket, e.g. `agent_failed:<id>:<code>:<day>`. */
  fingerprint: string;
  recipients: SignalRecipients;
  severity: SignalSeverity;
  /** A key of the signal's `titles`. */
  titleKey: string;
  params: SignalParams;
  /** An Orbit path (`ORBIT_PATH`). */
  link: string;
};

/** Periodic granularity (T4-2: hourly by default). */
export type SignalEvery = "15m" | "1h" | "1d";

export type SignalSource =
  /** Domain events (exact types or prefixes ending ".*"). */
  | { event: readonly string[] }
  /** A detector on the existing due-marker pass (no new loop). */
  | { periodic: { every: SignalEvery } }
  /**
   * Mapping only (no detector): existing member notification kinds of the
   * same owner, with the severity each carries into the feed and digest.
   */
  | { kinds: Readonly<Record<string, SignalSeverity>> }
  /**
   * Mapping only: notices the owner's Telegram bot already sends (`notify`,
   * WP2.5b) also become member notifications of `kind` for the project's
   * owners, keyed by the bot's own job key.
   */
  | { botKinds: Readonly<Record<string, SignalSeverity>> };

/** What a detector gets: the event, or the time of the periodic pass. */
export type SignalInput =
  | { event: DomainEventView }
  | { at: Date };

/** A signal a module or the platform contributes (`ModuleContributions.signals`). */
export type SignalDefinition = {
  /** `<owner>.<name>`, lower case. */
  key: string;
  /** The member notification kind it writes (registered by the same owner). */
  kind: string;
  /** Its name in the per-project switches. */
  title: { en: string; de: string };
  /** Title templates by key; `{name}` is replaced by a parameter. */
  titles?: Readonly<Record<string, { en: string; de: string }>>;
  source: SignalSource;
  /** A `botKinds` mapping's link, a path below /p/:projectId (e.g. "/marketing"). */
  link?: string;
  /** The detector of an event or periodic signal; runs in the project's transaction. */
  detect?(
    tx: DbTx,
    scope: Scope,
    input: SignalInput,
  ): Promise<readonly SignalFinding[]>;
};

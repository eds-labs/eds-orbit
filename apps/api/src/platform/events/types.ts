import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type {
  Actor,
  ObjectRef,
} from "../../../../../packages/module-contracts/src/index.ts";

/** A recorded domain event as subscribers receive it (ADR 0016). */
export type DomainEventView = {
  id: string;
  type: string;
  version: number;
  subject: ObjectRef;
  actor: Actor;
  origin: string;
  causationId: string | null;
  correlationId: string;
  depth: number;
  /** Content-free: ids, field names and status keys only. */
  data: Record<string, unknown>;
  createdAt: Date;
};

/**
 * A subscriber, run as its own job per event. `types` are exact event types
 * or prefixes ending in ".*" ("work.task.*"). The handler runs in the job's
 * project transaction; follow-up events it publishes pass the event on as
 * their cause.
 */
export type EventSubscription = {
  /** Unique name, "<module>.<purpose>", also the origin of its writes. */
  name: string;
  types: readonly string[];
  /**
   * Also subscribe to every triggerable event type any module declares
   * (ADR 0021): the agent trigger subscriber. Without declared triggers and
   * without `types` the subscription is left out.
   */
  triggerableEvents?: true;
  handler(tx: DbTx, scope: Scope, event: DomainEventView): Promise<void>;
};

/** The events a module publishes and the subscribers it runs. */
export type EventsContribution = {
  /** Exact event types, each prefixed with the publishing module's id. */
  publishes?: readonly string[];
  subscribes?: readonly EventSubscription[];
  /**
   * Published events a configured agent may be triggered by (ADR 0021,
   * plan §2.7), keyed by type; each must also be in `publishes`.
   */
  triggers?: Readonly<Record<string, TriggerableEventDeclaration>>;
};

/** How an agent trigger may use one event type. */
export type TriggerableEventDeclaration = {
  title: { en: string; de: string };
  /** The subject type the event's `subject` names (one open work order per agent and subject). */
  subject: string;
  /** The trigger filter an agent may set, checked against the event's content-free data. */
  filter: import("zod").ZodType;
  /** The subject carries personal data (shown as a badge). */
  sensitive?: boolean;
};

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
  handler(tx: DbTx, scope: Scope, event: DomainEventView): Promise<void>;
};

/** The events a module publishes and the subscribers it runs. */
export type EventsContribution = {
  /** Exact event types, each prefixed with the publishing module's id. */
  publishes?: readonly string[];
  subscribes?: readonly EventSubscription[];
};

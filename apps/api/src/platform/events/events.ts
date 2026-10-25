import { randomUUID } from "node:crypto";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type {
  Actor,
  ObjectRef,
} from "../../../../../packages/module-contracts/src/index.ts";
import { audit } from "../shared.ts";
import { enqueue } from "../jobs/enqueue.ts";
import type { JobDef, PeriodicTask } from "../jobs/types.ts";
import {
  moduleAvailable,
  ownerEnabled,
  registeredEventPublisher,
  registeredSubscriber,
  registeredSubscribers,
} from "../modules/contributions.ts";
import { enabledModules } from "../modules/enforcement.ts";
import type { DomainEventView } from "./types.ts";

// Domain events (ADR 0016): a content-free record per change and one job per
// subscriber on the platform queue. A chain of events caused by subscribers
// stops at depth 5, and a subscriber never receives events of its own origin.

export const EVENT_QUEUE = "domain_event";
export const MAX_EVENT_DEPTH = 5;
const MAX_DATA_BYTES = 4096;
const RETENTION_MS = 30 * 24 * 3600000;

export type PublishInput = {
  type: string;
  subject: ObjectRef;
  actor: Actor;
  /** The module, or the subscriber's name, that made the change. */
  origin: string;
  /** Ids, field names and status keys only: never titles or text. */
  data?: Record<string, unknown>;
  /** The event a subscriber is handling, when it caused this one. */
  cause?: DomainEventView | null;
};

/**
 * Records an event and queues its subscribers in the caller's transaction.
 * Returns the event id, or null when the chain is too deep (audited, not
 * published, so a loop ends instead of failing the write).
 */
export async function publishEvent(
  tx: DbTx,
  scope: Scope,
  input: PublishInput,
): Promise<string | null> {
  if (!registeredEventPublisher(input.type))
    throw new Error(`EVENT_TYPE_UNDECLARED: ${input.type}`);
  const data = input.data ?? {};
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_DATA_BYTES)
    throw new Error("EVENT_DATA_TOO_LARGE");
  const depth = input.cause ? input.cause.depth + 1 : 0;
  if (depth > MAX_EVENT_DEPTH) {
    await audit(tx, scope, "platform.event.depth_exceeded", input.subject.id, {
      type: input.type,
      origin: input.origin,
      correlationId: input.cause!.correlationId,
    });
    return null;
  }
  const id = randomUUID();
  await tx.domainEvent.create({
    data: {
      id,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      type: input.type,
      subjectType: input.subject.type,
      subjectId: input.subject.id,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      origin: input.origin,
      causationId: input.cause?.id ?? null,
      correlationId: input.cause?.correlationId ?? id,
      depth,
      data: data as object,
    },
  });
  for (const sub of registeredSubscribers(input.type)) {
    if (sub.name === input.origin || !moduleAvailable(sub.owner)) continue;
    await enqueue(
      tx,
      scope,
      EVENT_QUEUE,
      id,
      `evt:${id}:${sub.name}`,
      new Date(),
      { subscriber: sub.name },
    );
  }
  return id;
}

export function eventView(row: {
  id: string;
  type: string;
  version: number;
  subjectType: string;
  subjectId: string;
  actorKind: string;
  actorId: string | null;
  origin: string;
  causationId: string | null;
  correlationId: string;
  depth: number;
  data: unknown;
  createdAt: Date;
}): DomainEventView {
  return {
    id: row.id,
    type: row.type,
    version: row.version,
    subject: { type: row.subjectType, id: row.subjectId },
    actor: { kind: row.actorKind as DomainEventView["actor"]["kind"], id: row.actorId },
    origin: row.origin,
    causationId: row.causationId,
    correlationId: row.correlationId,
    depth: row.depth,
    data: (row.data ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

/**
 * Delivers one event to one subscriber. A subscriber whose module is off
 * for the project stops like a disabled module's job; its errors are
 * retried by the worker like any job's.
 */
export const eventJob: JobDef = {
  queueClass: EVENT_QUEUE,
  async handler({ scope, job }) {
    const sub = registeredSubscriber(String(job.subscriber ?? ""));
    if (!sub) return { status: "blocked", errorCode: "EVENT_SUBSCRIBER_UNKNOWN" };
    return scoped(scope.workspaceId, scope.projectId, async (tx) => {
      if (!ownerEnabled(sub.owner, await enabledModules(tx, scope)))
        return { status: "blocked", errorCode: "MODULE_DISABLED" };
      const row = await tx.domainEvent.findFirst({
        where: { projectId: scope.projectId, id: String(job.resourceId) },
      });
      if (!row) return { status: "blocked", errorCode: "EVENT_NOT_FOUND" };
      await sub.handler(tx, scope, eventView(row));
      return undefined;
    });
  },
};

const lastRetention = new Map<string, number>();
/** Deletes events older than 30 days, at most once a day per project. */
export const eventRetention: PeriodicTask = {
  name: "domain-event-retention",
  async run(scope) {
    const now = Date.now();
    if (now - (lastRetention.get(scope.projectId) ?? 0) < 24 * 3600000) return;
    lastRetention.set(scope.projectId, now);
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.domainEvent.deleteMany({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          createdAt: { lt: new Date(now - RETENTION_MS) },
        },
      }),
    );
  },
};

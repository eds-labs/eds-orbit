/**
 * Event triggers (ADR 0021, plan §2.7, WP1.7): one platform subscriber for
 * every module-declared triggerable event. It reads only the event's
 * content-free data; the agent loads the subject through its tools later,
 * under its principal. Events caused by agents never start agents (no
 * chains); a burst on one subject coalesces into one open work order.
 */
import { z } from "zod";
import type { EventSubscription } from "../../events/types.ts";
import { entitlementsFor, entitled } from "../../entitlements/entitlements.ts";
import { DomainError } from "../../shared.ts";
import { AGENT_DEFINITIONS, AgentDefinition } from "../definitions/schema.ts";
import { agentAutomationEnabled, agentPlatformEnabled, insertWorkOrder } from "../work-orders/service.ts";
import { triggerableEvent } from "./declarations.ts";

/** Whether an event's data matches a trigger filter: every filter key equal, or among a listed set. */
export function filterMatches(filter: Record<string, unknown>, data: Record<string, unknown>) {
  return Object.entries(filter).every(([key, wanted]) =>
    Array.isArray(wanted) ? wanted.includes(data[key]) : data[key] === wanted,
  );
}

export const agentTriggerSubscriber: EventSubscription = {
  name: "platform.agent_triggers",
  types: [],
  triggerableEvents: true,
  async handler(tx, scope, event) {
    if (!agentPlatformEnabled() || !agentAutomationEnabled()) return;
    if (event.actor.kind === "agent") return;
    const declared = triggerableEvent(event.type);
    if (!declared) return;
    const entitlements = await entitlementsFor(scope.workspaceId);
    if (!entitled(entitlements, "agentsAutomation") || !entitled(entitlements, { triggerKind: "event" }))
      return;
    const rows = await tx.entity.findMany({
      where: { workspaceId: scope.workspaceId, projectId: scope.projectId, kind: AGENT_DEFINITIONS },
    });
    for (const row of rows) {
      const parsed = AgentDefinition.safeParse(row.data);
      if (!parsed.success || parsed.data.status !== "active" || !parsed.data.active) continue;
      const config = parsed.data.active;
      // A disabled module stops its triggers (its module must be the agent's).
      if (!config.modules.includes(declared.module) && declared.module !== "platform") continue;
      for (const trigger of config.triggers) {
        if (trigger.kind !== "event" || trigger.type !== event.type) continue;
        if (!declared.filter.safeParse(trigger.filter).success) continue;
        if (!filterMatches(trigger.filter, event.data)) continue;
        try {
          await insertWorkOrder(tx, scope, {
            agentId: row.id,
            origin: "event",
            originRef: event.id,
            idempotencyKey: `agent:${row.id}:evt:${event.id}`,
            requestedBy: { kind: "event", eventType: event.type },
            subject: { type: declared.subject, id: event.subject.id },
            availableAt: new Date(Date.now() + trigger.debounceSeconds * 1000),
          });
        } catch (error) {
          if (!(error instanceof DomainError) || !["AGENT_RUN_LIMIT", "AGENT_NOT_ACTIVE"].includes(error.code))
            throw error;
        }
        break;
      }
    }
  },
};

/** The test-only triggerable event (plan WP1.7): declared only under NODE_ENV=test. */
export const TEST_PING = "platform.test.ping";
export const testPingTrigger = {
  [TEST_PING]: {
    title: { en: "Test ping", de: "Test-Ping" },
    subject: "platform.test_subject",
    filter: z.strictObject({ channel: z.string().optional() }),
  },
};

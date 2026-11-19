import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { emitWebhookEvent, webhooksEnabled } from "../../../platform/outbound-webhooks/webhooks.ts";
import { storedNotifiers } from "./adapters.ts";

// Telling sites about changes (ADR 0029 §4.5, CH1.11). An event about one
// site goes to the webhook endpoints that site names as notifiers, and to
// the module's endpoints no site names (project-wide subscribers such as an
// automation). An endpoint named by one site therefore never hears about
// another site's content. Rebuild notifiers arrive with phase 2.

export interface SiteEvent {
  siteId: string;
  payload: Record<string, unknown>;
}

/**
 * Emits one event per site to its endpoints, in the caller's transaction.
 * Returns the sites that got at least one delivery.
 */
export async function notifySites(tx: DbTx, scope: Scope, type: string, events: readonly SiteEvent[]) {
  const notified = new Set<string>();
  if (!events.length || !webhooksEnabled()) return notified;
  const subscribed = await tx.webhookEndpoint.findMany({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId, ownerModule: "cms", status: "active", eventTypes: { has: type } },
    select: { id: true },
  });
  if (!subscribed.length) return notified;
  const sites = await tx.cmsSite.findMany({ where: { projectId: scope.projectId }, select: { id: true, notifiers: true } });
  const named = new Map(
    sites.map((site) => [site.id, storedNotifiers(site.notifiers).flatMap((n) => (n.kind === "webhook" ? [n.endpointId] : []))]),
  );
  const bound = new Set([...named.values()].flat());
  const projectWide = subscribed.map((e) => e.id).filter((id) => !bound.has(id));
  const subscribedIds = new Set(subscribed.map((e) => e.id));
  for (const { siteId, payload } of events) {
    const targets = [...new Set([...(named.get(siteId) ?? []).filter((id) => subscribedIds.has(id)), ...projectWide])];
    if (!targets.length) continue;
    const eventId = await emitWebhookEvent(tx, scope, type, payload, { endpointIds: targets });
    if (eventId) notified.add(siteId);
  }
  return notified;
}

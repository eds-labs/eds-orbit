import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { Actor, ObjectRef } from "../../../../../packages/module-contracts/src/index.ts";
import { publishEvent } from "../events/events.ts";
import type { DomainEventView } from "../events/types.ts";
import { registeredHandoffs } from "../modules/contributions.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { effectiveRole } from "../tenancy/module-roles.ts";
import { can } from "../tenancy/permissions.ts";
import type { HandoffStatus } from "./types.ts";

// Handoffs between modules (ADR 0017 P-3): the registry of targets and the
// one event through which a target reports progress. The handing module
// listens to `platform.handoff.status_changed` for objects it handed off.

export const HANDOFF_EVENT = "platform.handoff.status_changed";

/** The targets a member may hand off to in the project: enabled modules, with permission. */
export async function availableHandoffs(tx: DbTx, scope: Scope) {
  const enabled = await enabledModules(tx, scope);
  return [...registeredHandoffs()]
    .filter(([, def]) => !enabled || enabled.has(def.owner))
    .filter(([, def]) => {
      const role = effectiveRole(scope, def.owner);
      return role !== "none" && can({ ...scope, role }, def.permission);
    })
    .map(([key, def]) => ({ key, label: def.label, risk: def.risk, owner: def.owner }));
}

/** Reports a handed-off object's progress (content-free). */
export function reportHandoffStatus(
  tx: DbTx,
  scope: Scope,
  target: ObjectRef,
  status: HandoffStatus,
  actor: Actor,
  origin: string,
  cause?: DomainEventView | null,
) {
  return publishEvent(tx, scope, {
    type: HANDOFF_EVENT,
    subject: target,
    actor,
    origin,
    data: { status },
    cause: cause ?? null,
  });
}

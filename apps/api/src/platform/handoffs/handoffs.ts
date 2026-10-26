import { randomUUID } from "node:crypto";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { Actor, ObjectRef } from "../../../../../packages/module-contracts/src/index.ts";
import { publishEvent } from "../events/events.ts";
import type { DomainEventView } from "../events/types.ts";
import { registeredHandoff, registeredHandoffs } from "../modules/contributions.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { effectiveRole, moduleScope } from "../tenancy/module-roles.ts";
import { DomainError } from "../shared.ts";
import { can } from "../tenancy/permissions.ts";
import type { HandoffStatus } from "./types.ts";

// Handoffs between modules (ADR 0017 P-3): the registry of targets and the
// one event through which a target reports progress. The handing module
// listens to `platform.handoff.status_changed` for objects it handed off.

export const HANDOFF_EVENT = "platform.handoff.status_changed";

/** Whether a target takes objects of this type. */
export const handoffAccepts = (def: { accepts?: readonly string[] }, type: string) =>
  !def.accepts || def.accepts.includes(type);

/**
 * The targets a member may hand objects of `fromType` to in the project:
 * enabled modules, with permission.
 */
export async function availableHandoffs(tx: DbTx, scope: Scope, fromType: string) {
  const enabled = await enabledModules(tx, scope);
  return [...registeredHandoffs()]
    .filter(([, def]) => handoffAccepts(def, fromType))
    .filter(([, def]) => !enabled || enabled.has(def.owner))
    .filter(([, def]) => {
      const role = effectiveRole(scope, def.owner);
      return role !== "none" && can({ ...scope, role }, def.permission);
    })
    .map(([key, def]) => ({ key, label: def.label, risk: def.risk, owner: def.owner }));
}

/**
 * Hands an object over at once, for targets a member decides themselves
 * (`W0_internal`), such as a Support agent reporting a ticket as a product
 * issue (ADR 0018). The target must take the object's type, its module
 * must be enabled and the member must hold its permission; paid or external
 * targets need an approval and are refused here.
 */
export async function handOff(
  tx: DbTx,
  scope: Scope,
  key: string,
  from: ObjectRef,
  raw: unknown,
  actor: Actor,
) {
  const def = registeredHandoff(key);
  if (!def || !handoffAccepts(def, from.type)) throw new DomainError("HANDOFF_UNKNOWN", 422);
  if (def.risk !== "W0_internal") throw new DomainError("HANDOFF_APPROVAL_REQUIRED", 409);
  const enabled = await enabledModules(tx, scope);
  if (enabled && !enabled.has(def.owner)) throw new DomainError("HANDOFF_UNAVAILABLE", 409);
  const role = effectiveRole(scope, def.owner);
  if (role === "none" || !can({ ...scope, role }, def.permission)) throw new DomainError("FORBIDDEN", 403);
  return def.create(tx, moduleScope(scope, def.owner), from, def.input.parse(raw), actor, randomUUID());
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

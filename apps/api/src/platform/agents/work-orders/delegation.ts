/**
 * Delegation core (ADR 0021 §8, plan agent-platform-phase-1 WP1.6): the
 * rules a child work order must satisfy before it exists. Pure: the caller
 * loads the parent chain and the target agents, and stores the children.
 */
import { DomainError } from "../../shared.ts";
import {
  MAX_DELEGATION_DEPTH,
  narrowsAllow,
  type AgentAllow,
} from "../principal.ts";

/** Most children one work order may start (D-07). */
export const MAX_DELEGATION_FANOUT = 10;

export type DelegationParent = {
  workOrderId: string;
  rootWorkOrderId: string;
  /** 0 for a root work order. */
  depth: number;
  /** The agent ids on the chain from the root to this work order, the parent's own last (empty for an assistant root). */
  chain: readonly string[];
  /** The agents this work order's agent may hand work to (its `delegateTo`); null for the assistant, which may name any agent. */
  delegateTo: readonly string[] | null;
  allow: AgentAllow | null;
  remainingCeilingMicros: number;
  /** The parent's sponsor; a child is bounded by its own target agent's sponsor, never the parent's. */
  sponsorUserId: string | null;
};

export type DelegationTarget = {
  agentId: string;
  sponsorUserId: string;
  allow: AgentAllow;
  ceilingMicros: number;
};

/** What a child work order inherits from its parent. */
export type DelegatedChild = DelegationTarget & {
  parentId: string;
  rootId: string;
  depth: number;
};

/**
 * Checks the children of `parent` and returns them with their chain fields.
 * Refuses AGENT_DELEGATION_FANOUT (more than 10), AGENT_DELEGATION_DEPTH
 * (deeper than 2), AGENT_DELEGATION_CYCLE (an agent already on the chain),
 * AGENT_DELEGATION_TARGET (an agent the parent does not name),
 * AGENT_DELEGATION_WIDENS (rights beyond the parent's) and
 * AGENT_BUDGET_EXHAUSTED (more than the parent's remaining ceiling, all
 * children together).
 */
export function planChildWorkOrders(
  parent: DelegationParent,
  targets: readonly DelegationTarget[],
): DelegatedChild[] {
  if (targets.length > MAX_DELEGATION_FANOUT)
    throw new DomainError("AGENT_DELEGATION_FANOUT", 409);
  const depth = parent.depth + 1;
  if (depth > MAX_DELEGATION_DEPTH)
    throw new DomainError("AGENT_DELEGATION_DEPTH", 409);
  let total = 0;
  for (const target of targets) {
    if (parent.chain.includes(target.agentId))
      throw new DomainError("AGENT_DELEGATION_CYCLE", 409);
    if (parent.delegateTo && !parent.delegateTo.includes(target.agentId))
      throw new DomainError("AGENT_DELEGATION_TARGET", 403);
    // Monotonic narrowing: an agent parent never hands more than it holds.
    // (The target's own allowlist and sponsor still bound the child: the
    // effective rights are re-read per call from the target's sponsor.)
    if (parent.allow && !narrowsAllow(parent.allow, target.allow))
      throw new DomainError("AGENT_DELEGATION_WIDENS", 403);
    if (!Number.isSafeInteger(target.ceilingMicros) || target.ceilingMicros <= 0)
      throw new DomainError("AGENT_CONFIG_INVALID", 400);
    total += target.ceilingMicros;
  }
  if (total > parent.remainingCeilingMicros)
    throw new DomainError("AGENT_BUDGET_EXHAUSTED", 409);
  return targets.map((target) => ({
    ...target,
    parentId: parent.workOrderId,
    rootId: parent.rootWorkOrderId,
    depth,
  }));
}

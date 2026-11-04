/**
 * Central request attribution for configured agents (ADR 0021 §9): while a
 * tool runs for an agent principal, every ActionRequest it creates records
 * the agent, whatever requester the tool itself passes. A tool can therefore
 * never present an agent's proposal as the member's own assistant request
 * (which an assistant-channel mandate would cover). Mirrors
 * `delegatedExecution` for MCP work orders (platform/tasks/delegation.ts).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { AgentPrincipal } from "./principal.ts";

/**
 * The work order's budget, for a tool that makes its own paid call inside an
 * agent turn (Support triage and draft, ADR 0021 Phase 2): it reserves under
 * the work order's run key, is attributed to the agent and passes the same
 * run and month ceiling check as the turn's own model calls.
 */
export type AgentToolBudget = {
  runKey: string;
  callKey: string;
  agentId?: string;
  check?(tx: DbTx, scope: Scope, estimateMicros: number, now: Date): Promise<void>;
};

export const agentExecution = new AsyncLocalStorage<{
  principal: AgentPrincipal;
  agentRunId: string | null;
  budget?: AgentToolBudget;
}>();

/** The agent call in progress, or null outside one. */
export function currentAgentExecution() {
  return agentExecution.getStore() ?? null;
}

/** The agent requester of the call in progress, or null outside an agent call. */
export function agentExecutionRequester() {
  const current = agentExecution.getStore();
  if (!current) return null;
  const { principal, agentRunId } = current;
  return {
    kind: "agent" as const,
    userId: principal.userId,
    agentRunId,
    agentId: principal.agentId,
    agentVersion: principal.agentVersion,
    workOrderId: principal.workOrderId,
    ...(principal.requesterUserId
      ? { requesterUserId: principal.requesterUserId }
      : {}),
  };
}

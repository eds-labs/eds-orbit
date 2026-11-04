/**
 * Central request attribution for configured agents (ADR 0021 §9): while a
 * tool runs for an agent principal, every ActionRequest it creates records
 * the agent, whatever requester the tool itself passes. A tool can therefore
 * never present an agent's proposal as the member's own assistant request
 * (which an assistant-channel mandate would cover). Mirrors
 * `delegatedExecution` for MCP work orders (platform/tasks/delegation.ts).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentPrincipal } from "./principal.ts";

export const agentExecution = new AsyncLocalStorage<{
  principal: AgentPrincipal;
  agentRunId: string | null;
}>();

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

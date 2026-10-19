import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { authDb } from "../../../../../packages/db/src/index.ts";
import { hash } from "../shared.ts";
import { recordGrantEvent } from "../mcp-auth/events.ts";
import { McpProposalQuotaError } from "./errors.ts";
import {
  MCP_PROPOSAL_WINDOW_MS,
  type McpRateLimiter,
  type RateRule,
} from "./limits.ts";

/**
 * Shared pieces of the MCP proposal tools (Track M, WP-M4). A proposal is a
 * pending ActionRequest; the module's own service creates it and the
 * decision stays in Orbit. These helpers only name the client's call.
 */

/**
 * The dedupe key of one proposal (D-M4-4): the MCP tool name, the project
 * and the arguments as the service normalized them, so a retry that spells
 * out a default matches. Only the hash is stored, never the values.
 */
export function mcpProposalArgsHash(
  tool: string,
  projectId: string,
  args: unknown,
): string {
  return hash({ tool, projectId, args });
}

/** Where the owner decides (D-M4-5): the project's approval inbox; no per-request link exists. */
export function mcpApproveUrl(projectId: string): string {
  return `${new URL(loadConfig().APP_ORIGIN).origin}/p/${encodeURIComponent(projectId)}/approvals`;
}

/**
 * Records one created proposal on the grant (`mcp.proposal`); deduplicated
 * calls are not recorded. Identifiers only, never arguments.
 */
export async function recordMcpProposal(input: {
  userId: string;
  clientId: string;
  grantId: string;
  workspaceId: string;
  actionType: string;
  actionRequestId: string;
}): Promise<void> {
  await recordGrantEvent({
    action: "mcp.proposal",
    userId: input.userId,
    clientId: input.clientId,
    grantId: input.grantId,
    workspaceId: input.workspaceId,
    detail: {
      actionType: input.actionType,
      actionRequestId: input.actionRequestId,
    },
  });
}

/** What the adapter needs to enforce the proposal quotas of one grant (D-M4-8). */
export type ProposalQuota = {
  /** The gateway's limiter: holds the hourly bucket in this process. */
  limiter: McpRateLimiter;
  perHour: number;
  perDay: number;
  now: () => number;
};

const DAY_MS = 86_400_000;
const startOfUtcDay = (ms: number) => ms - (ms % DAY_MS);

const hourlyRule = (quota: ProposalQuota, grantId: string): RateRule => ({
  key: `proposal:${grantId}`,
  max: quota.perHour,
  label: "proposal",
  windowMs: MCP_PROPOSAL_WINDOW_MS,
});

/**
 * Refuses (McpProposalQuotaError) when the grant has used its hourly or
 * daily proposal quota. Checks only; counting happens in chargeProposal
 * after a proposal was actually created, so deduplicated retries cost
 * nothing. The check and the charge are not one step: calls in flight at
 * the same time can all pass the check, so the quota may be overshot by the
 * number of concurrent calls of one grant (bounded by the per-grant request
 * rate), never by more. The daily number is read from the grant's
 * `mcp.proposal` events (written with each creation), so it survives
 * restarts and counts a creation whose call timed out.
 */
export async function assertProposalCapacity(
  quota: ProposalQuota,
  grant: { grantId: string; workspaceId: string },
): Promise<void> {
  if (!quota.limiter.check([hourlyRule(quota, grant.grantId)]).allowed)
    throw new McpProposalQuotaError();
  const today = await authDb.mcpGrantEvent.count({
    where: {
      grantId: grant.grantId,
      workspaceId: grant.workspaceId,
      action: "mcp.proposal",
      createdAt: { gte: new Date(startOfUtcDay(quota.now())) },
    },
  });
  if (today >= quota.perDay) throw new McpProposalQuotaError();
}

/** Counts one created proposal in the grant's hourly bucket. */
export function chargeProposal(quota: ProposalQuota, grantId: string): void {
  quota.limiter.charge([hourlyRule(quota, grantId)]);
}

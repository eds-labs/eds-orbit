import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { authDb } from "../../../../../packages/db/src/index.ts";
import { DomainError, hash } from "../shared.ts";
import type { RequestedBy } from "../../modules/action-requests.ts";
import type { ToolContext } from "../../modules/agents/tools/registry.ts";
import { recordGrantEvent } from "../mcp-auth/events.ts";
import { McpProposalQuotaError } from "./errors.ts";
import {
  MCP_PROPOSAL_DAY_CACHE_MAX,
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
 * The MCP client a proposal comes from (WP-M4): who proposes, through which
 * client and grant, in which run. Derived only by `mcpProposalOrigin` from
 * what the gateway set on the call.
 */
export type McpProposalOrigin = {
  /** The MCP tool name, part of the dedupe key. */
  tool: string;
  userId: string;
  clientId: string;
  grantId: string;
  /** The call's AgentRun, null when the gateway had none. */
  agentRunId: string | null;
};

const filled = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * The origin of a proposal from the call's context (D-M5-8): the scope's
 * user and the channel's client and grant, which only the gateway sets.
 * Refuses MCP_CHANNEL_INCOMPLETE unless the call came through the gateway
 * with all of them, so a tool can never propose as an MCP client otherwise.
 */
export function mcpProposalOrigin(
  context: Pick<ToolContext, "scope" | "runId" | "channel">,
  tool: string,
): McpProposalOrigin {
  const { channel, scope } = context;
  if (
    channel?.kind !== "mcp" ||
    !filled(channel.clientId) ||
    !filled(channel.grantId) ||
    !filled(channel.requestId) ||
    !filled(scope.userId)
  )
    throw new DomainError("MCP_CHANNEL_INCOMPLETE", 500);
  return {
    tool,
    userId: scope.userId,
    clientId: channel.clientId,
    grantId: channel.grantId,
    // Without an AgentRun the gateway passes its request id as runId.
    agentRunId: context.runId === channel.requestId ? null : context.runId,
  };
}

/**
 * The stored requester of an MCP proposal (D-M4-3): the origin plus the hash
 * of the arguments as the service normalized them.
 */
export function mcpRequester(
  origin: McpProposalOrigin,
  projectId: string,
  args: unknown,
): Extract<RequestedBy, { kind: "mcp" }> {
  return {
    kind: "mcp",
    userId: origin.userId,
    clientId: origin.clientId,
    grantId: origin.grantId,
    agentRunId: origin.agentRunId,
    argsHash: mcpProposalArgsHash(origin.tool, projectId, args),
  };
}

/** Longest request id an `mcp.proposal` event names; anything else is recorded as null. */
const MAX_RECORDED_ID = 128;

/** A tool-reported request id as events and logs may carry it: a short string, else null. */
export const recordableId = (value: unknown): string | null =>
  typeof value === "string" && value.length <= MAX_RECORDED_ID ? value : null;

/**
 * Records one created proposal on the grant (`mcp.proposal`): the MCP tool
 * and the request id, never arguments. The adapter writes it for every
 * proposal tool call that did not report a deduplicated retry (D-M5-8), so
 * no tool can forget it.
 */
export async function recordMcpProposal(input: {
  userId: string;
  clientId: string;
  grantId: string;
  workspaceId: string;
  tool: string;
  actionRequestId: unknown;
}): Promise<void> {
  await recordGrantEvent({
    action: "mcp.proposal",
    userId: input.userId,
    clientId: input.clientId,
    grantId: input.grantId,
    workspaceId: input.workspaceId,
    detail: {
      tool: input.tool,
      actionRequestId: recordableId(input.actionRequestId),
    },
  });
}

/**
 * Who the proposal quotas count (D-M5-8): one user through one client in
 * one workspace, whatever grant id the connection has now. A re-selection
 * replaces the grant and must not start fresh buckets.
 */
export type ProposalQuotaKey = {
  userId: string;
  clientId: string;
  workspaceId: string;
};

const DAY_MS = 86_400_000;
const startOfUtcDay = (ms: number) => ms - (ms % DAY_MS);

/**
 * Keys whose daily proposal quota is used up, each until the next UTC
 * midnight (D-M5-8), so a refused client does not cost a count of a day of
 * events per call. Bounded: when full, expired entries go first, then the
 * oldest; an evicted key is only counted again, never let through.
 */
export class McpProposalDayCache {
  private readonly until = new Map<string, number>();

  constructor(private readonly maxKeys = MCP_PROPOSAL_DAY_CACHE_MAX) {}

  get size(): number {
    return this.until.size;
  }

  /** Whether `key` is used up at `now`; drops the entry once it ended. */
  has(key: string, now: number): boolean {
    const end = this.until.get(key);
    if (end === undefined) return false;
    if (end > now) return true;
    this.until.delete(key);
    return false;
  }

  /** Marks `key` used up until `end` (ms). */
  add(key: string, end: number, now: number): void {
    this.until.delete(key);
    if (this.until.size >= this.maxKeys)
      for (const [stored, storedEnd] of this.until)
        if (storedEnd <= now) this.until.delete(stored);
    while (this.until.size >= this.maxKeys) {
      const oldest = this.until.keys().next().value;
      if (oldest === undefined) break;
      this.until.delete(oldest);
    }
    this.until.set(key, end);
  }
}

/** What the adapter needs to enforce the proposal quotas (D-M4-8, D-M5-8). */
export type ProposalQuota = {
  /** The gateway's limiter: holds the hourly bucket in this process. */
  limiter: McpRateLimiter;
  perHour: number;
  perDay: number;
  now: () => number;
  /** The gateway's "daily quota used up" memory. */
  usedUp: McpProposalDayCache;
  /** Counts the key's proposals since `since` (tests); default: its `mcp.proposal` events. */
  countToday?: (key: ProposalQuotaKey, since: Date) => Promise<number>;
};

const keyOf = (key: ProposalQuotaKey) =>
  JSON.stringify([key.userId, key.clientId, key.workspaceId]);

const hourlyRule = (quota: ProposalQuota, key: ProposalQuotaKey): RateRule => ({
  key: `proposal:${keyOf(key)}`,
  max: quota.perHour,
  label: "proposal",
  windowMs: MCP_PROPOSAL_WINDOW_MS,
});

/** The key's `mcp.proposal` events since `since`, across all of its grants. */
const countProposalEvents = (key: ProposalQuotaKey, since: Date) =>
  authDb.mcpGrantEvent.count({
    where: {
      userId: key.userId,
      clientId: key.clientId,
      workspaceId: key.workspaceId,
      action: "mcp.proposal",
      createdAt: { gte: since },
    },
  });

/** A proposal's place in the hourly bucket, taken before the tool runs. */
export type ProposalReservation = {
  /** Gives the place back (a deduplicated retry, a failed call); once. */
  release(): void;
};

/**
 * Reserves one proposal for the key, or refuses (McpProposalQuotaError) when
 * its hourly or daily quota is used up. The hourly bucket is checked and
 * charged in one synchronous step before anything is awaited (review M4),
 * so concurrent calls of one key in this process can never take more than
 * the free room; the caller releases the place when no proposal was created
 * (a deduplicated retry, a thrown call). A daily refusal or a failed count
 * releases it here.
 *
 * The daily number is read from the key's `mcp.proposal` events (written by
 * the adapter after each creation, also for a call that timed out), so it
 * survives restarts; once it reaches the limit the key is refused from
 * memory until the next UTC midnight. The daily check is not atomic with
 * the creation: calls in flight at the same time can all pass it, so the
 * daily quota may be overshot by the calls of one key in flight at once
 * (bounded by the hourly bucket in each process and the request rates).
 */
export async function reserveProposal(
  quota: ProposalQuota,
  key: ProposalQuotaKey,
): Promise<ProposalReservation> {
  const rule = hourlyRule(quota, key);
  if (!quota.limiter.check([rule]).allowed) throw new McpProposalQuotaError();
  const charge = quota.limiter.charge([rule]);
  let released = false;
  const reservation: ProposalReservation = {
    release() {
      if (released) return;
      released = true;
      quota.limiter.refund(charge);
    },
  };
  try {
    const now = quota.now();
    const cacheKey = keyOf(key);
    if (quota.usedUp.has(cacheKey, now)) throw new McpProposalQuotaError();
    const dayStart = startOfUtcDay(now);
    const today = await (quota.countToday ?? countProposalEvents)(
      key,
      new Date(dayStart),
    );
    if (today >= quota.perDay) {
      quota.usedUp.add(cacheKey, dayStart + DAY_MS, now);
      throw new McpProposalQuotaError();
    }
  } catch (error) {
    reservation.release();
    throw error;
  }
  return reservation;
}

/**
 * Audit, call log and telemetry of the MCP gateway (Track M, WP-M2,
 * plans/orbit-modularization/09 §7). One observer handles every finished
 * `tools/call`:
 *
 * - a call in a project writes an `AuditEvent` `mcp.tool_call` in that
 *   project (tool, client id, grant id, outcome code, duration, argument
 *   hash) and an `AgentRun` of kind `mcp` with one `tool_call` span (not
 *   for a refused call to an unknown tool, recorded as `<unknown>`);
 * - a call without a project (orbit_projects, a project outside the grant, a
 *   grant that is gone) writes an `McpGrantEvent` `mcp.call`;
 * - `McpGrant.lastUsedAt` follows, at most once a minute per grant.
 *
 * Argument values and results are never stored or logged: only the hash of
 * the arguments is. Failures never reach the caller: they are logged by error
 * name (an audit write for a project call at error level) and the call goes on.
 */
import { createHash } from "node:crypto";
import { authDb, scoped } from "../../../../../packages/db/src/index.ts";
import { hashText, finishRun, recordSpan, startRun } from "../ai/telemetry.ts";
import { recordGrantEvent } from "../mcp-auth/events.ts";
import { audit } from "../shared.ts";
import {
  MCP_UNKNOWN_TOOL,
  type McpCallObserver,
  type McpCallRecord,
  type McpRunStarter,
} from "./adapter.ts";

/** AuditEvent action of a call in a project. */
export const MCP_TOOL_CALL_ACTION = "mcp.tool_call";
/** How rarely a grant's lastUsedAt is written. */
export const LAST_USED_INTERVAL_MS = 60_000;
const MEMO_SWEEP_SIZE = 1000;

/** JSON with sorted object keys, so equal arguments hash equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** SHA-256 of the canonical JSON of the arguments (absent arguments count as `{}`). */
export function argsHash(args: unknown): string {
  try {
    return hashText(canonicalJson(args ?? {}));
  } catch {
    // Not JSON (cannot happen for a parsed request): still a fixed-size value.
    return createHash("sha256").update("unhashable").digest("hex");
  }
}

type Log = {
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
};

const errorName = (error: unknown) => (error as Error | undefined)?.name;

/** The facts of one finished call that audit rows carry. */
export type AuditedCall = Pick<
  McpCallRecord,
  | "requestId"
  | "tool"
  | "userId"
  | "clientId"
  | "grantId"
  | "workspaceId"
  | "projectId"
  | "outcome"
  | "durationMs"
> & { argsHash: string };

/**
 * Writes the audit record of one call: an AuditEvent `mcp.tool_call` in its
 * project, or, without a project, an McpGrantEvent `mcp.call`. Never throws:
 * a failed project write is logged at error level, a failed call-log write
 * as a warning, both by error name only.
 */
export async function auditToolCall(call: AuditedCall, log: Log) {
  const { workspaceId, projectId } = call;
  if (projectId && workspaceId) {
    const scope = { workspaceId, projectId, userId: call.userId };
    try {
      await scoped(workspaceId, projectId, (tx) =>
        audit(tx, scope, MCP_TOOL_CALL_ACTION, call.requestId, {
          tool: call.tool,
          clientId: call.clientId,
          grantId: call.grantId,
          outcome: call.outcome,
          durationMs: call.durationMs,
          argsHash: call.argsHash,
        }),
      );
    } catch (error) {
      log.error(
        {
          code: "MCP_AUDIT_FAILED",
          tool: call.tool,
          requestId: call.requestId,
          errorName: errorName(error),
        },
        "mcp audit write failed",
      );
    }
    return;
  }
  try {
    await recordGrantEvent({
      action: "mcp.call",
      userId: call.userId,
      clientId: call.clientId,
      ...(call.grantId ? { grantId: call.grantId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      detail: {
        tool: call.tool,
        outcome: call.outcome,
        durationMs: call.durationMs,
        argsHash: call.argsHash,
      },
    });
  } catch (error) {
    log.warn(
      {
        code: "MCP_CALL_LOG_FAILED",
        tool: call.tool,
        requestId: call.requestId,
        errorName: errorName(error),
      },
      "mcp call log write failed",
    );
  }
}

/**
 * Starts the `mcp` AgentRun of one project call; the adapter calls it before
 * the tool runs, the observer below adds the span and finishes it. Null when
 * the run cannot be created (startRun logs it).
 */
export const startMcpRun: McpRunStarter = (project, call) =>
  startRun(project, {
    kind: "mcp",
    agentName: `mcp:${call.clientId}`,
    taskClass: call.tool,
    ...(call.grantId
      ? { subjectType: "mcp_grant", subjectId: call.grantId }
      : {}),
  });

/**
 * The gateway's call observer. `now` only paces the lastUsedAt writes (tests
 * move it); stored timestamps are real time.
 */
export function createMcpObserver(options: {
  log: Log;
  now?: () => number;
}): McpCallObserver {
  const { log } = options;
  const now = options.now ?? Date.now;
  const lastUsedMemo = new Map<string, number>();

  async function traceProjectCall(record: McpCallRecord, hash: string) {
    if (!record.projectId || !record.workspaceId) return;
    // A refused call to a tool Orbit does not know gets its audit row only:
    // made-up names must not fill the run table.
    if (record.tool === MCP_UNKNOWN_TOOL) return;
    const scope = {
      workspaceId: record.workspaceId,
      projectId: record.projectId,
    };
    const startedAt = new Date(Date.now() - record.durationMs);
    // The run exists already when the call got as far as its tool; a refused
    // call (or a run that could not be started) is recorded afterwards.
    const runId =
      record.agentRunId ??
      (await startRun(scope, {
        kind: "mcp",
        agentName: `mcp:${record.clientId}`,
        taskClass: record.tool,
        ...(record.grantId
          ? { subjectType: "mcp_grant", subjectId: record.grantId }
          : {}),
        startedAt,
      }));
    const ok = record.outcome === "ok";
    await recordSpan(scope, runId, {
      type: "tool_call",
      name: record.tool,
      status: ok ? "succeeded" : "failed",
      ...(ok ? {} : { errorCode: record.outcome }),
      startedAt,
      durationMs: record.durationMs,
      inputHash: hash,
    });
    await finishRun(scope, runId, ok ? "succeeded" : "failed", record.outcome);
  }

  async function touchGrant(record: McpCallRecord) {
    const { grantId } = record;
    if (!grantId) return;
    const at = now();
    const last = lastUsedMemo.get(grantId);
    if (last !== undefined && at - last < LAST_USED_INTERVAL_MS) return;
    if (lastUsedMemo.size >= MEMO_SWEEP_SIZE)
      for (const [id, when] of lastUsedMemo)
        if (at - when >= LAST_USED_INTERVAL_MS) lastUsedMemo.delete(id);
    // Marked before the write, so concurrent calls do not all write.
    lastUsedMemo.set(grantId, at);
    try {
      await authDb.mcpGrant.updateMany({
        where: { id: grantId, status: "active" },
        data: { lastUsedAt: new Date() },
      });
    } catch (error) {
      lastUsedMemo.delete(grantId);
      log.warn(
        {
          code: "MCP_LAST_USED_FAILED",
          requestId: record.requestId,
          errorName: errorName(error),
        },
        "mcp grant lastUsedAt update failed",
      );
    }
  }

  return async (record) => {
    const hash = argsHash(record.args);
    await Promise.all([
      auditToolCall({ ...record, argsHash: hash }, log),
      traceProjectCall(record, hash),
      touchGrant(record),
    ]);
  };
}

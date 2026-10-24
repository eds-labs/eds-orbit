import {
  CHAT_MAX_INPUT_BYTES,
  CHAT_MAX_MODEL_CALLS,
} from "../assistant/chat-limits.ts";
import { registeredConversationSections } from "../modules/contributions.ts";
import { visibleModules } from "../tenancy/module-roles.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { z } from "zod";
import { type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  estimateCost,
  resolveRoute,
  providerOfModel,
  type OpenAiRuntimeConfig,
} from "../../../../../packages/ai/src/index.ts";
import { runtimeOpenAiConfiguration } from "../ai/openai-configuration.ts";
import { userScoped } from "../tenancy/scope.ts";
import { authorize, PROJECT_WRITE } from "../tenancy/permissions.ts";
import { actorScope } from "../tenancy/member-scope.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  hash,
  update,
} from "../shared.ts";
import {
  createActionRequest,
  cancelActionRequest,
  type ActionDefinition,
} from "../../modules/action-requests.ts";
import { sendMessageInTransaction } from "../../modules/chat.ts";
import { projectScope, type McpPrincipal } from "../mcp/principal.ts";
import { principalModules } from "../mcp/visibility.ts";
import { mcpApproveUrl } from "../mcp/proposals.ts";
import { assertDelegation, type Delegation } from "./delegation.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";

export const TASK_KIND = "orbit_tasks";

/** Approve the largest allowed route, including the owner's provider-budget fallback. */
export function taskChatCeiling(runtime: OpenAiRuntimeConfig) {
  const primary = resolveRoute("chat_operator", runtime);
  const routes = [primary];
  if (
    providerOfModel(primary.model, runtime.models) === "anthropic" &&
    runtime.fallback?.onProviderBudgetStop === "openai"
  )
    routes.push(resolveRoute("chat_operator", runtime, { provider: "openai" }));
  return (
    CHAT_MAX_MODEL_CALLS *
    Math.max(
      ...routes.map((route) =>
        estimateCost(
          route.model,
          CHAT_MAX_INPUT_BYTES,
          route.maxOutputTokens,
          runtime,
        ),
      ),
    )
  );
}

export const taskInput = z
  .object({
    description: z.string().trim().min(1).max(4000),
    idempotencyKey: z.string().min(1).max(128),
    mode: z.enum(["read", "draft", "execute"]).default("draft"),
    modules: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{1,30}$/))
      .min(1)
      .max(10),
  })
  .strict();
const payload = z
  .object({
    taskId: z.uuid(),
    descriptionHash: z.string(),
    ceilingMicros: z.number().int().nonnegative(),
  })
  .strict();

export const taskStart: ActionDefinition<z.infer<typeof payload>> = {
  riskClass: "C1",
  approvalMode: "approval_required",
  deciderRole: "owner",
  get mcpProposable() {
    return loadConfig().ORBIT_MCP_TASKS === "true";
  },
  ttlMs: 24 * 3600000,
  payload,
  costCeilingMicros: (p) => p.ceilingMicros,
  async revalidate(tx, scope, p) {
    const row = await entity(tx, scope, TASK_KIND, p.taskId);
    const d = data(row);
    if (d.runId || d.canceledAt || hash(d.description) !== p.descriptionHash)
      throw new DomainError("TASK_STALE", 409);
    const actor = await actorScope(
      scope.workspaceId,
      scope.projectId,
      d.userId,
    );
    if (!actor) throw new DomainError("ACTOR_MEMBERSHIP_REQUIRED", 403);
    await assertDelegation(actor, { ...d.delegation, taskId: row.id }, tx);
    const ai = await runtimeOpenAiConfiguration(tx, actor);
    if (
      d.delegation.ceilingMicros !== p.ceilingMicros ||
      taskChatCeiling(ai) > p.ceilingMicros
    )
      throw new DomainError("COST_CEILING_CHANGED", 409);
  },
  async onApproved(tx, scope, request) {
    const row = await entity(
      tx,
      scope,
      TASK_KIND,
      data(request).payload.taskId,
    );
    const d = data(row);
    const actor = await actorScope(
      scope.workspaceId,
      scope.projectId,
      d.userId,
    );
    if (!actor) throw new DomainError("ACTOR_MEMBERSHIP_REQUIRED", 403);
    await tx.$executeRaw`SELECT set_config('app.user_id',${actor.userId},true)`;
    const run = await sendMessageInTransaction(tx, actor, d.conversationId, {
      text: d.description,
      clientRequestId: row.id,
    });
    await update(tx, actor, row, {
      ...d,
      runId: run.runId,
      jobId: run.jobId,
      startedAt: new Date().toISOString(),
    });
    await audit(tx, actor, "task.queued", row.id, { runId: run.runId });
  },
};

export async function createTask(
  principal: McpPrincipal,
  projectId: string,
  raw: unknown,
) {
  const input = taskInput.parse(raw);
  const scope = await projectScope(principal, projectId);
  authorize(scope, PROJECT_WRITE);
  if (
    loadConfig().ORBIT_MCP_TASKS !== "true" ||
    loadConfig().ORBIT_MCP_PROPOSALS !== "true" ||
    !principal.scopes.has("orbit:propose")
  )
    throw new DomainError("MCP_TOOL_NOT_ALLOWED", 403);
  if (input.mode === "execute" && !principal.scopes.has("orbit:write"))
    throw new DomainError("MCP_TOOL_NOT_ALLOWED", 403);
  const visible = await principalModules(principal, scope);
  if (input.modules.some((m) => !visible.includes(m)))
    throw new DomainError("MCP_TOOL_NOT_ALLOWED", 403);
  if (
    input.modules.includes("support") &&
    !principal.scopes.has("orbit:support")
  )
    throw new DomainError("MCP_SUPPORT_CONSENT_REQUIRED", 403);
  const modules = [...new Set(input.modules)].sort();
  const argsHash = hash({ ...input, modules });
  return userScoped(scope, async (tx) => {
    const old = await tx.entity.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        projectId,
        kind: TASK_KIND,
        AND: [
          { data: { path: ["userId"], equals: scope.userId } },
          { data: { path: ["clientId"], equals: principal.clientId } },
          { data: { path: ["idempotencyKey"], equals: input.idempotencyKey } },
        ],
      },
    });
    if (old) {
      if (data(old).argsHash !== argsHash)
        throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", 409);
      return {
        taskId: old.id,
        actionRequestId: data(old).actionRequestId,
        deduplicated: true,
        approveUrl: mcpApproveUrl(projectId),
      };
    }
    const ai = await runtimeOpenAiConfiguration(tx, scope);
    const ceilingMicros = taskChatCeiling(ai);
    const conversation = await tx.chatConversation.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId,
        userId: scope.userId,
        title: input.description.slice(0, 80),
      },
    });
    const delegation: Omit<Delegation, "taskId"> = {
      grantId: principal.grantId,
      clientId: principal.clientId,
      userId: principal.userId,
      scopes: [...principal.scopes],
      modules,
      mode: input.mode,
      ceilingMicros,
    };
    const task = await create(tx, scope, TASK_KIND, {
      description: input.description,
      userId: scope.userId,
      clientId: principal.clientId,
      delegation,
      idempotencyKey: input.idempotencyKey,
      argsHash,
      conversationId: conversation.id,
      runId: null,
      jobId: null,
      canceledAt: null,
    });
    const request = await createActionRequest(tx, scope, {
      actionType: "platform.task.start",
      payload: {
        taskId: task.id,
        descriptionHash: hash(input.description),
        ceilingMicros,
      },
      requestedBy: {
        kind: "mcp",
        userId: scope.userId,
        clientId: principal.clientId,
        grantId: principal.grantId,
        agentRunId: null,
        argsHash,
        taskId: task.id,
      },
    });
    await update(tx, scope, task, {
      ...data(task),
      actionRequestId: request.id,
    });
    await audit(tx, scope, "task.created", task.id, {
      clientId: principal.clientId,
    });
    return {
      taskId: task.id,
      actionRequestId: request.id,
      deduplicated: false,
      approveUrl: mcpApproveUrl(projectId),
    };
  });
}

/** Same user/client boundary as action-status; web can read its own tasks. */
export async function readTask(
  scope: Scope,
  taskId: string,
  clientId?: string,
) {
  return userScoped(scope, async (tx) => {
    const row = await entity(tx, scope, TASK_KIND, taskId);
    const d = data(row);
    if (d.userId !== scope.userId || (clientId && d.clientId !== clientId))
      throw new DomainError("NOT_FOUND", 404);
    const visible = visibleModules(scope, await enabledModules(tx, scope));
    if (visible && d.delegation.modules.some((m: string) => !visible.has(m)))
      throw new DomainError("NOT_FOUND", 404);
    return taskSnapshot(tx, scope, row);
  });
}

async function taskSnapshot(
  tx: DbTx,
  scope: Scope,
  row: Awaited<ReturnType<typeof create>>,
) {
  const d = data(row);
  const run = d.runId
    ? await tx.chatRun.findFirst({
        where: {
          id: d.runId,
          userId: scope.userId,
          projectId: scope.projectId,
        },
      })
    : null;
  const agentRuns = d.runId
    ? await tx.agentRun.findMany({
        where: {
          projectId: scope.projectId,
          subjectType: "chat_run",
          subjectId: d.runId,
        },
        orderBy: { startedAt: "desc" },
        take: 5,
        select: {
          id: true,
          agentName: true,
          status: true,
          spans: {
            where: { type: "tool_call" },
            take: 20,
            select: { name: true, status: true },
          },
        },
      })
    : [];
  const requests = await tx.entity.findMany({
    where: {
      projectId: scope.projectId,
      kind: "action_requests",
      data: { path: ["requestedBy", "taskId"], equals: row.id },
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const approvals = requests.map((r) => {
    const a = data(r);
    return {
      actionRequestId: r.id,
      actionType: a.actionType,
      status:
        a.status === "pending" && Date.parse(a.expiresAt) <= Date.now()
          ? "expired"
          : a.status,
      approveUrl: mcpApproveUrl(scope.projectId),
    };
  });
  const start = approvals.find((a) => a.actionRequestId === d.actionRequestId);
  const sections: Record<string, unknown> = {};
  const messages = await tx.chatMessage.findMany({
    where: {
      projectId: scope.projectId,
      userId: scope.userId,
      conversationId: d.conversationId,
    },
    orderBy: { sequence: "desc" },
    take: 20,
  });
  for (const section of registeredConversationSections(
    new Set(d.delegation.modules),
  ))
    Object.assign(
      sections,
      await section(
        tx,
        scope,
        d.conversationId,
        messages.map((m) => ({ cards: Array.isArray(m.cards) ? m.cards : [] })),
      ),
    );
  const artifacts: Array<Record<string, unknown>> = [];
  const childStates = new Set<string>();
  const blockers = new Set<string>();
  const visit = (value: unknown, kind: string, depth = 0) => {
    if (
      depth > 5 ||
      artifacts.length >= 15 ||
      !value ||
      typeof value !== "object"
    )
      return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 30)) visit(item, kind, depth + 1);
      return;
    }
    const r = value as Record<string, unknown>;
    if (typeof r.status === "string") childStates.add(r.status);
    if (typeof r.errorCode === "string") blockers.add(r.errorCode);
    if (typeof r.id === "string")
      artifacts.push({
        id: r.id,
        kind,
        status: r.status ?? null,
        ...(typeof r.body === "string" ? { body: r.body.slice(0, 500) } : {}),
      });
    for (const [key, nested] of Object.entries(r))
      if (nested && typeof nested === "object") visit(nested, key, depth + 1);
  };
  for (const [kind, value] of Object.entries(sections)) visit(value, kind);
  for (const r of requests)
    if (data(r).executionResult)
      visit(data(r).executionResult, "operation_result");
  for (const request of requests) {
    const result = data(request).executionResult;
    if (typeof result?.jobId === "string") {
      const job = await tx.entity.findFirst({
        where: { id: result.jobId, projectId: scope.projectId, kind: "jobs" },
      });
      if (job) {
        const state = data(job);
        childStates.add(state.status);
        if (typeof state.error === "string") blockers.add(state.error);
        artifacts.push({ id: job.id, kind: "job", status: state.status });
      }
    }
  }
  const open = approvals.some((a) => a.status === "pending");
  const childStatus = childStates.has("awaiting_approval")
    ? "awaiting_approval"
    : ["running", "queued", "revising"].some((s) => childStates.has(s))
      ? "running"
      : [
            "failed",
            "blocked_dependency",
            "outcome_unknown",
            "partially_completed",
          ].some((s) => childStates.has(s))
        ? "blocked"
        : null;
  const status = d.canceledAt
    ? "canceled"
    : open
      ? "awaiting_approval"
      : run?.status === "succeeded" && childStatus
        ? childStatus
        : (run?.status ?? start?.status ?? "queued");
  return {
    schemaVersion: 1,
    taskId: row.id,
    projectId: scope.projectId,
    description: d.description,
    requestedBy: { userId: d.userId, clientId: d.clientId },
    status,
    phase:
      status === run?.status
        ? status
        : `${run?.status ?? "approval"}:${status}`,
    agent: "orbit_operator",
    agents: agentRuns.map((r) => ({
      id: r.id,
      name: r.agentName,
      status: r.status,
    })),
    capabilitiesUsed: [
      ...new Set(agentRuns.flatMap((r) => r.spans.map((span) => span.name))),
    ],
    modules: d.delegation.modules,
    conversationId: d.conversationId,
    runId: d.runId,
    approvals,
    artifacts,
    blockers: [...blockers],
    errorCode: run?.errorCode ?? [...blockers][0] ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: (run?.updatedAt ?? row.updatedAt).toISOString(),
    completedAt: [
      "succeeded",
      "failed",
      "blocked",
      "canceled",
      "rejected",
      "expired",
    ].includes(status)
      ? (d.canceledAt ?? (run?.updatedAt ?? row.updatedAt).toISOString())
      : null,
    result: run?.partialText?.slice(0, 4000) ?? null,
    resourceUri: `orbit://tasks/${scope.projectId}/${row.id}`,
    url: `${new URL(loadConfig().APP_ORIGIN).origin}/p/${scope.projectId}/assistant?conversation=${d.conversationId}`,
  };
}

export async function listTasks(
  scope: Scope,
  input: { clientId?: string; cursor?: string; limit?: number } = {},
) {
  return userScoped(scope, async (tx) => {
    const limit = Math.min(input.limit ?? 20, 50);
    let cursor: { at: Date; id: string } | undefined;
    if (input.cursor) {
      const [at, id] = Buffer.from(input.cursor, "base64url")
        .toString("utf8")
        .split("|");
      if (
        !z.iso.datetime().safeParse(at).success ||
        !z.uuid().safeParse(id).success
      )
        throw new DomainError("CURSOR_INVALID", 400);
      cursor = { at: new Date(at!), id: id! };
    }
    const rows = await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: TASK_KIND,
        AND: [
          { data: { path: ["userId"], equals: scope.userId } },
          ...(input.clientId
            ? [{ data: { path: ["clientId"], equals: input.clientId } }]
            : []),
        ],
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.at } },
                { createdAt: cursor.at, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const visible = visibleModules(scope, await enabledModules(tx, scope));
    const permitted = rows
      .slice(0, limit)
      .filter(
        (row) =>
          !visible ||
          !data(row).delegation.modules.some((m: string) => !visible.has(m)),
      );
    const items = await Promise.all(
      permitted.map((row) => taskSnapshot(tx, scope, row)),
    );
    return {
      schemaVersion: 1,
      items: items.map(({ result, ...rest }) => rest),
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              `${rows[limit - 1]!.createdAt.toISOString()}|${rows[limit - 1]!.id}`,
            ).toString("base64url")
          : null,
    };
  });
}

export async function cancelTask(
  scope: Scope,
  taskId: string,
  clientId?: string,
) {
  authorize(scope, PROJECT_WRITE);
  await userScoped(scope, async (tx) => {
    const row = await entity(tx, scope, TASK_KIND, taskId);
    const d = data(row);
    if (d.userId !== scope.userId || (clientId && d.clientId !== clientId))
      throw new DomainError("NOT_FOUND", 404);
    if (d.canceledAt) return;
    const current = await taskSnapshot(tx, scope, row);
    if (
      [
        "succeeded",
        "blocked",
        "failed",
        "canceled",
        "rejected",
        "expired",
      ].includes(current.status)
    )
      return;
    const run = d.runId
      ? await tx.chatRun.findFirst({
          where: { id: d.runId, userId: scope.userId },
        })
      : null;
    if (run && ["blocked", "failed", "canceled"].includes(run.status)) return;
    if (run && run.status !== "succeeded")
      await tx.chatRun.update({
        where: { id: run.id },
        data: { status: "canceled", sequence: { increment: 1 } },
      });
    const approvals = await tx.entity.findMany({
      where: {
        projectId: scope.projectId,
        kind: "action_requests",
        data: { path: ["requestedBy", "taskId"], equals: taskId },
      },
    });
    for (const a of approvals)
      await cancelActionRequest(tx, scope, a.id, "task_canceled", {
        pendingOnly: true,
      });
    await update(tx, scope, row, {
      ...d,
      canceledAt: new Date().toISOString(),
    });
    await audit(tx, scope, "task.canceled", row.id);
  });
  return readTask(scope, taskId, clientId);
}

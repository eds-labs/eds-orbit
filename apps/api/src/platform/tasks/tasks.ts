import {
  CHAT_MAX_INPUT_BYTES,
  CHAT_MAX_MODEL_CALLS,
  CHAT_MAX_OUTPUT_CHARS,
} from "../assistant/chat-limits.ts";
import { registeredConversationSections } from "../modules/contributions.ts";
import { visibleModules } from "../tenancy/module-roles.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { randomUUID } from "node:crypto";
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
import { FINANCE_READ_SCOPE } from "../mcp/scopes.ts";
import { assertDelegation, type Delegation } from "./delegation.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";

export const TASK_KIND = "orbit_tasks";

// ---------------------------------------------------------------------------
// The task store (ADR 0021 D-05, ADR 0022 item 7, plan agent-platform-phase-3
// WP3.6). New MCP tasks are rows of AgentWorkOrder with target "assistant"
// and origin "mcp": the frozen delegation is split into `requestedBy` (who:
// user, client, grant, scopes) and `allow` (what: modules, mode) plus the
// ceiling column; the private conversation is `conversationId`, the start
// approval `startRequestId`. Tasks created before are `orbit_tasks`
// entities and stay readable, cancellable and startable until task
// retention removes them. This module is the compatibility reader: every
// task read goes through `TaskRecord`, whichever store holds it.

export type TaskRecord = {
  id: string;
  store: "table" | "entity";
  description: string;
  userId: string;
  clientId: string;
  delegation: Omit<Delegation, "taskId">;
  idempotencyKey: string;
  argsHash: string;
  conversationId: string;
  runId: string | null;
  jobId: string | null;
  canceledAt: string | null;
  actionRequestId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Where an MCP task lives in the work order table. */
const TASK_ROWS = { target: "assistant", origin: "mcp" } as const;

type WorkOrderRow = Awaited<ReturnType<DbTx["agentWorkOrder"]["findFirstOrThrow"]>>;
type EntityRow = Awaited<ReturnType<typeof create>>;

function fromEntity(row: EntityRow): TaskRecord {
  const d = data(row);
  return {
    id: row.id,
    store: "entity",
    description: d.description,
    userId: d.userId,
    clientId: d.clientId,
    delegation: d.delegation,
    idempotencyKey: d.idempotencyKey,
    argsHash: d.argsHash,
    conversationId: d.conversationId,
    runId: d.runId ?? null,
    jobId: d.jobId ?? null,
    canceledAt: d.canceledAt ?? null,
    actionRequestId: d.actionRequestId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function fromWorkOrder(row: WorkOrderRow): TaskRecord {
  const by = row.requestedBy as {
    userId: string;
    clientId: string;
    grantId: string;
    scopes: string[];
  };
  const allow = row.allow as { modules: string[]; mode: Delegation["mode"] };
  const input = row.input as {
    description: string;
    idempotencyKey: string;
    argsHash: string;
    runId?: string | null;
    canceledAt?: string | null;
  };
  const times = [row.createdAt, row.startedAt, row.finishedAt].filter(
    (t): t is Date => t instanceof Date,
  );
  return {
    id: row.id,
    store: "table",
    description: input.description,
    userId: by.userId,
    clientId: by.clientId,
    delegation: {
      grantId: by.grantId,
      clientId: by.clientId,
      userId: by.userId,
      scopes: by.scopes,
      modules: allow.modules,
      mode: allow.mode,
      ceilingMicros: Number(row.ceilingMicros),
    },
    idempotencyKey: input.idempotencyKey,
    argsHash: input.argsHash,
    conversationId: row.conversationId!,
    runId: input.runId ?? null,
    jobId: row.jobId,
    canceledAt: input.canceledAt ?? null,
    actionRequestId: row.startRequestId,
    createdAt: row.createdAt,
    updatedAt: new Date(Math.max(...times.map((t) => t.getTime()))),
  };
}

/** A task by id from either store, or null. */
export async function findTaskRecord(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  id: string,
): Promise<TaskRecord | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const row = await tx.agentWorkOrder.findFirst({
    where: { id, workspaceId: scope.workspaceId, projectId: scope.projectId, ...TASK_ROWS },
  });
  if (row) return fromWorkOrder(row);
  const legacy = await tx.entity.findFirst({
    where: { id, workspaceId: scope.workspaceId, projectId: scope.projectId, kind: TASK_KIND },
  });
  return legacy ? fromEntity(legacy) : null;
}

/** A task by id from either store; 404 NOT_FOUND otherwise. */
export async function readTaskRecord(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  id: string,
): Promise<TaskRecord> {
  const record = await findTaskRecord(tx, scope, id);
  if (!record) throw new DomainError("NOT_FOUND", 404);
  return record;
}

/** The task whose chat run this is, from either store, or null. */
export async function taskRecordByRun(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  runId: string,
): Promise<TaskRecord | null> {
  const row = await tx.agentWorkOrder.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      ...TASK_ROWS,
      input: { path: ["runId"], equals: runId },
    },
  });
  if (row) return fromWorkOrder(row);
  const legacy = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: TASK_KIND,
      data: { path: ["runId"], equals: runId },
    },
  });
  return legacy ? fromEntity(legacy) : null;
}

/** The user's task of a conversation, from either store, or null. */
export async function taskRecordByConversation(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  conversationId: string,
  userId: string,
): Promise<TaskRecord | null> {
  const row = await tx.agentWorkOrder.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      ...TASK_ROWS,
      conversationId,
      requestedBy: { path: ["userId"], equals: userId },
    },
  });
  if (row) return fromWorkOrder(row);
  const legacy = await tx.entity.findFirst({
    where: {
      projectId: scope.projectId,
      kind: TASK_KIND,
      AND: [
        { data: { path: ["conversationId"], equals: conversationId } },
        { data: { path: ["userId"], equals: userId } },
      ],
    },
  });
  return legacy ? fromEntity(legacy) : null;
}

/** Records a task's start or cancellation in its own store. */
async function saveTaskRecord(
  tx: DbTx,
  scope: Scope,
  record: TaskRecord,
  change: { runId: string; jobId: string; startedAt: Date } | { canceledAt: Date },
) {
  if (record.store === "entity") {
    const row = await entity(tx, scope, TASK_KIND, record.id);
    await update(
      tx,
      scope,
      row,
      "canceledAt" in change
        ? { ...data(row), canceledAt: change.canceledAt.toISOString() }
        : {
            ...data(row),
            runId: change.runId,
            jobId: change.jobId,
            startedAt: change.startedAt.toISOString(),
          },
    );
    return;
  }
  const row = await tx.agentWorkOrder.findFirstOrThrow({
    where: { id: record.id, projectId: scope.projectId, ...TASK_ROWS },
  });
  const input = row.input as Record<string, unknown>;
  await tx.agentWorkOrder.update({
    where: { id: record.id },
    data:
      "canceledAt" in change
        ? {
            status: "canceled",
            finishedAt: change.canceledAt,
            input: { ...input, canceledAt: change.canceledAt.toISOString() },
          }
        : {
            // The chat run carries the progress; the row records the start.
            status: "running",
            startedAt: change.startedAt,
            jobId: change.jobId,
            input: { ...input, runId: change.runId },
          },
  });
}

/** The table idempotency key of a task: per user, client and client key. */
const taskKey = (userId: string, clientId: string, idempotencyKey: string) =>
  `mcp-task:${hash({ userId, clientId, idempotencyKey })}`;

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
    const d = await readTaskRecord(tx, scope, p.taskId);
    const row = { id: d.id };
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
    const d = await readTaskRecord(tx, scope, data(request).payload.taskId);
    const row = { id: d.id };
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
    await saveTaskRecord(tx, actor, d, {
      runId: run.runId,
      jobId: String(run.jobId),
      startedAt: new Date(),
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
  // Finance content reaches a task only through the native finance tools,
  // which need the same explicit consent as a direct MCP read.
  if (
    input.modules.includes("finance") &&
    !principal.scopes.has(FINANCE_READ_SCOPE)
  )
    throw new DomainError("MCP_FINANCE_CONSENT_REQUIRED", 403);
  const modules = [...new Set(input.modules)].sort();
  const argsHash = hash({ ...input, modules });
  return userScoped(scope, async (tx) => {
    // A retry finds the task in either store: the table, or an entity of
    // a task created before the fold-in.
    const stored = await tx.agentWorkOrder.findUnique({
      where: {
        projectId_idempotencyKey: {
          projectId,
          idempotencyKey: taskKey(scope.userId, principal.clientId, input.idempotencyKey),
        },
      },
    });
    const legacy = stored
      ? null
      : await tx.entity.findFirst({
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
    const old = stored ? fromWorkOrder(stored) : legacy ? fromEntity(legacy) : null;
    if (old) {
      if (old.argsHash !== argsHash)
        throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", 409);
      return {
        taskId: old.id,
        // Set in the same transaction that created the task.
        actionRequestId: old.actionRequestId as string,
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
    // An AgentWorkOrder of target "assistant" (D-05): who in
    // `requestedBy`, what in `allow`, the ceiling in its column.
    const taskId = randomUUID();
    const task = await tx.agentWorkOrder.create({
      data: {
        id: taskId,
        workspaceId: scope.workspaceId,
        projectId,
        ...TASK_ROWS,
        idempotencyKey: taskKey(scope.userId, principal.clientId, input.idempotencyKey),
        requestedBy: {
          kind: "mcp",
          userId: delegation.userId,
          clientId: delegation.clientId,
          grantId: delegation.grantId,
          scopes: delegation.scopes,
        },
        allow: { tools: [], modules: delegation.modules, mode: delegation.mode, knowledge: null },
        rootId: taskId,
        depth: 0,
        goal: input.description.slice(0, 2000),
        input: {
          description: input.description,
          idempotencyKey: input.idempotencyKey,
          argsHash,
          runId: null,
          canceledAt: null,
        },
        status: "awaiting_start",
        ceilingMicros: BigInt(ceilingMicros),
        conversationId: conversation.id,
      },
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
    await tx.agentWorkOrder.update({
      where: { id: task.id },
      data: { startRequestId: request.id },
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
    const d = await readTaskRecord(tx, scope, taskId);
    if (d.userId !== scope.userId || (clientId && d.clientId !== clientId))
      throw new DomainError("NOT_FOUND", 404);
    const visible = visibleModules(scope, await enabledModules(tx, scope));
    if (visible && d.delegation.modules.some((m: string) => !visible.has(m)))
      throw new DomainError("NOT_FOUND", 404);
    return taskSnapshot(tx, scope, d);
  });
}

async function taskSnapshot(tx: DbTx, scope: Scope, d: TaskRecord) {
  const row = d;
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
    // Null until the start approval queued the run (typed as before the fold-in).
    runId: d.runId as string,
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
    result: run?.partialText?.slice(0, CHAT_MAX_OUTPUT_CHARS) ?? null,
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
    const after = cursor
      ? {
          OR: [
            { createdAt: { lt: cursor.at } },
            { createdAt: cursor.at, id: { lt: cursor.id } },
          ],
        }
      : {};
    const legacy = await tx.entity.findMany({
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
        ...after,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const table = await tx.agentWorkOrder.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        ...TASK_ROWS,
        AND: [
          { requestedBy: { path: ["userId"], equals: scope.userId } },
          ...(input.clientId
            ? [{ requestedBy: { path: ["clientId"], equals: input.clientId } }]
            : []),
        ],
        ...after,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    // Both stores in one order: newest first, then by id.
    const rows = [...table.map(fromWorkOrder), ...legacy.map(fromEntity)]
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .slice(0, limit + 1);
    const visible = visibleModules(scope, await enabledModules(tx, scope));
    const permitted = rows
      .slice(0, limit)
      .filter(
        (row) =>
          !visible ||
          !row.delegation.modules.some((m: string) => !visible.has(m)),
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
    const d = await readTaskRecord(tx, scope, taskId);
    const row = d;
    if (d.userId !== scope.userId || (clientId && d.clientId !== clientId))
      throw new DomainError("NOT_FOUND", 404);
    if (d.canceledAt) return;
    const current = await taskSnapshot(tx, scope, d);
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
    await saveTaskRecord(tx, scope, d, { canceledAt: new Date() });
    await audit(tx, scope, "task.canceled", row.id);
  });
  return readTask(scope, taskId, clientId);
}

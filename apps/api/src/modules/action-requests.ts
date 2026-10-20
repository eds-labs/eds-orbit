import { delegatedRequester } from "../platform/tasks/delegation.ts";
import { z } from "zod";
import {
  authorize,
  PROJECT_OWN,
  PROJECT_WRITE,
} from "../platform/tenancy/permissions.ts";
import {
  authDb,
  scoped,
  type DbTx,
} from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  hash,
  list,
  listedRequester,
  update,
} from "../shared.ts";
import { activePolicyRecord } from "../platform/ai/spend-mandate.ts";
import {
  registeredActionType,
  registeredActionTypeOwner,
  registeredChannelDirectories,
} from "../platform/modules/contributions.ts";
import { moduleScope } from "../platform/tenancy/module-roles.ts";

/**
 * Generic action requests (ADR 0008), stored as Entity(kind="action_requests").
 * A request binds one exact payload by hash; a decision is single-use and is
 * consumed by the executor in the same transaction as its budget reservation.
 */
const KIND = "action_requests";
export type ActionRequestRow = Awaited<ReturnType<typeof create>>;
type Row = ActionRequestRow;

export const requestedBy = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("agent"),
      userId: z.string().min(1),
      agentRunId: z.string().nullable(),
    })
    .strict(),
  // A proposal from an MCP client (WP-M4): the client and grant it came from,
  // and the hash of its arguments, never the arguments themselves.
  z
    .object({
      kind: z.literal("mcp"),
      userId: z.string().min(1),
      clientId: z.string().min(1),
      grantId: z.string().min(1),
      agentRunId: z.string().nullable(),
      taskId: z.uuid().optional(),
      argsHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);
export type RequestedBy = z.infer<typeof requestedBy>;

export const actionDecision = z
  .object({
    version: z.number().int().positive(),
    packageHash: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(["approve", "reject"]),
    // Only read by `assignment.confirm`: consent that the assignment may use generated images.
    imageRightsConsent: z.boolean().optional(),
  })
  .strict();

export type ActionDefinition<P> = {
  riskClass: "C1" | "C2" | "W2" | "W0_internal";
  approvalMode: "approval_required";
  deciderRole: "owner" | "editor";
  /**
   * An MCP client may only propose types that set this (WP-M4); hard floors
   * and unreviewed types never do. The decision stays with the decider role.
   */
  mcpProposable?: boolean;
  mcpScopes?: readonly string[];
  ttlMs: number;
  payload: z.ZodType<P>;
  costCeilingMicros: (payload: P) => number;
  /** Rechecked at decision time; throws when the request no longer matches. */
  revalidate: (tx: DbTx, scope: Scope, payload: P) => Promise<void>;
  onApproved: (tx: DbTx, scope: Scope, request: Row) => Promise<void>;
  /** Module-owned projection of a durable result, e.g. current delivery state. */
  executionResult?: (tx: DbTx, scope: Scope, request: Row) => Promise<unknown>;
};

/**
 * Action types are code constants contributed by modules (WP1.6): no policy,
 * prompt, imported document or model output can change them.
 */
export type ActionType = string;

function definition(actionType: unknown): ActionDefinition<any> {
  const found =
    typeof actionType === "string"
      ? registeredActionType(actionType)
      : undefined;
  if (!found) throw new DomainError("ACTION_TYPE_NOT_SUPPORTED", 409);
  return found;
}

export async function createActionRequest(
  tx: DbTx,
  scope: Scope,
  input: { actionType: ActionType; payload: unknown; requestedBy: RequestedBy },
) {
  const type = definition(input.actionType);
  const requester = requestedBy.parse(
    delegatedRequester(input.payload) ?? input.requestedBy,
  );
  if (requester.kind === "mcp" && type.mcpProposable !== true)
    throw new DomainError("ACTION_TYPE_NOT_PROPOSABLE", 403);
  const payload = type.payload.parse(input.payload);
  const policy = await activePolicyRecord(tx, scope);
  if (!policy) throw new DomainError("ACTIVE_POLICY_REQUIRED", 409);
  const packageHash = hash({ actionType: input.actionType, payload });
  const row = await create(tx, scope, KIND, {
    actionType: input.actionType,
    riskClass: type.riskClass,
    approvalMode: type.approvalMode,
    policy: { id: policy.id, version: policy.version },
    requestedBy: requester,
    payload,
    packageHash,
    costCeilingMicros: type.costCeilingMicros(payload),
    status: "pending",
    expiresAt: new Date(Date.now() + type.ttlMs).toISOString(),
  });
  // Never the payload: who proposed which exact package is enough to trace it.
  if (requester.kind === "mcp")
    await audit(tx, scope, "action_request.proposed", row.id, {
      actionType: input.actionType,
      packageHash,
      clientId: requester.clientId,
      grantId: requester.grantId,
    });
  return row;
}

/** Who proposed through MCP: one user through one client (the workspace is the scope's). */
export type McpProposer = { userId: string; clientId: string };

/**
 * The newest pending, unexpired MCP proposal of this user and client for the
 * same type and arguments, so a retried call returns it instead of proposing
 * twice (D-M4-4). Matches on user and client, not on the grant id (the
 * identity rule of the cancellation), so a retry after a re-selection still
 * finds the proposal of the replaced grant; the caller checks that grant
 * still stands. Bounded: only the newest matches are inspected.
 */
export async function findPendingMcpProposal(
  tx: DbTx,
  scope: Scope,
  input: McpProposer & { actionType: string; argsHash: string; now: Date },
): Promise<Row | null> {
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: KIND,
      AND: [
        { data: { path: ["status"], equals: "pending" } },
        { data: { path: ["actionType"], equals: input.actionType } },
        { data: { path: ["requestedBy", "kind"], equals: "mcp" } },
        { data: { path: ["requestedBy", "userId"], equals: input.userId } },
        { data: { path: ["requestedBy", "clientId"], equals: input.clientId } },
        { data: { path: ["requestedBy", "argsHash"], equals: input.argsHash } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return (
    rows.find((row) => Date.parse(data(row).expiresAt) > input.now.getTime()) ??
    null
  );
}

export const MCP_ACTION_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "consumed",
  "canceled",
  "expired",
] as const;
export type McpActionStatus = (typeof MCP_ACTION_STATUSES)[number];

/**
 * What an MCP client may learn about its own proposal (WP-M4, D-M4-12):
 * type, status, times. Never the payload, hash, policy or any user id.
 * NOT_FOUND, with one body, unless the request is in this project and was
 * proposed by the same user through the same client (in this workspace; the
 * identity rule of the cancellation and the dedupe, so a re-selection that
 * replaced the grant keeps the client's own proposals visible), so a client
 * cannot probe other requests.
 * `expired` is derived: only a request that is still pending can expire; an
 * approved one has already run (the approval executes it) and stays approved.
 */
export async function mcpActionRequestStatus(
  tx: DbTx,
  scope: Scope,
  id: string,
  proposer: McpProposer,
  now: Date = new Date(),
) {
  const row = await entity(tx, scope, KIND, id);
  const d = data(row);
  if (
    d.requestedBy?.kind !== "mcp" ||
    d.requestedBy.userId !== proposer.userId ||
    d.requestedBy.clientId !== proposer.clientId
  )
    throw new DomainError("NOT_FOUND", 404);
  const stored = String(d.status) as McpActionStatus;
  const status: McpActionStatus =
    stored === "pending" && Date.parse(d.expiresAt) <= now.getTime()
      ? "expired"
      : stored;
  return {
    actionRequestId: row.id,
    actionType: String(d.actionType),
    status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: String(d.expiresAt),
    decidedAt:
      typeof d.decision?.decidedAt === "string"
        ? (d.decision.decidedAt as string)
        : null,
  };
}

/** Grants that ended by being replaced or superseded keep their authorization (see mcp-auth/grants.ts). */
const GRANT_CONTINUES = ["replaced", "superseded"];

/**
 * Whether the authorization an MCP proposal came from still allows proposing
 * in this project, for a proposal made at `since`: its grant (named by
 * `by.grantId`, of `by`'s user and client in this workspace) is active, or
 * was replaced by the active grant of the same user, client and workspace;
 * that grant has `orbit:propose` and covers the project, and its user is
 * still a member of the workspace (and of the project, unless an owner).
 * A successor never revives an old proposal: no grant of (user, client,
 * workspace) may have ended for another reason than a replacement since
 * `since` (a revocation, a denial, a client change) and proposals may not
 * have been stopped since. Used when a proposal is created (inside its
 * project transaction), for a dedupe hit, and before an approval. Bounded:
 * a fixed handful of single-row queries on the auth database.
 */
export async function mcpGrantStillProposes(
  by: McpProposer & { grantId: string },
  at: { workspaceId: string; projectId: string },
  since: Date,
  required: { module?: string; scopes?: readonly string[] } = {},
): Promise<boolean> {
  const select = {
    status: true,
    revokedBy: true,
    scopes: true,
    userId: true,
    clientId: true,
    workspaceId: true,
    projectIds: true,
    allCurrentProjects: true,
    modules: true,
    expiresAt: true,
  } as const;
  const origin = await authDb.mcpGrant.findUnique({
    where: { id: by.grantId },
    select,
  });
  if (
    !origin ||
    origin.workspaceId !== at.workspaceId ||
    origin.userId !== by.userId ||
    origin.clientId !== by.clientId
  )
    return false;
  const identity = {
    userId: origin.userId,
    clientId: origin.clientId,
    workspaceId: at.workspaceId,
  };
  let grant: typeof origin | null = origin;
  if (origin.status !== "active") {
    if (
      origin.status !== "revoked" ||
      !GRANT_CONTINUES.includes(origin.revokedBy ?? "")
    )
      return false;
    grant = await authDb.mcpGrant.findFirst({
      where: { ...identity, status: "active" },
      select,
    });
  }
  if (
    grant?.status !== "active" ||
    !grant.scopes.includes("orbit:propose") ||
    (grant.expiresAt !== null && grant.expiresAt.getTime() <= Date.now()) ||
    (required.scopes ?? []).some((s) => !grant.scopes.includes(s)) ||
    (required.module &&
      required.module !== "platform" &&
      grant.modules.length > 0 &&
      !grant.modules.includes(required.module)) ||
    !(grant.allCurrentProjects || grant.projectIds.includes(at.projectId))
  )
    return false;
  const [member, projectMember, ended, stopped] = await Promise.all([
    authDb.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: at.workspaceId,
          userId: identity.userId,
        },
      },
      select: { role: true },
    }),
    authDb.projectMember.findFirst({
      where: {
        workspaceId: at.workspaceId,
        projectId: at.projectId,
        userId: identity.userId,
      },
      select: { userId: true },
    }),
    authDb.mcpGrant.findFirst({
      where: {
        ...identity,
        status: "revoked",
        activatedAt: { not: null },
        revokedAt: { gte: since },
        revokedBy: { notIn: GRANT_CONTINUES },
      },
      select: { id: true },
    }),
    authDb.mcpGrantEvent.findFirst({
      where: {
        ...identity,
        action: "grant.proposals_disabled",
        createdAt: { gte: since },
      },
      select: { id: true },
    }),
  ]);
  if (!member || (member.role !== "owner" && !projectMember)) return false;
  return !ended && !stopped;
}

/** Records an authenticated user's decision on the exact version and hash that were shown. */
export async function decideActionRequest(
  tx: DbTx,
  member: Scope,
  id: string,
  raw: unknown,
  source:
    | { channel: "web" }
    | { channel: "mcp_setting"; inboxId: string; inboxVersion: number } = {
    channel: "web",
  },
) {
  const input = actionDecision.parse(raw);
  if (member.userId === "worker")
    throw new DomainError("DECISION_USER_REQUIRED", 403);
  const row = await entity(tx, member, KIND, id);
  const d = data(row);
  const type = definition(d.actionType);
  // The member decides, and the type's module runs, with the member's role
  // in the type's module (WP4.5): "none" is MODULE_NOT_AVAILABLE.
  const scope = moduleScope(member, registeredActionTypeOwner(d.actionType));
  if (type.deciderRole === "owner")
    authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  else authorize(scope, PROJECT_WRITE, "EDITOR_REQUIRED");
  if (d.status !== "pending") {
    // A repeated click with the same decision returns the recorded result.
    if (
      d.decision?.userId === scope.userId &&
      d.decision?.decision === input.decision &&
      d.packageHash === input.packageHash
    )
      return row;
    throw new DomainError("ACTION_REQUEST_NOT_PENDING", 409);
  }
  if (row.version !== input.version || d.packageHash !== input.packageHash)
    throw new DomainError("ACTION_REQUEST_STALE", 409);
  if (Date.parse(d.expiresAt) <= Date.now())
    throw new DomainError("ACTION_REQUEST_EXPIRED", 409);
  const approve = input.decision === "approve";
  // An approval executes: it needs the proposing grant to still stand. This
  // holds even when the cancellation at revocation did not run (D-M4-10).
  if (
    approve &&
    d.requestedBy?.kind === "mcp" &&
    !(await mcpGrantStillProposes(d.requestedBy, scope, row.createdAt, {
      module: registeredActionTypeOwner(d.actionType),
      scopes: type.mcpScopes,
    }))
  )
    throw new DomainError("MCP_GRANT_ENDED", 409);
  if (approve && d.requestedBy?.kind === "mcp" && type.mcpProposable !== true)
    throw new DomainError("ACTION_TYPE_NOT_PROPOSABLE", 403);
  if (approve) await type.revalidate(tx, scope, type.payload.parse(d.payload));
  const decided = await update(tx, scope, row, {
    ...d,
    status: approve ? "approved" : "rejected",
    decision: {
      userId: scope.userId,
      decision: input.decision,
      decidedAt: new Date().toISOString(),
      channel: source.channel,
      ...(source.channel === "mcp_setting"
        ? { inboxId: source.inboxId, inboxVersion: source.inboxVersion }
        : {}),
      ...(input.imageRightsConsent === undefined
        ? {}
        : { imageRightsConsent: input.imageRightsConsent }),
    },
  });
  await audit(
    tx,
    scope,
    approve ? "action_request.approved" : "action_request.rejected",
    row.id,
    {
      actionType: d.actionType,
      packageHash: d.packageHash,
      ...(source.channel === "mcp_setting"
        ? {
            decisionSource: source.channel,
            inboxId: source.inboxId,
            inboxVersion: source.inboxVersion,
          }
        : {}),
    },
  );
  if (approve) await type.onApproved(tx, scope, decided);
  return decided;
}

/** An approved request an execution may run; also the same execution re-entering after a crash. */
export async function executableActionRequest(
  tx: DbTx,
  scope: Scope,
  id: string,
  executionId: string,
) {
  const row = await entity(tx, scope, KIND, id);
  const d = data(row);
  if (d.status === "consumed") {
    if (d.consumedBy?.executionId === executionId) return row;
    throw new DomainError("ACTION_REQUEST_CONSUMED", 409);
  }
  if (d.status !== "approved")
    throw new DomainError("ACTION_REQUEST_NOT_APPROVED", 409);
  if (Date.parse(d.expiresAt) <= Date.now())
    throw new DomainError("ACTION_REQUEST_EXPIRED", 409);
  return row;
}

/** Uses the approval once; call it in the executor's reservation transaction. */
export async function consumeActionRequest(
  tx: DbTx,
  scope: Scope,
  id: string,
  executionId: string,
  packageHash: string,
) {
  const row = await executableActionRequest(tx, scope, id, executionId);
  const d = data(row);
  if (d.packageHash !== packageHash)
    throw new DomainError("ACTION_REQUEST_STALE", 409);
  if (d.status === "consumed") return row;
  return update(tx, scope, row, {
    ...d,
    status: "consumed",
    consumedBy: { executionId, consumedAt: new Date().toISOString() },
  });
}

/**
 * Withdraws a request before it is used; a consumed request is returned
 * unchanged. The scope's user is the actor (a member, or the platform's
 * "system"); no role is read. A `reason` (a short code) is recorded on the
 * request and its audit event, and so is `initiatedBy`, the user whose
 * action made the platform withdraw it. `pendingOnly` leaves an approved
 * request unchanged too.
 */
export async function cancelActionRequest(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId" | "userId">,
  id: string,
  reason?: string,
  options: { pendingOnly?: boolean; initiatedBy?: string | null } = {},
) {
  const row = await entity(tx, scope, KIND, id);
  const d = data(row);
  const cancelable = options.pendingOnly
    ? ["pending"]
    : ["pending", "approved"];
  if (!cancelable.includes(d.status)) return row;
  const canceled = await update(tx, scope, row, {
    ...d,
    status: "canceled",
    canceledBy: scope.userId,
    canceledAt: new Date().toISOString(),
    ...(reason ? { canceledReason: reason } : {}),
    ...(options.initiatedBy
      ? { canceledInitiatedBy: options.initiatedBy }
      : {}),
  });
  await audit(tx, scope, "action_request.canceled", row.id, {
    actionType: d.actionType,
    ...(reason ? { reason } : {}),
    ...(options.initiatedBy ? { initiatedBy: options.initiatedBy } : {}),
  });
  return canceled;
}

/** Pending requests listed per round; the sweep ends when a round finds fewer. */
const CANCEL_BATCH = 100;
const CANCEL_ROUNDS = 20;

/** The actor id of everything the platform does on its own (also mcp-auth/grants.ts). */
export const SYSTEM_ACTOR_ID = "system";

/** Why the platform withdrew MCP proposals (D-M4-10, D-M5-8). */
export type McpCancellationReason =
  "mcp_grant_ended" | "mcp_proposals_stopped" | "mcp_client_changed";

/**
 * Who withdraws MCP proposals (D-M5-8): the platform, never a member, so no
 * role is assumed. `initiatedBy` names the user whose grant change caused
 * it (the grant's user or an owner), null when the platform did it alone
 * (a client change).
 */
export type McpCancellationActor = {
  kind: "system";
  reason: McpCancellationReason;
  initiatedBy: string | null;
};

/**
 * Cancels the PENDING proposals an MCP client made for one user in this
 * project (WP-M4, D-M4-10): used when the user's grant for the client is
 * revoked, stops proposing or its client changed. Matches on user and
 * client, not on the grant id, so proposals of an earlier grant that was
 * replaced go too. Approved requests are not touched: their approval
 * already ran.
 *
 * Each request is canceled in its own project transaction (`scoped()`,
 * which holds the project lock a decision holds too, so an approval cannot
 * land in the middle of one, and `pendingOnly` keeps an approval that came
 * first): a failure of one is handed to `onFailure` and the sweep goes on
 * with the others (D-M5-8). A request left pending that way stays
 * unapprovable, because an approval re-checks the grant
 * (`mcpGrantStillProposes`). The listing itself failing throws. Returns the
 * numbers canceled and failed.
 */
export async function cancelMcpProposals(
  project: { workspaceId: string; projectId: string },
  proposer: { userId: string; clientId: string },
  actor: McpCancellationActor,
  onFailure: (actionRequestId: string, error: unknown) => void,
): Promise<{ canceled: number; failed: number }> {
  const scope = { ...project, userId: SYSTEM_ACTOR_ID };
  const failed: string[] = [];
  let canceled = 0;
  for (let round = 0; round < CANCEL_ROUNDS; round += 1) {
    const rows = await scoped(project.workspaceId, project.projectId, (tx) =>
      tx.entity.findMany({
        where: {
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          kind: KIND,
          // A request that failed once is not tried again in this sweep.
          ...(failed.length ? { id: { notIn: failed } } : {}),
          AND: [
            { data: { path: ["status"], equals: "pending" } },
            { data: { path: ["requestedBy", "kind"], equals: "mcp" } },
            {
              data: {
                path: ["requestedBy", "userId"],
                equals: proposer.userId,
              },
            },
            {
              data: {
                path: ["requestedBy", "clientId"],
                equals: proposer.clientId,
              },
            },
          ],
        },
        orderBy: { createdAt: "asc" },
        select: { id: true },
        take: CANCEL_BATCH,
      }),
    );
    for (const { id } of rows) {
      try {
        await scoped(project.workspaceId, project.projectId, (tx) =>
          cancelActionRequest(tx, scope, id, actor.reason, {
            pendingOnly: true,
            initiatedBy: actor.initiatedBy,
          }),
        );
        canceled += 1;
      } catch (error) {
        failed.push(id);
        onFailure(id, error);
      }
    }
    if (rows.length < CANCEL_BATCH) break;
  }
  return { canceled, failed: failed.length };
}

/** The trimmed requester of the inbox list (platform/shared.ts). */
export { listedRequester };

/**
 * Owners' open decisions as rows: pending, unexpired requests whose action
 * type needs an owner, newest first, among the 50 newest pending ones. The
 * owner's list and the attention item count the same rows.
 */
export async function openOwnerRequests(
  tx: DbTx,
  scope: Scope,
  now = new Date(),
) {
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: KIND,
      data: { path: ["status"], equals: "pending" },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.filter((row) => {
    const d = data(row);
    const type = registeredActionType(String(d.actionType));
    // As the list always read it: only a known past expiry drops a request.
    return (
      type?.deciderRole === "owner" &&
      !(Date.parse(d.expiresAt) <= now.getTime())
    );
  });
}

/**
 * Owners' open decisions (`openOwnerRequests`) with what the owner must see
 * to decide.
 */
export async function listActionRequests(tx: DbTx, scope: Scope) {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const rows = await openOwnerRequests(tx, scope);
  // A decision names the channel as the owner knows it, not by its ID.
  const channels = new Map<string, Record<string, unknown>>(
    (
      await Promise.all(
        registeredChannelDirectories().map((directory) => directory(tx, scope)),
      )
    )
      .flat()
      .map((channel: any) => [channel.id, channel]),
  );
  const items = [];
  for (const row of rows) {
    const d = data(row);
    const packageId =
      typeof d.payload?.packageId === "string"
        ? d.payload.packageId
        : String(d.payload?.budgetRunKey ?? "").startsWith("package:")
          ? String(d.payload.budgetRunKey).slice("package:".length)
          : null;
    const pkg = packageId
      ? await tx.entity.findFirst({
          where: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            kind: "content_packages",
            id: packageId,
          },
        })
      : null;
    items.push({
      id: row.id,
      version: row.version,
      actionType: d.actionType,
      riskClass: d.riskClass,
      packageHash: d.packageHash,
      costCeilingMicros: d.costCeilingMicros,
      expiresAt: d.expiresAt,
      createdAt: row.createdAt,
      requestedBy: listedRequester(d.requestedBy),
      summary: {
        ...(d.actionType === "platform.task.start"
          ? {
              task: await tx.entity
                .findFirst({
                  where: {
                    id: d.payload.taskId,
                    projectId: scope.projectId,
                    kind: "orbit_tasks",
                  },
                  select: { data: true },
                })
                .then((t) =>
                  t
                    ? {
                        description: data(t).description,
                        mode: data(t).delegation.mode,
                        modules: data(t).delegation.modules,
                      }
                    : null,
                ),
            }
          : {}),
        ...(String(d.actionType).includes(".mcp.")
          ? {
              operation: {
                ...d.payload.args,
                ...(d.payload.approvalContext === undefined
                  ? {}
                  : { approvalContext: d.payload.approvalContext }),
              },
            }
          : {}),
        prompt: d.payload?.prompt,
        model: d.payload?.model,
        maxCostMicros: d.payload?.maxCostMicros,
        size: d.payload?.size,
        quality: d.payload?.quality,
        channel: d.payload?.channel,
        channelName: channels.get(d.payload?.channel)?.name ?? null,
        channelPlatform: channels.get(d.payload?.channel)?.identifier ?? null,
        scheduledAt: d.payload?.scheduledAt,
        body: d.payload?.body,
        executionMode: d.payload?.executionMode,
        assetId: d.payload?.assetId,
        packageGoal: pkg ? data(pkg).goal : null,
        // The exact assignment the owner confirms, with its channels by name.
        ...(d.actionType === "assignment.confirm"
          ? {
              assignment: {
                id: d.payload.assignmentId,
                name: d.payload.name,
                kind: d.payload.kind,
                schedule: d.payload.schedule,
                contentType: d.payload.contentType,
                channels: d.payload.channels,
                channelNames: Object.fromEntries(
                  ((d.payload.channels ?? []) as string[])
                    .filter((id) => channels.has(id))
                    .map((id) => [id, channels.get(id)!.name]),
                ),
                topicFrame: d.payload.topicFrame,
                ...(d.payload.tone ? { tone: d.payload.tone } : {}),
                image: d.payload.image,
                styleAssetIds: d.payload.styleAssetIds,
                vetoMinutes: d.payload.vetoMinutes,
                approvalMode: d.payload.approvalMode ?? "delegated_review",
                monthlyBudgetMicros: d.payload.monthlyBudgetMicros,
                // Absent in the payload means "publish" (R73).
                delivery:
                  d.payload.delivery === "postiz_draft"
                    ? "postiz_draft"
                    : "publish",
              },
            }
          : {}),
      },
    });
  }
  return items;
}

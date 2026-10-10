import { z } from "zod";
import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  hash,
  list,
  update,
} from "../shared.ts";
import { assignedPostizChannels } from "./postiz-assignment.ts";
import { activePolicy } from "./policy.ts";
import { enqueue } from "./workflow.ts";
import { currentImageTerms, imageRequestPayload } from "./image-generation.ts";

/**
 * Generic action requests (ADR 0008), stored as Entity(kind="action_requests").
 * A request binds one exact payload by hash; a decision is single-use and is
 * consumed by the executor in the same transaction as its budget reservation.
 */
const KIND = "action_requests";
type Row = Awaited<ReturnType<typeof create>>;

export const requestedBy = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("agent"),
      userId: z.string().min(1),
      agentRunId: z.string().nullable(),
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

type ActionDefinition<P> = {
  riskClass: "C1" | "C2" | "W2" | "W0_internal";
  approvalMode: "approval_required";
  deciderRole: "owner" | "editor";
  ttlMs: number;
  payload: z.ZodType<P>;
  costCeilingMicros: (payload: P) => number;
  /** Rechecked at decision time; throws when the request no longer matches. */
  revalidate: (tx: DbTx, scope: Scope, payload: P) => Promise<void>;
  onApproved: (tx: DbTx, scope: Scope, request: Row) => Promise<void>;
};

// Code constants: no policy, prompt, imported document or model output can change them.
const imageGenerate: ActionDefinition<z.infer<typeof imageRequestPayload>> = {
  riskClass: "C2",
  approvalMode: "approval_required",
  deciderRole: "owner",
  ttlMs: 24 * 3600000,
  payload: imageRequestPayload,
  costCeilingMicros: (payload) => payload.maxCostMicros,
  async revalidate(tx, scope, payload) {
    const { imageConfig } = await currentImageTerms(tx, scope);
    if (
      imageConfig.model !== payload.model ||
      imageConfig.maxCostMicrosPerImage !== payload.maxCostMicros
    )
      throw new DomainError("IMAGE_REQUEST_STALE", 409);
  },
  async onApproved(tx, scope, request) {
    const job = await enqueue(
      tx,
      scope,
      "image",
      request.id,
      "action:" + request.id,
    );
    // One paid attempt: an unclear provider outcome is never retried.
    await update(tx, scope, job, { ...data(job), maxAttempts: 1 });
  },
};
// Paid drafts inside the mandate; the user confirms the exact package plan once.
const contentPackageStart: ActionDefinition<Record<string, unknown>> = {
  riskClass: "C1",
  approvalMode: "approval_required",
  deciderRole: "editor",
  ttlMs: 24 * 3600000,
  payload: z.record(z.string(), z.unknown()),
  costCeilingMicros: (payload) => Number(payload.ceilingMicros),
  // Loaded on use: the package module itself builds on action requests.
  async revalidate(tx, scope, payload) {
    const packages = await import("./agents/content-packages.ts");
    await packages.revalidateContentPackage(tx, scope, payload);
  },
  async onApproved(tx, scope, request) {
    const packages = await import("./agents/content-packages.ts");
    await packages.startContentPackage(tx, scope, request);
  },
};
// A public post at a fixed slot: an owner decides the exact post (ADR 0008, J3.1).
const contentSchedule: ActionDefinition<Record<string, unknown>> = {
  riskClass: "W2",
  approvalMode: "approval_required",
  deciderRole: "owner",
  ttlMs: 24 * 3600000,
  payload: z.record(z.string(), z.unknown()),
  costCeilingMicros: () => 0,
  async revalidate(tx, scope, payload) {
    const schedule = await import("./agents/package-schedule.ts");
    await schedule.revalidateSchedule(
      tx,
      scope,
      schedule.scheduleRequestPayload.parse(payload),
    );
  },
  async onApproved(tx, scope, request) {
    const schedule = await import("./agents/package-schedule.ts");
    await schedule.executeSchedule(tx, scope, request);
  },
};
// An internal change without public effect: the owner confirms an assignment's exact content.
const assignmentConfirm: ActionDefinition<Record<string, unknown>> = {
  riskClass: "W0_internal",
  approvalMode: "approval_required",
  deciderRole: "owner",
  ttlMs: 7 * 24 * 3600000,
  payload: z.record(z.string(), z.unknown()),
  costCeilingMicros: () => 0,
  async revalidate(tx, scope, payload) {
    const assignments = await import("./agents/assignments.ts");
    await assignments.revalidateAssignmentConfirm(tx, scope, payload);
  },
  async onApproved(tx, scope, request) {
    const assignments = await import("./agents/assignments.ts");
    await assignments.executeAssignmentConfirm(tx, scope, request);
  },
};
const actionTypes = {
  "image.generate": imageGenerate,
  "content_package.start": contentPackageStart,
  "content.schedule": contentSchedule,
  "assignment.confirm": assignmentConfirm,
} as const;
export type ActionType = keyof typeof actionTypes;

function definition(actionType: unknown): ActionDefinition<any> {
  const found = actionTypes[actionType as ActionType];
  if (!found) throw new DomainError("ACTION_TYPE_NOT_SUPPORTED", 409);
  return found;
}

export async function createActionRequest(
  tx: DbTx,
  scope: Scope,
  input: { actionType: ActionType; payload: unknown; requestedBy: RequestedBy },
) {
  const type = definition(input.actionType);
  const payload = type.payload.parse(input.payload);
  const policy = await activePolicy(tx, scope);
  if (!policy) throw new DomainError("ACTIVE_POLICY_REQUIRED", 409);
  return create(tx, scope, KIND, {
    actionType: input.actionType,
    riskClass: type.riskClass,
    approvalMode: type.approvalMode,
    policy: { id: policy.id, version: policy.version },
    requestedBy: requestedBy.parse(input.requestedBy),
    payload,
    packageHash: hash({ actionType: input.actionType, payload }),
    costCeilingMicros: type.costCeilingMicros(payload),
    status: "pending",
    expiresAt: new Date(Date.now() + type.ttlMs).toISOString(),
  });
}

/** Records an authenticated user's decision on the exact version and hash that were shown. */
export async function decideActionRequest(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
) {
  const input = actionDecision.parse(raw);
  if (scope.userId === "worker")
    throw new DomainError("DECISION_USER_REQUIRED", 403);
  const row = await entity(tx, scope, KIND, id);
  const d = data(row);
  const type = definition(d.actionType);
  if (type.deciderRole === "owner" && scope.role !== "owner")
    throw new DomainError("OWNER_REQUIRED", 403);
  if (type.deciderRole === "editor" && scope.role === "viewer")
    throw new DomainError("EDITOR_REQUIRED", 403);
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
  if (approve) await type.revalidate(tx, scope, type.payload.parse(d.payload));
  const decided = await update(tx, scope, row, {
    ...d,
    status: approve ? "approved" : "rejected",
    decision: {
      userId: scope.userId,
      decision: input.decision,
      decidedAt: new Date().toISOString(),
      channel: "web",
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
    { actionType: d.actionType, packageHash: d.packageHash },
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

/** Withdraws a request before it is used; a consumed request is returned unchanged. */
export async function cancelActionRequest(tx: DbTx, scope: Scope, id: string) {
  const row = await entity(tx, scope, KIND, id);
  const d = data(row);
  if (!["pending", "approved"].includes(d.status)) return row;
  const canceled = await update(tx, scope, row, {
    ...d,
    status: "canceled",
    canceledBy: scope.userId,
    canceledAt: new Date().toISOString(),
  });
  await audit(tx, scope, "action_request.canceled", row.id, {
    actionType: d.actionType,
  });
  return canceled;
}

/**
 * Owners' open decisions: pending, unexpired requests whose action type needs
 * an owner, newest first, with what the owner must see to decide.
 */
export async function listActionRequests(tx: DbTx, scope: Scope) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
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
  // A decision names the channel as the owner knows it, not by its ID.
  const channels = new Map<string, Record<string, unknown>>(
    (await list(tx, scope, "connectors"))
      .filter((row) => data(row).provider === "postiz")
      .flatMap((row) => assignedPostizChannels(data(row)))
      .map((channel: any) => [channel.id, channel]),
  );
  const items = [];
  for (const row of rows) {
    const d = data(row);
    const type = actionTypes[d.actionType as ActionType];
    if (!type || type.deciderRole !== "owner") continue;
    if (Date.parse(d.expiresAt) <= Date.now()) continue;
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
      requestedBy: d.requestedBy,
      summary: {
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

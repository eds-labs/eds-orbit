import { z } from "zod";
import { marketingPlanSpec } from "../../../../../../packages/schemas/src/index.ts";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  data,
  entity,
  update,
  hash,
  DomainError,
  audit,
  list,
} from "../../../shared.ts";
import {
  authorize,
  PROJECT_OWN,
} from "../../../platform/tenancy/permissions.ts";
import { moduleScope } from "../../../platform/tenancy/module-roles.ts";
import { actorScope } from "../../../platform/tenancy/member-scope.ts";
import {
  createActionRequest,
  cancelActionRequest,
} from "../../action-requests.ts";
import {
  assignmentInput,
  assignmentHash,
  assertWithinMandate,
  stagePlanAssignment,
  confirmAssignment,
  committedBudget,
} from "../agents/assignments.ts";
import { planAccess, validateSaved, planView } from "./service.ts";
import { pausePlanInTx } from "./lifecycle.ts";
const ref = z
  .object({ id: z.uuid(), version: z.number().int().positive() })
  .strict();
export const activationInput = z
  .object({
    version: z.number().int().positive(),
    children: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z0-9_-]{1,60}$/),
            assignment: assignmentInput,
            existing: ref.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict();
export const activationPayload = activationInput
  .extend({
    planId: z.uuid(),
    revision: z.number().int().positive(),
    specHash: z.string(),
    assets: z.array(ref).max(5),
    spec: marketingPlanSpec,
    sourceSnapshot: z.array(ref).max(40),
  })
  .strict();
export type ActivationPayload = z.infer<typeof activationPayload>;

async function owner(tx: DbTx, scope: Scope) {
  await planAccess(tx, scope, true);
  authorize(moduleScope(scope, "marketing"), PROJECT_OWN, "OWNER_REQUIRED");
  const current = await actorScope(
    scope.workspaceId,
    scope.projectId,
    scope.userId,
  );
  if (!current || moduleScope(current, "marketing").role !== "owner")
    throw new DomainError("OWNER_REQUIRED", 403);
}
async function validate(
  tx: DbTx,
  scope: Scope,
  p: ActivationPayload,
  pending = true,
) {
  await planAccess(tx, scope, true);
  const row = await entity(tx, scope, "marketing_plans", p.planId),
    d = data(row);
  if (
    d.revision !== p.revision ||
    d.specHash !== p.specHash ||
    d.status === "active"
  )
    throw new DomainError("PLAN_REVISION_STALE", 409);
  // The request is added to the Entity after its version was captured.
  if (row.version !== p.version + (pending ? 1 : 0))
    throw new DomainError("PLAN_REVISION_STALE", 409);
  if (
    hash(d.spec) !== hash(p.spec) ||
    hash(d.sources) !== hash(p.sourceSnapshot)
  )
    throw new DomainError("PLAN_REVISION_STALE", 409);
  await validateSaved(tx, scope, row, Boolean(d.activation));
  const reviewer =
    d.review &&
    (await actorScope(scope.workspaceId, scope.projectId, d.review.userId));
  if (
    !reviewer ||
    moduleScope(reviewer, "marketing").role !== "owner" ||
    d.review.specHash !== d.specHash
  )
    throw new DomainError("PLAN_STRATEGIC_REVIEW_REQUIRED", 409);
  const spec = d.spec;
  if (
    new Set(p.children.map((c) => c.key)).size !== p.children.length ||
    new Set(p.children.filter((c) => c.existing).map((c) => c.existing!.id))
      .size !== p.children.filter((c) => c.existing).length
  )
    throw new DomainError("PLAN_DUPLICATE_CHILD", 409);
  const adopted = p.children.flatMap((c) =>
    c.existing ? [c.existing.id] : [],
  );
  for (const ref of spec.existingWork) {
    if (ref.proposedChange.trim() && !adopted.includes(ref.id))
      throw new DomainError("PLAN_WORK_DELTA_REQUIRED", 409);
  }
  // Every cadence/content/channel tuple may be prepared once within this child set.
  const tuples = new Set<string>();
  for (const child of p.children) {
    const a = child.assignment;
    if (
      a.kind !== "standing" ||
      a.schedule.rhythm !== spec.cadence.rhythm ||
      hash([...a.schedule.weekdays].sort()) !==
        hash([...spec.cadence.weekdays].sort()) ||
      hash([...a.schedule.times].sort()) !==
        hash([...spec.cadence.times].sort()) ||
      a.channels.some((id) => !spec.channels.includes(id)) ||
      !spec.contentTypes.includes(a.contentType) ||
      a.approvalMode !== spec.approvalMode ||
      (a.delivery ?? "publish") !== spec.delivery ||
      (a.format?.cta !== undefined && a.format.cta !== spec.cta.url) ||
      a.image !== spec.creative.image ||
      hash([...a.styleAssetIds].sort()) !==
        hash([...spec.creative.styleAssetIds].sort())
    )
      throw new DomainError("PLAN_CHILD_EXCEEDS_ENVELOPE", 409);
    for (const channel of a.channels) {
      const tuple = `${channel}:${a.contentType}`;
      if (tuples.has(tuple)) throw new DomainError("PLAN_DUPLICATE_CHILD", 409);
      tuples.add(tuple);
    }
    if (child.existing) {
      const link = spec.existingWork.find(
        (r: any) => r.kind === "assignments" && r.id === child.existing!.id,
      );
      const previousOwned = d.activation?.children?.some(
        (c: any) => c.id === child.existing!.id,
      );
      if (!link && !previousOwned)
        throw new DomainError("PLAN_WORK_LINK_REQUIRED", 409);
      if (link && !previousOwned && link.version !== child.existing.version)
        throw new DomainError("PLAN_WORK_STALE", 409);
      const work = await entity(tx, scope, "assignments", child.existing.id);
      if (work.version !== child.existing.version)
        throw new DomainError("PLAN_WORK_STALE", 409);
      const otherPlan = data(work).marketingPlan;
      if (otherPlan && otherPlan.planId !== p.planId)
        throw new DomainError("PLAN_CHILD_ALREADY_OWNED", 409);
    }
    await assertWithinMandate(
      tx,
      scope,
      a,
      child.existing?.id ?? null,
      adopted,
    );
  }
  const independentBudget = (await list(tx, scope, "assignments"))
    .filter(
      (r) =>
        spec.existingWork.some((ref: any) => ref.id === r.id) &&
        !adopted.includes(r.id) &&
        ["active", "paused", "budget_exhausted"].includes(data(r).status),
    )
    .reduce((sum, r) => sum + Number(data(r).monthlyBudgetMicros ?? 0), 0);
  const total = p.children.reduce(
    (sum, c) => sum + c.assignment.monthlyBudgetMicros,
    independentBudget,
  );
  if (total > spec.monthlyBudgetMicros)
    throw new DomainError("PLAN_CHILD_BUDGET_EXCEEDED", 409);
  // Validate the combined replacement, not each child against an empty ledger.
  const oldBudget = (await list(tx, scope, "assignments"))
    .filter(
      (r) =>
        adopted.includes(r.id) &&
        ["active", "paused", "budget_exhausted"].includes(data(r).status),
    )
    .reduce((sum, r) => sum + Number(data(r).monthlyBudgetMicros ?? 0), 0);
  const policy = await entity(tx, scope, "policies", spec.policy.id);
  if (
    (await committedBudget(tx, scope, null)) -
      oldBudget +
      total -
      independentBudget >
    Number(data(policy).monthlyBudgetMicros)
  )
    throw new DomainError("ASSIGNMENT_BUDGET_EXCEEDS_PROJECT", 409);
  const assets = await Promise.all(
    spec.creative.styleAssetIds.map(async (id: string) => {
      const asset = await entity(tx, scope, "assets", id);
      return { id, version: asset.version };
    }),
  );
  if (hash(assets) !== hash(p.assets))
    throw new DomainError("PLAN_ASSET_VERSION_STALE", 409);
  return row;
}
export async function proposeActivation(
  tx: DbTx,
  scope: Scope,
  id: string,
  raw: unknown,
) {
  await planAccess(tx, scope, true);
  const input = activationInput.parse(raw);
  let row = await entity(tx, scope, "marketing_plans", id),
    d = data(row);
  const assets = await Promise.all(
    d.spec.creative.styleAssetIds.map(async (id: string) => {
      const asset = await entity(tx, scope, "assets", id);
      return { id, version: asset.version };
    }),
  );
  // Retried exact proposal returns its existing request, including stale input version.
  if (d.activationRequestId) {
    const request = await entity(
        tx,
        scope,
        "action_requests",
        d.activationRequestId,
      ),
      r = data(request);
    if (
      r.status === "pending" &&
      Date.parse(r.expiresAt) > Date.now() &&
      hash(r.payload.children) === hash(input.children) &&
      hash(r.payload.assets) === hash(assets) &&
      [row.version, r.payload.version].includes(input.version)
    )
      return planView(tx, scope, id);
  }
  if (row.version !== input.version)
    throw new DomainError("VERSION_CONFLICT", 409);
  const payload = activationPayload.parse({
    ...input,
    planId: id,
    revision: d.revision,
    specHash: d.specHash,
    assets,
    spec: d.spec,
    sourceSnapshot: d.sources,
  });
  // Same validation before storing; the pending request changes the plan version once.
  await validate(tx, scope, payload, false);
  if (d.activationRequestId)
    await cancelActionRequest(
      tx,
      scope,
      d.activationRequestId,
      "PLAN_ACTIVATION_REVISED",
    );
  const request = await createActionRequest(tx, scope, {
    actionType: "marketing_plan.activate",
    payload,
    requestedBy: { kind: "agent", userId: scope.userId, agentRunId: null },
  });
  row = await update(tx, scope, row, { ...d, activationRequestId: request.id });
  await audit(tx, scope, "marketing_plan.activation_proposed", id, {
    revision: d.revision,
    requestId: request.id,
    childCount: input.children.length,
  });
  return planView(tx, scope, id);
}
export async function revalidateActivation(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
) {
  await validate(tx, scope, activationPayload.parse(raw));
}
export async function activatePlan(
  tx: DbTx,
  scope: Scope,
  request: { id: string; data: unknown },
) {
  await owner(tx, scope);
  const p = activationPayload.parse(data(request).payload),
    row = await validate(tx, scope, p),
    d = data(row);
  if (d.activationRequestId !== request.id)
    throw new DomainError("PLAN_REVISION_STALE", 409);
  const consent = data(request).decision?.imageRightsConsent === true;
  if (p.children.some((c) => c.assignment.image) && !consent)
    throw new DomainError("IMAGE_RIGHTS_CONSENT_REQUIRED", 409);
  if (
    d.activation?.children.some(
      (c: any) => !p.children.some((child) => child.existing?.id === c.id),
    )
  )
    throw new DomainError("PLAN_OWNED_CHILD_REQUIRED", 409);
  const origin = {
    planId: p.planId,
    revision: p.revision,
    specHash: p.specHash,
    requestId: request.id,
  };
  const staged = [];
  for (const c of p.children)
    staged.push({
      key: c.key,
      row: await stagePlanAssignment(tx, scope, c.assignment, c.existing, {
        ...origin,
        childKey: c.key,
      }),
    });
  const children = [];
  for (const c of staged) {
    const confirmed = await confirmAssignment(
      tx,
      scope,
      c.row.id,
      c.row.version,
      consent,
    );
    children.push({
      key: c.key,
      id: confirmed.id,
      version: confirmed.version,
      assignmentHash: assignmentHash(data(confirmed)),
    });
  }
  await update(tx, scope, row, {
    ...d,
    status: "active",
    activation: {
      ...origin,
      userId: scope.userId,
      at: new Date().toISOString(),
      assets: p.assets,
      children,
    },
  });
  await audit(tx, scope, "marketing_plan.activated", row.id, {
    revision: p.revision,
    requestId: request.id,
    childIds: children.map((c) => c.id),
  });
}
export async function pausePlan(
  tx: DbTx,
  scope: Scope,
  id: string,
  version: number,
) {
  await planAccess(tx, scope, true);
  await pausePlanInTx(tx, scope, id, version);
  return planView(tx, scope, id);
}

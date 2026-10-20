import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data, entity, DomainError, hash } from "../../../shared.ts";
import { actorScope } from "../../../platform/tenancy/member-scope.ts";
import { moduleScope } from "../../../platform/tenancy/module-roles.ts";
import { assignmentHash } from "../agents/assignments.ts";
import { planAccess, validateSaved } from "./service.ts";
/** Missing origin is legacy independent work. A present origin always fails
 * closed; current plan authority is required at every new execution boundary. */
export async function ownedPlanRefusal(
  tx: DbTx,
  scope: Scope,
  assignment: Record<string, any>,
  now = new Date(),
  scheduledAt?: Date,
): Promise<string | null> {
  if (!assignment.marketingPlan) return null;
  try {
    const origin = assignment.marketingPlan;
    const row = await entity(tx, scope, "marketing_plans", origin.planId),
      d = data(row);
    if (
      d.status !== "active" ||
      d.revision !== origin.revision ||
      d.specHash !== origin.specHash ||
      d.activation?.requestId !== origin.requestId
    )
      return "PLAN_NOT_ACTIVE";
    if (
      now.valueOf() < Date.parse(d.spec.horizon.startAt) ||
      now.valueOf() >= Date.parse(d.spec.horizon.endAt) ||
      (scheduledAt !== undefined &&
        (scheduledAt.valueOf() < Date.parse(d.spec.horizon.startAt) ||
          scheduledAt.valueOf() >= Date.parse(d.spec.horizon.endAt)))
    )
      return "PLAN_OUTSIDE_HORIZON";
    const current = await actorScope(
      scope.workspaceId,
      scope.projectId,
      d.activation.userId,
    );
    if (!current || moduleScope(current, "marketing").role !== "owner")
      return "PLAN_OWNER_REVOKED";
    const reviewer =
      d.review &&
      (await actorScope(scope.workspaceId, scope.projectId, d.review.userId));
    if (!reviewer || moduleScope(reviewer, "marketing").role !== "owner")
      return "PLAN_REVIEWER_NO_LONGER_OWNER";
    await planAccess(tx, current);
    await validateSaved(tx, current, row, true);
    if (
      !d.activation.children.some(
        (c: any) =>
          c.key === origin.childKey &&
          c.assignmentHash === assignmentHash(assignment),
      )
    )
      return "PLAN_CHILD_CHANGED";
    const assets = await Promise.all(
      d.spec.creative.styleAssetIds.map(async (id: string) => {
        const asset = await entity(tx, scope, "assets", id);
        return { id, version: asset.version };
      }),
    );
    if (hash(assets) !== hash(d.activation.assets))
      return "PLAN_ASSET_VERSION_STALE";
    return null;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return error.code === "NOT_FOUND"
      ? "PLAN_REFERENCE_UNAVAILABLE"
      : error.code;
  }
}

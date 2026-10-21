import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data, entity, DomainError, create, update } from "../../../shared.ts";
const WAITING = ["draft", "needs_review", "reviewed", "blocked_dependency"];
export const REVIEW_BACKLOG_FULL = "ASSIGNMENT_REVIEW_BACKLOG_FULL";
/** Slots of admitted runs reserve review capacity too. Otherwise two workers
 * could both see an empty inbox and pay to exceed the owner's bound. */
export async function reviewBacklog(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
  currentRunId?: string,
) {
  const assignment = data(await entity(tx, scope, "assignments", assignmentId));
  const limit = Number.isInteger(assignment.pendingReviewLimit)
    ? Number(assignment.pendingReviewLimit)
    : null;
  if (limit === null)
    return {
      limit: null,
      pending: 0,
      held: 0,
      available: null,
      blocked: false,
    };
  const where = {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    data: { path: ["assignmentId"], equals: assignmentId },
  };
  const [contents, runs] = await Promise.all([
    tx.entity.findMany({ where: { ...where, kind: "content" }, take: 1001 }),
    tx.entity.findMany({
      where: { ...where, kind: "assignment_runs" },
      take: 1001,
    }),
  ]);
  if (contents.length > 1000 || runs.length > 1000)
    return { limit, pending: limit, held: 0, available: 0, blocked: true };
  const outputs = contents.length
    ? await tx.entity.findMany({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: { in: ["publications", "postiz_drafts"] },
          data: { path: ["assignmentId"], equals: assignmentId },
        },
        take: 1001,
      })
    : [];
  if (outputs.length > 1000)
    return { limit, pending: limit, held: 0, available: 0, blocked: true };
  const handedOff = new Set(
    outputs
      .filter(
        (r) => !["canceled", "failed", "withdrawn"].includes(data(r).status),
      )
      .map((r) => data(r).contentId),
  );
  const pending = contents.filter(
    (r) =>
      (!currentRunId || data(r).assignmentRunId !== currentRunId) &&
      !data(r).supersededBy &&
      !handedOff.has(r.id) &&
      WAITING.includes(data(r).status),
  ).length;
  let held = 0;
  for (const r of runs) {
    const d = data(r);
    if (r.id === currentRunId || !["planned", "running"].includes(d.status))
      continue;
    // Revisions do not produce another occupied slot. Counting both versions
    // would incorrectly free admission capacity for a still-unwritten slot.
    const made = new Set(
      contents
        .filter((c) => data(c).assignmentRunId === r.id)
        .map(
          (c) =>
            data(c).briefKey ??
            (data(c).scheduledAt
              ? `${data(c).channel}@${data(c).scheduledAt}`
              : c.id),
        ),
    ).size;
    held += Math.max(0, (d.slots?.length ?? 0) - made);
  }
  const available = Math.max(0, limit - pending - held);
  const nextRunSize = Math.max(
    1,
    (assignment.channels?.length ?? 1) *
      (assignment.schedule?.times?.length ?? 1),
  );
  return { limit, pending, held, available, blocked: available < nextRunSize };
}
export async function assertReviewCapacity(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
  currentRunId?: string,
) {
  const state = await reviewBacklog(tx, scope, assignmentId, currentRunId);
  if (state.limit === null) return;
  const owned = currentRunId
    ? (data(await entity(tx, scope, "assignment_runs", currentRunId)).slots
        ?.length ?? 0)
    : 1;
  if ((state.available ?? 0) < Math.max(1, owned))
    throw new DomainError(REVIEW_BACKLOG_FULL, 409);
}
/** Persistent native blocker; deduped while full and cleared after capacity
 * returns. Does not require Telegram and creates no paid work. */
export async function recordBacklogBlocker(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
  full: boolean,
) {
  const row = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "exceptions",
      AND: [
        { data: { path: ["code"], equals: REVIEW_BACKLOG_FULL } },
        { data: { path: ["resourceId"], equals: assignmentId } },
      ],
    },
    orderBy: { createdAt: "desc" },
  });
  if (row) {
    if (data(row).status !== (full ? "open" : "resolved"))
      await update(tx, scope, row, {
        ...data(row),
        status: full ? "open" : "resolved",
      });
  } else if (full)
    await create(tx, scope, "exceptions", {
      code: REVIEW_BACKLOG_FULL,
      resourceId: assignmentId,
      resourceIds: [assignmentId],
      status: "open",
    });
}

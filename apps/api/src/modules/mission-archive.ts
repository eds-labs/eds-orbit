import { z } from "zod";
import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { audit, data, DomainError, entity, list, update } from "../shared.ts";

export const missionArchiveInput = z
  .object({
    missionId: z.uuid(),
    version: z.number().int().positive(),
    archived: z.boolean(),
  })
  .strict();

/**
 * Archiving hides a mission and stops the sweep from planning it; jobs,
 * content, costs and evidence stay untouched. Restoring returns the
 * previous status, so a restored ready mission can be planned again.
 */
export async function archiveMission(tx: DbTx, scope: Scope, raw: unknown) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const input = missionArchiveInput.parse(raw);
  await tx.$queryRaw`SELECT id FROM "Entity" WHERE id=${input.missionId}::uuid AND "projectId"=${scope.projectId}::uuid FOR UPDATE`;
  const row = await entity(tx, scope, "missions", input.missionId);
  if (row.version !== input.version)
    throw new DomainError("VERSION_CONFLICT", 409);
  const m = data(row);
  if (input.archived) {
    if (m.status === "archived") return row;
    const active = (await list(tx, scope, "jobs")).some(
      (job) =>
        data(job).resourceId === row.id &&
        ["queued", "running", "retry_scheduled"].includes(data(job).status),
    );
    if (active) throw new DomainError("MISSION_RUN_IN_PROGRESS", 409);
    return markMissionArchived(tx, scope, row);
  }
  if (m.status !== "archived") return row;
  const { statusBeforeArchive, archivedAt, archivedBy, ...rest } = m;
  const restored = await update(tx, scope, row, {
    ...rest,
    status: statusBeforeArchive ?? "completed",
  });
  await audit(tx, scope, "mission.restored", row.id, {});
  return restored;
}

/** Archives one mission row; callers check role and running jobs first. */
export async function markMissionArchived(
  tx: DbTx,
  scope: Scope,
  row: Awaited<ReturnType<typeof entity>>,
) {
  const m = data(row);
  const archived = await update(tx, scope, row, {
    ...m,
    status: "archived",
    statusBeforeArchive: m.status,
    archivedAt: new Date().toISOString(),
    archivedBy: scope.userId,
  });
  await audit(tx, scope, "mission.archived", row.id, {});
  return archived;
}

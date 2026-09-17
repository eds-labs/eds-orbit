import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  list,
  data,
  update,
  exception,
  audit,
  DomainError,
} from "../shared.ts";
export async function pauseProject(tx: DbTx, scope: Scope, paused: boolean) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const result = await tx.project.update({
    where: { id: scope.projectId },
    data: { paused, generation: { increment: 1 } },
  });
  if (paused)
    for (const p of await list(tx, scope, "publications")) {
      if (["intent_created", "scheduled_remote"].includes(data(p).status))
        await update(tx, scope, p, {
          ...data(p),
          status:
            data(p).status === "scheduled_remote"
              ? "cancellation_required"
              : "blocked_dependency",
          reason: "PROJECT_PAUSED",
        });
      if (
        ["scheduled_remote", "sending", "outcome_unknown"].includes(
          data(p).status,
        )
      )
        await exception(
          tx,
          scope,
          "REMOTE_ACTION_RECONCILIATION_REQUIRED",
          p.id,
        );
    }
  await audit(tx, scope, "project.pause", scope.projectId, { paused });
  return result;
}

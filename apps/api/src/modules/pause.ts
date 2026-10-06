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
import { stopChatRunForPause } from "./chat.ts";
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
  // Waiting replies end visibly instead of showing "working" forever; on
  // resume, replies whose job the worker blocked during the pause end too.
  for (const job of await list(tx, scope, "jobs")) {
    const d = data(job);
    if (
      d.topic === "chat" &&
      (paused
        ? d.status === "queued"
        : d.status === "blocked_dependency" && d.error === "PROJECT_PAUSED")
    )
      await stopChatRunForPause(
        tx,
        d as { resourceId: string; actorId: string },
      );
  }
  await audit(tx, scope, "project.pause", scope.projectId, { paused });
  return result;
}

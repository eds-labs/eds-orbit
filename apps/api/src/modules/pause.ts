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
import { notify } from "./agents/notifications.ts";
import { stopChatRunForPause } from "./chat.ts";
/**
 * Pauses or resumes the project. A pause tells the owner's Telegram bot
 * (Orbit Agents) in the same transaction, unless `notify` is false because
 * the bot itself asked for the pause and confirms it.
 */
export async function pauseProject(
  tx: DbTx,
  scope: Scope,
  paused: boolean,
  options: { notify?: boolean } = {},
) {
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
  // Each pause is its own event: the generation changes with every toggle.
  if (paused && options.notify !== false)
    await notify(
      tx,
      scope,
      "project_paused",
      `${scope.projectId}:${result.generation}`,
    );
  return result;
}

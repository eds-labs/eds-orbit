import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { authorize, PROJECT_OWN } from "../tenancy/permissions.ts";
import { list, data, audit } from "../shared.ts";
import { registeredHooks } from "../modules/contributions.ts";
import { stopChatRunForPause } from "../../modules/chat.ts";

/**
 * Pauses or resumes the project (WP1.8: a platform operation that modules
 * extend). The platform bumps the generation, which fences every queued job,
 * ends waiting chat replies and audits. Modules add their steps through
 * `ProjectHooks` in the same transaction and in the order these steps ran
 * before: marketing blocks publications on pause, tells the owner's Telegram
 * bot after it (unless `notify` is false because the bot asked and confirms
 * itself) and puts held-back assignment tasks back on resume.
 */
export async function pauseProject(
  tx: DbTx,
  scope: Scope,
  paused: boolean,
  options: { notify?: boolean } = {},
) {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const result = await tx.project.update({
    where: { id: scope.projectId },
    data: { paused, generation: { increment: 1 } },
  });
  const hooks = registeredHooks();
  const generation = result.generation;
  if (paused)
    for (const h of hooks) await h.onProjectPause?.(tx, scope, { generation });
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
  if (!paused)
    for (const h of hooks) await h.onProjectResume?.(tx, scope, { generation });
  await audit(tx, scope, "project.pause", scope.projectId, { paused });
  if (paused)
    for (const h of hooks)
      await h.afterProjectPause?.(tx, scope, {
        generation,
        notify: options.notify !== false,
      });
  return result;
}

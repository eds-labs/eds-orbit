import type { ProjectHooks } from "../../platform/governance/types.ts";
import { list, data, update, exception } from "../../shared.ts";
import { resumeAgentTasks } from "./agents/assignment-runs.ts";
import { notify } from "./agents/notifications.ts";

/**
 * Marketing's part of a project pause and resume (WP1.8), moved unchanged
 * from `pauseProject`.
 */
export const marketingHooks: ProjectHooks = {
  // Planned posts stop; posts already handed to Postiz or in flight need a
  // reconciliation the owner sees.
  async onProjectPause(tx, scope) {
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
  },
  // Each pause is its own event: the generation changes with every toggle.
  async afterProjectPause(tx, scope, { generation, notify: send }) {
    if (send)
      await notify(
        tx,
        scope,
        "project_paused",
        `${scope.projectId}:${generation}`,
      );
  },
  // Assignment tasks the pause held back go on the queue again, or their
  // runs are cancelled when the slots passed meanwhile (Orbit Agents).
  async onProjectResume(tx, scope, { generation }) {
    await resumeAgentTasks(tx, scope, generation);
  },
};

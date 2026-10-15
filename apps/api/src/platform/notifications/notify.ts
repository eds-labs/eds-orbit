import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { enqueue } from "../jobs/enqueue.ts";
import { telegramEnabled } from "../connections/telegram.ts";
import { registeredNotification } from "../modules/contributions.ts";

/**
 * Notifications to the owner's private Telegram bot (WP2.5b; Orbit Agents,
 * spec §10). Modules register their kinds and how to render them
 * (`notifications`); the platform queues, sends and records them.
 *
 * `notify` only queues a `telegram_notification` job; it runs inside the
 * transaction of the state change it reports, so the notice commits with it
 * or not at all. The sender (`sender.ts`) renders the message when the job
 * runs and reads the state again then. A notification never changes
 * publishing rights: it is a message about a state.
 */

/** A bound bot exists. Whether its owner is still an owner is checked when sending. */
export async function telegramLinked(tx: DbTx, scope: Scope) {
  return Boolean(
    await tx.entity.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "telegram_connections",
        data: { path: ["status"], equals: "linked" },
      },
      select: { id: true },
    }),
  );
}

/**
 * Queues one message. The idempotency key `notify:<kind>:<ref>` makes
 * repeated calls one job; `ref` must therefore name the event, not only the
 * thing (a second pause or a second exhaustion is a new event). A no-op while
 * the bot is off, and without a bound bot (nothing to deliver to). An
 * unregistered kind is a programming error and throws.
 */
export async function notify(
  tx: DbTx,
  scope: Scope,
  kind: string,
  ref: string,
) {
  if (!registeredNotification(kind))
    throw new Error(`NOTIFY_KIND_UNKNOWN: ${kind}`);
  if (!telegramEnabled() || !(await telegramLinked(tx, scope))) return null;
  return enqueue(
    tx,
    scope,
    "telegram_notification",
    ref,
    `notify:${kind}:${ref}`,
  );
}

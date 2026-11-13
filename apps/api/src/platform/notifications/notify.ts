import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { enqueue } from "../jobs/enqueue.ts";
import { telegramEnabled } from "../connections/telegram.ts";
import {
  botKindSignal,
  registeredNotification,
  registeredUserNotification,
} from "../modules/contributions.ts";
import { proactiveEnabled } from "../proactive/preferences.ts";
import { notifyMembers } from "./members.ts";
import { resolveRecipients } from "../signals/deliver.ts";
import { inProject } from "../management/links.ts";

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
  if (proactiveEnabled()) await mirrorBotNotice(tx, scope, kind, ref);
  if (!telegramEnabled() || !(await telegramLinked(tx, scope))) return null;
  return enqueue(
    tx,
    scope,
    "telegram_notification",
    ref,
    `notify:${kind}:${ref}`,
  );
}

/**
 * ADR 0023 item 4: a bot notice a signal maps also becomes a member notice
 * for the project's owners, keyed by the bot's own job key, so a repeated
 * `notify` writes no second row. It carries the kind's label only.
 */
async function mirrorBotNotice(tx: DbTx, scope: Scope, kind: string, ref: string) {
  const mapped = botKindSignal(kind);
  const target = mapped && registeredUserNotification(mapped.signal.kind);
  if (!mapped || !target) return;
  const userIds = await resolveRecipients(scope, { roles: ["owner"] }, target.owner);
  if (!userIds.length) return;
  const project = await tx.project.findFirst({
    where: { id: scope.projectId },
    select: { language: true },
  });
  await notifyMembers(tx, scope, {
    kind: mapped.signal.kind,
    userIds: userIds.slice(0, 200),
    title: target.label[project?.language === "de" ? "de" : "en"],
    link: inProject(scope.projectId, mapped.signal.link ?? ""),
    dedupeKey: `notify:${kind}:${ref}`.slice(0, 200),
    severity: mapped.severity,
  });
}

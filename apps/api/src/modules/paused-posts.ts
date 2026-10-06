import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { audit, data, DomainError, list, update } from "../shared.ts";
import { preflight } from "./policy.ts";
import { enqueue } from "./workflow.ts";

const stoppedByPause = (row: { data: unknown }) =>
  data(row as never).status === "blocked_dependency" &&
  data(row as never).reason === "PROJECT_PAUSED";

/**
 * A pause stops every scheduled post. Resuming the project sends none of
 * them; the owner schedules the ones whose slot is still ahead again here,
 * each after a fresh pre-publish check, daily limit and spacing.
 */
export async function resumePausedPublications(
  tx: DbTx,
  scope: Scope,
  at = new Date(),
) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  if (project.paused) throw new DomainError("PROJECT_PAUSED", 409);
  const all = await list(tx, scope, "publications");
  const jobs = await list(tx, scope, "jobs");
  const blocked: { id: string; blockers: string[] }[] = [];
  let resumed = 0;
  const active = all.filter((row) =>
    ["intent_created", "scheduled_remote", "sending"].includes(
      data(row).status,
    ),
  );
  for (const pub of all
    .filter(
      (row) =>
        stoppedByPause(row) && Date.parse(data(row).scheduledAt) > at.valueOf(),
    )
    .sort((a, b) => data(a).scheduledAt.localeCompare(data(b).scheduledAt))) {
    const v = data(pub);
    const slot = new Date(v.scheduledAt);
    const checked = await preflight(tx, scope, v.contentId, {
      test: v.test,
      at: slot,
    });
    const blockers = [...checked.blockers];
    if (checked.allowed && checked.packageHash !== v.packageHash)
      blockers.push("PACKAGE_CHANGED");
    const sameChannel = active.filter((row) => data(row).channel === v.channel);
    const day = (value: string) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: project.timezone }).format(
        new Date(value),
      );
    if (
      checked.policyInput &&
      sameChannel.filter(
        (row) => day(data(row).scheduledAt) === day(v.scheduledAt),
      ).length >= checked.policyInput.maxPerDay
    )
      blockers.push("CHANNEL_DAILY_QUOTA");
    if (
      checked.policyInput &&
      sameChannel.some(
        (row) =>
          Math.abs(Date.parse(data(row).scheduledAt) - slot.valueOf()) <
          checked.policyInput!.minIntervalMinutes * 60000,
      )
    )
      blockers.push("CHANNEL_SPACING");
    if (blockers.length) {
      blocked.push({ id: pub.id, blockers: [...new Set(blockers)] });
      continue;
    }
    const { reason: _reason, blockers: _old, ...rest } = v;
    const current = await update(tx, scope, pub, {
      ...rest,
      status: "intent_created",
    });
    active.push(current);
    // The original job still waits for the slot unless it ran during the pause.
    if (
      !jobs.some(
        (job) =>
          data(job).topic === "publishing" &&
          data(job).resourceId === pub.id &&
          data(job).status === "queued",
      )
    )
      await enqueue(
        tx,
        scope,
        "publishing",
        pub.id,
        `publish:${pub.id}:${current.version}`,
        slot,
      );
    await audit(tx, scope, "publish.resumed", pub.id, {
      scheduledAt: v.scheduledAt,
    });
    resumed++;
  }
  return { resumed, blocked };
}

/**
 * A slot that passed is not made up for later: an autopilot draft nobody
 * approved in time is archived, and a post stopped by a pause is canceled.
 */
export async function releaseMissedSlots(
  tx: DbTx,
  scope: Scope,
  at = new Date(),
) {
  const passed = (row: { data: unknown }) =>
    Date.parse(String(data(row as never).scheduledAt ?? "")) < at.valueOf();
  for (const pub of await list(tx, scope, "publications"))
    if (stoppedByPause(pub) && passed(pub)) {
      await update(tx, scope, pub, {
        ...data(pub),
        status: "canceled",
        reason: "SLOT_PASSED",
      });
      await audit(tx, scope, "publish.slot_missed", pub.id, {
        scheduledAt: data(pub).scheduledAt,
      });
    }
  const autopilot = new Set(
    (await list(tx, scope, "missions"))
      .filter((m) => data(m).autopilot === true)
      .map((m) => m.id),
  );
  for (const content of await list(tx, scope, "content"))
    if (
      data(content).status === "needs_review" &&
      autopilot.has(String(data(content).missionId)) &&
      passed(content)
    ) {
      await update(tx, scope, content, {
        ...data(content),
        status: "archived",
        reason: "SLOT_PASSED",
      });
      await audit(tx, scope, "autopilot.slot_missed", content.id, {
        scheduledAt: data(content).scheduledAt,
      });
    }
}

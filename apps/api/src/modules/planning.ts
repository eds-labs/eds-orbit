import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  data,
  create,
  update,
  entity,
  list,
  hash,
  DomainError,
  exception,
} from "../shared.ts";
/** Each completed run consumes one finite owner-granted work package, even when it reuses content. */
export async function finishMissionRun(
  tx: DbTx,
  scope: Scope,
  missionId: string,
  contentId: string,
  at = new Date(),
  reused = false,
) {
  const mission = await entity(tx, scope, "missions", missionId),
    m = data(mission),
    run = (m.completedRuns ?? 0) + 1;
  if (run > m.maxContents) throw new DomainError("MISSION_RUN_QUOTA");
  const window = Date.parse(m.endAt) - Date.parse(m.startAt),
    spacing = Math.max(60000, Math.floor(window / m.maxContents));
  const nextAt = Math.max(
    at.valueOf() + 60000,
    Date.parse(m.startAt) + run * spacing,
  );
  const complete = run >= m.maxContents || nextAt >= Date.parse(m.endAt);
  await create(tx, scope, "work_packages", {
    missionId,
    run,
    contentId,
    reused,
    status: "completed",
    completedAt: at.toISOString(),
    planContext: m.planContext ?? null,
  });
  return update(tx, scope, mission, {
    ...m,
    completedRuns: run,
    status: complete ? "completed" : "awaiting_followup",
    lastContentId: contentId,
    lastRunAt: at.toISOString(),
    ...(complete
      ? { completedAt: at.toISOString() }
      : { nextPlanAt: new Date(nextAt).toISOString() }),
  });
}
/** Reads measured memory as planning context only. It never turns a hypothesis into a product fact. */
export async function prepareFollowup(
  tx: DbTx,
  scope: Scope,
  missionId: string,
  at = new Date(),
) {
  const row = await entity(tx, scope, "missions", missionId),
    m = data(row);
  if (m.status !== "awaiting_followup" || at < new Date(m.nextPlanAt))
    return null;
  if (at >= new Date(m.endAt) || (m.completedRuns ?? 0) >= m.maxContents)
    return update(tx, scope, row, { ...m, status: "completed" });
  const last =
    typeof m.lastContentId === "string"
      ? await tx.entity.findFirst({
          where: {
            id: m.lastContentId,
            projectId: scope.projectId,
            kind: "content",
          },
        })
      : null;
  if (!last || !Number.isFinite(Date.parse(m.nextPlanAt))) {
    await update(tx, scope, row, {
      ...m,
      status: "blocked_dependency",
      blockReason: "FOLLOWUP_CONTENT_MISSING",
    });
    await exception(tx, scope, "FOLLOWUP_CONTENT_MISSING", row.id);
    return null;
  }
  const publications = (await list(tx, scope, "publications")).filter(
    (p) => data(p).contentId === last.id,
  );
  // Wait for the last result or an explicit owner disposition instead of multiplying unresolved drafts.
  if (
    !publications.some((p) =>
      ["published", "published_test", "canceled"].includes(data(p).status),
    ) &&
    !["exported", "archived"].includes(data(last).status)
  )
    return null;
  const insights = (await list(tx, scope, "insights")).filter(
    (i) =>
      !["invalidated", "deleted", "disabled"].includes(data(i).status) &&
      (!data(i).validUntil || new Date(data(i).validUntil) > at) &&
      data(i).campaign === missionId,
  );
  const preferences = (await list(tx, scope, "preferences")).filter(
    (p) => data(p).status === "confirmed" && new Date(data(p).validUntil) > at,
  );
  const latest = insights[0];
  if (
    latest &&
    data(latest).status === "observed" &&
    ["clicks", "sessions", "conversions"].includes(m.targetAction) &&
    typeof m.targetValue === "number" &&
    typeof data(latest)[m.targetAction] === "number" &&
    data(latest)[m.targetAction] >= m.targetValue
  )
    return update(tx, scope, row, {
      ...m,
      status: "completed",
      completedAt: at.toISOString(),
      completionReason: "Observed target reached",
      targetEvidenceId: latest.id,
    });
  const planContext = {
    insights: insights.map((i) => ({
      id: i.id,
      version: i.version,
      status: data(i).status,
      denominator: data(i).denominator,
      clicks: data(i).clicks,
      sessions: data(i).sessions,
      conversions: data(i).conversions,
      recommendation: data(i).recommendation,
      limitations: data(i).limitations,
    })),
    preferences: preferences.map((p) => ({
      id: p.id,
      version: p.version,
      rule: data(p).rule,
    })),
    reason: insights.length
      ? "Use current campaign observations without causal claims"
      : "No comparable observations; preserve the approved goal and limits",
    goalHash: hash({
      goal: m.goal,
      audience: m.audience,
      channels: m.channels,
      startAt: m.startAt,
      endAt: m.endAt,
      maxContents: m.maxContents,
    }),
  };
  await create(tx, scope, "followup_plans", {
    missionId,
    run: (m.completedRuns ?? 0) + 1,
    planContext,
    createdAt: at.toISOString(),
  });
  return update(tx, scope, row, { ...m, status: "ready", planContext });
}

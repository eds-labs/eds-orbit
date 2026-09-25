import { finishMissionRun } from "./planning.ts";
import { randomUUID } from "node:crypto";
import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  retrieve,
  validateEvidence,
} from "../../../../packages/knowledge/src/index.ts";
import {
  create,
  update,
  entity,
  data,
  list,
  hash,
  DomainError,
  audit,
  exception,
} from "../shared.ts";
import { preflight, checkClaims } from "./policy.ts";
import { assertMissionAssets } from "./asset-tools.ts";
export async function enqueue(
  tx: DbTx,
  scope: Scope,
  topic: string,
  resourceId: string,
  key: string,
  availableAt = new Date(),
) {
  const old = (await list(tx, scope, "jobs")).find(
    (x) => data(x).idempotencyKey === key,
  );
  if (old) return old;
  const job = await create(tx, scope, "jobs", {
    topic,
    resourceId,
    idempotencyKey: key,
    status: "queued",
    attempts: 0,
    maxAttempts: 3,
    availableAt: availableAt.toISOString(),
    actorId: scope.userId,
  });
  await tx.outbox.create({
    data: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      topic,
      entityId: job.id,
      payload: { jobId: job.id },
      availableAt,
    },
  });
  return job;
}
export async function planMission(tx: DbTx, scope: Scope, missionId: string) {
  const m = await entity(tx, scope, "missions", missionId);
  await assertMissionAssets(tx, scope, data(m).assetIds ?? []);
  if (["completed", "awaiting_followup"].includes(data(m).status)) return m;
  if (new Date(data(m).startAt) > new Date())
    throw new DomainError("MISSION_NOT_ACTIVE");
  if (new Date(data(m).endAt) <= new Date())
    throw new DomainError("MISSION_EXPIRED");
  return enqueue(
    tx,
    scope,
    "generation",
    missionId,
    "mission:" + missionId + ":" + m.version,
  );
}
export async function deterministicDraft(
  tx: DbTx,
  scope: Scope,
  missionId: string,
  jobId?: string,
) {
  if (jobId) {
    const saved = (await list(tx, scope, "content")).find(
      (c) => data(c).jobId === jobId,
    );
    if (saved) return [saved];
  }
  const m = await entity(tx, scope, "missions", missionId),
    v = data(m);
  await assertMissionAssets(tx, scope, v.assetIds ?? []);
  if (new Date(v.endAt) <= new Date()) throw new DomainError("MISSION_EXPIRED");
  if (new Date(v.startAt) > new Date())
    throw new DomainError("MISSION_NOT_ACTIVE");
  if ((v.completedRuns ?? 0) >= v.maxContents) return [];
  const channel = v.channels[(v.completedRuns ?? 0) % v.channels.length];
  const existing = (await list(tx, scope, "content")).filter(
    (x) => data(x).missionId === missionId,
  );
  if (existing.length >= v.maxContents) return existing;
  const evidence = await retrieve(tx, scope, {
    query: v.goal,
    sourceIds: v.sourceIds,
    purpose: "public",
    language: v.language,
    at: new Date(),
  });
  const e = data(evidence as any);
  const evidenceId = (evidence as any).id;
  if (!evidenceId || e.status === "insufficient_evidence") {
    await exception(tx, scope, "INSUFFICIENT_EVIDENCE", missionId);
    throw new DomainError("INSUFFICIENT_EVIDENCE");
  }
  const facts = await list(tx, scope, "facts");
  const fact = facts.find(
    (f) => JSON.stringify(e).includes(f.id) && data(f).status === "verified",
  );
  let body: string, claims: any[];
  if (fact) {
    const f = data(fact);
    body = `${f.key}: ${typeof f.value === "object" ? JSON.stringify(f.value) : f.value}${f.currency ? " " + f.currency : f.unit ? " " + f.unit : ""}`;
    claims = [{ kind: "fact", text: body, factId: fact.id }];
  } else {
    const items = e.items ?? [];
    const first = items[0];
    const chunkId = first?.chunkId ?? first?.id;
    const chunk = chunkId
      ? await tx.knowledgeChunk.findFirst({
          where: { id: chunkId, projectId: scope.projectId },
        })
      : null;
    if (!chunk) throw new DomainError("INSUFFICIENT_EVIDENCE");
    body = chunk.text.slice(0, 260);
    claims = [{ kind: "quote", text: body, chunkId: chunk.id }];
  }
  body = `${body}\n${v.targetAction}`;
  claims.push({ kind: "style", text: v.targetAction });
  const duplicate = (await list(tx, scope, "content")).find(
    (x) => data(x).body === body && data(x).channel === channel,
  );
  if (
    duplicate &&
    (await validateEvidence(tx, scope, data(duplicate).evidenceId, new Date()))
      .valid
  ) {
    await finishMissionRun(
      tx,
      scope,
      missionId,
      duplicate.id,
      new Date(),
      true,
    );
    return [];
  }
  const content = await create(tx, scope, "content", {
    title: v.title,
    body,
    type: v.contentType,
    language: v.language,
    channel,
    missionId,
    ...(v.assetIds?.length
      ? { assetId: v.assetIds[(v.completedRuns ?? 0) % v.assetIds.length] }
      : {}),
    campaignType: v.campaignType,
    profileVersion: v.profileVersion,
    evidenceId,
    claims,
    risk: "routine",
    status: "draft",
    synthetic: true,
    origin: "generated_derived",
    executionMode: "test",
    generationMethod: "deterministic_extract_test",
    ...(jobId ? { jobId } : {}),
    outline: [],
    sources: [],
    slug: v.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  });
  await finishMissionRun(tx, scope, missionId, content.id);
  await audit(tx, scope, "mission.test_draft", content.id, {
    missionId,
    evidenceId,
  });
  return [content];
}
function localDay(at: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  }).format(at);
}
export async function publishIntent(
  tx: DbTx,
  scope: Scope,
  input: { contentId: string; version: number; scheduledAt?: string },
) {
  const c = await entity(tx, scope, "content", input.contentId);
  if (c.version !== input.version)
    throw new DomainError("VERSION_CONFLICT", 409);
  const effectiveSchedule = input.scheduledAt ?? data(c).scheduledAt;
  const at = effectiveSchedule ? new Date(effectiveSchedule) : new Date();
  if (!Number.isFinite(at.valueOf()) || at.valueOf() < Date.now() - 1000)
    throw new DomainError("INVALID_SCHEDULE");
  if (input.scheduledAt && data(c).scheduledAt !== input.scheduledAt)
    throw new DomainError("SAVE_SCHEDULE_BEFORE_APPROVAL", 409);
  const test = process.env.EXECUTION_MODE !== "live";
  const p = await preflight(tx, scope, c.id, { test, at });
  if (!p.allowed) throw new DomainError(p.blockers.join(","), 409);
  const key = hash({
    contentId: c.id,
    version: c.version,
    packageHash: p.packageHash,
    test,
  });
  const all = await list(tx, scope, "publications"),
    old = all.find((x) => data(x).idempotencyKey === key);
  if (old) return old;
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  const active = all.filter(
    (x) =>
      !["canceled", "failed", "blocked_dependency"].includes(data(x).status) &&
      data(x).channel === data(c).channel,
  );
  if (
    active.filter(
      (x) =>
        localDay(new Date(data(x).scheduledAt), project.timezone) ===
        localDay(at, project.timezone),
    ).length >= p.policyInput!.maxPerDay
  )
    throw new DomainError("CHANNEL_DAILY_QUOTA", 409);
  if (
    active.some(
      (x) =>
        Math.abs(new Date(data(x).scheduledAt).valueOf() - at.valueOf()) <
        p.policyInput!.minIntervalMinutes * 60000,
    )
  )
    throw new DomainError("CHANNEL_SPACING", 409);
  const pub = await create(tx, scope, "publications", {
    contentId: c.id,
    contentVersion: c.version,
    evidenceId: data(c).evidenceId,
    channel: data(c).channel,
    status: "intent_created",
    packageHash: p.packageHash,
    idempotencyKey: key,
    scheduledAt: at.toISOString(),
    test,
    remoteId: null,
  });
  await enqueue(tx, scope, "publishing", pub.id, "publish:" + pub.id, at);
  await audit(tx, scope, "publish.intent", pub.id, {
    test,
    packageHash: p.packageHash,
  });
  return pub;
}
export async function claimPublication(tx: DbTx, scope: Scope, pubId: string) {
  const pub = await entity(tx, scope, "publications", pubId),
    v = data(pub);
  if (
    [
      "published",
      "published_test",
      "canceled",
      "blocked_dependency",
      "outcome_unknown",
      "sending",
    ].includes(v.status)
  )
    return { send: false, pub };
  if (new Date(v.scheduledAt) > new Date()) throw new DomainError("NOT_DUE");
  const p = await preflight(tx, scope, v.contentId, { test: v.test });
  if (!p.allowed || p.packageHash !== v.packageHash) {
    const blocked = await update(tx, scope, pub, {
      ...v,
      status: "blocked_dependency",
      blockers: p.blockers.length ? p.blockers : ["PACKAGE_CHANGED"],
    });
    await exception(tx, scope, "PUBLISH_PREFLIGHT_BLOCKED", pub.id);
    return { send: false, pub: blocked };
  }
  const claimed = await update(tx, scope, pub, {
    ...v,
    status: "sending",
    handoffAt: new Date().toISOString(),
    fence: randomUUID(),
  });
  for (const a of await list(tx, scope, "approvals"))
    if (data(a).packageHash === v.packageHash && data(a).status === "approved")
      await update(tx, scope, a, {
        ...data(a),
        status: "consumed",
        publicationId: pub.id,
      });
  return { send: true, pub: claimed, content: p.content };
}
export async function finishPublication(
  tx: DbTx,
  scope: Scope,
  pubId: string,
  fence: string,
  result: {
    status: "published" | "published_test" | "outcome_unknown" | "failed";
    remoteId?: string;
  },
) {
  const pub = await entity(tx, scope, "publications", pubId);
  if (data(pub).fence !== fence) throw new DomainError("STALE_FENCE", 409);
  if (data(pub).status !== "sending") return pub;
  const done = await update(tx, scope, pub, {
    ...data(pub),
    ...result,
    completedAt: new Date().toISOString(),
  });
  await audit(tx, scope, "publish." + result.status, pubId, {
    remoteId: result.remoteId ?? null,
  });
  if (result.status === "outcome_unknown")
    await exception(tx, scope, "PUBLISH_OUTCOME_UNKNOWN", pubId);
  return done;
}
export async function analyze(tx: DbTx, scope: Scope, campaign?: string) {
  const rows = (await list(tx, scope, "metrics")).filter(
    (x) => !campaign || data(x).campaign === campaign,
  );
  if (!rows.length) throw new DomainError("NO_METRICS");
  const dimensions = new Set(
    rows.map((x) =>
      JSON.stringify([
        data(x).source,
        data(x).currency ?? null,
        data(x).accountId ?? null,
        data(x).timezone ?? null,
      ]),
    ),
  );
  if (dimensions.size > 1)
    throw new DomainError("METRIC_DIMENSIONS_MUST_MATCH");
  const sources = [...new Set(rows.map((x) => data(x).source))];
  if (sources.length > 1 && !campaign)
    throw new DomainError("SELECT_SINGLE_SOURCE_CAMPAIGN");
  const sum = (k: string) =>
    rows.some((x) => data(x)[k] === null)
      ? null
      : rows.reduce((n, x) => n + Number(data(x)[k] ?? 0), 0);
  const sample = rows.reduce((n, x) => n + data(x).sampleSize, 0),
    snapshot = hash(rows.map((x) => ({ id: x.id, version: x.version })));
  const previous = (await list(tx, scope, "insights")).find(
    (x) => data(x).snapshot === snapshot,
  );
  if (previous) return previous;
  const insight = await create(tx, scope, "insights", {
    kind: "performance",
    status: sample < 30 ? "hypothesis" : "observed",
    campaign: campaign ?? null,
    snapshot,
    metricIds: rows.map((x) => x.id),
    sources,
    currency: data(rows[0]!).currency ?? null,
    accountId: data(rows[0]!).accountId ?? null,
    timezone: data(rows[0]!).timezone ?? null,
    denominator: sample,
    clicks: sum("clicks"),
    sessions: sum("sessions"),
    conversions: sum("conversions"),
    costMicros: sum("costMicros"),
    limitations: [
      "Observational data does not establish causation",
      ...[
        ...new Set(
          rows.flatMap((r) =>
            Array.isArray(data(r).limitations) ? data(r).limitations : [],
          ),
        ),
      ].slice(0, 30),
      ...(sample < 30 ? ["Insufficient sample; no winner declared"] : []),
    ],
    validUntil: new Date(Date.now() + 30 * 86400000).toISOString(),
    recommendation:
      "Review the existing mission using this observation; do not increase channel quota, budget or audience.",
  });
  await audit(tx, scope, "analytics.insight", insight.id, { snapshot });
  return insight;
}
export async function reviewContent(
  tx: DbTx,
  scope: Scope,
  id: string,
  version: number,
  humanConfirm = false,
) {
  let c = await entity(tx, scope, "content", id);
  if (c.version !== version) throw new DomainError("VERSION_CONFLICT", 409);
  if (humanConfirm) {
    if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
    c = await update(tx, scope, c, {
      ...data(c),
      humanReviewedBodyHash: hash(data(c).body),
    });
  }
  const result = await checkClaims(tx, scope, id);
  return update(tx, scope, c, {
    ...data(c),
    status: result.valid ? "reviewed" : "needs_review",
    review: result,
    reviewedBy: scope.userId,
  });
}

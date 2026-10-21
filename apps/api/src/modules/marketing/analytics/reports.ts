import { reportEvidenceCurrent } from "./report-evidence.ts";
import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { marketingPlanSpec } from "../../../../../../packages/schemas/src/index.ts";
import {
  create,
  data,
  entity,
  update,
  hash,
  audit,
  DomainError,
} from "../../../shared.ts";
import {
  authorize,
  PROJECT_OWN,
} from "../../../platform/tenancy/permissions.ts";
import { actorScope } from "../../../platform/tenancy/member-scope.ts";
import { moduleScope } from "../../../platform/tenancy/module-roles.ts";
import { planAccess, proposePlan, planView } from "../plans/service.ts";
import { localDate } from "../agents/scheduling.ts";
import { notify } from "../agents/notifications.ts";
import { matomoDayInterval } from "./matomo.ts";
import { lockMetrics, summarizeMetrics } from "./metric-report.ts";
export const REPORT_KIND = "marketing_reports";
export const reportInput = z
  .object({ planId: z.uuid(), from: z.iso.date(), to: z.iso.date() })
  .strict();
export const reportVersion = z
  .object({ version: z.number().int().positive() })
  .strict();
const DAY = 86400000;
/** Opaque aggregate campaign identity; never embeds a user/account/person identifier. */
export const attributionCampaign = (planId: string) =>
  `orbit-${hash(planId).slice(0, 20)}`;
export function proposedAttributionUrl(raw: string, planId: string) {
  const url = new URL(raw);
  if (url.searchParams.has("utm_campaign")) return { url: raw, conflict: true };
  url.searchParams.set("utm_source", "orbit");
  url.searchParams.set("utm_medium", "organic_social");
  url.searchParams.set("utm_campaign", attributionCampaign(planId));
  return { url: url.toString(), conflict: false };
}
function period(input: z.infer<typeof reportInput>, zone: string, now: Date) {
  if (
    input.from > input.to ||
    Date.parse(input.to) - Date.parse(input.from) >= 120 * DAY ||
    input.to >= localDate(now, zone)
  )
    throw new DomainError("REPORT_CLOSED_PERIOD_REQUIRED", 409);
  return {
    from: input.from,
    to: input.to,
    timezone: zone,
    startAt: matomoDayInterval(input.from, zone).periodStart,
    endAt: matomoDayInterval(input.to, zone).periodEnd,
  };
}
/** Internal sweep path reads stored aggregates only. User entrypoints call planAccess first. */
export async function persistReport(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  now = new Date(),
) {
  const input = reportInput.parse(raw);
  await lockMetrics(tx, scope);
  const plan = { id: input.planId };
  const key = hash({ planId: plan.id, from: input.from, to: input.to });
  const previous = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: REPORT_KIND,
      data: { path: ["periodKey"], equals: key },
    },
  });
  // Historical corrections retain the originally reported strategy, horizon and
  // local timezone even after that plan has been revised or removed.
  const p =
    data(previous).planSnapshot ??
    data(await entity(tx, scope, "marketing_plans", input.planId));
  const window = period(input, p.spec.timezone, now);
  const start = Math.max(
    Date.parse(window.startAt),
    Date.parse(p.spec.horizon.startAt),
  );
  const end = Math.min(
    Date.parse(window.endAt),
    Date.parse(p.spec.horizon.endAt),
  );
  if (start >= end) throw new DomainError("REPORT_PERIOD_OUTSIDE_PLAN", 409);
  const metrics = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "metrics",
      AND: [
        { data: { path: ["periodStart"], gte: new Date(start).toISOString() } },
        { data: { path: ["periodStart"], lt: new Date(end).toISOString() } },
      ],
    },
    orderBy: { id: "asc" },
    take: 1001,
  });
  const contained = metrics
    .slice(0, 1000)
    .filter(
      (m) =>
        Date.parse(data(m).periodEnd) <= end &&
        Date.parse(data(m).periodEnd) > Date.parse(data(m).periodStart),
    );
  const publications = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "publications",
      AND: [
        { data: { path: ["marketingPlan", "planId"], equals: plan.id } },
        { data: { path: ["status"], equals: "published" } },
      ],
    },
    orderBy: { id: "asc" },
    take: 201,
  });
  // Older publication rows may carry the plan only on their content. Join exact
  // stored IDs, never similar text/campaign labels or a connector's whole account.
  const contents = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "content",
      data: { path: ["marketingPlan", "planId"], equals: plan.id },
    },
    orderBy: { id: "asc" },
    take: 201,
  });
  const contentIds = contents.slice(0, 200).map((c) => c.id);
  const byContent = contentIds.length
    ? await tx.entity.findMany({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "publications",
          OR: contentIds.map((id) => ({
            data: { path: ["contentId"], equals: id },
          })),
        },
        orderBy: { id: "asc" },
        take: 201,
      })
    : [];
  const unique = new Map([...publications, ...byContent].map((r) => [r.id, r]));
  const delivered = [...unique.values()].filter(
    (r) =>
      ["published", "posted"].includes(String(data(r).status)) &&
      data(r).remoteId,
  );
  const measuredIds = new Set(delivered.map((r) => r.id));
  const attributed = contained.filter(
    (m) =>
      measuredIds.has(data(m).publicationId) ||
      data(m).campaign === attributionCampaign(plan.id),
  );
  const reports = summarizeMetrics(contained),
    planReports = summarizeMetrics(attributed);
  const complete =
    metrics.length <= 1000 &&
    contents.length <= 200 &&
    publications.length <= 200 &&
    byContent.length <= 200 &&
    contained.length === metrics.length &&
    reports.length <= 20 &&
    reports.every((r) => r.complete);
  const refs = contained.map((m) => ({ id: m.id, version: m.version }));
  const signature = hash({
    specHash: p.specHash,
    refs,
    publications: delivered.map((r) => ({ id: r.id, version: r.version })),
    complete,
  });
  if (
    previous &&
    data(previous).snapshot === signature &&
    data(previous).status !== "invalidated"
  )
    return previous;
  const old = data(previous),
    revision = Number(old.revision ?? 0) + 1;
  const noData = planReports.length === 0 || planReports.every((r) => r.noData);
  const limitations = [
    "Observational measurements do not establish causation. Source groups are never added together.",
    "Project-level measurements are separate from measurements explicitly attributed to this plan.",
    "Observed source days do not establish full-period coverage. Missing days and missing counters are not zeros.",
    "Postiz specialist sampling: at most 3 channels, 5 posts per task, recent 7 days; cached/live samples are not complete period totals.",
    ...(p.spec.channels.length > 3
      ? ["PLAN_EXCEEDS_SPECIALIST_CHANNEL_LIMIT"]
      : []),
    ...(!complete ? ["INCOMPLETE_EVIDENCE"] : []),
    ...(delivered.length === 0 ? ["NO_CONFIRMED_PUBLICATION_IDS"] : []),
    ...(noData ? ["NO_PLAN_ATTRIBUTED_MEASUREMENTS"] : []),
  ];
  const spec = marketingPlanSpec.parse({
    ...p.spec,
    // Refresh a baseline only from one unambiguous attributed source group.
    // Multiple sources, missing counters, insufficient samples or native ref
    // limits stay no_data rather than inventing a combined baseline.
    kpis: p.spec.kpis.map((kpi: any) => {
      const counter = kpi.unit === "USD" ? "costMicros" : kpi.unit;
      const eligible = planReports.filter(
        (g) =>
          g.complete &&
          Number.isFinite((g as Record<string, any>)[counter]) &&
          (kpi.unit !== "USD" || g.currency === "USD"),
      );
      const refs = eligible.length === 1 ? eligible[0]!.metricRefs : [];
      const valid =
        refs.length > 0 &&
        refs.length <= 10 &&
        refs.every(
          (ref) =>
            Number(data(contained.find((m) => m.id === ref.id)).sampleSize) > 0,
        );
      return {
        ...kpi,
        baselineState: valid ? "measured" : "no_data",
        metricRefs: valid ? refs : [],
      };
    }),
    title: `Report review: ${p.spec.title}`.slice(0, 160),
    assumptions: [
      ...p.spec.assumptions.slice(0, 9),
      `Review evidence for ${input.from} to ${input.to}; ${noData ? "no attributed measurements" : "descriptive measurements only"}. Report ${key}.`,
    ],
  });
  const value = {
    ...old,
    periodKey: key,
    planId: plan.id,
    planSnapshot: { spec: p.spec, specHash: p.specHash, revision: p.revision },
    planSpecHash: p.specHash,
    planRevision: p.revision,
    period: window,
    effectivePeriod: {
      startAt: new Date(start).toISOString(),
      endAt: new Date(end).toISOString(),
    },
    snapshot: signature,
    revision,
    status: "ready",
    noData,
    complete,
    metricRefs: refs,
    projectReports: reports.slice(0, 20),
    planReports: planReports.slice(0, 20),
    publicationIds: delivered.map((r) => r.id).slice(0, 200),
    coverage: {
      periodCoverageEstablished: false,
      requestedChannels: p.spec.channels,
      specialistMaxChannels: 3,
      specialistMaxPosts: 5,
      specialistRecentDays: 7,
      sampledAllChannels:
        p.spec.channels.length <= 3 ? "not_established" : false,
    },
    limitations,
    attribution: {
      campaign: attributionCampaign(plan.id),
      proposedLink: proposedAttributionUrl(p.spec.cta.url, plan.id),
      appliedToContent: false,
    },
    revisionProposal: {
      status: "candidate",
      baseSpecHash: p.specHash,
      spec,
      reportSnapshot: signature,
    },
    generatedAt: now.toISOString(),
    availableToOwnerAt: old.availableToOwnerAt ?? now.toISOString(),
    acknowledgedRevision: old.acknowledgedRevision ?? 0,
  };
  const saved = previous
    ? await update(tx, scope, previous, value)
    : await create(tx, scope, REPORT_KIND, value);
  await notify(tx, scope, "marketing_report", saved.id);
  await audit(tx, scope, "marketing.report_saved", saved.id, {
    revision,
    metricCount: refs.length,
    noData,
    complete,
  });
  return saved;
}
export async function acknowledgeReport(
  tx: DbTx,
  scope: Scope,
  id: string,
  version: number,
) {
  await planAccess(tx, scope);
  const current = await actorScope(
    scope.workspaceId,
    scope.projectId,
    scope.userId,
  );
  if (!current) throw new DomainError("FORBIDDEN", 403);
  authorize(moduleScope(current, "marketing"), PROJECT_OWN, "OWNER_REQUIRED");
  const row = await entity(tx, scope, REPORT_KIND, id),
    d = data(row);
  if (row.version !== version) throw new DomainError("VERSION_CONFLICT", 409);
  if (!(await reportEvidenceCurrent(tx, scope, d)))
    throw new DomainError("REPORT_STALE", 409);
  if (d.acknowledgedRevision === d.revision) return row;
  return update(tx, scope, row, {
    ...d,
    acknowledgedRevision: d.revision,
    acknowledgedBy: scope.userId,
    acknowledgedAt: new Date().toISOString(),
  });
}
export async function proposeReportRevision(
  tx: DbTx,
  scope: Scope,
  id: string,
  version: number,
  spec?: unknown,
) {
  await planAccess(tx, scope, true);
  await lockMetrics(tx, scope);
  const row = await entity(tx, scope, REPORT_KIND, id),
    d = data(row);
  if (row.version !== version) throw new DomainError("VERSION_CONFLICT", 409);
  const plan = await entity(tx, scope, "marketing_plans", d.planId);
  if (
    !(await reportEvidenceCurrent(tx, scope, d)) ||
    !d.revisionProposal ||
    data(plan).specHash !== d.planSpecHash
  )
    throw new DomainError("REPORT_STALE", 409);
  if (d.revisionProposal.proposedPlanId)
    return planView(tx, scope, d.revisionProposal.proposedPlanId);
  // A separate native proposal: never revise/pause/activate the live mandate here.
  const candidateSpec = spec ?? {
    ...d.revisionProposal.spec,
    horizon: {
      ...d.revisionProposal.spec.horizon,
      startAt: new Date(
        Math.max(
          Date.parse(d.revisionProposal.spec.horizon.startAt),
          Date.now() + 60000,
        ),
      ).toISOString(),
    },
  };
  const parsed = marketingPlanSpec.parse(candidateSpec);
  const links = new Map(parsed.existingWork.map((ref) => [ref.id, ref]));
  for (const child of data(plan).activation?.children ?? []) {
    const assignment = await entity(tx, scope, "assignments", child.id);
    if (data(assignment).marketingPlan?.planId !== plan.id)
      throw new DomainError("PLAN_CHILD_OWNERSHIP_STALE", 409);
    links.set(child.id, {
      kind: "assignments",
      id: child.id,
      version: assignment.version,
      proposedChange:
        "Review existing work only; no adoption or activation is authorized by this report.",
    });
  }
  if (links.size > 20) throw new DomainError("REPORT_LINK_LIMIT", 409);
  const boundSpec = {
    ...parsed,
    existingWork: [...links.values()],
    assumptions: [
      ...parsed.assumptions.slice(0, 9),
      `Report ${d.period.from} to ${d.period.to}, revision ${d.revision} (${d.periodKey.slice(0, 12)}/${d.snapshot.slice(0, 12)}). Owner review and exact activation required.`,
    ],
  };
  const proposed = await proposePlan(tx, scope, boundSpec);
  if (
    proposed.id === plan.id ||
    proposed.activation ||
    proposed.status !== "proposed"
  )
    throw new DomainError("REPORT_PROPOSAL_ALREADY_ACTIVE", 409);
  const candidate = await entity(tx, scope, "marketing_plans", proposed.id);
  await update(tx, scope, candidate, {
    ...data(candidate),
    reportOrigin: { id: row.id, snapshot: d.snapshot },
  });
  await update(tx, scope, row, {
    ...d,
    revisionProposal: {
      ...d.revisionProposal,
      status: "proposed",
      proposedPlanId: proposed.id,
    },
  });
  return planView(tx, scope, proposed.id);
}

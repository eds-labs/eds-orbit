import {
  marketingPlanSpec,
  marketingPlanReview,
  type MarketingPlanSpec,
  type Scope,
} from "../../../../../../packages/schemas/src/index.ts";
import { sourceData } from "../../../../../../packages/knowledge/src/index.ts";
import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import {
  data,
  entity,
  create,
  update,
  hash,
  audit,
  DomainError,
  list,
} from "../../../shared.ts";
import {
  authorize,
  PROJECT_READ,
  PROJECT_WRITE,
  PROJECT_OWN,
} from "../../../platform/tenancy/permissions.ts";
import { moduleScope } from "../../../platform/tenancy/module-roles.ts";
import { assertModuleEnabled } from "../../../platform/modules/enforcement.ts";
import { actorScope } from "../../../platform/tenancy/member-scope.ts";
import {
  currentMarketingProfile,
  assertCampaignContext,
} from "../brand/marketing-profile.ts";
import {
  usableFactsByIds,
  listUsableFacts,
} from "../../../platform/knowledge/facts.ts";
import { activePolicy } from "../policy/policy.ts";
import { assertAssignedSocialChannels } from "../publishing/postiz-assignment.ts";
import {
  assignmentHash,
  agentsEnabled,
  committedBudget,
} from "../agents/assignments.ts";
import {
  createActionRequest,
  cancelActionRequest,
} from "../../action-requests.ts";
import { projectReadiness } from "../../../platform/governance/readiness.ts";
import { assignedPostizChannels } from "../publishing/postiz-assignment.ts";
import { connectionVerified } from "../../../platform/connections/connections.ts";
import { conversation } from "../../chat.ts";
import { budgetMonthStart } from "../../../platform/ai/budget.ts";

import { latestAssignmentResult } from "../agents/assignment-result.ts";
import { pauseOwnedChildren } from "./lifecycle.ts";
export const PLAN_KIND = "marketing_plans";
export async function planAccess(tx: DbTx, scope: Scope, write = false) {
  await assertModuleEnabled(tx, scope, "marketing");
  authorize(
    moduleScope(scope, "marketing"),
    write ? PROJECT_WRITE : PROJECT_READ,
  );
  const current = await actorScope(
    scope.workspaceId,
    scope.projectId,
    scope.userId,
  );
  if (!current) throw new DomainError("FORBIDDEN", 403);
  authorize(
    moduleScope(current, "marketing"),
    write ? PROJECT_WRITE : PROJECT_READ,
  );
  if (!agentsEnabled()) throw new DomainError("AGENTS_DISABLED", 409);
}

function assertSource(raw: unknown) {
  try {
    const source = sourceData(raw);
    if (
      !source.publicUse ||
      !source.modelUse ||
      source.authority === "generated" ||
      (source.embargoUntil && Date.parse(source.embargoUntil) > Date.now()) ||
      (source.audiences &&
        !source.audiences.includes("all") &&
        !source.audiences.includes("marketing"))
    )
      throw new Error("unusable");
  } catch {
    throw new DomainError("PLAN_SOURCE_STALE_OR_UNUSABLE", 409);
  }
}

/** Current references and capacity, never a new spend mandate. */
async function validateSpec(
  tx: DbTx,
  scope: Scope,
  spec: MarketingPlanSpec,
  execution = false,
  ownedIds: string[] = [],
) {
  const now = Date.now();
  if (
    (!execution && Date.parse(spec.horizon.startAt) < now - 300000) ||
    Date.parse(spec.horizon.startAt) > now + 90 * 86400000 ||
    Date.parse(spec.horizon.endAt) <= now
  )
    throw new DomainError("PLAN_HORIZON_NOT_CURRENT", 409);
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  if (project.paused) throw new DomainError("PROJECT_PAUSED", 409);
  if (project.timezone !== spec.timezone)
    throw new DomainError("PLAN_TIMEZONE_STALE", 409);
  const policy = await activePolicy(tx, scope);
  if (
    !policy ||
    policy.id !== spec.policy.id ||
    policy.version !== spec.policy.version
  )
    throw new DomainError("PLAN_POLICY_STALE", 409);
  const p = data(policy);
  if (Date.parse(p.startAt) > now || Date.parse(p.endAt) <= now)
    throw new DomainError("PLAN_POLICY_EXPIRED", 409);
  if (Date.parse(spec.horizon.endAt) > Date.parse(p.endAt))
    throw new DomainError("PLAN_HORIZON_EXCEEDS_POLICY", 409);
  if (
    spec.channels.some((id) => !p.channels.includes(id)) ||
    spec.contentTypes.some((kind) => !p.contentTypes.includes(kind))
  )
    throw new DomainError("SCOPE_NOT_ALLOWED", 409);
  if (spec.cadence.times.length > p.maxPerDay)
    throw new DomainError("PLAN_CADENCE_EXCEEDS_POLICY", 409);
  await assertAssignedSocialChannels(tx, scope, spec.channels);
  await assertCampaignContext(tx, scope, {
    campaignType: spec.campaignType,
    profileVersion: spec.profileVersion,
    language: spec.language,
    targetAction: spec.cta.label,
    targetUrl: spec.cta.url,
  });
  if (!p.allowedOrigins.includes(new URL(spec.cta.url).origin))
    throw new DomainError("LINK_NOT_ALLOWED", 409);
  const profile = await currentMarketingProfile(tx, scope);
  if (
    !data(profile).officialLinks?.some(
      (link: any) =>
        link.url === spec.cta.url && link.factId === spec.cta.factId,
    )
  )
    throw new DomainError("PLAN_CTA_STALE", 409);
  if (!spec.facts.some((f) => f.id === spec.cta.factId))
    throw new DomainError("PLAN_CTA_FACT_REQUIRED", 409);
  const facts = await usableFactsByIds(
    tx,
    scope,
    spec.facts.map((f) => f.id),
    { at: new Date(), language: spec.language },
  );
  const sources = new Map<string, { id: string; version: number }>();
  for (const ref of spec.facts) {
    const fact = facts.get(ref.id);
    if (!fact || fact.version !== ref.version)
      throw new DomainError("PLAN_FACT_STALE_OR_UNUSABLE", 409);
    const source = await entity(tx, scope, "sources", data(fact).sourceId);
    assertSource(data(source));
    sources.set(source.id, { id: source.id, version: source.version });
  }
  for (const ref of spec.sourceRefs) {
    const row = await entity(tx, scope, "sources", ref.id);
    assertSource(data(row));
    if (row.version !== ref.version)
      throw new DomainError("PLAN_SOURCE_STALE_OR_UNUSABLE", 409);
    sources.set(row.id, { id: row.id, version: row.version });
  }
  for (const kpi of spec.kpis)
    for (const ref of kpi.metricRefs) {
      const metric = await entity(tx, scope, "metrics", ref.id);
      const value = data(metric)[kpi.unit === "USD" ? "costMicros" : kpi.unit];
      if (
        !Number.isFinite(value) ||
        data(metric).sampleSize <= 0 ||
        Date.parse(data(metric).periodEnd) <=
          Date.parse(data(metric).periodStart)
      )
        throw new DomainError("PLAN_BASELINE_NOT_MEASURED", 409);
      if (
        metric.version !== ref.version ||
        ["deleted", "invalidated"].includes(data(metric).status)
      )
        throw new DomainError("PLAN_BASELINE_STALE", 409);
    }
  let linkedBudget = 0,
    ownedBudget = 0;
  for (const ref of spec.existingWork) {
    const row = await entity(tx, scope, ref.kind, ref.id);
    const d = data(row);
    if (
      (!ownedIds.includes(ref.id) && row.version !== ref.version) ||
      ["ended", "archived", "completed"].includes(d.status)
    )
      throw new DomainError("PLAN_WORK_STALE", 409);
    if (
      ref.kind === "assignments" &&
      ["active", "paused", "budget_exhausted"].includes(d.status)
    )
      if (ownedIds.includes(row.id))
        ownedBudget += Number(d.monthlyBudgetMicros ?? 0);
      else linkedBudget += Number(d.monthlyBudgetMicros ?? 0);
  }
  for (const id of ownedIds.filter(
    (id) => !spec.existingWork.some((r) => r.id === id),
  )) {
    const owned = await entity(tx, scope, "assignments", id);
    if (["active", "paused", "budget_exhausted"].includes(data(owned).status))
      ownedBudget += Number(data(owned).monthlyBudgetMicros ?? 0);
  }
  const committed = await committedBudget(tx, scope, null);
  if (
    spec.monthlyBudgetMicros < linkedBudget ||
    committed - linkedBudget - ownedBudget + spec.monthlyBudgetMicros >
      Number(p.monthlyBudgetMicros)
  )
    throw new DomainError("PLAN_BUDGET_EXCEEDS_PROJECT", 409);
  for (const id of spec.creative.styleAssetIds) {
    const asset = data(await entity(tx, scope, "assets", id));
    if (!asset.usageApproved || asset.assetStatus !== "approved")
      throw new DomainError("PLAN_ASSET_NOT_APPROVED", 409);
  }
  return [...sources.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function validateSaved(
  tx: DbTx,
  scope: Scope,
  row: { data: unknown },
  execution = false,
) {
  const d = data(row);
  const sources = await validateSpec(
    tx,
    scope,
    marketingPlanSpec.parse(d.spec),
    execution,
    execution ? (d.activation?.children ?? []).map((c: any) => c.id) : [],
  );
  if (hash({ spec: d.spec, sources }) !== d.specHash)
    throw new DomainError("PLAN_SOURCE_SNAPSHOT_STALE", 409);
}
export async function planView(tx: DbTx, scope: Scope, id: string) {
  await planAccess(tx, scope);
  const row = await entity(tx, scope, PLAN_KIND, id),
    d = data(row);
  const blockers: string[] = [];
  try {
    await validateSaved(tx, scope, row, Boolean(d.activation));
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    blockers.push(
      error.code === "NOT_FOUND" ? "PLAN_REFERENCE_UNAVAILABLE" : error.code,
    );
  }
  if (d.review) {
    const reviewer = await actorScope(
      scope.workspaceId,
      scope.projectId,
      d.review.userId,
    );
    if (!reviewer || moduleScope(reviewer, "marketing").role !== "owner")
      blockers.push("PLAN_REVIEWER_NO_LONGER_OWNER");
  }
  if (d.activation && d.status === "active") {
    const activator = await actorScope(
      scope.workspaceId,
      scope.projectId,
      d.activation.userId,
    );
    if (!activator || moduleScope(activator, "marketing").role !== "owner")
      blockers.push("PLAN_OWNER_REVOKED");
    for (const child of d.activation.children) {
      const work = await tx.entity.findFirst({
        where: {
          id: child.id,
          kind: "assignments",
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
        },
      });
      if (
        !work ||
        assignmentHash(data(work)) !== child.assignmentHash ||
        data(work).marketingPlan?.requestId !== d.activation.requestId
      )
        blockers.push("PLAN_CHILD_CHANGED");
    }
    for (const ref of d.activation.assets) {
      const asset = await tx.entity.findFirst({
        where: {
          id: ref.id,
          kind: "assets",
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
        },
      });
      if (!asset || asset.version !== ref.version)
        blockers.push("PLAN_ASSET_VERSION_STALE");
    }
  }
  const spec = marketingPlanSpec.parse(d.spec);
  const linkedWork = await Promise.all(
    [
      ...spec.existingWork,
      ...(d.activation?.children ?? [])
        .filter((c: any) => !spec.existingWork.some((r) => r.id === c.id))
        .map((c: any) => ({
          kind: "assignments" as const,
          id: c.id,
          version: c.version,
        })),
    ].map(async (ref) => {
      const work = await tx.entity.findFirst({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: ref.kind,
          id: ref.id,
        },
      });
      const latest =
        ref.kind === "assignments" && work
          ? await latestAssignmentResult(tx, scope, ref.id)
          : null;
      const deliveryIds =
        latest?.deliverables.flatMap((item) =>
          [item.publicationId, item.postizDraftId].filter((id): id is string =>
            Boolean(id),
          ),
        ) ?? [];
      const deliveryRows = deliveryIds.length
        ? await tx.entity.findMany({
            where: {
              workspaceId: scope.workspaceId,
              projectId: scope.projectId,
              kind: { in: ["publications", "postiz_drafts"] },
              id: { in: deliveryIds },
            },
            take: 32,
          })
        : [];
      return {
        id: ref.id,
        kind: ref.kind,
        owned: Boolean(
          d.activation?.children.some((c: any) => c.id === ref.id),
        ),
        expectedVersion: ref.version,
        currentVersion: work?.version ?? null,
        title: work
          ? String(data(work).name ?? data(work).title ?? "").slice(0, 160)
          : null,
        status: work ? String(data(work).status) : null,
        href: `/p/${scope.projectId}/marketing/${ref.kind}`,
        latestRun: latest
          ? {
              operation: latest.operation,
              id: latest.id,
              status: latest.status,
              costMicros: latest.costMicros,
              deliveries: deliveryRows.map((r) => ({
                id: r.id,
                kind: r.kind,
                status: String(data(r).status),
                remoteId:
                  typeof data(r).remoteId === "string"
                    ? data(r).remoteId
                    : null,
              })),
            }
          : null,
      };
    }),
  );
  const request = d.actionRequestId
    ? await entity(tx, scope, "action_requests", d.actionRequestId)
    : null;
  const r = data(request);
  return {
    id: row.id,
    version: row.version,
    revision: d.revision,
    specHash: d.specHash,
    spec: marketingPlanSpec.parse(d.spec),
    sourceSnapshot: d.sources,
    linkedWork,
    status: blockers.length
      ? ("blocked" as const)
      : ((d.status ?? "proposed") as
          "proposed" | "active" | "paused" | "completed"),
    blockers,
    strategicallyReviewed:
      !blockers.length && d.review?.specHash === d.specHash,
    reviewedAt: d.review?.at ?? null,
    activationAvailable:
      !blockers.length &&
      d.review?.specHash === d.specHash &&
      d.status !== "active",
    activation: d.activation ?? null,
    activationRequest: d.activationRequestId
      ? await activationRequestView(tx, scope, d.activationRequestId)
      : null,
    actionRequest: request
      ? {
          id: request.id,
          version: request.version,
          packageHash: r.packageHash,
          status: r.status,
          expiresAt: r.expiresAt,
        }
      : null,
  };
}

export async function proposePlan(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  originConversation: string | null = null,
  changing?: { id: string; version: number },
) {
  await planAccess(tx, scope, true);
  if (originConversation) await conversation(tx, scope, originConversation);
  const spec = marketingPlanSpec.parse(raw);
  const previous = changing
    ? await entity(tx, scope, PLAN_KIND, changing.id)
    : null;
  const sources = await validateSpec(
    tx,
    scope,
    spec,
    Boolean(previous && data(previous).activation),
    previous
      ? (data(previous).activation?.children ?? []).map((c: any) => c.id)
      : [],
  );
  const specHash = hash({ spec, sources });
  let row;
  if (changing) {
    row = await entity(tx, scope, PLAN_KIND, changing.id);
    if (row.version !== changing.version)
      throw new DomainError("VERSION_CONFLICT", 409);
    if (data(row).specHash === specHash) return planView(tx, scope, row.id);
    if (data(row).activation) await pauseOwnedChildren(tx, scope, row);
    if (data(row).activationRequestId)
      await cancelActionRequest(
        tx,
        scope,
        data(row).activationRequestId,
        "PLAN_REVISED",
      );
    if (data(row).actionRequestId)
      await cancelActionRequest(
        tx,
        scope,
        data(row).actionRequestId,
        "PLAN_REVISED",
      );
    row = await update(tx, scope, row, {
      ...data(row),
      spec,
      sources,
      specHash,
      revision: Number(data(row).revision) + 1,
      review: null,
      activationRequestId: null,
      status: "proposed",
      actionRequestId: null,
    });
  } else {
    const existing = await tx.entity.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: PLAN_KIND,
        data: { path: ["specHash"], equals: specHash },
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      const view = await planView(tx, scope, existing.id);
      if (
        view.strategicallyReviewed ||
        (view.actionRequest?.status === "pending" &&
          Date.parse(view.actionRequest.expiresAt) > Date.now())
      )
        return view;
    }
    row = await create(tx, scope, PLAN_KIND, {
      schemaVersion: 1,
      spec,
      sources,
      specHash,
      revision: 1,
      status: "proposed",
      review: null,
      actionRequestId: null,
      origin: { userId: scope.userId, conversationId: originConversation },
    });
  }
  const request = await createActionRequest(tx, scope, {
    actionType: "marketing_plan.review",
    payload: {
      planId: row.id,
      revision: data(row).revision,
      specHash,
      spec,
      sourceSnapshot: sources,
    },
    requestedBy: { kind: "agent", userId: scope.userId, agentRunId: null },
  });
  row = await update(tx, scope, row, {
    ...data(row),
    actionRequestId: request.id,
  });
  await audit(
    tx,
    scope,
    changing ? "marketing_plan.revised" : "marketing_plan.proposed",
    row.id,
    { revision: data(row).revision, specHash },
  );
  return planView(tx, scope, row.id);
}
export async function revalidatePlanReview(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
) {
  await planAccess(tx, scope);
  const payload = marketingPlanReview.parse(raw);
  const row = await entity(tx, scope, PLAN_KIND, payload.planId),
    d = data(row);
  if (
    d.revision !== payload.revision ||
    d.specHash !== payload.specHash ||
    hash(d.spec) !== hash(payload.spec) ||
    hash(d.sources) !== hash(payload.sourceSnapshot)
  )
    throw new DomainError("PLAN_REVISION_STALE", 409);
  await validateSaved(tx, scope, row, Boolean(d.activation));
}
export async function recordPlanReview(
  tx: DbTx,
  scope: Scope,
  request: { id: string; data: unknown },
) {
  authorize(moduleScope(scope, "marketing"), PROJECT_OWN, "OWNER_REQUIRED");
  const current = await actorScope(
    scope.workspaceId,
    scope.projectId,
    scope.userId,
  );
  if (current?.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const payload = marketingPlanReview.parse(data(request).payload);
  await revalidatePlanReview(tx, scope, payload);
  const row = await entity(tx, scope, PLAN_KIND, payload.planId),
    d = data(row);
  if (d.actionRequestId !== request.id)
    throw new DomainError("PLAN_REVISION_STALE", 409);
  await update(tx, scope, row, {
    ...d,
    review: {
      requestId: request.id,
      userId: scope.userId,
      at: new Date().toISOString(),
      revision: d.revision,
      specHash: d.specHash,
    },
  });
  await audit(tx, scope, "marketing_plan.reviewed", row.id, {
    revision: d.revision,
    specHash: d.specHash,
    requestId: request.id,
  });
}
export async function planContext(tx: DbTx, scope: Scope) {
  await planAccess(tx, scope);
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  const policy = await activePolicy(tx, scope);
  const p = data(policy);
  const channels = (await list(tx, scope, "connectors"))
    .filter(
      (r) =>
        data(r).provider === "postiz" && connectionVerified(data(r).status),
    )
    .flatMap((r) => assignedPostizChannels(data(r)))
    .filter((c: any) => p.channels?.includes(c.id));
  const profile = await currentMarketingProfile(tx, scope);
  const usable = profile
    ? await listUsableFacts(tx, scope, {
        at: new Date(),
        language: data(profile).contentLanguage,
      })
    : [];
  const sourceRows = new Map(
    (await list(tx, scope, "sources")).map((r) => [r.id, r]),
  );
  const facts = usable.filter((f) => {
    try {
      assertSource(data(sourceRows.get(data(f).sourceId)));
      return true;
    } catch {
      return false;
    }
  });
  const plans = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: PLAN_KIND,
    },
    orderBy: { createdAt: "desc" },
    take: 11,
  });
  const metrics = (await list(tx, scope, "metrics")).slice(0, 11);
  const work = [
    ...(await list(tx, scope, "assignments")),
    ...(await list(tx, scope, "missions")),
  ];
  const month = budgetMonthStart(new Date());
  const reservations = await tx.budgetReservation.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      createdAt: { gte: month },
      state: { not: "released" },
    },
    select: { state: true, amountMicros: true, settledMicros: true },
  });
  const output = {
    asOf: new Date().toISOString(),
    project: {
      id: project.id,
      timezone: project.timezone,
      paused: project.paused,
    },
    marketingProfile: profile
      ? {
          version: profile.version,
          language: data(profile).contentLanguage,
          primaryCtas: data(profile).primaryCtas.slice(0, 5),
          officialLinks: data(profile)
            .officialLinks.slice(0, 5)
            .map((link: any) => ({
              ...link,
              url: String(link.url).slice(0, 600),
            })),
        }
      : null,
    policy: policy
      ? {
          id: policy.id,
          version: policy.version,
          monthlyBudgetMicros: p.monthlyBudgetMicros,
          dailyBudgetMicros: p.dailyBudgetMicros,
          perRunBudgetMicros: p.perRunBudgetMicros,
          approvedPaidTests: p.approvedPaidTests,
          maxPerDay: p.maxPerDay,
          contentTypes: p.contentTypes,
          startAt: p.startAt,
          endAt: p.endAt,
        }
      : null,
    allowedChannels: channels.slice(0, 20).map((c: any) => ({
      id: c.id,
      name: String(c.name ?? c.id).slice(0, 120),
    })),
    readiness: await projectReadiness(tx, scope),
    facts: await Promise.all(
      facts.slice(0, 20).map(async (f) => ({
        id: f.id,
        version: f.version,
        key: String(data(f).key).slice(0, 120),
        value: JSON.stringify(data(f).value).slice(0, 300),
        sourceId: data(f).sourceId,
        sourceVersion: (await entity(tx, scope, "sources", data(f).sourceId))
          .version,
      })),
    ),
    existingPlans: plans.slice(0, 10).map((r) => ({
      id: r.id,
      version: r.version,
      revision: data(r).revision,
      title: data(r).spec.title,
    })),
    existingWork: work.slice(0, 20).map((r) => ({
      id: r.id,
      version: r.version,
      kind: r.kind,
      title: String(data(r).title ?? data(r).name).slice(0, 160),
      status: data(r).status,
    })),
    baselines: metrics.slice(0, 10).map((r) => ({
      id: r.id,
      version: r.version,
      source: data(r).source,
      synthetic: data(r).synthetic === true,
      impressions: data(r).impressions ?? null,
      clicks: data(r).clicks ?? null,
      sessions: data(r).sessions ?? null,
      conversions: data(r).conversions ?? null,
      currency: data(r).currency,
      timezone: data(r).timezone,
      periodStart: data(r).periodStart ?? null,
      periodEnd: data(r).periodEnd ?? null,
    })),
    baselineState: metrics.length ? "measured_records_available" : "no_data",
    budgetLedger: {
      monthStart: month.toISOString(),
      spentMicros: reservations
        .filter((r) => r.state === "settled")
        .reduce((n, r) => n + Number(r.settledMicros ?? 0), 0),
      heldMicros: reservations
        .filter((r) => ["reserved", "in_flight", "unknown"].includes(r.state))
        .reduce((n, r) => n + Number(r.amountMicros), 0),
      unknownCount: reservations.filter((r) => r.state === "unknown").length,
      scope:
        "Read-only projection of the existing ledger; no funds reserved by this plan",
    },
    committedAssignmentBudgetMicros: await committedBudget(tx, scope, null),
    truncation: {
      facts: facts.length > 20,
      plans: plans.length > 10,
      work: work.length > 20,
      metrics: metrics.length > 10,
      byteLimited: false,
      profile:
        !!profile &&
        (data(profile).primaryCtas.length > 5 ||
          data(profile).officialLinks.length > 5 ||
          data(profile).officialLinks.some(
            (link: any) => String(link.url).length > 600,
          )),
    },
    activationAvailable: true,
    activationContextTool: "marketing_plan_activation_context",
    specContract: z.toJSONSchema(marketingPlanSpec, { io: "input" }),
  };
  const bounded = [
    output.facts,
    output.baselines,
    output.existingWork,
    output.existingPlans,
    output.allowedChannels,
  ] as unknown[][];
  for (const items of bounded) {
    while (Buffer.byteLength(JSON.stringify(output)) > 32000 && items.length) {
      items.pop();
      output.truncation.byteLimited = true;
    }
  }
  if (Buffer.byteLength(JSON.stringify(output)) > 32000)
    throw new DomainError("PLAN_CONTEXT_TOO_LARGE", 409);
  return output;
}

async function activationRequestView(tx: DbTx, scope: Scope, id: string) {
  const row = await entity(tx, scope, "action_requests", id),
    d = data(row);
  return {
    id: row.id,
    version: row.version,
    packageHash: d.packageHash,
    status: d.status,
    expiresAt: d.expiresAt,
    payload: d.payload,
  };
}

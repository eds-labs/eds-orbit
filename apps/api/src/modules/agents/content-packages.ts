import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import {
  marketingProfile,
  type Scope,
} from "../../../../../packages/schemas/src/index.ts";
import {
  create,
  data,
  DomainError,
  entity,
  exception,
  hash,
  list,
  update,
} from "../../shared.ts";
import { chatScoped, conversation, validateDraftMission } from "../chat.ts";
import {
  cancelActionRequest,
  createActionRequest,
  decideActionRequest,
} from "../action-requests.ts";
import { currentImageTerms, imageRequestBrief } from "../image-generation.ts";
import { proposeImageRequest } from "../image-requests.ts";
import { markMissionArchived } from "../mission-archive.ts";
import { currentMarketingProfile } from "../marketing-profile.ts";
import { activePolicy } from "../policy.ts";
import { resolveChannelRules } from "../channel-rules.ts";
import { assignedPostizChannels } from "../postiz-assignment.ts";
import { zonedTime } from "../posting-slots.ts";
import { enqueue, reviewContent } from "../workflow.ts";
import { invalidateContent } from "../content-invalidation.ts";

/**
 * Content packages: one chat request becomes one draft-only mission per
 * channel. The plan is deterministic; the start decision is an action request
 * on its hash, and the plan is rebuilt from current data before it starts.
 */
const KIND = "content_packages";
const DRAFT_WINDOW_MS = 7 * 86400000;
const SLOT_WINDOW_MS = 2 * 3600000;
// Reversible default for channels without a configured posting time.
const DEFAULT_POSTING_TIME = "09:00";
// Text revisions per package; their cost is reserved in the confirmed ceiling.
const MAX_REVISIONS = 2;

export function contentPackagesEnabled() {
  return loadConfig().ORBIT_CONTENT_PACKAGES === "true";
}

export const contentPackageRequest = z
  .object({
    goal: z.string().trim().min(5).max(2000),
    audience: z.string().trim().min(1).max(300).optional(),
    channels: z.array(z.string().trim().min(1).max(80)).min(1).max(4),
    factKeys: z.array(z.string().trim().min(1).max(160)).max(8),
    campaignType: z.enum(["product", "presale"]).optional(),
    // Project-local publication date; nothing is published from a package.
    intendedDate: z.iso.date().optional(),
    // Artwork description for one package image; owners only.
    imageBrief: z.string().trim().min(10).max(1000).optional(),
  })
  .strict();
type PackageRequest = z.infer<typeof contentPackageRequest>;

/** Each key needs exactly one Verified Fact that is public, model-usable and valid now. */
async function usableFacts(tx: DbTx, scope: Scope, keys: string[], at: Date) {
  if (!keys.length) throw new DomainError("FACTS_REQUIRED", 409);
  const facts = await list(tx, scope, "facts");
  return [...new Set(keys)].map((key) => {
    const usable = facts.filter((row) => {
      const f = data(row);
      return (
        f.key === key &&
        f.status === "verified" &&
        f.publicUse === true &&
        f.modelUse === true &&
        Date.parse(f.validFrom) <= at.valueOf() &&
        (!f.validUntil || Date.parse(f.validUntil) > at.valueOf())
      );
    });
    if (!usable.length) throw new DomainError("FACT_NOT_USABLE", 409);
    if (usable.length > 1) throw new DomainError("FACT_CONFLICT", 409);
    return usable[0]!;
  });
}

function slotFor(date: string, postingTime: string, timezone: string) {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const [hour, minute] = postingTime.split(":").map(Number) as [number, number];
  return zonedTime(year, month, day, hour, minute, timezone);
}

/** Drafts start now; a planned slot only bounds the window, it never delays drafting. */
function missionWindow(
  now: Date,
  plannedSlotAt: string | null,
  policyEndAt: string,
) {
  const policyEnd = Date.parse(policyEndAt);
  const end = plannedSlotAt
    ? Date.parse(plannedSlotAt) + SLOT_WINDOW_MS
    : now.valueOf() + DRAFT_WINDOW_MS;
  if (plannedSlotAt && end > policyEnd)
    throw new DomainError("PACKAGE_DATE_OUTSIDE_POLICY", 409);
  return {
    startAt: now.toISOString(),
    endAt: new Date(Math.min(end, policyEnd)).toISOString(),
  };
}

/** Deterministic package plan from current project data; equal inputs give an equal hash. */
async function buildPackagePlan(
  tx: DbTx,
  scope: Scope,
  packageId: string,
  request: PackageRequest,
  now = new Date(),
) {
  const facts = await usableFacts(tx, scope, request.factKeys, now);
  const profileRow = await currentMarketingProfile(tx, scope);
  if (!profileRow) throw new DomainError("MARKETING_PROFILE_REQUIRED", 409);
  const profile = marketingProfile.parse(profileRow.data);
  const link = profile.officialLinks[0];
  if (!link) throw new DomainError("CAMPAIGN_TARGET_URL_REQUIRED", 409);
  const policyRow = await activePolicy(tx, scope);
  if (!policyRow) throw new DomainError("POLICY_REQUIRED", 409);
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  const channelNames = new Map(
    (await list(tx, scope, "connectors"))
      .filter((row) => data(row).provider === "postiz")
      .flatMap((row) => assignedPostizChannels(data(row)))
      .map((channel: any) => [channel.id, String(channel.name ?? channel.id)]),
  );
  const deliverables = [];
  let checked: Awaited<ReturnType<typeof validateDraftMission>> | null = null;
  for (const channelId of [...new Set(request.channels)]) {
    const rules = await resolveChannelRules(
      tx,
      scope,
      channelId,
      "social",
      false,
    );
    const plannedSlotAt = request.intendedDate
      ? slotFor(
          request.intendedDate,
          rules.postingTime ?? DEFAULT_POSTING_TIME,
          project.timezone,
        ).toISOString()
      : null;
    if (plannedSlotAt && Date.parse(plannedSlotAt) <= now.valueOf())
      throw new DomainError("PACKAGE_DATE_IN_PAST", 409);
    const platform = rules.providerIdentifier ?? "unknown";
    checked = await validateDraftMission(
      tx,
      scope,
      {
        title: `${platform}: ${request.goal}`.slice(0, 160),
        goal: request.goal,
        audience: request.audience ?? profile.audience,
        product: profile.productName,
        language: profile.contentLanguage,
        channels: [channelId],
        maxContents: 1,
        targetAction: profile.primaryCtas[0],
        targetUrl: link.url,
        sourceIds: [...new Set(facts.map((fact) => data(fact).sourceId))],
        assetIds: [],
        contentType: "social",
        campaignType: request.campaignType ?? "product",
        profileVersion: profileRow.version,
        ...missionWindow(now, plannedSlotAt, data(policyRow).endAt),
      },
      facts.map((fact) => fact.id),
    );
    const { startAt: _start, endAt: _end, ...mission } = checked.parsed;
    deliverables.push({
      key: channelId,
      channelId,
      channelName: channelNames.get(channelId) ?? channelId,
      platform,
      mission,
      plannedSlotAt,
      ceilingMicros: checked.firstDraftMaxMicros,
    });
  }
  let image = null;
  if (request.imageBrief) {
    const { imageConfig } = await currentImageTerms(tx, scope);
    image = {
      brief: imageRequestBrief.parse({
        name: `Package image: ${request.goal}`.slice(0, 160),
        prompt: request.imageBrief,
        size: "1024x1024",
        quality: "medium",
        background: "opaque",
        validUses: ["social"],
        channel: "Social",
      }),
      model: imageConfig.model,
      maxCostMicros: imageConfig.maxCostMicrosPerImage,
    };
  }
  const revisionReserveMicros =
    MAX_REVISIONS *
    Math.max(...deliverables.map((deliverable) => deliverable.ceilingMicros));
  const ceilingMicros =
    deliverables.reduce(
      (sum, deliverable) => sum + deliverable.ceilingMicros,
      0,
    ) +
    (image?.maxCostMicros ?? 0) +
    revisionReserveMicros;
  // All paid calls of a package share one run key, so one per-run limit covers them.
  if (ceilingMicros > checked!.policy.perRunBudgetMicros)
    throw new DomainError("RUN_BUDGET_EXCEEDED", 409);
  // Stored plans went through JSON; normalizing here keeps rebuilt hashes comparable.
  return normalized({
    packageId,
    request,
    profileVersion: profileRow.version,
    policy: { id: policyRow.id, version: policyRow.version },
    projectGeneration: project.generation,
    facts: facts.map((fact) => ({
      id: fact.id,
      version: fact.version,
      key: data(fact).key as string,
    })),
    sources: checked!.sourceRows.map((row) => ({
      id: row.id,
      version: row.version,
    })),
    index: { id: checked!.index.id, model: checked!.index.model },
    draftModel: checked!.draftModel,
    deliverables,
    image,
    revisionReserveMicros,
    ceilingMicros,
  });
}
const normalized = <T>(value: T): T => JSON.parse(JSON.stringify(value));
type PackagePlan = Awaited<ReturnType<typeof buildPackagePlan>>;

/** Saves a proposed package and its start request; nothing runs before the user confirms it. */
export async function requestContentPackage(
  scope: Scope,
  conversationId: string,
  raw: unknown,
) {
  if (scope.role === "viewer") throw new DomainError("EDITOR_REQUIRED", 403);
  if (!contentPackagesEnabled())
    throw new DomainError("CONTENT_PACKAGES_DISABLED", 409);
  const request = contentPackageRequest.parse(raw);
  return chatScoped(scope, async (tx) => {
    await conversation(tx, scope, conversationId);
    const pkg = await create(tx, scope, KIND, {
      conversationId,
      userId: scope.userId,
      goal: request.goal,
      status: "proposed",
    });
    const plan = await buildPackagePlan(tx, scope, pkg.id, request);
    const actionRequest = await createActionRequest(tx, scope, {
      actionType: "content_package.start",
      payload: plan,
      requestedBy: { kind: "agent", userId: scope.userId, agentRunId: null },
    });
    const saved = await update(tx, scope, pkg, {
      ...data(pkg),
      actionRequestId: actionRequest.id,
      ceilingMicros: plan.ceilingMicros,
      image: plan.image
        ? {
            prompt: plan.image.brief.prompt,
            maxCostMicros: plan.image.maxCostMicros,
          }
        : null,
      deliverables: plan.deliverables.map(
        ({ key, channelId, channelName, platform, plannedSlotAt }) => ({
          key,
          channelId,
          channelName,
          platform,
          plannedSlotAt,
        }),
      ),
    });
    return { package: saved, actionRequest };
  });
}

/** Decision check: only the requester starts a package, and only an unchanged plan. */
export async function revalidateContentPackage(
  tx: DbTx,
  scope: Scope,
  payload: Record<string, unknown>,
) {
  if (!contentPackagesEnabled())
    throw new DomainError("CONTENT_PACKAGES_DISABLED", 409);
  const plan = payload as PackagePlan;
  const pkg = await entity(tx, scope, KIND, plan.packageId);
  if (data(pkg).userId !== scope.userId)
    throw new DomainError("FORBIDDEN", 403);
  const current = await buildPackagePlan(
    tx,
    scope,
    plan.packageId,
    contentPackageRequest.parse(plan.request),
  );
  if (hash(current) !== hash(plan)) throw new DomainError("PACKAGE_STALE", 409);
}

/** Runs on approval: one ready draft-only mission and generation job per channel, starting now. */
export async function startContentPackage(
  tx: DbTx,
  scope: Scope,
  request: { data: unknown },
) {
  const plan = data(request).payload as PackagePlan;
  const pkg = await entity(tx, scope, KIND, plan.packageId);
  if (data(pkg).status !== "proposed") return;
  const policyRow = await activePolicy(tx, scope);
  if (!policyRow) throw new DomainError("POLICY_REQUIRED", 409);
  const now = new Date();
  const steps = [];
  for (const deliverable of plan.deliverables) {
    const mission = await create(tx, scope, "missions", {
      ...deliverable.mission,
      ...missionWindow(now, deliverable.plannedSlotAt, data(policyRow).endAt),
      ...(deliverable.plannedSlotAt
        ? { plannedSlotAt: deliverable.plannedSlotAt }
        : {}),
      status: "ready",
      factKeys: plan.facts.map((fact) => fact.key),
      packageId: plan.packageId,
      budgetRunKey: `package:${plan.packageId}`,
      chatCostCeilingMicros: deliverable.ceilingMicros,
      mediaPlanned: Boolean(plan.image),
    });
    // Same key as the project sweep, so the draft is queued once.
    const job = await enqueue(
      tx,
      scope,
      "generation",
      mission.id,
      "mission:" + mission.id + ":" + mission.version,
      now,
    );
    steps.push({
      key: deliverable.key,
      kind: "copy",
      missionId: mission.id,
      jobId: job.id,
    });
  }
  if (plan.image) {
    const imageRequest = await proposeImageRequest(
      tx,
      scope,
      plan.image.brief,
      { kind: "user", userId: scope.userId },
      { budgetRunKey: `package:${plan.packageId}` },
    );
    // An owner's start click covers the shown prompt and image ceiling;
    // an editor's image waits in the owners' approval inbox.
    if (scope.role === "owner")
      await decideActionRequest(tx, scope, imageRequest.id, {
        version: imageRequest.version,
        packageHash: data(imageRequest).packageHash,
        decision: "approve",
      });
    steps.push({
      key: "image",
      kind: "image",
      actionRequestId: imageRequest.id,
    });
  }
  await update(tx, scope, pkg, {
    ...data(pkg),
    status: "started",
    startedAt: now.toISOString(),
    steps,
  });
}

/** Current package state, derived from its start request, jobs and persisted drafts. */
export async function packageSnapshot(
  tx: DbTx,
  scope: Scope,
  pkg: { id: string; version: number; createdAt: Date; data: unknown },
) {
  const d = data(pkg);
  const request = d.actionRequestId
    ? await entity(tx, scope, "action_requests", d.actionRequestId)
    : null;
  const r = data(request);
  const canceled = d.status === "canceled";
  const steps = (d.steps ?? []) as Array<Record<string, any>>;
  const deliverables = [];
  for (const deliverable of d.deliverables ?? []) {
    const step = steps.find(
      (candidate) =>
        candidate.kind === "copy" && candidate.key === deliverable.key,
    );
    let status = "planned";
    let content = null as null | Record<string, unknown>;
    let errorCode = null as string | null;
    let review = null as null | { valid: boolean; problems: string[] };
    let revisions = 0;
    let revisionError = null as string | null;
    let schedule = null as Awaited<ReturnType<typeof scheduleState>>;
    if (canceled && !step) status = "canceled";
    if (step) {
      const current = await currentDraft(tx, scope, step);
      const { draft, reused } = current;
      revisions = current.revisions;
      revisionError = current.revisionError;
      schedule = await scheduleState(
        tx,
        scope,
        step.schedule,
        draft,
        step.reschedule,
      );
      const job = await tx.entity.findFirst({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "jobs",
          id: step.jobId,
        },
      });
      if (draft) {
        status = current.pending ? "revising" : "drafted";
        content = {
          id: draft.id,
          version: draft.version,
          channel: data(draft).channel,
          body: data(draft).body,
          status: data(draft).status,
          scheduledAt: data(draft).scheduledAt ?? null,
          assetId: data(draft).assetId ?? null,
          reused,
        };
        review = data(draft).review ?? null;
      } else if (data(job).status === "canceled") status = "canceled";
      else if (["blocked_dependency", "failed"].includes(data(job).status)) {
        status = "failed";
        errorCode = data(job).error ?? null;
      } else if (data(job).status === "running") status = "running";
      else status = canceled ? "canceled" : "queued";
    }
    deliverables.push({
      ...deliverable,
      status,
      content,
      errorCode,
      review,
      revisions,
      revisionError,
      schedule,
    });
  }
  const image = d.image ? await imageState(tx, scope, d.image, steps) : null;
  const states = deliverables.map((deliverable) => deliverable.status);
  const waiting =
    states.some((state) => ["queued", "running", "revising"].includes(state)) ||
    ["queued", "running", "awaiting_approval"].includes(image?.status ?? "");
  const status = canceled
    ? "canceled"
    : d.status === "proposed"
      ? r.status === "rejected"
        ? "rejected"
        : Date.parse(r.expiresAt) <= Date.now()
          ? "expired"
          : "proposed"
      : waiting
        ? "running"
        : states.every((state) => state === "drafted") &&
            (!image || image.status === "generated")
          ? "completed"
          : states.some((state) => state === "drafted") ||
              image?.status === "generated"
            ? "partially_completed"
            : "failed";
  return {
    id: pkg.id,
    version: pkg.version,
    goal: d.goal,
    status,
    ceilingMicros: d.ceilingMicros ?? null,
    createdAt: pkg.createdAt,
    image,
    actionRequest: request
      ? {
          id: request.id,
          version: request.version,
          packageHash: r.packageHash,
          status: r.status,
          expiresAt: r.expiresAt,
        }
      : null,
    deliverables,
  };
}

/**
 * A deliverable's schedule from its decision request and publication; the
 * publication status is the truth once the owner approved.
 */
async function scheduleState(
  tx: DbTx,
  scope: Scope,
  schedule: Record<string, any> | undefined,
  draft: { id: string; version: number } | null,
  reschedule?: Record<string, any>,
) {
  if (!schedule) return null;
  const where = { workspaceId: scope.workspaceId, projectId: scope.projectId };
  // A proposal's state from its request: waiting, stale, expired or decided.
  const proposalState = async (proposal: Record<string, any>) => {
    const request = await tx.entity.findFirst({
      where: {
        ...where,
        kind: "action_requests",
        id: proposal.actionRequestId,
      },
    });
    const r = data(request);
    let status = String(r.status);
    if (r.status === "pending")
      status =
        Date.parse(r.expiresAt) <= Date.now()
          ? "expired"
          : draft?.id !== r.payload?.contentId ||
              draft?.version !== r.payload?.contentVersion
            ? "stale"
            : "awaiting_approval";
    return { status, executionMode: r.payload?.executionMode ?? null };
  };
  const base = {
    scheduledAt: schedule.scheduledAt as string,
    contentId: schedule.contentId as string,
    actionRequestId: schedule.actionRequestId as string,
  };
  // A move waits for its own decision; the post keeps its slot until then.
  const move = reschedule
    ? {
        scheduledAt: reschedule.scheduledAt as string,
        actionRequestId: reschedule.actionRequestId as string,
        status: (await proposalState(reschedule)).status,
      }
    : null;
  const proposal = await proposalState(schedule);
  if (schedule.publicationId) {
    const publication = await tx.entity.findFirst({
      where: { ...where, kind: "publications", id: schedule.publicationId },
    });
    const p = data(publication);
    return {
      ...base,
      executionMode: proposal.executionMode,
      status: p.status === "intent_created" ? "scheduled" : String(p.status),
      publicationId: schedule.publicationId as string,
      blockers: (p.blockers as string[] | undefined) ?? [],
      move,
    };
  }
  return {
    ...base,
    executionMode: proposal.executionMode,
    status: proposal.status,
    publicationId: null,
    blockers: [] as string[],
    move,
  };
}

/** The requesting user's packages in one conversation, newest first. */
export async function conversationPackages(
  tx: DbTx,
  scope: Scope,
  conversationId: string,
) {
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: KIND,
      AND: [
        { data: { path: ["conversationId"], equals: conversationId } },
        { data: { path: ["userId"], equals: scope.userId } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const snapshots = [];
  for (const row of rows) snapshots.push(await packageSnapshot(tx, scope, row));
  return snapshots;
}

/** Image step state from its request, job, reservation and asset; never a model claim. */
async function imageState(
  tx: DbTx,
  scope: Scope,
  planned: { prompt: string; maxCostMicros: number },
  steps: Array<Record<string, any>>,
) {
  const base = {
    prompt: planned.prompt,
    maxCostMicros: planned.maxCostMicros,
    assetId: null as string | null,
    href: null as string | null,
    errorCode: null as string | null,
    assetVersion: null as number | null,
    rightsApproved: false,
  };
  const step = steps.find((candidate) => candidate.kind === "image");
  if (!step) return { ...base, status: "planned" };
  const where = { workspaceId: scope.workspaceId, projectId: scope.projectId };
  const request = data(
    await entity(tx, scope, "action_requests", step.actionRequestId),
  );
  const asset = await tx.entity.findFirst({
    where: {
      ...where,
      kind: "assets",
      data: { path: ["generationId"], equals: step.actionRequestId },
    },
  });
  if (asset)
    return {
      ...base,
      status: "generated",
      assetId: asset.id,
      assetVersion: asset.version,
      // The owner's rights decision on the asset; only then can drafts use it.
      rightsApproved:
        data(asset).usageApproved === true &&
        data(asset).assetStatus === "approved",
      href: `/api/projects/${scope.projectId}/assets/${asset.id}/content`,
    };
  if (request.status === "canceled") return { ...base, status: "canceled" };
  if (request.status === "rejected")
    return { ...base, status: "failed", errorCode: "IMAGE_REJECTED" };
  if (request.status === "pending")
    return Date.parse(request.expiresAt) <= Date.now()
      ? { ...base, status: "failed", errorCode: "IMAGE_APPROVAL_EXPIRED" }
      : { ...base, status: "awaiting_approval" };
  const reservation = await tx.budgetReservation.findFirst({
    where: {
      projectId: scope.projectId,
      key: `${scope.projectId}:image:${step.actionRequestId}`,
    },
  });
  // Sent without a stored result: reconcile, never send again.
  if (reservation) return { ...base, status: "outcome_unknown" };
  const job = await tx.entity.findFirst({
    where: {
      ...where,
      kind: "jobs",
      data: { path: ["resourceId"], equals: step.actionRequestId },
    },
  });
  const jobStatus = data(job).status;
  if (["blocked_dependency", "failed", "canceled"].includes(jobStatus))
    return {
      ...base,
      status: jobStatus === "canceled" ? "canceled" : "failed",
      errorCode: data(job).error ?? null,
    };
  if (request.status !== "approved" && request.status !== "consumed")
    return { ...base, status: "failed", errorCode: "IMAGE_NOT_APPROVED" };
  return { ...base, status: jobStatus === "running" ? "running" : "queued" };
}

/**
 * Stops what has not started: the start or image decision, queued jobs and
 * missions without a draft. Drafts, running jobs and sent requests stay and
 * are reported as they are.
 */
export async function cancelContentPackage(scope: Scope, packageId: string) {
  return chatScoped(scope, async (tx) => {
    const pkg = await entity(tx, scope, KIND, packageId);
    const d = data(pkg);
    if (d.userId !== scope.userId) throw new DomainError("NOT_FOUND", 404);
    if (d.status === "canceled") return packageSnapshot(tx, scope, pkg);
    if (d.actionRequestId)
      await cancelActionRequest(tx, scope, d.actionRequestId);
    const jobs = await list(tx, scope, "jobs");
    // Returns whether a job for the resource is already running.
    const cancelQueued = async (resourceId: string) => {
      let running = false;
      for (const job of jobs.filter(
        (row) => data(row).resourceId === resourceId,
      )) {
        if (data(job).status === "running") running = true;
        if (["queued", "retry_scheduled"].includes(data(job).status))
          await update(tx, scope, job, {
            ...data(job),
            status: "canceled",
            error: "PACKAGE_CANCELED",
          });
      }
      return running;
    };
    for (const step of (d.steps ?? []) as Array<Record<string, any>>) {
      if (step.kind === "image") {
        await cancelActionRequest(tx, scope, step.actionRequestId);
        await cancelQueued(step.actionRequestId);
        continue;
      }
      const missionIds = [
        step.missionId,
        ...(step.revisions ?? []).map(
          (r: { missionId: string }) => r.missionId,
        ),
      ];
      for (const missionId of missionIds) {
        if (await cancelQueued(missionId)) continue;
        const mission = await entity(tx, scope, "missions", missionId);
        const { draft } = await stepDraft(tx, scope, missionId);
        if (!draft && data(mission).status === "ready")
          await markMissionArchived(tx, scope, mission);
      }
    }
    const saved = await update(tx, scope, pkg, {
      ...d,
      status: "canceled",
      canceledAt: new Date().toISOString(),
    });
    return packageSnapshot(tx, scope, saved);
  });
}

/** Project sweep: reviews new package drafts with the existing claim checks. */
export async function advanceContentPackages(tx: DbTx, scope: Scope) {
  for (const pkg of await list(tx, scope, KIND)) {
    if (data(pkg).status !== "started") continue;
    for (const step of (data(pkg).steps ?? []) as Array<Record<string, any>>) {
      if (step.kind !== "copy") continue;
      // A finished revision replaces its parent: the parent's approvals and publications are blocked.
      for (const revision of step.revisions ?? []) {
        const { draft: revised } = await stepDraft(
          tx,
          scope,
          revision.missionId,
        );
        if (!revised) continue;
        const parent = await entity(
          tx,
          scope,
          "content",
          revision.parentContentId,
        );
        // A reused draft belongs to another package; only its own drafts are replaced.
        if (
          data(parent).supersededBy ||
          !(await isPackageDraft(tx, scope, pkg.id, parent))
        )
          continue;
        await update(tx, scope, parent, {
          ...data(parent),
          supersededBy: revised.id,
          supersededAt: new Date().toISOString(),
        });
        await invalidateContent(tx, scope, parent.id);
      }
      const { draft } = await currentDraft(tx, scope, step);
      if (draft) {
        if (data(draft).status !== "draft" || data(draft).review) continue;
        try {
          await reviewContent(tx, scope, draft.id, draft.version);
        } catch (error) {
          // One unreviewable draft must not stop the project sweep.
          if (!(error instanceof DomainError)) throw error;
          await exception(tx, scope, error.code, draft.id);
        }
      }
    }
  }
}

/** Whether a draft was written by one of this package's missions, not reused from elsewhere. */
export async function isPackageDraft(
  tx: DbTx,
  scope: Scope,
  packageId: string,
  draft: { data: unknown },
) {
  const mission = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "missions",
      id: String(data(draft).missionId ?? ""),
    },
  });
  return data(mission).packageId === packageId;
}

/**
 * Refuses a draft that generation reused from another package: it may be
 * scheduled or changed only from its own package. Revising creates an own draft.
 */
export async function assertPackageDraft(
  tx: DbTx,
  scope: Scope,
  packageId: string,
  draft: { data: unknown },
) {
  if (!(await isPackageDraft(tx, scope, packageId, draft)))
    throw new DomainError("DRAFT_REUSED", 409);
}

/** A step's draft: its own, or the identical earlier draft its mission reused. */
async function stepDraft(tx: DbTx, scope: Scope, missionId: string) {
  const where = { workspaceId: scope.workspaceId, projectId: scope.projectId };
  const own = await tx.entity.findFirst({
    where: {
      ...where,
      kind: "content",
      data: { path: ["missionId"], equals: missionId },
    },
    orderBy: { createdAt: "desc" },
  });
  if (own) return { draft: own, reused: false };
  const mission = await tx.entity.findFirst({
    where: { ...where, kind: "missions", id: missionId },
  });
  const lastContentId = data(mission).lastContentId;
  const reused = lastContentId
    ? await tx.entity.findFirst({
        where: { ...where, kind: "content", id: lastContentId },
      })
    : null;
  return { draft: reused, reused: Boolean(reused) };
}

/**
 * The draft a deliverable shows: the newest revision that produced one, else
 * the original. A queued or running revision keeps the previous draft visible.
 */
export async function currentDraft(
  tx: DbTx,
  scope: Scope,
  step: Record<string, any>,
) {
  let current = {
    ...(await stepDraft(tx, scope, step.missionId)),
    revisions: 0,
    pending: false,
    revisionError: null as string | null,
  };
  for (const [index, revision] of (step.revisions ?? []).entries()) {
    const { draft } = await stepDraft(tx, scope, revision.missionId);
    if (draft) {
      current = {
        draft,
        reused: false,
        revisions: index + 1,
        pending: false,
        revisionError: null,
      };
      continue;
    }
    const job = await tx.entity.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "jobs",
        id: revision.jobId,
      },
    });
    const state = data(job).status;
    current = ["blocked_dependency", "failed", "canceled"].includes(state)
      ? { ...current, pending: false, revisionError: data(job).error ?? state }
      : { ...current, pending: true };
  }
  return current;
}

/** One channel's step in the user's latest started package of a conversation. */
export async function startedDeliverable(
  tx: DbTx,
  scope: Scope,
  conversationId: string,
  deliverableKey: string,
) {
  await conversation(tx, scope, conversationId);
  const pkg = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: KIND,
      AND: [
        { data: { path: ["conversationId"], equals: conversationId } },
        { data: { path: ["userId"], equals: scope.userId } },
      ],
    },
    orderBy: { createdAt: "desc" },
  });
  if (!pkg) throw new DomainError("NOT_FOUND", 404);
  if (data(pkg).status !== "started")
    throw new DomainError("PACKAGE_NOT_STARTED", 409);
  const steps = (data(pkg).steps ?? []) as Array<Record<string, any>>;
  const step = steps.find(
    (candidate) =>
      candidate.kind === "copy" && candidate.key === deliverableKey,
  );
  if (!step) throw new DomainError("DELIVERABLE_NOT_FOUND", 404);
  return { pkg, steps, step };
}

export const deliverableRevision = z
  .object({
    deliverableKey: z.string().trim().min(1).max(80),
    instruction: z.string().trim().min(3).max(500),
  })
  .strict();

/**
 * Revises one channel's current draft in the conversation's latest package.
 * Covered by the confirmed package ceiling; other channels and the image stay as they are.
 */
export async function reviseDeliverable(
  scope: Scope,
  conversationId: string,
  raw: unknown,
) {
  if (scope.role === "viewer") throw new DomainError("EDITOR_REQUIRED", 403);
  if (!contentPackagesEnabled())
    throw new DomainError("CONTENT_PACKAGES_DISABLED", 409);
  const input = deliverableRevision.parse(raw);
  return chatScoped(scope, async (tx) => {
    const { pkg, steps, step } = await startedDeliverable(
      tx,
      scope,
      conversationId,
      input.deliverableKey,
    );
    const d = data(pkg);
    const used = steps.reduce(
      (sum, candidate) => sum + (candidate.revisions?.length ?? 0),
      0,
    );
    if (used >= MAX_REVISIONS)
      throw new DomainError("PACKAGE_REVISION_LIMIT", 409);
    const current = await currentDraft(tx, scope, step);
    if (current.pending) throw new DomainError("REVISION_IN_PROGRESS", 409);
    if (!current.draft) throw new DomainError("DRAFT_REQUIRED", 409);
    const plan = data(
      await entity(tx, scope, "action_requests", d.actionRequestId),
    ).payload as PackagePlan;
    const deliverable = plan.deliverables.find(
      (candidate) => candidate.key === step.key,
    )!;
    const spent = await packageSpentMicros(tx, scope, pkg.id);
    if (spent + deliverable.ceilingMicros > d.ceilingMicros)
      throw new DomainError("PACKAGE_BUDGET_EXHAUSTED", 409);
    const now = new Date();
    const policyRow = await activePolicy(tx, scope);
    if (!policyRow) throw new DomainError("POLICY_REQUIRED", 409);
    // A revision is checked against current facts and profile like a new draft.
    const facts = await usableFacts(tx, scope, plan.request.factKeys, now);
    const checked = await validateDraftMission(
      tx,
      scope,
      {
        ...deliverable.mission,
        ...missionWindow(now, deliverable.plannedSlotAt, data(policyRow).endAt),
      },
      facts.map((fact) => fact.id),
    );
    const mission = await create(tx, scope, "missions", {
      ...checked.parsed,
      ...(deliverable.plannedSlotAt
        ? { plannedSlotAt: deliverable.plannedSlotAt }
        : {}),
      status: "ready",
      factKeys: facts.map((fact) => data(fact).key),
      packageId: pkg.id,
      budgetRunKey: `package:${pkg.id}`,
      chatCostCeilingMicros: deliverable.ceilingMicros,
      mediaPlanned: Boolean(plan.image),
      revisionOf: {
        contentId: current.draft.id,
        version: current.draft.version,
        instruction: input.instruction,
      },
    });
    const job = await enqueue(
      tx,
      scope,
      "generation",
      mission.id,
      "mission:" + mission.id + ":" + mission.version,
      now,
    );
    const saved = await update(tx, scope, pkg, {
      ...d,
      steps: steps.map((candidate) =>
        candidate === step
          ? {
              ...step,
              revisions: [
                ...(step.revisions ?? []),
                {
                  missionId: mission.id,
                  jobId: job.id,
                  instruction: input.instruction,
                  parentContentId: current.draft!.id,
                  requestedAt: now.toISOString(),
                },
              ],
            }
          : candidate,
      ),
    });
    return packageSnapshot(tx, scope, saved);
  });
}

/** Reserved or settled cost of all paid calls under the package run key. */
async function packageSpentMicros(tx: DbTx, scope: Scope, packageId: string) {
  const run = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "budget_runs",
      data: { path: ["runKey"], equals: `package:${packageId}` },
    },
  });
  if (!run) return 0;
  const rows = await tx.budgetReservation.findMany({
    where: {
      projectId: scope.projectId,
      id: { in: data(run).reservationIds },
      state: { not: "released" },
    },
  });
  return rows.reduce(
    (sum, row) =>
      sum +
      Number(row.state === "settled" ? row.settledMicros : row.amountMicros),
    0,
  );
}

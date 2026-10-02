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
  const ceilingMicros =
    deliverables.reduce(
      (sum, deliverable) => sum + deliverable.ceilingMicros,
      0,
    ) + (image?.maxCostMicros ?? 0);
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
  // Image decisions belong to owners; there is no owner inbox for editors' packages yet.
  if (request.imageBrief && scope.role !== "owner")
    throw new DomainError("IMAGE_OWNER_REQUIRED", 403);
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
  if (plan.image && scope.role !== "owner")
    throw new DomainError("IMAGE_OWNER_REQUIRED", 403);
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
    // The owner's start click covered the shown prompt and image ceiling.
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
    if (canceled && !step) status = "canceled";
    if (step) {
      const { draft, reused } = await stepDraft(tx, scope, step.missionId);
      const job = await tx.entity.findFirst({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "jobs",
          id: step.jobId,
        },
      });
      if (draft) {
        status = "drafted";
        content = {
          id: draft.id,
          version: draft.version,
          channel: data(draft).channel,
          body: data(draft).body,
          status: data(draft).status,
          scheduledAt: data(draft).scheduledAt ?? null,
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
    deliverables.push({ ...deliverable, status, content, errorCode, review });
  }
  const image = d.image ? await imageState(tx, scope, d.image, steps) : null;
  const states = deliverables.map((deliverable) => deliverable.status);
  const waiting =
    states.some((state) => state === "queued" || state === "running") ||
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
      href: `/api/projects/${scope.projectId}/assets/${asset.id}/content`,
    };
  if (request.status === "canceled") return { ...base, status: "canceled" };
  if (request.status === "pending")
    return { ...base, status: "awaiting_approval" };
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
    for (const step of (d.steps ?? []) as Array<Record<string, any>>) {
      const resourceId =
        step.kind === "image" ? step.actionRequestId : step.missionId;
      if (step.kind === "image")
        await cancelActionRequest(tx, scope, step.actionRequestId);
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
      if (step.kind !== "copy" || running) continue;
      const mission = await entity(tx, scope, "missions", step.missionId);
      const { draft } = await stepDraft(tx, scope, step.missionId);
      if (!draft && data(mission).status === "ready")
        await markMissionArchived(tx, scope, mission);
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
      const { draft } = await stepDraft(tx, scope, step.missionId);
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

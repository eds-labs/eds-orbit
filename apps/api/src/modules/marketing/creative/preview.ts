import { z } from "zod";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import {
  CREATIVE_FORMAT_IDS,
  CREATIVE_FORMATS,
  CREATIVE_TEMPLATE_IDS,
  CREATIVE_VARIANT_IDS,
  encodePreviewJpeg,
  formatsForChannel,
  LOGO_PLACEMENTS,
} from "../../../../../../packages/creative/src/index.ts";
import {
  id as idSchema,
  type Scope,
} from "../../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import { enqueue } from "../../../platform/jobs/enqueue.ts";
import { actorScope } from "../../../platform/tenancy/member-scope.ts";
import { moduleScope } from "../../../platform/tenancy/module-roles.ts";
import {
  authorize,
  PROJECT_OWN,
} from "../../../platform/tenancy/permissions.ts";
import { create, data, DomainError, entity, update } from "../../../shared.ts";
import { assertMandateStillAuthorizes } from "../../../platform/governance/authorization.ts";
import type { AgentMandateRecord } from "../../../platform/governance/agent-mandates.ts";
import { currentImageTerms } from "../brand/image-generation.ts";
import { generateArt, planArt, type ArtRequest } from "./art.ts";
import { assetBytes } from "../../assets.ts";
import { resolveBrandKit } from "./brand-kit.ts";
import { artDirectionInput, resolveCreativeBrief } from "./brief.ts";
import { artAsset, productAsset, projectRow } from "./components.ts";
import { creativeStudioEnabled } from "./flag.ts";
import {
  assertSourcesHold,
  storeComposed,
  type CreativePlan,
} from "./persist.ts";
import {
  checkedArtDirection,
  checkedCreativePlan,
  composePlan,
  creativeCopyOf,
  shownProducts,
  trialComposition,
} from "./pipeline.ts";
import { findCreative, type CreativeRecord } from "./store.ts";

// Internal creative previews (MCP and the assistant): one finished creative
// with its post text, made once from the brand kit and never attached,
// scheduled, published or sent to Postiz. The owner's approval of the
// proposal (operation-tools) covers its exact image ceiling and art prompt;
// a worker job then plans, pays for at most one image, composes and stores
// the creative under the preview. Every building block is the studio's own.

export const CREATIVE_PREVIEWS = "creative_previews";
export const PREVIEW_QUEUE = "creative_preview";
/** The largest budget limit one preview may name (USD 2). */
export const PREVIEW_BUDGET_MAX = 2_000_000;

const copyText = z.string().max(500);
/** What a client asks a preview for. */
export const previewInput = z
  .object({
    // The channel's provider identifier (instagram, linkedin, x, ...): it picks the format.
    channel: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u),
    // A format the client chooses instead of the channel's (for example feed_portrait, 1080x1350).
    format: z.enum(CREATIVE_FORMAT_IDS).optional(),
    language: z
      .string()
      .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/u)
      .optional(),
    title: z.string().trim().min(1).max(200),
    // The post text the client wrote; Orbit checks it, it never publishes it.
    postText: z.string().trim().min(1).max(5000),
    copy: z
      .object({
        eyebrow: copyText.optional(),
        headline: copyText,
        subline: copyText.optional(),
        cta: copyText.optional(),
      })
      .strict(),
    template: z.enum(CREATIVE_TEMPLATE_IDS).optional(),
    variant: z.enum(CREATIVE_VARIANT_IDS).optional(),
    // New art (one paid image), an approved art asset, or none (a template without art).
    art: z.enum(["generate", "asset", "none"]),
    artAssetId: idSchema.optional(),
    artDirection: artDirectionInput.optional(),
    productAssetId: idSchema.optional(),
    logoPlacement: z.enum(LOGO_PLACEMENTS).optional(),
    // The preview's own limit in USD millionths; the project's policy still applies.
    maxBudgetMicros: z.number().int().min(0).max(PREVIEW_BUDGET_MAX),
  })
  .strict();
export type PreviewInput = z.infer<typeof previewInput>;

export type PreviewStatus =
  "queued" | "running" | "completed" | "failed" | "blocked";
type PreviewPhase = "queued" | "planning" | "art" | "composing" | "done";
const PROGRESS: Record<PreviewPhase, number> = {
  queued: 0,
  planning: 10,
  art: 30,
  composing: 80,
  done: 100,
};

/** One preview as stored. */
export type PreviewRecord = {
  status: PreviewStatus;
  phase: PreviewPhase;
  /** The member who proposed it; the job runs with their current role. */
  actorId: string;
  request: PreviewInput;
  /** The approved image ceiling (0 without new art). */
  ceilingMicros: number;
  /** The approved art prompt, compared before the image is paid for. */
  artPrompt: string | null;
  /** The approved brand kit profile version, compared before anything is made. */
  profileVersion: number;
  /** Posts of this project with exactly this text (duplicate check). */
  duplicateContentIds: string[];
  /**
   * The agent mandate that approved the proposal (ADR 0019), or null for a
   * person's approval. Its work stops before payment once it ended.
   */
  mandate?: { id: string; version: number } | null;
  creativeId?: string;
  artAssetId?: string;
  errorCode?: string;
  blockers?: string[];
  cost: { settledMicros: number; unknownMicros: number };
  startedAt?: string;
  completedAt?: string;
};

/**
 * Plans a preview in `tx` with the studio's own steps: the brand kit, the
 * brief for the chosen or the channel's format, the components and every
 * free check of the copy and the rights; with `art: "generate"` (owner only)
 * the image request at `ceilingMicros` (the current ceiling when absent).
 * With `pendingArtId` the plan draws that new art instead. Nothing is stored.
 */
export async function planPreview(
  tx: DbTx,
  scope: Scope,
  input: PreviewInput,
  options: { ceilingMicros?: number; pendingArtId?: string } = {},
): Promise<{ plan: CreativePlan; art: ArtRequest | null }> {
  if (!creativeStudioEnabled()) throw new DomainError("NOT_FOUND", 404);
  const generate = input.art === "generate";
  if (generate) authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  // A chosen art shows what it shows; an art direction is for new art (R31).
  if (
    (input.art === "asset") !== Boolean(input.artAssetId) ||
    (input.artDirection && !generate)
  )
    throw new DomainError("INVALID_TEMPLATE_INPUT", 400);
  const artDirection = checkedArtDirection(input.artDirection);
  const copy = creativeCopyOf(input.copy);
  const kit = await resolveBrandKit(tx, scope);
  const art = options.pendingArtId
    ? await artAsset(tx, scope, options.pendingArtId)
    : input.artAssetId
      ? await artAsset(tx, scope, input.artAssetId)
      : null;
  const explicit = input.productAssetId
    ? [await productAsset(tx, scope, input.productAssetId)]
    : [];
  const candidates = explicit.length ? explicit : kit.products;
  const brief = resolveCreativeBrief({
    proposal: null,
    content: { title: input.title },
    profile: kit.profile,
    config: kit.config,
    hasProducts: candidates.length > 0,
    channelFormats: input.format
      ? [input.format]
      : formatsForChannel(input.channel, kit.config.formatsByChannel),
    origin: "manual",
    template: input.template,
    variant: input.variant,
    artDirection,
  });
  const products = shownProducts(brief, candidates);
  // A named product the layout does not show would be dropped silently (R31).
  if (explicit.length && !products.length)
    throw new DomainError("INVALID_TEMPLATE_INPUT", 400);
  const plan = await checkedCreativePlan(
    tx,
    scope,
    {
      kit,
      brief,
      copy,
      options: {
        logoPlacement: input.logoPlacement ?? kit.config.logoPlacement,
        textScale: "m",
      },
      variantFixed: input.variant !== undefined,
      art,
      products,
    },
    null,
    {
      artToCome: generate && !options.pendingArtId,
      pendingArtId: options.pendingArtId,
    },
  );
  if (!generate || options.pendingArtId) return { plan, art: null };
  const ceilingMicros =
    options.ceilingMicros ??
    (await currentImageTerms(tx, scope)).imageConfig.maxCostMicrosPerImage;
  return {
    plan,
    art: await planArt(tx, scope, plan, input.title, {
      confirmMaximumCostMicros: ceilingMicros,
      confirmPromptMayBeSentToProvider: true,
    }),
  };
}

/** The image ceiling a preview reserves: the configured one for new art, else 0. */
export async function previewCeiling(
  tx: DbTx,
  scope: Scope,
  input: PreviewInput,
): Promise<number> {
  if (input.art !== "generate") return 0;
  return (await currentImageTerms(tx, scope)).imageConfig.maxCostMicrosPerImage;
}

/**
 * Checks a proposal before it is saved and again when it is approved: the
 * plan (free) and the preview's own limit over the image ceiling
 * (`PREVIEW_BUDGET_TOO_LOW`). Returns what the owner approves: the profile
 * version, the ceiling and the exact art prompt.
 */
export async function previewTerms(
  tx: DbTx,
  scope: Scope,
  input: PreviewInput,
) {
  const { plan, art } = await planPreview(tx, scope, input);
  const ceilingMicros = art?.costMicros ?? 0;
  if (ceilingMicros > input.maxBudgetMicros)
    throw new DomainError("PREVIEW_BUDGET_TOO_LOW", 409);
  return {
    profileVersion: plan.kit.profileVersion,
    ceilingMicros,
    artPrompt: art?.prompt ?? null,
  };
}

/** Posts of this project whose text is exactly the preview's (at most 5). */
async function duplicatePosts(tx: DbTx, scope: Scope, text: string) {
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "content",
      data: { path: ["body"], equals: text },
    },
    select: { id: true },
    take: 5,
  });
  return rows.map((row) => row.id);
}

/**
 * Runs on the owner's approval, in its transaction: stores the queued
 * preview with the approved terms and queues its one-attempt job.
 */
export async function queuePreview(
  tx: DbTx,
  scope: Scope,
  input: PreviewInput,
  mandate: { id: string; version: number } | null = null,
) {
  const terms = await previewTerms(tx, scope, input);
  const record: PreviewRecord = {
    status: "queued",
    phase: "queued",
    actorId: scope.userId,
    request: input,
    ceilingMicros: terms.ceilingMicros,
    artPrompt: terms.artPrompt,
    profileVersion: terms.profileVersion,
    duplicateContentIds: await duplicatePosts(tx, scope, input.postText),
    mandate,
    cost: { settledMicros: 0, unknownMicros: 0 },
  };
  const row = await create(tx, scope, CREATIVE_PREVIEWS, record);
  const job = await enqueue(
    tx,
    scope,
    PREVIEW_QUEUE,
    row.id,
    `${PREVIEW_QUEUE}:${row.id}`,
  );
  // One paid attempt: an unclear provider outcome is never retried.
  await update(tx, scope, job, { ...data(job), maxAttempts: 1 });
  return { previewId: row.id, status: record.status };
}

/** Refusals that need a change in Orbit (brand kit, budget, rights), not a retry. */
const BLOCKING = new Set([
  "MARKETING_PROFILE_REQUIRED",
  "MARKETING_PROFILE_INVALID",
  "PRIMARY_LOGO_REQUIRED",
  "APPROVED_LOGO_ASSET_REQUIRED",
  "ASSET_RIGHTS",
  "OWNER_REQUIRED",
  "ACTOR_MEMBERSHIP_REQUIRED",
  "PREVIEW_BUDGET_TOO_LOW",
  "PREVIEW_STALE",
  "IMAGE_GENERATION_NOT_CONFIGURED",
  "IMAGE_MODEL_NOT_VERIFIED",
  "IMAGE_COST_CONFIRMATION_STALE",
  "PAID_MANDATE_REQUIRED",
  "POLICY_REQUIRED",
  "BUDGET_EXCEEDED",
  "NO_CREATIVE_TEMPLATE_ENABLED",
  "PRODUCT_ASSET_REQUIRED",
  "AGENT_MANDATE_ENDED",
]);

/**
 * The asset fields of the mandate's rights consent for new art (ADR 0019
 * §7): only when the owner gave it and the image route still has the model
 * and ceiling it was given for; otherwise none, and the art waits for the
 * owner's rights decision as before.
 */
async function mandateArtRights(
  tx: DbTx,
  scope: Scope,
  mandate: { id: string; version: number },
  record: AgentMandateRecord,
  previewId: string,
) {
  const terms = record.rightsTerms;
  if (!record.generatedImageRights || !terms) return undefined;
  const { imageConfig } = await currentImageTerms(tx, scope);
  if (
    terms.model !== imageConfig.model ||
    terms.maxCostMicrosPerImage !== imageConfig.maxCostMicrosPerImage
  )
    return undefined;
  return {
    usageApproved: true,
    assetStatus: "approved",
    approvedBy: record.grantedBy,
    approvedAt: new Date().toISOString(),
    license:
      "AI-generated under the owner's standing rights consent of an agent mandate",
    rightsSource: {
      kind: "agent_mandate",
      mandateId: mandate.id,
      mandateVersion: mandate.version,
      model: imageConfig.model,
      maxCostMicrosPerImage: imageConfig.maxCostMicrosPerImage,
      previewId,
    },
  };
}

/** The preview's image cost from its reservation: settled, or unknown while open. */
async function imageCost(tx: DbTx, scope: Scope, previewId: string) {
  const reservation = await tx.budgetReservation.findFirst({
    where: {
      projectId: scope.projectId,
      key: `${scope.projectId}:image:${previewId}`,
    },
  });
  if (!reservation) return { settledMicros: 0, unknownMicros: 0 };
  return reservation.state === "settled"
    ? {
        settledMicros: Number(reservation.settledMicros ?? 0),
        unknownMicros: 0,
      }
    : { settledMicros: 0, unknownMicros: Number(reservation.amountMicros) };
}

/** Writes the preview's next state over its current row. */
async function advance(
  scope: Scope,
  previewId: string,
  change: (record: PreviewRecord, tx: DbTx) => Promise<Partial<PreviewRecord>>,
) {
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await entity(tx, scope, CREATIVE_PREVIEWS, previewId);
    const record = data(row) as PreviewRecord;
    // A preview already closed (lease expiry: outcome unknown) stays closed.
    if (record.status !== "running") return;
    await update(tx, scope, row, { ...record, ...(await change(record, tx)) });
  });
}

/**
 * Worker entry: makes the preview once. Plans with the proposer's current
 * role, refuses a changed art prompt (`PREVIEW_STALE`) or a ceiling over the
 * preview's limit before anything is paid, generates at most one image
 * (reserved at the approved ceiling, request id = preview id, so it is never
 * paid twice), composes and stores the creative under the preview. Its
 * outcome, cost and error code are recorded on the preview; it never throws
 * for a refusal.
 */
export async function runCreativePreview(
  worker: Scope,
  previewId: string,
): Promise<void> {
  const started = await scoped(
    worker.workspaceId,
    worker.projectId,
    async (tx) => {
      const row = await entity(tx, worker, CREATIVE_PREVIEWS, previewId);
      const record = data(row) as PreviewRecord;
      if (record.status !== "queued") return null;
      await update(tx, worker, row, {
        ...record,
        status: "running",
        phase: "planning",
        startedAt: new Date().toISOString(),
      });
      return record;
    },
  );
  if (!started) return;
  try {
    const actor = await actorScope(
      worker.workspaceId,
      worker.projectId,
      started.actorId,
    );
    if (!actor) throw new DomainError("ACTOR_MEMBERSHIP_REQUIRED", 403);
    const scope = moduleScope(actor, "marketing");
    const request = started.request;
    const mandate = started.mandate ?? null;
    // Work a mandate approved stops before anything once it ended (ADR 0019 §6).
    if (mandate)
      await scoped(scope.workspaceId, scope.projectId, (tx) =>
        assertMandateStillAuthorizes(tx, scope, mandate.id, "marketing"),
      );
    const prep = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      planPreview(tx, scope, request, { ceilingMicros: started.ceilingMicros }),
    );
    let plan = prep.plan;
    // What runs is the brand kit the owner approved.
    if (plan.kit.profileVersion !== started.profileVersion)
      throw new DomainError("PREVIEW_STALE", 409);
    if (prep.art) {
      // What runs is what the owner approved: prompt and ceiling.
      if (prep.art.prompt !== started.artPrompt)
        throw new DomainError("PREVIEW_STALE", 409);
      if (prep.art.costMicros > request.maxBudgetMicros)
        throw new DomainError("PREVIEW_BUDGET_TOO_LOW", 409);
      // Copy that does not fit or a refused logo stops before payment (R53).
      await trialComposition(scope, plan, prep.art, {});
      await advance(worker, previewId, async () => ({ phase: "art" }));
      const artAssetId = await generateArt(
        scope,
        { ...prep.art, requestId: previewId },
        {
          confirmMaximumCostMicros: prep.art.costMicros,
          confirmPromptMayBeSentToProvider: true,
        },
        undefined,
        // Again in the reservation transaction, right before payment.
        mandate
          ? async (tx) => {
              const record = await assertMandateStillAuthorizes(
                tx,
                scope,
                mandate.id,
                "marketing",
              );
              return {
                assetFields: await mandateArtRights(
                  tx,
                  scope,
                  mandate,
                  record,
                  previewId,
                ),
              };
            }
          : undefined,
      );
      await advance(worker, previewId, async () => ({ artAssetId }));
      plan = (
        await scoped(scope.workspaceId, scope.projectId, (tx) =>
          planPreview(tx, scope, request, { pendingArtId: artAssetId }),
        )
      ).plan;
    }
    await advance(worker, previewId, async () => ({ phase: "composing" }));
    const composed = await composePlan(scope, plan, 0, {});
    const creative = await scoped(
      scope.workspaceId,
      scope.projectId,
      async (tx) => {
        await assertSourcesHold(tx, scope, plan);
        const cost = await imageCost(tx, scope, previewId);
        const reservation = cost.settledMicros
          ? await tx.budgetReservation.findFirst({
              where: {
                projectId: scope.projectId,
                key: `${scope.projectId}:image:${previewId}`,
              },
            })
          : null;
        return storeComposed(tx, scope, {
          content: {
            previewId,
            channel: request.channel,
            title: request.title,
          },
          plan,
          composed,
          approvedBy: scope.userId,
          record: {
            cost: {
              reservationIds: reservation ? [reservation.id] : [],
              ...cost,
            },
          },
        });
      },
    );
    await advance(worker, previewId, async (_record, tx) => ({
      status: "completed",
      phase: "done",
      creativeId: creative.id,
      cost: await imageCost(tx, worker, previewId),
      completedAt: new Date().toISOString(),
    }));
  } catch (error) {
    const code =
      error instanceof DomainError
        ? error.code
        : error instanceof z.ZodError
          ? "INVALID_PREVIEW_REQUEST"
          : "PREVIEW_FAILED";
    const detail = (error as { detail?: { codes?: string } }).detail;
    await advance(worker, previewId, async (_record, tx) => ({
      status: BLOCKING.has(code) ? "blocked" : "failed",
      errorCode: code,
      ...(detail?.codes && { blockers: detail.codes.split(",") }),
      cost: await imageCost(tx, worker, previewId),
      completedAt: new Date().toISOString(),
    }));
  }
}

/** A job whose lease ran out while running: its image outcome may be unknown; never retried. */
export async function markPreviewOutcomeUnknown(
  tx: DbTx,
  scope: Scope,
  previewId: string,
) {
  const row = await entity(tx, scope, CREATIVE_PREVIEWS, previewId);
  const record = data(row) as PreviewRecord;
  if (record.status !== "running") return;
  await update(tx, scope, row, {
    ...record,
    status: "failed",
    errorCode: "PREVIEW_OUTCOME_UNKNOWN",
    cost: await imageCost(tx, scope, previewId),
    completedAt: new Date().toISOString(),
  });
}

/** One preview of this project; another kind, project or a malformed id is `NOT_FOUND`. */
export async function findPreview(tx: DbTx, scope: Scope, id: string) {
  return projectRow(tx, scope, CREATIVE_PREVIEWS, id);
}

/** The preview's progress for a client. */
export function previewStatus(row: Awaited<ReturnType<typeof findPreview>>) {
  const record = data(row) as PreviewRecord;
  return {
    previewId: row.id,
    status: record.status,
    phase: record.phase,
    progress: PROGRESS[record.phase],
    createdAt: row.createdAt.toISOString(),
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    errorCode: record.errorCode ?? null,
    blockers: record.blockers ?? [],
    costMicros: record.cost.settledMicros,
    unknownCostMicros: record.cost.unknownMicros,
    maxBudgetMicros: record.request.maxBudgetMicros,
    creativeId: record.creativeId ?? null,
    published: false,
  };
}

/**
 * The finished preview: post text, image copy, the rendition (format, size,
 * asset, an Orbit link that needs a sign-in), the brand kit's profile
 * version and the logo drawn, QA, rights and cost. Never published, scheduled
 * or handed to Postiz. `PREVIEW_NOT_COMPLETED` (409) before it finished.
 */
export async function previewResult(tx: DbTx, scope: Scope, id: string) {
  const row = await findPreview(tx, scope, id);
  const record = data(row) as PreviewRecord;
  if (record.status !== "completed" || !record.creativeId)
    throw Object.assign(new DomainError("PREVIEW_NOT_COMPLETED", 409), {
      detail: { status: record.status, errorCode: record.errorCode ?? "" },
    });
  const creative = data(
    await findCreative(tx, scope, record.creativeId),
  ) as CreativeRecord;
  const rendition = creative.renditions[0]!;
  const pending = (creative.qa.checks.find((c) => c.code === "ASSET_RIGHTS")
    ?.detail?.pendingAssetIds ?? "") as string;
  const { request } = record;
  return {
    ...previewStatus(row),
    channel: request.channel,
    language: request.language ?? null,
    title: request.title,
    postText: request.postText,
    copy: creative.copy,
    creative: {
      creativeId: record.creativeId,
      status: creative.status,
      template: creative.template,
      variant: creative.variant,
    },
    image: {
      format: rendition.format,
      width: rendition.width,
      height: rendition.height,
      aspectRatio: `${CREATIVE_FORMATS[rendition.format].width}:${CREATIVE_FORMATS[rendition.format].height}`,
      assetId: rendition.assetId,
      sha256: rendition.sha256,
      bytes: rendition.bytes,
      mimeType: "image/png",
      orbitUrl: `${loadConfig().APP_ORIGIN}/api/projects/${scope.projectId}/assets/${rendition.assetId}/content`,
    },
    brandKit: {
      profileVersion: creative.profileVersion,
      logoAssetId: creative.components.logo.assetId,
      logoSha256: creative.components.logo.sha256,
    },
    artAssetId: creative.components.artAssetId ?? null,
    productAssetIds: creative.components.products.map((p) => p.assetId),
    qa: {
      // Layout, legibility and logo checks; never usage rights.
      scope: "technical",
      verdict: creative.qa.verdict,
      checks: creative.qa.checks.map((check) => ({
        code: check.code,
        passed: check.passed,
        severity: check.severity,
      })),
    },
    rights: {
      status:
        creative.status === "needs_rights"
          ? "awaiting_owner_rights_decision"
          : "approved_components",
      pendingAssetIds: pending ? pending.split(",") : [],
      // Rights are their own decision: a passed QA never approves them.
      explanation:
        creative.status === "needs_rights"
          ? "The image is composed and its technical QA ran, but the new art's usage rights wait for the owner's decision. It cannot be attached or published until then."
          : "Every drawn asset is approved for this use.",
    },
    duplicateContentIds: record.duplicateContentIds,
    approval: {
      generation: "approved",
      generationApprovedBy: record.mandate ? "agent_mandate" : "person",
      publishing: "not_requested",
    },
    cost: {
      settledMicros: record.cost.settledMicros,
      unknownMicros: record.cost.unknownMicros,
      maxBudgetMicros: request.maxBudgetMicros,
    },
  };
}

/** The finished preview's image as a small JPEG for a client (base64). */
export async function previewImage(
  tx: DbTx,
  scope: Scope,
  result: { image: { assetId: string } },
) {
  const asset = await projectRow(tx, scope, "assets", result.image.assetId);
  const { bytes } = assetBytes(data(asset));
  const jpeg = await encodePreviewJpeg(bytes);
  return [{ data: jpeg.toString("base64"), mimeType: "image/jpeg" as const }];
}

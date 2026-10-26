import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import {
  composeCreative,
  CreativeError,
  formatsForChannel,
  TEMPLATE_NEEDS,
  type CreativeCopy,
  type ImageKind,
  type LogoPlacement,
  type TemplateId,
  type TextScale,
  type VariantId,
} from "../../../../../../packages/creative/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  authorize,
  PROJECT_WRITE,
} from "../../../platform/tenancy/permissions.ts";
import { audit, create, data, DomainError, update } from "../../../shared.ts";
import { resolveChannelRules } from "../publishing/channel-rules.ts";
import { attachCreativeInTx } from "./attach.ts";
import {
  loadCreativeBrand,
  resolveBrandKit,
  type EntityRow,
} from "./brand-kit.ts";
import { resolveCreativeBrief, type ResolvedBrief } from "./brief.ts";
import {
  artAsset,
  componentBytes,
  isOrbitArt,
  keptAssets,
  outdateRendition,
  productAsset,
  projectAssets,
  projectRow,
} from "./components.ts";
import { parsedCreativeCopy, storedCreativeCopy } from "./copy-checks.ts";
import { creativeStudioEnabled } from "./flag.ts";
import {
  assertContentHolds,
  assertSourcesHold,
  composedFields,
  saveRenditions,
  sourceRows,
  type ComposedCreative,
  type CreativePlan,
} from "./persist.ts";
import { assertRights, refusal, rightsCheck } from "./quality.ts";
import { composeRenditions, type CompositionOutcome } from "./renditions.ts";
import {
  CREATIVES,
  creativeView,
  findCreative,
  type CreativeRecord,
  type CreativeView,
} from "./store.ts";

// The manual Creative Studio (spec §8, §11): produce a creative for a social
// post from approved assets, recompose it for free and attach it to the post.
// Producing and recomposing run in three steps: plan in one transaction,
// read bytes and compose outside any transaction, save in a second
// transaction only while the profile, every component and the post's
// channel are unchanged.

/** A person's request for a creative of one post (the Creative Studio). */
export type ProduceRequest = {
  contentId: string;
  template?: TemplateId;
  variant?: VariantId;
  /** The copy on the image; without it the copywriter's `creativeCopy` of the post. */
  copy?: CreativeCopy;
  /** An approved art asset (photo, background, banner or generated artwork). */
  artAssetId?: string;
  /** The approved screenshot or product image to show; without it the brand kit's first. */
  productAssetIds?: string[];
  options?: Partial<{ logoPlacement: LogoPlacement; textScale: TextScale }>;
};

/** Test seam: the composer, and a hook between composing and saving. */
export type PipelineDeps = {
  compose?: typeof composeCreative;
  afterCompose?: () => Promise<void>;
};

/** What a recomposition changes; everything else (art, products, copy) is kept. */
export type RecomposeChanges = {
  template?: TemplateId;
  variant?: VariantId;
  options?: Partial<{ logoPlacement: LogoPlacement; textScale: TextScale }>;
  copy?: CreativeCopy;
};

const SHOWS_PRODUCT: readonly ImageKind[] = ["product", "combined"];
/** Engine refusals that are bad input or a render fault; the others are conflicts (409). */
const ENGINE_STATUS: Readonly<Record<string, number>> = {
  INVALID_TEMPLATE_INPUT: 400,
  INVALID_TEMPLATE_VARIANT: 400,
  INVALID_BRAND_COLOR: 400,
  INVALID_BRAND_FONT: 400,
  INVALID_BRAND_ASSET: 400,
  RASTER_RENDER_FAILED: 500,
  RASTER_OUTPUT_INVALID: 500,
};

/**
 * The image copy in the stored shape of `content.creativeCopy` (R37, Task
 * 12's parser): the headline and only the non-empty other layers.
 * `CREATIVE_COPY_REQUIRED` when it is missing, malformed or without a
 * headline.
 */
function creativeCopyOf(raw: unknown): CreativeCopy {
  const copy = parsedCreativeCopy(raw);
  if (!copy?.headline.trim())
    throw new DomainError("CREATIVE_COPY_REQUIRED", 409);
  return storedCreativeCopy({
    eyebrow: copy.eyebrow?.trim() ?? "",
    headline: copy.headline.trim(),
    subline: copy.subline?.trim() ?? "",
    cta: copy.cta?.trim() ?? "",
  });
}

/** Off, the studio does not exist (CS-D6); otherwise a writer's action. */
function assertStudio(scope: Scope) {
  if (!creativeStudioEnabled()) throw new DomainError("NOT_FOUND", 404);
  authorize(scope, PROJECT_WRITE, "EDITOR_REQUIRED");
}

/** Engine refusals as API errors; `TEXT_OVERFLOW` and the like are 409. */
function engineError(error: unknown): never {
  if (error instanceof CreativeError)
    throw new DomainError(error.code, ENGINE_STATUS[error.code] ?? 409);
  throw error;
}

/** The post's title and core message as the brief reads them. */
const briefContent = (v: Record<string, any>) => ({
  title: String(v.title ?? ""),
  ...(typeof v.coreMessage === "string" && { coreMessage: v.coreMessage }),
});

/** The products the layout shows (the template's frame, at most one). */
function shownProducts(brief: ResolvedBrief, candidates: EntityRow[]) {
  return TEMPLATE_NEEDS[brief.template].product !== "none" &&
    SHOWS_PRODUCT.includes(brief.imageKind)
    ? candidates.slice(0, 1)
    : [];
}

/** A creative plan of one post. */
type Plan = CreativePlan & { content: EntityRow };

/** Completes a plan with the rights of its components; a refusal throws (R22). */
async function checkedPlan(
  tx: DbTx,
  scope: Scope,
  plan: Omit<Plan, "rights">,
): Promise<Plan> {
  if (TEMPLATE_NEEDS[plan.brief.template].art === "required" && !plan.art)
    throw new DomainError("ART_REQUIRED", 409);
  const rights = await rightsCheck(tx, scope, sourceRows(plan), "social");
  assertRights(rights);
  return { ...plan, rights };
}

/** Reads the bytes and composes every format, outside any transaction. */
async function composePlan(
  scope: Scope,
  plan: Plan,
  artAttempts: number,
  deps: PipelineDeps,
): Promise<ComposedCreative> {
  const brand = await loadCreativeBrand(scope, plan.kit);
  const art = plan.art ? await componentBytes(scope, plan.art) : undefined;
  const products = await Promise.all(
    plan.products.map((row) => componentBytes(scope, row)),
  );
  const outcome = await composeRenditions(
    {
      brand,
      brief: plan.brief,
      copy: plan.copy,
      art,
      products,
      options: plan.options,
      variantFixed: plan.variantFixed,
      artState: {
        orbitGenerated: isOrbitArt(plan.art),
        attempts: artAttempts,
        maxCorrections: plan.kit.config.maxArtCorrections,
      },
    },
    { compose: deps.compose },
  ).catch(engineError);
  // A logo or screenshot that is not its approved bytes is refused (R34).
  const refused = refusal(outcome.failed);
  if (refused) throw new DomainError(refused, 409);
  // Copy that does not fit is the person's to shorten; nothing is saved.
  if (outcome.overflow.length) throw new DomainError("TEXT_OVERFLOW", 409);
  await deps.afterCompose?.();
  return { outcome, art, products };
}

/** The renditions of a plan, saved for a creative of its post by the person asking. */
const renditionsOf = (
  tx: DbTx,
  scope: Scope,
  creativeId: string,
  plan: Plan,
  composed: ComposedCreative,
) =>
  saveRenditions(tx, scope, {
    creativeId,
    contentId: plan.content.id,
    channel: data(plan.content).channel,
    title: String(data(plan.content).title ?? ""),
    plan,
    composed,
    approvedBy: scope.userId,
  });

/** Content-free audit facts of a composition. */
const auditFacts = (record: CreativeRecord, outcome: CompositionOutcome) => ({
  contentId: record.contentId,
  template: record.template,
  variant: record.variant,
  status: record.status,
  renditionIds: record.renditions.map((r) => r.assetId),
  failed: outcome.failed,
  corrections: outcome.corrections.length,
});

/**
 * Produces a creative for a social post (spec §8): plans the brand kit,
 * brief and approved components (`ASSET_RIGHTS` refuses, R22), composes one
 * rendition per channel format with free corrections and art checks, and
 * stores the creative with its bound renditions under the re-check of
 * profile, components and post. `composed` when no failed blocker remains,
 * else `needs_owner` with the findings. Free: no model call.
 * Errors: `EDITOR_REQUIRED` (403), `NOT_FOUND` (404),
 * `CREATIVE_SOCIAL_ONLY`, `CREATIVE_COPY_REQUIRED`, `ART_REQUIRED`,
 * `TEXT_OVERFLOW`, `LOGO_INTEGRITY`, `SCREENSHOT_INTEGRITY`,
 * `MARKETING_PROFILE_CHANGED`, `BRAND_ASSET_CHANGED`, `CONTENT_CHANGED`
 * (409), besides the brand kit's and brief's own.
 */
export async function produceCreative(
  scope: Scope,
  request: ProduceRequest,
  deps: PipelineDeps = {},
): Promise<CreativeView> {
  assertStudio(scope);
  const plan = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const content = await projectRow(tx, scope, "content", request.contentId);
    const v = data(content);
    if (v.type !== "social") throw new DomainError("CREATIVE_SOCIAL_ONLY", 409);
    const art = request.artAssetId
      ? await artAsset(tx, scope, request.artAssetId)
      : null;
    const requested = [...new Set(request.productAssetIds ?? [])];
    // One product frame per layout.
    if (requested.length > 1)
      throw new DomainError("INVALID_TEMPLATE_INPUT", 400);
    const explicit = await Promise.all(
      requested.map((id) => productAsset(tx, scope, id)),
    );
    const copy = creativeCopyOf(request.copy ?? v.creativeCopy);
    const kit = await resolveBrandKit(tx, scope);
    const rules = await resolveChannelRules(
      tx,
      scope,
      v.channel,
      "social",
      true,
    );
    const candidates = explicit.length ? explicit : kit.products;
    const brief = resolveCreativeBrief({
      proposal: null,
      content: briefContent(v),
      profile: kit.profile,
      config: kit.config,
      hasProducts: candidates.length > 0,
      channelFormats: formatsForChannel(
        rules.providerIdentifier,
        kit.config.formatsByChannel,
      ),
      origin: "manual",
      template: request.template,
      variant: request.variant,
    });
    const products = shownProducts(brief, candidates);
    // Named products the layout does not show would be dropped silently (R31).
    if (explicit.length && !products.length)
      throw new DomainError("INVALID_TEMPLATE_INPUT", 400);
    return checkedPlan(tx, scope, {
      kit,
      content,
      brief,
      copy,
      options: {
        logoPlacement:
          request.options?.logoPlacement ?? kit.config.logoPlacement,
        textScale: request.options?.textScale ?? "m",
      },
      variantFixed: request.variant !== undefined,
      art,
      products,
    });
  });
  const composed = await composePlan(scope, plan, 0, deps);
  const row = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await assertSourcesHold(tx, scope, plan);
    await assertContentHolds(tx, scope, plan.content);
    const record: CreativeRecord = {
      contentId: plan.content.id,
      ...composedFields(plan, composed),
      renditions: [],
      corrections: composed.outcome.corrections,
      cost: { reservationIds: [], settledMicros: 0, unknownMicros: 0 },
    };
    // The renditions are bound to the creative, so it is created first.
    const creative = await create(tx, scope, CREATIVES, record);
    record.renditions = await renditionsOf(
      tx,
      scope,
      creative.id,
      plan,
      composed,
    );
    const saved = await update(tx, scope, creative, record);
    await audit(
      tx,
      scope,
      "creative.produced",
      creative.id,
      auditFacts(record, composed.outcome),
    );
    return saved;
  });
  return creativeView(row, scope);
}

/**
 * Recomposes a creative for free (spec §8): another template, variant, logo
 * placement, text scale or copy over exactly the same art and products (the
 * bytes it was composed from, else `BRAND_ASSET_CHANGED`), with the current
 * brand kit. A variant a person chose stays fixed until a new template
 * without a variant is chosen. The new renditions replace the old ones,
 * which become `outdated`, except the one the post carries: an attached
 * creative stays on its post until the next attach (R5). Errors as
 * `produceCreative`.
 */
export async function recomposeCreative(
  scope: Scope,
  creativeId: string,
  changes: RecomposeChanges,
  deps: PipelineDeps = {},
): Promise<CreativeView> {
  assertStudio(scope);
  const { row, record, plan } = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const row = await findCreative(tx, scope, creativeId);
      const record = data(row) as CreativeRecord;
      const content = await projectRow(tx, scope, "content", record.contentId);
      const { artAssetId, artSha256 } = record.components;
      const [art = null] = artAssetId
        ? await keptAssets(tx, scope, [
            { assetId: artAssetId, sha256: artSha256 },
          ])
        : [];
      const products = await keptAssets(tx, scope, record.components.products);
      const kit = await resolveBrandKit(tx, scope);
      let brief = record.brief;
      if (changes.template !== undefined || changes.variant !== undefined) {
        const resolved = resolveCreativeBrief({
          proposal: null,
          content: briefContent(data(content)),
          profile: kit.profile,
          config: kit.config,
          hasProducts: products.length > 0,
          channelFormats: record.brief.formats,
          origin: "manual",
          template: changes.template ?? record.template,
          // A new template without a variant gets its default one.
          variant:
            changes.variant ??
            (changes.template === undefined ? record.brief.variant : undefined),
        });
        // The layout changes; what the brief says about the image stays.
        const { template, variant, imageKind, reservedZones, fallbackReason } =
          resolved;
        brief = {
          ...record.brief,
          template,
          variant,
          imageKind,
          reservedZones,
          fallbackReason,
        };
      }
      const plan = await checkedPlan(tx, scope, {
        kit,
        content,
        brief,
        copy: changes.copy ? creativeCopyOf(changes.copy) : record.copy,
        options: { ...record.options, ...changes.options },
        // A person's variant stays theirs until a new template replaces it.
        variantFixed:
          changes.variant !== undefined ||
          (changes.template === undefined && record.variantFixed === true),
        art,
        products: shownProducts(brief, products),
      });
      return { row, record, plan };
    },
  );
  const artAttempts = record.corrections.filter((c) => c.kind === "art").length;
  const composed = await composePlan(scope, plan, artAttempts, deps);
  const saved = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await assertSourcesHold(tx, scope, plan);
    const carried = data(
      await assertContentHolds(tx, scope, plan.content),
    ).assetId;
    // The post keeps its attached rendition until the next attach (R5).
    const old = await projectAssets(
      tx,
      scope,
      record.renditions
        .map((r) => r.assetId)
        .filter((assetId) => assetId !== carried),
    );
    for (const rendition of old.values())
      await outdateRendition(tx, scope, rendition);
    const next: CreativeRecord = {
      ...record,
      ...composedFields(plan, composed),
      renditions: await renditionsOf(tx, scope, row.id, plan, composed),
      // Corrections are history: art regenerations count against the limit.
      corrections: [...record.corrections, ...composed.outcome.corrections],
    };
    const updated = await update(tx, scope, row, next);
    await audit(
      tx,
      scope,
      "creative.recomposed",
      row.id,
      auditFacts(next, composed.outcome),
    );
    return updated;
  });
  return creativeView(saved, scope);
}

/**
 * Attaches a creative to its post (spec §11): the studio's entry to
 * `attachCreativeInTx`, behind the flag and the writer role.
 */
export async function attachCreative(
  scope: Scope,
  creativeId: string,
  input: { acceptQaFindings?: true } = {},
): Promise<{ contentId: string; assetId: string }> {
  assertStudio(scope);
  return scoped(scope.workspaceId, scope.projectId, (tx) =>
    attachCreativeInTx(tx, scope, creativeId, input),
  );
}

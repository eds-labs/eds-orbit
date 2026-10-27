import { randomUUID } from "node:crypto";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { generateImage } from "../../../../../../packages/ai/src/index.ts";
import {
  composeCreative,
  CreativeError,
  formatsForChannel,
  solidRaster,
  TEMPLATE_COPY_LIMITS,
  TEMPLATE_NEEDS,
  type CreativeCopy,
  type ImageKind,
  type LogoPlacement,
  type RasterSource,
  type TemplateId,
  type TextScale,
  type VariantId,
} from "../../../../../../packages/creative/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  authorize,
  PROJECT_OWN,
  PROJECT_WRITE,
} from "../../../platform/tenancy/permissions.ts";
import { audit, data, DomainError, update } from "../../../shared.ts";
import { resolveChannelRules } from "../publishing/channel-rules.ts";
import {
  artAttempts,
  artConfirmation,
  artCorrectionInput,
  findingsCorrection,
  generateArt,
  planArt,
  recordArtAttempt,
  settleArtAttempt,
  type ArtConfirmation,
  type ArtRequest,
} from "./art.ts";
import type { ArtCorrection } from "./art-direction.ts";
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
import {
  CREATIVE_TEXT_TOO_LONG,
  creativeCopyProblems,
  parsedCreativeCopy,
  storedCreativeCopy,
} from "./copy-checks.ts";
import { creativeStudioEnabled } from "./flag.ts";
import {
  assertContentHolds,
  assertSourcesHold,
  auditFacts,
  composedFields,
  saveRenditions,
  sourceRows,
  storeComposed,
  type ComposedCreative,
  type CreativePlan,
} from "./persist.ts";
import { assertRights, creativeRefusal, rightsCheck } from "./quality.ts";
import { composeRenditions } from "./renditions.ts";
import {
  creativeView,
  findCreative,
  type CreativeRecord,
  type CreativeView,
} from "./store.ts";
import { withVision } from "./vision-review.ts";

// The manual Creative Studio (spec §8, §11): produce a creative for a social
// post from approved assets or new art, recompose it for free, regenerate its
// art (paid, bounded) and attach it to the post. Producing and recomposing
// run in three steps: plan in one transaction, read bytes and compose outside
// any transaction, save in a second transaction only while the profile,
// every component and the post's channel are unchanged. New art is generated
// between the plan and the composition.

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
  /**
   * New art instead of `artAssetId` (owner, one paid image at the confirmed
   * per-image ceiling). The art is stored unapproved and the creative
   * `needs_rights` until the owner approves the art and recomposes.
   */
  generateArt?: ArtConfirmation;
  /**
   * The client's id for the paid image (R51): a retried request names the
   * same image request and is refused (`RESERVATION_ALREADY_USED`) instead
   * of paying twice. A new one is drawn when it is absent.
   */
  requestId?: string;
};

/** Test seam: the composer, the image provider and a hook between composing and saving. */
export type PipelineDeps = {
  compose?: typeof composeCreative;
  generate?: typeof generateImage;
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
export function creativeCopyOf(raw: unknown): CreativeCopy {
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
export const briefContent = (v: Record<string, any>) => ({
  title: String(v.title ?? ""),
  ...(typeof v.coreMessage === "string" && { coreMessage: v.coreMessage }),
});

/** The products the layout shows (the template's frame, at most one). */
export function shownProducts(brief: ResolvedBrief, candidates: EntityRow[]) {
  return TEMPLATE_NEEDS[brief.template].product !== "none" &&
    SHOWS_PRODUCT.includes(brief.imageKind)
    ? candidates.slice(0, 1)
    : [];
}

/** A creative plan of one post. */
export type Plan = CreativePlan & { content: EntityRow };

/** How a plan's art is checked: new art to come, or the creative's own new art. */
type ArtCheck = {
  /** Paid art is generated after this check (the plan has none yet). */
  artToCome?: boolean;
  /** The creative's own new art, which may wait for the owner's rights decision. */
  pendingArtId?: string;
};

/**
 * Completes a plan, before any byte is read: the copy within the template's
 * limits (Task 12's rule, `CREATIVE_TEXT_TOO_LONG`, R42), art where the
 * template needs it (`ART_REQUIRED`) and the rights of every component (a
 * refusal throws, R22). With `artToCome` (paid art follows) it checks the
 * copy and the rights of the other components; what composing them can
 * refuse is found by `trialComposition` before the art is paid for (R53).
 */
export async function checkedPlan(
  tx: DbTx,
  scope: Scope,
  plan: Omit<Plan, "rights">,
  art: ArtCheck = {},
): Promise<Plan> {
  const { template } = plan.brief;
  if (
    creativeCopyProblems(plan.copy, TEMPLATE_COPY_LIMITS[template], {
      cta: plan.copy.cta,
    }).includes(CREATIVE_TEXT_TOO_LONG)
  )
    throw new DomainError(CREATIVE_TEXT_TOO_LONG, 409);
  if (
    TEMPLATE_NEEDS[template].art === "required" &&
    !plan.art &&
    !art.artToCome
  )
    throw new DomainError("ART_REQUIRED", 409);
  const rights = await rightsCheck(tx, scope, sourceRows(plan), "social", {
    pendingArtId: art.pendingArtId,
  });
  assertRights(rights);
  return { ...plan, rights };
}

/**
 * New art is the owner's decision (`OWNER_REQUIRED`, 403) with a valid
 * confirmation, and replaces a named art (`INVALID_TEMPLATE_INPUT`, 400).
 */
function newArtConfirmation(scope: Scope, request: ProduceRequest) {
  if (!request.generateArt) return null;
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const confirmation = artConfirmation.parse(request.generateArt);
  if (request.artAssetId) throw new DomainError("INVALID_TEMPLATE_INPUT", 400);
  return confirmation;
}

/**
 * Reads the bytes and composes every format, outside any transaction. A
 * `trial` composes over stand-in art instead of the plan's and skips the
 * hook before saving (R53).
 */
export async function composePlan(
  scope: Scope,
  plan: Plan,
  artAttempts: number,
  deps: PipelineDeps,
  trial?: { art: RasterSource },
): Promise<ComposedCreative> {
  const brand = await loadCreativeBrand(scope, plan.kit);
  const art = trial
    ? trial.art
    : plan.art
      ? await componentBytes(scope, plan.art)
      : undefined;
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
        orbitGenerated: !trial && isOrbitArt(plan.art),
        attempts: artAttempts,
        maxCorrections: plan.kit.config.maxArtCorrections,
      },
    },
    { compose: deps.compose },
  ).catch(engineError);
  // A logo or screenshot that is not its approved bytes is refused (R34).
  const refused = creativeRefusal(outcome.failed);
  if (refused) throw new DomainError(refused, 409);
  // Copy that does not fit is the person's to shorten; nothing is saved.
  if (outcome.overflow.length) throw new DomainError("TEXT_OVERFLOW", 409);
  if (!trial) await deps.afterCompose?.();
  return { outcome, art, products };
}

/**
 * Before new art is paid for (R53): one free composition of the plan over
 * brand-coloured stand-in art of the image's size. Copy that does not fit
 * (`TEXT_OVERFLOW`) and refusals (`LOGO_INTEGRITY`, `SCREENSHOT_INTEGRITY`;
 * `ASSET_RIGHTS` was checked with the plan) stop here, before anything is
 * reserved; findings about the stand-in art itself are ignored.
 */
async function trialComposition(
  scope: Scope,
  plan: Plan,
  art: ArtRequest,
  deps: PipelineDeps,
): Promise<void> {
  const [width, height] = art.size.split("x").map(Number) as [number, number];
  const standIn = await solidRaster(
    plan.kit.profile.visualIdentity.primaryColor,
    width,
    height,
  );
  await composePlan(scope, plan, 0, deps, { art: standIn });
}

/**
 * Work after new art was paid for (R53): its failure names the art in the
 * error's detail (`artAssetId`); the art stays an unapproved reference the
 * owner may still approve and use.
 */
async function afterPayment<T>(
  artAssetId: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DomainError) {
      const { detail } = error as { detail?: Record<string, unknown> };
      Object.assign(error, { detail: { ...detail, artAssetId } });
    }
    throw error;
  }
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

/**
 * Produces a creative for a social post (spec §8): plans the brand kit,
 * brief and approved components (`ASSET_RIGHTS` refuses, R22), composes one
 * rendition per channel format with free corrections and art checks, and
 * stores the creative with its bound renditions under the re-check of
 * profile, components and post. `composed` when no failed blocker remains,
 * else `needs_owner` with the findings. Free: no model call, except with
 * `generateArt`: after every other check one image is generated through the
 * owner's image generation (reserved at the confirmed ceiling before it is
 * sent, `IMAGE_COST_CONFIRMATION_STALE` otherwise); the art and the
 * renditions are stored unapproved and the creative `needs_rights`.
 * Errors: `EDITOR_REQUIRED`, `OWNER_REQUIRED` (403), `NOT_FOUND` (404),
 * `CREATIVE_SOCIAL_ONLY`, `CREATIVE_COPY_REQUIRED`, `CREATIVE_TEXT_TOO_LONG`,
 * `ART_REQUIRED`,
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
  const confirmation = newArtConfirmation(scope, request);
  const prep = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
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
    const plan = await checkedPlan(
      tx,
      scope,
      {
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
      },
      { artToCome: confirmation !== null },
    );
    // The paid image is planned, and its terms checked, before anything is sent.
    return {
      plan,
      art: confirmation
        ? await planArt(tx, scope, plan, String(v.title ?? ""), confirmation)
        : null,
    };
  });
  if (!prep.art || !confirmation) return saveProduced(scope, prep.plan, deps);
  await trialComposition(scope, prep.plan, prep.art, deps);
  const assetId = await generateArt(
    scope,
    { ...prep.art, requestId: request.requestId ?? randomUUID() },
    confirmation,
    deps.generate,
  );
  const art = prep.art;
  return afterPayment(assetId, async () => {
    const { rights: _rights, ...rest } = prep.plan;
    // The new art waits for the owner's rights decision (spec §8).
    const plan = await scoped(scope.workspaceId, scope.projectId, async (tx) =>
      checkedPlan(
        tx,
        scope,
        { ...rest, art: await artAsset(tx, scope, assetId) },
        { pendingArtId: assetId },
      ),
    );
    return saveProduced(scope, plan, deps, art);
  });
}

/**
 * Composes a planned creative and stores it with its renditions under the
 * re-check of profile, components and post; `paidArt` is new art the plan
 * draws, settled at its ceiling.
 */
async function saveProduced(
  scope: Scope,
  plan: Plan,
  deps: PipelineDeps,
  paidArt?: ArtRequest,
): Promise<CreativeView> {
  const composed = await composePlan(scope, plan, 0, deps);
  const row = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await assertSourcesHold(tx, scope, plan);
    return storeComposed(tx, scope, {
      content: await assertContentHolds(tx, scope, plan.content),
      plan,
      composed,
      approvedBy: scope.userId,
      // New art was settled at the confirmed ceiling.
      ...(paidArt && {
        record: {
          cost: {
            reservationIds: [String(data(plan.art).budgetReservationId)],
            settledMicros: paidArt.costMicros,
            unknownMicros: 0,
          },
        },
      }),
    });
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
  return recompose(scope, creativeId, changes, deps);
}

/**
 * The recomposition of `recomposeCreative`. With `newArtId` the creative's
 * new art (a regeneration) replaces the kept art; like a creative's own art
 * that `needs_rights`, it may wait for the owner's rights decision.
 */
async function recompose(
  scope: Scope,
  creativeId: string,
  changes: RecomposeChanges,
  deps: PipelineDeps,
  newArtId?: string,
): Promise<CreativeView> {
  const { row, record, plan } = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const row = await findCreative(tx, scope, creativeId);
      const record = data(row) as CreativeRecord;
      const content = await projectRow(tx, scope, "content", record.contentId);
      const { artAssetId, artSha256 } = record.components;
      const [art = null] = newArtId
        ? [await artAsset(tx, scope, newArtId)]
        : artAssetId
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
      const plan = await checkedPlan(
        tx,
        scope,
        {
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
        },
        {
          pendingArtId:
            newArtId ??
            (record.status === "needs_rights" ? artAssetId : undefined),
        },
      );
      return { row, record, plan };
    },
  );
  const composed = await composePlan(scope, plan, artAttempts(record), deps);
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
      // A failing vision verdict stays the owner's until a new review (R49).
      ...withVision(composedFields(plan, composed), record.qa.vision),
      renditions: await renditionsOf(tx, scope, row.id, plan, composed),
      // Corrections are history: art regenerations count against the limit.
      corrections: [...record.corrections, ...composed.outcome.corrections],
    };
    const updated = await update(tx, scope, row, next);
    await audit(
      tx,
      scope,
      newArtId ? "creative.art_regenerated" : "creative.recomposed",
      row.id,
      auditFacts(next, composed.outcome),
    );
    return updated;
  });
  return creativeView(saved, scope);
}

/**
 * Regenerates a creative's art (spec §9; owner, one paid image): replaces
 * its art, Orbit's or uploaded (R52), with new Orbit art. At most
 * `maxArtCorrections` attempts per creative (`ART_CORRECTION_LIMIT`, 409,
 * before anything is reserved). Everything else of the creative is checked
 * first, including a free trial composition (R53); the prompt carries the
 * owner's `correction`, else the change the art findings ask for. The
 * attempt is recorded on the creative in the image's reservation
 * transaction, so it counts once sent, with its cost or, when the call's
 * outcome is unknown, as unknown cost. The new art is stored unapproved and
 * the creative recomposed over it: `needs_rights` until the owner approves
 * the art and recomposes; the post keeps an attached rendition until the
 * next attach (R5). A failure after payment names the art (`artAssetId`).
 * The optional `requestId` is the client's id for the image (R51), as in
 * `ProduceRequest`.
 * Errors: as `recomposeCreative`, plus `OWNER_REQUIRED` (403),
 * `ART_CORRECTION_LIMIT`, `IMAGE_COST_CONFIRMATION_STALE`,
 * `RESERVATION_ALREADY_USED`, `VERSION_CONFLICT` (409) and the image
 * generation's own.
 */
export async function regenerateCreativeArt(
  scope: Scope,
  creativeId: string,
  input: ArtConfirmation & { correction?: ArtCorrection; requestId?: string },
  providers: PipelineDeps = {},
): Promise<CreativeView> {
  assertStudio(scope);
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const { correction: asked, requestId: clientRequestId, ...rest } = input;
  const confirmation = artConfirmation.parse(rest);
  const correction = asked && artCorrectionInput.parse(asked);
  const planned = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const row = await findCreative(tx, scope, creativeId);
      const record = data(row) as CreativeRecord;
      const kit = await resolveBrandKit(tx, scope);
      if (artAttempts(record) >= kit.config.maxArtCorrections)
        throw new DomainError("ART_CORRECTION_LIMIT", 409);
      const content = await projectRow(tx, scope, "content", record.contentId);
      const products = await keptAssets(tx, scope, record.components.products);
      // The rest of the creative must stand before new art is paid for.
      const plan = await checkedPlan(
        tx,
        scope,
        {
          kit,
          content,
          brief: record.brief,
          copy: record.copy,
          options: record.options,
          variantFixed: record.variantFixed === true,
          art: null,
          products: shownProducts(record.brief, products),
        },
        { artToCome: true },
      );
      const change = correction ?? findingsCorrection(record.qa.checks);
      return {
        row,
        plan,
        change,
        art: await planArt(
          tx,
          scope,
          plan,
          String(data(content).title ?? ""),
          confirmation,
          change,
        ),
      };
    },
  );
  await trialComposition(scope, planned.plan, planned.art, providers);
  const requestId = clientRequestId ?? randomUUID();
  let assetId: string;
  try {
    assetId = await generateArt(
      scope,
      { ...planned.art, requestId },
      confirmation,
      providers.generate,
      (tx) =>
        recordArtAttempt(tx, scope, planned.row, {
          kind: "art",
          reason: planned.change?.kind ?? "owner_request",
          at: new Date().toISOString(),
          requestId,
        }),
    );
  } catch (error) {
    // A sent attempt keeps its cost on the creative, or stays unknown.
    await settleArtAttempt(scope, creativeId, requestId).catch(() => undefined);
    throw error;
  }
  return afterPayment(assetId, async () => {
    await settleArtAttempt(scope, creativeId, requestId, assetId);
    return recompose(scope, creativeId, {}, providers, assetId);
  });
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

import { z } from "zod";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import {
  composeCreative,
  CreativeError,
  failedBlockers,
  formatsForChannel,
  TEMPLATE_COPY_LIMITS,
  TEMPLATE_NEEDS,
  type CreativeCheck,
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
  PROJECT_OWN,
  PROJECT_WRITE,
} from "../../../platform/tenancy/permissions.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  list,
  update,
} from "../../../shared.ts";
import { currentMarketingProfile } from "../brand/marketing-profile.ts";
import { invalidateContent } from "../pipeline/content-invalidation.ts";
import { reviewContent } from "../pipeline/workflow.ts";
import {
  channelLimitExceeded,
  resolveChannelRules,
} from "../publishing/channel-rules.ts";
import {
  loadCreativeBrand,
  resolveBrandKit,
  type BrandKitPlan,
  type EntityRow,
} from "./brand-kit.ts";
import { resolveCreativeBrief, type ResolvedBrief } from "./brief.ts";
import {
  artAsset,
  assetSha,
  componentBytes,
  isOrbitArt,
  outdateRendition,
  productAsset,
  projectAssets,
  projectRow,
} from "./components.ts";
import { creativeStudioEnabled } from "./flag.ts";
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
// transaction only while the profile and every component are unchanged.

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
// Publications in these states no longer hold the post.
const INACTIVE_PUBLICATION = ["canceled", "failed", "blocked_dependency"];
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

type CopyField = keyof CreativeCopy;
/** A field's longest copy over all templates; the layout decides what fits. */
const longest = (field: CopyField) =>
  Math.max(
    ...Object.values(TEMPLATE_COPY_LIMITS).map((limits) => limits[field]),
  );
const copyField = (field: CopyField) =>
  z.string().trim().max(longest(field)).optional();
const creativeCopyInput = z
  .object({
    eyebrow: copyField("eyebrow"),
    headline: copyField("headline"),
    subline: copyField("subline"),
    cta: copyField("cta"),
  })
  .strict();

/** The copy without empty layers; `CREATIVE_COPY_REQUIRED` without a headline. */
function creativeCopyOf(raw: unknown): CreativeCopy {
  if (raw === undefined || raw === null)
    throw new DomainError("CREATIVE_COPY_REQUIRED", 409);
  const parsed = creativeCopyInput.parse(raw);
  if (!parsed.headline) throw new DomainError("CREATIVE_COPY_REQUIRED", 409);
  return Object.fromEntries(
    Object.entries(parsed).filter(([, text]) => text),
  ) as CreativeCopy;
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

/** What a creative is composed from, planned in one transaction. */
type Plan = {
  kit: BrandKitPlan;
  content: EntityRow;
  brief: ResolvedBrief;
  copy: CreativeCopy;
  options: { logoPlacement: LogoPlacement; textScale: TextScale };
  variantFixed: boolean;
  art: EntityRow | null;
  products: EntityRow[];
  rights: CreativeCheck;
};

/** Every component whose state the save depends on: all brand kit logos, art, products. */
const sourceRows = (plan: Omit<Plan, "rights">) => [
  ...Object.values(plan.kit.logos).filter((row): row is EntityRow => !!row),
  ...(plan.art ? [plan.art] : []),
  ...plan.products,
];

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
) {
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
type Composed = Awaited<ReturnType<typeof composePlan>>;

/**
 * The save's re-check (Review Focus 5): the profile version and every
 * component's version and SHA-256 are as planned, else
 * `MARKETING_PROFILE_CHANGED` / `BRAND_ASSET_CHANGED` (409) and nothing is
 * stored.
 */
async function assertSourcesHold(tx: DbTx, scope: Scope, plan: Plan) {
  const profile = await currentMarketingProfile(tx, scope);
  if (!profile || profile.version !== plan.kit.profileVersion)
    throw new DomainError("MARKETING_PROFILE_CHANGED", 409);
  const rows = sourceRows(plan);
  const current = await projectAssets(
    tx,
    scope,
    rows.map((row) => row.id),
  );
  for (const row of rows) {
    const now = current.get(row.id);
    if (!now || now.version !== row.version || assetSha(now) !== assetSha(row))
      throw new DomainError("BRAND_ASSET_CHANGED", 409);
  }
}

/**
 * Stores each rendition as an approved `generated_artwork` asset bound to
 * its creative and post (kept out of the library and pickers), whose rights
 * source records every drawn component's id, version and SHA-256.
 */
async function saveRenditions(
  tx: DbTx,
  scope: Scope,
  creativeId: string,
  plan: Plan,
  composed: Composed,
): Promise<CreativeRecord["renditions"]> {
  const content = data(plan.content);
  const component = (role: string, row: EntityRow, sha256: string) => ({
    role,
    assetId: row.id,
    version: row.version,
    sha256,
  });
  const renditions: CreativeRecord["renditions"] = [];
  for (const { format, variant, result } of composed.outcome.renditions) {
    const drawn = (kind: string) => result.layers.some((l) => l.kind === kind);
    const logo = plan.kit.logos[result.logoRole]!;
    const components = [
      component("logo", logo, assetSha(logo)),
      ...(plan.art && composed.art && drawn("art")
        ? [component("art", plan.art, composed.art.sha256)]
        : []),
      ...(drawn("product")
        ? plan.products.map((row, i) =>
            component("product", row, composed.products[i]!.sha256),
          )
        : []),
    ];
    const asset = await create(tx, scope, "assets", {
      name: `Creative ${format}: ${content.title ?? ""}`.slice(0, 160),
      type: "generated_artwork",
      mime: "image/png",
      filename: `creative-${plan.brief.template}-${format}.png`,
      base64: result.png.toString("base64"),
      sha256: result.sha256,
      width: result.width,
      height: result.height,
      bytes: result.png.length,
      source: "template",
      sourceType: "TEMPLATE_GENERATED",
      usageApproved: true,
      assetStatus: "approved",
      approvedBy: scope.userId,
      license:
        "Composed by Orbit from approved brand assets; rights follow its components",
      rightsSource: { profileVersion: plan.kit.profileVersion, components },
      // Bound to its creative and post: not in the asset library or pickers.
      boundTo: { creativeId, contentId: plan.content.id },
      creativeFormat: format,
      creativeVariant: variant,
      profileVersion: plan.kit.profileVersion,
      renderer: result.renderer,
      channel: "Social",
      validUses: ["social"],
      driveSyncStatus: "LOCAL_ONLY",
    });
    renditions.push({
      format,
      channel: content.channel,
      assetId: asset.id,
      width: result.width,
      height: result.height,
      bytes: result.png.length,
      sha256: result.sha256,
    });
  }
  return renditions;
}

/** The composition part of a creative record. */
function composedFields(
  plan: Plan,
  composed: Composed,
): Omit<CreativeRecord, "contentId" | "renditions" | "corrections" | "cost"> {
  const { outcome } = composed;
  const logo = plan.kit.logos[outcome.renditions[0]!.result.logoRole]!;
  return {
    profileVersion: plan.kit.profileVersion,
    brief: plan.brief,
    template: plan.brief.template,
    variant: plan.brief.variant,
    options: plan.options,
    copy: plan.copy,
    components: {
      ...(plan.art && { artAssetId: plan.art.id }),
      logo: { assetId: logo.id, sha256: assetSha(logo) },
      products: plan.products.map((row, i) => ({
        assetId: row.id,
        sha256: composed.products[i]!.sha256,
      })),
    },
    qa: { checks: [plan.rights, ...outcome.checks], verdict: outcome.verdict },
    status: outcome.failed.length ? "needs_owner" : "composed",
  };
}

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
 * profile and components. `composed` when no failed blocker remains, else
 * `needs_owner` with the findings. Free: no model call.
 * Errors: `EDITOR_REQUIRED` (403), `NOT_FOUND` (404),
 * `CREATIVE_SOCIAL_ONLY`, `CREATIVE_COPY_REQUIRED`, `ART_REQUIRED`,
 * `TEXT_OVERFLOW`, `MARKETING_PROFILE_CHANGED`, `BRAND_ASSET_CHANGED` (409),
 * besides the brand kit's and brief's own.
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
    // The post may have been removed meanwhile.
    await entity(tx, scope, "content", plan.content.id);
    const record: CreativeRecord = {
      contentId: plan.content.id,
      ...composedFields(plan, composed),
      renditions: [],
      corrections: composed.outcome.corrections,
      cost: { reservationIds: [], settledMicros: 0, unknownMicros: 0 },
    };
    // The renditions are bound to the creative, so it is created first.
    const creative = await create(tx, scope, CREATIVES, record);
    record.renditions = await saveRenditions(
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

/** A component the creative keeps; gone or with other bytes, it is `BRAND_ASSET_CHANGED`. */
async function keptComponents(
  tx: DbTx,
  scope: Scope,
  components: Array<{ assetId: string; sha256?: string }>,
) {
  const current = await projectAssets(
    tx,
    scope,
    components.map((c) => c.assetId),
  );
  return components.map(({ assetId, sha256 }) => {
    const row = current.get(assetId);
    if (!row || (sha256 && assetSha(row) && assetSha(row) !== sha256))
      throw new DomainError("BRAND_ASSET_CHANGED", 409);
    return row;
  });
}

/**
 * Recomposes a creative for free (spec §8): another template, variant, logo
 * placement, text scale or copy over the same art and products, with the
 * current brand kit. The new renditions replace the old ones, which become
 * `outdated`, except the one the post carries: an attached creative stays on
 * its post until the next attach (R5). Errors as `produceCreative`.
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
      const { artAssetId } = record.components;
      const [art = null] = artAssetId
        ? await keptComponents(tx, scope, [{ assetId: artAssetId }])
        : [];
      const products = await keptComponents(
        tx,
        scope,
        record.components.products,
      );
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
            (changes.template === undefined ? record.variant : undefined),
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
        variantFixed: changes.variant !== undefined,
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
      await entity(tx, scope, "content", plan.content.id),
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
      renditions: await saveRenditions(tx, scope, row.id, plan, composed),
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
 * The rendition still stands: it is this creative's approved rendition with
 * its bytes (`CREATIVE_NOT_ATTACHABLE`), and every component in its rights
 * source still has its bytes (`BRAND_ASSET_CHANGED`) and its rights
 * (`ASSET_RIGHTS`).
 */
async function assertRenditionHolds(
  tx: DbTx,
  scope: Scope,
  creativeId: string,
  rendition: CreativeRecord["renditions"][number],
) {
  const asset = (await projectAssets(tx, scope, [rendition.assetId])).get(
    rendition.assetId,
  );
  const d = data(asset);
  if (
    !asset ||
    d.assetStatus !== "approved" ||
    d.usageApproved !== true ||
    d.boundTo?.creativeId !== creativeId ||
    assetSha(asset) !== rendition.sha256
  )
    throw new DomainError("CREATIVE_NOT_ATTACHABLE", 409);
  const components = (d.rightsSource?.components ?? []) as Array<{
    assetId: string;
    sha256: string;
  }>;
  const rows = await keptComponents(tx, scope, components);
  assertRights(await rightsCheck(tx, scope, rows, "social"));
}

/**
 * What the post carried before an attach: a rendition of one of its
 * creatives becomes `outdated`, another creative of the post `superseded`.
 */
async function retirePrevious(
  tx: DbTx,
  scope: Scope,
  before: Record<string, any>,
  attached: { contentId: string; creativeId: string; assetId: string },
) {
  if (before.assetId && before.assetId !== attached.assetId) {
    const previous = (
      await projectAssets(tx, scope, [String(before.assetId)])
    ).get(String(before.assetId));
    const bound = data(previous).boundTo;
    if (bound?.creativeId && bound.contentId === attached.contentId)
      await outdateRendition(tx, scope, previous);
  }
  if (before.creativeId && before.creativeId !== attached.creativeId) {
    const replaced = await findCreative(
      tx,
      scope,
      String(before.creativeId),
    ).catch((error) => {
      if (error instanceof DomainError) return null;
      throw error;
    });
    if (replaced && data(replaced).status !== "superseded")
      await update(tx, scope, replaced, {
        ...data(replaced),
        status: "superseded",
      });
  }
}

/**
 * Attaches a creative to its post (spec §11, like `attachPackageImage`): the
 * rendition of the creative's first format (the channel's) becomes the
 * post's image, the post goes back to `draft` without its review, approvals
 * and publications of the old version are blocked, and the review runs
 * again. Only a `composed` creative is attached; one that `needs_owner` only
 * when the owner accepts the findings (audited `creative.qa_override`). The
 * creative becomes `attached` (R5); repeating the attach changes nothing.
 * Errors: `CREATIVE_QA_FAILED`, `CREATIVE_NOT_ATTACHABLE`,
 * `DRAFT_SUPERSEDED`, `ALREADY_SCHEDULED`, `CAPTION_TOO_LONG`,
 * `BRAND_ASSET_CHANGED`, `ASSET_RIGHTS` (409), `OWNER_REQUIRED` (403).
 */
export async function attachCreative(
  scope: Scope,
  creativeId: string,
  input: { acceptQaFindings?: true } = {},
): Promise<{ contentId: string; assetId: string }> {
  assertStudio(scope);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await findCreative(tx, scope, creativeId);
    const record = data(row) as CreativeRecord;
    const content = await projectRow(tx, scope, "content", record.contentId);
    const v = data(content);
    const rendition =
      record.renditions.find((r) => r.format === record.brief.formats[0]) ??
      record.renditions[0];
    if (!rendition) throw new DomainError("CREATIVE_NOT_ATTACHABLE", 409);
    const result = { contentId: content.id, assetId: rendition.assetId };
    if (
      record.status === "attached" &&
      v.assetId === rendition.assetId &&
      v.creativeId === row.id
    )
      return result;
    const failed = [...new Set(failedBlockers(record.qa.checks))];
    // Integrity and rights findings are refusals no one accepts (R34).
    const refused = refusal(failed);
    if (refused) throw new DomainError(refused, 409);
    const override = record.status === "needs_owner";
    if (override) {
      if (input.acceptQaFindings !== true)
        throw new DomainError("CREATIVE_QA_FAILED", 409);
      authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
    } else if (record.status !== "composed")
      throw new DomainError("CREATIVE_NOT_ATTACHABLE", 409);
    if (v.supersededBy) throw new DomainError("DRAFT_SUPERSEDED", 409);
    await assertRenditionHolds(tx, scope, row.id, rendition);
    if (
      (await list(tx, scope, "publications")).some(
        (publication) =>
          data(publication).contentId === content.id &&
          !INACTIVE_PUBLICATION.includes(data(publication).status),
      )
    )
      throw new DomainError("ALREADY_SCHEDULED", 409);
    // Telegram sends text with media as a caption with a smaller limit.
    if (
      channelLimitExceeded(
        String(v.body ?? ""),
        v.targetUrl,
        await resolveChannelRules(tx, scope, v.channel, v.type, true),
      )
    )
      throw new DomainError("CAPTION_TOO_LONG", 409);
    const { review: _review, ...rest } = v;
    const attached = await update(tx, scope, content, {
      ...rest,
      assetId: rendition.assetId,
      creativeId: row.id,
      status: "draft",
    });
    await invalidateContent(tx, scope, content.id);
    await reviewContent(tx, scope, attached.id, attached.version);
    await retirePrevious(tx, scope, v, { ...result, creativeId: row.id });
    await update(tx, scope, row, { ...record, status: "attached" });
    if (override)
      await audit(tx, scope, "creative.qa_override", row.id, {
        contentId: content.id,
        failed,
      });
    await audit(tx, scope, "creative.attached", row.id, {
      contentId: content.id,
      assetId: rendition.assetId,
      format: rendition.format,
    });
    return result;
  });
}

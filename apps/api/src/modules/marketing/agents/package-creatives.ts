import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import { formatsForChannel } from "../../../../../../packages/creative/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  hash,
  update,
} from "../../../shared.ts";
import { resolveChannelRules } from "../publishing/channel-rules.ts";
import { attachCreativeInTx } from "../creative/attach.ts";
import {
  resolveBrandKit,
  type BrandKitPlan,
  type EntityRow,
} from "../creative/brand-kit.ts";
import { resolveCreativeBrief } from "../creative/brief.ts";
import {
  creativeTemplateOf,
  parsedCreativeCopy,
} from "../creative/copy-checks.ts";
import {
  briefContent,
  checkedPlan,
  creativeCopyOf,
  shownProducts,
  type Plan,
} from "../creative/pipeline.ts";
import {
  assertContentHolds,
  assertSourcesHold,
  composedFields,
  saveRenditions,
  type ComposedCreative,
} from "../creative/persist.ts";
import {
  CREATIVES,
  findCreative,
  type CreativeRecord,
} from "../creative/store.ts";

// Composed creatives of a content package (Creative Studio): attaching the
// package's image gives each draft with image copy its own rendition in its
// channel's format instead of the raw image. Planning, composing (no
// transaction) and saving with the attach (one transaction) are separate
// steps of `attachPackageImage`; the building blocks are the studio's own.

/** What the package's image becomes for one chosen draft. */
export type PackageCreative =
  /** A creative to compose from the package image and the draft's image copy. */
  | { kind: "compose"; plan: Plan }
  /** The draft has no usable image copy: it keeps the raw image (`CREATIVE_COPY_MISSING`). */
  | { kind: "missing" }
  /** The draft already carries this package's creative for this image and copy. */
  | { kind: "current" };

/**
 * The project's brand kit for composing, or null when the profile has no
 * primary logo (such a project keeps attaching the raw image). A logo that is
 * set but unusable is an error to fix (`APPROVED_LOGO_ASSET_REQUIRED`), not
 * a reason to attach unbranded images.
 */
export async function packageBrandKit(
  tx: DbTx,
  scope: Scope,
): Promise<BrandKitPlan | null> {
  try {
    return await resolveBrandKit(tx, scope);
  } catch (error) {
    if (error instanceof DomainError && error.code === "PRIMARY_LOGO_REQUIRED")
      return null;
    throw error;
  }
}

/** Whether the draft already carries this package's attached creative of the same art and copy. */
async function carriesCreative(
  tx: DbTx,
  scope: Scope,
  input: { packageId: string; art: EntityRow },
  draft: EntityRow,
  copy: unknown,
): Promise<boolean> {
  const { creativeId, assetId } = data(draft);
  if (typeof creativeId !== "string") return false;
  const row = await findCreative(tx, scope, creativeId).catch((error) => {
    if (error instanceof DomainError) return null;
    throw error;
  });
  if (!row) return false;
  const record = data(row) as CreativeRecord;
  return (
    record.status === "attached" &&
    record.packageId === input.packageId &&
    record.components.artAssetId === input.art.id &&
    hash(record.copy) === hash(copy) &&
    record.renditions.some((rendition) => rendition.assetId === assetId)
  );
}

/**
 * Plans one chosen draft's creative from the package image (`art`, rights
 * approved) in the first template its mission wrote the image copy for:
 * automated rules for the brief (a disabled template or missing product
 * falls back), the channel's formats, and the studio's plan checks (copy
 * within the template's limits, `CREATIVE_TEXT_TOO_LONG`; rights of every
 * component, `ASSET_RIGHTS`). Free; reads only.
 */
export async function planPackageCreative(
  tx: DbTx,
  scope: Scope,
  input: { packageId: string; art: EntityRow; kit: BrandKitPlan },
  draft: EntityRow,
): Promise<PackageCreative> {
  const v = data(draft);
  if (!parsedCreativeCopy(v.creativeCopy)?.headline.trim())
    return { kind: "missing" };
  const copy = creativeCopyOf(v.creativeCopy);
  if (await carriesCreative(tx, scope, input, draft, copy))
    return { kind: "current" };
  const { kit } = input;
  const mission = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "missions",
      id: String(v.missionId ?? ""),
    },
  });
  const rules = await resolveChannelRules(tx, scope, v.channel, "social", true);
  const brief = resolveCreativeBrief({
    proposal: null,
    content: briefContent(v),
    profile: kit.profile,
    config: kit.config,
    hasProducts: kit.products.length > 0,
    channelFormats: formatsForChannel(
      rules.providerIdentifier,
      kit.config.formatsByChannel,
    ),
    origin: "automated",
    template: creativeTemplateOf(data(mission)) ?? undefined,
  });
  return {
    kind: "compose",
    plan: await checkedPlan(tx, scope, {
      kit,
      content: draft,
      brief,
      copy,
      options: { logoPlacement: kit.config.logoPlacement, textScale: "m" },
      variantFixed: false,
      art: input.art,
      products: shownProducts(brief, kit.products),
    }),
  };
}

/**
 * Saves a composed creative of a package draft and attaches it, in the
 * caller's transaction: the re-check of profile, components and post, the
 * creative with its renditions (bound to the package), and the studio's
 * attach in `content` mode (the draft goes back to `draft` and is reviewed
 * again). A refusal or a creative that needs the owner (`CREATIVE_QA_FAILED`)
 * throws, which rolls the caller's whole transaction back.
 */
export async function savePackageCreative(
  tx: DbTx,
  scope: Scope,
  input: { packageId: string; art: EntityRow },
  plan: Plan,
  composed: ComposedCreative,
) {
  await assertSourcesHold(tx, scope, plan);
  const draft = await assertContentHolds(tx, scope, plan.content);
  const record: CreativeRecord = {
    contentId: draft.id,
    packageId: input.packageId,
    ...composedFields(plan, composed),
    renditions: [],
    corrections: composed.outcome.corrections,
    // The package image was paid for by the package; composing is free.
    cost: { reservationIds: [], settledMicros: 0, unknownMicros: 0 },
  };
  // The renditions are bound to the creative, so it is created first.
  const creative = await create(tx, scope, CREATIVES, record);
  record.renditions = await saveRenditions(tx, scope, {
    creativeId: creative.id,
    contentId: draft.id,
    channel: data(draft).channel,
    title: String(data(draft).title ?? ""),
    plan,
    composed,
    approvedBy: scope.userId,
    boundTo: { packageId: input.packageId },
    rightsSource: { packageId: input.packageId },
  });
  await update(tx, scope, creative, record);
  await audit(tx, scope, "creative.produced", creative.id, {
    contentId: draft.id,
    packageId: input.packageId,
    template: record.template,
    variant: record.variant,
    status: record.status,
    renditionIds: record.renditions.map((rendition) => rendition.assetId),
    failed: composed.outcome.failed,
    corrections: composed.outcome.corrections.length,
  });
  const attached = await attachCreativeInTx(tx, scope, creative.id, {
    mode: "content",
  });
  await audit(tx, scope, "content_package.image_attached", draft.id, {
    packageId: input.packageId,
    assetId: attached.assetId,
    creativeId: creative.id,
    artAssetId: input.art.id,
  });
}

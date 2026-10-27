import { z } from "zod";
import {
  authorize,
  PROJECT_OWN,
  PROJECT_WRITE,
} from "../../../platform/tenancy/permissions.ts";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  audit,
  data,
  DomainError,
  entity,
  hash,
  list,
  update,
} from "../../../shared.ts";
import { chatScoped } from "../../chat.ts";
import {
  channelLimitExceeded,
  resolveChannelRules,
} from "../publishing/channel-rules.ts";
import { retirePrevious } from "../creative/attach.ts";
import type { EntityRow } from "../creative/brand-kit.ts";
import { artAsset } from "../creative/components.ts";
import { creativeStudioEnabled } from "../creative/flag.ts";
import {
  composePlan,
  type PipelineDeps,
  type Plan,
} from "../creative/pipeline.ts";
import type { ComposedCreative } from "../creative/persist.ts";
import { invalidateContent } from "../pipeline/content-invalidation.ts";
import { reviewContent } from "../pipeline/workflow.ts";
import {
  assertPackageDraft,
  contentPackagesEnabled,
  currentDraft,
  packageSnapshot,
} from "./content-packages.ts";
import {
  hasUsableCopy,
  PackageCreativeQaError,
  packageBrandKit,
  planPackageCreative,
  savePackageCreative,
  type PackageCreative,
} from "./package-creatives.ts";

/**
 * Package image in a post (Orbit Core J3.3). The package's generated image is
 * attached to chosen drafts only after an owner approved its usage rights; each
 * draft is reviewed again, and approvals or schedule proposals for the previous
 * version become stale. `acceptQaFindings` (owner only) accepts the findings of
 * composed creatives that did not pass their checks.
 */
export const imageAttachment = z
  .object({
    deliverableKeys: z.array(z.string().trim().min(1).max(80)).min(1).max(4),
    acceptQaFindings: z.literal(true).optional(),
  })
  .strict();

// Publications in these states no longer hold the post.
const INACTIVE_PUBLICATION = ["canceled", "failed", "blocked_dependency"];

/** The started package and its rights-approved image, as every attach needs them. */
async function loadPackageImage(tx: DbTx, scope: Scope, packageId: string) {
  const pkg = await entity(tx, scope, "content_packages", packageId);
  const d = data(pkg);
  if (d.userId !== scope.userId) throw new DomainError("NOT_FOUND", 404);
  if (d.status !== "started") throw new DomainError("PACKAGE_NOT_STARTED", 409);
  const steps = (d.steps ?? []) as Array<Record<string, any>>;
  const imageStep = steps.find((step) => step.kind === "image");
  if (!imageStep) throw new DomainError("PACKAGE_IMAGE_REQUIRED", 409);
  const asset = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "assets",
      data: { path: ["generationId"], equals: imageStep.actionRequestId },
    },
  });
  if (!asset) throw new DomainError("IMAGE_NOT_GENERATED", 409);
  if (
    data(asset).usageApproved !== true ||
    data(asset).assetStatus !== "approved"
  )
    throw new DomainError("ASSET_RIGHTS_REQUIRED", 409);
  return {
    pkg,
    steps,
    asset,
    publications: await list(tx, scope, "publications"),
  };
}
type PackageImage = Awaited<ReturnType<typeof loadPackageImage>>;

/** The current draft of a deliverable, if it can take an image now. */
async function chosenDraft(
  tx: DbTx,
  scope: Scope,
  image: PackageImage,
  key: string,
) {
  const step = image.steps.find(
    (candidate) => candidate.kind === "copy" && candidate.key === key,
  );
  if (!step) throw new DomainError("DELIVERABLE_NOT_FOUND", 404);
  const current = await currentDraft(tx, scope, step);
  if (current.pending) throw new DomainError("REVISION_IN_PROGRESS", 409);
  if (!current.draft) throw new DomainError("DRAFT_REQUIRED", 409);
  const draft = current.draft;
  if (data(draft).supersededBy) throw new DomainError("DRAFT_SUPERSEDED", 409);
  await assertPackageDraft(tx, scope, image.pkg.id, draft);
  if (
    image.publications.some(
      (row) =>
        data(row).contentId === draft.id &&
        !INACTIVE_PUBLICATION.includes(data(row).status),
    )
  )
    throw new DomainError("ALREADY_SCHEDULED", 409);
  return draft;
}

/**
 * Attaches the raw package image to a draft and reviews it again. A creative
 * the draft carried no longer counts: it is superseded and its rendition
 * outdated, as when another creative is attached.
 */
async function attachRawImage(
  tx: DbTx,
  scope: Scope,
  image: PackageImage,
  draft: EntityRow,
) {
  const v = data(draft);
  if (v.assetId === image.asset.id) return;
  // Telegram sends text with media as a caption with a smaller limit.
  if (
    channelLimitExceeded(
      v.body,
      v.targetUrl,
      await resolveChannelRules(tx, scope, v.channel, v.type, true),
    )
  )
    throw new DomainError("CAPTION_TOO_LONG", 409);
  const { review: _review, creativeId: _creative, ...rest } = v;
  const attached = await update(tx, scope, draft, {
    ...rest,
    assetId: image.asset.id,
    status: "draft",
  });
  await invalidateContent(tx, scope, draft.id);
  await reviewContent(tx, scope, attached.id, attached.version);
  await retirePrevious(tx, scope, v, {
    contentId: draft.id,
    assetId: image.asset.id,
  });
  await audit(tx, scope, "content_package.image_attached", draft.id, {
    packageId: image.pkg.id,
    assetId: image.asset.id,
    assetVersion: image.asset.version,
  });
}

const snapshotOf = async (tx: DbTx, scope: Scope, packageId: string) =>
  packageSnapshot(
    tx,
    scope,
    await entity(tx, scope, "content_packages", packageId),
  );
type PackageSnapshot = Awaited<ReturnType<typeof packageSnapshot>>;

/** The raw image on every chosen draft, in one transaction. */
async function attachRawImages(
  tx: DbTx,
  scope: Scope,
  image: PackageImage,
  keys: string[],
) {
  for (const key of keys)
    await attachRawImage(
      tx,
      scope,
      image,
      await chosenDraft(tx, scope, image, key),
    );
  return snapshotOf(tx, scope, image.pkg.id);
}

/** What the attach did with each chosen draft's creative (Creative Studio on). */
type CreativeReport = {
  /** Drafts that got a composed creative in this call. */
  composed: string[];
  /** Drafts that kept the raw image, with why (`CREATIVE_COPY_MISSING` or the brand kit's code). */
  skipped: Array<{ contentId: string; code: string }>;
};

/** A chosen draft, what its image becomes, and the composition made for it. */
type Chosen = {
  key: string;
  draft: EntityRow;
  creative: PackageCreative;
  composed?: ComposedCreative;
};

/**
 * Creative Studio on: plans each chosen draft's creative in one
 * transaction, composes outside any transaction (free: no model call), and
 * saves and attaches them all in a second transaction that first re-checks
 * the package, the drafts' image copy, the profile and every component. The
 * brand kit is only read when a chosen draft has image copy.
 */
async function attachCreatives(
  scope: Scope,
  packageId: string,
  keys: string[],
  acceptQaFindings: true | undefined,
  deps: PipelineDeps,
): Promise<PackageSnapshot & { creative?: CreativeReport }> {
  const planned = await chatScoped(scope, async (tx) => {
    const image = await loadPackageImage(tx, scope, packageId);
    const chosen: Chosen[] = [];
    for (const key of keys)
      chosen.push({
        key,
        draft: await chosenDraft(tx, scope, image, key),
        creative: { kind: "missing" },
      });
    const brand = chosen.some((entry) => hasUsableCopy(entry.draft))
      ? await packageBrandKit(tx, scope)
      : null;
    const kit = brand && "kit" in brand ? brand.kit : null;
    const kitCode = brand && "code" in brand ? brand.code : null;
    // A project without a primary logo keeps the raw image, unreported.
    if (kitCode === "PRIMARY_LOGO_REQUIRED") {
      for (const entry of chosen)
        await attachRawImage(tx, scope, image, entry.draft);
      return { snapshot: await snapshotOf(tx, scope, packageId) };
    }
    const art = kit ? await artAsset(tx, scope, image.asset.id) : null;
    for (const entry of chosen)
      entry.creative = !hasUsableCopy(entry.draft)
        ? { kind: "missing" }
        : kit
          ? await planPackageCreative(
              tx,
              scope,
              { packageId, art: art!, kit },
              entry.draft,
            )
          : { kind: "unavailable", code: kitCode! };
    return { chosen, art };
  });
  if (planned.snapshot) return planned.snapshot;
  const { chosen, art } = planned;
  // The package image is a single confirmed paid image: no regeneration, so
  // art findings stay with the owner (`CREATIVE_QA_FAILED`).
  for (const entry of chosen)
    if (entry.creative.kind === "compose")
      entry.composed = await composePlan(
        scope,
        entry.creative.plan,
        entry.creative.plan.kit.config.maxArtCorrections,
        deps,
      );
  // Every draft's findings are named at once, before anything is stored.
  const failing = chosen.flatMap((entry) =>
    entry.composed?.outcome.failed.length
      ? [
          {
            contentId: entry.draft.id,
            codes: [...entry.composed.outcome.failed],
          },
        ]
      : [],
  );
  if (failing.length && !acceptQaFindings)
    throw new PackageCreativeQaError({ failed: failing });
  return chatScoped(scope, async (tx) => {
    const image = await loadPackageImage(tx, scope, packageId);
    const report: CreativeReport = { composed: [], skipped: [] };
    for (const entry of chosen) {
      const draft = await chosenDraft(tx, scope, image, entry.key);
      // The draft the creative was planned and composed for.
      if (
        draft.id !== entry.draft.id ||
        hash(data(draft).creativeCopy) !== hash(data(entry.draft).creativeCopy)
      )
        throw new DomainError("CONTENT_CHANGED", 409);
      const { creative } = entry;
      if (creative.kind === "compose") {
        await savePackageCreative(
          tx,
          scope,
          { packageId, art: art!, acceptQaFindings },
          creative.plan,
          entry.composed!,
        );
        report.composed.push(draft.id);
      } else if (creative.kind !== "current") {
        await attachRawImage(tx, scope, image, draft);
        report.skipped.push({
          contentId: draft.id,
          code:
            creative.kind === "missing"
              ? "CREATIVE_COPY_MISSING"
              : creative.code,
        });
      }
    }
    return { ...(await snapshotOf(tx, scope, packageId)), creative: report };
  });
}

/**
 * Attaches the package image to every chosen draft, or to none when one
 * cannot take it. With the Creative Studio on and a primary logo in the brand
 * kit, a draft with image copy gets its own composed creative in its
 * channel's format instead of the raw image, and the snapshot carries
 * `creative: {composed, skipped}`: a draft without image copy keeps the raw
 * image and is listed as `CREATIVE_COPY_MISSING`, and when the brand kit
 * cannot compose (a logo that is no longer approved) the drafts with copy
 * keep it too, listed with the brand kit's code. A creative that fails its
 * checks (`CREATIVE_QA_FAILED`; its `detail` lists every failing draft with
 * its codes) refuses the whole attach unless the owner passes
 * `acceptQaFindings` (`OWNER_REQUIRED` for an editor); a refused creative
 * (`LOGO_INTEGRITY`, `ASSET_RIGHTS`), copy over the template's limits
 * (`CREATIVE_TEXT_TOO_LONG`) or a profile or component that changed
 * meanwhile (`MARKETING_PROFILE_CHANGED`, `BRAND_ASSET_CHANGED`) leave every
 * chosen draft unchanged. A raw image replaces a creative the draft carried.
 * Off, the raw image is attached as before.
 */
export async function attachPackageImage(
  scope: Scope,
  packageId: string,
  raw: unknown,
  deps: PipelineDeps = {},
): Promise<PackageSnapshot & { creative?: CreativeReport }> {
  authorize(scope, PROJECT_WRITE, "EDITOR_REQUIRED");
  if (!contentPackagesEnabled())
    throw new DomainError("CONTENT_PACKAGES_DISABLED", 409);
  const input = imageAttachment.parse(raw);
  // Accepting findings is the owner's decision, as in the studio.
  if (input.acceptQaFindings) authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const keys = [...new Set(input.deliverableKeys)];
  if (creativeStudioEnabled())
    return attachCreatives(
      scope,
      packageId,
      keys,
      input.acceptQaFindings,
      deps,
    );
  // One transaction: a refused draft leaves every chosen draft unchanged.
  return chatScoped(scope, async (tx) =>
    attachRawImages(
      tx,
      scope,
      await loadPackageImage(tx, scope, packageId),
      keys,
    ),
  );
}

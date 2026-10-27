import { createHash } from "node:crypto";
import {
  scoped,
  type DbTx,
} from "../../../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../../../packages/config/src/index.ts";
import type { ImageReference } from "../../../../../../../packages/ai/src/index.ts";
import type { Scope } from "../../../../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  hash,
  update,
} from "../../../../shared.ts";
import { assetBytes } from "../../../assets.ts";
import {
  channelLimitExceeded,
  resolveChannelRules,
} from "../../publishing/channel-rules.ts";
import { invalidateContent } from "../../pipeline/content-invalidation.ts";
import { driveContent } from "../../../../platform/connections/google-drive.ts";
import {
  currentImageTerms,
  generateAssignmentImage,
} from "../../brand/image-generation.ts";
import { mayTransmitToProvider } from "../../brand/provider-use.ts";
import { isApprovedAsset } from "../../brand/asset-rules.ts";
import { assetContent } from "../../creative/asset-content.ts";
import { renderRasterBanner } from "../../../../../../../packages/creative/src/index.ts";
import { assignmentHash } from "../assignments.ts";
import {
  approvedBannerLogo,
  assignmentBanner,
  BANNER_RENDER_FAILED,
  type BannerBrand,
  bannerBackgroundPrompt,
  bannerTextProblems,
  footerDomain,
  parsedBanner,
} from "../banner.ts";
import { errorCode } from "../../../telemetry.ts";
import {
  composeRunCreatives,
  creativeVisualStep,
} from "../../creative/assignment.ts";
import { assertTaskBudget, runBudgetKey } from "./runner.ts";
import type { AgentTask, StepHandler } from "./types.ts";

/**
 * Visual step of an assignment run (Orbit Agents, spec §5, §6, §8): one image
 * per run from the strategy's image idea, the brand profile and the
 * assignment's style references, generated through Orbit's image generation
 * without an owner request because the owner's assignment confirmation
 * carries the image rights consent. The asset is approved for use with that
 * consent as its rights source and is attached to every draft of the run
 * whose channel can carry it. Copywriters run in parallel: whichever step
 * finishes second attaches (the visual to existing drafts, a copywriter to an
 * existing image), so both orders end with the same drafts illustrated.
 * With a banner (R78) the image is only the background: each draft gets its
 * own banner composed over it (`composeRunBanners`), one per slot. With a
 * creative (Creative Studio) the step makes art per post or run instead
 * (`creativeVisualStep`) and each draft gets its own composed creative
 * (`composeRunCreatives`), never the raw art.
 */
export const ASSET_RIGHTS_REQUIRED = "ASSET_RIGHTS_REQUIRED";
const STYLES = "assignment_style_descriptions";
const MAX_STYLE_TEXT = 1500;
// Publications in these states no longer hold the post.
const INACTIVE_PUBLICATION = ["canceled", "failed", "blocked_dependency"];

/** One switch for reference images (`images.edit`); off uses the stored style description (R8). */
export function imageReferencesEnabled() {
  return loadConfig().ORBIT_IMAGE_REFERENCES === "true";
}

/** The image of a task's run: requested once per visual task (R26, R37). */
export const runImageRequestId = (taskId: string) => `agent:${taskId}:image`;

/**
 * The rights source of an assignment image: the owner's confirmation must
 * include the image consent and still cover the assignment's current content.
 */
export function imageRightsSource(row: { id: string; data: unknown }) {
  const d = data(row);
  const confirmation = d.confirmation;
  if (
    d.image !== true ||
    confirmation?.imageRightsConsent !== true ||
    confirmation.assignmentHash !== assignmentHash(d)
  )
    throw new DomainError(ASSET_RIGHTS_REQUIRED, 409);
  return {
    assignmentId: row.id,
    confirmationHash: String(confirmation.assignmentHash),
  };
}

/**
 * The run's assets in creation order: its image (a banner run's background,
 * R78) first, then its composed banners (`bannerKey`); a creative run's art
 * (`creativeArt`, Creative Studio).
 */
export function runAssets(tx: DbTx, scope: Scope, runId: string) {
  return tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "assets",
      data: { path: ["assignmentRunId"], equals: runId },
    },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Which composed banner belongs to a draft (R78): the run's background and
 * its bytes (SHA-256), the draft's banner copy, the domain of its link and
 * the brand around them (product name, logo id and bytes). A shared copy
 * (R76) has the same copy and link, so it has the same banner. Versions are
 * left out on purpose: a Drive sync or retry bumps an asset's version
 * without changing what the banner shows.
 */
export function bannerKeyOf(
  background: { id: string; data: unknown },
  content: Record<string, any>,
  brand: BannerBrand,
) {
  const text = parsedBanner(content.banner);
  const footer = footerDomain(content.targetUrl);
  return text && footer
    ? hash({
        backgroundId: background.id,
        backgroundSha256: String(data(background).sha256 ?? "").toLowerCase(),
        text,
        footer,
        brand,
      })
    : null;
}

/** The brand banners are composed with now, or null without an approved logo. */
async function currentBrand(tx: DbTx, scope: Scope) {
  try {
    return (await approvedBannerLogo(tx, scope)).brand;
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}

const approvedRow = (row: { data: unknown } | null) =>
  Boolean(
    row &&
    data(row).usageApproved === true &&
    data(row).assetStatus === "approved",
  );

function findAsset(tx: DbTx, scope: Scope, id: unknown) {
  return typeof id === "string"
    ? tx.entity.findFirst({
        where: {
          id,
          kind: "assets",
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
        },
      })
    : Promise.resolve(null);
}

/** An asset's stored SHA-256, lower case. */
const sha = (row: { data: unknown } | null) =>
  String(data(row).sha256 ?? "").toLowerCase();

/**
 * Whether a composed banner still stands on approved, unchanged sources
 * (R78): the banner itself, its background and its logo are approved, the
 * background and logo still hold the bytes it was composed from (SHA-256,
 * not the entity version, so Drive syncs and retries change nothing), and
 * the logo is still the profile's.
 */
async function bannerSourcesHold(
  tx: DbTx,
  scope: Scope,
  banner: { data: unknown } | null,
  brand: BannerBrand | null,
) {
  if (!banner || !brand || !approvedRow(banner)) return false;
  const d = data(banner);
  const rights = d.rightsSource ?? {};
  const background = await findAsset(tx, scope, d.visualAssetId);
  const logo = await findAsset(tx, scope, d.brandAssetId);
  return (
    approvedRow(background) &&
    Boolean(rights.backgroundSha256) &&
    sha(background) === rights.backgroundSha256 &&
    approvedRow(logo) &&
    Boolean(rights.logoSha256) &&
    sha(logo) === rights.logoSha256 &&
    brand.logoId === logo!.id &&
    brand.logoSha256 === sha(logo)
  );
}

/**
 * The run's composed banner for a draft whose sources still hold, or null
 * (R78).
 */
async function draftBanner(
  tx: DbTx,
  scope: Scope,
  assets: Awaited<ReturnType<typeof runAssets>>,
  background: { id: string; data: unknown },
  content: Record<string, any>,
  brand: BannerBrand | null,
) {
  const key = brand ? bannerKeyOf(background, content, brand) : null;
  const banner = key
    ? (assets.find((row) => data(row).bannerKey === key) ?? null)
    : null;
  return (await bannerSourcesHold(tx, scope, banner, brand)) ? banner : null;
}

/**
 * Attaches the run's image to every draft of the run that can carry it and
 * does not have it yet: social drafts on a channel with known media support
 * whose text fits the media limit (Telegram sends it as a caption of at most
 * 1,024 characters), blog and newsletter drafts always. A banner run (R78)
 * attaches each draft's own composed banner, never the background, and
 * only while its sources hold. A draft that is scheduled, archived,
 * rejected or replaced is left alone. Idempotent.
 */
export async function attachRunImage(tx: DbTx, scope: Scope, runId: string) {
  const attached: string[] = [];
  const skipped: Array<{ contentId: string; code: string }> = [];
  const assets = await runAssets(tx, scope, runId);
  // A creative run's art is never attached raw: each draft gets its composed creative.
  const image = assets.find(
    (row) => !data(row).bannerKey && data(row).creativeArt !== true,
  );
  if (!image) return { assetId: null, attached, skipped };
  const bannerRun = data(image).bannerBackground === true;
  const brand = bannerRun ? await currentBrand(tx, scope) : null;
  const drafts = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "content",
      data: { path: ["assignmentRunId"], equals: runId },
    },
    orderBy: { createdAt: "asc" },
  });
  for (const draft of drafts) {
    const v = data(draft);
    // An archived, rejected or replaced draft stays as it is.
    if (["archived", "rejected"].includes(v.status) || v.supersededBy) continue;
    const asset = bannerRun
      ? await draftBanner(tx, scope, assets, image, v, brand)
      : image;
    if (!asset) {
      skipped.push({ contentId: draft.id, code: "BANNER_NOT_COMPOSED" });
      continue;
    }
    if (v.assetId === asset.id) {
      attached.push(draft.id);
      continue;
    }
    // A banner of this run that is no longer the draft's own (its copy or
    // sources changed) gives way to the current one on a draft not yet
    // reviewed (R78); a reviewed draft keeps what was reviewed and the
    // review's banner check catches it.
    const stale =
      bannerRun &&
      v.status === "draft" &&
      (await findAsset(tx, scope, v.assetId).then(
        (row) => data(row).boundTo?.runId === runId,
      ));
    const code = !approvedRow(asset)
      ? ASSET_RIGHTS_REQUIRED
      : v.assetId && !stale
        ? "ASSET_ALREADY_ATTACHED"
        : await attachRefusal(tx, scope, draft.id, v);
    if (code) {
      skipped.push({ contentId: draft.id, code });
      continue;
    }
    // The draft changed: a review or approval of the text without the image no longer applies.
    const { review: _review, ...rest } = v;
    await update(tx, scope, draft, {
      ...rest,
      assetId: asset.id,
      status: "draft",
    });
    await invalidateContent(tx, scope, draft.id);
    await audit(tx, scope, "assignment.image_attached", draft.id, {
      assignmentRunId: runId,
      assetId: asset.id,
      assetVersion: asset.version,
    });
    attached.push(draft.id);
  }
  return { assetId: image.id, attached, skipped };
}

/**
 * The banner state of a draft of a banner run (R78): `own` when it carries
 * its own composed banner on sources that still hold; `render_failed` when
 * composing its banner failed; `media_refused` when its banner exists but
 * its channel cannot carry an image; else `missing`.
 */
export async function bannerState(
  tx: DbTx,
  scope: Scope,
  content: Record<string, any>,
): Promise<"own" | "render_failed" | "media_refused" | "missing"> {
  const brand = await currentBrand(tx, scope);
  const attached = await findAsset(tx, scope, content.assetId);
  const attachedBackground = attached
    ? await findAsset(tx, scope, data(attached).visualAssetId)
    : null;
  if (
    attached &&
    attachedBackground &&
    brand &&
    data(attached).boundTo?.runId === content.assignmentRunId &&
    data(attached).bannerKey ===
      bannerKeyOf(attachedBackground, content, brand) &&
    (await bannerSourcesHold(tx, scope, attached, brand))
  )
    return "own";
  const assets = await runAssets(tx, scope, String(content.assignmentRunId));
  const background = assets.find(
    (row) => !data(row).bannerKey && data(row).bannerBackground === true,
  );
  const key =
    background && brand ? bannerKeyOf(background, content, brand) : null;
  if (key && content.bannerFailure?.key === key) return "render_failed";
  if (
    background &&
    (await draftBanner(tx, scope, assets, background, content, brand)) &&
    (await mediaRefusal(tx, scope, content))
  )
    return "media_refused";
  return "missing";
}

/** Whether a draft carries its own composed banner (R78). */
export async function hasOwnBanner(
  tx: DbTx,
  scope: Scope,
  content: Record<string, any>,
) {
  return (await bannerState(tx, scope, content)) === "own";
}

/**
 * Puts the run's composed banner on one fresh copy of a shared text (R76,
 * R78) whose original went without it (its own channel refused media),
 * when the copy's channel can carry it. Returns whether it attached.
 */
export async function attachOwnBanner(
  tx: DbTx,
  scope: Scope,
  row: Awaited<ReturnType<typeof entity>>,
) {
  const v = data(row);
  if (v.assetId || parsedBanner(v.banner) === null) return false;
  const assets = await runAssets(tx, scope, String(v.assignmentRunId));
  const background = assets.find(
    (asset) => !data(asset).bannerKey && data(asset).bannerBackground === true,
  );
  if (!background) return false;
  const banner = await draftBanner(
    tx,
    scope,
    assets,
    background,
    v,
    await currentBrand(tx, scope),
  );
  if (!banner || (await mediaRefusal(tx, scope, v))) return false;
  const { imageSkipped: _skipped, ...rest } = v;
  await update(tx, scope, row, { ...rest, assetId: banner.id });
  await audit(tx, scope, "assignment.image_attached", row.id, {
    assignmentRunId: v.assignmentRunId,
    assetId: banner.id,
    assetVersion: banner.version,
  });
  return true;
}

/** Why a draft cannot take an image: it is scheduled, or its channel cannot carry one; else null. */
export async function attachRefusal(
  tx: DbTx,
  scope: Scope,
  contentId: string,
  v: Record<string, any>,
) {
  const scheduled = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "publications",
      AND: [
        { data: { path: ["contentId"], equals: contentId } },
        {
          NOT: INACTIVE_PUBLICATION.map((status) => ({
            data: { path: ["status"], equals: status },
          })),
        },
      ],
    },
  });
  if (scheduled) return "ALREADY_SCHEDULED";
  return mediaRefusal(tx, scope, v);
}

/**
 * Why a draft's channel cannot carry an image, or null: no known media
 * support, or a text longer than the channel's caption limit. Also used for
 * the per-channel copies of a shared text (R76).
 */
export async function mediaRefusal(
  tx: DbTx,
  scope: Scope,
  v: Record<string, any>,
) {
  if (v.type !== "social") return null;
  const rules = await resolveChannelRules(tx, scope, v.channel, v.type, true);
  if (!rules.liveCapabilityKnown) return "MEDIA_NOT_SUPPORTED";
  if (channelLimitExceeded(String(v.body ?? ""), v.targetUrl, rules))
    return "CAPTION_TOO_LONG";
  return null;
}

/** A written style from the references' recorded names, prompts and tags; no model call, no cost. */
function describeStyle(rows: Array<{ data: unknown }>) {
  const parts = rows.map((row) => {
    const d = data(row);
    return [
      String(d.name ?? "").trim(),
      typeof d.prompt === "string" ? d.prompt.trim() : "",
      Array.isArray(d.tags) && d.tags.length
        ? `tags: ${d.tags.join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join(" - ");
  });
  return `Follow the look of these approved references: ${parts.join("; ")}`.slice(
    0,
    MAX_STYLE_TEXT,
  );
}

/**
 * The approved style references of an assignment (R6: uploaded or Orbit
 * generated assets with approved usage, raster images only). Their stored
 * description goes into the prompt as before; their bytes go to the image
 * provider only for assets the owner marked for provider use
 * (`referenceImages`, R28 as narrowed by R64).
 */
async function styleAssets(tx: DbTx, scope: Scope, ids: string[]) {
  if (!ids.length) return [];
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "assets",
      id: { in: ids },
    },
  });
  return ids.flatMap((id) => {
    const row = rows.find((candidate) => candidate.id === id);
    const d = data(row);
    return row &&
      isApprovedAsset(d) &&
      // A composed banner is bound to its post (R78), never a style reference.
      !d.boundTo &&
      ["image/png", "image/jpeg", "image/webp"].includes(d.mime)
      ? [row]
      : [];
  });
}

/**
 * The style description stored for an assignment and its current references,
 * derived once and kept in its own row (changing the assignment row would
 * change its confirmed version).
 */
async function storedStyleDescription(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
  rows: Array<{ id: string; data: unknown }>,
) {
  if (!rows.length) return null;
  const assetIds = rows.map((row) => row.id);
  const existing = await tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: STYLES,
      data: { path: ["assignmentId"], equals: assignmentId },
    },
  });
  if (
    existing &&
    JSON.stringify(data(existing).assetIds) === JSON.stringify(assetIds)
  )
    return String(data(existing).text);
  const value = {
    assignmentId,
    assetIds,
    text: describeStyle(rows),
    method: "asset_metadata",
    derivedAt: new Date().toISOString(),
  };
  if (existing) await update(tx, scope, existing, value);
  else await create(tx, scope, STYLES, value);
  return value.text;
}

/**
 * Reference image bytes of the references the owner marked for provider use
 * (R28, whatever their type); a reference that cannot be read is left out.
 */
async function referenceImages(
  scope: Scope,
  rows: Array<{ id: string; data: unknown }>,
) {
  const references: ImageReference[] = [];
  for (const row of rows) {
    const d = data(row);
    if (!mayTransmitToProvider(d)) continue;
    try {
      const content =
        d.driveFileId && !d.base64
          ? await driveContent(scope, d.driveFileId, {
              md5Checksum: d.md5Checksum,
              modifiedTime: d.driveModifiedTime,
            })
          : assetBytes(d);
      if (!["image/png", "image/jpeg", "image/webp"].includes(content.mime))
        continue;
      references.push({
        bytes: content.bytes,
        mime: content.mime as ImageReference["mime"],
        filename: `reference-${references.length + 1}.${content.mime.split("/")[1]}`,
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
  }
  return references;
}

/** The image idea of the run: the first brief's, else its topic. */
function imageIdea(task: AgentTask) {
  const briefs = (task.input as any)?.inputs?.strategy?.briefs;
  if (!Array.isArray(briefs) || !briefs.length)
    throw new DomainError("AGENT_BRIEFS_MISSING");
  const withIdea = briefs.find(
    (brief: any) => typeof brief.imageIdea === "string" && brief.imageIdea,
  );
  return String(withIdea?.imageIdea ?? briefs[0].topic);
}

/** Resume only local work after an image save committed before the worker stopped. */
export async function recoverPersistedVisual(
  scope: Scope,
  task: AgentTask,
  assetId: string,
) {
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    imageRightsSource(
      await entity(tx, scope, "assignments", task.assignmentId),
    );
    const asset = await entity(tx, scope, "assets", assetId);
    const a = data(asset);
    if (
      a.generationId !== runImageRequestId(task.id) ||
      a.agentTaskId !== task.id ||
      a.assignmentRunId !== task.runId ||
      a.assignmentId !== task.assignmentId ||
      !approvedRow(asset)
    )
      throw new DomainError(ASSET_RIGHTS_REQUIRED, 409);
  });
  return { assetId, ...(await attach(scope, task)) };
}

export const visualStep: StepHandler = async (scope, task) => {
  const inScope = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, work);
  // An assignment with a creative (Creative Studio) gets art per post or run, composed per draft.
  const assignment = await inScope((tx) =>
    entity(tx, scope, "assignments", task.assignmentId),
  );
  if (data(assignment).creative) {
    const { assetIds, skipped, correctionErrors } = await creativeVisualStep(
      scope,
      task,
    );
    return {
      assetIds,
      ...(skipped.length ? { skippedUnits: skipped } : {}),
      ...(correctionErrors.length ? { correctionErrors } : {}),
      ...(await attach(scope, task, skipped)),
    };
  }
  const idea = imageIdea(task);
  const requestId = runImageRequestId(task.id);
  // A restarted task finds its image instead of generating a second one (R26).
  const existing = await inScope((tx) =>
    tx.entity.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "assets",
        data: { path: ["generationId"], equals: requestId },
      },
    }),
  );
  if (existing) return { assetId: existing.id, ...(await attach(scope, task)) };
  const prepared = await inScope(async (tx) => {
    const row = await entity(tx, scope, "assignments", task.assignmentId);
    const rightsSource = imageRightsSource(row);
    // A banner (R78) needs the approved logo; without it nothing is generated or paid.
    const banner = data(row).banner
      ? assignmentBanner.parse(data(row).banner)
      : null;
    if (banner) await approvedBannerLogo(tx, scope);
    const rows = await styleAssets(
      tx,
      scope,
      (data(row).styleAssetIds ?? []) as string[],
    );
    const useReferences = imageReferencesEnabled();
    return {
      rightsSource,
      rows,
      useReferences,
      banner,
      contentType: String(data(row).contentType),
      name: String(data(row).name),
      userId: String(data(row).confirmation.userId),
    };
  });
  const references = prepared.useReferences
    ? await referenceImages(scope, prepared.rows)
    : [];
  // Without readable references (switch off or none usable) the stored description carries the style.
  const styleDescription = references.length
    ? null
    : await inScope((tx) =>
        storedStyleDescription(tx, scope, task.assignmentId, prepared.rows),
      );
  const banner = prepared.banner;
  const asset = await generateAssignmentImage(
    scope,
    {
      requestId,
      name: `Assignment ${banner ? "banner background" : "image"}: ${prepared.name}`,
      // A banner's background follows the banner style, the same for every slot (R78).
      prompt: banner ? bannerBackgroundPrompt(banner) : idea,
      ...(banner ? { size: "1536x1024" as const } : {}),
      validUses: [
        prepared.contentType === "newsletter"
          ? "newsletter"
          : prepared.contentType === "blog"
            ? "blog"
            : "social",
      ],
      references,
      styleDescription,
      userId: prepared.userId,
      assetFields: {
        usageApproved: true,
        assetStatus: "approved",
        license:
          "AI-generated asset; usage approved by the owner's assignment confirmation",
        rightsSource: prepared.rightsSource,
        assignmentId: task.assignmentId,
        assignmentRunId: task.runId,
        agentTaskId: task.id,
        ...(banner
          ? { bannerBackground: true, bannerTemplate: banner.template }
          : {}),
      },
    },
    {
      runKey: runBudgetKey(task.runId),
      // In the reservation transaction: the consent still holds and the image fits the task and month.
      authorize: async (tx) => {
        imageRightsSource(
          await entity(tx, scope, "assignments", task.assignmentId),
        );
        const { imageConfig } = await currentImageTerms(tx, scope);
        await assertTaskBudget(
          tx,
          scope,
          task,
          imageConfig.maxCostMicrosPerImage,
        );
      },
    },
  );
  // The image is committed (and paid) before anything is attached.
  return { assetId: asset.id, ...(await attach(scope, task)) };
};

/**
 * Composes the run's banners (R78) and creatives (Creative Studio; with the
 * art units this step skipped, `refused`) and attaches the run image in its
 * own transaction. A failure never touches the stored image: it is
 * reported, and the next attach of the run (a later copywriter or a
 * restarted task) puts the image on the drafts. A banner or creative
 * failure never stops the attach of those already composed.
 */
async function attach(
  scope: Scope,
  task: AgentTask,
  refused: Array<{ unit: string; code: string }> = [],
) {
  let banners: Awaited<ReturnType<typeof composeRunBanners>> | null = null;
  let bannerError: string | null = null;
  try {
    banners = await composeRunBanners(scope, task.runId);
    bannerError = banners.error ?? null;
  } catch (error) {
    bannerError = errorCode(error);
  }
  let creatives: Awaited<ReturnType<typeof composeRunCreatives>> | null = null;
  let creativeError: string | null = null;
  try {
    creatives = await composeRunCreatives(scope, task.runId, { refused });
    creativeError = creatives.error;
  } catch (error) {
    creativeError = errorCode(error);
  }
  const reported = {
    ...(banners?.composed.length ? { banners: banners.composed } : {}),
    ...(banners?.failed.length ? { bannerFailures: banners.failed } : {}),
    ...(bannerError ? { bannerError } : {}),
    ...(creatives?.composed.length ? { creatives: creatives.composed } : {}),
    ...(creatives?.failed.length ? { creativeFailures: creatives.failed } : {}),
    ...(creativeError ? { creativeError } : {}),
  };
  try {
    const result = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      attachRunImage(tx, scope, task.runId),
    );
    return { attached: result.attached, skipped: result.skipped, ...reported };
  } catch (error) {
    return {
      attached: [],
      skipped: [],
      attachError: errorCode(error),
      ...reported,
    };
  }
}

/** An approved image's bytes, from the stored copy or Drive. */
async function imageBytes(scope: Scope, d: Record<string, any>) {
  const content = await assetContent(scope, d);
  return `data:${content.mime};base64,${content.bytes.toString("base64")}`;
}

/** Serializes the banner and creative saves of one run (parallel copywriters and the visual step). */
export const lockRun = (tx: DbTx, scope: Scope, runId: string) =>
  tx.$queryRaw`SELECT id FROM "Entity" WHERE id=${runId}::uuid AND "projectId"=${scope.projectId}::uuid FOR UPDATE`;

/**
 * Composes one banner per banner copy of a banner run (R78): over the run's
 * background (generated once per run, art only), the `brand_landscape`
 * template places the profile's approved logo (its exact stored bytes) and
 * product name, the draft's banner copy and the domain of its official
 * link. Each banner is stored once per key (background, copy, domain,
 * brand) as an approved asset bound to its run and draft (`boundTo`: kept
 * out of the asset library and pickers), whose rights are the assignment's
 * image consent plus the background's and logo's versions. The save runs
 * under the run's lock and checks again that consent, background (approval,
 * bytes), logo and product name are unchanged (`BRAND_ASSET_CHANGED` stops
 * further saves; logo bytes that fail their hash stop it as
 * `BRAND_ASSET_INTEGRITY_FAILED`; banners
 * already stored stay). Rendering runs outside any transaction, per banner:
 * a render failure is recorded on its drafts (`bannerFailure`,
 * `BANNER_RENDER_FAILED`) and the other slots go on. Copy with a
 * deterministic banner problem gets no banner: the review sends it back or
 * rejects it. Free: no model call.
 */
export async function composeRunBanners(scope: Scope, runId: string) {
  const inScope = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, work);
  const composed: string[] = [];
  const failed: Array<{ contentId: string; code: string }> = [];
  const plan = await inScope(async (tx) => {
    const assets = await runAssets(tx, scope, runId);
    const background = assets.find((row) => !data(row).bannerKey);
    if (!background || data(background).bannerBackground !== true) return null;
    if (!approvedRow(background))
      throw new DomainError(ASSET_RIGHTS_REQUIRED, 409);
    const run = data(await entity(tx, scope, "assignment_runs", runId));
    const assignment = await entity(
      tx,
      scope,
      "assignments",
      String(run.assignmentId),
    );
    const rightsSource = imageRightsSource(assignment);
    const logo = await approvedBannerLogo(tx, scope);
    const drafts = await tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "content",
        data: { path: ["assignmentRunId"], equals: runId },
      },
      orderBy: { createdAt: "asc" },
    });
    // Only banners whose sources still hold count as done (R78).
    const done = new Set<string>();
    for (const row of assets)
      if (
        data(row).bannerKey &&
        (await bannerSourcesHold(tx, scope, row, logo.brand))
      )
        done.add(String(data(row).bannerKey));
    const todo = new Map<
      string,
      { contentIds: string[]; v: Record<string, any> }
    >();
    for (const draft of drafts) {
      const v = data(draft);
      if (["archived", "rejected"].includes(v.status) || v.supersededBy)
        continue;
      const key = bannerKeyOf(background, v, logo.brand);
      // Copy the review will refuse or send back gets no banner (R78); its
      // button is the mission CTA, checked as campaign copy.
      const mission = v.missionId
        ? data(await entity(tx, scope, "missions", v.missionId))
        : null;
      const refused = bannerTextProblems(v.banner, {
        brandName: logo.productName,
        footer: footerDomain(v.targetUrl) ?? "",
        cta: mission?.targetAction,
      }).length;
      if (!key || refused || done.has(key)) continue;
      const entry = todo.get(key);
      if (entry) entry.contentIds.push(draft.id);
      else todo.set(key, { contentIds: [draft.id], v });
    }
    return {
      background,
      logo,
      rightsSource,
      approvedBy: String(data(assignment).confirmation?.userId ?? ""),
      assignmentId: assignment.id,
      assignmentName: String(data(assignment).name),
      todo: [...todo.entries()],
    };
  });
  if (!plan?.todo.length) return { composed, failed, error: null };
  const backgroundUri = await imageBytes(scope, data(plan.background));
  const logo = data(plan.logo.row);
  const logoUri = await imageBytes(scope, logo);
  for (const [key, { contentIds, v }] of plan.todo) {
    const text = parsedBanner(v.banner)!;
    let rendered: Awaited<ReturnType<typeof renderRasterBanner>>;
    try {
      rendered = await renderRasterBanner({
        template: "brand_landscape",
        text,
        brandName: plan.logo.productName,
        footer: footerDomain(v.targetUrl)!,
        logoApproved: true,
        logoDataUri: logoUri,
        logoSha256: String(logo.sha256),
        backgroundDataUri: backgroundUri,
      });
      if (rendered.status !== "rendered") throw new Error("BLOCKED_ASSET");
    } catch (error) {
      // Copy that does not fit is the review's to send back (BANNER_TEXT_OVERFLOW).
      if (errorCode(error) === "TEXT_OVERFLOW") continue;
      // Logo bytes that are not the approved ones stop the run's banners.
      if (errorCode(error) === "BRAND_ASSET_INTEGRITY_FAILED")
        return { composed, failed, error: "BRAND_ASSET_INTEGRITY_FAILED" };
      // Only these drafts go without a banner; the review leaves them for the owner.
      await inScope(async (tx) => {
        for (const contentId of contentIds) {
          const row = await entity(tx, scope, "content", contentId);
          await update(tx, scope, row, {
            ...data(row),
            bannerFailure: {
              key,
              code: BANNER_RENDER_FAILED,
              error: errorCode(error),
              at: new Date().toISOString(),
            },
          });
          failed.push({ contentId, code: BANNER_RENDER_FAILED });
        }
      });
      continue;
    }
    const { bytes, svg: _svg, ...metadata } = rendered;
    try {
      const saved = await inScope(async (tx) => {
        await lockRun(tx, scope, runId);
        // Consent, background, logo and profile still hold when the banner is stored.
        imageRightsSource(
          await entity(tx, scope, "assignments", plan.assignmentId),
        );
        // What the banner shows is compared, not entity versions (a Drive
        // sync bumps a version): the brand (product name, logo id and
        // bytes) and the background's approval and bytes, also the bytes
        // that were rendered.
        const current = await approvedBannerLogo(tx, scope);
        const background = await findAsset(tx, scope, plan.background.id);
        if (
          hash(current.brand) !== hash(plan.logo.brand) ||
          !approvedRow(background) ||
          sha(background) !== sha(plan.background) ||
          rendered.backgroundHash !== sha(plan.background) ||
          rendered.logoHash !== plan.logo.brand.logoSha256
        )
          throw new DomainError("BRAND_ASSET_CHANGED", 409);
        const existing = (await runAssets(tx, scope, runId)).find(
          (row) => data(row).bannerKey === key,
        );
        if (existing) return null;
        const asset = await create(tx, scope, "assets", {
          ...metadata,
          name: `Banner: ${plan.assignmentName}`.slice(0, 160),
          type: "generated_artwork",
          filename: "banner-brand-landscape.png",
          base64: bytes.toString("base64"),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
          source: "template",
          sourceType: "TEMPLATE_GENERATED",
          usageApproved: true,
          assetStatus: "approved",
          // The owner whose assignment confirmation carries the consent.
          approvedBy: plan.approvedBy,
          license:
            "Composed by Orbit from the run's AI-generated background (owner's assignment consent) and the approved logo",
          rightsSource: {
            ...plan.rightsSource,
            backgroundAssetId: plan.background.id,
            backgroundSha256: sha(plan.background),
            // Versions for the record only; the checks compare the bytes.
            backgroundVersion: plan.background.version,
            logoAssetId: plan.logo.row.id,
            logoSha256: plan.logo.brand.logoSha256,
            logoVersion: plan.logo.row.version,
          },
          brandAssetId: plan.logo.row.id,
          brandName: plan.logo.productName,
          visualAssetId: plan.background.id,
          profileVersion: plan.logo.profileVersion,
          assignmentId: plan.assignmentId,
          assignmentRunId: runId,
          // Bound to its run and draft: not in the asset library or pickers.
          boundTo: { runId, contentId: contentIds[0] },
          bannerKey: key,
          bannerText: text,
          channel: "Social",
          validUses: ["social"],
          driveSyncStatus: "LOCAL_ONLY",
        });
        await audit(tx, scope, "assignment.banner_composed", asset.id, {
          assignmentRunId: runId,
          contentIds,
          backgroundAssetId: plan.background.id,
          logoAssetId: plan.logo.row.id,
        });
        return asset.id;
      });
      if (saved) composed.push(saved);
    } catch (error) {
      // A changed source stops this run's banners; those stored stay.
      return { composed, failed, error: errorCode(error) };
    }
  }
  return { composed, failed, error: null as string | null };
}

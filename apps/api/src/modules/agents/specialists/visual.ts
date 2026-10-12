import { createHash } from "node:crypto";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import type { ImageReference } from "../../../../../../packages/ai/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  hash,
  update,
} from "../../../shared.ts";
import { assetBytes } from "../../assets.ts";
import {
  channelLimitExceeded,
  resolveChannelRules,
} from "../../channel-rules.ts";
import { invalidateContent } from "../../content-invalidation.ts";
import { driveContent } from "../../google-drive.ts";
import {
  currentImageTerms,
  generateAssignmentImage,
} from "../../image-generation.ts";
import { renderRasterBanner } from "../../../../../../packages/creative/src/index.ts";
import { assignmentHash } from "../assignments.ts";
import {
  approvedBannerLogo,
  assignmentBanner,
  bannerBackgroundPrompt,
  bannerTextProblems,
  footerDomain,
  parsedBanner,
} from "../banner.ts";
import { errorCode } from "../../telemetry.ts";
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
 * own banner composed over it (`composeRunBanners`), one per slot.
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
 * R78) first, then its composed banners (`bannerKey`).
 */
function runAssets(tx: DbTx, scope: Scope, runId: string) {
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
 * Which composed banner belongs to a draft (R78): the run's background, the
 * draft's banner copy and the domain of its link. A shared copy (R76) has
 * the same copy and link, so it has the same banner.
 */
export function bannerKeyOf(
  backgroundId: string,
  content: Record<string, any>,
) {
  const text = parsedBanner(content.banner);
  const footer = footerDomain(content.targetUrl);
  return text && footer ? hash({ backgroundId, text, footer }) : null;
}

/**
 * Attaches the run's image to every draft of the run that can carry it and
 * does not have it yet: social drafts on a channel with known media support
 * whose text fits the media limit (Telegram sends it as a caption of at most
 * 1,024 characters), blog and newsletter drafts always. A draft that is
 * scheduled, archived, rejected or replaced is left alone. Idempotent.
 */
export async function attachRunImage(tx: DbTx, scope: Scope, runId: string) {
  const attached: string[] = [];
  const skipped: Array<{ contentId: string; code: string }> = [];
  const assets = await runAssets(tx, scope, runId);
  const image = assets.find((row) => !data(row).bannerKey);
  if (!image) return { assetId: null, attached, skipped };
  // A banner run (R78) attaches each draft's own composed banner, never the background.
  const bannerRun = data(image).bannerBackground === true;
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
    const key = bannerRun ? bannerKeyOf(image.id, v) : null;
    const asset = bannerRun
      ? assets.find((row) => key && data(row).bannerKey === key)
      : image;
    if (!asset) {
      skipped.push({ contentId: draft.id, code: "BANNER_NOT_COMPOSED" });
      continue;
    }
    if (v.assetId === asset.id) {
      attached.push(draft.id);
      continue;
    }
    const approved =
      data(asset).usageApproved === true &&
      data(asset).assetStatus === "approved";
    const code = !approved
      ? ASSET_RIGHTS_REQUIRED
      : v.assetId
        ? "ASSET_ALREADY_ATTACHED"
        : await refusal(tx, scope, draft.id, v);
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
 * Whether a draft carries its own composed banner (R78): an approved banner
 * of its run whose key matches the draft's copy and link.
 */
export async function hasOwnBanner(
  tx: DbTx,
  scope: Scope,
  content: Record<string, any>,
) {
  if (typeof content.assetId !== "string") return false;
  const asset = await tx.entity.findFirst({
    where: {
      id: content.assetId,
      kind: "assets",
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
    },
  });
  const d = data(asset);
  return Boolean(
    asset &&
    d.usageApproved === true &&
    d.assetStatus === "approved" &&
    d.assignmentRunId === content.assignmentRunId &&
    typeof d.visualAssetId === "string" &&
    d.bannerKey === bannerKeyOf(d.visualAssetId, content),
  );
}

/** Why a draft cannot take the image, or null. */
async function refusal(
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
 * generated assets with approved usage, raster images only).
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
      d.usageApproved === true &&
      d.assetStatus === "approved" &&
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

/** Reference image bytes; a reference that cannot be read is left out. */
async function referenceImages(
  scope: Scope,
  rows: Array<{ id: string; data: unknown }>,
) {
  const references: ImageReference[] = [];
  for (const row of rows) {
    const d = data(row);
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

export const visualStep: StepHandler = async (scope, task) => {
  const idea = imageIdea(task);
  const requestId = runImageRequestId(task.id);
  const inScope = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, work);
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
 * Composes the run's banners (R78) and attaches the run image in its own
 * transaction. A failure never touches the stored image: it is reported, and
 * the next attach of the run (a later copywriter or a restarted task) puts
 * the image on the drafts.
 */
async function attach(scope: Scope, task: AgentTask) {
  try {
    const { composed } = await composeRunBanners(scope, task.runId);
    const result = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      attachRunImage(tx, scope, task.runId),
    );
    return {
      attached: result.attached,
      skipped: result.skipped,
      ...(composed.length ? { banners: composed } : {}),
    };
  } catch (error) {
    return { attached: [], skipped: [], attachError: errorCode(error) };
  }
}

/** An approved image's bytes, from the stored copy or Drive. */
async function imageBytes(scope: Scope, d: Record<string, any>) {
  const content =
    d.driveFileId && !d.base64
      ? await driveContent(scope, d.driveFileId, {
          md5Checksum: d.md5Checksum,
          modifiedTime: d.driveModifiedTime,
        })
      : assetBytes(d);
  if (!["image/png", "image/jpeg", "image/webp"].includes(content.mime))
    throw new DomainError("BRAND_IMAGE_FORMAT_UNSUPPORTED", 415);
  return {
    uri: `data:${content.mime};base64,${content.bytes.toString("base64")}`,
    hash: createHash("sha256").update(content.bytes).digest("hex"),
  };
}

/**
 * Composes one banner per banner copy of a banner run (R78): over the run's
 * background (generated once per run, art only), the `brand_landscape`
 * template places the profile's approved logo and product name, the draft's
 * banner copy and the domain of its official link. Each banner is stored
 * once per key (background, copy, domain) as an approved asset whose rights
 * are the assignment's image consent plus the approved logo; a shared run's
 * slot (R76) has one copy and so one banner for all its channels. Rendering
 * runs outside any transaction. Copy with a deterministic banner problem
 * (too long for the template, a figure, status or promise) gets no banner:
 * the review sends it back or rejects it. Free: no model call. Returns the
 * ids of the banners it stored.
 */
export async function composeRunBanners(scope: Scope, runId: string) {
  const inScope = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, work);
  const plan = await inScope(async (tx) => {
    const assets = await runAssets(tx, scope, runId);
    const background = assets.find((row) => !data(row).bannerKey);
    if (!background || data(background).bannerBackground !== true) return null;
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
    const done = new Set(assets.map((row) => data(row).bannerKey));
    const todo = new Map<
      string,
      { contentId: string; v: Record<string, any> }
    >();
    for (const draft of drafts) {
      const v = data(draft);
      if (["archived", "rejected"].includes(v.status) || v.supersededBy)
        continue;
      const key = bannerKeyOf(background.id, v);
      // Copy the review will refuse or send back gets no banner (R78).
      const refused = bannerTextProblems(v.banner, {
        brandName: logo.productName,
        footer: footerDomain(v.targetUrl) ?? "",
      }).length;
      if (key && !refused && !done.has(key) && !todo.has(key))
        todo.set(key, { contentId: draft.id, v });
    }
    return {
      background,
      logo,
      rightsSource,
      assignmentId: assignment.id,
      assignmentName: String(data(assignment).name),
      todo: [...todo.entries()],
    };
  });
  if (!plan?.todo.length) return { composed: [] as string[] };
  const backgroundImage = await imageBytes(scope, data(plan.background));
  const logo = data(plan.logo.row);
  // The bundled original logo is the template's own; any other is read unchanged.
  const logoImage =
    logo.type === "original_logo" ? null : await imageBytes(scope, logo);
  const composed: string[] = [];
  for (const [key, { contentId, v }] of plan.todo) {
    const text = parsedBanner(v.banner)!;
    let rendered: Awaited<ReturnType<typeof renderRasterBanner>>;
    try {
      rendered = await renderRasterBanner({
        template: "brand_landscape",
        text,
        brandName: plan.logo.productName,
        footer: footerDomain(v.targetUrl)!,
        logoApproved: true,
        logoDataUri: logoImage?.uri,
        logoHash: logoImage?.hash ?? logo.sha256,
        backgroundDataUri: backgroundImage.uri,
        backgroundHash: backgroundImage.hash,
      });
    } catch (error) {
      // Copy that does not fit is the review's to send back (BANNER_TEXT_OVERFLOW).
      if (errorCode(error) === "TEXT_OVERFLOW") continue;
      throw error;
    }
    if (rendered.status !== "rendered") continue;
    const { bytes, svg: _svg, ...metadata } = rendered;
    const saved = await inScope(async (tx) => {
      // Consent and logo still hold when the banner is stored.
      imageRightsSource(
        await entity(tx, scope, "assignments", plan.assignmentId),
      );
      const current = await approvedBannerLogo(tx, scope);
      if (
        current.row.id !== plan.logo.row.id ||
        current.row.version !== plan.logo.row.version
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
        license:
          "Composed by Orbit from the run's AI-generated background (owner's assignment consent) and the approved logo",
        rightsSource: {
          ...plan.rightsSource,
          backgroundAssetId: plan.background.id,
          logoAssetId: plan.logo.row.id,
          logoVersion: plan.logo.row.version,
        },
        brandAssetId: plan.logo.row.id,
        visualAssetId: plan.background.id,
        profileVersion: plan.logo.profileVersion,
        assignmentId: plan.assignmentId,
        assignmentRunId: runId,
        bannerKey: key,
        bannerText: text,
        composedFor: contentId,
        channel: "Social",
        validUses: ["social"],
        driveSyncStatus: "LOCAL_ONLY",
      });
      await audit(tx, scope, "assignment.banner_composed", asset.id, {
        assignmentRunId: runId,
        contentId,
        backgroundAssetId: plan.background.id,
        logoAssetId: plan.logo.row.id,
      });
      return asset.id;
    });
    if (saved) composed.push(saved);
  }
  return { composed };
}

import { scoped } from "../../../../../../packages/db/src/index.ts";
import { exportBlogArticle } from "../../../../../../packages/connectors/src/index.ts";
import { validateEvidence } from "../../../../../../packages/knowledge/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data, DomainError, entity } from "../../../shared.ts";
import { assetBytes } from "../../assets.ts";
import { driveContent } from "../../../platform/connections/google-drive.ts";
import { assertAssetPublishable } from "../brand/ai-labels.ts";

/**
 * Resolve the approved PNG attached to exported content. Drive-imported assets
 * keep no inline bytes, so they are read from Drive with the recorded checksum,
 * as the asset preview does.
 *
 * `options.publish` names an outbound path (Postiz, the Social handoff, the
 * content bundle): the exact bytes then pass the AI label gate (ADR 0028 §4)
 * in their own project transaction, and an AI image without a valid label
 * throws 409 AI_LABEL_MISSING / AI_LABEL_INVALID. Owner-internal previews
 * read without it and must never publish what they read.
 */
export async function exportAssetContent(
  scope: Scope,
  asset: Record<string, any> | null,
  readDrive: typeof driveContent = driveContent,
  options: { publish?: string } = {},
) {
  if (!asset || asset.usageApproved !== true || asset.mime !== "image/png")
    return null;
  const content =
    asset.driveFileId && !asset.base64
      ? await readDrive(scope, asset.driveFileId, {
          md5Checksum: asset.md5Checksum,
          modifiedTime: asset.driveModifiedTime,
        })
      : assetBytes(asset);
  if (content.mime !== "image/png") return null;
  if (options.publish)
    await assertAssetPublishable(scope, asset, content.bytes, options.publish);
  // Bytes and type only, whatever else the Drive read returns.
  return { bytes: content.bytes, mime: content.mime };
}

/**
 * The portable draft bundle of one blog or newsletter content (article
 * Markdown, metadata, escaped preview and, unless `withAsset` is false, its
 * approved image). Exports only, never publishes. Content whose public
 * evidence is no longer valid is refused.
 */
export async function exportContentBundle(
  scope: Scope,
  contentId: string,
  options: { withAsset?: boolean } = {},
) {
  const withAsset = options.withAsset !== false;
  const loaded = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const c = await entity(tx, scope, "content", contentId);
      const evidence = await entity(tx, scope, "evidence", data(c).evidenceId);
      if (
        data(evidence).purpose !== "public" ||
        !(await validateEvidence(tx, scope, evidence.id, new Date())).valid
      )
        throw new DomainError("EVIDENCE_INVALIDATED");
      const asset =
        withAsset && data(c).assetId
          ? await entity(tx, scope, "assets", data(c).assetId)
          : null;
      return { c, evidence, asset };
    },
  );
  const { c, evidence, asset } = loaded,
    v = data(c),
    a = asset ? data(asset) : null;
  const assetContent = await exportAssetContent(scope, a, undefined, {
    publish: "marketing.content_export",
  });
  const article = exportBlogArticle({
    title: v.title,
    slug:
      (v.slug ??
        v.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 100)) ||
      "article",
    language: v.language,
    bodyMarkdown: v.body,
    description: v.description ?? v.title,
    updatedAt: c.updatedAt.toISOString(),
    sourceUrls: (data(evidence).items ?? [])
      .filter((i: any) => i.publicUse && i.canonicalUrl)
      .map((i: any) => i.canonicalUrl),
    assets: assetContent
      ? [
          {
            filename: "creative.png",
            mime: "image/png",
            bytes: assetContent.bytes,
            alt: a!.title ?? v.title,
          },
        ]
      : [],
  });
  return {
    ...article,
    contentType: v.type,
    deliveryStatus: "draft_export",
    metadata: {
      outline: v.outline ?? [],
      internalLinks: v.internalLinks ?? [],
      altTexts: v.altTexts ?? [],
      ...(v.type === "newsletter"
        ? {
            newsletter: v.newsletter ?? null,
            sendCapability: "not_configured",
          }
        : {}),
    },
  };
}

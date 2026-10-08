import { scoped } from "../../../../packages/db/src/index.ts";
import { exportBlogArticle } from "../../../../packages/connectors/src/index.ts";
import { validateEvidence } from "../../../../packages/knowledge/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { data, DomainError, entity } from "../shared.ts";
import { assetBytes } from "./assets.ts";
import { driveContent } from "./google-drive.ts";

/**
 * Resolve the approved PNG attached to exported content. Drive-imported assets
 * keep no inline bytes, so they are read from Drive with the recorded checksum,
 * as the asset preview does.
 */
export async function exportAssetContent(
  scope: Scope,
  asset: Record<string, any> | null,
  readDrive: typeof driveContent = driveContent,
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
  return content.mime === "image/png" ? content : null;
}

/**
 * The portable draft bundle of one blog or newsletter content (article
 * Markdown, metadata, escaped preview and its approved image). Exports only;
 * it never publishes. Content whose public evidence is no longer valid is refused.
 */
export async function exportContentBundle(scope: Scope, contentId: string) {
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
      const asset = data(c).assetId
        ? await entity(tx, scope, "assets", data(c).assetId)
        : null;
      return { c, evidence, asset };
    },
  );
  const { c, evidence, asset } = loaded,
    v = data(c),
    a = asset ? data(asset) : null;
  const assetContent = await exportAssetContent(scope, a);
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

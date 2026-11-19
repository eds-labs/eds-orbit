import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { referencedAssetIds, type OrbitDoc } from "../../../../../../packages/content-doc/src/index.ts";
import { DomainError } from "../../../shared.ts";
import { requireRefs } from "../entries/common.ts";
import { slugFree } from "../entries/slugs.ts";
import { renditionMissingLabel } from "../media/provenance.ts";
import { contentType } from "../types/registry.ts";

// What must hold before a revision goes live (ADR 0029 §4.6, CH1.10). The
// same checks run when a publication is asked for, when it is decided and
// when the worker switches the live pointer, so a change in between (an
// archived asset, a taken slug, a removed site) stops it. Issues carry codes
// and ids only, never content.

export interface PreflightIssue {
  code: string;
  siteIds?: string[];
  assetIds?: string[];
  missing?: Record<string, string[]>;
  slug?: string;
}

/** The parts of a revision (or of a draft about to become one) the checks read. */
export interface PublishableContent {
  slug: string;
  title: string;
  body: unknown;
  seo: unknown;
  heroAssetId: string | null;
  authorIds: readonly string[];
  termIds: readonly string[];
}

interface EntryRef {
  id: string;
  type: string;
  locale: string;
}

const ogImageOf = (seo: unknown) => {
  const id = (seo as { ogImageAssetId?: unknown } | null)?.ogImageAssetId;
  return typeof id === "string" ? id : null;
};

/** Every issue that stops the content from going live on the sites; empty when it may. */
export async function preflight(
  tx: DbTx,
  scope: Scope,
  entry: EntryRef,
  content: PublishableContent,
  siteIds: readonly string[],
): Promise<PreflightIssue[]> {
  const issues: PreflightIssue[] = [];
  if (!contentType(entry.type)?.enabled) issues.push({ code: "CMS_TYPE_UNAVAILABLE" });
  if (!content.title.trim()) issues.push({ code: "CMS_TITLE_MISSING" });

  // Sites: at least one, each active and serving the entry's locale.
  if (!siteIds.length) issues.push({ code: "CMS_SITE_REQUIRED" });
  else {
    const sites = await tx.cmsSite.findMany({
      where: { projectId: scope.projectId, id: { in: [...siteIds] }, archivedAt: null },
      select: { id: true, locales: true },
    });
    const serving = new Set(sites.filter((s) => s.locales.includes(entry.locale)).map((s) => s.id));
    const unusable = siteIds.filter((id) => !serving.has(id));
    if (unusable.length) issues.push({ code: "CMS_SITE_UNAVAILABLE", siteIds: unusable });
  }

  if (!(await slugFree(tx, scope, { type: entry.type, locale: entry.locale, entryId: entry.id }, content.slug)))
    issues.push({ code: "CMS_SLUG_TAKEN", slug: content.slug });

  const bodyAssets = referencedAssetIds(content.body as OrbitDoc);
  const shown = [...new Set([...bodyAssets, ...(content.heroAssetId ? [content.heroAssetId] : [])])];
  const og = ogImageOf(content.seo);
  const assetIds = [...new Set([...shown, ...(og ? [og] : [])])];
  try {
    await requireRefs(tx, scope, { authorIds: content.authorIds, termIds: content.termIds, assetIds, locale: entry.locale });
  } catch (error) {
    if (!(error instanceof DomainError && error.code === "CMS_REFERENCE_UNKNOWN")) throw error;
    issues.push({ code: "CMS_REFERENCE_UNKNOWN", missing: (error as { detail?: { missing?: Record<string, string[]> } }).detail?.missing ?? {} });
  }

  // Images shown in the article need a text alternative in its language.
  const assets = await tx.cmsAsset.findMany({
    where: { projectId: scope.projectId, id: { in: assetIds } },
    select: { id: true, alt: true, sha256: true },
  });
  const altOf = new Map(assets.map((a) => [a.id, (a.alt as Record<string, string> | null)?.[entry.locale]?.trim() ?? ""]));
  const withoutAlt = shown.filter((id) => altOf.has(id) && !altOf.get(id));
  if (withoutAlt.length) issues.push({ code: "CMS_ALT_TEXT_MISSING", assetIds: withoutAlt });

  // AI images only with their label (ADR 0028), byline avatars included.
  const avatars = content.authorIds.length
    ? await tx.cmsAsset.findMany({
        where: {
          projectId: scope.projectId,
          id: {
            in: (
              await tx.cmsAuthor.findMany({
                where: { projectId: scope.projectId, id: { in: [...content.authorIds] }, avatarAssetId: { not: null } },
                select: { avatarAssetId: true },
              })
            ).map((a) => a.avatarAssetId!),
          },
        },
        select: { id: true, alt: true, sha256: true },
      })
    : [];
  const unlabelled: string[] = [];
  for (const asset of [...assets, ...avatars.filter((a) => !altOf.has(a.id))])
    if (await renditionMissingLabel(tx, scope, asset.sha256, asset.sha256)) unlabelled.push(asset.id);
  if (unlabelled.length) issues.push({ code: "AI_LABEL_MISSING", assetIds: unlabelled });
  return issues;
}

/** Throws 422 CMS_PREFLIGHT_FAILED with the issues unless the content may go live. */
export async function requirePreflight(...args: Parameters<typeof preflight>) {
  const issues = await preflight(...args);
  if (issues.length) throw Object.assign(new DomainError("CMS_PREFLIGHT_FAILED", 422), { detail: { issues } });
}

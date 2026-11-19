import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { authDb, scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { referencedAssetIds, type OrbitDoc } from "../../../../../../packages/content-doc/src/index.ts";
import { readFile } from "../../../platform/files/files.ts";
import type { ApiPrincipal } from "../../../platform/api-keys/keys.ts";
import { audit, DomainError } from "../../../shared.ts";
import { findEntry, notFound, refused } from "../entries/common.ts";
import { cmsActive } from "../gate.ts";
import { CMS_MODULE_ID } from "../manifest.ts";
import { extensionOf, renditionByFileName, renditionsOf } from "../media/assets.ts";
import { renditionMissingLabel } from "../media/provenance.ts";
import { publicCmsMediaEnabled } from "../media/public-media.ts";
import { pullSettings } from "../sites/adapters.ts";
import { absoluteUrl } from "../types/routes.ts";
import { fullEntry } from "./delivery.ts";
import { deliverySite, pathOf } from "./live.ts";
import type { MediaUrl } from "./views.ts";

// Draft previews (ADR 0029 §4.1, CH1.12). A member asks Orbit for a preview
// token of an entry on one site; the site's preview route (Next.js draft
// mode) reads the current draft with its API key (`cms:preview.read`) and the
// token. The token names project, entry and site, is signed (key derived from
// AUTH_SECRET) and expires after 30 minutes; it shows whatever the draft is
// when it is read, so an editor can keep editing and reload. Images of a
// draft load through a preview media route bound to the same token.

export const PREVIEW_MINUTES = 30;
const MAC_BYTES = 16;
const key = () => Buffer.from(hkdfSync("sha256", loadConfig().AUTH_SECRET, Buffer.alloc(0), "orbit-cms-preview-v1", 32));
const mac = (payload: string) => createHmac("sha256", key()).update(payload).digest().subarray(0, MAC_BYTES);

interface Claims {
  projectId: string;
  entryId: string;
  siteId: string;
  expiresAt: Date;
}

const claimsShape = z.object({ p: z.uuid(), e: z.uuid(), s: z.uuid(), x: z.int() }).strict();

export function previewToken(claims: Claims) {
  const payload = Buffer.from(
    JSON.stringify({ p: claims.projectId, e: claims.entryId, s: claims.siteId, x: Math.floor(claims.expiresAt.getTime() / 1000) }),
  ).toString("base64url");
  return `cmsp.${payload}.${mac(payload).toString("base64url")}`;
}

/** The token's claims, or null when it is malformed, forged or expired. */
export function verifyPreviewToken(token: string, now = new Date()): Claims | null {
  if (token.length > 400) return null;
  const [prefix, payload, signature, extra] = token.split(".");
  if (prefix !== "cmsp" || !payload || !signature || extra !== undefined) return null;
  const given = Buffer.from(signature, "base64url");
  const expected = mac(payload);
  if (given.toString("base64url") !== signature || given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = claimsShape.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    const expiresAt = new Date(parsed.x * 1000);
    if (expiresAt <= now) return null;
    return { projectId: parsed.p, entryId: parsed.e, siteId: parsed.s, expiresAt };
  } catch {
    return null;
  }
}

const createInput = z.object({ siteId: z.uuid() }).strict();

/** A preview token of the entry's draft on one of the project's sites (members only). */
export async function createPreview(tx: DbTx, scope: Scope, entryId: string, raw: unknown) {
  const { siteId } = createInput.parse(raw);
  const entry = await findEntry(tx, scope, entryId);
  const site = await tx.cmsSite.findFirst({ where: { id: siteId, projectId: scope.projectId, archivedAt: null } });
  if (!site) throw notFound("CMS_SITE_NOT_FOUND");
  if (!site.locales.includes(entry.locale)) throw refused("CMS_SITE_LOCALE_MISSING", 422, { siteIds: [siteId], locale: entry.locale });
  const draft = await tx.cmsDraft.findFirstOrThrow({ where: { entryId: entry.id, projectId: scope.projectId } });
  const expiresAt = new Date(Date.now() + PREVIEW_MINUTES * 60_000);
  const token = previewToken({ projectId: scope.projectId, entryId: entry.id, siteId, expiresAt });
  const path = pathOf(site, entry, entry.slug);
  const { previewPath } = pullSettings(site.adapterConfig);
  const previewUrl =
    previewPath && path ? `${absoluteUrl(site.baseUrl, previewPath)}?${new URLSearchParams({ token, path }).toString()}` : null;
  await audit(tx, scope, "cms.preview.created", entry.id, { siteId, draftVersion: draft.version });
  return { token, expiresAt: expiresAt.toISOString(), path, previewUrl };
}

/** Preview image URLs: bound to the token, valid while it is. */
const previewMediaUrl = (token: string): MediaUrl => (asset, rendition) => {
  const found = renditionsOf(asset).find((r) => r.name === rendition);
  if (!found) throw new DomainError("CMS_RENDITION_UNKNOWN", 404);
  // The token goes in the query: it is longer than a path parameter may be.
  return `${new URL(loadConfig().APP_ORIGIN).origin}/api/public/cms/preview-media/${asset.id}/${rendition}.${extensionOf(found.mime)}?${new URLSearchParams({ token })}`;
};

/** The draft as a site would show it, for a key with `cms:preview.read`. Never cached. */
export async function readPreview(tx: DbTx, principal: ApiPrincipal, raw: unknown) {
  const { token } = z.object({ token: z.string().max(400) }).strict().parse(raw ?? {});
  const claims = verifyPreviewToken(token);
  if (!claims || claims.projectId !== principal.projectId) throw notFound("CMS_PREVIEW_NOT_FOUND");
  const site = await deliverySite(tx, principal, claims.siteId);
  const entry = await tx.cmsEntry.findFirst({ where: { id: claims.entryId, projectId: principal.projectId } });
  if (!entry) throw notFound("CMS_PREVIEW_NOT_FOUND");
  const draft = await tx.cmsDraft.findFirstOrThrow({ where: { entryId: entry.id, projectId: principal.projectId } });
  const now = new Date();
  const view = await fullEntry(
    tx,
    principal.scope,
    site,
    entry,
    { ...draft, id: "draft", number: 0, slug: entry.slug },
    { publishedAt: entry.firstPublishedAt ?? now, updatedAt: draft.updatedAt },
    previewMediaUrl(token),
  );
  return { ...view, preview: { draftVersion: draft.version, expiresAt: claims.expiresAt.toISOString(), status: entry.status } };
}

/** Assets the entry's current draft shows (hero, Open Graph, body, byline avatars). */
async function draftShows(tx: DbTx, scope: Pick<Scope, "projectId">, entryId: string, assetId: string) {
  const draft = await tx.cmsDraft.findFirst({ where: { entryId, projectId: scope.projectId } });
  if (!draft) return false;
  const og = (draft.seo as { ogImageAssetId?: unknown } | null)?.ogImageAssetId;
  if (draft.heroAssetId === assetId || og === assetId || referencedAssetIds(draft.body as unknown as OrbitDoc).includes(assetId)) return true;
  if (!draft.authorIds.length) return false;
  return (
    (await tx.cmsAuthor.count({ where: { projectId: scope.projectId, id: { in: draft.authorIds }, avatarAssetId: assetId } })) > 0
  );
}

/** The bytes of a draft image for a valid preview token; NOT_FOUND for everything else. */
export async function servePreviewMedia(token: string, assetId: string, file: string) {
  const missing = () => new DomainError("NOT_FOUND", 404);
  if (!publicCmsMediaEnabled()) throw missing();
  const claims = verifyPreviewToken(token);
  if (!claims || !z.uuid().safeParse(assetId).success) throw missing();
  const project = await authDb.project.findUnique({ where: { id: claims.projectId }, select: { workspaceId: true } });
  if (!project) throw missing();
  const scope: Scope = { workspaceId: project.workspaceId, projectId: claims.projectId, userId: "cms-preview-media", role: "viewer" };
  const rendition = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    if (!(await cmsActive(tx, scope))) return null;
    const asset = await tx.cmsAsset.findFirst({ where: { id: assetId, projectId: scope.projectId } });
    if (!asset) return null;
    const found = renditionByFileName(asset, file);
    if (!found || !(await draftShows(tx, scope, claims.entryId, asset.id))) return null;
    if (await renditionMissingLabel(tx, scope, asset.sha256, found.sha256)) return null;
    return found;
  });
  if (!rendition) throw missing();
  const content = await readFile(scope, rendition.fileId);
  if (content.file.moduleId !== CMS_MODULE_ID) throw missing();
  return { bytes: content.bytes, mime: rendition.mime };
}

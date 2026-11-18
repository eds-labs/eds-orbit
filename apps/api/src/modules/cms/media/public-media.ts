import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { authDb, scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { readFile } from "../../../platform/files/files.ts";
import { publicIngressEnabled } from "../../../platform/http/webhooks.ts";
import { DomainError } from "../../../shared.ts";
import { cmsActive, cmsSwitchedOn } from "../gate.ts";
import { CMS_MODULE_ID } from "../manifest.ts";
import { extensionOf, renditionByFileName, renditionsOf } from "./assets.ts";
import { renditionMissingLabel } from "./provenance.ts";

// Public media URLs of the content module (ADR 0029 §4.1, CH1.9):
// `/api/public/cms/media/<token>/<rendition>.<ext>`, e.g. `…/w960.webp`.
// The token names the project and the asset; a 128-bit HMAC (key derived
// from AUTH_SECRET) makes URLs unguessable. A URL does not expire: websites
// embed it. It serves only while the asset is used by a live revision (hero,
// Open Graph image, body image or a byline's avatar) and never an AI image
// whose rendition lacks its label; every other case is the same 404.

const MAC_BYTES = 16;
const PUBLIC_ACTOR = "cms-public-media";
/** Browsers and CDNs keep an image a day: a withdrawn article's images go away within that. */
export const PUBLIC_MEDIA_CACHE = "public, max-age=86400, stale-while-revalidate=604800";

/** Both switches: the module and public ingress. */
export const publicCmsMediaEnabled = () => cmsSwitchedOn() && publicIngressEnabled();

const key = () => Buffer.from(hkdfSync("sha256", loadConfig().AUTH_SECRET, Buffer.alloc(0), "orbit-cms-media-v1", 32));
const mac = (payload: string) => createHmac("sha256", key()).update(payload).digest().subarray(0, MAC_BYTES);
const uuidBytes = (uuid: string) => Buffer.from(uuid.replaceAll("-", ""), "hex");
const bytesUuid = (bytes: Buffer) => {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export function cmsMediaToken(projectId: string, assetId: string) {
  const ids = Buffer.concat([uuidBytes(projectId), uuidBytes(assetId)]).toString("base64url");
  return `${ids}.${mac(ids).toString("base64url")}`;
}

/** The public URL of one rendition of an asset (`original`, `w480`, `w960`, `w1600`, `og`). */
export function cmsMediaUrl(scope: Pick<Scope, "projectId">, asset: { id: string; mime: string; variants: unknown }, rendition: string) {
  const found = renditionsOf(asset as Parameters<typeof renditionsOf>[0]).find((r) => r.name === rendition);
  if (!found) throw new DomainError("CMS_RENDITION_UNKNOWN", 404);
  return `${new URL(loadConfig().APP_ORIGIN).origin}/api/public/cms/media/${cmsMediaToken(scope.projectId, asset.id)}/${rendition}.${extensionOf(found.mime)}`;
}

/** The token's ids, or null when it is malformed or forged. */
export function verifyCmsMediaToken(token: string): { projectId: string; assetId: string } | null {
  if (token.length > 100) return null;
  const [ids, signature, extra] = token.split(".");
  if (!ids || !signature || extra !== undefined) return null;
  const given = Buffer.from(signature, "base64url");
  if (given.toString("base64url") !== signature) return null;
  const expected = mac(ids);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const raw = Buffer.from(ids, "base64url");
  if (raw.length !== 32 || raw.toString("base64url") !== ids) return null;
  return { projectId: bytesUuid(raw.subarray(0, 16)), assetId: bytesUuid(raw.subarray(16)) };
}

/** True when a live revision of the project shows the asset. */
export async function assetIsLive(tx: DbTx, scope: Pick<Scope, "projectId">, assetId: string) {
  const rows = await tx.$queryRaw<Array<{ live: number }>>`
    SELECT 1 AS live
    FROM "CmsEntry" e
    JOIN "CmsRevision" r ON r.id = e."publishedRevisionId"
    WHERE e."projectId" = ${scope.projectId}::uuid
      AND (
        r."heroAssetId" = ${assetId}::uuid
        OR r."seo"->>'ogImageAssetId' = ${assetId}
        OR jsonb_path_exists(r."body", '$.** ? (@.type == "image" && @.assetId == $id)', jsonb_build_object('id', ${assetId}::text))
        OR EXISTS (
          SELECT 1 FROM "CmsAuthor" a
          WHERE a."projectId" = e."projectId" AND a.id = ANY (r."authorIds") AND a."avatarAssetId" = ${assetId}::uuid
        )
      )
    LIMIT 1`;
  return rows.length > 0;
}

/** The bytes a public media URL may show; NOT_FOUND for everything else. */
export async function servePublicCmsMedia(token: string, file: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const missing = () => new DomainError("NOT_FOUND", 404);
  if (!publicCmsMediaEnabled()) throw missing();
  const claims = verifyCmsMediaToken(token);
  if (!claims) throw missing();
  const project = await authDb.project.findUnique({ where: { id: claims.projectId }, select: { workspaceId: true } });
  if (!project) throw missing();
  const scope: Scope = { workspaceId: project.workspaceId, projectId: claims.projectId, userId: PUBLIC_ACTOR, role: "viewer" };
  const rendition = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    if (!(await cmsActive(tx, scope))) return null;
    const asset = await tx.cmsAsset.findFirst({ where: { id: claims.assetId, projectId: scope.projectId } });
    if (!asset) return null;
    const found = renditionByFileName(asset, file);
    if (!found || !(await assetIsLive(tx, scope, asset.id))) return null;
    if (await renditionMissingLabel(tx, scope, asset.sha256, found.sha256)) return null;
    return found;
  });
  if (!rendition) throw missing();
  const content = await readFile(scope, rendition.fileId);
  if (content.file.moduleId !== CMS_MODULE_ID) throw missing();
  return { bytes: content.bytes, mime: rendition.mime };
}

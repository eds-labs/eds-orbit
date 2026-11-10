import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { authDb, scoped } from "../../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { readFile } from "../../../platform/files/files.ts";
import { publicIngressEnabled } from "../../../platform/http/webhooks.ts";
import { audit, DomainError } from "../../../shared.ts";
import { mediaAssetByFile } from "./library.ts";

// Signed public media URLs (ADR 0020, S3). A platform that fetches media by
// URL (Instagram) gets `/api/public/social/media/<token>`. The token names
// the project, publication and file and expires after two hours; a 128-bit
// HMAC (key derived from AUTH_SECRET) covers all of it. It stays under
// Fastify's 100-character limit for a path parameter. The route serves
// the file only while the publication is being sent and the file is a
// rendition of one of its media; every other case is the same 404.

const LIFETIME_MS = 2 * 60 * 60_000;
const MAC_BYTES = 16;
const SERVABLE = new Set(["claimed", "sending", "processing"]);
const PUBLIC_ACTOR = "social-public-media";

export type MediaTokenClaims = { projectId: string; publicationId: string; fileId: string };

/** Both switches: the module's public media and public ingress. */
export const publicMediaEnabled = () =>
  loadConfig().ORBIT_SOCIAL_MEDIA_PUBLIC === "true" && publicIngressEnabled();

const key = () =>
  Buffer.from(hkdfSync("sha256", loadConfig().AUTH_SECRET, Buffer.alloc(0), "orbit-social-media-v1", 32));
const mac = (payload: string) => createHmac("sha256", key()).update(payload).digest().subarray(0, MAC_BYTES);
const uuidBytes = (uuid: string) => Buffer.from(uuid.replaceAll("-", ""), "hex");
const bytesUuid = (bytes: Buffer) => {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The public URL of one file of a publication. */
export function publicMediaUrl(
  scope: Pick<Scope, "projectId">,
  input: { publicationId: string; fileId: string },
  now = new Date(),
): string {
  if (!publicMediaEnabled()) throw new DomainError("SOCIAL_MEDIA_PUBLIC_DISABLED", 409);
  const ids = Buffer.concat(
    [scope.projectId, input.publicationId, input.fileId].map(uuidBytes),
  ).toString("base64url");
  const expires = Math.floor((now.getTime() + LIFETIME_MS) / 1000).toString(36);
  const payload = `${ids}.${expires}`;
  const token = `${payload}.${mac(payload).toString("base64url")}`;
  return `${new URL(loadConfig().APP_ORIGIN).origin}/api/public/social/media/${token}`;
}

/** The token's claims, or null when it is malformed, forged or expired. */
export function verifyMediaToken(token: string, now = new Date()): MediaTokenClaims | null {
  if (token.length > 300) return null;
  const [ids, expires, signature, extra] = token.split(".");
  if (!ids || !expires || !signature || extra !== undefined) return null;
  const given = Buffer.from(signature, "base64url");
  // One spelling only: base64url leaves unused bits in the last character,
  // and a decoder ignores them.
  if (given.toString("base64url") !== signature) return null;
  const expected = mac(`${ids}.${expires}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const seconds = parseInt(expires, 36);
  if (!Number.isSafeInteger(seconds) || seconds * 1000 <= now.getTime()) return null;
  const raw = Buffer.from(ids, "base64url");
  if (raw.length !== 48) return null;
  const [projectId, publicationId, fileId] = [0, 1, 2].map((i) =>
    bytesUuid(raw.subarray(i * 16, i * 16 + 16)),
  ) as [string, string, string];
  return { projectId, publicationId, fileId };
}

/** The bytes a valid token may see; NOT_FOUND for everything else. */
export async function servePublicMedia(token: string): Promise<{ bytes: Uint8Array; mime: string; name: string }> {
  const notFound = () => new DomainError("NOT_FOUND", 404);
  if (!publicMediaEnabled()) throw notFound();
  const claims = verifyMediaToken(token);
  if (!claims) throw notFound();
  const project = await authDb.project.findUnique({
    where: { id: claims.projectId },
    select: { workspaceId: true },
  });
  if (!project) throw notFound();
  const scope: Scope = {
    workspaceId: project.workspaceId,
    projectId: claims.projectId,
    userId: PUBLIC_ACTOR,
    role: "viewer",
  };
  const allowed = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const publication = await tx.socialPublication.findFirst({
      where: { id: claims.publicationId, projectId: scope.projectId },
    });
    if (!publication || !SERVABLE.has(publication.status)) return false;
    const asset = await mediaAssetByFile(tx, scope, claims.fileId);
    if (!asset) return false;
    const used = await tx.socialPostMedia.count({
      where: {
        projectId: scope.projectId,
        variantId: publication.variantId,
        fileId: { in: [asset.fileId, asset.jpegFileId] },
      },
    });
    if (!used) return false;
    await audit(tx, scope, "social.media.public_served", publication.id, {});
    return true;
  });
  if (!allowed) throw notFound();
  const { file, bytes } = await readFile(scope, claims.fileId);
  if (file.moduleId !== "social") throw notFound();
  return { bytes, mime: file.mime, name: file.name ?? "media" };
}

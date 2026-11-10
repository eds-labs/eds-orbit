# Social S3 — Media Library and Public Media URLs (Images) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners and editors upload images into a per-project social media library; every image is normalized (orientation, metadata stripped) and gets an Instagram-ready JPEG rendition; platform rules tell which image fits which platform; a short-lived signed public URL can serve exactly one rendition of a post that is being published.

**Architecture:** Bytes stay in the platform file storage (`platform/files`, encrypted, `moduleId: "social"`, private to the module). A new table `SocialMediaAsset` holds the library entry (dimensions, alt text, the original and the JPEG rendition file). Image work happens in `packages/creative` with its existing sharp dependency (no new dependency). The public URL is a plain module route under `/api/public/social/media/:token`, so the existing public-ingress gate applies; the token is an HMAC over project, publication, file and expiry with a key derived from `AUTH_SECRET` by HKDF.

**Tech Stack:** TypeScript, Fastify 5, Prisma 7 + PostgreSQL 17 (FORCE RLS), sharp 0.35.5 (already in `packages/creative`), zod 4, Next.js 16, Vitest.

**Spec:** [`2026-11-02-social-module.md`](2026-11-02-social-module.md) (§3 S-D5 images only, §6.6 media and public URLs, §10 S3) and [ADR 0020](../../adr/0020-social-module.md). Stacked on S2 (`claude/social-s2`, PR #184).

## Findings this plan relies on (verified 2026-11-02)

| Topic | Fact | Source |
|---|---|---|
| SDK X | Images only JPEG or PNG as a Blob, ≤ 5 MiB; alt text is refused in 0.5.0 | `dist/platforms/x.js:1140-1156` |
| SDK Instagram | Images only JPEG, public HTTPS URL; a carousel needs equal aspect ratios with known width and height | `dist/platforms/instagram.js:598-620` |
| Instagram | JPEG, ≤ 8 MB, aspect ratio 4:5–1.91:1, width 320–1440 (scaled otherwise), sRGB | Meta docs (S2 research) |
| Telegram | photo ≤ 10 MB, width + height ≤ 10000, ratio ≤ 20 | Bot API |
| Files | `storeFile(scope, {moduleId, bytes, mime, name?})`, `readFile(scope, id) → {file, bytes}` (whole file in memory), `deleteFile`; default 20 MiB per file, 100 MiB per project; png/jpeg/webp magic-byte checks; `ORBIT_FILES` + `FILES_ENCRYPTION_KEY` required; social is `privateToModule` | `platform/files/files.ts` |
| Uploads | raw `application/octet-stream` body with `x-file-name`/`x-file-type`, checks in `onRequest` before the body (finance route pattern) | `modules/finance/routes.ts:360-417` |
| sharp | only in `packages/creative` (`normalizeRasterAsset`, `encodePreviewJpeg` patterns, `limitInputPixels`, `failOn: "warning"`, `animated: false`) | `packages/creative/src/index.ts:567-647` |
| Public ingress | `/api/public/*` routes answer 404 unless `ORBIT_PUBLIC_INGRESS`; GET needs no origin exemption; the web proxy streams the body, drops `content-length`, forces `Cache-Control: no-store`; no Traefik path allowlist | `server.ts:406-434`, `apps/web/src/lib/api-upstream.ts` |

## Global Constraints

- Branch `claude/social-s3` in `.claude/worktrees/social-s3`, stacked on `claude/social-s2`; push only with Mario's approval.
- No new dependency. sharp is used only inside `packages/creative`.
- One migration (`202611020002_social_media`): it changes the approved schema hash again; a deploy needs Mario's approval of the new hash.
- New installation switch `ORBIT_SOCIAL_MEDIA_PUBLIC` (default `false`) in config, both Compose files, `.env.example` and the Compose checks.
- Images only (png, jpeg, webp input); video is refused with `SOCIAL_VIDEO_NOT_AVAILABLE` (S3b).
- Metadata (EXIF, GPS, ICC beyond sRGB conversion) never survives normalization.
- The public route serves nothing a token does not name, never lists, and never serves a file of a publication outside `claimed | sending | processing`.
- English in code/docs; UI strings `en` + `de`.

## Review Focus

1. **A token for one file used for another file, another publication or another project.** Expect 404 (MAC covers all of them).
2. **A token replayed after the publication finished or was canceled.** Expect 404.
3. **A decompression bomb or an animated image uploaded.** Expect `SOCIAL_MEDIA_INVALID` (pixel limit 40 MP, `pages > 1` refused) without exhausting memory.
4. **Deleting an image a post still uses.** Expect it to leave the library only (archived); the post's media stay.
5. **A viewer or another project's member reading or uploading media.** Expect read for viewers, upload/edit/delete only with `social.compose`, nothing across projects.

---

### Task 1: Image preparation in `packages/creative`

**Files:** Create `packages/creative/src/social-image.ts`; modify `packages/creative/src/index.ts` (export); test `packages/creative/src/social-image.test.ts`.

**Interfaces — produces:**
```ts
export type PreparedSocialImage = {
  original: { bytes: Buffer; mime: "image/png" | "image/jpeg"; width: number; height: number };
  jpeg: { bytes: Buffer; width: number; height: number };
};
export async function prepareSocialImage(bytes: Buffer, options?: { maxPixels?: number; maxSide?: number }): Promise<PreparedSocialImage>;
```
Rules: decode with `limitInputPixels` (default 40 MP), `failOn: "warning"`; input format png, jpeg or webp only and `pages === 1`, else throw `Error("SOCIAL_MEDIA_INVALID")`; `.rotate()` (EXIF orientation); original: JPEG input → JPEG (quality 92, mozjpeg), PNG/WebP → PNG, long side ≤ `maxSide` (default 4096), no metadata; JPEG rendition: `resize({ width: 1440, withoutEnlargement: true })`, `flatten({ background: "#ffffff" })`, `toColorspace("srgb")`, JPEG quality 88 mozjpeg.

- [ ] Tests (images generated with sharp in the test): a PNG with alpha → PNG original and JPEG rendition without alpha; a 3000×2000 JPEG with EXIF orientation 6 and GPS → original 2000×3000, `metadata().exif` undefined; a WebP → PNG original; a 2000-px-wide image → rendition 1440 wide, ratio kept; an animated WebP/GIF → `SOCIAL_MEDIA_INVALID`; a 9000×9000 image with `maxPixels` 40 MP → `SOCIAL_MEDIA_INVALID`; a text file → `SOCIAL_MEDIA_INVALID`.
- [ ] Fail, implement, pass; commit `feat(creative): prepare social images (normalized original and JPEG rendition)`.

### Task 2: `SocialMediaAsset` table

**Files:** `packages/db/prisma/schema.prisma`, migration `packages/db/prisma/migrations/202611020002_social_media/migration.sql`, `scripts/db-deploy.ts`, `apps/api/src/modules/social/manifest.ts` (tables), `apps/api/tests/rls-matrix.integration.test.ts`, `apps/api/tests/social-schema.integration.test.ts`.

Columns: `id`, `workspaceId`, `projectId`, `fileId` (composite FK to `File(projectId,id)` ON DELETE CASCADE), `jpegFileId` (same FK, CASCADE), `name`, `mime` (`image/png|image/jpeg`), `width`, `height`, `jpegWidth`, `jpegHeight`, `size`, `jpegSize`, `sha256` (hex64), `altText` (≤ 1000), `version`, `createdBy`, `createdAt`, `updatedAt`, `archivedAt`. Checks on mime, positive sizes, hex. Unique `(projectId, id)`, `(projectId, fileId)`; index `(projectId, archivedAt, createdAt)`. FORCE RLS loop; full business grants.

- [ ] Tests: rls-matrix classification and seed; cross-project read hidden; FK refuses another project's file; deleting the File removes the asset; manifest lists the table.
- [ ] Fail, implement (migration, `db:generate`, `test-db-for-worktree`), pass; print the schema hash; commit `feat(social): media library table`.

### Task 3: Library service

**Files:** Create `apps/api/src/modules/social/media/library.ts`; test `apps/api/tests/social-media-library.integration.test.ts`.

**Interfaces — produces:**
```ts
uploadMedia(scope: Scope, input: { bytes: Uint8Array; mime: string; name?: string }): Promise<MediaView>;
listMedia(tx: DbTx, scope: Scope): Promise<{ items: MediaView[] }>;
updateMedia(tx: DbTx, scope: Scope, id: string, raw: unknown /* {altText, version} */): Promise<MediaView>;
removeMedia(scope: Scope, id: string): Promise<{ id: string; removed: "archived" | "deleted" }>;
mediaContent(scope: Scope, id: string, rendition: "original" | "jpeg"): Promise<{ bytes: Uint8Array; mime: string }>;
mediaAssetByFile(tx: DbTx, scope: Scope, fileId: string): Promise<SocialMediaAsset | null>;
type MediaView = { id; name; mime; width; height; size; jpegWidth; jpegHeight; jpegSize; altText; version; createdAt };
```
Rules: refuse `video/*` with 415 `SOCIAL_VIDEO_NOT_AVAILABLE`; mime must be png/jpeg/webp (415 `SOCIAL_MEDIA_TYPE`); `prepareSocialImage` errors → 422 `SOCIAL_MEDIA_INVALID`; store both renditions with `storeFile(moduleId "social")` (cleanup of the first if the second fails); `requireSocial` and `ORBIT_FILES` (404 `FILES_NOT_CONFIGURED` from the platform); remove: archive when any `SocialPostMedia.fileId` references the asset's `fileId` or `jpegFileId`, else `deleteFile` both and delete the row; `mediaContent` checks the asset belongs to the project and `File.moduleId === "social"`.

- [ ] Tests: upload of a PNG stores two files and returns dimensions; WebP becomes PNG; `video/mp4` → 415; a broken PNG → 422; list excludes archived; alt-text update with version conflict 409; remove unused → files deleted; remove used by a post → archived and files kept; content of another project's asset → 404; no file is created when preparation fails.
- [ ] Fail, implement, pass; commit `feat(social): media library service`.

### Task 4: Media routes

**Files:** Modify `apps/api/src/modules/social/routes.ts`; test `apps/api/tests/social-media-routes.integration.test.ts`; access matrix fixture.

Routes (prefix `/api/projects/:projectId/social`): `POST /media` (raw `application/octet-stream`, `x-file-name`, `x-file-type`, body limit `FILES_MAX_BYTES`, rate limit 60/min, checks in `onRequest`: session, `SOCIAL_COMPOSE`, module, content type) → `MediaView`; `GET /media` (`SOCIAL_READ`); `GET /media/:id/content?rendition=original|jpeg` (`SOCIAL_READ`; `Content-Type`, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, no-store`); `PATCH /media/:id` `{altText, version}` (`SOCIAL_COMPOSE`); `DELETE /media/:id` (`SOCIAL_COMPOSE`).

- [ ] Tests: viewer reads list and content, cannot upload/patch/delete (403); editor uploads; wrong content type → 415 before the body is read; another project's member 404; content headers; flag off → 404 `SOCIAL_DISABLED`.
- [ ] Fail, implement, pass; access matrix updated and reviewed; commit `feat(social): media routes`.

### Task 5: Platform media rules

**Files:** Create `apps/api/src/modules/social/media/rules.ts`; test `apps/api/tests/social-media-rules.test.ts`.

**Interfaces — produces:**
```ts
type MediaFacts = { mime: string; width: number; height: number; size: number; jpegWidth: number; jpegHeight: number; jpegSize: number };
type Rendition = "original" | "jpeg";
renditionFor(media: MediaFacts, platform: SocialPlatform): Rendition;
mediaIssues(media: MediaFacts, platform: SocialPlatform): string[];
carouselIssues(items: MediaFacts[], platform: SocialPlatform): string[];
```
Rules: Instagram → `jpeg` rendition; issues `SOCIAL_MEDIA_ASPECT_RATIO` outside 0.8–1.91 (on the rendition), `SOCIAL_MEDIA_TOO_SMALL` width < 320, `SOCIAL_MEDIA_TOO_LARGE` > 8 MB; carousel: 2–10 items, equal ratios (±0.001) else `SOCIAL_MEDIA_CAROUSEL_RATIO`. X → `original` if ≤ 5 MiB else `jpeg`; issue `SOCIAL_MEDIA_TOO_LARGE` if the chosen rendition > 5 MiB; at most 4 images (`SOCIAL_MEDIA_TOO_MANY`). Facebook → `original` if ≤ 10 MB else `jpeg`. Telegram → `original` if ≤ 10 MB else `jpeg`; issues for width + height > 10000 or ratio > 20; up to 10 per album.

- [ ] Tests per platform with boundary values (ratio 0.8 and 1.91 allowed, 0.79 and 1.92 not; 5 MiB exact allowed; 5 images on X refused); fail, implement, pass; commit `feat(social): platform media rules`.

### Task 6: Signed public media URLs

**Files:** Create `apps/api/src/modules/social/media/public-url.ts`; modify `packages/config/src/index.ts`, `docker-compose.yml`, `.env.example`, `scripts/check-coolify-compose.mjs`, `docker-compose.pve.yml` (render), `apps/api/src/modules/social/routes.ts`; tests `apps/api/tests/social-media-public.integration.test.ts`, access matrix (public route list).

**Interfaces — produces:**
```ts
publicMediaUrl(scope: Scope, input: { publicationId: string; fileId: string }, now?: Date): string; // throws SOCIAL_MEDIA_PUBLIC_DISABLED 409 unless ORBIT_SOCIAL_MEDIA_PUBLIC and ORBIT_PUBLIC_INGRESS
verifyMediaToken(token: string, now?: Date): { workspaceId; projectId; publicationId; fileId } | null;
```
Token: `base64url(16-byte uuids of workspace, project, publication, file) + "." + expiry seconds (base36) + "." + base64url(HMAC-SHA256(key, payload) first 24 bytes)`; key = `hkdfSync("sha256", AUTH_SECRET, "", "orbit-social-media-v1", 32)`; lifetime 2 h. Route `GET /api/public/social/media/:token` (rate limit 120/min per address): verify → `scoped` → publication status in `claimed|sending|processing` and the file is the `fileId` or `jpegFileId` of an asset whose `fileId` is used by a `SocialPostMedia` of the publication's variant → `readFile` → headers `Content-Type`, `Content-Disposition: inline`, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow`, nosniff, CSP sandbox; audit `social.media.public_served` with the publication id only. Every refusal is the same 404 `NOT_FOUND`.

- [ ] Tests: valid token serves the JPEG bytes with the headers; tampered MAC, other file, other publication, other project → 404; expired → 404; publication `pending`, `published`, `canceled` → 404; `ORBIT_SOCIAL_MEDIA_PUBLIC` off → issuing refused and route 404; `ORBIT_PUBLIC_INGRESS` off → 404; no listing (`GET /api/public/social/media/`) → 404; audit row without bytes.
- [ ] Fail, implement, pass; access matrix public-route list updated; commit `feat(social): signed public media URLs`.

### Task 7: Web media library

**Files:** Create `apps/web/src/modules/social/media.tsx`, test `media.test.tsx`; modify `manifest.tsx` (media view), `labels.ts`, `api.ts`.

Behaviour: grid of images (thumbnail via the content route, `alt` = alt text or name), upload button for editors/owners (`accept="image/png,image/jpeg,image/webp"`, client size check against 20 MB), per image: dimensions, alt-text field (save with version), platform hints from a client copy of the ratio and size rules (Instagram ratio, X size), delete with confirm; error codes translated.

- [ ] Tests: viewer sees images without upload/delete; editor sees upload; platform hint for a 1:2 image ("Instagram: aspect ratio outside 4:5 to 1.91:1"); every button named; error texts en/de. Fail, implement, pass; commit `feat(social): media library view`.

### Task 8: Documentation and full checks

`docs/SOCIAL.md` (media library, renditions, rules, public URL and flags, `ORBIT_FILES` dependency), `docs/API_CONTRACT.md`, `docs/SECURITY_REVIEW.md` (public media route), `docs/PUBLIC_INGRESS.md` (the media route and the callback path), `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md`; OpenAPI and client regenerated; `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, framework checks; commit `docs(social): S3 media library and public media URLs`.

## Done when

- Images upload, normalize and list; renditions and platform rules are right at the boundaries; nothing of another project is reachable.
- The public route serves only a rendition of a media item of a publication that is being sent, only with both flags on, and the same 404 otherwise.
- Production: nothing deployed; the migration needs the new schema hash approved; `ORBIT_FILES` must be on for the module's media in production.

# Google Drive browser page and Social Drive picker — design

Date: 2026-11-05 · Owner decision: Mario (brainstorming 2026-11-05) · Status: draft for review

## 1. Goal

1. Replace the Google Drive settings card browser with a proper **Drive page**: a lazily loaded folder tree on the left, a breadcrumb, and a sortable list (table) or grid of the current folder on the right.
2. Let Social users **pick Drive images** in the post composer and the Social media library. The picked image is imported into the Social media library like an upload.

Success: a member can navigate the project's Drive root by tree and breadcrumb, deep-link a folder, and a Social editor can attach a Drive image to a post without downloading and re-uploading it.

## 2. Decisions (Mario, 2026-11-05)

| ID | Decision |
| --- | --- |
| DB-1 | Drive gets its **own platform page** `/p/:projectId/drive`, sidebar group "Project". Settings → Integrations keeps connect/disconnect/test/root selection and links to the page. |
| DB-2 | **Images only** now. Videos (Social phase S3b: storage, platform rules, publishing adapters, transcoding) stay a separate later project. Drive videos are shown but disabled ("Videos later"). |
| DB-3 | The page keeps today's actions (add to Marketing library, upload to Drive, copy link, open in Drive) and adds **"Add to Social media"** for images. |
| DB-4 | Tree and breadcrumb use **server-side ancestry** (approach 1): the server walks the parent chain, returns the path, and caches verified folder chains for 60 seconds per project and root. |

Rejected: client-held path only (breaks deep links, weaker boundary check); a persisted folder index (needs a migration, goes stale).

## 3. Constraints

- The project's configured Drive root stays the access boundary. Every folder or file request is checked to lie inside it.
- Read access stays as today: any project member may browse (`scopeFor` without role). Imports keep their module checks: Marketing import/upload require project owner (unchanged); Social import requires the Social module enabled and `SOCIAL_COMPOSE` (owners and editors), like `POST …/social/media`.
- No database migration, no new dependency, no new external provider. The Drive OAuth scope is unchanged.
- `scripts/boundaries.json`: web platform code must not import web modules; the platform page learns module actions only through a registry contribution. API Social may import `platform/connections/google-drive.ts`; nothing from `modules/marketing/`.
- The OAuth callback still redirects to `/settings?googleDrive=ready|choose-root` and opens the Integrations section (`settings-nav.tsx`).

## 4. API

### 4.1 Ancestry (platform, `apps/api/src/platform/connections/google-drive.ts`)

- `ancestry(token, targetId, rootId)` replaces the body of `isWithin`. It walks `parents[0]` up to 30 levels and returns the chain `[{ id, name }]` from the root to the target (root first, target last), or `null` when the root is not reached. `isWithin` stays as a thin wrapper (`ancestry(...) !== null`), so `driveContent`, `configureRootWithToken` and Marketing (`driveContains`) keep their behavior.
- Cache: an in-process `Map` keyed `${projectId}:${rootId}:${folderId}` → `{ path, expiresAt }`, TTL 60 s, at most 1,000 entries (oldest dropped). Only **folder** chains are cached; a file's check reuses its parent folder's cached chain plus one `files.get` for the file itself. A cache hit for a prefix shortens a walk (when the walk reaches a cached folder, the cached chain is appended). The cache is cleared for a project on `configureRoot`, `disconnect` and `finishConnect`.
- Risk accepted: a folder moved out of the root stays browsable for at most 60 s on one API process. The token can read the whole Drive anyway; the root is a project-organization boundary, not a security boundary against the connected account.

### 4.2 Folders endpoint (new)

`GET /api/projects/:projectId/google-drive/folders?parentId=<id>&pageToken=<t>`

- `parentId` optional (default: root). The parent is checked with `ancestry`.
- Lists `mimeType = folder and trashed = false` children, `orderBy=name`, `pageSize=200`, fields `id,name`.
- Response: `{ parentId, folders: [{ id, name }], nextPageToken: string | null }`.
- Errors as today: `GOOGLE_DRIVE_STORAGE_NOT_CONFIGURED` 409, `GOOGLE_DRIVE_FOLDER_OUTSIDE_ROOT` 403, `GOOGLE_DRIVE_RECONNECT_REQUIRED` 409.

### 4.3 Files endpoint (extended)

`GET /api/projects/:projectId/google-drive/files` gets:

- `sort`: `name` (default) or `modified` → Drive `orderBy` `folder,name` / `folder,modifiedTime desc`.
- `kind`: `all` (default) or `image` → adds `(mimeType = folder or mimeType contains 'image/')`. Videos are not filtered out by `image`; the picker uses `all` and disables non-images itself (DB-2), so `kind=image` is for callers that want images only.
- The response adds `path: [{ id, name }]` (root first, current folder last) and `rootName`.
- The existing `query` (name contains) stays scoped to the current folder.

### 4.4 Social import from Drive (new, `apps/api/src/modules/social/`)

`POST /api/projects/:projectId/social/media/from-drive` body `{ fileId: string, name?: string }`

- Checks: module enabled (`assertModuleEnabledFor`), `SOCIAL_COMPOSE`, `requireSocial`, rate limit `UPLOAD_RATE` (same as uploads).
- Reads bytes via platform `driveContent(scope, fileId)` (root check, 20 MB cap, image/PDF types). Types other than PNG, JPEG and WebP are refused with `SOCIAL_MEDIA_TYPE` 415; `video/*` with `SOCIAL_VIDEO_NOT_AVAILABLE` 415 (checked from Drive metadata before download).
- Stores via existing `uploadMedia(scope, { bytes, mime, name })`, so normalization, metadata stripping, JPEG rendition and audit are identical to an upload. Default name: the Drive file name.
- Response 201: the `MediaView`, like `POST …/media`.
- No duplicate detection (would need a column for the Drive file id → migration). Importing the same file twice creates two library entries.
- New error texts in `apps/web/src/modules/social/labels.ts` (`mediaMessage`) for Drive codes (`GOOGLE_DRIVE_*`).

### 4.5 Contracts

OpenAPI and `packages/api-client` are regenerated (`pnpm api:generate`) for the new and changed routes; the diff is reviewed.

## 5. Web

### 5.1 Shared Drive building blocks (`apps/web/src/platform/drive/`)

- `api.ts`: types (`DriveFile`, `DriveFolder`, `DrivePathItem`, `DriveStatus`), URL helpers, `isImage`, `isVideo`, size/date formatting.
- `folder-tree.tsx`: `role="tree"` with `treeitem`/`group`, roving tab index, arrow keys (up/down move, right expands or enters, left collapses or goes to parent), Enter selects. Children load on first expand (`/folders?parentId=`), with a "More folders" item for `nextPageToken`. On open with a deep-linked folder, it expands the nodes along `path`.
- `drive-browser.tsx`: breadcrumb from `path`, search, sort (name/modified), view toggle (table/grid, remembered per viewer in `localStorage` with try/catch), pagination ("Load more"), refresh. Table columns: name (icon or thumbnail), type, size, modified. Props:
  - `mode: "browse" | "pick"`; in pick mode a click on an image calls `onPick(file)`, non-images are disabled with a reason (video: "Videos later").
  - `fileActions` and `toolbar` render slots, filled from module contributions (5.3).
  - `folderId` / `onFolderChange` so the page can sync `?folder=`.
- Images show thumbnails through the existing content route (`/google-drive/files/:id/content`), `loading="lazy"`.

### 5.2 Drive page (platform view)

- Registry `apps/web/src/modules/registry.ts` platform view: `key: "drive"`, `path: "drive"`, `navGroup: "project"`, `nav: { label: { en: "Google Drive", de: "Google Drive" }, icon: HardDrive, order: 105, feature: "googleDrive" }`.
- The shell (`components/orbit.tsx`) sets `features.googleDrive` from `GET …/google-drive` (`enabled === true`). Without it the entry is hidden; a deep link shows an empty state with a link to Settings → Integrations (owners) or a note to ask an owner.
- Layout: two columns (tree ~280 px, resizable later not in scope); below 768 px the tree becomes a collapsible "Folders" disclosure above the list. Follows `docs/DESIGN_SYSTEM.md` tokens and page head pattern (`PageHead`).
- URL: `?folder=<id>` (validated against the id pattern), so folders are linkable; back/forward navigate folders.
- Shows the reconnect alert (`refreshFailureText`) as today.

### 5.3 Module contributions

`WebModule` (`apps/web/src/platform/shell/types.ts`) gets:

```ts
drive?: {
  /** Actions on one Drive file in the Drive page; a component renders nothing when it does not apply (file type, role). */
  fileActions?: readonly ComponentType<{ file: DriveFile; folderId: string; onDone: () => void }>[];
  /** Buttons in the Drive page toolbar, e.g. upload. */
  toolbar?: readonly ComponentType<{ folderId: string; onDone: () => void }>[];
};
```

The shell passes only contributions of modules that are enabled and visible for the member (same filter as `connectors` and `settings`). Each component checks its own role (for example owner-only) and renders nothing otherwise.

- Marketing (`apps/web/src/modules/marketing/drive/`): "Add to library" (asset type select, `POST …/google-drive/files/:id/import`) and the toolbar "Upload to Drive" modal (`POST …/google-drive/upload`), moved from `components/google-drive.tsx`.
- Social (`apps/web/src/modules/social/drive-action.tsx`): "Add to Social media" for images (`POST …/social/media/from-drive`), editors and owners.
- Platform keeps "Copy Drive link" and "Open in Drive" itself.

### 5.4 Settings card

`GoogleDriveSettings` keeps status, alerts, connect/reconnect, disconnect, test connection and the root chooser, and gains an "Open Google Drive" link to the page when enabled. The file browser part is removed from the card. `?googleDrive=` handling in `management.tsx` and `settings-nav.tsx` is unchanged.

### 5.5 Social composer and library

- `posts/media-picker.tsx`: tabs "Library" and "Google Drive" (Drive tab only when `features.googleDrive`). The Drive tab embeds `DriveBrowser` in pick mode. Picking an image imports it (`from-drive`), refreshes the library list, and adds the new media id to the selection (respecting the limit of ten). Pending state per file; errors through `mediaMessage`.
- `media.tsx`: an "Add from Google Drive" button (editors/owners, when the feature is on) opening a modal with `DriveBrowser` in pick mode; each pick imports one image.

## 6. Error handling

- Google failures map to the existing codes; the browser shows them inline with retry. `GOOGLE_DRIVE_RECONNECT_REQUIRED` shows the reconnect alert with a link to Settings.
- A deep-linked folder outside the root (403) falls back to the root with a notice.
- Import failures leave the selection unchanged.

## 7. Testing

- API unit tests (mocked `fetch`): `ancestry` path order, 30-level cap, cache hit/expiry/invalidation; folders endpoint paging and root check; files `path`, `sort`, `kind`; `from-drive` happy path, video refused before download, GIF/SVG/PDF refused, module disabled, viewer refused, Drive not configured.
- Access matrix (`apps/api/tests/access-matrix.integration.test.ts`): new rows for `GET …/google-drive/folders` (members) and `POST …/social/media/from-drive` (Social editors/owners, module on). Reviewed as a security change.
- Web tests: tree lazy load and keyboard, breadcrumb navigation and `?folder=`, page hidden without the feature, contributions filtered by module, picker import-and-select, settings card link, OAuth callback still opens Integrations.
- Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, boundary check, `pnpm api:generate` diff; e2e for the Drive page if a Drive fixture exists, otherwise a documented skip (no real Google calls in tests).

## 8. Out of scope

Video import and publishing (S3b), Drive-wide search across subfolders, drag-and-drop moves, renaming or deleting Drive files, duplicate detection, a resizable tree column.

## 9. Delivery

Risk: medium (new read endpoints on an external integration, new write path into the Social library; no schema change). Environment: local first; push to `main` only after Mario's OK (a push deploys production). No migration, so no Coolify schema-hash approval is needed. Rollback: revert the commit; no data written outside the existing Social media tables.

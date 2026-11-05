# Drive Browser Page and Social Drive Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Google Drive platform page with a lazy folder tree, breadcrumb and table/grid, plus picking Drive images into the Social media library from the composer and the library page.

**Architecture:** The platform Drive connection gains an ancestry walk with a 60 s cache, a folders-only endpoint and a path in the files listing. Web gets shared Drive building blocks in `apps/web/src/platform/drive/`, a platform page fed by a new `WebModule.drive` contribution (Marketing and Social add their file actions), and Social gets `POST …/social/media/from-drive` reusing `uploadMedia`.

**Tech Stack:** TypeScript, Fastify, zod, Vitest, Next.js (React, `renderToStaticMarkup` tests), lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-11-05-drive-browser-design.md`

## Global Constraints

- No database migration, no new dependency, no Drive OAuth scope change.
- The configured Drive root is the boundary for every folder and file request.
- Browsing: any project member (`scopeFor` without role). Social import: module enabled + `SOCIAL_COMPOSE` + `requireSocial` + `UPLOAD_RATE`. Marketing import/upload: unchanged (project owner).
- Social accepts only `image/png`, `image/jpeg`, `image/webp` from Drive; `video/*` → `SOCIAL_VIDEO_NOT_AVAILABLE` 415 before download; other types → `SOCIAL_MEDIA_TYPE` 415. Drive size cap stays 20,000,000 bytes.
- Ancestry cache: TTL 60,000 ms, max 1,000 entries, folders only, key `${projectId}:${rootId}:${folderId}`, cleared per project on `configureRoot`, `disconnect`, `finishConnect`.
- Web platform code imports no web module (`scripts/boundaries.json`); API Social imports nothing from `modules/marketing/`.
- OAuth callback keeps redirecting to `/settings?googleDrive=ready|choose-root` and opens Integrations.
- Page: platform view `key "drive"`, `path "drive"`, `navGroup "project"`, nav order 105, icon `HardDrive`, `nav.feature "googleDrive"`; deep link `?folder=<id>` validated by `/^[A-Za-z0-9_-]{10,100}$/`.
- Docs and code comments in English; UI texts in en and de.
- Delivery: commit in the worktree; push to `main` only after Mario's OK (push deploys production).

## Review Focus

1. A deep-linked `?folder=` outside the root or malformed → page falls back to the root with a notice, no crash (Task 4 test).
2. A Drive folder with more than one page of subfolders → tree shows "More folders" and loads the next page (Task 3 test).
3. Picking a Drive image when ten media are already selected → import is not started, the limit hint shows (Task 6 test).
4. Drive reconnect required while browsing → reconnect alert with a link to Settings instead of an empty list (Task 4 test).
5. A file whose parent chain is cached but which itself lies in a cached folder that was moved → at most 60 s stale; the cache must still refuse a target whose walk never reaches the root (Task 1 test `refuses a chain that ends without the root`).

---

### Task 1: Drive ancestry, cache, folders endpoint and files path

**Files:**
- Modify: `apps/api/src/platform/connections/google-drive.ts`
- Modify: `apps/api/src/server.ts` (Drive routes, ~1163-1236)
- Test: `apps/api/tests/google-drive-browse.test.ts` (new, unit, mocked `fetch`)

**Interfaces:**
- Produces:
  - `type DrivePathItem = { id: string; name: string }`
  - `ancestry(token: string, targetId: string, rootId: string, projectId?: string): Promise<DrivePathItem[] | null>` — root first, target last; with `projectId` uses and fills the cache for folders.
  - `isWithin(token, target, root, projectId?)` → `(await ancestry(...)) !== null` (existing callers unchanged).
  - `forgetDriveAncestry(projectId: string): void`
  - `listDriveFolders(scope: Scope, raw: unknown): Promise<{ parentId: string; folders: DrivePathItem[]; nextPageToken: string | null }>` — input `{ parentId?: id; pageToken?: string(max 500) }`.
  - `browseDrive` input adds `sort?: "name" | "modified"` (default `name`) and `kind?: "all" | "image"` (default `all`); result adds `path: DrivePathItem[]` and `rootName: string | null`.
  - `driveFileInRoot(scope: Scope, fileId: string): Promise<DriveFile>` — storage + token + root check + metadata, for Task 2.
  - Route `GET /api/projects/:projectId/google-drive/folders` → `listDriveFolders(await scopeFor(auth, req, projectId), req.query)`.
  - Export `ancestry as driveAncestry`, `forgetDriveAncestry`, `driveFileInRoot`, `type DrivePathItem` in the bottom export block.

- [ ] **Step 1: Write failing tests** in `apps/api/tests/google-drive-browse.test.ts`. Mock `globalThis.fetch` with a map `id → { id, name, mimeType, parents }` answering `files/<id>?fields=…` and the list URL. Tests:
  - `ancestry returns the chain root first`: tree `root → a → b`; `ancestry("t","b","root")` equals `[{id:"root",name:"Root"},{id:"a",name:"A"},{id:"b",name:"B"}]`.
  - `refuses a chain that ends without the root`: `x` has no parents → `null`.
  - `stops after 30 levels`: a 31-deep chain → `null`.
  - `cached folders skip Google`: two `ancestry(..., "p1")` calls for `b` → the second makes 0 `files/b`/`files/a` fetches.
  - `cache expires after 60 s`: `vi.useFakeTimers()`, advance 60_001 ms → fetches again.
  - `forgetDriveAncestry clears one project`: after `forgetDriveAncestry("p1")` a `p1` call fetches, a `p2` cached entry does not.
  - `folders query lists only folders by name`: call the internal query builder (export `driveFoldersUrl(parent: string, pageToken?: string): string` for the test) and assert the URL `q` contains `mimeType = 'application/vnd.google-apps.folder'`, `orderBy=name`, `pageSize=200`.
  - `files query sorts and filters`: export `driveChildrenUrl(parent, { query?, pageToken?, sort?, kind? }): string`; `sort:"modified"` → `orderBy=folder,modifiedTime desc`; default → `orderBy=folder,name`; `kind:"image"` → `q` contains `(mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'image/')`.
- [ ] **Step 2: Run** `node --env-file=<main>/.runtime/local.env ./node_modules/vitest/vitest.mjs run apps/api/tests/google-drive-browse.test.ts` → FAIL (exports missing).
- [ ] **Step 3: Implement** in `google-drive.ts`: `ancestry` walks `file(token, current).parents[0]` collecting `{id,name}` and reverses; on a cache hit for `current` it prepends the cached chain and stops; it caches every folder on the resulting chain. `children` builds its URL through `driveChildrenUrl` (keeps the existing default behavior plus `orderBy`). `browseDrive` returns `path` from `ancestry(token, folderId, root, scope.projectId)` (403 `GOOGLE_DRIVE_FOLDER_OUTSIDE_ROOT` when null) and `rootName` from storage. `driveContent` and `configureRootWithToken` pass `scope.projectId`. Call `forgetDriveAncestry(scope.projectId)` in `configureRootWithToken` (before writing), `disconnect` and `finishConnect`. Add the route in `server.ts` after `/google-drive/files`.
- [ ] **Step 4: Run** the test file → PASS. Run `./node_modules/.bin/tsc --noEmit` → no errors.
- [ ] **Step 5: Commit** `feat(drive): folder ancestry with cache, folders endpoint and path in listings`.

### Task 2: Social import from Drive

**Files:**
- Create: `apps/api/src/modules/social/media/from-drive.ts`
- Modify: `apps/api/src/modules/social/routes.ts`
- Test: `apps/api/tests/social-media-drive.integration.test.ts` (new; copy the setup of `social-media-routes.integration.test.ts`)
- Modify: `apps/api/tests/fixtures/access-matrix.json` (regenerated, reviewed)

**Interfaces:**
- Consumes: `driveFileInRoot`, `driveContent` (Task 1), `uploadMedia` (`media/library.ts`).
- Produces: `importDriveMedia(scope: Scope, raw: unknown): Promise<MediaView>` with input `{ fileId: string (Drive id pattern), name?: string (max 200) }` strict. Route `POST /api/projects/:projectId/social/media/from-drive` → 201 `MediaView`.

- [ ] **Step 1: Write failing tests** (`vi.mock("../src/platform/connections/google-drive.ts", …)` keeping the original module and replacing `driveFileInRoot` and `driveContent` with stubs keyed by file id; PNG bytes from `fixtures/social/photo-800x600.png`):
  - `editor imports a Drive PNG` → 201, body `name === "Drive Banner.png"`, then `GET …/social/media` lists it.
  - `owner may pass a name` → `name: "Custom"` gives `Custom.png`.
  - `viewer is refused` → 403.
  - `video is refused before download` → `video/mp4` meta → 415 `SOCIAL_VIDEO_NOT_AVAILABLE`, `driveContent` stub not called.
  - `GIF, SVG and PDF are refused` → 415 `SOCIAL_MEDIA_TYPE` each.
  - `Drive not configured` → stub throws `DomainError("GOOGLE_DRIVE_STORAGE_NOT_CONFIGURED", 409)` → 409 with that code.
  - `module disabled` → 404/403 as the existing upload route answers for a disabled module (assert the same status the upload test asserts).
  - `another project's member` → 403.
- [ ] **Step 2: Run** the file with the integration env → FAIL (404 route).
- [ ] **Step 3: Implement** `importDriveMedia`: parse input; `meta = await driveFileInRoot(scope, fileId)`; `video/*` → `SOCIAL_VIDEO_NOT_AVAILABLE` 415; not in the three image types → `SOCIAL_MEDIA_TYPE` 415; `content = await driveContent(scope, fileId, { md5Checksum: meta.md5Checksum, modifiedTime: meta.modifiedTime })`; `return uploadMedia(scope, { bytes: content.bytes, mime: content.mime, name: input.name ?? meta.name })`. Route in `routes.ts` next to `POST …/media`: `config: UPLOAD_RATE`, then `inSocial(auth, req, SOCIAL_COMPOSE, …)`-equivalent checks (module enabled, `authorize(member, SOCIAL_COMPOSE)`, `requireSocial`) outside the transaction (import does network I/O), reply 201.
- [ ] **Step 4: Run** the file → PASS. Regenerate the access matrix: `UPDATE_ACCESS_MATRIX=1 node --env-file=… ./node_modules/vitest/vitest.mjs run apps/api/tests/access-matrix.integration.test.ts`; review the diff: only the two new routes (`GET …/google-drive/folders`: viewer/editor/owner allowed, outsider/sysadmin denied; `POST …/social/media/from-drive`: editor/owner allowed). Re-run without the flag → PASS.
- [ ] **Step 5: Commit** `feat(social): import images from Google Drive into the media library`.

### Task 3: Shared web Drive building blocks

**Files:**
- Create: `apps/web/src/platform/drive/api.ts`, `apps/web/src/platform/drive/tree-state.ts`, `apps/web/src/platform/drive/folder-tree.tsx`, `apps/web/src/platform/drive/drive-browser.tsx`, `apps/web/src/platform/drive/labels.ts`
- Test: `apps/web/src/platform/drive/tree-state.test.ts`, `apps/web/src/platform/drive/drive-browser.test.tsx`

**Interfaces:**
- Produces:
  - `api.ts`: types `DriveFile` (`id,name,mimeType,size?,modifiedTime?,thumbnailLink?`), `DriveFolder = { id; name }`, `DriveListing = { folderId; files: DriveFile[]; nextPageToken: string|null; path: DriveFolder[]; rootName: string|null }`, `DriveStatus` (move the `Status` type from `components/google-drive.tsx`); `drivePaths(projectId)` → `{ status, files(params), folders(parentId?, pageToken?), content(fileId), openInDrive(fileId) }`; `DRIVE_FOLDER_MIME`; `isDriveImage(f)`, `isDriveVideo(f)`, `isDriveFolder(f)`; `driveFolderParam(value: string|null): string|null` (id pattern or null).
  - `tree-state.ts` (pure): `type TreeState = { children: Record<string, { ids: string[]; next: string|null } | undefined>; names: Record<string,string>; expanded: Set<string> }`; `emptyTree(rootId, rootName)`, `addChildren(state, parentId, page: { folders: DriveFolder[]; nextPageToken: string|null }, append: boolean)`, `toggle(state, id)`, `expandPath(state, path: DriveFolder[])`, `visibleRows(state, rootId): Array<{ id; name; depth; expanded; loaded; more?: true }>`, `keyMove(rows, currentId, key: "ArrowUp"|"ArrowDown"|"ArrowLeft"|"ArrowRight"|"Home"|"End", state): { focus: string; toggle?: string }`.
  - `FolderTree({ projectId, rootId, rootName, path, current, onSelect, locale })`: `role="tree"`, `aria-label`, rows `role="treeitem"` with `aria-level`, `aria-expanded`, `aria-selected`; loads children with `api(drivePaths(projectId).folders(id, token))` on first expand; "More folders" row.
  - `DriveBrowser({ projectId, folderId, onFolderChange, mode: "browse"|"pick", onPick?, pickDisabled?: (f) => string|null, fileActions?: ComponentType<DriveFileActionProps>[], toolbar?: ComponentType<DriveToolbarProps>[], locale })`; `DriveFileActionProps = { projectId; file: DriveFile; folderId: string; onDone: () => void }`; `DriveToolbarProps = { projectId; folderId: string; onDone: () => void }`. Renders: tree column + main column (breadcrumb `nav aria-label`, search input, sort select, view toggle, refresh; table `<table>` with Name/Type/Size/Modified or grid of `asset-card`; "Load more" appends pages). View choice read/written via `localStorage` key `orbit.drive.view` inside try/catch. Platform actions per file: "Copy Drive link", "Open in Drive".
- [ ] **Step 1: Write failing tests.** `tree-state.test.ts`: `visibleRows` hides children of collapsed nodes; `addChildren(..., append true)` keeps earlier ids and sets `next`; a row with `next` adds a `more` row; `expandPath` expands every ancestor; `keyMove` ArrowRight on collapsed → `toggle`, on expanded → first child; ArrowLeft on child → parent. `drive-browser.test.tsx` (static markup, mocked `useResource` like `modules/social/media.test.tsx`): breadcrumb shows `Root / A / B` with links for Root and A, current B as `aria-current="page"`; table view lists name/type/size; in pick mode a video row shows the disabled reason "Videos later" (de: "Videos folgen später") and an image row a "Choose" button; contributed `fileActions` render for each file; `driveFolderParam("../x")` → null.
- [ ] **Step 2: Run** `./node_modules/vitest/vitest.mjs run apps/web/src/platform/drive` → FAIL.
- [ ] **Step 3: Implement** the files. Texts in `labels.ts` (`driveText(locale)`), en and de. Styling with existing classes (`panel`, `page-actions`, `asset-library`, `asset-card`, `data-list`) plus a small layout block in the web stylesheet for `.drive-layout` (grid `minmax(220px, 280px) 1fr`, single column below 768px with the tree in `<details>`), using design-system tokens.
- [ ] **Step 4: Run** the tests → PASS; `pnpm --dir apps/web typecheck` (or `tsc -p apps/web`) → clean; `node scripts/boundaries.mjs` → no new violation.
- [ ] **Step 5: Commit** `feat(web): shared Drive tree and browser components`.

### Task 4: Drive page, contribution point, feature and settings card

**Files:**
- Create: `apps/web/src/platform/drive/drive-page.tsx`
- Modify: `apps/web/src/platform/shell/types.ts` (`WebModule.drive`), `apps/web/src/platform/shell/shell-context.tsx` (`drive` in `ShellContextValue`), `apps/web/src/components/orbit.tsx` (contributions + `googleDrive` feature probe), `apps/web/src/modules/registry.ts` (platform view), `apps/web/src/components/google-drive.tsx` (card slimmed, link), `apps/web/src/lib/i18n` only if nav labels need it
- Test: `apps/web/src/platform/drive/drive-page.test.tsx`; update `apps/web/src/platform/shell/routes.test.tsx` / `nav-groups.test.tsx` expectations that list project-group entries

**Interfaces:**
- Consumes: Task 3 components and types.
- Produces: `WebModule.drive?: { fileActions?: readonly ComponentType<DriveFileActionProps>[]; toolbar?: readonly ComponentType<DriveToolbarProps>[] }`; `ShellContextValue.drive: { fileActions: readonly ComponentType<DriveFileActionProps>[]; toolbar: readonly ComponentType<DriveToolbarProps>[] }` built from `active` modules like `connectors`; `features.googleDrive: boolean` = `useResource<DriveStatus>(drivePaths(project.id).status).data?.enabled === true`.
- [ ] **Step 1: Write failing tests** (`drive-page.test.tsx`, static markup with `ShellContext`): with status `enabled` the page renders `DriveBrowser` and the contributed toolbar; without it an empty state with a link to the Integrations settings (owner) or "Ask a project owner" (viewer); status `reconnectRequired` shows the reconnect alert text from `refreshFailureText`; `?folder=bad` (mock `useSearchParams`) renders the root and the notice "Folder not found in the project folder"; a listing answering 403 `GOOGLE_DRIVE_FOLDER_OUTSIDE_ROOT` shows the same notice. Route test: `routeTable(webRegistry)` has `drive` at `/p/:id/drive` in group `project`, hidden by `navigationForFeatures` without `googleDrive`, shown with it. Settings card test: enabled status renders a link to the drive page and no file list.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Page reads/writes `?folder=` with `useSearchParams`/`router.replace`; uses `PageHead`. Move `refreshFailureText` export unchanged (keep it exported from `components/google-drive.tsx` for existing imports, or re-export). Remove the browser and upload modal from `GoogleDriveSettings` (the upload moves to Marketing in Task 5); add `<a href={hrefOf("drive")}>Open Google Drive</a>` when enabled.
- [ ] **Step 4: Run** web tests (`apps/web/src/platform`, `apps/web/src/components`) → PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(web): Google Drive page in the project navigation`.

### Task 5: Marketing and Social Drive file actions

**Files:**
- Create: `apps/web/src/modules/marketing/drive/drive-actions.tsx` (`AddToLibraryAction`, `UploadToDriveToolbar`)
- Create: `apps/web/src/modules/social/drive-action.tsx` (`AddToSocialAction`)
- Modify: `apps/web/src/modules/marketing/manifest.tsx`, `apps/web/src/modules/social/manifest.tsx` (add `drive: {...}`), `apps/web/src/modules/social/api.ts` (`importFromDrive(projectId, fileId, name?) → Promise<SocialMedia>`), `apps/web/src/modules/social/labels.ts` (texts + `media.errors` for `GOOGLE_DRIVE_STORAGE_NOT_CONFIGURED`, `GOOGLE_DRIVE_RECONNECT_REQUIRED`, `GOOGLE_DRIVE_FILE_OUTSIDE_ROOT`, `GOOGLE_DRIVE_PREVIEW_TOO_LARGE`, `DRIVE_ASSET_CHANGED`, `SOCIAL_VIDEO_NOT_AVAILABLE` if absent)
- Test: `apps/web/src/modules/marketing/drive/drive-actions.test.tsx`, `apps/web/src/modules/social/drive-action.test.tsx`

**Interfaces:**
- Consumes: `DriveFileActionProps`, `DriveToolbarProps`, `isDriveImage` (Task 3); `WebModule.drive` (Task 4).
- Produces: `importFromDrive` used by Task 6.
- [ ] **Step 1: Write failing tests:** `AddToLibraryAction` renders the asset-type select + button for an owner and nothing for an editor (project role from `WorkspaceContext.isOwner`); renders nothing for a folder. `UploadToDriveToolbar` renders for owners only. `AddToSocialAction` renders for module access `editor`/`owner` on an image, nothing for `viewer`, nothing for a video or PDF. The registry has `marketing.drive.fileActions` and `social.drive.fileActions` set.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** by moving the existing import/select and upload modal code from `components/google-drive.tsx` (same endpoints, same payloads, `uploadAssetTypes(studio)`), and the Social action calling `importFromDrive` with a success notice "Added to Social media" (de "In die Social-Mediathek übernommen").
- [ ] **Step 4: Run** tests → PASS; `node scripts/boundaries.mjs` → no new violation.
- [ ] **Step 5: Commit** `feat(web): Marketing and Social actions on Drive files`.

### Task 6: Social composer Drive tab and library button

**Files:**
- Modify: `apps/web/src/modules/social/posts/media-picker.tsx`, `apps/web/src/modules/social/media.tsx`, the composer that renders `MediaPicker` (pass `onImported` to refresh its library list), `apps/web/src/modules/social/labels.ts`
- Test: `apps/web/src/modules/social/posts/media-picker.test.tsx` (new or extend existing), `apps/web/src/modules/social/media.test.tsx`

**Interfaces:**
- Consumes: `DriveBrowser` (Task 3), `importFromDrive` (Task 5), `features.googleDrive` (Task 4).
- Produces: `MediaPicker` new optional props `driveEnabled?: boolean; onImported?: (media: SocialMedia) => void`.
- [ ] **Step 1: Write failing tests:** with `driveEnabled` the picker shows tabs "Library" / "Google Drive" (`role="tablist"`); without it no tabs; with `selected.length === 10` the Drive tab's `pickDisabled` returns the limit text "At most ten images" for images; `pickDisabled` returns "Videos later" for a video. `MediaView` shows "Add from Google Drive" for editors when the feature is on, not for viewers, not when off. Export the pure helper `drivePickBlock(file: DriveFile, selectedCount: number, locale): string | null` from `media-picker.tsx` and test it directly.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement:** picking calls `importFromDrive`, then `onImported(media)` and `onChange([...selected, media.id])`; per-file pending state; errors via `mediaMessage`. The library button opens a `Modal` with `DriveBrowser mode="pick"`, refreshing the list after each import.
- [ ] **Step 4: Run** `./node_modules/vitest/vitest.mjs run apps/web/src/modules/social` → PASS.
- [ ] **Step 5: Commit** `feat(social): choose Google Drive images in the composer and library`.

### Task 7: Contracts, docs and full verification

**Files:**
- Modify: `packages/schemas/openapi.json`, `packages/api-client/src/generated.ts` (generated), `docs/SOCIAL.md` (media section: Drive import, line ~79), `docs/IMPLEMENTATION_STATUS.md` (entry), the Drive section of the doc that describes the settings card (find with `grep -rn "Sync from Drive\|google-drive/files" docs`)

- [ ] **Step 1:** `ORBIT_CONFIG_FILE=<main>/.runtime/local.env node scripts/openapi.ts` then `./node_modules/.bin/openapi-typescript packages/schemas/openapi.json -o packages/api-client/src/generated.ts`; review: only the folders route, files query params, from-drive route.
- [ ] **Step 2:** Update the docs (English): Drive page, contribution point, Social import, limits, no duplicate detection.
- [ ] **Step 3:** Run `pnpm lint`, `pnpm typecheck`, `pnpm test` (with the worktree test DB from `node scripts/test-db-for-worktree.ts`), `pnpm build` (or `next build --webpack` with symlinked modules), `git diff --check`. Expected: all pass; record any environmental failure with its reason.
- [ ] **Step 4:** Browser check in the local preview if a Drive-connected project exists locally; otherwise document the skip (no real Google calls in tests).
- [ ] **Step 5: Commit** `docs(drive): Drive page and Social Drive import`. Then ask Mario before integrating `origin/main` and pushing to `main`.

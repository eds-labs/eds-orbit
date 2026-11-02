# Social S4 — Posts, Variants, Validation, Approvals and Schedule Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member drafts a post for several connected accounts (one base text and image set, per-account variants that inherit or override it), sees per-platform limits and a preview, and requests a schedule or an immediate publication; the owner approves exactly that package in Decisions, and a later change resets the approval. Nothing is sent (S5 sends).

**Architecture:** New `posts/` folder in `apps/api/src/modules/social` with pure parts (`schedule-time.ts`, `validation.ts`, `package-hash.ts`) and services (`posts.ts`, `approval.ts`, `routes.ts`) over the existing `SocialPost`, `SocialPostVariant`, `SocialPostMedia` tables plus one small migration (base text and media, inheritance flags). Approvals are platform ActionRequests (`social.post.schedule`, `social.post.publish_now`, W2, owner decides, never mandatable, not MCP-proposable until S7); an owner's own schedule in the UI is its approval (S-D9). DST handling is a new platform helper `platform/time/zoned-time.ts`. The web gets a posts view with the editor and a native approval renderer; the calendar stays S6.

**Tech Stack:** TypeScript, Fastify 5, Prisma 7 + PostgreSQL 17 (FORCE RLS), zod 4, `@opencoredev/social-sdk` 0.5.0 (`./x`, `./instagram` `prepareTarget` only, no network), Next.js 16, Vitest.

**Spec:** [`2026-11-02-social-module.md`](2026-11-02-social-module.md) (§3 S-D6, S-D9; §5 data model; §6.2 REST; §6.3 action types; §7 "Time"; §10 S4) and [ADR 0020](../../adr/0020-social-module.md). Stacked on S3 (`claude/social-s3`, PR #185).

## Findings this plan relies on (verified 2026-11-02)

| Topic | Fact | Source |
|---|---|---|
| SDK validation | `adapter.posts.prepareTarget(target)` is pure (no I/O); X needs `target.account.accountId === options.auth.userId`, else `x.account`; `x.text` = weighted 280 limit (`isValidXText` is not exported); Instagram: `instagram.caption` > 2,200, media rules need public HTTPS URLs (S3 rules cover media) | `dist/platforms/x.js:1104-1115`, `instagram.js:591-624`, scratch run |
| X long posts | SDK `publishTarget` does not re-run `prepareTarget`; only the client's `publish()` does, so S5 can send > 280 characters for Premium accounts by calling the adapter directly | `x.js:1158-1172`, `core/client.js:212` |
| ActionRequests | `ActionDefinition` (`riskClass`, `deciderRole: "owner"\|"editor"`, `payload` zod, `revalidate`, `onApproved`, `summary`, `ttlMs`, `policyRequired`); package hash = `hash({actionType, payload})`; decide checks version + hash, then `revalidate`, then `onApproved` in the same transaction; no hook on reject; `cancelActionRequest(tx, scope, id, reason, {pendingOnly})` | `platform/governance/action-requests.ts:137-180, 493-575, 600-640` |
| Decider | Only `deciderRole` decides who may decide (owner → `PROJECT_OWN`); there is no per-project decider hook, and `social.approve` is owner-only, so `editor_each` cannot be honored without a platform change | `action-requests.ts:509-512`, `modules/social/permissions.ts` |
| Web renderers | `WebModule.actionRequests: Record<actionType, ActionRequestRenderer>` get `item.summary` (from the type's `summary(payload)`), `de`, `pending`, `decide` | `apps/web/src/modules/work/action-requests.tsx`, `marketing/manifest.tsx:57` |
| Web views | One path segment per view; details via query (`?post=<id>`, pattern of Support's ticket redirect); web tests render statically (`renderToStaticMarkup`) and test pure functions | `platform/shell/types.ts:43-60`, `modules/social/media.test.tsx` |
| Time | `zonedTime` in Marketing has no gap/overlap detection; `Project.timezone` via `tx.project.findUnique` | `marketing/publishing/posting-slots.ts:32`, `marketing/agents/scheduling.ts:69` |
| DST dates | Europe/Berlin: gap 2027-03-28 02:00–03:00, overlap 2026-10-25 02:00–03:00; America/New_York: gap 2027-03-14 02:00–03:00, overlap 2026-11-01 01:00–02:00 | tz rules |
| Error detail | `DomainError(code, status)` has no detail; a subclass with a `detail` object (pattern `PackageCreativeQaError`) is sent as `{error: {code, message, detail}}` | `server.ts:243-249, 451-490`, `marketing/agents/package-creatives.ts:58` |
| Schema | `SocialPost` has status/schedule/approval columns and CHECKs (status list, `scheduleMode`, `scheduleLocal` pattern, `packageHash` hex); no base text; `SocialPostVariant.body` has no length CHECK; publications FK makes a variant with publications undeletable | `migrations/202611020001_social_core` |

## Global Constraints

- Branch `claude/social-s4` in `.claude/worktrees/social-s4`, stacked on `claude/social-s3`; push only on Mario's request. Install with `corepack pnpm install --frozen-lockfile` and create the worktree test DB (`node scripts/test-db-for-worktree.ts`) before Task 1.
- No new dependency. The SDK is imported only from `@opencoredev/social-sdk/x` and `@opencoredev/social-sdk/instagram`, only for `prepareTarget`.
- One migration (`202611020003_social_post_base`): new schema hash, printed for Mario's approval; no deploy.
- Nothing is sent and no `SocialPublication` row is created in S4; S5 creates publications from `scheduled`/`approved` posts.
- S-D6: an approval binds content, accounts, media and the time. S-D9: `owner_each`; a non-owner's schedule or publish-now creates an ActionRequest the owner decides; an owner's own action in the UI is its approval; social action types are never mandatable.
- Limits: text ≤ 25,000 characters stored; schedule lead time ≥ 2 minutes, horizon ≤ 365 days; ≤ 10 accounts and ≤ 10 images per post.
- Code and docs in English; UI strings `en` + `de`; flags stay off.

## Review Focus

1. **An approved post changed afterwards** (text, image, account, options, time, also by a second tab with an old version). Expect: `SOCIAL_VERSION_CONFLICT` for the old version; any accepted change clears the approval, cancels a pending request and returns the post to `draft` (content) or `needs_approval` (editor move).
2. **An owner approves a request whose post changed after the request** (request still pending, hash differs). Expect `SOCIAL_APPROVAL_STALE` (409), post unchanged.
3. **A schedule time in a DST gap or overlap, in the past, or more than a year ahead.** Expect gap → `SOCIAL_SCHEDULE_TIME_GAP` with the suggested time; overlap without `fold` → `SOCIAL_SCHEDULE_TIME_AMBIGUOUS` with both instants; past/too close → `SOCIAL_SCHEDULE_TOO_SOON`; > 365 days → `SOCIAL_SCHEDULE_TOO_FAR`.
4. **A variant that a platform would refuse** (X > 280 without long posts, Telegram caption > 1,024 with images, Instagram without image, five images on X, disconnected account). Expect schedule/publish-now refused with `SOCIAL_VALIDATION_FAILED` and the issues per account; drafts still save.
5. **Media or accounts of another project, or a viewer writing.** Expect 404 for foreign ids (never existence leaks), 403 for viewers.

Each line has its test in the owning task (Tasks 1, 5, 6, 7).

---

### Task 1: DST-safe local time (`platform/time/zoned-time.ts`, `posts/schedule-time.ts`)

**Files:** Create `apps/api/src/platform/time/zoned-time.ts`, `apps/api/src/modules/social/posts/schedule-time.ts`, `apps/api/src/modules/social/errors.ts`; test `apps/api/tests/schedule-time.test.ts`.

**Interfaces — produces:**
```ts
// platform/time/zoned-time.ts
export type LocalResolution =
  | { kind: "exact"; at: Date }
  | { kind: "gap"; suggestedAt: Date; suggestedLocal: string }      // first valid minute after the gap
  | { kind: "ambiguous"; earlier: Date; later: Date };
export function resolveLocalTime(local: string /* YYYY-MM-DDTHH:MM */, timeZone: string): LocalResolution;
export function localOf(at: Date, timeZone: string): string;           // YYYY-MM-DDTHH:MM
export function isTimeZone(value: string): boolean;                    // Intl accepts it

// modules/social/posts/schedule-time.ts
export type ScheduleInput = { at: string } | { local: string; timeZone?: string; fold?: "earlier" | "later" };
export type ResolvedSchedule = { at: Date; local: string; timeZone: string; fold: "earlier" | "later" | null };
export function resolveSchedule(input: ScheduleInput, projectTimeZone: string, now: Date): ResolvedSchedule; // throws DomainError
```
Approach for `resolveLocalTime`: offset(t) = wall clock of t in the zone (via `Intl.DateTimeFormat` parts, `hourCycle: "h23"`) minus t; candidates = wanted-as-UTC minus offset(wanted − 1 day) and minus offset(wanted + 1 day); keep the candidates whose wall clock equals `local`: two distinct → ambiguous (sorted), one → exact, none → gap, where `suggestedAt` is the transition instant found by binary search (minute precision) between the two candidates.

Add `export class SocialDetailError extends DomainError { constructor(code: string, status: number, readonly detail: Record<string, unknown>) }` in `apps/api/src/modules/social/errors.ts` (used by Tasks 1 and 6). `resolveSchedule` errors (422): invalid `local`/`at` or unknown zone → `SOCIAL_SCHEDULE_INVALID`; gap → `SOCIAL_SCHEDULE_TIME_GAP` with `detail: { suggestedLocal, suggestedAt }`; ambiguous without `fold` → `SOCIAL_SCHEDULE_TIME_AMBIGUOUS` with `detail: { earlier, later }` (ISO), both as `SocialDetailError`; `at < now + 2 min` → `SOCIAL_SCHEDULE_TOO_SOON`; `at > now + 365 days` → `SOCIAL_SCHEDULE_TOO_FAR`. An `{at}` input stores `local = localOf(at, projectTimeZone)`, `fold = null`.

- [ ] **Step 1: Write the failing tests** (`schedule-time.test.ts`, no DB):
  - `resolveLocalTime("2027-03-28T02:30", "Europe/Berlin")` → `{kind: "gap", suggestedLocal: "2027-03-28T03:00", suggestedAt: 2027-03-28T01:00:00.000Z}`
  - `resolveLocalTime("2026-10-25T02:30", "Europe/Berlin")` → `{kind: "ambiguous", earlier: 2026-10-25T00:30Z, later: 2026-10-25T01:30Z}`
  - `resolveLocalTime("2027-03-14T02:30", "America/New_York")` → gap, `suggestedAt` 2027-03-14T07:00Z; `("2026-11-01T01:30", "America/New_York")` → ambiguous 05:30Z / 06:30Z
  - `resolveLocalTime("2026-12-01T10:00", "UTC")` → exact 10:00Z; `("2026-12-01T10:00", "Europe/Berlin")` → exact 09:00Z
  - `resolveSchedule({local: "2026-10-25T02:30", timeZone: "Europe/Berlin", fold: "later"}, "UTC", now=2026-10-01)` → `at` 01:30Z, `fold: "later"`; without fold → throws `SOCIAL_SCHEDULE_TIME_AMBIGUOUS` with both instants
  - gap → throws `SOCIAL_SCHEDULE_TIME_GAP` with `suggestedLocal: "2027-03-28T03:00"`
  - `{at: now + 1 min}` → `SOCIAL_SCHEDULE_TOO_SOON`; `{at: now + 366 days}` → `SOCIAL_SCHEDULE_TOO_FAR`; `{local: "2026-13-01T10:00"}` and `timeZone: "Mars/Base"` → `SOCIAL_SCHEDULE_INVALID`
  - `{at}` input keeps `local` in the project zone: `{at: "2026-12-01T09:00:00Z"}`, project zone `Europe/Berlin` → `local: "2026-12-01T10:00"`
- [ ] **Step 2: Run** `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run apps/api/tests/schedule-time.test.ts` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** both files as specified.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): resolve local schedule times across DST gaps and overlaps`.

### Task 2: Migration `202611020003_social_post_base`

**Files:** Create `packages/db/prisma/migrations/202611020003_social_post_base/migration.sql`; modify `packages/db/prisma/schema.prisma`; test `apps/api/tests/social-schema.integration.test.ts` (extend).

**Interfaces — produces (columns):**
- `SocialPost.baseText TEXT NOT NULL DEFAULT ''` with CHECK `char_length("baseText") <= 25000`
- `SocialPost.baseMedia JSONB NOT NULL DEFAULT '[]'` with CHECK `jsonb_typeof("baseMedia") = 'array' AND jsonb_array_length("baseMedia") <= 10` (asset ids, in order)
- `SocialPostVariant.inheritsText BOOLEAN NOT NULL DEFAULT true`, `inheritsMedia BOOLEAN NOT NULL DEFAULT true`, CHECK `char_length("body") <= 25000`
- `SocialPost.title` CHECK `"title" IS NULL OR char_length("title") <= 200`
- Index `SocialPostMedia_project_file_idx ON "SocialPostMedia"("projectId","fileId")` (S3 removal counts uses by file; deferred S3 minor)

- [ ] **Step 1: Failing test** in `social-schema.integration.test.ts`: inserting a variant with a 25,001-character body fails with a CHECK violation; a post with 11 `baseMedia` entries fails; defaults read back as `baseText ""`, `baseMedia []`, `inheritsText true`, `inheritsMedia true`.
- [ ] **Step 2: Run** it — Expected: FAIL (unknown columns).
- [ ] **Step 3: Write** the migration and Prisma fields; apply to the worktree test DB (`node scripts/test-db-for-worktree.ts`).
- [ ] **Step 4: Run** `social-schema`, `rls-matrix` and `social-module` tests — Expected: PASS. Print the hash with `scripts/check-pve-schema.sh --print-hash` and write it into the ledger.
- [ ] **Step 5: Commit** `feat(social): base text, base media and inheritance flags for posts`.

### Task 3: Account settings for posts, and `editor_each` held back

**Files:** Modify `apps/api/src/modules/social/accounts/accounts.ts` (view + update), `settings.ts`, `routes.ts`; test `apps/api/tests/social-accounts.integration.test.ts` (extend), `apps/api/tests/social-settings.integration.test.ts` (extend or create following the existing settings test).

**Interfaces — produces:**
```ts
export type SocialAccountView = { /* existing fields */ settings: { xLongPosts: boolean } };
export async function updateAccountSettings(tx: DbTx, scope: Scope, accountId: string, raw: unknown): Promise<SocialAccountView>;
// raw: { version: int ≥ 1, settings: { xLongPosts?: boolean } } (strict); only X accounts accept xLongPosts (else 422 SOCIAL_SETTING_INVALID)
```
Route `PATCH /api/projects/:projectId/social/accounts/:accountId` (`social.accounts.manage`), optimistic `version` (`SOCIAL_VERSION_CONFLICT` 409), audit `social.account.settings_changed` with the changed keys only. `xLongPosts` means "this X account may post up to 25,000 characters (X Premium)".

`editor_each` (S-D9 option): the platform has no per-project decider hook, so `saveSocialSettings` refuses `approval: "editor_each"` with 409 `SOCIAL_SETTING_NOT_AVAILABLE` until the hook exists (see Ruling at the end). Reading a stored `editor_each` keeps working.

- [ ] **Step 1: Failing tests:** owner sets `xLongPosts: true` on an X account → view shows it, version +1; same on a Telegram account → 422 `SOCIAL_SETTING_INVALID`; editor → 403; stale version → 409; saving settings with `approval: "editor_each"` → 409 `SOCIAL_SETTING_NOT_AVAILABLE`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Update `apps/web/src/modules/social/api.ts` `SocialAccount` with `settings` and add a long-posts switch to the X row of `accounts.tsx` (owner only, `en`/`de` labels), with a static render test in `accounts.test.tsx`.
- [ ] **Step 4: Run** the API tests and `apps/web/src/modules/social` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): X long posts per account; hold back editor approvals`.

### Task 4: Validation (`posts/validation.ts`)

**Files:** Create `apps/api/src/modules/social/posts/validation.ts`; test `apps/api/tests/social-validation.test.ts` (no DB).

**Interfaces — produces:**
```ts
export type ValidationIssue = { code: string; severity: "error" | "warning"; path?: string };
export type VariantFacts = {
  account: { id: string; platform: SocialPlatform; externalId: string; status: string; capability: string; settings: { xLongPosts?: boolean } };
  body: string;
  media: MediaFacts[];                 // from media/rules.ts
  options: Record<string, unknown>;
};
export function validateVariant(v: VariantFacts): ValidationIssue[];
export const TEXT_LIMITS: { x: 280; xLong: 25_000; instagram: 2_200; facebook: 63_206; telegram: 4_096; telegramCaption: 1_024 };
export function platformOptions(platform: SocialPlatform): z.ZodType; // strict per platform
```
Rules (errors unless noted):
- Empty: no text and no media → `SOCIAL_TEXT_EMPTY`.
- X: without `xLongPosts`, run the SDK X adapter's `prepareTarget` (adapter built with `auth.userId = account.externalId` and a dummy token, `fetch` that throws) on a text-only target and map `x.text` → `SOCIAL_TEXT_TOO_LONG` (path `body`); with `xLongPosts`, `[...body].length > 25,000` → `SOCIAL_TEXT_TOO_LONG`.
- Instagram: no media → `SOCIAL_MEDIA_REQUIRED`; caption via the SDK Instagram adapter (`instagram.caption` → `SOCIAL_TEXT_TOO_LONG`), passing placeholder media `https://media.invalid/<i>.jpg` with the real JPEG width/height so only caption issues remain; ignore all other SDK codes.
- Facebook: `[...body].length > 63,206` → `SOCIAL_TEXT_TOO_LONG`. Telegram: with media `> 1,024` → `SOCIAL_CAPTION_TOO_LONG`, else `> 4,096` → `SOCIAL_TEXT_TOO_LONG`.
- Media: `carouselIssues(media, platform)` codes as errors (path `media`).
- Account: `status !== "active"` → `SOCIAL_ACCOUNT_NOT_ACTIVE`; `capability !== "write_verified"` → warning `SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED`.
- Options: X `{replySettings?: "everyone"|"following"|"mentionedUsers"}`, Telegram `{disableLinkPreview?: boolean, silent?: boolean}`, Instagram and Facebook `{}`; anything else → `SOCIAL_OPTIONS_INVALID` (path `options`).

- [ ] **Step 1: Failing tests:** X 281 ASCII characters → `SOCIAL_TEXT_TOO_LONG`; X 281 with `xLongPosts` → none; X 25,001 with `xLongPosts` → `SOCIAL_TEXT_TOO_LONG`; X five images → `SOCIAL_MEDIA_TOO_MANY`; Instagram no media → `SOCIAL_MEDIA_REQUIRED`; Instagram 2,201 characters with one 1080×1080 image → `SOCIAL_TEXT_TOO_LONG` only; Telegram 1,025 characters with an image → `SOCIAL_CAPTION_TOO_LONG`, without image → none; Facebook 63,207 → `SOCIAL_TEXT_TOO_LONG`; empty → `SOCIAL_TEXT_EMPTY`; `reconnect_required` → `SOCIAL_ACCOUNT_NOT_ACTIVE`; `read_verified` → warning only; `options: {replySettings: "nobody"}` → `SOCIAL_OPTIONS_INVALID`; a URL-heavy X text of 250 characters stays valid (SDK weighting, not raw length).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): validate post variants per platform without network calls`.

### Task 5: Posts service and package hash (`posts/posts.ts`, `posts/package-hash.ts`)

**Files:** Create `apps/api/src/modules/social/posts/posts.ts`, `posts/package-hash.ts`; modify `manifest.ts` only if a table list changes (it does not); test `apps/api/tests/social-posts.integration.test.ts`.

**Interfaces — produces:**
```ts
export type PostInput = {
  title?: string | null;                 // ≤ 200
  baseText: string;                      // ≤ 25,000
  baseMedia: string[];                   // SocialMediaAsset ids, unique, ≤ 10
  variants: Array<{ accountId: string; text?: string | null; media?: string[] | null; options?: Record<string, unknown> }>; // 1..10, unique accountId; null/absent = inherit
};
export type PostView = {
  id: string; status: string; title: string | null; baseText: string; baseMedia: MediaRef[];
  schedule: { mode: "none" | "at" | "now"; at: string | null; local: string | null; timeZone: string; fold: "earlier" | "later" | null };
  approval: { state: "none" | "pending" | "approved" | "rejected" | "expired" | "canceled"; requestId: string | null; approvedAt: string | null; approvedBy: string | null };
  packageHash: string | null; origin: string; readOnly: boolean; version: number; createdAt: string; updatedAt: string;
  variants: Array<{ id: string; accountId: string; platform: SocialPlatform; handle: string; body: string; inheritsText: boolean; inheritsMedia: boolean; media: MediaRef[]; options: Record<string, unknown>; issues: ValidationIssue[]; version: number }>;
};
export type MediaRef = { mediaId: string; width: number; height: number; altText: string | null };
export async function createPost(tx: DbTx, scope: Scope, raw: unknown): Promise<PostView>;
export async function getPost(tx: DbTx, scope: Scope, id: string): Promise<PostView>;
export async function listPosts(tx: DbTx, scope: Scope, query: unknown): Promise<{ items: PostListItem[]; nextCursor: string | null }>;
// query: { status?: csv, from?, to? (ISO, ≤ 62 days apart, on scheduledAt), cursor?, limit ≤ 50 }; newest updatedAt first
export async function updatePost(tx: DbTx, scope: Scope, id: string, raw: unknown /* PostInput & {version} */): Promise<PostView>;
export async function archivePost(tx: DbTx, scope: Scope, id: string, version: number): Promise<PostView>;
export async function cancelPost(tx: DbTx, scope: Scope, id: string, version: number): Promise<PostView>;
export async function lockPost(tx: DbTx, scope: Scope, id: string): Promise<SocialPostRow>; // SELECT … FOR UPDATE, 404 otherwise
export function computePackage(post: SocialPostRow, variants: VariantRow[], media: MediaRow[], accounts: AccountRow[]): { hash: string; package: SocialPackage };
```
Rules:
- Save resolves inheritance: `body = text ?? baseText`, media rows = `media ?? baseMedia` (asset → `fileId`, `sha256`, `width`, `height`, `altText`, `kind: "image"`, `position` 0..n). Assets and accounts must belong to the project (else 404 `NOT_FOUND`, never a hint); disabled accounts are refused (`SOCIAL_ACCOUNT_NOT_ACTIVE` 409); validation issues are stored in `variant.validation` but never block a save.
- Variants are upserted by `(postId, accountId)`; removed accounts' variants are deleted (no publications exist in S4); `contentHash = hash({body, options, media: sha256 list})`.
- `scheduleTimezone` on create = `Project.timezone`.
- Version: every mutation needs the current `version` (`SOCIAL_VERSION_CONFLICT` 409) and increments it. `readOnly` posts refuse every write (`SOCIAL_POST_READ_ONLY` 409).
- Editable statuses: `draft`, `needs_approval`, `approved`, `scheduled`. Any content change of `needs_approval|approved|scheduled` → status `draft`, `approvalRequestId/approvedAt/approvedBy/packageHash` cleared, a pending request canceled with reason `post_changed` (`cancelActionRequest(..., {pendingOnly: true})`), audit `social.post.approval_reset`. The planned time stays (`scheduleMode` kept for drafts so S6 can show it).
- `cancelPost`: `needs_approval|approved|scheduled` → `draft` with the same reset; `archivePost`: `draft|canceled|failed|published|partially_published` → `archived`.
- `approval.state` is read from the request entity (`pending`, `approved`/`consumed` → `approved`, `rejected`, `canceled`, pending past `expiresAt` → `expired`); an owner-direct approval has `requestId: null`, `state: "approved"`.
- Package (`package-hash.ts`): `hash({postId, schedule: {mode, at}, variants: sorted by accountId → {accountId, platform, externalId, body, options, media: [{position, sha256, altText}]}})`. Account health/capability is not part of it (S5 rechecks at claim).
- Audit: `social.post.created`, `social.post.updated` (ids and counts only, never text).

- [ ] **Step 1: Failing tests** (`social-posts.integration.test.ts`, fixture `createSocialProject`, seeded accounts via `tx.socialAccount.create`, media via `uploadMedia`):
  - create with base text, one image, X + Telegram, X overriding text → variants: Telegram inherits text and media, X `inheritsText false`; view returns both, `status: "draft"`, `version: 1`
  - update with the old version → `SOCIAL_VERSION_CONFLICT`; changing base text updates only inheriting variants
  - an account id or media id of another project → 404 `NOT_FOUND`
  - a scheduled post (set up via `approval.ts` owner path once Task 6 exists, here by direct row update) edited → `draft`, `packageHash null`, `approval.state "none"`; the pending request of a `needs_approval` post becomes `canceled`
  - package hash changes when body, media order, options or time change, and not when only `title` changes
  - viewer `createPost` → 403 is a route concern (Task 7); here `readOnly` post → `SOCIAL_POST_READ_ONLY`
  - `listPosts` with `from/to` 63 days apart → 422 `SOCIAL_RANGE_TOO_LARGE`; paging returns `nextCursor` after 50
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): posts with inheriting variants, versions and package hashes`.

### Task 6: Approvals, schedule, publish-now and reschedule (`posts/approval.ts`)

**Files:** Create `apps/api/src/modules/social/posts/approval.ts`; modify `contributions.ts` (`actionTypes`); test `apps/api/tests/social-approval.integration.test.ts`.

**Interfaces — consumes:** Task 1 `resolveSchedule`, Task 4 `validateVariant`, Task 5 `lockPost`, `computePackage`, `getPost`. **Produces:**
```ts
export const SCHEDULE_ACTION = "social.post.schedule";
export const PUBLISH_NOW_ACTION = "social.post.publish_now";
export const socialActionTypes: Record<string, ActionDefinition<SocialApprovalPayload>>;
export type SocialApprovalPayload = {
  postId: string; postVersion: number; packageHash: string; requesterId: string;
  schedule: { mode: "at" | "now"; at: string | null; local: string | null; timeZone: string };
  variants: Array<{ accountId: string; platform: SocialPlatform; handle: string; body: string; media: Array<{ mediaId: string; width: number; height: number; altText: string | null }> }>;
};
export async function schedulePost(tx: DbTx, scope: Scope, id: string, raw: unknown): Promise<PostView>;   // {version, at} | {version, local, timeZone?, fold?}
export async function publishNow(tx: DbTx, scope: Scope, id: string, raw: unknown): Promise<PostView>;    // {version}
export async function reschedulePost(tx: DbTx, scope: Scope, id: string, raw: unknown): Promise<PostView>; // {version, at|local…, reapprove?: boolean}
```
Definitions: `riskClass: "W2"`, `approvalMode: "approval_required"`, `deciderRole: "owner"`, no `mandate`, no `mcpProposable`, `policyRequired: false`, `ttlMs: 7 days`, `costCeilingMicros: () => 0`, `summary(payload) → { operation: { kind: "social_post", mode, at, local, timeZone, variants } }`.
- `revalidate`: post exists in the project, not `readOnly`, `status === "needs_approval"`, `packageHash === payload.packageHash`, `version === payload.postVersion`, every account still `active`, no validation error, and for `at` the time is still ≥ now + 2 min; otherwise `SOCIAL_APPROVAL_STALE` (409) or `SOCIAL_SCHEDULE_TOO_SOON`.
- `onApproved`: lock the post, repeat the hash/version check and require `post.approvalRequestId === request.id` (else `SOCIAL_APPROVAL_STALE`), set `status` (`scheduled` for `at`, `approved` for `now`), `approvedAt`, `approvedBy = scope.userId`, consume the request (`consumeActionRequest(tx, scope, request.id, "social-post:" + postId, packageHash)`), audit `social.post.approved` `{requestId, packageHash}`.
- `schedulePost`/`publishNow`: lock, check version (`SOCIAL_VERSION_CONFLICT`), editable status (`draft` or a rejected/expired/canceled `needs_approval`), resolve time (Task 1, project zone default), validate all variants (any error → 409 `SOCIAL_VALIDATION_FAILED`, a `SocialDetailError` with `detail.variants[{accountId, issues}]`), store schedule fields + `packageHash`, bump version. Owner (`scope.role === "owner"`): approve directly (status `scheduled`/`approved`, `approvedBy`, audit `social.post.approved` `{channel: "owner_direct"}`). Others (`social.publish`): `createActionRequest` with the payload and `requestedBy {kind: "user", userId}`, store `approvalRequestId`, status `needs_approval`, audit `social.post.approval_requested`.
- `reschedulePost` (S-D6, the S6 drag target): `draft` → only time fields change. `needs_approval|scheduled|approved`: editor → pending request canceled (`rescheduled`), new request, `needs_approval`; owner with `reapprove: true` → `scheduled` with new approval; owner without → 409 `SOCIAL_REAPPROVAL_REQUIRED` (the UI asks first).

- [ ] **Step 1: Failing tests:**
  - editor schedules a valid post at `local` in 3 days → `needs_approval`, one pending `social.post.schedule` request whose payload names the post, version, hash and both variants
  - editor tries to decide it → 403 `OWNER_REQUIRED`; owner approves with the shown version + hash → post `scheduled`, `approvedBy` owner, request `consumed`
  - post edited between request and decision → the request is `canceled` (Task 5); deciding the stale request → 409 (`ACTION_REQUEST_NOT_PENDING`); with a hand-crafted still-pending request whose hash no longer matches → `SOCIAL_APPROVAL_STALE`
  - owner schedules directly → `scheduled` without a request; audit `social.post.approved` with `channel: "owner_direct"`
  - schedule with an X variant over 280 characters (no long posts) → 409 `SOCIAL_VALIDATION_FAILED` naming the X account; nothing changed
  - gap time → `SOCIAL_SCHEDULE_TIME_GAP` with `suggestedLocal`; ambiguous with `fold: "earlier"` → scheduled at the earlier instant
  - editor reschedules an approved post → `needs_approval`, new request, old approval cleared; owner reschedule without `reapprove` → 409 `SOCIAL_REAPPROVAL_REQUIRED`, with it → `scheduled` and a new `approvedAt`
  - publish-now by editor → request `social.post.publish_now`; approved → status `approved`, `scheduleMode "now"`
  - a scheduled time that passed while the request was pending → decision fails `SOCIAL_SCHEDULE_TOO_SOON`, post stays `needs_approval`
  - registry check: both types W2, no `mandate`, not `mcpProposable` (extend the existing pinned registry test if it lists types)
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**; add `actionTypes: socialActionTypes` to `socialContributions`.
- [ ] **Step 4: Run** this test plus `agent-mandates.integration.test.ts` and `module-contributions` tests — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): owner approvals for scheduling and publishing posts`.

### Task 7: Post routes

**Files:** Create `apps/api/src/modules/social/http-scope.ts` (move `inSocial` there; `routes.ts` imports it), `apps/api/src/modules/social/posts/routes.ts` (`socialPostRoutes: RoutesContribution`, called from `socialRoutes`); modify `apps/api/tests/access-matrix.integration.test.ts` (UPDATE_ACCESS_MATRIX=1 for the pinned table), `docs/API_CONTRACT.md`, OpenAPI (`pnpm api:generate`); test `apps/api/tests/social-posts-routes.integration.test.ts`.

**Routes** (`/api/projects/:projectId/social`):

| Method + path | Permission | Service |
|---|---|---|
| `GET /posts` | `social.read` | `listPosts` |
| `POST /posts` | `social.compose` | `createPost` → 201 |
| `GET /posts/:postId` | `social.read` | `getPost` |
| `PATCH /posts/:postId` | `social.compose` | `updatePost` |
| `POST /posts/:postId/validate` | `social.compose` | stored issues refreshed, `{variants:[{accountId, issues}]}` |
| `POST /posts/:postId/schedule` | `social.publish` | `schedulePost` |
| `POST /posts/:postId/publish-now` | `social.publish` | `publishNow` |
| `POST /posts/:postId/reschedule` | `social.publish` | `reschedulePost` |
| `POST /posts/:postId/cancel` | `social.compose` | `cancelPost` |
| `POST /posts/:postId/archive` | `social.compose` | `archivePost` |

All take `version` in the body where they mutate; ids validated as uuid (404 otherwise); error detail (`variants`, `suggestedLocal`, `earlier/later`) reaches the client as `error.detail`.

- [ ] **Step 1: Failing tests:** viewer reads list and post, gets 403 on every write; editor creates, schedules (→ `needs_approval`); another project's member → 404; module off → 404 `SOCIAL_DISABLED`; `SOCIAL_VALIDATION_FAILED` response carries `error.detail.variants`; gap response carries `error.detail.suggestedLocal`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**; regenerate OpenAPI and the web client; update the access matrix and `API_CONTRACT.md`.
- [ ] **Step 4: Run** this test and `access-matrix.integration.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): post routes`.

### Task 8: Web editor and posts view

**Files:** Create in `apps/web/src/modules/social/posts/`: `editor-state.ts` (pure reducer), `limits.ts`, `posts-view.tsx`, `editor.tsx`, `variant-tabs.tsx`, `media-picker.tsx`, `preview.tsx`, `schedule-field.tsx`; modify `api.ts` (types), `labels.ts` (`posts`, `editor`, `schedule`, `approval` sections, `postMessage(code, locale)`), `manifest.tsx` (`social.posts` → `PostsView`); tests `posts/editor-state.test.ts`, `posts/limits.test.ts`, `posts/posts.test.tsx`.

**Interfaces — produces:**
```ts
// editor-state.ts
export type EditorState = { title: string; baseText: string; baseMedia: string[]; accounts: string[]; overrides: Record<string, { text: string | null; media: string[] | null; options: Record<string, unknown> }>; tab: "base" | string; version: number | null; dirty: boolean };
export type EditorAction =
  | { type: "load"; post: PostView } | { type: "baseText"; text: string } | { type: "toggleAccount"; accountId: string }
  | { type: "override"; accountId: string; text: string } | { type: "inherit"; accountId: string }
  | { type: "media"; target: "base" | string; mediaIds: string[] } | { type: "tab"; tab: string };
export function editorReducer(state: EditorState, action: EditorAction): EditorState;
export function toPostInput(state: EditorState): PostInput;           // null overrides = inherit
export function effectiveText(state: EditorState, accountId: string): string;
// limits.ts (client hints only; the server decides)
export function textHint(platform: SocialPlatform, text: string, opts: { xLongPosts?: boolean; hasMedia: boolean }): { used: number; limit: number; over: boolean };
// schedule-field.tsx helper
export function scheduleErrorView(code: string, detail: unknown, locale: "en" | "de"): { message: string; choices?: Array<{ label: string; fold?: "earlier" | "later"; local?: string }> };
```
Behavior: `/p/:projectId/social/posts` lists posts (status badge incl. `approval.state`, planned time in the post's zone, accounts); `?new=1` or `?post=<id>` opens the editor in the same view. Editor: title, base text with per-platform counters, media picker (library dialog, up to 10, alt text shown), account checkboxes (only `active` accounts selectable, others listed with their status), a tab per selected account ("Uses base text" / "Own text" switch, own media), per-platform preview (handle, text cut at the platform limit with a marker, image grid), schedule field (date + time inputs labelled with the post's zone; gap → message with the suggested time as a button; ambiguous → two buttons "earlier (UTC+2)" / "later (UTC+1)"), buttons Save draft, Check, Schedule (or Request approval for non-owners), Publish now / Request publication, Cancel schedule, Archive; server validation issues shown per tab with `postMessage` texts. Every control has a visible label or `aria-label`; tabs use `role="tablist"`/`tab`/`tabpanel` with `aria-selected`; no `hidden` file inputs.

- [ ] **Step 1: Failing tests:** reducer: base text change reaches inheriting accounts only; `override` then `inherit` restores inheritance; `toggleAccount` removes the override; `toPostInput` sends `text: null` for inheriting accounts. `textHint("x", 281 chars)` → over; with `xLongPosts` → not over; Telegram with media → limit 1,024. `scheduleErrorView("SOCIAL_SCHEDULE_TIME_AMBIGUOUS", {earlier, later})` → two choices with folds; gap → one choice with `local`. Static render: editor for an owner shows "Schedule" and no "Request approval"; for an editor the reverse; viewer sees the list without "New post"; tabs carry ARIA roles; every `<button>` has text or `aria-label`; every `<input>`/`<textarea>` has a label; `de` texts present.
- [ ] **Step 2: Run** `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run apps/web/src/modules/social` — Expected: FAIL.
- [ ] **Step 3: Implement** (read `apps/web/node_modules/next/dist/docs/` for any Next 16 API used; follow `media.tsx` patterns for data loading and errors).
- [ ] **Step 4: Run** the same command and `pnpm --dir apps/web typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): post editor with variants, previews and schedule field`.

### Task 9: Approval renderer and docs

**Files:** Create `apps/web/src/modules/social/action-requests.tsx`; modify `manifest.tsx` (`actionRequests: { "social.post.schedule": …, "social.post.publish_now": … }`), `docs/SOCIAL.md` (posts, variants, approval flow, DST, limits, long posts, `editor_each` held back), `docs/API_CONTRACT.md` (if not done in Task 7), `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md` (R3 editor/approvals partial, R4 time), `docs/adr/0020-social-module.md` (note on `editor_each`); test `apps/web/src/modules/social/action-requests.test.tsx`.

Renderer shows: title "Schedule a social post" / "Publish a social post now" (`de`: "Social-Beitrag einplanen" / "Social-Beitrag sofort veröffentlichen"), the time as local + zone (and UTC when the viewer's zone differs), one block per account (platform, handle, full text in `pre-wrap`, image thumbnails from `/media/:mediaId/content?rendition=jpeg` with their alt text), the note "Approval applies exactly this content and time once." / "Die Freigabe gilt genau für diesen Inhalt und diese Zeit.", Approve / Reject buttons.

- [ ] **Step 1: Failing test:** static render of both renderers with a summary of two variants shows both handles, both texts, image `src` and `alt`, the local time with zone, and two named buttons; `accepts` is false for a summary without `operation.kind === "social_post"`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**; write the docs.
- [ ] **Step 4: Run** the web module tests — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): approval renderer and S4 docs`.

### Task 10: Whole-branch verification

- [ ] **Step 1:** `pnpm lint`, `pnpm typecheck` (web via `pnpm --dir apps/web typecheck`), `python3 scripts/check_framework.py --require-full-validation`, full `vitest run` into the plan workspace log — Expected: all green except environment skips; record counts in the ledger.
- [ ] **Step 2:** Print the schema hash again (must match Task 2) and revert `evals/knowledge/last-deterministic-run.json` if a run touched it.

## Ruling recorded with this plan

- **`editor_each` stays unavailable in S4.** The platform decides "who may decide" only by the type's static `deciderRole`; honoring a per-project setting needs a new optional hook in `ActionDefinition` (used by `decideActionRequest` and `openDecidableRequests`). Default `owner_each` covers Mario's setup; the hook is a platform change best reviewed on its own (S7 or a separate PR). Cost if wrong: editors in a project that wants `editor_each` cannot approve until then.
- **No `SocialPublication` rows in S4.** S5 creates them with the jobs, so the reschedule and cancel logic lives in one place.
- **S4 adds no `social.post.cancel_remote` / `social.account.verify_write`.** Both act on publications or live writes and belong to S5.
- **New migration for the base text** instead of deriving inheritance from equal bodies: inheritance must survive reloads and edits of the base.

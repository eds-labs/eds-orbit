# Social S5 — Dispatcher, Worker Jobs, Adapters and Write Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An approved social post is published at its time to X, Instagram and Telegram exactly once, through the existing Orbit worker, with test mode, per-account write verification, rate limits, reconnect handling, crash recovery that never resends an ambiguous write, and owner resolution of unknown outcomes.

**Architecture:** Three job classes on the existing outbox/pump: `social_dispatch` (per post, due at the scheduled time, creates the publications), `social_deliver` (per publication: claim with fence → send outside the transaction → finish with fence) and `social_reconcile` (Instagram processing and read-back of unknown outcomes). Platform calls go through one `SocialSender` interface (`adapters/registry.ts`) with adapters over SDK 0.5.0 (`./x`, `./instagram`, called through `adapter.posts.publishTarget`, never the SDK client) and over Orbit's Telegram connector. Live sends need `EXECUTION_MODE=live`, `ENABLE_EXTERNAL_WRITES=true`, the platform in the new `ORBIT_SOCIAL_PLATFORMS` and a write-verified account; otherwise the publication is a test publication. A generic worker fix re-dispatches jobs lost from Redis.

**Tech Stack:** TypeScript, Fastify 5, Prisma 7 + PostgreSQL 17 (FORCE RLS), BullMQ via the Orbit pump (`apps/worker/src/main.ts`), `@opencoredev/social-sdk` 0.5.0, `packages/connectors` Telegram client, zod 4, Next.js 16, Vitest.

**Spec:** [`2026-11-02-social-module.md`](2026-11-02-social-module.md) (§3 S-D1, S-D2, S-D3; §6.1 flags; §6.3 revalidation; §7 complete; §8 Telegram; §10 S5) and [ADR 0020](../../adr/0020-social-module.md). Stacked on S4 (`claude/social-s4`, PR #186).

## Findings this plan relies on (verified 2026-11-02)

| Topic | Fact | Source |
|---|---|---|
| Enqueue | `enqueue(tx, scope, topic, resourceId, key, availableAt?, extra?)` writes an `Entity(kind "jobs")` `{status:"queued", attempts:0, maxAttempts:3, …extra}` and an `Outbox` row; dedupe by `key` across all statuses, so a replacement needs a new key | `platform/jobs/enqueue.ts:11-46` |
| Job statuses | `queued`, `running`, `succeeded`, `retry_scheduled`, `blocked_dependency`, `canceled`, `failed`; no cancel API (modules set `canceled` on the entity; the claim skips it) | `apps/worker/src/main.ts:112-209`, `marketing/agents/package-schedule.ts:298-309` |
| JobDef | `{queueClass, handler(ctx), concurrency?, runWhilePaused?, leaseMs? (120 s), onLeaseExpired?(tx, scope, job), onBlockedByPause?(tx, job, scope)}`; `ctx = {scope (userId "worker", role owner), jobId, job, executionMode}`; retries: 3 BullMQ attempts, errors matching `/BUDGET|NOT_|REQUIRED|EXPIRED|…|PAUSED|UNKNOWN|…/` are not retried | `platform/jobs/types.ts:5-45`, `main.ts:73-74, 197` |
| Leases | set once at claim, never renewed; expiry → `onLeaseExpired`, then `retry_scheduled` with a new outbox row (or `blocked_dependency` + `JOB_OUTCOME_UNKNOWN` after 3 attempts) | `main.ts:155-164, 245-287` |
| Pump | per project, every 1.5 s, due `Outbox.availableAt`; an outbox insert pulls `Project.workDueAt` to its `availableAt`, so no scheduler `nextDueAt` is needed for outbox jobs | `main.ts:223-361`, migration `202609300001_project_work_due` |
| Lost jobs | a `queued`/`retry_scheduled` job whose outbox row was dispatched but whose BullMQ job is gone is never re-dispatched | `main.ts:316-334` (no `getJob` anywhere) |
| Pause | worker blocks the job (`PROJECT_PAUSED`) and calls `onBlockedByPause`; modules get `hooks.onProjectResume(tx, scope, {generation})` | `main.ts:128-153`, `platform/governance/types.ts:10-32` |
| Live gate | `liveSending()` = `EXECUTION_MODE === "live" && ENABLE_EXTERNAL_WRITES === "true"` | `platform/email/connection.ts:53-56` |
| Events | `publishEvent(tx, scope, {type, subject, actor, origin, data?})`, content-free, `EventsContribution.publishes` | `platform/events/events.ts:47-97` |
| SDK X | token fixed at construction; `authorize` needs `ref.backend === context.backendInstance` and `ref.accountId === auth.userId`; `publishTarget` skips `prepareTarget`; images only `{kind:"blob", blob, fingerprint}` ≤ 5 MiB; every image-upload error → `media_error`/never; `/2/tweets` throws `SocialError` (5xx/network after dispatch → `ambiguous_outcome`/`reconcile-first`; 429 → `rate_limited`/`after-delay`; 401 → `reconnect_required`); success = `published{post.postId}` without URL; no `getDelivery`; `posts.list` reads recent posts | `dist/platforms/x.js:42-83, 412-455, 715-740, 1158-1189`, `cloud/common.js:58-98` |
| SDK Instagram | Graph v25.0; `publishTarget` creates containers (any error → `ambiguous_outcome` with `details.createdContainerIds`), returns `processing` (`IN_PROGRESS`), `failed` (`ERROR`/`EXPIRED`), `unknown` or `published{postId}` after `media_publish`; state in `InstagramWorkflowStore {create, get, update (partial merge), claim (bool), release?}` — no revision, no lease; `getDelivery` may POST (`media_publish`); `native.publishingLimit` reads the quota; only HTTP status is mapped (401 → reconnect, 400 → `upstream_failure`) | `dist/platforms/instagram.js:41-49, 216-368, 627-778, 1043-1046`, `d.ts:112-130` |
| SDK errors | `SocialError {code, retryDisposition {never \| after-delay{delayMs} \| after-reconnect \| reconcile-first}, upstreamStatus, details}`; transport drops error bodies | `core/errors.d.ts:31-44`, `transport/http.js:190-197` |
| Facebook | no Facebook adapter in 0.5.0, and 0.5.0 is the newest published version (`npm view`, 2026-11-02) | `dist/platforms/`, npm |
| Telegram | connector has `sendMessage(chatId, text, buttons?)` (always disables link previews, no `disable_notification`) and `sendPhoto(chatId, bytes, caption)`; no `sendMediaGroup`; errors are `ConnectorError(code, outcome not_sent\|rejected\|unknown, retryable, status, detail, retryAfterMs)`, sends get `unknown` on network/5xx | `packages/connectors/src/telegram.ts:111-334`, `http.ts:5-10` |
| Credentials | `accountCredentials(scope, accountId)` → `{platform, accessToken, externalId, pageId?, config}` (X refreshed under the connection lock when ≤ 5 min left; Telegram `botToken`; Instagram `pageToken` + `config.igUserId`); `markReconnectRequired(tx, scope, accountId, code)` | `modules/social/accounts/vault.ts:21-134` |
| Media | `publicMediaUrl(scope, {publicationId, fileId})` (needs `ORBIT_SOCIAL_MEDIA_PUBLIC` + public ingress; serves while the publication is `claimed\|sending\|processing`); `renditionFor(media, platform)`; `readFile(scope, fileId)` | `media/public-url.ts:39-52`, `media/rules.ts:27-38`, `platform/files/files.ts` |
| Throttle table | `SocialAccountThrottle (accountId, window minute\|hour\|day, windowStart, count, blockedUntil?)`; `SocialProviderState (projectId, namespace, recordKey, revision, body, leaseToken?, leaseExpiresAt?)` | migration `202611020001_social_core:216-283` |

## Global Constraints

- Branch `claude/social-s5` in `.claude/worktrees/social-s5`, stacked on `claude/social-s4`; push only on Mario's request. Worktree test DB via `node scripts/test-db-for-worktree.ts` before Task 1.
- **No live write in any test or run of this phase.** Tests use fake `fetch` (`setSocialFetchForTests`) for X, Instagram and Telegram. A real post needs Mario's approval per account (write verification is that approval).
- One scheduler: no BullMQ repeatable or delayed jobs, no SDK timers; due work only through outbox `availableAt`.
- An unknown outcome is never resent automatically (`outcome_unknown` is terminal until an owner or a read-back resolves it).
- The SDK is used only through `@opencoredev/social-sdk/x` and `/instagram` adapters (`adapter.posts.publishTarget`, `posts.list`, `native.publishingLimit`), never the SDK client, never `./cloud/*`.
- No migration (all tables exist since S1). New installation switch `ORBIT_SOCIAL_PLATFORMS` (comma list of `x,instagram,telegram`, default empty) in config, both Compose files, `.env.example` and the Compose checks.
- Facebook is not sent in S5 (no adapter; see Ruling 1): a live Facebook publication blocks with `SOCIAL_PLATFORM_NOT_AVAILABLE`.
- Code and docs English; UI `en` + `de`; flags stay off.

## Review Focus

1. **The same publication delivered twice** (BullMQ redelivery, two workers, a retry after a crash between the provider call and the result write). Expect exactly one adapter call; the second run sees the fence or a non-pending status and does nothing.
2. **The worker dies while sending.** Expect the lease expiry to set `outcome_unknown`, no second adapter call when the job reruns, an attention item, and the owner (or a read-back) resolving it.
3. **A post that changed, was canceled, rescheduled or whose project paused between approval and due time.** Expect the old dispatch job to do nothing (version check), pause to block with `PROJECT_PAUSED`, resume to re-enqueue only within 30 minutes of the planned time.
4. **Live mode against an unverified account, a disabled platform, or Instagram without public media.** Expect no provider call and a blocked publication with the reason; in test mode a test publication.
5. **Provider throttling and token loss** (429 with `Retry-After`, Telegram `retry_after`, Instagram quota, 401). Expect a delayed retry only when nothing was submitted, at most 3 automatic attempts, and `reconnect_required` with an owner notification on 401.

Each line has its test in Tasks 7, 8, 9 or 10.

---

### Task 1: Delivery gates and `ORBIT_SOCIAL_PLATFORMS`

**Files:** Create `apps/api/src/modules/social/dispatch/gates.ts`; modify `packages/config/src/index.ts` (next to `ORBIT_SOCIAL_MEDIA_PUBLIC`, a string validated as a comma list of `x|instagram|telegram`, default `""`), `docker-compose.yml`, `docker-compose.pve.yml`, `.env.example`, `scripts/check-coolify-compose.mjs` (the three places that list `ORBIT_SOCIAL_MEDIA_PUBLIC`), `posts/validation.ts` (context); test `apps/api/tests/social-gates.test.ts`, extend `social-validation.test.ts`.

**Interfaces — produces:**
```ts
export type SendMode = "live" | "test";
export function sendMode(): SendMode;                        // liveSending() from platform/email/connection.ts
export function platformEnabled(platform: SocialPlatform): boolean; // in ORBIT_SOCIAL_PLATFORMS and has an adapter (x, instagram, telegram)
export const SENDABLE_PLATFORMS: readonly SocialPlatform[]; // ["x", "instagram", "telegram"]
// validation.ts gains an optional second argument:
export function validateVariant(v: VariantFacts, ctx?: { mode: SendMode; platformEnabled: boolean; publicMedia: boolean }): ValidationIssue[];
```
In live mode only: `!platformEnabled` → error `SOCIAL_PLATFORM_NOT_AVAILABLE`; Instagram with `!publicMedia` → error `SOCIAL_MEDIA_PUBLIC_REQUIRED`; account `capability !== "write_verified"` becomes an error (`SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED`, still a warning in test mode). `currentIssues` (posts.ts) passes the context, so `schedule`/`publish-now` refuse live posts that cannot go out.

- [ ] **Step 1: Failing tests:** `sendMode()` is `test` unless both env values are set; `platformEnabled("x")` false by default, true with `ORBIT_SOCIAL_PLATFORMS=x,telegram`, `platformEnabled("facebook")` always false; validation in live mode: Facebook → `SOCIAL_PLATFORM_NOT_AVAILABLE`, Instagram without public media → `SOCIAL_MEDIA_PUBLIC_REQUIRED`, `read_verified` → error; in test mode none of these. Compose check fails without the new key in both files.
- [ ] **Step 2: Run** `.superpowers/sdd/<plan>/t apps/api/tests/social-gates.test.ts apps/api/tests/social-validation.test.ts scripts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same plus `npm run test:coolify-compose` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): delivery gates and ORBIT_SOCIAL_PLATFORMS`.

### Task 2: Telegram connector additions

**Files:** Modify `packages/connectors/src/telegram.ts`; test `packages/connectors/src/telegram.test.ts` (extend).

**Interfaces — produces (additive, existing signatures unchanged):**
```ts
sendMessage(chatId, text, buttons?, options?: { disableLinkPreview?: boolean /* default true */; silent?: boolean }): Promise<{ messageId: number }>;
sendPhoto(chatId, bytes, caption, buttons?, options?: { silent?: boolean; mime?: "image/jpeg" | "image/png" }): Promise<{ messageId: number }>;
sendMediaGroup(chatId: string, photos: Array<{ bytes: Uint8Array; mime: "image/jpeg" | "image/png" }>, caption: string, options?: { silent?: boolean }): Promise<{ messageIds: number[] }>;
```
`sendMediaGroup`: 2–10 photos, each ≤ 10 MiB, caption ≤ 1,024 on the first item, multipart `attach://photo<i>`, `disable_notification` when silent, a per-call timeout of 60 s for media sends; same error mapping as `sendPhoto` (a send: network/5xx → `unknown`).

- [ ] **Step 1: Failing tests:** `sendMessage` sends `link_preview_options.is_disabled` false when `disableLinkPreview: false` and `disable_notification: true` when silent; `sendPhoto` uses the given mime in the multipart part; `sendMediaGroup` with 3 photos posts `media` JSON with `attach://photo0..2`, caption only on item 0, returns the three message ids; 1 or 11 photos → `ConnectorError` `INVALID_INPUT` before any request; 429 with `retry_after: 7` → `RATE_LIMITED`, `retryAfterMs: 7000`, outcome `rejected`; HTTP 502 → outcome `unknown`; the bot token never appears in an error.
- [ ] **Step 2: Run** `…/t packages/connectors/src/telegram.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it and `apps/api/tests/telegram*.test.ts` (owner bot untouched) — Expected: PASS.
- [ ] **Step 5: Commit** `feat(connectors): Telegram media groups, silent sends and link previews`.

### Task 3: Provider state store and Instagram workflow store

**Files:** Create `apps/api/src/modules/social/adapters/provider-state-store.ts`; test `apps/api/tests/social-provider-state.integration.test.ts`.

**Interfaces — produces:**
```ts
export function providerStateStore(scope: Scope, namespace: string): {
  read(key: string): Promise<{ revision: number; body: Record<string, unknown> } | null>;
  create(key: string, body: Record<string, unknown>): Promise<void>;              // conflict if it exists
  update(key: string, revision: number, patch: Record<string, unknown>): Promise<number>; // CAS on revision → new revision; SOCIAL_PROVIDER_STATE_CONFLICT otherwise
  claim(key: string, ttlMs: number): Promise<string | null>;                       // lease token, null when leased and not expired
  release(key: string, token: string): Promise<void>;
};
export function instagramWorkflowStore(scope: Scope, publicationId: string): InstagramWorkflowStore; // SDK interface
```
Each call is its own short `scoped()` transaction (the adapter calls the store outside any Orbit transaction). The Instagram store uses namespace `instagram-workflow`, key = workflow id (`<publicationId>`, so one workflow per publication), merges `update` patches with CAS retries (3), `claim` = lease of 5 minutes, `release` clears it. No tokens or captions beyond what the SDK stores (`caption` is the post text, already in the variant).

- [ ] **Step 1: Failing tests:** create/read/update with the right revision; a stale revision → `SOCIAL_PROVIDER_STATE_CONFLICT`; claim twice → second `null`; after the TTL (fake `Date`) claim succeeds again; release frees it; another project cannot read the record (RLS); the Instagram store satisfies the SDK's workflow sequence `create → update(stage) → get → claim → release` and `create` returns the id `pub-…` derived from the publication.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): provider state store with compare-and-set and leases`.

### Task 4: Sender interface and the X adapter

**Files:** Create `apps/api/src/modules/social/adapters/{registry.ts, outcome.ts, x.ts}`; test `apps/api/tests/social-adapter-x.test.ts` (no DB; fake fetch).

**Interfaces — produces:**
```ts
export type SendInput = {
  publicationId: string;
  credentials: AccountCredentials;                     // accounts/vault.ts
  account: { externalId: string; handle: string; settings: { xLongPosts?: boolean } };
  body: string;
  options: Record<string, unknown>;
  media: Array<{ fileId: string; bytes: Uint8Array; mime: "image/jpeg" | "image/png"; width: number; height: number; publicUrl: string | null }>;
  providerState: Record<string, unknown>;              // from an earlier attempt
};
export type SendResult =
  | { kind: "published"; externalPostId: string; permalink: string | null; providerState?: Record<string, unknown> }
  | { kind: "processing"; providerState: Record<string, unknown> }
  | { kind: "failed"; code: string; retry: "never" | "after-delay" | "after-reconnect"; delayMs?: number }  // nothing was submitted
  | { kind: "unknown"; code: string; providerState?: Record<string, unknown> };                           // maybe submitted
export interface SocialSender {
  send(scope: Scope, input: SendInput): Promise<SendResult>;
  /** Reads back after processing or an unknown outcome; never resubmits. */
  reconcile?(scope: Scope, input: SendInput & { since: Date }): Promise<SendResult | { kind: "not_found" }>;
}
export function senderFor(platform: SocialPlatform): SocialSender | null; // x, instagram, telegram; facebook null
export function resultFromSocialError(error: unknown): SendResult;       // outcome.ts
```
`resultFromSocialError`: `SocialError` with `retryDisposition` `after-delay` → `failed/after-delay` (`delayMs`), `after-reconnect` → `failed/after-reconnect`, `reconcile-first` or code `ambiguous_outcome`/`timeout`/`cancelled` → `unknown`, other `never` → `failed/never` with `code` `SOCIAL_PROVIDER_<UPPER(code)>`; anything not a `SocialError` → `unknown` (`SOCIAL_PROVIDER_UNKNOWN`). X adapter: build `x({auth: {userId: externalId, accessToken}, fetch: socialFetch})` per send, context `{correlationId: publicationId, backendInstance: "orbit", retryBudget: {maxAttempts: 1, maxElapsedMs: 120_000}}`, target account `{kind: "connected-account", version: 1, backend: "orbit", platform: "x", accountId: externalId}`, media as `{kind: "image", source: {kind: "blob", blob: new Blob([bytes], {type: mime}), fingerprint: sha256}, mimeType}` (no alt text: X refuses it in 0.5.0), `options.replySettings` passed; `published` → permalink `https://x.com/<handle without @>/status/<postId>`. `reconcile`: `posts.list(limit 20)` and match a post created at/after `since − 5 min` whose text equals the body after collapsing whitespace (X shortens links, so compare with every `https?://\S+` replaced by `<url>`) → `published`, else `not_found`.

- [ ] **Step 1: Failing tests** (fake fetch answering the X endpoints):
  - text-only 201 → `published`, permalink `https://x.com/orbit_x/status/111`, exactly one `POST /2/tweets`
  - two images → two `POST /2/media/upload` then `/2/tweets` with both media ids
  - a 600-character body is sent unchanged (no `prepareTarget` on the send path)
  - `/2/tweets` 429 with `retry-after: 30` → `failed/after-delay`, `delayMs: 30000`
  - 401 → `failed/after-reconnect`; 403 → `failed/never` `SOCIAL_PROVIDER_MISSING_PERMISSION`
  - 503 or a network error after dispatch → `unknown`
  - image upload 500 → `failed/never` (nothing posted; the SDK maps every upload error to `media_error`)
  - `reconcile` finds the post among 3 recent ones by normalized text, ignores one from before `since − 5 min`, returns `not_found` otherwise
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): sender interface and X adapter`.

### Task 5: Instagram adapter

**Files:** Create `apps/api/src/modules/social/adapters/instagram.ts`; test `apps/api/tests/social-adapter-instagram.integration.test.ts` (DB for the workflow store; fake fetch).

**Interfaces — consumes:** Task 3 `instagramWorkflowStore`, Task 4 `SocialSender`. **Produces:** `instagramSender: SocialSender`.

Behaviour: adapter `instagram({auth: {accessToken: pageToken, accountId: config.igUserId, flavor: "facebook-login"}, fetch: socialFetch, workflowStore})`; media from `publicUrl` (JPEG rendition; a missing `publicUrl` → `failed/never` `SOCIAL_MEDIA_PUBLIC_REQUIRED` without any request); before sending read `native.publishingLimit` — `quota_usage >= config.quota_total` → `failed/after-delay` `SOCIAL_RATE_LIMITED` with `delayMs` 1 hour. When `providerState.workflowId` exists from an earlier attempt, never call `publishTarget` again: continue with `native.resumePublication(account, workflowId, context)`. `processing` → `{kind: "processing", providerState: {workflowId}}`; `published` → permalink via `posts.get` (best effort; `null` on failure); `ambiguous_outcome` with `details.createdContainerIds` → `unknown` with `providerState {workflowId, containerIds}`. `reconcile`: with a `workflowId` → `resumePublication` (continues the same workflow, may publish it — the workflow's own stage prevents a second `media_publish`); without → `posts.list(limit 20)` caption match as for X.

- [ ] **Step 1: Failing tests:** single image `FINISHED` → `published` with permalink, one `media_publish`; `IN_PROGRESS` → `processing` with `workflowId`; a later `reconcile` with `FINISHED` publishes once; a second `reconcile` after `published` makes no POST; container create 500 → `unknown` with the created container ids; quota exhausted → `failed/after-delay` with no container created; no `publicUrl` → no request at all; carousel of 3 equal ratios → 3 child containers, one `CAROUSEL`, one `media_publish`; 401 → `failed/after-reconnect`.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): Instagram adapter with a durable workflow`.

### Task 6: Telegram adapter

**Files:** Create `apps/api/src/modules/social/adapters/telegram.ts`; test `apps/api/tests/social-adapter-telegram.test.ts`.

**Interfaces — consumes:** Task 2 connector, Task 4 interface. **Produces:** `telegramSender: SocialSender` (no `reconcile`: Telegram cannot read a channel back).

Behaviour: client from `credentials.accessToken` (bot token) with `fetch: socialFetch`; chat `credentials.config.chatId`; no media → `sendMessage(chat, body, undefined, {disableLinkPreview: options.disableLinkPreview ?? true, silent})`; one image → `sendPhoto`; 2–10 → `sendMediaGroup`. `externalPostId` = first message id (all ids in `providerState.messageIds`); permalink `https://t.me/<name>/<id>` only when `chatId` starts with `@`. `ConnectorError` mapping: `RATE_LIMITED` → `failed/after-delay` (`retryAfterMs`); `PROVIDER_AUTH` → `failed/after-reconnect`; outcome `unknown` → `unknown`; other `rejected`/`not_sent` → `failed/never` (`SOCIAL_PROVIDER_REJECTED`).

- [ ] **Step 1: Failing tests:** text → `sendMessage` once, `published` with id; 3 images → one `sendMediaGroup`; `@orbit_news` chat → permalink `https://t.me/orbit_news/42`, numeric chat → `null`; 429 `retry_after: 5` → after-delay 5000; 403 → after-reconnect; 502 → `unknown`; the owner bot's token is never used (the sender only reads the account's credentials).
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): Telegram adapter over the Orbit connector`.

### Task 7: Dispatch — from an approved post to publications

**Files:** Create `apps/api/src/modules/social/dispatch/{jobs.ts, dispatch.ts, status.ts}`; modify `posts/approval.ts` (call `startDelivery` where a post becomes `scheduled`/`approved`), `posts/posts.ts` (`cancelPost`, `updatePost` reset and `reschedulePost` call `stopDelivery`), `contributions.ts` (`jobs`); test `apps/api/tests/social-dispatch.integration.test.ts`.

**Interfaces — produces:**
```ts
export const DISPATCH = "social_dispatch", DELIVER = "social_deliver", RECONCILE = "social_reconcile";
export async function startDelivery(tx: DbTx, scope: Scope, post: SocialPostRow): Promise<void>;
// enqueue(tx, scope, DISPATCH, post.id, `social-dispatch:${post.id}:v${post.version}`, post.scheduledAt ?? new Date(), { postVersion: String(post.version) })
export async function stopDelivery(tx: DbTx, scope: Scope, postId: string, reason: string): Promise<void>;
// sets queued/retry_scheduled/blocked_dependency DISPATCH jobs of the post to canceled (error `SOCIAL_${reason}`)
export async function dispatchPost(scope: Scope, postId: string, postVersion: number): Promise<{ status: "succeeded" | "canceled"; errorCode: string | null }>;
export async function refreshPostStatus(tx: DbTx, scope: Scope, postId: string): Promise<void>; // status.ts
export function idempotencyKeyOf(p: { postId: string; variantId: string; accountId: string; packageHash: string }): string; // "social:" + sha256
```
`dispatchPost` (one transaction, post locked): post must be `scheduled|approved`, `version === postVersion`, `packageHash === packageOf(...).hash`; else `{status: "canceled", errorCode: "SOCIAL_POST_CHANGED"}` and nothing created. It creates one `SocialPublication` per variant (`status pending`, `idempotencyKey`; an existing key → skip), sets the post to `publishing`, and enqueues one `DELIVER` job per publication (`social-deliver:${pubId}:1`, now). `refreshPostStatus`: all `published` → `published`; any `pending|claimed|sending|processing|accepted|failed with nextAttemptAt|blocked|outcome_unknown|cancel_requested` → `publishing`; all terminal with ≥ 1 published → `partially_published`; all terminal without → `failed` (canceled-only → `canceled`). Job defs: `DISPATCH {concurrency 1}`, `DELIVER {concurrency 2, leaseMs 180_000}` (handler in Task 8), `RECONCILE {concurrency 2}` (Task 9).

- [ ] **Step 1: Failing tests:**
  - owner schedules → one `social_dispatch` job with `availableAt` = `scheduledAt` and key `…:v<version>`; publish-now → `availableAt` ≈ now
  - running the dispatch handler (via `registeredJobs().get(DISPATCH)!.handler`) creates 2 publications (two variants), the post becomes `publishing`, two `social_deliver` jobs exist; running it again creates nothing new
  - edit after approval → the dispatch job is `canceled`; a dispatch job of an older version → `canceled`, no publication
  - reschedule by an owner → old job canceled, new job at the new time
  - `refreshPostStatus` table: [published, published] → published; [published, failed] → partially_published; [failed, canceled] → failed; [canceled] → canceled; [published, outcome_unknown] → publishing
  - S4 editing rules still hold for `publishing` posts (`SOCIAL_POST_NOT_EDITABLE`)
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** this and the S4 suites (`social-posts`, `social-approval`, `social-posts-routes`) — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): dispatch approved posts into publications`.

### Task 8: Deliver — claim, send, finish

**Files:** Create `apps/api/src/modules/social/dispatch/{deliver.ts, claim.ts, throttle.ts}`; modify `dispatch/jobs.ts`, `contributions.ts` (`events.publishes`), `attention.ts`; test `apps/api/tests/social-deliver.integration.test.ts`.

**Interfaces — produces:**
```ts
export async function deliverPublication(scope: Scope, publicationId: string): Promise<{ status: string; errorCode: string | null }>;
export async function claimPublication(tx: DbTx, scope: Scope, id: string, now: Date):
  Promise<{ kind: "claimed"; fence: string; mode: SendMode } | { kind: "skip"; reason: string } | { kind: "blocked"; code: string } | { kind: "later"; at: Date }>;
export async function finishPublication(tx: DbTx, scope: Scope, id: string, fence: string, result: SendResult, mode: SendMode): Promise<void>;
export async function takeThrottle(tx: DbTx, scope: Scope, account: { id: string; platform: SocialPlatform }, now: Date): Promise<{ ok: true } | { ok: false; until: Date }>;
export const THROTTLE: Record<SocialPlatform, Array<{ window: "minute" | "hour" | "day"; max: number }>>;
// telegram [{minute, 20}], x [{minute, 6}, {day, 300}], instagram [{day, 50}], facebook [{hour, 30}]
```
`claimPublication` (row `FOR UPDATE`): status `pending`, or `failed` with `retryDisposition = "after-delay"` and `nextAttemptAt <= now`, else `skip`; `cancel_requested` → `canceled`, `skip`; post `publishing`; revalidation in order — account `active` (else blocked `ACCOUNT_RECONNECT_REQUIRED`), live mode: platform enabled (`SOCIAL_PLATFORM_NOT_AVAILABLE`), account `write_verified` unless the post is a write verification (Task 11) (`SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED`), Instagram with public media (`SOCIAL_MEDIA_PUBLIC_REQUIRED`); post package unchanged (`SOCIAL_APPROVAL_STALE`); throttle (`later` with `until`). Claimed: `status claimed`, new `fence`, `attempts + 1`, `claimedAt`. `deliverPublication`: claim (tx 1) → test mode: finish as `published` with `externalPostId "test:<uuid>"`, `providerState {test: true}`, no adapter → live: mark `sending` with the fence (tx 2, committed), read media bytes and public URLs, `senderFor(platform).send(...)` outside any transaction, write one `SocialDeliveryAttempt` (`step publish`, `outcome ok|rejected|unknown|not_sent`, `httpStatus?`, `providerCode`, `requestHash = sha256(idempotencyKey + attempt)`), `finishPublication` (tx 3; fence mismatch → throw `SOCIAL_STALE_FENCE`, nothing written). Finish mapping: `published` → `published`, `publishedAt`, `externalPostId`, `permalink`; `processing` → `processing` + enqueue `RECONCILE` (`social-reconcile:${id}:1`, now + 15 s); `failed/after-delay` → `attempts < 3`: `failed`, `retryDisposition after-delay`, `nextAttemptAt = now + max(delayMs, 60 s)` and a new `DELIVER` job (`social-deliver:${id}:${attempts + 1}`, at `nextAttemptAt`); else terminal `failed`; `failed/after-reconnect` → `blocked` `ACCOUNT_RECONNECT_REQUIRED` + `markReconnectRequired`; `failed/never` → `failed` (terminal, `lastErrorCode`); `unknown` → `outcome_unknown` + `exception(tx, scope, "SOCIAL_OUTCOME_UNKNOWN", id)`. Each finish calls `refreshPostStatus` and publishes `social.publication.published|failed|outcome_unknown` (data: `{postId, platform}` only). `later` → re-enqueue `DELIVER` at `until` (`…:t<epoch>` key). `DELIVER.onLeaseExpired`: a publication still `sending` → `outcome_unknown` + exception (never `pending` again). `onBlockedByPause` → publication `blocked` `PROJECT_PAUSED`. Attention: one item per post with `outcome_unknown`, `blocked` or terminal `failed` publications.

- [ ] **Step 1: Failing tests** (fake fetch for X/Telegram; env per test):
  - test mode (default env): two publications become `published` with `test:` ids, no fetch call, post `published`, events published
  - live mode with a verified Telegram account and `ORBIT_SOCIAL_PLATFORMS=telegram`: exactly one `sendMessage`, publication `published` with the message id, one delivery attempt row without the text
  - running `deliverPublication` twice concurrently → one provider call; the second returns `skip`
  - finishing with a stale fence → `SOCIAL_STALE_FENCE`, state unchanged
  - lease expiry while `sending` (call `onLeaseExpired`) → `outcome_unknown`, exception; running the job again → no provider call
  - 429 `retry_after 30` → `failed`, `nextAttemptAt` ≈ now + 60 s (minimum), a new deliver job at that time; third failure → terminal `failed`
  - 403 on Telegram → `blocked ACCOUNT_RECONNECT_REQUIRED`, account `reconnect_required`, owner notified once
  - 502 → `outcome_unknown`, no retry job
  - live mode, account `read_verified` → `blocked SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED`, no fetch; platform not in the list → `SOCIAL_PLATFORM_NOT_AVAILABLE`
  - throttle: the 21st Telegram publication in one minute → `later`, re-enqueued at the next minute
  - a publication whose post changed after dispatch (package hash) → `blocked SOCIAL_APPROVAL_STALE`
  - attention lists the post with an unknown outcome
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): deliver publications exactly once with fences and throttles`.

### Task 9: Reconcile — processing and unknown outcomes

**Files:** Create `apps/api/src/modules/social/dispatch/reconcile.ts`; modify `dispatch/jobs.ts`; test `apps/api/tests/social-reconcile.integration.test.ts`.

**Interfaces — produces:**
```ts
export async function reconcilePublication(scope: Scope, publicationId: string, attempt: number): Promise<{ status: string; errorCode: string | null }>;
export const RECONCILE_DELAYS_MS: (attempt: number) => number; // min(15_000 * 2 ** (attempt - 1), 900_000)
export const RECONCILE_MAX = 12;
```
`processing`: call `sender.reconcile` (Instagram resumes its workflow) → `published` (finish as in Task 8), still `processing` → next `RECONCILE` job at the backoff (`social-reconcile:${id}:${attempt + 1}`), after attempt 12 → `outcome_unknown` + exception; `failed` → terminal `failed`. `outcome_unknown` (enqueued once by Task 8 for X and Instagram only, 2 minutes after the unknown result): `reconcile` with `since = claimedAt` → `published` sets `resolution "published_confirmed"`, `resolvedBy "system"`; `not_found` → stays `outcome_unknown` for the owner (never resent). Telegram: no reconcile job. Each read writes a `SocialDeliveryAttempt` (`step status`).

- [ ] **Step 1: Failing tests:** Instagram `IN_PROGRESS` twice then `FINISHED` → `published` after 3 reconcile jobs, one `media_publish`; 12 × `IN_PROGRESS` → `outcome_unknown`; X unknown + read-back finds the post → `published`, `resolution published_confirmed`; read-back without match → still `outcome_unknown`, no `/2/tweets` call; backoff values `[15 s, 30 s, 60 s, …, 900 s]`.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): reconcile processing and unknown publications`.

### Task 10: Cancel, pause/resume and owner resolution

**Files:** Create `apps/api/src/modules/social/dispatch/control.ts`; modify `posts/posts.ts` (`cancelPost` accepts `publishing`), `posts/routes.ts`, `contributions.ts` (`hooks.onProjectResume`), `posts/posts.ts` `getPost` (publications in the view); test `apps/api/tests/social-control.integration.test.ts`; access matrix.

**Interfaces — produces:**
```ts
export async function cancelDelivery(tx: DbTx, scope: Scope, postId: string): Promise<{ canceled: number; tooLate: number }>;
// pending|blocked|failed-with-retry → canceled (+ their jobs canceled); claimed|sending → cancel_requested; others unchanged
export async function resolvePublication(tx: DbTx, scope: Scope, id: string, raw: unknown): Promise<PublicationView>;
// owner only; only outcome_unknown; {resolution: "published_confirmed" | "not_published", permalink?: https URL, version}
export async function resumeBlocked(tx: DbTx, scope: Scope, now: Date): Promise<number>;
// onProjectResume: blocked PROJECT_PAUSED publications whose post.scheduledAt (or claimedAt for now-posts) ≥ now − 30 min → pending + new DELIVER job; older stay blocked
export type PublicationView = { id: string; accountId: string; platform: SocialPlatform; status: string; blockedCode: string | null; lastErrorCode: string | null; externalPostId: string | null; permalink: string | null; publishedAt: string | null; resolution: string | null; test: boolean; version: number };
```
Routes: `POST /posts/:postId/cancel` (now also for `publishing`; answers `{canceled, tooLate}` with the post), `POST /publications/:publicationId/resolve` (owner, `social.approve`). `PostView` gains `publications: PublicationView[]`. `not_published` → status `failed`, `lastErrorCode "SOCIAL_NOT_PUBLISHED"`; `published_confirmed` → `published`; both refresh the post status and audit `social.publication.resolved`.

- [ ] **Step 1: Failing tests:** cancel during `publishing` with one `pending` and one `sending` publication → the pending one `canceled` (its job too), the sending one `cancel_requested`; a deliver run on `cancel_requested` before the provider call → `canceled`, no fetch; pause → the worker-side `onBlockedByPause` blocks with `PROJECT_PAUSED`; resume 10 minutes after the planned time re-enqueues, 40 minutes after keeps it blocked; editor resolve → 403; owner resolve of a `published` publication → 409 `SOCIAL_PUBLICATION_NOT_UNKNOWN`; resolve `not_published` → post `failed`; the post view lists publications with `test: true` for test publications.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement**; update the access matrix (`UPDATE_ACCESS_MATRIX=1`) and OpenAPI.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): cancel, pause handling and owner resolution of unknown outcomes`.

### Task 11: Write verification

**Files:** Create `apps/api/src/modules/social/accounts/verify-write.ts`; modify `posts/approval.ts` (action type registry), `routes.ts`, `dispatch/finish` path (capability update), `accounts/accounts.ts` view; test `apps/api/tests/social-verify-write.integration.test.ts`.

**Interfaces — produces:**
```ts
export const VERIFY_WRITE_ACTION = "social.account.verify_write";
export async function requestWriteVerification(tx: DbTx, scope: Scope, accountId: string, raw: unknown): Promise<{ requestId: string }>;
// owner (social.accounts.manage); raw {version, text (1..280 characters)}; live mode only (else 409 SOCIAL_LIVE_WRITES_DISABLED); platform enabled; account active
```
Action type: W2, `deciderRole "owner"`, no mandate, not MCP-proposable, `policyRequired false`, payload `{accountId, accountVersion, text}`, summary `{operation: {kind: "social_verify_write", platform, handle, text}}`. `onApproved` creates a post (`origin "manual"`, `originModule "social"`, `originType "write_verification"`, one variant with `text`, mode `now`, status `approved`, approved by the decider) and calls `startDelivery`. The claim lets a `write_verification` post through without `write_verified`; when its publication becomes `published` (live, not test), the account gets `capability "write_verified"`, `writeVerifiedAt`, version + 1, audit `social.account.write_verified`. Route `POST /accounts/:accountId/verify-write`.

- [ ] **Step 1: Failing tests:** in test mode the request is refused (`SOCIAL_LIVE_WRITES_DISABLED`); in live mode an owner request creates a pending W2 request; approving it creates the verification post and a dispatch job; delivering it with a fake Telegram 200 sets `write_verified`; a fake 403 leaves the account unverified and blocks; editor → 403; the type is not mandatable and not proposable.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): approved write verification per account`.

### Task 12: Re-dispatch jobs lost from Redis (platform)

**Files:** Modify `apps/worker/src/main.ts` (`processProject`), possibly extract `apps/worker/src/lost-jobs.ts`; test `apps/worker/tests/lost-job.integration.test.ts` (real worker process via `workerProcess`), keep `queue-dispatch.integration.test.ts` green.

**Interfaces — produces:**
```ts
export async function redispatchLost(tx: DbTx, scope: Scope, queues: Map<string, Queue>, now: Date): Promise<number>;
// jobs (Entity kind "jobs") with status queued|retry_scheduled whose newest Outbox row has dispatchedAt < now − 10 min,
// and whose BullMQ job (id = that outbox id) is missing or completed/failed → a new Outbox row (availableAt now); at most 20 per pass; audit-free, logs counts
```
Runs once per project pass after the outbox dispatch, only every 5 minutes per project (in-process map, like `fileCleanup`).

- [ ] **Step 1: Failing test:** start a worker, enqueue a job, let it dispatch, remove the BullMQ job (`queue.remove`) while its entity is `queued` and backdate the outbox `dispatchedAt` by 11 minutes → within one pass a new outbox row exists and the job runs to `succeeded`; a job with a live BullMQ entry is not duplicated.
- [ ] **Step 2: Run** `…/t apps/worker/tests/lost-job.integration.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it and `apps/worker/tests` — Expected: PASS.
- [ ] **Step 5: Commit** `fix(worker): re-dispatch outbox jobs lost from Redis`.

### Task 13: Web — publication status, resolution and write verification

**Files:** Modify `apps/web/src/modules/social/{api.ts, labels.ts, accounts.tsx, posts/editor.tsx, posts/posts-view.tsx, action-requests.tsx}`; create `posts/publications.tsx`; tests extend `posts/posts.test.tsx`, `accounts.test.tsx`, `action-requests.test.tsx`.

Behaviour: the post page shows a publications list (account, status, test marker, link when `permalink`, reason for `blocked`/`failed`, for `outcome_unknown` an explanation and — owners only — "It was published" / "It was not published" buttons with a confirm); `publishing` posts show "Stop remaining publications" (cancel); accounts view: owners see "Verify posting" on active, unverified accounts (opens a short form with the test text, en/de default "Orbit connection test – this post can be deleted." / "Orbit-Verbindungstest – dieser Beitrag kann gelöscht werden."), and a "Posting verified" badge; the renderer shows the verification request (platform, handle, exact text, note that it posts publicly).

- [ ] **Step 1: Failing tests:** static renders for an owner with an `outcome_unknown` publication show both resolve buttons (an editor sees none); a test publication shows "Test"; a published one links its permalink; accounts view shows "Verify posting" only to owners and only for unverified active accounts; the verification renderer shows the text and the public-post note; every button named, every input labelled; `de` texts present.
- [ ] **Step 2: Run** `…/t apps/web/src/modules/social` — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** it and the web typecheck — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): publication status, owner resolution and write verification in the web`.

### Task 14: Docs and whole-branch verification

**Files:** `docs/SOCIAL.md` (dispatch, modes, gates, throttles, reconcile, unknown outcomes, write verification, `ORBIT_SOCIAL_PLATFORMS`, operations notes), `docs/API_CONTRACT.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md` (R2, R4), `docs/OPERATIONS.md` (go-live order per platform), ADR 0020 note (Ruling 1), `docs/DEPENDENCY_RISKS.md` (SDK error bodies dropped, Graph v25.0).

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** `pnpm lint`, API and web typecheck, framework check, full `vitest run` into the workspace log, `npm run test:coolify-compose` — Expected: green except environment skips; counts in the ledger.
- [ ] **Step 3:** Revert `evals/knowledge/last-deterministic-run.json` if touched; confirm the schema hash is unchanged (`12cf3d02…`).
- [ ] **Step 4: Commit** `docs(social): S5 dispatch, modes and operations`.

## Rulings recorded with this plan

1. **Facebook is not sent in S5.** No published SDK version has a Facebook adapter (0.5.0 is the newest). S-D1's fallback (vendor a pinned upstream commit) assumes upstream has one; whether it does, and whether to vendor unreleased code or write a small own Graph adapter (`/{page-id}/feed`, `/{page-id}/photos`), is Mario's decision before S5b. Cost if wrong: Facebook pages wait one phase.
2. **Publications are created when the post is due** (`social_dispatch`), not at approval. Editing, rescheduling and canceling an approved post then only cancel one job, and the S4 rule "no publications exist before sending" stays true. Cost if wrong: none for S5; the calendar shows scheduled posts from `SocialPost` anyway.
3. **Instagram workflow state lives in `SocialProviderState`** with Orbit-side compare-and-set and a 5-minute claim, because the SDK store has neither; one workflow per publication, so a retry resumes and never creates a second container.
4. **Automatic retries only when the provider says nothing was submitted** (`after-delay`), at most 3 attempts, at least 60 s apart; X image-upload errors count as not submitted (no post was created), `/2/tweets` 5xx and network errors as unknown.
5. **The throttle values** are conservative defaults (Telegram 20/min per channel; X 6/min and 300/day per account; Instagram 50/day plus the live quota; Facebook 30/hour reserved for S5b); they live in code (`THROTTLE`) and are documented in SOCIAL.md.
6. **Health endpoint `/api/health/social` and analytics stay out of S5** (S8/S10).

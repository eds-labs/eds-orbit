# Social Module (standalone publishing, Postiz replacement) — Architecture and Migration Plan

> **For agentic workers:** this is a programme-level plan. Each phase below gets its own task-level TDD plan (`docs/superpowers/plans/<date>-social-s<N>-<name>.md`) written at phase start against the then-current `main`. Use superpowers:subagent-driven-development or superpowers:executing-plans for those phase plans.

**Goal:** A standalone `social` module that owns platform connections, social accounts, posts, media, calendar, scheduling, publication status and technical analytics, publishes directly to Instagram, Facebook Pages, X and Telegram (phase 2: LinkedIn, TikTok) without any managed publishing provider, and replaces Postiz for Marketing without losing history, audit data or approvals.

**Architecture:** A new module `apps/api/src/modules/social` with dedicated relational tables (ADR 0009 rule for modules with relational query needs), its own permissions, gate, routes, jobs, tools and web views. Platform calls go through `@opencoredev/social-sdk` direct adapters behind one Orbit-owned `SocialDispatcher`; Telegram is a custom SDK adapter over the existing Orbit Telegram connector. Timing, leases, retries and crash recovery run on the existing Orbit worker (outbox `availableAt` + `workDueAt` pump), not on a second scheduler. Marketing keeps strategy, generation and marketing approvals and calls Social only through `modules/social/contract.ts` and domain events.

**Tech stack:** TypeScript, Node 24.18, Fastify 5, Prisma 7 + PostgreSQL 17 (FORCE RLS), BullMQ 6 via the Orbit pump, zod 4, Next.js 16 + Tailwind 4 + `@dnd-kit/*` (already approved, ADR 0016 D-10), `@opencoredev/social-sdk` (MIT, zero dependencies; version decided in S-D1).

**Spec:** Mario's request of 2026-11-02 ("EDS Orbit – Eigenständiges Social-Media-Modul"), quoted requirements R1–R7 in §1.

**Baseline:** `origin/main` at `c7ed4e34` (2026-10-30). Evidence below is from static source reading of that revision plus a read-only inspection of the SDK npm tarball 0.5.0 and GitHub `main` at `d9500a7635` (2026-11-01). Nothing was executed against production, no provider was called, no dependency was installed.

---

## Global Constraints

- Planning only. This document authorizes no code, migration, dependency, flag, provider account or deployment.
- Governance: implementation is **high risk** (auth/OAuth, tenant data, migrations, background jobs with external side effects, public media URLs, external providers). Every phase plan needs risk analysis, test strategy and rollback before code (`AGENTS.md`, `.agentic/routing/risk-classification.md`). Primary app profile `fullstack-saas`, complementary `ai-agent-app` (MCP/assistant) and `web-frontend` (calendar/editor). Stack preset unchanged: `web-next-custom-postgres`.
- Human approval required before: adding `@opencoredev/social-sdk` (new production dependency); creating Meta/X/LinkedIn/TikTok developer apps or paid API tiers (new external providers, possible cost); every production migration (approved schema hash in Coolify, `scripts/check-pve-schema.sh`); every live test post; enabling any `ORBIT_SOCIAL*` flag in production; every Postiz switch-off step; any push to `main` (auto-deploys).
- No managed publishing provider: never import `@opencoredev/social-sdk/cloud/*`; enforced by a source-check rule (S1).
- Existing private Telegram agent features (owner link, `/pause`, veto Stop buttons, notifications, webhook) must behave identically; the social module never calls `setWebhook`, `deleteWebhook` or `getUpdates`.
- Existing entity kinds and tables are not renamed, moved or rewritten (ADR 0009 AD-03/04; `docs/POSTIZ_PROJECT_ASSIGNMENT_CHANGE.md:51`). Historical `publications`, `postiz_drafts`, `approvals`, `action_requests`, `AuditEvent`, `EntityVersion` rows are never updated or deleted by the migration.
- One scheduler: no BullMQ repeatable or delayed jobs, no SDK timer loops; due work is found by the Orbit pump.
- Unknown outcome is a stop condition: a send whose result is unknown is never resent automatically.
- Documentation and code comments in English; user-facing UI strings `de` + `en`.
- Next.js 16 has breaking changes: read `apps/web/node_modules/next/dist/docs/` before web work (`apps/web/AGENTS.md`).

## Review Focus

1. **Duplicate post after a crash or timeout** (worker killed between provider call and DB write; Telegram 5xx; X 503). Expect: publication becomes `outcome_unknown`, owner sees an exception, nothing is resent. Pinned by S5 tests `lease expiry while sending → outcome_unknown, no second adapter call`.
2. **Schedule at a non-existent or doubled local time** (Europe/Berlin 2027-03-28 02:30, 2026-10-25 02:30). Expect: gap → refused with the next valid time suggested; overlap → user must pick earlier/later. Pinned by S4 `schedule-time.test.ts`.
3. **Approved post changed after approval** (text edit, media swap, account added, drag to another day). Expect: approval no longer matches the package hash; post returns to `needs_approval`; dispatch refuses with `SOCIAL_APPROVAL_STALE`. Pinned by S4/S5 tests.
4. **Token expired or revoked between scheduling and due time.** Expect: refresh under a lock; if refresh fails, publication `blocked_reconnect` (no send), owner notified, account health `reconnect_required`. Pinned by S2/S5 tests.
5. **Public media URL leakage** (Instagram needs public HTTPS media). Expect: URL works only for the claimed publication, expires, is single-file, unguessable, rate-limited, not listable. Pinned by S3 tests.

---

## 1. Requirements (from the request)

| ID | Requirement | Phases |
| --- | --- | --- |
| R1 | Standalone module `social`, independent of Marketing; owns connections, accounts, posts, calendar, media, scheduling, status, technical analytics; Marketing keeps strategy/campaigns/generation/marketing approvals and publishes via Social API | S1, S4–S9 |
| R2 | Phase 1: Instagram, Facebook Pages, X, Telegram; phase 2: LinkedIn, TikTok; extensible adapters; verify real SDK adapter availability; Telegram via existing Orbit connector without breaking private agent features | S0, S2, S5, S11, S12 |
| R3 | Calendar (month/week/list), filters (account, platform, project, status, origin), drag-and-drop reschedule, preview, status; manual editor (text, images, video, multiple accounts, per-platform variants, drafts, approvals, publish now, schedule) that works without Marketing | S4, S6; video in S3b (S-D5) |
| R4 | Scheduler on existing worker; time zones, DST, leases, crash recovery, idempotency, rate limits, retries, unknown-state reconciliation, safe cancellation; evaluate SocialScheduler with PostgreSQL | S0, S5 |
| R5 | Social read/write tools in the Orbit MCP gateway; evaluate SDK MCP; no external MCP dependency; tenant/role/approval/audit rules | S7 |
| R6 | Global developer-app configuration in global admin; OAuth connections and accounts per project; tokens encrypted server-side | S2 |
| R7 | Postiz migration without loss of history/audit/approvals; new posts owned by Social; stable references from Marketing; Postiz off only after E2E success; rollback possible | S9, S10 |

## 2. Findings that shape the design

### 2.1 Social SDK reality (verified)

| Item | npm `latest` 0.5.0 (2026-09-24) | GitHub `main` d9500a7635 (unreleased; 0.6.0 PR #49 open since 2026-09-25) |
| --- | --- | --- |
| X adapter (`./x`) | yes; text, ≤4 images, video/GIF via chunked v2 upload; **Blob media only**; no native schedule | same, newer manifest |
| Instagram (`./instagram`) | yes; Graph v25; container flow; **media must be public HTTPS URLs**; no text-only; no native schedule; multi-step state in a pluggable `workflowStore` (default in-memory) | same |
| Facebook Pages | **absent** | `./facebook` (Page token, native schedule 10 min–30 days, cancel); **no Facebook OAuth provider** |
| LinkedIn / TikTok | yes (offline-tested); TikTok photos need verified-origin URLs | TikTok FILE_UPLOAD streaming added |
| Telegram | **absent** (only a `KnownPlatform` id and managed-provider mappings) | absent |
| `SocialScheduler` | **absent** | present; `runDue()` driven externally (no `setInterval`); store interface pluggable; **no PostgreSQL ScheduleStore** (KV store scans up to 10,000 entries, no due index); **scheduled media must be `https-url`/`media-ref`** while the X adapter accepts only Blob → X media posts cannot be scheduled through it |
| MCP / AI toolkit | absent | `./mcp`, `./ai`: hand-written JSON-RPC, JSON-Schema tool definitions (not zod), dry-run unless `confirmWrite` |
| OAuth / credentials | `./server`: PKCE for X, Instagram Login, LinkedIn, TikTok; `refreshOAuthToken`; `CredentialManager` with `CredentialLock`; memory stores only | adds encrypted credential store, SQL/Redis stores (tested only against an injected executor) |
| Dependencies / install scripts / telemetry | none / none / none found | same |
| Live verification | upstream marks all providers "NOT CHECKED" (offline fixtures only) | same |
| Maintenance | one maintainer, 8 releases in 3 days, then 5 weeks without release; pre-1.0 with breaking changesets pending | |

Public extension point: `defineAdapter()` (`dist/core/adapter.d.ts:121`) and `createSocial({backends})` (`dist/core/client.d.ts:138-141`), so an Orbit Telegram adapter can sit behind the same interface as the SDK adapters. Outcome model to adopt: `DeliveryOutcome` (`not-submitted | scheduled | accepted | processing | published | failed{retryDisposition} | cancelled | unknown`) and `SocialError` codes (`rate_limited`, `reconnect_required`, `ambiguous_outcome`, …).

### 2.2 Orbit reality (verified, `c7ed4e34`)

- **Modules:** `ServerModule` manifest (`packages/module-contracts/src/index.ts:70-82`) + `ModuleContributions` (`apps/api/src/platform/modules/contributions.ts:61-188`); install flag + `ProjectModule` row + `ORBIT_MODULES`; route guard in `apps/api/src/server.ts:1041-1060`; boundaries in `scripts/boundaries.json` (only module→module import allowed: a declared dependency to a `contract.ts`). Finance is the reference layout (`apps/api/src/modules/finance/`).
- **Publishing today** is entirely Postiz-shaped and lives in the generic `Entity` table (`schema.prisma:886-902`): kinds `publications`, `postiz_drafts`, `approvals`, `connectors`, `connector_verifications`, `calendar_blocks`, `channel_posts`, `jobs`, … Postiz integration ids are the channel ids in `content.channel`, `missions.channels`, `policies.channels`, `publications.channel`, `assignments.channels`, slot keys and `ConnectionGrant.settings.channels`. The Postiz connector id/version/baseUrl is inside every marketing `packageHash` (`marketing/policy/policy.ts:72-83`) → changing it invalidates open approvals and blocks scheduled publications with `PACKAGE_CHANGED`. Telegram Stop buttons embed `publicationId.version` (`marketing/agents/telegram-stop.ts:28-38`).
- **Worker:** DB-polled pump every 1.5 s over `Project.workDueAt` (`apps/worker/src/main.ts`, `due-marker.ts`), outbox rows with `availableAt`, DB job lease + `onLeaseExpired`, publication `fence` + `STALE_FENCE`, `outcome_unknown` + bounded reconciliation (`marketing/publishing/publisher.ts:200-303`). No repeatable/delayed BullMQ jobs. Gap: a dispatched job lost from Redis while `queued` is never re-dispatched (only expired running leases are recovered). Job idempotency is a linear scan (`platform/jobs/enqueue.ts:20-23`), no unique index.
- **Time:** `Intl` only, `Project.timezone` IANA; `zonedTime()` two-pass (`marketing/publishing/posting-slots.ts:32-48`); DST change-over tested, gap/overlap not tested.
- **Connections (ADR 0014):** `Connection` (scope system/workspace/project), `ConnectionSecret` (versioned, AES-256-GCM, key ring `CREDENTIAL_KEYS`), `ConnectionGrant` (purposes, modules, `settings.channels`), `ConnectionProvider` with `channelAssignment`; admin routes `/api/admin/connections`, org routes `/api/organizations/:workspaceId/connections`; `ORBIT_CONNECTIONS` on in production. Existing OAuth clients (Google Drive, GitHub knowledge) have no PKCE.
- **Telegram:** `packages/connectors/src/telegram.ts` has `sendMessage` (≤4096, previews off, no parse mode), `sendPhoto` (bytes ≤10 MB, caption ≤1024), webhook and callback methods; no media group, video, `getChat`/`getChatMember`; 10 s timeout, 1 MB response cap. The only stored Telegram credential is the owner's private bot (`Entity` kind `telegram_connections`, single `CREDENTIAL_KEY`, one webhook per token). No direct channel publishing exists; Telegram channels are published through Postiz today.
- **MCP:** one `OrbitTool` registry for assistant and MCP; tools built with `readOperation` / `approvedOperation` (`platform/tasks/operation-tools.ts`); write = ActionRequest with `approvalContext`/`revalidateContext`, 24 h TTL, idempotency key; scopes in six places (`platform/mcp/scopes.ts`, `server.ts:70-81`, `mcp-auth/plugins.ts:28-47`, `visibility.ts:224-232`, web `oauth-flow.ts`, `connect-view.tsx`); publishing/scheduling are never mandatable (ADR 0019 §10, pinned by `agent-mandates.integration.test.ts:308-344`).
- **Files:** platform `File` storage (`ORBIT_FILES`, DB or S3 backend, AES-GCM, 20 MB default / 50 MB hard limit, **no video MIME**). Marketing brand assets are base64 inside `assets` entities (≤1 MB upload).
- **Web:** `WebModule`/`ViewDef` (`apps/web/src/platform/shell/types.ts`), URL `/p/:projectId/<module>/<view>`; no calendar library; Marketing's calendar is a month-filtered list (`marketing/work.tsx:1666-1803`); `@dnd-kit` approved and used in `work/board.tsx`.

## 3. Decisions (S-D1–S-D9, decided by Mario on 2026-11-02)

| ID | Decision |
| --- | --- |
| S-D1 | As recommended: pin 0.5.0; Facebook via the first published 0.6.x, vendored pinned commit as fallback at S5 start. |
| S-D2 | As recommended: no `SocialScheduler`; Orbit worker/outbox is the only scheduler. |
| S-D3 | As recommended: a separate Telegram publishing bot per project. |
| S-D4 | As recommended: one Meta app, Facebook Login for Business (Pages + linked Instagram professional accounts). |
| S-D5 | **Deviation: no video in phase 1.** Text and images only; video (S3-compatible storage, MIME/limits, Telegram `sendVideo`, Instagram Reels, Facebook video, X chunked video) moves to phase S3b after the storage exists. |
| S-D6 | As recommended: an approval binds the scheduled time. |
| S-D7 | **Paid X API access is booked now** (by Mario, at S2 start; tier and cost confirmed in S0). X is a full phase-1 platform with real accounts. |
| S-D8 | As recommended: additive read-only mirror of Postiz history. |
| S-D9 | As recommended: `owner_each` by default; MCP writes always create an ActionRequest unless the owner opts in per project; never mandatable. |

The original options and reasons are kept below for traceability.

| ID | Question | Recommendation | Why |
| --- | --- | --- | --- |
| S-D1 | SDK version strategy | Pin **0.5.0** exactly for X/Instagram (and later LinkedIn/TikTok) and OAuth helpers. Facebook Pages: upgrade to the first published 0.6.x once released and reviewed; if not published by S5 start, vendor the MIT source at a pinned commit as workspace package `packages/social-sdk-vendor` (LICENSE, commit SHA, diff-review checklist) instead of writing our own Facebook adapter. | Released, provenance-attested code first; no parallel re-implementation of the Facebook adapter; vendoring is reviewable and reversible. |
| S-D2 | Use `SocialScheduler`? | **No, not as the source of truth.** Orbit's pump/outbox is the single scheduler; `SocialPublication` is the single state machine; the SDK is used at adapter level (`prepareTarget`, `publishTarget`, `getDelivery`, `cancelScheduled`, outcome/error model). Re-evaluate when a released SDK offers an indexed store and Blob-free X media; the dispatcher keeps the same seams (`claim`, idempotency key, `DeliveryOutcome`). | It is unreleased, has no PostgreSQL store, cannot schedule X media, and would add a second lease/claim/job state next to Orbit's — exactly the competing infrastructure the request rules out. This deviates from the stated preference; the preference's goals (durable PostgreSQL state, existing worker, one scheduler) are met. |
| S-D3 | Telegram bot for channel publishing | A **separate publishing bot per project** (bot token + channel chat id), stored as a project `Connection` provider `social.telegram`. Reusing the owner bot token is allowed only as an explicit opt-in that reads the token through a read-only accessor and never touches the webhook. | Decouples channel posting from owner link/role/disconnect (`platform/connections/telegram.ts:104-122, 181-192`) and from the single-webhook rule. |
| S-D4 | Meta login model | **One Meta app**, Facebook Login for Business: Pages + Instagram professional accounts linked to those Pages (SDK `flavor: "facebook-login"`). Instagram Login (IG-only accounts) as a later option. | One OAuth flow covers two phase-1 platforms; Page tokens are needed anyway; the SDK has no Facebook OAuth provider, so the Meta flow is Orbit code either way. |
| S-D5 | Video storage | Require `FILES_BACKEND=s3` (S3-compatible store on the PVE host) for video; images may stay on the DB backend. Social video limit 250 MB (platform caps validated per account). | Storing videos in `FileBlob` would bloat backups; Instagram/TikTok need streamable public URLs. Needs an infra decision and possibly a new service. |
| S-D6 | Does an approval bind the scheduled time? | **Yes.** Moving an approved post (also by drag-and-drop) returns it to `needs_approval`; an owner's own move is re-approved in the same confirm dialog. | Same semantics as Marketing's `content.schedule` (exact slot); no silent change of an approved publication. |
| S-D7 | X API access | Mario chooses the X API access level/cost; until then X runs only in a test project. | Paid external provider → explicit approval. |
| S-D8 | History in the Social calendar | **Additive read-only mirror** of legacy Postiz publications/drafts into Social tables (`origin = legacy_postiz`, `legacyEntityId`), source rows untouched. | Single calendar with full history, zero risk to source data, rollback = delete mirror rows. |
| S-D9 | Standalone approval policy | Per-project Social setting `approval`: `owner_each` (default: every publish/schedule by a non-owner needs owner approval; an owner's own action in the UI is its approval), or `editor_each` (an editor with `social.approve` may decide). MCP writes always create an ActionRequest unless the owner calls directly and the project enables `mcpOwnerPublishWithoutApproval` (off by default). Never mandatable. | Mirrors existing owner rules (`ownerMcpAutoApproval`) and ADR 0019 §10. |

## 4. Target architecture

```
                   ┌──────────────── apps/web ────────────────┐
                   │ modules/social: calendar, editor, media, │
                   │ accounts, approvals renderer, analytics   │
                   └───────────────┬──────────────────────────┘
                                   │ REST /api/projects/:p/social/*
┌────────────── apps/api ──────────┴───────────────────────────────────────┐
│ platform: tenancy, governance(ActionRequests), connections(ADR 0014),    │
│           files, events, links, jobs/pump, mcp gateway, audit            │
│                                                                          │
│ modules/social ─────────────────────────────────────────────────────────│
│   accounts/ (OAuth begin/callback, token vault, refresh, health)         │
│   posts/    (posts, variants, validation, approvals, schedule-time)      │
│   media/    (File-backed library, signed public URLs)                    │
│   dispatch/ (claim/fence, adapters registry, outcome mapping,            │
│              rate limiter, reconcile, cancel)                            │
│   adapters/ (sdk-x, sdk-instagram, sdk-facebook, telegram-orbit,         │
│              phase 2: sdk-linkedin, sdk-tiktok)                          │
│   analytics/, tools/ (assistant+MCP), contract.ts (Marketing API)        │
│                                                                          │
│ modules/marketing ──(contract.ts + domain events)──► modules/social      │
│   strategy, campaigns, generation, marketing approvals, veto             │
│   publishing backend switch: postiz (legacy) | social                    │
└──────────────────────────────────────────────────────────────────────────┘
          apps/worker: registry only; pump runs social jobs/scheduler
          packages/connectors/telegram.ts: extended, backward compatible
          @opencoredev/social-sdk: direct adapters only (no ./cloud/*)
```

Ownership after cutover:

| Concern | Owner |
| --- | --- |
| Developer apps (Meta, X, LinkedIn, TikTok) | Platform administration (system `Connection`s, provider ids `social.app.*`), registered by the social module |
| Project social accounts + tokens | Social (`SocialAccount` + project `Connection` `social.account.<platform>` + `ConnectionSecret`) |
| Post content, variants, media, schedule, approval of publication, delivery, status, metrics | Social |
| Campaigns, strategy, generation, marketing review/approval, veto window, assignments | Marketing |
| Link between them | `ObjectLink` `marketing.content → social.post` (relation `published_as`) + `SocialPost.origin*` columns |

## 5. Data model (new tables, migration `2026MMDD0001_social_core`)

All tables: `id uuid`, `workspaceId`, `projectId`, composite FK to `Project(workspaceId,id)`, `@@unique([projectId,id])`, `Timestamptz(3)`, FORCE RLS `project_scope` policy, grants in `scripts/db-deploy.ts`, listed in the social manifest `tables`. Append-only tables get the no-DELETE grant.

| Model | Purpose | Key fields | Constraints |
| --- | --- | --- | --- |
| `SocialAccount` | A publishable destination (IG account, FB Page, X user, Telegram channel) | `connectionId` (project `Connection`), `platform` (`instagram\|facebook\|x\|telegram\|linkedin\|tiktok`), `externalId`, `handle`, `displayName`, `avatarFileId?`, `status` (`active\|reconnect_required\|disabled`), `capability` (`configured\|read_verified\|write_verified`), `writeVerifiedAt?`, `capabilities Json` (SDK manifest snapshot), `settings Json` (default posting times `HH:MM`[], X long posts, IG post type), `legacyPostizIntegrationId?`, `version`, `disabledAt?` | unique `(projectId, platform, externalId)`; unique `(projectId, legacyPostizIntegrationId)` where not null |
| `SocialPost` | Logical post (one approval unit) | `status` (`draft\|needs_approval\|approved\|scheduled\|publishing\|published\|partially_published\|failed\|canceled\|archived`), `title?`, `scheduleMode` (`none\|at\|now`), `scheduledAt?` (UTC), `scheduleTimezone`, `scheduleLocal?` (`YYYY-MM-DDTHH:MM`), `scheduleFold?` (`earlier\|later`), `packageHash?`, `approvalRequestId?`, `approvedAt?`, `approvedBy?`, `origin` (`manual\|marketing\|mcp\|assistant\|legacy_postiz`), `originModule?`, `originType?`, `originId?`, `originVersion?`, `createdBy`, `version`, `readOnly bool` | index `(projectId, scheduledAt)`, `(projectId, status)`, `(projectId, origin)` |
| `SocialPostVariant` | Per-account content | `postId`, `accountId`, `body`, `platformOptions Json` (zod-validated per platform: X reply settings, IG `post_type`, Telegram `disableLinkPreview`, …), `contentHash`, `validation Json` (last result), `version` | unique `(postId, accountId)`; same-project FKs |
| `SocialPostMedia` | Ordered media per variant | `variantId`, `fileId` (platform `File`, moduleId `social`), `position`, `kind` (`image\|video`), `altText?`, `width?`, `height?`, `durationMs?`, `sha256` | unique `(variantId, position)` |
| `SocialPublication` | One delivery of one variant to one account | `variantId`, `accountId`, `status` (`pending\|claimed\|sending\|accepted\|processing\|published\|failed\|outcome_unknown\|cancel_requested\|canceled\|blocked`), `blockedCode?`, `idempotencyKey`, `fence?`, `attempts`, `nextAttemptAt?`, `externalPostId?`, `permalink?`, `providerState Json` (container ids, chunk upload ids — no tokens), `lastErrorCode?`, `retryDisposition?`, `publishedAt?`, `resolvedBy?`, `resolution?` (`published_confirmed\|not_published`), `legacyEntityId?`, `version` | **unique `idempotencyKey`**; unique `(projectId, legacyEntityId)` where not null; index `(projectId, status, nextAttemptAt)` |
| `SocialDeliveryAttempt` (append-only) | Every provider interaction | `publicationId`, `step` (`upload\|container\|publish\|status\|cancel\|delete`), `outcome` (`not_sent\|rejected\|unknown\|ok`), `httpStatus?`, `providerCode?`, `retryAfterMs?`, `requestHash`, `startedAt`, `finishedAt` | no body, no token, no media bytes |
| `SocialAccountThrottle` | Outbound rate limiting | `accountId`, `window` (`minute\|hour\|day`), `windowStart`, `count`, `blockedUntil?` | PK `(accountId, window, windowStart)` |
| `SocialOAuthState` | OAuth begin/callback | `stateHash`, `platform`, `appConnectionId`, `userId`, `codeVerifierCiphertext` (sealSecret), `redirectAfter`, `expiresAt` (10 min), `usedAt?` | unique `stateHash` |
| `SocialMetricSnapshot` | Technical analytics | `publicationId`, `metric`, `value numeric`, `unit`, `period`, `observedAt` | unique `(publicationId, metric, period, observedAt)` |
| `SocialProviderState` | SDK store interfaces (Instagram `workflowStore`, idempotency claims) | `namespace`, `recordKey`, `revision`, `body Json`, `leaseToken?`, `leaseExpiresAt?` | PK `(projectId, namespace, recordKey)`; compare-and-set on `revision` |

Credential storage (no new secret table): project `Connection` (`scope = project`, `provider = social.account.<platform>`, `config` = non-secret ids, granted scopes, token expiry, app connection id) + `ConnectionSecret` (sealed JSON `{accessToken, refreshToken?, pageToken?}` via `sealSecret`, key ring). Token refresh writes a new secret version and retires the old one under `SELECT … FOR UPDATE` on the `Connection` row (implements the SDK `CredentialLock`). Telegram channel: `social.account.telegram` with sealed bot token; config `{chatId, channelTitle, botUserId}`.

Developer apps: system `Connection`s `social.app.meta`, `social.app.x`, (phase 2) `social.app.linkedin`, `social.app.tiktok`; `config` = client id, API version, redirect URI, requested scopes; secret = client secret. Made available to organizations/projects through the existing `ConnectionGrant` hierarchy with `modules: ["social"]`, `purposes: ["social_oauth"]`.

Settings: `ProjectModule.settings` for `moduleId = social`: `{approval: "owner_each"|"editor_each", mcpOwnerPublishWithoutApproval: false, defaultTimezone?: null (project timezone)}`; versioned via `settingsVersion`.

## 6. Module surface

### 6.1 Server files (`apps/api/src/modules/social/`)

```
manifest.ts            id "social", version 0.1.0, defaultEnabled false, tables, permissions
contributions.ts       routes, jobs, scheduler, periodic, tools, actionTypes, connections
                       (providers), publicRoutes, linkTypes, events, attention, retention,
                       available() = ORBIT_SOCIAL, unavailableCode SOCIAL_DISABLED
gate.ts                socialSwitchedOn / socialActive / requireSocial
permissions.ts         social.read, social.compose, social.approve, social.publish,
                       social.accounts.manage, social.analytics.read
settings.ts            module settings schema + read/write
routes.ts              REST (6.2)
accounts/{oauth.ts, meta.ts, x.ts, telegram.ts, vault.ts, health.ts, providers.ts}
posts/{posts.ts, variants.ts, validation.ts, approval.ts, schedule-time.ts, package-hash.ts}
media/{library.ts, public-url.ts, probe.ts}
dispatch/{dispatcher.ts, claim.ts, outcome.ts, throttle.ts, reconcile.ts, cancel.ts, jobs.ts,
          scheduler.ts, origin-guards.ts}
adapters/{registry.ts, sdk-x.ts, sdk-instagram.ts, sdk-facebook.ts, telegram.ts,
          provider-state-store.ts, credential-lock.ts}
analytics/{collect.ts, periodic.ts}
tools/{read-tools.ts, write-tools.ts}
legacy/{postiz-mirror.ts, inventory.ts}
contract.ts            Marketing-facing API (6.4)
```

Web: `apps/web/src/modules/social/{manifest.tsx, calendar/{month.tsx, week.tsx, list.tsx, filters.tsx, dnd.tsx}, editor/{editor.tsx, variant-tabs.tsx, media-picker.tsx, preview/<platform>.tsx, schedule-field.tsx}, accounts.tsx, media.tsx, analytics.tsx, action-requests.tsx}`; admin developer-app forms contributed through `connectors.providers` in the existing admin connections page.

Boundaries: zones `module:social`, `web-module:social`; dependency `module:marketing → module:social` (contract only); source-check rule `social-no-managed-provider` forbidding `@opencoredev/social-sdk/cloud`.

Flags (`packages/config/src/index.ts`, compose files, `.env.example`, `scripts/check-coolify-compose.mjs`, PVE compose render): `ORBIT_SOCIAL` (module install switch, default false), `ORBIT_SOCIAL_PLATFORMS` (comma list, default empty → no adapter active), `ORBIT_SOCIAL_MEDIA_PUBLIC` (signed media URLs, default false). Live sends additionally require existing `ENABLE_EXTERNAL_WRITES=true` and `EXECUTION_MODE=live`; otherwise adapters run in test mode (`published_test`-equivalent: `status = published`, `externalPostId = test:<uuid>`, `providerState.test = true`), mirroring Marketing.

### 6.2 REST contract (`/api/projects/:projectId/social`)

| Method + path | Permission | Notes |
| --- | --- | --- |
| `GET /accounts` | `social.read` | health, capability, platform limits |
| `POST /accounts/connect/:platform` | `social.accounts.manage` | returns `{authorizeUrl}`; PKCE S256 + state (10 min) |
| `GET /api/social/oauth/callback` (global) | session + state owner | resolves project from state; Meta: lists Pages + linked IG accounts for selection |
| `POST /accounts/select` | `social.accounts.manage` | `{pendingId, externalIds[]}` creates `SocialAccount`s |
| `POST /accounts/telegram` | `social.accounts.manage` | `{botToken, chat}` → `getMe`, `getChat`, `getChatMember(bot)` must be admin with `can_post_messages` |
| `POST /accounts/:id/check` / `POST /accounts/:id/disconnect` / `PATCH /accounts/:id` | manage | disconnect revokes secret, keeps history |
| `POST /accounts/:id/verify-write` | owner | prepares a fixed test post → ActionRequest `social.account.verify_write` (W2) → `write_verified` |
| `GET /posts?from&to&accountIds&platforms&statuses&origins&cursor` | `social.read` | range ≤ 62 days |
| `POST /posts` / `GET /posts/:id` / `PATCH /posts/:id` (`version`) / `POST /posts/:id/archive` | compose / read | edits of approved posts reset approval |
| `POST /posts/:id/validate` | compose | per-variant SDK `prepareTarget` + Orbit rules; no network |
| `POST /posts/:id/schedule` `{at}` or `{local, timeZone, fold?}` | compose | creates ActionRequest `social.post.schedule` unless policy allows (S-D9) |
| `POST /posts/:id/publish-now` | compose | ActionRequest `social.post.publish_now` unless policy allows |
| `POST /posts/:id/reschedule` (drag-and-drop) | compose | `{version, at|local}`; approved → `needs_approval` (S-D6) |
| `POST /posts/:id/cancel` | compose (before claim) / owner (native-scheduled remote) | |
| `POST /publications/:id/resolve` `{resolution, permalink?}` | owner | only for `outcome_unknown` |
| `POST /media` (multipart) / `GET /media` / `GET /media/:id` | compose / read | |
| `GET /calendar?view=month|week|list&from&to&filters` | read | aggregated cells incl. legacy mirror |
| `GET /posts/:id/metrics` | `social.analytics.read` | |
| `GET /api/organizations/:workspaceId/social/calendar` | member of each project | cross-project view (project filter), read-only, projects with module enabled and `social.read` only |
| `GET /api/public/social/media/:token` (publicRoutes) | token | 6.6 |

Errors use the existing envelope; codes prefixed `SOCIAL_` (`SOCIAL_DISABLED`, `SOCIAL_APPROVAL_STALE`, `SOCIAL_ACCOUNT_RECONNECT_REQUIRED`, `SOCIAL_SCHEDULE_TIME_GAP`, `SOCIAL_SCHEDULE_TIME_AMBIGUOUS`, `SOCIAL_RATE_LIMITED`, `SOCIAL_OUTCOME_UNKNOWN`, `SOCIAL_VERSION_CONFLICT`, `SOCIAL_MEDIA_INVALID`, `SOCIAL_PLATFORM_DISABLED`). OpenAPI regenerated (`pnpm api:generate`).

### 6.3 Action types (ActionRequests)

| Type | Risk class | Decider | Mandatable | `approvalContext` (bound into `packageHash`) |
| --- | --- | --- | --- | --- |
| `social.post.schedule` | W2 | owner (or editor with `social.approve` under `editor_each`) | never | variant bodies, media sha256 list, account ids + capability versions, `scheduledAt`, platform options |
| `social.post.publish_now` | W2 | same | never | same without time |
| `social.post.cancel_remote` | W2 | owner | never | publication id, external id |
| `social.account.verify_write` | W2 | owner | never | fixed test package |
| `social.mcp.*` (MCP wrappers) | from tool | from tool | per 6.5 | args + context |

Revalidation at approval and again at claim: module enabled, project not paused, account `active` + `write_verified`, package hash unchanged, throttle allows, origin guard passes (6.4).

### 6.4 Marketing contract (`apps/api/src/modules/social/contract.ts`)

```ts
export type SocialAccountRef = { accountId: string; platform: SocialPlatform; handle: string;
  capability: "configured" | "read_verified" | "write_verified"; legacyPostizIntegrationId?: string };
export function socialPublishingAvailable(tx: Tx, scope: Scope): Promise<boolean>;
export function listPublishableAccounts(tx: Tx, scope: Scope): Promise<SocialAccountRef[]>;
export function validateDraft(tx: Tx, scope: Scope, input: OriginDraft): Promise<SocialValidation>;
export function submitOriginPost(tx: Tx, scope: Scope, input: OriginPostInput): Promise<{
  postId: string; publicationIds: string[]; deduplicated: boolean }>;
export function cancelOriginPost(tx: Tx, scope: Scope, postId: string,
  reason: "veto" | "pause" | "calendar_block" | "withdrawn", actor: Actor): Promise<CancelResult>;
export function originPostStatus(tx: Tx, scope: Scope, postIds: string[]): Promise<OriginPostStatus[]>;
export function recentPublishedTexts(tx: Tx, scope: Scope, accountIds: string[], days: number): Promise<string[]>;
export function postMetrics(tx: Tx, scope: Scope, postIds: string[]): Promise<SocialMetricSummary[]>;
export function registerOriginGuard(module: "marketing", guard: OriginGuard): void;
// OriginGuard = (tx, scope, p: {postId, originType, originId, originVersion, publicationId}) =>
//   Promise<{ ok: true } | { ok: false; code: string; terminal: boolean }>
```

`OriginPostInput` carries `origin {module, type, id, version}`, variants, media as `{fileId}` or `{bytes, mime, sha256}` (copied into a Social-owned `File`), `schedule {at}` or `{mode: "draft"}`, `approval: {kind: "origin_authorized", actionRequestId | approvalId, packageHash}` and `idempotencyKey`. A post submitted with `origin_authorized` is created `approved` (no second Social approval for content Marketing already approved exactly), but the Marketing origin guard is re-run in the claim transaction, so veto, pause, assignment authority, image rights and package hash checks stay with Marketing (preserves the MA-00/01 guard matrix). `mode: "draft"` replaces Postiz-draft delivery: the post lands in Social as `draft` for a human.

Events published by Social (content-free, ADR 0016): `social.post.scheduled`, `social.post.canceled`, `social.publication.published`, `social.publication.failed`, `social.publication.outcome_unknown`, `social.account.health_changed`. Marketing subscribes to update mission/content status, release slots and feed analytics. Link type `social.post` (resolve → title, status, href `/p/:p/social/posts/:id`).

### 6.5 MCP and assistant tools (`tools/`, feature `social`, scope `orbit:social`)

| Tool | Factory / risk | Permission | Notes |
| --- | --- | --- | --- |
| `social_accounts` | `readOperation` R0 | `social.read` | no tokens, health + limits |
| `social_calendar` | R0 | `social.read` | range ≤ 31 days, filters; bounded arrays (200) |
| `social_post_get` | R0 | `social.read` | variants, media metadata, publications, approval state |
| `social_post_status` | R0 | `social.read` | publication statuses, permalinks |
| `social_validate` | R0 | `social.compose` | per-variant validation, no network |
| `social_draft_create` | `approvedOperation` W0, mandatable | `social.compose` | creates `draft` |
| `social_draft_update` | W0, mandatable | `social.compose` | optimistic `version`; resets approval |
| `social_request_approval` | W0 | `social.compose` | moves to `needs_approval` (no external effect) |
| `social_schedule` | W2, never mandatable, `openWorld` | `social.publish` | `approvalContext` = 6.3 package; run creates/decides the `social.post.schedule` request (no double approval: the MCP ActionRequest **is** the schedule approval) |
| `social_publish_now` | W2, never mandatable, `mcpDirectEffect` only under S-D9 owner opt-in | `social.publish` | |
| `social_cancel` | W0 before claim; W2 for native-scheduled remote posts | `social.compose` / owner | |

Scope `orbit:social` added in all six places (§2.2) plus `MODULE_CONTENT_SCOPES`. Tests extend `mcp-proposals-contract.integration.test.ts` and the pinned mandate list (W2 social tools must never appear). SDK `./mcp` and `./ai` are **not** used (unreleased, JSON-Schema, own transport); only their tool vocabulary informs names. No new MCP dependency.

### 6.6 Media and public URLs

- **Phase 1 is images only (S-D5).** The video items in this section apply from phase S3b.
- Library on platform `File` (`moduleId: "social"`, `files.privateToModule: true`). (S3b) Extend the allow-list with `video/mp4`, `video/quicktime` (magic-byte checks), add `FILES_VIDEO_MAX_BYTES` (default 250 MB, effective only with the S3 backend; DB backend refuses video with `SOCIAL_VIDEO_REQUIRES_OBJECT_STORAGE`). Probe width/height/duration without new native dependencies (MP4 `moov/mvhd`/`tkhd` box parsing in `media/probe.ts`).
- Signed URL: `GET /api/public/social/media/:token`, token = base64url(`fileId.publicationId.exp`) + HMAC-SHA256 with a key derived from `AUTH_SECRET` via HKDF label `orbit-social-media-v1`; issued only while the publication is `claimed|sending|processing`, expiry 2 h, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`, rate limit per token and per IP, range requests for video, audit `social.media.public_served` (count only). Requires public ingress for that path (`docs/PUBLIC_INGRESS.md`), behind `ORBIT_SOCIAL_MEDIA_PUBLIC`.
- Per adapter: X and Telegram upload bytes (Blob/multipart); Instagram uses signed URLs; Facebook photos/videos upload bytes where the SDK supports it, else signed URL; TikTok (phase 2) uses FILE_UPLOAD chunking (no domain verification needed).

## 7. Scheduling and dispatch design (R4)

**Time.** Store `scheduledAt` (UTC instant) plus `scheduleTimezone` and `scheduleLocal` for display and re-validation. `posts/schedule-time.ts` converts local→UTC with `Intl` (extracting `zonedTime` from Marketing into the platform as `platform/time/zoned-time.ts`, used by both; Marketing keeps a re-export). Gap → `SOCIAL_SCHEDULE_TIME_GAP` with `suggestedAt` (first valid minute after the gap); overlap → `SOCIAL_SCHEDULE_TIME_AMBIGUOUS` unless `fold` is given. A later change of `Project.timezone` never moves stored instants; the UI shows both zones when they differ. Minimum lead time 2 minutes; maximum horizon 365 days.

**Enqueue.** Scheduling a post creates one `SocialPublication` per variant (`status = pending`, `idempotencyKey = sha256(publicationId-stable fields: postId, variantId, accountId, packageHash)`) and one outbox job per publication via `enqueue(tx, scope, "social_publish", publicationId, "social-publish:" + publicationId + ":" + post.version, availableAt = scheduledAt)`. A reschedule bumps `post.version`, cancels the superseded jobs (`canceled`), and enqueues new ones; the handler ignores a job whose key version differs from the current post version. The `social` `SchedulerContribution.nextDueAt` returns the earliest `nextAttemptAt` of retrying publications so the pump wakes the project.

**Claim (in the scoped transaction, project advisory lock already held).** `SELECT … FOR UPDATE` the publication; require `pending` (or `failed` with `retryDisposition=after-delay` and due), post `scheduled|publishing`, version match; run revalidation (6.3) and the origin guard; check and increment `SocialAccountThrottle`; set `status = claimed`, new `fence`, `attempts+1`. Any blocker sets `blocked` + `blockedCode` (pause: `PROJECT_PAUSED`, retried by the resume hook; disabled module: `MODULE_DISABLED`; reconnect: `ACCOUNT_RECONNECT_REQUIRED`).

**Send (outside the transaction).** Mark `sending` (with fence) and commit, then call the adapter: `prepareTarget` → (uploads) → `publishTarget`. Map `DeliveryOutcome`:

| SDK outcome | Orbit status | Follow-up |
| --- | --- | --- |
| `published{post}` | `published` | store `externalPostId`, fetch permalink via `posts.get` (best effort, separate job) |
| `accepted` / `processing` (IG containers, TikTok, video) | `processing` | `social_reconcile` job via `getDelivery`, backoff 15 s·2ⁿ ≤ 15 min, max 12 polls, then `outcome_unknown` |
| `scheduled` (Facebook native) | `accepted` with `providerState.nativeScheduled` | reconcile after `scheduledAt` |
| `failed{retryDisposition: after-delay}` / `rate_limited` | `failed` → retry | `nextAttemptAt = now + max(delayMs, throttle)`; max 3 automatic attempts, only when the SDK says nothing was submitted |
| `failed{after-reconnect}` / `reconnect_required` | `blocked` `ACCOUNT_RECONNECT_REQUIRED` | account → `reconnect_required`, attention + notification |
| `failed{never}` | `failed` terminal | attention item |
| `unknown` / network timeout after submit / lease expiry while `sending` | `outcome_unknown` | reconcile where the platform can read back: SDK `getDelivery` with the stored provider ids, else a bounded read of the account's posts in `[claimedAt − 5 min, claimedAt + 30 min]` matched by `contentHash` (X, Instagram, Facebook); Telegram cannot read back → owner resolves; never resend |

Every provider call writes a `SocialDeliveryAttempt`. Result writes check the fence (`SOCIAL_STALE_FENCE`). `onLeaseExpired` for `social_publish` → `outcome_unknown` (copy of `marketing/jobs.ts:42-51` semantics).

**Rate limits.** `throttle.ts` holds per-platform defaults (Telegram: ≤20 posts/min per channel, 1 s spacing; Instagram: read `content_publishing_limit` before publishing and block above the quota; X/Facebook: honour `Retry-After` / `x-rate-limit-reset` from `SocialError`), stored in `SocialAccountThrottle`; values verified in S0 against current platform docs and recorded in `docs/SOCIAL.md`.

**Cancellation.** `pending|blocked` → `canceled` immediately (job becomes a no-op). `claimed|sending` → `cancel_requested`; the dispatcher checks it before the provider call; after the call the outcome wins and the UI says "already sent". Facebook native-scheduled → `social.post.cancel_remote` (owner) → SDK `cancelScheduled` → `canceled` only on provider confirmation. Published posts are never deleted by cancel (deletion is a separate, later, owner-only feature, out of scope for phase 1).

**Recovery.** Lost Redis job while `queued`: S5 adds a platform fix — the pump re-dispatches outbox-backed jobs that are `queued|retry_scheduled` and older than 10 minutes without a BullMQ entry (generic, with its own regression test), benefiting all modules. Restart mid-IG-flow: `SocialProviderState` (SDK `workflowStore` on PostgreSQL with compare-and-set) lets the next attempt resume the container instead of creating a second one.

**Pause / disable.** Project pause → claims block with `PROJECT_PAUSED`; resume hook re-enqueues due blocked publications that are still inside a 30-minute late window, later ones need a human reschedule (no surprise late posts). Module disabled → `MODULE_DISABLED`, nothing sent, data kept.

## 8. Telegram (R2)

- Extend `packages/connectors/src/telegram.ts` additively: `getMe`, `getChat`, `getChatMember`, `sendMediaGroup` (2–10 photos/videos, caption on first item), `sendVideo` (≤50 MB bot API upload limit; larger → `SOCIAL_MEDIA_INVALID`), optional `parseMode` (`HTML`, sanitised) and `disableLinkPreview` (default unchanged: true) on `sendMessage`; a per-call `timeoutMs` override (uploads up to 120 s) and response cap unchanged. Existing signatures and tests stay green; new tests per method including token redaction.
- `adapters/telegram.ts` implements the SDK `SocialAdapter` via `defineAdapter` (`id: "telegram"`): `prepareTarget` (lengths 4096 / caption 1024, media count, sizes), `publishTarget` → `published{postId: message_id}`; `getDelivery` returns `unknown` (no read-back). Permalink `https://t.me/<username>/<message_id>` for public channels.
- Isolation: different `Connection` provider, no access to `telegram_connections` entities, no webhook calls (unit test asserts the adapter's client never calls `setWebhook`/`deleteWebhook`); regression run of the existing Telegram suites (`telegram*.test.ts`, owner link, `/pause`, Stop button) in every phase that touches the connector.

## 9. Postiz migration (R7)

### 9.1 Principles

1. Postiz stays the live path for every project until that project's Social cutover passes E2E acceptance.
2. No double sending: a destination is driven by exactly one backend at any time (per-project marketing setting `publishingBackend: postiz|social`, default `postiz`).
3. Source data is never rewritten; Social mirrors history additively.
4. Every step has a documented rollback; the Postiz code path is removed only after a stable period and a separate approval.

### 9.2 Inventory (S10, read-only script `legacy/inventory.ts`, run by Mario in the container)

Per project: counts by kind/status for `publications`, `postiz_drafts`, `approvals`, `action_requests` of types `content.schedule`/`marketing.mcp.*`, `connectors` (Postiz fields), `assignments`/`policies`/`missions` referencing Postiz integration ids, `calendar_blocks`, `channel_posts`, open exceptions with `POSTIZ_*` codes, central `ConnectionGrant.settings.channels`. Output: JSON report without bodies or tokens, stored as evidence.

### 9.3 Mapping

`legacyPostizIntegrationId → SocialAccount` per project, proposed automatically by platform + handle from the Postiz integration list, confirmed by the owner in the UI (`POST /legacy/mapping`). Mapping table is the `SocialAccount.legacyPostizIntegrationId` column; unmapped integrations stay Postiz-only.

### 9.4 History mirror

Idempotent backfill `legacy/postiz-mirror.ts`: for each legacy `publications` / `postiz_drafts` row create `SocialPost(origin=legacy_postiz, readOnly=true)` + variant + `SocialPublication(legacyEntityId, externalPostId=remoteId, permalink=releaseUrl, status mapped)` and an `ObjectLink legacy.publication → social.post (mirrors)`. Re-run updates mirrors from the source (source wins), never the reverse. Bodies are copied from the referenced `content` version. Dry-run mode prints counts; verification compares counts per status. Rollback: delete rows where `origin = legacy_postiz` (owner approval; source unaffected).

### 9.5 Marketing switch-over (code, S9)

- `marketing/publishing/backend.ts`: `publishingBackend(tx, scope)` reads the marketing module setting; `publishIntent`, owner release, package schedule, assignment delivery and veto call either the existing Postiz path or `social/contract.ts`.
- `packageFor` for the social backend binds `{backend: "social", accountId, accountVersion, connectionId, capability}` instead of the Postiz connector fields; Postiz projects keep the old hash input (no hash change for them).
- Assignment delivery values: add `social` and `social_draft` next to `publish` and `postiz_draft` (schema enum in `packages/schemas/src/marketing-plan.ts`); confirmation hash changes only for assignments that switch.
- Channel references: new marketing records for social projects store `social:<accountId>`; legacy raw Postiz ids remain valid for Postiz projects; a single resolver `marketingChannel(ref)` handles both.
- Duplicate check (`DUPLICATE_CONTENT`) and analytics (`postiz_analytics` tool, specialist inputs) read from `recentPublishedTexts` / `postMetrics` for social projects.
- Telegram Stop: new buttons `sstop:<socialPublicationId>.<version>.<mac>` routed to Marketing's veto → `cancelOriginPost`; legacy `stop:` handler unchanged until no legacy publication is withdrawable.
- Channel rules move to `social/posts/validation.ts` (single source); Marketing's `channel-rules.ts` remains for the Postiz path until removal.

### 9.6 Per-project cutover runbook (each step needs Mario's go)

1. Social module enabled for the project; accounts connected for every mapped destination; each account `write_verified` through one approved real test post (or a test channel for Telegram).
2. Manual E2E in Social (no Marketing): one post per platform with image, one scheduled across a DST-neutral boundary, one cancel, one reschedule by drag-and-drop; MCP read + draft + schedule request; evidence recorded.
3. Marketing E2E on the project: one assignment slot delivered with `social_draft`, released by the owner, published; veto Stop tested on a scheduled post.
4. Freeze: set `publishingBackend: postiz_draining` → Marketing refuses new Postiz intents (`PUBLISHING_BACKEND_DRAINING`), existing Postiz items finish and reconcile; precondition for the switch: zero legacy publications in `sending|scheduled_remote|outcome_unknown|reconciliation_required|cancellation_required` and zero `postiz_drafts` in `sending|outcome_unknown` (inventory proves it).
5. Switch: owner-confirmed policy + assignment changes to Social accounts (normal confirmation flow, new hashes); `publishingBackend: social`.
6. Watch the next 3 slots and the attention list; record evidence in `docs/IMPLEMENTATION_STATUS.md`.

Rollback per project (any time after step 5): `publishingBackend: postiz` + confirmed policy/assignment change back to the mapped legacy ids; Social publications not yet claimed are `canceled` with reason `rollback`; any in `sending|outcome_unknown` are resolved first (never re-sent through Postiz blindly).

### 9.7 Postiz decommissioning (after all projects switched and 30 days without Social incident)

1. `ENABLE_POSTIZ_DRAFTS=false`; Postiz queue-watch periodic disabled by flag; Postiz `Connection`s/connectors `disabledAt` set (not deleted).
2. Keep the Postiz code path for one release cycle as rollback.
3. Separate approved PR removes Postiz runtime code, keeping read-only legacy views (mirror) and the inventory script; docs updated.
4. Shutting down the Postiz instance is an infrastructure action by Mario outside this repo.

## 10. Phases

Dependencies: S0 → S1 → S2 → {S3, S4} → S5 → {S6, S7, S8} → S9 → S10 → S11/S12 (S11/S12 can start after S5; S3b after S5 once storage exists). Each phase ends with green `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, docs updated, flags off, and (for migrations) the new schema hash printed for approval.

### S0 — Decisions, ADR, verification spike (docs + throw-away spike branch)

- ADR `docs/adr/0020-social-module.md` recording §3 decisions, alternatives (SocialScheduler, managed providers, own adapters, Postiz retained) and consequences.
- Spike in a worktree (not merged): install the pinned SDK, import each direct entry under Node 24/tsx, run its offline `./testing` mock backend against X/IG adapters, confirm ESM interop and bundle exclusion of `./cloud/*`; record exact API signatures used by the dispatcher.
- Verify current platform constraints from official docs (Meta app review for `instagram_content_publish`/`pages_manage_posts` and dev-mode limits, IG publishing quota, X tier limits, Telegram limits, LinkedIn Community Management approval, TikTok unaudited-app private-only rule) → `docs/SOCIAL.md` "Platform constraints".
- Acceptance: Mario has answered S-D1–S-D9; ADR accepted; dependency approval given or plan adjusted.

### S1 — Module skeleton, data model, gate (no platform calls)

- Manifest, contributions, gate, permissions, settings, empty routes, web manifest with views `calendar`, `posts`, `media`, `accounts`, `analytics` (nav group, `optIn: true`).
- Migration `social_core` (all §5 tables, RLS, grants, append-only grant for `SocialDeliveryAttempt`), `db-deploy.ts` table list, boundaries zones + `social-no-managed-provider` rule, flags in config/compose/env/check scripts.
- Tests: `social-module.test.ts` (manifest/registry validation), `module-registry`, `module-contributions`, `module-enforcement`, `access-matrix`, `rls-matrix` (cross-project reads of every social table fail), `social-gate.integration.test.ts` (flag off → 404 `SOCIAL_DISABLED`; module row off → refused).
- Acceptance: module invisible with `ORBIT_SOCIAL=false`; enabling per project shows empty views; no change in any existing test.

### S2 — Developer apps, OAuth, token vault, accounts, Telegram connection

- Providers `social.app.meta`, `social.app.x` (system scope; admin UI through existing connections admin), `social.account.{instagram,facebook,x,telegram}` (project scope).
- OAuth: `SocialOAuthState` with PKCE S256 for X; Meta Facebook Login for Business (Page list + linked IG accounts; long-lived user token → Page tokens); callback route; account selection; SDK `refreshOAuthToken` behind `credential-lock.ts` (row lock + new `ConnectionSecret` version); health check (`read_verified` via account read) and `reconnect_required` handling; disconnect.
- Telegram: connector extensions (§8) and channel connection flow.
- Tests: `social-oauth.integration.test.ts` (state single-use, expiry, wrong user, PKCE verifier sealed, project from state must match membership), `social-token-refresh.integration.test.ts` (two concurrent refreshes → one provider refresh, one new secret version), `telegram.test.ts` additions, `social-telegram-account.integration.test.ts` (bot not admin → refused; owner bot untouched; no webhook call), secret never in responses/logs/audit.
- Acceptance: with test apps, an owner connects an X account, a FB Page + linked IG account and a Telegram channel in a test project; tokens only as ciphertext; existing Telegram owner-bot suites unchanged.

### S3 — Media library and public media URLs (images)

- `media/library.ts` (png, jpeg, webp; platform limits per account), `probe.ts` (image dimensions), `public-url.ts` (publicRoutes), per-platform media validation hooks.
- Tests: magic-byte refusal, video MIME refused with `SOCIAL_VIDEO_NOT_AVAILABLE`, token tamper/expiry/foreign publication/after terminal status → 404, no listing, rate limit, `rls-matrix` for `File` with moduleId social.
- Acceptance: image upload in a test project; signed URL fetchable only during a claimed publication.

### S3b — Video (after S-D5 storage exists; can run after S5)

- S3-compatible storage on the PVE host (infra decision and approval), `FILES_BACKEND=s3` for social video, video MIME + `FILES_VIDEO_MAX_BYTES`, MP4 probing, range requests on the public URL, Telegram `sendVideo`, Instagram Reels, Facebook video (SDK), X chunked video, editor video picker and previews.
- Tests: video on DB backend refused, range requests, per-platform duration/size limits, chunked-upload resume after crash.

### S4 — Posts, variants, validation, approvals, schedule time (no sending)

- Post/variant/media CRUD with versions; validation through SDK `prepareTarget` + Telegram adapter; `package-hash.ts`; ActionRequest types §6.3 with web approval renderer (`action-requests.tsx`, per-variant preview); approval policy S-D9; schedule-time module with gap/overlap handling; editor UI (text, media picker, multi-account, variant tabs inheriting from a base text, live per-platform preview and limits, save draft, request approval, schedule, publish now).
- Tests: `schedule-time.test.ts` (Europe/Berlin spring gap 2027-03-28 02:30 → suggested 03:00; autumn overlap 2026-10-25 02:30 with/without `fold`; America/New_York; UTC), `social-posts.integration.test.ts` (version conflicts, edit after approval resets, drag of approved post → `needs_approval`, editor cannot self-approve under `owner_each`), web component tests for editor validation and accessibility (keyboard, labels).
- Acceptance: a non-owner drafts a multi-account post with per-platform variants and image; owner approves exactly that package in Decisions; nothing is sent.

### S5 — Dispatcher, worker jobs, adapters, write verification

- Queue classes `social_publish` (concurrency 2, lease 180 s), `social_reconcile`, `social_permalink`; scheduler contribution; claim/fence; outcome mapping; throttle; cancel; resume hook; `SocialProviderState` store for the IG workflow; adapters X, Instagram, Telegram (Facebook per S-D1); test mode without external writes; account write verification flow; platform fix for lost queued jobs.
- Tests (fake SDK backend from `./testing` + fake Telegram fetch): exactly-once on duplicate job delivery; lease expiry while sending → `outcome_unknown` and no second call; `rate_limited` → `nextAttemptAt` honours `Retry-After`; reconnect → `blocked`; pause/resume window; module disabled; reschedule supersedes old job; cancel before claim / during send / after publish; IG resume after crash reuses the container; X media via Blob, IG via signed URL; per-account throttle across two posts; `worker-lost-job.integration.test.ts` for the pump fix.
- Acceptance: in a test project with test accounts and live writes enabled only there (Mario's approval per account), one approved post per platform publishes; one forced timeout ends in `outcome_unknown` and is resolved by the owner; no duplicate.

### S6 — Calendar UI

- Month grid, week (time grid, 30-minute rows, project timezone), list (virtualised, cursor paging); filters account/platform/status/origin and, on the organization view, project; drag-and-drop with `@dnd-kit` (keyboard alternative: "Move to…" dialog) calling `reschedule` with version and showing the S-D6 confirmation; post preview drawer; status badges incl. legacy mirror and `outcome_unknown`; empty/error/loading states; `de`/`en`.
- Tests: component tests (filters, DST week rendering, drop → request payload, conflict message), Playwright `social-calendar.spec.ts` (create → schedule → move → approve), accessibility check (axe in Playwright, keyboard-only reschedule).
- Acceptance: R3 complete with `ORBIT_MARKETING` disabled for the project.

### S7 — MCP and assistant tools

- Tools §6.5, feature `social`, scope `orbit:social` in all six places, approval renderers reuse S4.
- Tests: `social-mcp.integration.test.ts` (service-level: visibility by role/module/scope, tenant isolation, idempotency conflict, W2 never auto-approved, schedule approval executes once, output schemas bounded), gateway HTTP test for scope step-up, updated pinned proposable/mandatable lists.
- Acceptance: ChatGPT (read-only grant) lists accounts and calendar; a propose grant creates a schedule request that the owner approves in Orbit.

### S8 — Technical analytics

- Periodic task `social-metrics` (every 6 h, posts ≤ 30 days old, ≤ 50 calls per project per run), SDK metrics per platform (Telegram: none available via Bot API, shown as "not available"), `SocialMetricSnapshot`, post metrics panel, `postMetrics` contract.
- Tests: bounded calls, provider error isolation, no metrics for test-mode posts.

### S9 — Marketing integration

- Everything in §9.5 behind the per-project `publishingBackend` setting (default `postiz`, so no behaviour change on deploy); events subscription; origin guard registration.
- Tests: re-run and extend the MA-00/01 dispatch guard matrix for the social backend (owner/module/policy/assignment/image/schedule invalidation), `assignment-social-drafts.integration.test.ts`, veto via `sstop:`, hash unchanged for Postiz projects (pinned), duplicate check and analytics via contract, boundary check (Marketing imports only `social/contract.ts`).
- Acceptance: in the test project, a Marketing assignment publishes through Social end to end; Postiz projects are byte-identical in behaviour (existing suites green).

### S10 — Postiz migration and decommissioning

- Inventory script, mapping UI, history mirror, `postiz_draining` mode, runbook `docs/SOCIAL_POSTIZ_MIGRATION.md`, evidence template; then §9.6 per project (uLiquid, FamilyPlan, others) and §9.7.
- Tests: mirror idempotency and status mapping, draining refuses new Postiz intents but completes existing ones, rollback path test (switch back, unclaimed social publications canceled, no Postiz resend).
- Acceptance: per project evidence of steps 1–6; after decommission, no Postiz call in 30 days of logs; rollback documented and rehearsed once in the test project.

### S11 — LinkedIn (phase 2) / S12 — TikTok (phase 2)

- Developer app providers, OAuth via SDK `linkedinOAuth`/`tiktokOAuth`, adapters, platform options (LinkedIn author member/organization, document posts; TikTok privacy level, direct post vs draft), media paths (TikTok FILE_UPLOAD), throttle defaults, editor previews, analytics.
- Gated on platform approvals (LinkedIn Community Management API; TikTok app audit — unaudited apps post private only).
- Tests as in S5 per adapter; acceptance: one verified post per platform in a test account.

### Size indication (relative, for sequencing only)

S0 S · S1 M · S2 L · S3 M · S4 L · S5 XL · S6 L · S7 M · S8 S · S9 L · S10 M (+ operational time) · S11 M · S12 M.

## 11. Security, privacy, operations

- Tokens: sealed with the connection key ring, never returned, never logged; audit/system-audit entries carry ids and codes only; `SocialDeliveryAttempt` has no bodies.
- OAuth: PKCE where the platform supports it, state single-use and user-bound, redirect URI fixed per app, HTTPS only, SSRF-safe transport for all provider calls (reuse `boundedFetch` as the SDK `fetch` where the SDK accepts an injected fetch; otherwise document the exception in the ADR).
- Public media endpoint is the only new public ingress path; threat model in the S3 plan (enumeration, hot-linking, replay after cancel, large range abuse).
- Personal data: account handles and avatars of the project's own accounts; no follower data stored; metrics aggregate only. Retention contribution: delivery attempts 24 months, metrics 24 months, OAuth states 1 day.
- Observability: `/api/health/social` (adapters enabled, accounts needing reconnect, oldest due-but-unclaimed publication, unknown outcomes) replacing `/api/health/postiz` after decommissioning; attention items for `outcome_unknown`, `reconnect_required`, `blocked`; notifications through the existing notify pipeline.
- Cost: no AI spend in Social; X API tier cost (S-D7) recorded in `docs/OPERATIONS.md`.

## 12. Documentation deliverables

`docs/adr/0020-social-module.md`, `docs/SOCIAL.md` (module, platform constraints, limits, operations), `docs/SOCIAL_POSTIZ_MIGRATION.md` (runbook + evidence), `docs/API_CONTRACT.md` and OpenAPI, `docs/MODULE_ACTIVATION.md`, `docs/MCP_2_0.md` (social tools, scope), `docs/CONNECTOR_CAPABILITIES.md` (direct adapters replace Postiz rows), `docs/IMPLEMENTATION_STATUS.md` and `docs/REQUIREMENTS_TRACEABILITY.md` per phase.

## 13. Open risks

- **SDK maturity:** single maintainer, unreleased features, no live verification upstream. Mitigation: pin exact version, wrap behind `adapters/registry.ts`, our own live write verification per account, vendoring fallback (S-D1).
- **Platform approvals and cost** (Meta app review, X tier, LinkedIn/TikTok audits) can delay phases independently of code. Mitigation: S0 verification; test projects with app-role accounts.
- **Marketing coupling:** 117 API files reference Postiz; the backend switch must keep Postiz projects unchanged. Mitigation: per-project setting, pinned hash tests, existing suites.
- **Public media URLs** add an internet-facing path. Mitigation: flag, short-lived HMAC tokens, ingress limited to one route.
- **Video storage** needs S3-compatible storage on the PVE host (S-D5).
- **Telegram unknown outcomes** cannot be reconciled automatically; owner resolution UI is mandatory.

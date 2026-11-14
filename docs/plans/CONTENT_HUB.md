# Content Hub and SEO publishing: architecture review and implementation plan

Status: proposed, 2026-11-14 (plan only). Mario answered E-1 to E-4 on 2026-11-14. Decision record: [ADR 0029](../adr/0029-content-module.md). Baseline `main` at `f3885898`. Nothing is implemented; every migration, dependency pin, flag, website change and production step needs its own approval.

Scope: phase 1 (Orbit Content Hub and API), phase 2 (website integration) and phase 4 (AI SEO workflow). Phase 3 (external CMS such as WordPress) is deferred; only its extension points are part of phase 1.

## 0. Context and classification

**Why.** Blog articles are written outside Orbit or end as Markdown in Google Drive. The three websites keep articles as code (TypeScript arrays or JSON) and need a commit and a deploy for every article. Orbit should become the central, tenant-isolated source for articles (later FAQs, help docs, changelogs, product information); agents create and update through the same service; websites render under their own domain without new commits.

**Classification (AGENTS.md).**
- Risk: **high** (new tables and RLS, new machine authentication, a public API, outbound webhooks, a new web dependency). Production steps (schema hash, flags, DNS) are approved one by one.
- Environment: implementation `local` (own worktree test database); delivery per work package to `main` (production deploy on coolify-pve) only with Mario's approval.
- App profiles: primary `fullstack-saas`; also `backend-api` (v1 API, webhooks), `web-frontend` (editor), `ai-agent-app` (phase 4).
- Workflows: `feature.md`, `migration.md`, later `release.md`. Stack preset: the existing stack, no change.

**Decisions by Mario (2026-11-14).**
- E-1 Website rendering (ISR or rebuild) is decided later in a separate step → the Orbit API and publishing support both.
- E-2 Hosting of EDS Labs and uLiquid: decided after the FamilyPlan pilot.
- E-3 Editor: TipTap with Orbit's own versioned block JSON.
- E-4 Publishing and updates are approved by the owner or a content editor (`W2`, never under a mandate).

## 1. Current state (evidence)

### 1.1 Present and reusable

| Area | State | Evidence |
| --- | --- | --- |
| Module system | Manifest (`id`, `tables`, `permissions`, `entityKinds`), registry validation, contributions for routes, jobs, scheduler, action types, tools, public routes, events, link types, handoffs, attention, retention | `packages/module-contracts/src/index.ts:70-255`, `apps/api/src/modules/registry.ts:35-95`, `apps/api/src/platform/modules/contributions.ts:76-234` |
| Template for an independent publishing module | Social: own tables, `contract.ts` for Marketing, `W2` approval with package hash, outbox dispatch, fence, `outcome_unknown` never resent, reconciliation | ADR 0020, `apps/api/src/modules/social/contract.ts:246`, `social/dispatch/*.ts`, `social/posts/approval.ts` |
| Activation and roles | `ProjectModule` (opt-in), `assertModuleEnabled`, module roles editor/viewer/none | `packages/db/prisma/schema.prisma:168-184`, `platform/modules/enforcement.ts`, `platform/tenancy/module-roles.ts` |
| Tenant isolation | `scoped()` sets `app.workspace_id`/`app.project_id`, FORCE RLS, composite tenant FKs, grants in `db-deploy.ts`, RLS matrix test | `packages/db/src/index.ts:62-131`, `migrations/202611080001_ads_core/migration.sql`, `scripts/db-deploy.ts` lines 131-385, `apps/api/tests/rls-matrix.integration.test.ts` |
| Approvals | ActionRequests with `revalidate`, `onApproved`, `consumeActionRequest`; `deciderRole: "editor"`, `inbox: "editors"` and `mayDecide` already exist (Work uses them) | `platform/governance/action-requests.ts:162-210, 578-600, 936-951`; ADR 0008; ADR 0019 §10 |
| Jobs and time | Outbox enqueue with idempotency key and `availableAt`, scheduler and periodic contributions, DST-safe zoned time | `platform/jobs/enqueue.ts:11-46`, `platform/jobs/types.ts`, `platform/time/zoned-time.ts` |
| Files and media | Encrypted platform files (S3 or DB), signed public media URLs (Social), AI image label publish gate, `sharp` available | `platform/files/files.ts`, `social/media/public-url.ts`, `platform/provenance/image-provenance.ts:433`, `packages/creative/package.json` |
| Public endpoints | `PublicClientKey` (identifier, origin allowlist, sessions, rate limits), used by the Support widget only; requests without `Origin` pass | `platform/http/public-api.ts:70-95` |
| Outbound HTTP | `boundedFetch` (HTTPS, public IPs only, DNS pinning, timeouts, size caps); HMAC scheme `X-Orbit-Signature: v1=` | `packages/connectors/src/http.ts`, `platform/automation/workflows.ts:60-62,191-200` |
| Secrets | Connections and `ConnectionSecret` (versioned, encrypted, grants, `managedByModule`) | `platform/connections/project-secrets.ts`, ADR 0014 |
| REST conventions | Errors `{error:{code,message,detail}}`, keyset pagination `{items,nextCursor}`, OpenAPI via `pnpm api:generate`, global rate limit 600 reads/100 writes per minute | `apps/api/src/server.ts:356-509`, `apps/api/src/openapi.ts`, `social/posts/posts.ts:357-420` |
| MCP | OAuth gateway, closed scope list, `OrbitTool` with `exposure.mcp`, proposals become ActionRequests | `platform/mcp-auth/plugins.ts:27-50`, `platform/mcp/scopes.ts`, `platform/agents/tools/registry.ts:88-185` |
| Marketing AI | Assignments (content type `blog` exists), run DAG research → strategy → copywriter → review, facts/evidence/claims checks, duplicate and novelty checks, image generation (1200×630 format), `runStructured`, budgets and reservations | `marketing/agents/assignments.ts:145-241`, `assignment-runs.ts:165-233`, `policy/fact-claims.ts`, `pipeline/draft-similarity.ts`, `platform/agents/structured-run.ts`, `platform/ai/budget.ts` |
| Analytics | Matomo import including `Actions.getPageUrls`, twice daily | `marketing/analytics/matomo.ts:46-64`, `matomo-schedule.ts` |
| Work | Handoff registry, ObjectLinks, domain events | `platform/handoffs/handoffs.ts:47-80`, `modules/work/issue-handoff.ts` |

### 1.2 Missing

1. **No article or revision model.** Blog is an `Entity` draft (body at most 40,000 characters, no SEO fields); approved blogs only reach Drive; publishing is refused (`owner-release.ts:146`, `veto.ts:252-260`, blocker `BLOG_TARGET_NOT_CONFIGURED`).
2. **No machine API keys** (only session cookies and MCP OAuth), **no `/api/v1`**, generic OpenAPI responses, global `Cache-Control: no-store` (`server.ts:380`), no ETag, no `Idempotency-Key` header.
3. **No outbound webhook system** (endpoints, secrets, delivery log, retries, replay, auto-disable).
4. **No rich-text editor**, no web sanitizer; `sanitize-html` is only used server-side for text extraction.
5. **No Search Console**, no keyword or ranking data; `draft_blog` defaults to 1,800 output tokens; copy and quality checks are social-oriented; blog assignments need a placeholder channel.
6. **Work** has no generic handoff target for editorial tasks (`task_from_issue` accepts issues only; `TASK_SOURCES` is closed).
7. **Leftover:** branch `claude/uliquid-blog-publishing-c9a252` (GitHub PR delivery, 18 commits, 2026-10-12) is not merged and 1,504 commits behind `main` on the old layout. It is superseded; only the uLiquid validator rules are carried over as a site content rule.

### 1.3 Websites (local repositories inspected)

| | FamilyPlan (pilot) | EDS Labs | uLiquid |
| --- | --- | --- | --- |
| Repository | `eds-labs/FamilyPlan` → `apps/web` (marketing site, web app and admin in one Next app) | `eds-labs/eds-labs-website` | `eds-labs/uliquid-desk-website-v2` (`workspace/site-v2`) |
| Next.js | 15.5.22, App Router, `output: "export"` | 15.5.22, `output: "export"` | 16.3.3, `output: "export"` |
| Hosting | Coolify (Docker → static nginx, auto-deploy on `main`) | Hostinger static | Hostinger (git build, static `out`) |
| Blog data | TS array `lib/blog-posts.ts` (3 de + 3 en) | TS array `lib/blog-content.ts` (~25 + ~25) | one JSON per post + validator `content/blog/blog-posts.mjs` (2, en only) |
| Languages | de (no prefix) + `/en`, `alternateSlug` | `/de` + `/en`, `translationSlug` | en only |
| SEO | metadata, canonical, hreflang, sitemap, JSON-LD BlogPosting/FAQ/Breadcrumb, no RSS | same, no RSS; CSP blocks external images and fetch | metadata, JSON-LD, sitemap without lastmod, no RSS |
| Matomo | site 2 (consent) | none | site 1 (consent) |
| Notes | The website's AGENTS.md forbids route handlers and SSR until a hosting change is ordered; the live container holds two hotfixes not merged to `main` (a rebuild from `main` would revert them) | deploy mechanism undocumented | validator rules (forbidden phrases, plain text) |

Not verified: Search Console setup of FamilyPlan and uLiquid, Node support of the Hostinger plans, a Hostinger redeploy webhook, build times.

## 2. Architecture

### 2.1 Core decision

A new opt-in product module **`cms`** (display name "Content"), built on the Social pattern, plus **three small generic platform capabilities** that do not exist yet and serve other modules too. No external CMS or SaaS.

- **Module id `cms`**, not `content` (already a Marketing entity kind, a tool namespace, the prefix of `content.schedule` and a forbidden literal in `package:knowledge`, `scripts/boundaries.json` lines 155-161). Tables `Cms*`, permissions `cms.*`, flag `ORBIT_CMS`, MCP scope `orbit:cms`.
- **Independent of Marketing.** `cms` imports no module; Marketing (later Support, Knowledge) uses `modules/cms/contract.ts` and domain events; `boundaries.json` gains `module:marketing → module:cms`.
- **Headless pull by default.** Publishing atomically switches `publishedRevisionId` in Orbit. Websites read through the delivery API; Orbit notifies them by signed webhook (ISR revalidation) or triggers a rebuild (Coolify deploy API or GitHub `repository_dispatch`). Both answers to E-1 work without changing Orbit, and the publish step has no ambiguous external outcome.
- **Push adapters** (WordPress and others, phase 3) attach to the same publication state machine through an adapter registry, as `SocialSender` does in Social.

### 2.2 Building blocks

```
platform/api-keys        (new)  project-bound, hashed API keys with module scopes
platform/http/v1         (new)  /api/v1 frame: auth, errors, pagination, ETag/cache, Idempotency-Key, OpenAPI v1
platform/webhooks        (new)  outbound webhooks: endpoints, v1 signature + rotation, retry/backoff, log, replay
packages/content-doc     (new)  orbit-doc-v1: schema, validation, HTML/text renderer, TOC, TipTap mapping (pure)
modules/cms              (new)  entries, revisions, taxonomies, authors, assets, sites, publications, redirects,
                                approval actions, delivery/management API, MCP tools, contract.ts, adapter registry
apps/web/src/modules/cms (new)  overview, list, TipTap editor, media, taxonomies, history, calendar, settings sections
modules/marketing        (ext.) SEO editorial work (phase 4): research, clusters, briefs, generation, review → cms contract
modules/work             (ext.) handoff target work.task_from_editorial
```

### 2.3 Data flow

```
Editor/agent/API/MCP ──► CmsDraft (working copy, optimistic version)
        │ "Submit" / "Schedule"
        ▼
CmsRevision (immutable, contentHash) ──► ActionRequest cms.entry.publish (W2)
        │ owner or content editor decides (revalidate: hash, sites, time)
        ▼ onApproved
CmsPublication per site (queued, availableAt = scheduledAt) ──► worker cms_publish
        │ claim + fence + preflight (hash, alt texts, AI label, evidence, slug, module on, project not paused)
        ▼
switch publishedRevisionId + redirects ──► domain event cms.entry.published
        ├─► platform/webhooks: signed POST to the site (revalidation tags) ─┐
        ├─► optional rebuild notifier (Coolify / GitHub dispatch)          ├─► live check (GET canonical URL, <meta orbit-revision>)
        └─► Marketing / Work / attention (events)                          ─┘
Website ◄── delivery API v1 (API key cms:delivery.read, ETag, stale-if-error)
```

### 2.4 Dependencies

- New production dependency: **TipTap** (`@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extension-link`, `-image`, `-placeholder`, all MIT), chosen by Mario with E-3; exact versions are pinned in CH0.2. No Markdown parser: agents produce orbit-doc JSON through a strict schema. `sharp` (`packages/creative`) and `sanitize-html` exist.
- Phase 4: Google Search Console API (free, new external provider → approval).

## 3. Database design

Every table has `workspaceId`, `projectId`, a composite FK to `Project(workspaceId,id)`, `UNIQUE(projectId,id)` for child FKs, CHECK constraints for enums, **ENABLE + FORCE RLS** with `project_scope`, grants in `scripts/db-deploy.ts`, an entry in the manifest `tables` and in `rls-matrix.integration.test.ts`. Prisma models have no relation to `Project` (like `SocialPost`).

### 3.1 Platform

| Table | Purpose / key fields | Grants |
| --- | --- | --- |
| `ApiKey` (control plane, `orbit_auth`) | `name`, `prefix` (display), `secretHash` (SHA-256 of a 256-bit secret), `scopes[]` (registered module scopes), `resourceFilter` (e.g. `siteIds`), `expiresAt`, `lastUsedAt`, `revokedAt`, `createdBy` | auth: no DELETE (revoke instead) |
| `ApiIdempotencyKey` | `apiKeyId`, `key`, `requestHash`, `responseStatus`, `responseBody` (capped), `expiresAt` (24 h) | app: SELECT/INSERT/DELETE (retention) |
| `WebhookEndpoint` | `ownerModule`, `url` (HTTPS), `eventTypes[]`, `connectionId` (signing secret in `ConnectionSecret`, two active versions during rotation), `status`, `consecutiveFailures`, `disabledReason` | app: no DELETE |
| `WebhookDelivery` | `endpointId`, `eventId` (unique per endpoint), `eventType`, `payload` (content-light), `status` pending/delivered/failed/dead, `attempts`, `nextAttemptAt`, `lastStatus`, `lastErrorCode`, `durationMs` | app: 30-day retention |

### 3.2 Module `cms`

| Table | Key fields | Notes |
| --- | --- | --- |
| `CmsEntry` | `type` (code registry: `article`; prepared `faq`, `help_doc`, `changelog`, `product`), `locale`, `translationGroupId`, `slug`, `status` (draft/in_review/scheduled/published/archived), `publishedRevisionId`, `scheduledRevisionId`, `scheduledAt`, `firstPublishedAt`, `lastPublishedAt`, `archivedAt`, `origin` (manual/assistant/marketing/api/mcp/import), `originRef`, `version` | `UNIQUE(projectId,type,locale,slug)`; status consistent with the pointers by CHECK |
| `CmsDraft` | 1:1 with the entry: `title`, `excerpt`, `body` (orbit-doc-v1), `fields` (type-specific: FAQ, checklist, related links), `seo` (seoTitle, metaDescription, canonicalOverride, robots, og*, focusKeyword, keywords[], structuredDataType), `heroAssetId`, `authorIds[]`, `termIds[]`, `version`, `updatedBy` | autosave with version conflict `CMS_DRAFT_STALE` |
| `CmsRevision` | immutable snapshot of all draft fields + `number`, `contentHash`, `bodyHash`, `wordCount`, `changeNote`, `createdBy` (actor incl. agent, API key, MCP), `basedOnRevisionId` | trigger forbids UPDATE; no DELETE grant; created on "save version", submit and publish |
| `CmsTaxonomyTerm` | `kind` category/tag, `locale`, `translationGroupId`, `slug`, `name`, `description`, `parentId` | `UNIQUE(projectId,kind,locale,slug)` |
| `CmsAuthor` | `userId?`, `name`, `slug`, `bio` (per locale), `avatarAssetId`, `sameAs[]` | JSON-LD `Person` |
| `CmsAsset` | `fileId` (platform file), `mime` (PNG/JPEG/WebP/GIF, no SVG), `width`, `height`, `bytes`, `sha256`, `alt` (per locale), `caption`, `credit`, `license`, `provenanceId` (ImageProvenance), `focalPoint`, `variants` (WebP 480/960/1600, OG 1200×630) | preflight requires the alt text of the target locale and passes the AI label gate |
| `CmsSite` | `name`, `baseUrl`, `locales[]`, `defaultLocale`, `routes` (per type and locale, e.g. `/blog/{slug}/`, `/en/blog/{slug}/`), `trailingSlash`, `adapter` (`orbit_pull`; later `wordpress` …), `adapterConfig`, `notifiers` (webhook, coolify_rebuild, github_dispatch), `contentRules` (e.g. forbidden phrases, uLiquid plain-text profile), `verification` (configured/read_verified/live_verified) | one site per website; a project may have several |
| `CmsEntrySite` | entry ↔ site | composite FKs |
| `CmsPublication` | `entryId`, `revisionId`, `siteId`, `action` publish/update/unpublish, `status` queued/claimed/visible/notified/live_verified/needs_attention/cancelled/failed, `idempotencyKey` UNIQUE, `fence`, `attempts`, `approvalRequestId`, `scheduledAt`, `visibleAt`, `notifiedAt`, `liveVerifiedAt`, `errorCode` | adapter-neutral; push adapters add `sending`/`outcome_unknown` as in Social |
| `CmsPublicationAttempt` | log per step and adapter call | no UPDATE/DELETE |
| `CmsRedirect` | `siteId`, `fromPath`, `toEntryId`/`toPath`, `code` 301/410, `reason` slug_changed/archived | created on a slug change of a published entry and on archiving |

Phase 4 (owned by Marketing, own migration): `SeoSearchMetric` (site, page, query, country, device, date, clicks, impressions, ctr, position; index on page and date), `SeoTopicCluster`, `SeoBrief` (topic, intent, keywords, locale, target date, outline, fact keys, link targets, status, `cmsEntryId`, `workTaskId`).

**Migration strategy.** Additive; no existing table changes in phase 1, so no breaking change. Three separate migrations (platform keys and idempotency, platform webhooks, CMS core), each needing **a new schema hash in Coolify approved by Mario** before the push to `main`. Rollback: flags off (routes 404, worker skips), tables stay unused, no down migration required. Existing Marketing blog drafts stay in Drive; a new setting `blogTarget: drive | cms` switches only when Content is used.

## 4. API specification

### 4.1 Layers

| Layer | Path | Auth | Purpose |
| --- | --- | --- | --- |
| Internal UI API | `/api/projects/:projectId/cms/…` | session (Better Auth), module role, `cms.*` permissions | Orbit web (unversioned, as Social) |
| **Delivery API v1** | `/api/v1/cms/sites/:siteId/…` | API key `cms:delivery.read` (server-side on the website, never in a browser) | published revisions only |
| Preview v1 | `/api/v1/cms/preview/…` | API key `cms:preview.read` + signed preview token (HMAC, 30 min, bound to entry and revision) | draft preview (Next draft mode) |
| **Management API v1** | `/api/v1/cms/…` | API key `cms:manage.read`, `cms:manage.write`, `cms:publish.propose` | integrations; writes drafts only, publishing only as a proposal |
| Media (public) | `/api/v1/cms/media/:assetId/:variant.:ext?v=:hash` | none (assets of published revisions, unguessable ids) | `Cache-Control: public, max-age=31536000, immutable`, inline, `nosniff` |
| MCP | gateway `mcp-main.ts` | OAuth, scope `orbit:cms` (+ `orbit:read/propose/write`) | agents (Claude, ChatGPT) |
| Internal services | `modules/cms/contract.ts`, events `cms.*` | in-process, scope | Marketing, later Support and Knowledge |

### 4.2 Delivery endpoints (excerpt)

- `GET /sites/:siteId/entries?type=article&locale=de&category=&tag=&cursor=&limit=` → `{items, nextCursor}`
- `GET /sites/:siteId/entries/:type/by-slug/:slug?locale=de` → entry: title, excerpt, `body.doc`, `body.html` (rendered and sanitized), `body.text`, `toc`, `readingTime`, SEO, OG, canonical, `alternates[]` (hreflang from the translation group), authors, terms, hero image with variants and dimensions, `structuredData` (ready JSON-LD), `revision`, `publishedAt`, `updatedAt`
- `GET /sites/:siteId/taxonomies/:kind`, `GET /sites/:siteId/authors`
- `GET /sites/:siteId/redirects`, `GET /sites/:siteId/sitemap?locale=`, `GET /sites/:siteId/feed?locale=`
- `GET /sites/:siteId/manifest` (overall site revision for snapshots and build fallbacks)

### 4.3 Management endpoints (excerpt)

`GET/POST /entries`, `GET/PATCH /entries/:id/draft` (with `version`), `POST /entries/:id/revisions`, `GET /entries/:id/revisions[/:rev]`, `POST /entries/:id/translations`, `POST /entries/:id/publication-requests` (→ ActionRequest, 202), `POST /entries/:id/archive-requests`, `GET /publications/:id`, `GET/POST /assets`, `GET/POST/PATCH /taxonomies`, `/authors`.

### 4.4 Cross-cutting rules

- **Versioning:** path `/api/v1`; additive changes stay in v1; breaking changes only with `/v2` and at least six months in parallel, with `Deprecation`/`Sunset` headers. Own OpenAPI document `packages/schemas/openapi-v1.json` with explicit response schemas, separate from the internal spec.
- **Errors:** the existing envelope plus `requestId`; stable codes (`CMS_ENTRY_NOT_FOUND`, `CMS_DRAFT_STALE`, `API_KEY_SCOPE_MISSING`, `RATE_LIMITED`, …).
- **Pagination:** keyset `{items,nextCursor}`, `limit` ≤ 100 (delivery) / 50 (management).
- **Rate limits:** per API key (delivery 600/min, management 120/min, preview 60/min) on top of the IP limit; `RateLimit-*` headers.
- **Caching and invalidation:** delivery overrides the global `no-store`: `ETag` (revision or list hash), `If-None-Match` → 304, `Cache-Control: private, max-age=60, stale-while-revalidate=86400, stale-if-error=604800`; webhook payloads carry cache tags (`orbit:entry:<id>`, `orbit:list:<site>:<type>:<locale>`, `orbit:sitemap:<site>`).
- **Idempotency:** `Idempotency-Key` header on every v1 POST/PATCH (24 h, request hash compared → `IDEMPOTENCY_KEY_REUSED`); publications use `idempotencyKey = sha256(entry, revision, site, action)`.
- **Proxy and origin:** the Next proxy forwards `Authorization` for `/api/v1/*`; bearer-only routes are exempt from `ORIGIN_REQUIRED` (no cookies, so no CSRF) and ignore cookies. Security review item.
- **Audit:** content-free audit events for key creation and revocation, draft changes (field names only), decisions, publications, webhook endpoint changes, origin and scope refusals.
- **Rich-text safety:** closed node and mark set (h2–h4, paragraph, lists, quote, code, image by `assetId`, callout, FAQ block, tables later); links only `https:`, `mailto:` or relative; `rel="noopener noreferrer"` on external links; no raw HTML node; own escaping renderer plus `sanitize-html`; XSS corpus tests.

### 4.5 Webhooks

Payload (content-light; the receiver fetches content through the delivery API):

```json
{ "id": "evt_…", "type": "cms.entry.published", "occurredAt": "…", "projectId": "…", "siteId": "…",
  "entry": { "id": "…", "type": "article", "locale": "de", "slug": "…", "path": "/blog/…/", "revision": 7 },
  "previousPath": null, "tags": ["orbit:entry:…", "orbit:list:…:article:de"] }
```

Headers `X-Orbit-Event-Id`, `X-Orbit-Timestamp`, `X-Orbit-Signature: v1=<hex HMAC-SHA256(secret, ts + "." + body)>` (the existing scheme; two signatures during rotation). Receivers check a 5-minute window and deduplicate by event id. Events: `cms.entry.published|updated|unpublished|scheduled`, `cms.redirect.created`, `cms.site.ping`. Retries: exponential with jitter (1 min to 24 h, at most 12 attempts); 2xx is success; 410 disables the endpoint; 20 failures in a row auto-disable it with an attention item. Delivery through `boundedFetch`, 10 s timeout, replay from the log.

### 4.6 Approval (E-4)

- Action types `cms.entry.publish` (publish, update, schedule; payload binds `entryId`, `revisionId`, `contentHash`, `siteIds`, `scheduledAt`) and `cms.entry.unpublish`. Risk class `W2`, `approval_required`, never mandatable, `mcpProposable: true`.
- `deciderRole: "editor"`, `inbox: "editors"` and `mayDecide` against the project setting `cms.publishApprovers` (`owner` or `owner_or_editor`, default `owner_or_editor`); a content editor writes in the module `cms`. Optional `fourEyes` (requester ≠ decider), default off.
- Agents, API keys and MCP only propose. The deviation from ADR 0008's owner default for `W2` is recorded in ADR 0029.

## 5. UI concept

- **Sidebar group "Content"** (`groupOrder: 11`, between Marketing 10 and Social 12), opt-in per project. New deep links under `/p/:projectId/cms/…`; existing links are untouched.
- **Overview** `/cms`: attention (pending approvals, scheduled publications, failed webhooks or live checks, missing alt texts and SEO warnings, outdated translations), recently edited.
- **Entries** `/cms/entries`: table with filters (type, status, locale, site, category, author) and search.
- **Editor** `/cms/entries/:id`: TipTap canvas (reading surface, block toolbar, slash menu, image block from the media library); side panel tabs *Publishing* (sites, time in the project time zone, status, request approval), *SEO* (title and meta with length meter, slug, canonical, robots, focus keyword, snippet preview, deterministic checks), *Social/OG*, *Taxonomy & authors*, *Translations* (variants per locale, "create from source", outdated hint); autosave indicator; preview link.
- **History** `/cms/entries/:id/history`: revisions, diff, restore as a new draft, publication log per site.
- **Media** `/cms/media`: library, upload, import from Drive and Creative Studio, alt text per locale, AI label state, variants.
- **Taxonomies and authors** `/cms/taxonomies`, `/cms/authors`.
- **Calendar** `/cms/calendar`: scheduled and published entries (later with SEO briefs).
- **Settings center** (ADR 0027): `/manage/p/:id/cms/sites` (sites, routes, locales, notifiers, verification, content rules), `/manage/p/:id/cms/publishing` (approval rules, time zone, lateness window), `/manage/p/:id/integrations/api-keys` and `/integrations/webhooks` (platform sections; a key is shown once; log, replay, test ping).
- **Approval renderer** for `cms.entry.publish/unpublish` (diff against the live revision, sites, time, check state).
- Design per `docs/DESIGN_SYSTEM.md`.

## 6. Agent integration

- **Contract** `modules/cms/contract.ts`: `submitOriginDraft` (origin `{module,type,id,version}`, deduplicated per origin and version, writes drafts and revisions only), `requestPublication` (creates the ActionRequest), `entryStatus`, `publishedEntries` (internal linking, cannibalization and novelty checks), `entryUrlMap` (metrics mapping), `cancelOriginRequest`.
- **Marketing:** blog assignments target `cms` when `blogTarget: cms`, without a placeholder channel; Drive stays the fallback. Generation produces orbit-doc JSON through a strict schema; facts, evidence and claims checks as today; images through the existing image generation and the AI label gate.
- **Assistant and MCP:** `cms_entries`, `cms_entry_get` (R0), `cms_draft_create`, `cms_draft_update`, `cms_media_import` (W0, `orbit:write` + `orbit:cms`), `cms_publish_propose` (P_proposal), `cms_publication_status` (R0). New scope `orbit:cms` in `mcp-auth/plugins.ts` and `mcp/scopes.ts` (unchecked on consent, like `orbit:social`).
- **Work:** new handoff target `work.task_from_editorial` (accepts `marketing.seo_brief` and `cms.entry`), `TASK_SOURCES += editorial`.

## 7. Website integration (phase 2, a separate step; variant per site open)

**Shared pattern (both variants).**
- Site client (`lib/orbit/`): typed from OpenAPI v1, timeout and retry, zod validation, mapping to the site's existing model (FamilyPlan `BlogPost`, EDS Labs `translationSlug`/`categoryServices`, uLiquid exactly per `blog-posts.mjs`), and a **committed fallback snapshot** for builds and runtime when Orbit is unreachable. Reference implementation in Orbit under `examples/website-client/`.
- Routes `/blog`, `/blog/[slug]` (plus locale variants) from delivery data; `generateMetadata` (SEO title, meta, canonical, hreflang with `x-default`, OG); JSON-LD from `structuredData`; `sitemap.ts` with lastmod and alternates; **RSS** `/blog/feed.xml` per locale; redirects from `/redirects`; `<meta name="orbit-revision">` for the live check; image dimensions from the API.
- **Variant A, Node + ISR:** `next start`/standalone in Docker (Coolify); `fetch` with tags; route `/api/orbit/revalidate` checks the HMAC and calls `revalidateTag`; when Orbit is down the last generated page stays in the ISR cache. Requires lifting the static-only rule of the website's AGENTS.md; FamilyPlan moves its nginx routing (`/app`, `/admin`, `/approve`, `.well-known`, `_health`) into Next rewrites.
- **Variant B, static + rebuild:** the build reads the delivery API and falls back to the snapshot; Orbit's notifier calls the Coolify deploy API (FamilyPlan app `ijuexphi1o7hmytcnhjggtjg`) or GitHub `repository_dispatch` → build → deploy (Hostinger: SFTP). No commit, but one build per publication (5-minute debounce window).

**Per site.**
1. **FamilyPlan (pilot):** first merge the two live-only hotfixes (Android test page, privacy page) into `main`. Migrate the 3+3 articles (`alternateSlug` → translation group; checklist, FAQ, related links in `fields`; images as assets with real dimensions). Files: `apps/web/lib/blog-posts.ts`, both `[blogSlug]/page.tsx`, `BlogArticlePage.tsx`, `BlogCard.tsx`, `BlogIndexPage.tsx`, `app/sitemap.ts`, a new feed route, `Dockerfile`/`nginx.conf` (variant B: build secret), `apps/web/tests/`, `ENTWICKLUNGSLOG.md`.
2. **EDS Labs:** migrate ~25+25 articles (slugs and dates unchanged); category keys ↔ `categoryServices`; `cta` as a type field; generate `llms.txt` at build time; adjust the CSP in `.htaccess`/`_headers` or download images into `out/` at build time. Hosting decision E-2 first.
3. **uLiquid:** mirror the plain-text profile and forbidden phrases as `CmsSite.contentRules` (checked before approval); a pre-build fetch into the `blog-posts.mjs` pipeline; read the Next 16 caching docs before any ISR work; supersedes branch `claude/uliquid-blog-publishing-c9a252` (closed after Mario's OK).

## 8. SEO concept

**Technical (module and sites):** normalized unique slugs with redirects on change; canonical from the site route with override; hreflang from the translation group including `x-default`; robots per entry; sitemap and feed data; JSON-LD (`BlogPosting`, `BreadcrumbList`, `FAQPage` from the FAQ field, `Person`/`Organization`); OG images 1200×630; image variants and dimensions (CLS); `lastmod` = last content revision; 301/410 on archiving; deterministic editor checks (title and meta length, one H1, heading order, alt texts, internal links, focus keyword coverage without stuffing).

**Editorial (phase 4):** topic clusters and pillar pages, search intent, cannibalization checks, internal links from published entries, updating before producing (striking distance, falling clicks), a quality rubric (helpful, evidenced, own experience or product relevance), a monthly volume cap.

## 9. Work packages

Sizes: **S** ≈ 0.5–1 person-day, **M** ≈ 2–3, **L** ≈ 4–6, **XL** ≈ 8–12 (classic estimates including tests and review). With the observed Orbit pace (Social S1–S6 in about two days), calendar time is bounded mainly by reviews, schema hash approvals and live checks. **MVP** = needed for the first pilot article.

### Phase 0, foundations

| ID | Content | Depends | Size | MVP |
| --- | --- | --- | --- | --- |
| CH0.1 | ADR 0029, this plan, status and traceability entries | – | S | ✔ |
| CH0.2 | Spike TipTap ↔ orbit-doc-v1 (mapping, bundle size, paste behaviour), pin versions | CH0.1 | S | ✔ |

### Phase 1, Content Hub and API

| ID | Content | Depends | Size | MVP |
| --- | --- | --- | --- | --- |
| CH1.1 | Platform API keys: `ApiKey` (auth role), hash and prefix, scope registry (`apiScopes` contribution), auth hook, per-key rate limits, owner-only management with audit, proxy pass-through and origin exemption | CH0.1 | L | ✔ |
| CH1.2 | `/api/v1` frame: prefix helper, errors with `requestId`, pagination, ETag/cache helper (no-store override), `Idempotency-Key` (+ `ApiIdempotencyKey`), OpenAPI v1 document and client generation | CH1.1 | M | ✔ |
| CH1.3 | Platform webhooks: `WebhookEndpoint`/`WebhookDelivery`, v1 signature with rotation, queue `webhook_delivery`, backoff with jitter, auto-disable, replay, test ping, `webhookEvents` contribution, retention | CH0.1 | L | ✔ |
| CH1.4 | Module skeleton `cms`: manifest, permissions, gate `ORBIT_CMS` (compose, env, checks), settings (approvers, four-eyes, time zone, 24 h lateness window), boundary zone, web manifest (opt-in), access matrix | CH0.1 | M | ✔ |
| CH1.5 | `packages/content-doc`: orbit-doc-v1 schema, validation, HTML/text renderer, TOC, reading time, link policy, TipTap adapter, XSS corpus and property tests | CH0.2 | M | ✔ |
| CH1.6 | CMS core migration (all `Cms*` tables of §3.2), RLS, grants, revision trigger, `cms-schema.integration.test.ts`, RLS matrix | CH1.4 | L | ✔ |
| CH1.7 | Content type registry: `article` on; `faq`, `help_doc`, `changelog`, `product` defined and off; field schemas, JSON-LD builders | CH1.5 | S | ✔ |
| CH1.8 | Entry service and internal routes: draft CRUD and autosave, revisions (snapshot, diff, restore), archive, translations, slugs and redirects, taxonomies, authors, audit | CH1.6, CH1.7 | L | ✔ |
| CH1.9 | Media: `CmsAsset` over platform files, upload and import (Drive, Creative Studio), dimensions, variants through `sharp`, alt text per locale, public media route, ImageProvenance and AI label gate | CH1.6 | L | ✔ |
| CH1.10 | Publishing core: publish/unpublish action types (E-4), `revalidate`/`onApproved`, `CmsPublication` and worker `cms_publish` (claim, fence, preflight, pointer switch, redirects), schedule, reschedule, cancel, domain events | CH1.8, CH1.9 | L | ✔ |
| CH1.11 | Sites and adapter registry: `CmsSite` management, `PublishingAdapter` (implemented: `orbit_pull`), notifier interface (implemented: `webhook` through CH1.3; prepared: `coolify_rebuild`, `github_dispatch`), live check job, site verification, content rules | CH1.3, CH1.10 | L | ✔ |
| CH1.12 | Delivery API v1 and preview (token), sitemap, feed, redirect and manifest endpoints, caching, per-site key scopes, OpenAPI | CH1.2, CH1.8, CH1.11 | L | ✔ |
| CH1.13 | Management API v1 (drafts, revisions, assets, taxonomies, publication proposals), idempotency | CH1.2, CH1.10 | M | – |
| CH1.14a | Web: overview, entry list, navigation, attention | CH1.8 | M | ✔ |
| CH1.14b | Web: TipTap editor with SEO, OG, slug, scheduling, translations, preview | CH1.5, CH1.8, CH1.10 | XL | ✔ |
| CH1.14c | Web: media library, taxonomies, authors | CH1.9 | M | ✔ |
| CH1.14d | Web: history, diff, restore, publication log, approval renderer | CH1.10 | M | ✔ |
| CH1.14e | Web: calendar | CH1.10 | S | – |
| CH1.14f | Web: settings center sections (sites, publishing, API keys, webhooks) | CH1.1, CH1.3, CH1.11 | M | ✔ |
| CH1.15 | `contract.ts` and events for other modules, boundary `marketing → cms` | CH1.10 | M | – (required before phase 4) |
| CH1.16 | MCP and assistant tools, scope `orbit:cms` | CH1.10, CH1.15 | M | – |
| CH1.17 | Retention, export and pause hooks, notifications and signals, docs (new CMS.md and CMS_API.md under docs/, operations, rollout runbook) | CH1.10 | M | ✔ |
| CH1.18 | Phase 1 acceptance: E2E, security review (API keys, webhooks, rich text, media), `pnpm api:generate`, lint, typecheck, test, build | all MVP | M | ✔ |

**Phase 3 preparation** (no WordPress implementation) is part of CH1.10 and CH1.11: the adapter-neutral publication state machine (including `sending`, `outcome_unknown` and reconciliation for push targets), `PublishingAdapter` (`validate`, `render`, `push`, `reconcile`, `unpublish`, `capabilities`), the connection provider pattern `cms.target.<kind>`, mapping profiles per site and event subscription through platform webhooks.

### Phase 2, websites (starts after Mario's variant decision)

| ID | Content | Depends | Size | MVP |
| --- | --- | --- | --- | --- |
| CH2.0 | Decision gate: variant A/B per site, hosting of EDS Labs and uLiquid, FamilyPlan hotfixes in `main` | CH1.18 | S | ✔ |
| CH2.1 | Reference site client, fallback snapshot, revalidation and rebuild examples; notifiers `coolify_rebuild`/`github_dispatch` if variant B | CH1.12 | M | ✔ |
| CH2.2 | Import tool (management API) for existing articles, mapping per site, dry run | CH1.13 | M | ✔ |
| CH2.3 | FamilyPlan integration (de/en, images, FAQ and checklist, sitemap, RSS, JSON-LD, live check) | CH2.0–CH2.2 | L | ✔ |
| CH2.4 | EDS Labs integration (~50 articles, categories and CTA, `llms.txt`, CSP, hosting if decided) | CH2.3 | L | – |
| CH2.5 | uLiquid integration (validator mirror, pre-build fetch, Next 16), retire the old branch | CH2.3 | M | – |
| CH2.6 | Operations: monitoring of webhooks and live checks, outage drill (Orbit down → sites keep serving), runbook | CH2.3 | S | ✔ |

### Phase 4, AI SEO automation

| ID | Content | Depends | Size | MVP |
| --- | --- | --- | --- | --- |
| CH4.1 | Search Console connection (OAuth `webmasters.readonly`, property ↔ site), provider through a Marketing contribution | CH1.11 | M | ✔ |
| CH4.2 | Metrics import: daily Search Analytics → `SeoSearchMetric`; Matomo page metrics per article URL (existing import) through `entryUrlMap` | CH4.1, CH1.15 | M | ✔ |
| CH4.3 | Topic and keyword research: Search Console queries, existing content, knowledge base, hosted web search (research specialist); clusters and intent through `runStructured` (task class `seo_research`) | CH4.2 | L | ✔ |
| CH4.4 | Editorial calendar: brief proposals → accepted by owner or editor → Work task (`work.task_from_editorial`) and a CMS placeholder; calendar view | CH4.3, CH1.15 | L | ✔ |
| CH4.5 | Article generation: blog assignment with target `cms`; brief → outline → draft (orbit-doc JSON, task class `draft_article`, 8–16k tokens) → facts → SEO → links → image → review | CH4.4 | L | ✔ |
| CH4.6 | Quality and source review: claims only against verified facts or fetched sources, no invented quotes or URLs, cannibalization, readability, site rules, model rubric; failures go to `needs_owner` | CH4.5 | M | ✔ |
| CH4.7 | SEO optimization and internal linking (from `publishedEntries`), meta, FAQ and alt suggestions (confirmed by a person) | CH4.5 | M | – |
| CH4.8 | Images: hero 1200×630 through image generation or Drive, AI label, alt text suggestion | CH4.5 | S | – |
| CH4.9 | Handoff: `submitOriginDraft` + `requestPublication` → existing approval → scheduled publication | CH4.6 | S | ✔ |
| CH4.10 | Measurement and optimization: article dashboard, update candidates (striking distance, CTR, decline) → update briefs through the same pipeline | CH4.2, CH4.9 | L | – |
| CH4.11 | Guardrails and evals: monthly budget, articles per month cap (default 4), golden-set evals, live eval with spend approval | CH4.5 | M | ✔ |

### Order and parallelism

1. CH0.1 → CH0.2.
2. In parallel where files do not overlap: CH1.5 → CH1.7 next to the platform track. The three migrations (CH1.1/CH1.2, CH1.3, CH1.4 → CH1.6) all touch `schema.prisma`, `scripts/db-deploy.ts` and the RLS matrix, so they run one after another.
3. CH1.8 → CH1.9 ∥ CH1.10 → CH1.11 → CH1.12; web CH1.14a/c beside the backend, CH1.14b after CH1.5 and CH1.8.
4. CH1.13, CH1.15, CH1.16, CH1.17, CH1.18.
5. Phase 2 after CH2.0; phase 4 may start after CH1.15 next to phase 2 (CH4.1–CH4.3).

## 10. Tests and acceptance criteria

- **Function:** draft → revision → approval → scheduled → published → updated → archived (301/410) with translations; restore; slug change creates a redirect; time zones and DST; lateness over 24 h → `needs_attention`.
- **Security:** a key is shown once and stored as a hash; scope and site filters; expired or revoked → 401; bearer routes ignore cookies; webhook signature and replay protection; SSRF (private IPs, redirects) blocked; XSS corpus against renderer and sanitizer; SVG and active content refused; the media route serves published assets only; rate limits hold.
- **Tenancy:** RLS matrix (all new tables), access matrix (module roles editor/viewer/none, disabled module → 404, foreign project → 404), a project's key never sees another project's data; `cms-schema.integration.test.ts`; queue dispatch test extended by `cms_publish` and `webhook_delivery`.
- **Approval:** owner and content editor (with `owner_or_editor`) may decide; viewers, agents and keys may not; a draft changed after the request fails `revalidate`; four-eyes; an MCP proposal always ends in an Orbit decision; no mandate applies.
- **Publishing and idempotency:** a duplicate worker run yields one publication (fence); webhook retries and auto-disable; the live check detects an old revision; a repeated idempotency key returns the same answer, a different body fails.
- **SEO:** canonical, hreflang pairs, JSON-LD (schema validator), sitemap and feed data are correct; site acceptance with the rich results test, sitemap in Search Console, Lighthouse SEO ≥ 95, redirects checked.
- **Websites:** outage drill (API down → existing articles stay reachable, the build uses the snapshot); a new article is live without a commit (variant A: under a minute after approval; variant B: after the rebuild).
- **AI (phase 4):** no claim without a verified fact or fetched source; golden-set eval; budget reservation and settlement; no automatic publication without approval.
- Standard checks per package: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, affected `pnpm test:e2e`, `pnpm api:generate` (review the diff), `pnpm test:coolify-compose` for flag or compose changes, worktree database through `node scripts/test-db-for-worktree.ts`.

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| New public surface (API keys, v1, media route) | security review package, per-site key scopes, rate limits, audit, `ORBIT_CMS` default off, separate acceptance |
| Origin exemption for bearer routes weakens CSRF protection | strictly `/api/v1/*` with `Authorization`, cookies ignored there, tests |
| Name clash `content` | module id `cms` |
| Two systems (Marketing blog in Drive vs. CMS) | `blogTarget` switch, Drive as fallback only, docs |
| Editor approval of `W2` deviates from ADR 0008's default | ADR 0029, project setting, optional four-eyes |
| Schema hash approvals block delivery | three bundled migrations, announced early |
| FamilyPlan live container differs from `main` | merge the hotfixes before any rebuild or ISR change (CH2.0) |
| Website variant still open | Orbit supports pull + webhook and rebuild notifiers; decision at CH2.0 |
| SEO loss during migration | unchanged slugs, dates and canonicals, redirect tests, sitemap comparison before and after |
| Low-quality AI mass production | volume cap, quality rubric, fact binding, mandatory approval, update-before-new strategy |
| Google OAuth app in testing mode / verification of sensitive scopes | Mario publishes or verifies the OAuth app before CH4.1 goes live |
| Editor complexity and bundle size | spike CH0.2, lazy-loaded editor, closed node set |
| Next 16 caching changes (uLiquid) | read `node_modules/next/dist/docs/` first |

## 12. Effort (order of magnitude)

| Phase | Classic effort | MVP share |
| --- | --- | --- |
| Phase 0 | 1–2 person-days | all |
| Phase 1 | ≈ 55–75 person-days | ≈ 45–60 (without CH1.13, CH1.14e, CH1.15, CH1.16) |
| Phase 2 | ≈ 15–22 person-days (FamilyPlan pilot ≈ 7–10) | pilot + operations |
| Phase 4 | ≈ 30–40 person-days | ≈ 20–28 |

Expected calendar time with Claude Code and subagents: phase 1 about 2–3 weeks including reviews and approvals, the pilot about one week after the decision, phase 4 about 2–3 weeks.

## 13. Open decisions

- D-A Website variant A/B per site (CH2.0) and hosting of EDS Labs and uLiquid (E-1, E-2 deferred).
- D-B Exact TipTap versions and extension list: proposal from CH0.2 in [CONTENT_HUB_CH0_2_TIPTAP_SPIKE.md](CONTENT_HUB_CH0_2_TIPTAP_SPIKE.md) (five packages at 3.32.2), awaiting approval.
- D-C Public API domain: the app origin through the Next proxy (recommended) or an `api.` subdomain.
- D-D Search Console: publish the OAuth app; optional paid keyword volume API (not MVP; recommended: no).
- D-E Monthly budget and article cap for the SEO automation (proposal: 4 articles per month and project).
- D-F Close branch `claude/uliquid-blog-publishing-c9a252` once CH2.5 is planned.

## 14. Delivery and verification

- Each package in its own worktree or subagent, local checks (§10), commit; push to `main` only with Mario's approval (production deploy); migrations only after a new schema hash in Coolify; flags stay off until their own live approval.
- Phase 1 end-to-end evidence: locally a project with `cms` on, a site "FamilyPlan (local)", articles in de and en, approval by a content editor, a scheduled publication, the delivery API with `curl` and a key (ETag/304), a webhook to a local test receiver (signature checked), a live check against a test page, archiving → 410/301.
- Rollback: `ORBIT_CMS` off (routes 404, worker idle), keys revocable, webhook endpoints can be disabled; tables are additive; websites keep their fallback snapshot.

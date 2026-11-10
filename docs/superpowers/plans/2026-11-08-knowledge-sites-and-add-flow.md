# Knowledge sites and add flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read whole multi-page sites into Knowledge and keep them current, and replace the add wizard with a short flow whose AI analysis states its cost and blockers up front.

**Architecture:** A platform service discovers a site through its sitemap and reads it in a durable run of 20-page batches using the existing `ingest`. The Knowledge module adds owner actions and a rebuilt wizard. AI analysis moves to its own task class with a read-only preflight.

**Tech Stack:** TypeScript, Fastify, BullMQ worker, Prisma/PostgreSQL, Next.js, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-08-knowledge-sites-and-add-flow-design.md`

## Global Constraints

- Branch `claude/wissen-modul-review-3fbb67`. Never push. Commit steps assume Mario's go-ahead for this execution.
- Node 24.18 (`export PATH=~/.nvm/versions/node/v24.18.0/bin:$PATH`). `VT` below means `node --env-file=.runtime/local.env --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run`.
- No schema migration, no new dependency, no live GitBook or paid model in tests.
- `maxAgeHours` 336, `syncEveryHours` 168, batch 20 pages, 200 pages per source, 10 child sitemaps, 3 `robots.txt` redirects, AI mode 30 pages and 100,000 characters, single statement 1,000 characters, `knowledge_analysis` default 12,000 output tokens.
- Platform code must not import modules (`scripts/boundaries.json`). All new actions are owner-only.
- User-facing text exists in German and English. Audit records stay content-free.

## Review Focus

- A sitemap that lists the root with and without a trailing slash, or URLs outside the root: each page appears once and foreign URLs never enter the run.
- `<page>.md` answering `200 text/markdown` with an empty body, or `404` for the root page: Orbit falls back to HTML.
- The owner pauses a source or excludes pages during a run: the next batch stops or skips them, and a second start returns the active run.
- A page too large or too long for `ingest`: it is listed as failed, keeps its last version, and the run continues.
- A worker that dies mid-batch: repeating the batch creates no duplicate documents, jobs or counters.

---

### Task 1: Fetching: robots redirects, sitemap XML, shared credential check

**Files:**
- Modify: `packages/knowledge/src/safe-fetch.ts`, `packages/knowledge/src/index.ts`, `apps/api/src/modules/knowledge/github.ts`, `apps/api/src/modules/knowledge/workspace.ts`
- Create: `packages/knowledge/src/credentials.ts`, `packages/knowledge/tests/site-fetch.test.ts`

**Interfaces:**
- Produces: `class RedirectError extends KnowledgeError { location: string | null }` (code `REDIRECT_NOT_ALLOWED`); `type FetchFn = typeof fetchPublicDocument`; `fetchApprovedDocument(input, policy, fetchFn?: FetchFn)`; `fetchDiscoveryDocument(input, policy, fetchFn?: FetchFn)`; `FetchPolicy.discovery?: true`; `containsCredentials(text: string): boolean` exported from `packages/knowledge`.

- [ ] **Step 1: Write failing tests** in `site-fetch.test.ts` with a stubbed `fetchFn`: `follows a same-origin robots redirect` (307 to `/familyplan-hilfe/robots.txt`, page returned); `denies a robots redirect to another origin`, `to a path not ending in /robots.txt`, `after more than 3 redirects` (rejects `REDIRECT_NOT_ALLOWED`); `applies a disallowing robots file after the redirect` (`ROBOTS_DISALLOWED`); `still refuses a redirect of the page itself`; `only discovery accepts XML` (`fetchApprovedDocument` passes no `discovery`, `fetchDiscoveryDocument` passes `discovery: true`).
- [ ] **Step 2: Run** `VT packages/knowledge/tests/site-fetch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `fetchPublicDocument` rejects 3xx with `RedirectError` carrying the `location` header, and with `policy.discovery` also accepts `application/xml` and `text/xml` in `accept` and the MIME check. The robots step of `fetchApprovedDocument` loops at most 3 times, resolving `location` against the current URL and requiring the same origin and a path ending in `/robots.txt`. Each hop uses `allowedPaths: [thatPath]`. Move `containsCredentials` to `credentials.ts` and import it where it was used.
- [ ] **Step 4: Run** `VT packages/knowledge/tests apps/api/src/modules/knowledge/website-snapshot.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): follow same-origin robots redirects and allow sitemap XML`.

### Task 2: Retiring a document without a tombstone

**Files:**
- Modify: `packages/knowledge/src/index.ts`, `apps/api/src/platform/knowledge/engine.ts`
- Test: `packages/knowledge/tests/knowledge.integration.test.ts`

**Interfaces:**
- Produces: engine `retireDocument(tx, s, handlers, documentId): Promise<{ retired: boolean }>`; platform wrapper `retireDocument(tx, s, documentId)`.

- [ ] **Step 1: Write failing tests:** `retiring hides a document from retrieval`; `retiring writes no tombstone, so the same externalId can be ingested again`; `retiring invalidates dependents without purging evidence items`; `retiring twice reports retired false`.
- [ ] **Step 2: Run** `VT packages/knowledge/tests/knowledge.integration.test.ts -t retir`. Expected: FAIL.
- [ ] **Step 3: Implement** by marking the active version `superseded`, clearing `activeVersionId` and calling `invalidate(..., "document_retired", undefined, false)`. Audit `knowledge.document_retired`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): retire documents without blocking their return`.

### Task 3: Discovering a site and reading a page

**Files:**
- Create: `apps/api/src/platform/knowledge/site-sync.ts`, `apps/api/src/platform/knowledge/site-sync.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `type SitePage = { url: string; language: string }`; `type SiteDiscovery = { rootUrl: string; discovery: "sitemap" | "single"; pages: SitePage[]; capped: boolean }`; `sitePolicy(rootUrl: string): FetchPolicy`; `discoverSite(rootUrl, { languages: string[]; fallbackLanguage: string }, deps?: { fetchDiscovery; fetchPage }): Promise<SiteDiscovery>`; `readSitePage(url, policy, deps?): Promise<{ title: string; text: string; mimeType: string }>`; `MAX_SITE_PAGES = 200`.

- [ ] **Step 1: Write failing tests** with stubs and sitemaps modelled on GitBook: `expands a sitemap index one level and no deeper`; `reads at most 10 child sitemaps`; `drops URLs outside the root`; `lists the root once with and without a trailing slash`; `caps at 200 and reports capped`; `falls back to the single root page without a sitemap`; `reads /en/ pages as English when en is a content language`; `uses the fallback language otherwise`. For pages: `prefers Markdown and drops a first-line llms.txt blockquote`; `falls back to HTML on 404`; `falls back to HTML when the Markdown body is empty`; `takes the title from the first heading, else <title>, else the path`.
- [ ] **Step 2: Run** `VT apps/api/src/platform/knowledge/site-sync.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `sitePolicy` allows the origin and the root path. Discovery also allows `/sitemap.xml` at the origin. Use `discoverPublicPages` for `<urlset>` and detect `<sitemapindex>` to expand it.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): discover site pages and read them cleanly`.

### Task 4: The site run

**Files:**
- Create: `apps/api/src/platform/knowledge/site-run.ts`, `apps/api/tests/knowledge-site-run.integration.test.ts`
- Modify: `apps/api/src/platform/modules/platform-contributions.ts`, `apps/api/src/modules/knowledge/manifest.ts`, `apps/api/src/platform/knowledge/source-sync.ts`, `apps/worker/tests/queue-dispatch.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces: `SITE_BATCH = 20`; `startSiteRun(tx, s, sourceId, trigger: "initial" | "manual" | "schedule", pages: SitePage[]): Promise<Entity>`, which returns the active run if one exists; `runSiteBatch(s, runId, jobId): Promise<void>`; queue class `knowledge_site_sync` (`leaseMs` 300000, concurrency 1); entity kind `knowledge_site_runs` with `exported: false` and the fields from the spec.

- [ ] **Step 1: Write failing tests** with stubbed fetches: `reads a site in batches and enqueues the next one`; `counts unchanged, changed and added pages`; `retires a page no longer listed`; `does not retire when discovery is empty or would remove more than half, and sets site_shrank`; `keeps the last version of a failing page and lists it`; `lists a page too long for ingest as failed and continues`; `skips and counts a page with credentials`; `stops when the source is paused or its generation changed`; `skips a page excluded during the run`; `retires a page that was excluded after being read`; `returns the active run on a second start`; `repeating a batch creates no duplicate documents, jobs or counters`; `queues embeddings only when the source allows model use and index, key and authority exist`; `schedules a run for a site source past its interval`; `does not schedule with weekly updates off`; `leaves a source with syncEveryHours but no site on today's behaviour`.
- [ ] **Step 2: Run** `VT apps/api/tests/knowledge-site-run.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Fetch outside a transaction. Run each page's `ingest` and the update of `cursor` and counters in one `scoped` transaction, so a retried batch resumes at the first unprocessed page. A `schedule` run starts with `pages: []`; its first batch calls `discoverSite`, because the sweep must not fetch inside its transaction. Removals happen when the last page is done.
- [ ] **Step 4: Run** the same command and `VT apps/worker/tests/queue-dispatch.integration.test.ts apps/api/tests/sweep.characterization.integration.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): read sites in durable batches and keep them current`.

### Task 5: Owner actions and attention for sites

**Files:**
- Create: `apps/api/src/modules/knowledge/sites.ts`
- Modify: `apps/api/src/modules/knowledge/actions.ts`, `permissions.ts`, `attention.ts`, `apps/api/tests/module-contributions.test.ts`, `apps/api/tests/fixtures/access-matrix.json`, `apps/web/src/modules/knowledge/attention.tsx`
- Test: `apps/api/tests/knowledge-site-run.integration.test.ts`, `apps/api/tests/attention-knowledge-platform.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 4.
- Produces: actions `knowledge-site-discover { url? , sourceId? }`, `knowledge-site-start { sourceId?, url?, name?, type?, excludedPages, autoUpdate, marketing, support, publicUse, modelUse, language }`, `knowledge-site-refresh { sourceId }`, `knowledge-site-settings { sourceId, autoUpdate?, excludedPages? }`; attention kind `knowledge_site_review`.

- [ ] **Step 1: Write failing tests:** `discover writes nothing`; `start creates a site source with maxAgeHours 336 and syncEveryHours 168`; `start reuses an existing empty gitbook source`; `start without pages is refused with KNOWLEDGE_NO_PAGES`; `settings without autoUpdate removes syncEveryHours`; `only owners can use any site action`; `site actions stay inside their project`; `a run with a warning or failed pages raises knowledge_site_review linking to the source`.
- [ ] **Step 2: Run** `VT apps/api/tests/knowledge-site-run.integration.test.ts -t action` and the attention file. Expected: FAIL.
- [ ] **Step 3: Implement** using `ownTransaction` handlers, then run `UPDATE_ACCESS_MATRIX=1 VT apps/api/tests/access-matrix.integration.test.ts` and confirm the diff adds only owner-only entries. Add the German and English attention text.
- [ ] **Step 4: Run** `VT apps/api/tests/module-contributions.test.ts apps/api/tests/access-matrix.integration.test.ts apps/web/src/platform/shell/attention.test.tsx` plus the two files above. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): add owner actions for site sources`.

### Task 6: AI analysis: own route, preflight, consent, multiple pages

**Files:**
- Modify: `packages/ai/src/routing.ts`, `packages/ai/src/provider.ts`, `apps/web/src/components/ai-settings.tsx`, `apps/web/src/lib/ai-presets.ts`, `packages/schemas/src/knowledge-workspace.ts`, `apps/api/src/modules/knowledge/workspace.ts`, `actions.ts`, `permissions.ts`, `docs/MODEL_ROUTING.md`
- Test: `apps/api/tests/knowledge-workspace.integration.test.ts`, `packages/ai/src/routing.test.ts`, `apps/api/src/modules/knowledge/website-snapshot.test.ts`

**Interfaces:**
- Produces: task class `knowledge_analysis` (12,000 tokens, `standard`, Claude suggestion `claude-sonnet-5-5`); action `knowledge-analysis-preflight { previewId } -> { ready: boolean; blockers: string[]; estimateMicros: number; model: string; provider: string; proposalLimit: number }`; `knowledge-analysis-start { previewId, confirmModelUse?: true }`; draft field `pages?: string[]` (max 30); run field `costMicros`; error `KNOWLEDGE_TEXT_TOO_LONG`.

- [ ] **Step 1: Write failing tests:** `knowledge_analysis defaults to 12000 tokens`; `analysis routes through knowledge_analysis`; `allows 13 proposals at the default`; `preflight reports a missing authority, model, price or open cost case without a reservation`; `preflight is ready and estimates when all is set`; `start refuses an AI run without confirmModelUse`; `start records consent in the run`; `a site draft snapshots each selected page, at most 30`; `refuses more than 100,000 characters`; `a text without AI becomes one proposal`; `text over 1000 characters is refused with KNOWLEDGE_TEXT_TOO_LONG`; `the run records costMicros`.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement.** Share one `analysisReadiness(tx, s, preview, input)` between preflight and start so the two cannot disagree. Add the route to every task-class list the compiler names.
- [ ] **Step 4: Run** the same files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): give analysis its own route and a cost preflight`.

### Task 7: Taking text and documents over whole

**Files:**
- Modify: `apps/api/src/modules/knowledge/workspace.ts`, `actions.ts`, `permissions.ts`, `apps/api/tests/fixtures/access-matrix.json`, `apps/api/tests/module-contributions.test.ts`
- Test: `apps/api/tests/knowledge-workspace.integration.test.ts`

**Interfaces:**
- Produces: action `knowledge-content-accept { name, text, kind: "manual" | "file", language, marketing, support, publicUse, modelUse } -> source Entity`.

- [ ] **Step 1: Write failing tests:** `makes the whole text searchable under the chosen audiences`; `is refused when no audience is chosen`; `refuses text with credentials`; `only owners can use it`; `stays inside its project`.
- [ ] **Step 2: Run** `VT apps/api/tests/knowledge-workspace.integration.test.ts -t "whole text|audience|credentials"`. Expected: FAIL.
- [ ] **Step 3: Implement** by creating a `sources` entity (`authority: "official"`, `maxAgeHours: 8760`) and calling `ingest`. Update the access matrix as in Task 5.
- [ ] **Step 4: Run** the same file and the access matrix. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): take text and documents over as searchable content`.

### Task 8: The new add flow

**Files:**
- Create: `apps/web/src/modules/knowledge/add-flow.tsx`, `apps/web/src/modules/knowledge/github-page.tsx`
- Modify: `apps/web/src/modules/knowledge/workspace.tsx` (wizard and GitHub parts move out), `workspace-text.ts`, `manifest.tsx`, `knowledge.tsx`, `apps/web/src/app/globals.css`
- Test: `apps/web/src/modules/knowledge/workspace.test.tsx`

**Interfaces:**
- Consumes: actions of Tasks 5 to 7.
- Produces: `KnowledgeAddFlow({ data, refresh })`, `canUseWhole(kind)`, `canUseStatement(kind, text)`, route `knowledge-github` at path `github`.

- [ ] **Step 1: Write failing tests:** `asks what to add first`; `no longer requires a project description`; `edit project description opens its own form at ?profile=1`; `offers take-over, AI and one statement for a short text`; `hides one statement above 1000 characters`; `offers no take-over for GitHub`; `lists discovered pages by language, all preselected`; `shows cost and model on the start button when ready`; `disables the start button and links to AI settings on a blocker`; `shows no model-use checkbox`; `keeps the draft, preview and github deep links`; `links GitHub setup instead of showing credential fields`; existing wizard tests updated only where the spec changes the text.
- [ ] **Step 2: Run** `VT apps/web/src/modules/knowledge/workspace.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** by moving the wizard into `add-flow.tsx` and `GithubConfiguration` into `github-page.tsx`. Page labels use the existing `Field` and `Button`. After a step change, focus moves to the new step's heading.
- [ ] **Step 4: Run** `VT apps/web/src/modules/knowledge apps/web/src/platform/shell/routes.test.tsx` and `pnpm --dir apps/web typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): replace the setup wizard with a short add flow`.

### Task 9: Sources page for sites and analyses

**Files:**
- Modify: `apps/web/src/modules/knowledge/workspace.tsx`, `workspace-text.ts`
- Test: `apps/web/src/modules/knowledge/workspace.test.tsx`

**Interfaces:**
- Consumes: run fields from Tasks 4 and 6; actions from Task 5.

- [ ] **Step 1: Write failing tests:** `shows page count and progress of an active run`; `shows the last summary`; `offers read now and the weekly switch to owners only`; `read in content opens the page selection for gitbook and website sources`; `keeps the expert link for other source types`; `shows proposals, cost and dropped proposals of the last analysis`; `calls a previously read draft's action Edit, an unread one's Resume`.
- [ ] **Step 2: Run** `VT apps/web/src/modules/knowledge/workspace.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** in `ManagedSource` and the draft row. Poll while a site run is active, as for analysis runs.
- [ ] **Step 4: Run** the same file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): show site runs and analysis outcomes on sources`.

### Task 10: Documentation and final verification

**Files:**
- Modify: `docs/KNOWLEDGE_WORKSPACE.md`, `docs/KNOWLEDGE_ARCHITECTURE.md`, `docs/IMPLEMENTATION_STATUS.md`, `apps/web/tests/knowledge-workspace.spec.ts`

- [ ] **Step 1: Extend the browser spec** on desktop and mobile. Stub `knowledge-site-discover` and `knowledge-site-start` at the network, as `assistant-panel.spec.ts` does, because the fetcher only reads public HTTPS. Choose pages and assert the request names the excluded ones. Take a real text over whole and find it on the Sources page. Follow an AI text flow up to the disabled button without a spending authority.
- [ ] **Step 2: Update the docs** with the two ways in, the weekly update, D-6 and the first-read steps for production.
- [ ] **Step 3: Run** `pnpm lint`, `pnpm typecheck`, `VT` (whole suite), `pnpm build`, then the Knowledge browser test on the isolated stack. Expected: all pass; report any failure by name. Revert `evals/knowledge/last-deterministic-run.json` and `apps/web/next-env.d.ts` if touched.
- [ ] **Step 4: Run** `impeccable detect --json apps/web/src/modules/knowledge` and review desktop and mobile screenshots of the add flow once.
- [ ] **Step 5: Commit** `docs(knowledge): describe site sources and the add flow`.

# Knowledge: reading whole sites and a simpler add flow

Date: 2026-11-08. Status: design approved in chat by Mario (decisions D-1 to D-9 below); spec awaiting review. Builds on package 1 (commit `04d5992b`, not yet on `main`).

## Goal

An owner adds knowledge in a few understandable steps. A multi-page help site such as the FamilyPlan GitBook becomes searchable for Support as whole pages and stays current without further work. AI analysis says what it will cost and why it cannot run before the owner starts it.

## Findings this design rests on

- Orbit cannot read the FamilyPlan GitBook today. `fetchApprovedDocument` reads `/robots.txt` at the origin first, GitBook answers `307` to `/familyplan-hilfe/robots.txt`, and the fetcher refuses every redirect (`REDIRECT_NOT_ALLOWED`, reproduced with the real code on 2026-11-08).
- GitBook publishes a sitemap index with two child sitemaps: 37 German and 37 English pages. `discoverPublicPages` can parse sitemaps but has no caller, and `fetchPublicDocument` rejects XML.
- GitBook serves each page as Markdown at `<page>.md`. The tested page is 1.7 KB instead of 355 KB of HTML, without navigation noise. The first line is a blockquote addressed to AI programs and pointing to `llms.txt`.
- Documents older than `maxAgeHours` (default 168) are hidden from retrieval. The periodic sync re-reads only the latest `sync_requests` entry of a source, so one URL per source.
- `revokeDocument` writes a tombstone that makes a later `ingest` of the same page fail with `DOCUMENT_REVOKED`.
- The analysis uses the shared `agent_research` route. At its default of 3,000 output tokens it may propose at most 3 statements.
- Support drafts retrieve facts and passages with the `support` audience. The reviewed flow stores only a short quote per statement.

## Decisions

| ID | Decision |
| --- | --- |
| D-1 | Help sites enter knowledge as whole pages. The owner's review is the page selection, not each statement. This is a deliberate exception to "nothing enters retrieval before a statement is accepted", and it applies wherever the owner chooses "take over whole". |
| D-2 | Changes are taken over automatically once a week: changed pages replaced, new pages added, deleted pages removed. |
| D-3 | A site read is one durable run in batches of 20 pages, not one job per page. |
| D-4 | Pages are read as Markdown when the site offers it, otherwise as HTML. |
| D-5 | At most 200 pages per source; `maxAgeHours` is 336 so one failed weekly run hides nothing. After a failed run the next one is due 24 hours after it ended, unless the owner caused the stop (`SOURCE_INACTIVE`). |
| D-6 | Automatic removal stops when discovery returns nothing or would remove more than half of the pages. |
| D-7 | "Add knowledge" asks what to add and has three steps. The project description is optional and GitHub App setup moves to its own page. |
| D-8 | Three ways to use content, see the table below. Line-by-line proposals are removed. |
| D-9 | AI consent is the start button itself, which names the estimated cost and the model. A dedicated `knowledge_analysis` route replaces `agent_research`. |

| Content | Take over whole | AI proposes statements | Review as one statement |
| --- | --- | --- | --- |
| Text, document | yes | yes | up to 1,000 characters |
| Website, GitBook | yes (recommended) | yes, up to 30 pages and 100,000 characters | no |
| GitHub | never | yes | no |

## Reading a site

### Fetching (`packages/knowledge/src/safe-fetch.ts`)

- `fetchApprovedDocument` follows at most 3 redirects for `robots.txt` only. Each target must keep the origin and end in `/robots.txt`. Any other redirect denies access, as an unknown robots failure does today. Page fetches still refuse every redirect.
- A new `fetchDiscoveryDocument(url, policy)` applies the robots check and additionally accepts `application/xml` and `text/xml`. No other fetch accepts XML.

### Discovery (`apps/api/src/platform/knowledge/site-sync.ts`, new)

1. Try `<root>/sitemap.xml`, then `<origin>/sitemap.xml`. Both must pass the allowlist.
2. A `<sitemapindex>` is expanded one level, at most 10 children. Nothing deeper is followed.
3. Every URL passes `validatePublicUrl` against the source's origin and root path, is de-duplicated, and the list is capped at 200.
4. Without a usable sitemap the source is the single root page and `discovery` is `"single"`.

A page's language is the first path segment after the root when it is one of the project's content languages, else the source's language.

### Reading one page

- Try `<url>.md`. On anything other than `200 text/markdown`, read `<url>` as HTML.
- Drop a first-line blockquote that links to `llms.txt`.
- The title is the first Markdown heading or the HTML `<title>`, else the path.
- `externalId` and `canonicalUrl` are the page URL without `.md`, so citations open the real page and a switch between formats creates no new document.
- A page with possible credentials is skipped and counted. `containsCredentials` moves from the Knowledge module's `github.ts` to `packages/knowledge`, because platform code may not import a module.

### Source record

No migration: `sources` is a versioned JSON entity. A site source has `type` `gitbook` or `website`, plus:

```
site: { rootUrl, discovery: "sitemap" | "single", excludedPages: string[], lastRunId }
syncEveryHours: 168 | undefined   // absent when the owner switched weekly updates off
maxAgeHours: 336
```

Excluded pages are stored instead of included ones, so new pages join automatically (D-2). The FamilyPlan GitBook source is reused.

### Run (`knowledge_site_runs`, new private entity kind, not exported)

```
sourceId, trigger: "initial" | "manual" | "schedule", generation, status: queued | running | completed | failed,
pages: string[], cursor, unchanged, changed, added, removed, failed: [{ url, code }] (first 50), skippedSensitive,
embeddingsQueued, warning: "site_shrank" | null, startedAt, completedAt
```

- New queue class `knowledge_site_sync`, contributed by the platform like `ingestion`. A job processes one batch and enqueues the next with the key `site:<runId>:<cursor>`.
- Only one active run per source; a second start returns it.
- Fetching happens outside a transaction; each `ingest` runs in a short scoped transaction.
- The run stops if the source is no longer active or its generation changed, so pausing a source stops its run.
- A failing page keeps its last version and is listed in `failed`. The run still completes. Only an error of the run itself fails it.
- When a changed page's source allows model use, the active index holds embeddings, an embedding key exists and a spending authority is active, the existing `queueDocumentEmbedding` is used. Otherwise the page stays full-text searchable and nothing fails.

### Removing pages

A page whose document exists and which discovery no longer lists is retired, unless D-6 applies. Only documents whose `externalId` lies under the site root count: documents a reused source brought along are never retired. A new engine operation `retireDocument` clears the active version and invalidates dependents without purging or writing a tombstone, so a page that comes back is read as a new version. An excluded page is retired the same way. D-6 sets `warning`, and the run removes nothing.

When discovery could not finish looking (`complete: false`, or `single` on a source recorded as `sitemap`), a non-initial run reads the union of the found pages and the source's live documents, minus exclusions, capped at 200, each in its stored language. The warning and "retire nothing" stay; the pages just do not age out unnoticed.

### What a page change affects

A site run changes one page at a time, so it invalidates per page. `ingest` with `documentScoped: true` and `retireDocument` match only evidence whose items cite the document's previous active version; they do not match facts by source, and the source-wide demotion of verified facts is skipped. `KnowledgeImpact` carries `documentScoped`, and a handler then relates records only through `evidenceIds` and their content, never by source. Every other `ingest` caller keeps source-wide invalidation.

### Weekly schedule

`sourceSyncScheduler` starts a `schedule` run for an active site source whose last run is older than `syncEveryHours`, or 24 hours after a failed run (D-5). Existing sources with `syncEveryHours` but no `site` keep today's behaviour.

With `ORBIT_KNOWLEDGE_WORKSPACE` off, or Knowledge unavailable or off for the project, nobody could pause a source, so background reads stop: the sweep skips site sources and a batch ends its run as `failed` with `KNOWLEDGE_DISABLED`.

## Add flow

`/knowledge/import` keeps its deep links (`?draft=`, `?preview=`, `?github=connected`, `setupPath` of a new project).

1. **What do you want to add?** Text, document, website or GitBook, GitHub.
2. **Content.** Name plus the content, or the address. For a site, Orbit discovers the pages and lists them by language, all preselected.
3. **Use.** The ways from the table above, with the rights: Marketing and Support (both on), AI features may read it (on), public statements (on for website and GitBook content, off for text, documents and GitHub). Support retrieves as `public`, and a site's pages are public already; with public statements off Support would find none of them. The owner can still untick it. A `?site=` link on a source never read as a site prefills on; one that has a `site` keeps its stored value. While public is off and Support or Marketing is on, the step says these modules can only use the content in what customers see when the option is on.
4. **Result.** Progress and outcome.

The step indicator shows Content, Use and Result. The project description is reachable through "Edit project description". GitHub App credentials move to a new page `knowledge/github`, linked from Advanced and from a GitHub source that is not set up yet.

| Owner action (all owner-only) | Effect |
| --- | --- |
| `knowledge-site-discover` | Returns the page list for an address or source; writes nothing |
| `knowledge-site-start` | Creates the source or updates an existing one, then starts the initial run |
| `knowledge-site-refresh` | Starts a manual run |
| `knowledge-site-settings` | Weekly updates on or off, excluded pages |
| `knowledge-content-accept` | Takes text or an extracted document over whole as a searchable document |
| `knowledge-analysis-preflight` | Read-only: see below |

## AI analysis

- New task class `knowledge_analysis`: default 12,000 output tokens, `standard` tier, listed under Settings → AI as "Knowledge analysis" / "Wissensanalyse". That allows up to 13 statements. A project with its own `agent_research` route starts on the default model of the new class.
- `knowledge-analysis-preflight` takes a preview and returns `{ ready, blockers, estimateMicros, model, provider, proposalLimit }` from the same checks the start uses. It reserves nothing. Blockers link to Settings → AI.
- `knowledge-analysis-start` takes `confirmModelUse: true` for an AI run and records it in the run input. Without it an AI run is refused with `MODEL_USE_FORBIDDEN`. The checkbox disappears.
- A draft may name `pages` (at most 30). The snapshot reads them as described above, one file per page, within 100,000 characters.
- `directTextProposals` returns one proposal for the whole text; text over 1,000 characters is refused with `KNOWLEDGE_TEXT_TOO_LONG`.
- The run records `costMicros`. The source row shows proposals, cost and dropped proposals.

## Sources page additions

- A site source shows page count, progress of an active run and the last summary, plus "Read now" and the weekly switch.
- "Read in content" opens the page selection for `gitbook` and `website` sources.
- "Resume" reads "Edit" on a draft that was read successfully before.
- `knowledge_site_review` is a new attention item for a run with `warning`, with failed pages, or that failed, linking to the source. A run that ended `SOURCE_INACTIVE` or `KNOWLEDGE_DISABLED` raises none: the owner caused the first, and nobody can act on the second. The item sits behind `ORBIT_KNOWLEDGE_WORKSPACE`.

## Security and privacy

- Only owners start, change or refresh a site. The worker rechecks source status and generation at every batch.
- Fetching stays HTTPS-only, allowlisted, with pinned public addresses, no compression, bounded bytes and wall time. The only new redirect is the same-origin `robots.txt` case.
- Page text remains data. It enters retrieval under the source's rights and audiences and never reaches an instruction position.
- Automatic takeover means an edit in GitBook can reach Support answers within a week. Pausing the source stops this at once.
- Audit records stay content-free: source, run and counts.

## Testing

- Unit: robots redirects (same origin allowed, other origin and other path denied, more than 3 denied), XML only through discovery, sitemap index one level, cap, language, blockquote removal, Markdown fallback.
- Integration: initial run in batches; unchanged, changed, new and removed pages; D-6; a failing page; a page with credentials; pause stopping a run; a removed page returning; no second active run; non-owner and foreign-project refusal for every new action; preflight blockers without reservation; `confirmModelUse`; the 1,000-character limit; cost on the run.
- Safety nets: access matrix (six new owner-only actions, reviewed as security changes), queue dispatch, RLS matrix, module contributions.
- Browser: extend `knowledge-workspace.spec.ts` for the new flow on desktop and mobile with a stubbed site, no live GitBook and no paid model.

## Rollout and rollback

Risk high: background job with outside reads and automatic content changes. No migration and no schema hash. Existing flag `ORBIT_KNOWLEDGE_WORKSPACE` applies.

After deployment the owner starts the first GitBook read in the UI and checks the page count, the language split and a Support test question. Weekly updates can be switched off per source.

Rollback is a revert with one step before it.

**Before the revert:** remove `knowledge_analysis` from the task routes of every stored AI profile (project and organization AI settings). `taskRoutesSchema` in `packages/ai/src/routing.ts` is strict, so after a revert a saved `knowledge_analysis` route makes every AI configuration read of that project throw, and that takes chat, Support and Marketing down with it.

**What else a revert does:**

- The older strict `knowledgeDraft` schema rejects drafts that carry `rights` or `pages`, so those drafts can no longer be saved or previewed.
- Drafts marked `replaced` by a take-over reappear on Sources, because the older code does not know that status.
- Documents already read stay searchable until `maxAgeHours` passes, then the existing freshness warning appears. Stored `site` fields and `knowledge_site_runs` entries are ignored.

## Not in this package

Bulk review and the restructuring of the Knowledge pages (package 3), following links on sites without a sitemap, sites that need a login or JavaScript to render, and PDF files inside a site.

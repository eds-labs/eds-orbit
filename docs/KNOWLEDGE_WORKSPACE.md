# Reviewed project knowledge

`ORBIT_KNOWLEDGE_WORKSPACE=true` enables the reviewed workflow. It defaults to false and must be set consistently for the API and worker. The web uses the API's advertised feature state; it needs no public credential or separate build flag. Disabling it restores the prior navigation and forms. Existing accepted knowledge remains available under its normal rights. No database migration is needed: the new storage uses versioned Entity records, existing project RLS, and the module's declared private kinds.

## User workflow

The primary Knowledge pages are Project knowledge, Sources and To review. "Add knowledge" (`/knowledge/import`, also the `setupPath` of a new project) first asks what to add: text, document, website or GitBook, or GitHub. Three steps follow: Content, Use and Result. The project description is optional and has its own form behind "Edit project description". GitHub App credentials have their own page, `/knowledge/github`, linked from the technical area and from a GitHub source that is not set up yet. The links `?draft=`, `?preview=`, `?github=connected`, and `?site=<sourceId>` (the page selection of an existing site source) enter the flow at the matching step. PDF, TXT, Markdown and HTML uploads are limited to 1 MB, with at most 100,000 extracted characters.

### Two ways in

Content reaches retrieval in one of two ways. It is either taken over whole, where the owner's choice of content is the review, or it is reviewed statement by statement. Line-by-line proposals no longer exist. The Use step offers what fits the content:

| Content | Take over whole | AI proposes statements | Review as one statement |
| --- | --- | --- | --- |
| Text, document | yes | yes | up to 1,000 characters |
| Website, GitBook | yes (recommended) | yes, up to 30 pages and 100,000 characters | no |
| GitHub | never | yes | no |

The Use step also sets the rights: Marketing and Support (both on), AI features may read it (on) and public statements (on for website and GitBook content, whose pages are public already, and off for text, documents and GitHub). Support, Marketing and the assistant search as `public`, so a source without that right is not found for them: while it is off and Support or Marketing is on, the step and the statement review form say so. A `?site=` link on a source never read as a site prefills public statements on; one that has a `site` keeps its stored value. At least one of Marketing and Support is required. For whole takeover the rights apply to the source at once. For the two statement ways they are stored on the draft as review defaults, and `modelUse` of a confirmed statement comes from them.

Taking content over whole (decision D-1) is a deliberate exception to "nothing enters retrieval before a statement is accepted". It makes all of the content searchable under the chosen rights, with no model and no cost. It creates no facts.

AI analysis has no consent checkbox: the start button is the owner's consent and names the estimated cost and the model. `knowledge-analysis-preflight` runs the same checks as the start and reserves nothing. When something blocks the analysis, the button stays disabled and each blocker explains itself. AI-configuration blockers link to Settings → AI, `MODEL_USE_FORBIDDEN` links to Sources (a source closed to AI features is changed there), and the rest have no link. `knowledge-analysis-start` refuses an AI run without `confirmModelUse: true` with `MODEL_USE_FORBIDDEN`. A completed run records `costMicros`, and the source row shows proposals, cost and dropped proposals.

### Reading a website or GitBook

Orbit tries `<root>/sitemap.xml`, then `<origin>/sitemap.xml`, and expands a sitemap index one level (at most 10 children). Every page must stay on the source's origin and below its root path, and a source holds at most 200 pages. Without a usable sitemap the source is its single root page. The owner sees the pages by language, all preselected. Excluded pages are stored rather than included ones, so new pages join automatically. Pages are read as Markdown at `<page>.md` when the site offers it, otherwise as HTML. A page with possible credentials is skipped and counted. Sites that need a login or JavaScript to render, links on sites without a sitemap and PDF files inside a site are not read.

A read is one durable run in batches of 20 pages. A source has at most one active run, and a second start returns it and changes nothing on the source. A page that fails keeps its last version and is listed, and the run still completes. Site sources use authority `official` and `maxAgeHours` 336, so one failed weekly run hides nothing. A changed page is embedded through the existing `queueDocumentEmbedding` only when the source allows model use, the active index holds embeddings, an embedding key exists and a spending authority is active. Otherwise the page stays full-text searchable and nothing fails.

A site source on the Sources page shows its page count, the progress of an active run and the last summary; its Update, the weekly switch and "Read in content" (the page selection) are described under "Sources: one row each". A run with a warning, with failed pages, or that failed raises the attention item `knowledge_site_review`, which links to the source. A run that ended `SOURCE_INACTIVE` (the owner paused the source or changed its settings) or `KNOWLEDGE_DISABLED` raises none. "Read now" and the weekly switch appear once a source has been read as a site; before its first read a GitBook or website source offers "Read in content". Starting a site at an address that an active source already has, or that a GitBook or website source without a site covers, is refused with `KNOWLEDGE_SITE_EXISTS` and points the owner to "Read in content" on Sources.

### Weekly update and automatic removal

Unless the owner switches it off, a site source is read again every 168 hours (`syncEveryHours`; the key is absent when switched off). This applies automatically: changed pages are replaced, new pages added and deleted pages removed (D-2). An edit on the site can therefore reach Support answers within a week. Weekly updates can be switched off per source on the Use step and on the Sources page; without them the pages leave search after 14 days (`maxAgeHours` 336). After a failed run the next one is due 24 hours after it ended, unless the failure is `SOURCE_INACTIVE`. Pausing a source stops this at once: the worker rechecks source status and generation at every batch, and a run stopped that way ends as `failed` with `errorCode` `SOURCE_INACTIVE`, which the source row explains. Removals happen only after the last page, so a run stopped while reading removes nothing. With `ORBIT_KNOWLEDGE_WORKSPACE` off, or Knowledge unavailable or off for the project, nobody could pause a source, so the sweep skips site sources and a batch ends its run as `failed` with `KNOWLEDGE_DISABLED`.

A page is removed by `retireDocument`, which clears the active version and invalidates dependents without purging or a tombstone, so a page that comes back is read as a new version. A site run's changes stay on the page they concern: a changed or removed page invalidates only the evidence citing its previous version, and the content, approvals and publications built on that evidence. Evidence on other pages, verified facts of the source and anything that merely references the source stay untouched. Only documents under the site root can be retired, so documents a reused source brought along are never removed.

Automatic removal stops (D-6) when discovery returns nothing or would remove more than half of the source's live pages. The run then sets `warning: "site_shrank"` and removes nothing at all, owner exclusions included; those are retired on the next healthy run. Only pages missing from discovery count toward the 50%: an owner excluding most pages does not trip the guard. The same warning applies when discovery could not finish looking: an unreadable child sitemap, or a site recorded with a sitemap that now offers none. On such an incomplete discovery a non-initial run reads the union of the found pages and the source's live documents, minus exclusions and capped at 200, so the pages do not age out while the run reports fresh. A capped list does not set `site_shrank`: it is cut rather than complete, so the run only skips retiring missing pages. An `initial` run retires only owner exclusions and never pages merely missing from its list; the next manual or weekly run removes those after its own discovery.

### Statements and evidence

Project descriptions are setup metadata, not verified evidence for the assistant. Source text and analyst output remain in private staging records. A statement enters retrieval only after an owner accepts its proposal. Decisions select Marketing and/or Support, default to internal use, and preserve the proposal version, editor and evidence. Only the reviewed quote is ingested; the full repository never becomes a document corpus implicitly. Rejected proposals and decision versions are available in each source's history. Existing source/fact/library/import and diagnostic deep links remain reachable, with technical forms in the technical area.

Source Refresh on a reviewed draft asks for confirmation, reads a new immutable snapshot and opens its Use step. Only changed file contents are analyzed, and repeated starts reuse the active run. Successful source previews immediately withdraw affected facts and pause their reviewed document source via the shared knowledge engine before replacements can be accepted, including when subsequent AI analysis is blocked by a missing budget. Nothing is erased: the knowledge cannot be retrieved, its text and versions stay, and the proposal moves to To review as changed. Dependent evidence and module outputs receive the existing invalidation callbacks. Incomplete inventories do not prove an unseen file was removed; explicitly unreadable selected paths are withheld conservatively. Failed fetches preserve the last successfully confirmed knowledge and show the failure.

Owners decide about changed knowledge with Keep using or Remove. Keep using holds until the text changes again; a proposal that was never confirmed is simply discarded. Each confirmed statement offers Edit and Remove; removed statements, including facts withdrawn or sources paused in the expert view, appear under Removed and can be restored. Only a verified fact is withdrawn, so a restore never promotes an unreviewed one. The source of a removed or changed statement can only come back through that statement's decision, not through the expert view's resume. Removing pauses the statement's source, so other facts on that source pause with it and the dialog says so. Restoring resumes the source and confirms its verified facts again under the current generation. Edit changes the fact and the document title, because the title becomes the passage heading; the quoted evidence stays. A source revoked for good cannot be restored and needs a new analysis.

A source warning links to that source (`/knowledge/sources?source=<id>`), for drafts too. A source without any successful fetch is reported as never read. A paused source raises no freshness warning and is left out of the freshness overview. Only a source without documents or facts can be removed. The reason of the latest failed analysis stays on the source until a newer run succeeds.

The analyst distinguishes documented from implemented. Neither a repository nor generated prose proves public release. Human confirmation controls public-use rights; no live deployment status is inferred.

### Sources: one row each

The model on every page is source, then proposals, then knowledge. The Sources page renders one row per visible draft and listed source (`source-rows.ts`, `source-list.tsx`): name, kind, one status, one sentence, last read and at most one primary action. Everything else is under "More", a menu that follows the user menu pattern (it closes after a choice and stays inside the viewport on a phone). Readers see status and sentence only.

The first matching status wins: Reading, Paused, Failed (with its reason; `SOURCE_INACTIVE` and `KNOWLEDGE_DISABLED` runs do not count), n proposals waiting, Never read or Not finished, Out of date, Not read for a while, Up to date. Rows that need the owner sort first. Primary actions: Resume, Try again, Review, Read in content or Continue setup, Update. Text and uploaded documents have no Update; they can be edited.

GitHub sources and single-page website drafts get a reminder ("Not read for a while") 30 days after the last successful read. It is only a row state: there is no background check and no attention item, because Orbit does not keep user tokens and cannot read a repository on its own.

### Grouped knowledge and bulk confirm

Project knowledge and To review list statements under the five topics (description, audience, platforms, features, limitations), each with its count; empty topics are hidden and older facts without a topic go under "Other". Changed statements come first in their own group with Keep using and Remove, and are never part of a bulk confirm.

A review card shows the statement, its source name, the quote with location and link, the reason and one rights line. Confirm, Reject and Adjust (statement text and the three rights) are its buttons; stage hint, commit and history are under "More about the evidence". Owners can select cards, or all selectable cards of a topic, and a bar that stays in view (above the bottom navigation on a phone) states the effect before the click, for example "12 statements · Marketing and Support · 5 public", with the existing note that customers only see public statements. A card without any audience cannot be selected. Effective rights are the owner's edits on the card, else the draft's rights from the Use step, else Marketing and Support on and public off.

"Confirm selection" sends `knowledge-proposal-decide` one statement after another with its current version; a failure does not stop the rest. The result reads "10 of 12 confirmed"; failed cards stay selected and show their reason (for example `VERSION_CONFLICT`). The list refreshes once at the end, and leaving the page stops the remainder. No model is called. No API, action or migration changed.

### Technical area

The quiet link "Technical area" opens `knowledge/health?expert=1`. While the workspace is on, a bar above the technical pages links Sources, Facts, Conflicts, Import, Library, Status, Search check, Affected content, the GitHub App page (owners) and back to knowledge. Routes, `legacyPaths` and `?expert=1` are unchanged. Fact, index and generation appear only there, with named labels in German and English; an unknown value reads "Unknown", never the raw key. The status page no longer lists missing evidence; the same records are on "Affected content".

## GitHub App setup (separate introduction step)

Create a GitHub App for the intended GitHub.com account. Set repository permissions to Contents: read and Metadata: read, install on **selected repositories**, and disable provider webhooks for this initial manual-refresh release. Use the installation URL linked by Orbit.

On the owner's GitHub page (`/knowledge/github`, linked from the technical area), enter App ID, app slug, OAuth Client ID, Client secret and the RSA private App key. Credentials are encrypted with the existing credential key and never returned by reads or project exports. Updating App settings invalidates existing connection bindings; connect again afterward.

Set the app's authorization callback URL to:

```
https://<orbit-host>/api/projects/<project-id>/knowledge/github/callback
```

Register the exact callback for each project connecting the app. Orbit sends the same exact URL as `redirect_uri` for authorization and exchange. The callback is an authenticated, owner-only API route. It consumes a random, expiring, one-use state bound to that project, user, draft and configuration version. Orbit exchanges the authorization code, then reads the authenticated user's app installations. A posted installation ID alone cannot establish access. The resulting connection is bound to both the workspace and project, and is excluded from generic collection reads and exports.

After installation, choose Connect with GitHub in Orbit. The user-authorized repository list determines which repositories can be selected. Before reading or sending content to a model, Orbit checks that access again. It generates an installation token restricted to that exact numeric repository ID and read permissions. Revoked/expired user access requires reconnecting; the initial implementation does not persist or rotate GitHub user refresh tokens. The installation token itself is generated as needed and is never stored in browser state.

Default selection: `README.md` and `docs/`, on the repository's default branch. Owners may choose another branch and explicit paths. All files in one preview use the same commit SHA. The reader allows at most 30 files and 100 KB of decoded text in total, excludes secret paths, key/token patterns, binaries, dependencies and generated output, and reports skipped files or a truncated Git tree as a partial scan. Repository code, hooks and scripts are never run. Git submodules and external symlink targets are not followed. Repository discovery is bounded to 1,000 accessible repositories per installation.

## API and storage

All routes live under `/api/projects/:projectId` and retain the Knowledge module activation/role checks.

| Read | Result / permission |
| --- | --- |
| `GET /knowledge-workspace` | Feature state, setup profile, logical sources, runs without raw snapshots, proposals, legacy facts and sources; Knowledge readers |
| `GET /knowledge/previews/:id` | Unexpired preview summary for an unchanged draft; owner |
| `GET /knowledge/proposals/:id/history` | Project-scoped version history; Knowledge readers |
| `GET /knowledge/github` | Configured state, safe installation identifiers and install link; owner |
| `GET /knowledge/github/repositories?connectionId=...` | Authorized repository choices; owner |
| `GET /knowledge/github/callback` | One-use OAuth exchange and redirect to the saved draft; owner |

Owner-only project actions use the existing `POST /actions/:name` dispatcher:

- `knowledge-profile-save`: description, audience, setup step.
- `knowledge-draft-save`: source input, optional id/expected version, and `partial` for unfinished setup.
- `knowledge-file-read`: bounded filename/base64 input → extracted text, without ingestion.
- `knowledge-draft-preview`: draft ID → immutable snapshot and safe preview summary.
- `knowledge-analysis-preflight`: preview ID → `{ ready, blockers, estimateMicros, model, provider, proposalLimit }`; read-only, reserves nothing.
- `knowledge-analysis-start`: preview ID and `confirmModelUse: true` for an AI run → durable analysis run; duplicate active starts reuse it.
- `knowledge-analysis-cancel`: run ID; cancellation prevents promotion even if a transmitted model response arrives later.
- `knowledge-proposal-decide`: proposal ID/expected version, accept/reject, optional edited statement, public-use right and module audiences.
- `knowledge-proposal-remove`, `knowledge-proposal-restore`: proposal ID/expected version; take a statement out of use, or bring removed, changed or withdrawn knowledge back.
- `knowledge-proposal-edit`: proposal ID/expected version and the corrected statement.
- `knowledge-github-configure` and `knowledge-github-connect`: encrypted App configuration and authorization start.
- `knowledge-content-accept`: name, text, kind, language, rights, optional draft ID → takes text or an extracted document over whole as one searchable document; refused with `KNOWLEDGE_SENSITIVE_TEXT_EXCLUDED` for possible credentials.
- `knowledge-site-discover`: address or source ID → page list by language; writes nothing.
- `knowledge-site-start`: address or source ID, name, rights, `excludedPages`, `autoUpdate`, optional draft ID → creates or updates the site source and starts the `initial` run; `started: false` when it hands back an active run.
- `knowledge-site-refresh`: source ID → starts a `manual` run, or returns the active one.
- `knowledge-site-settings`: weekly updates on or off, excluded pages.

A draft named by `knowledge-content-accept` or `knowledge-site-start` is marked replaced and is hidden from Sources and counts.

Input/output schemas shared with the web are in `packages/schemas/src/knowledge-workspace.ts`. The additive private kinds are `knowledge_profiles`, `knowledge_drafts`, `knowledge_previews`, `knowledge_runs`, `knowledge_proposals`, `knowledge_github_config`, `knowledge_github_connections`, `knowledge_github_oauth` and `knowledge_site_runs`. Generic collection access and exports do not expose these kinds. The explicit management read APIs expose them only inside the authorized project. Run snapshots never enter documents/chunks until review. Content-free audit events record queued/completed analysis, accepted/rejected decision identifiers, and for sites and whole takeover the source, run and counts.

A site source is a `sources` entity of type `gitbook` or `website` with `site: { rootUrl, discovery, excludedPages, lastRunId }`, so no migration is needed. The workspace read also returns the latest run per site source.

The `knowledge_analysis` worker rechecks the initiating owner's membership, module and feature activation, source consent, project pause, current model configuration and spend mandate. It routes through its own task class `knowledge_analysis` (`docs/MODEL_ROUTING.md`), reserves the existing AI budget, makes one tool-free structured response call and settles reported usage. Invalid model output has known settled cost and never creates proposals. A transmitted call with an ambiguous result retains unknown spend and cannot automatically be retried. Reconcile the reservation through the existing budget operations before starting another analysis.

## Local validation and introduction

Use Node from `.nvmrc` and pnpm from `package.json`. Run `node scripts/test-db-for-worktree.ts` for an isolated local test database. Never reset the shared test database. The browser seed script refuses every database except this feature worktree's isolated `orbit_test_eds_orbit_knowledge_*` database.

```
pnpm install --frozen-lockfile
pnpm db:generate
pnpm typecheck
pnpm lint
pnpm test
pnpm build
ORBIT_CONFIG_FILE=.runtime/local.env pnpm api:generate
```

For the optional real-browser test, start API/web/worker against that isolated database with the feature enabled and matching origins, create synthetic credentials with `node --env-file=.runtime/local.env --import tsx scripts/seed-knowledge-e2e.ts`, and run:

```
KNOWLEDGE_E2E=true PLAYWRIGHT_BASE_URL=http://localhost:4320 pnpm exec playwright test apps/web/tests/knowledge-workspace.spec.ts
```

The test covers desktop and mobile: the add flow, a real queued single-statement analysis, review, acceptance, evidence history, search, navigation, edit, remove and restore, a real text taken over whole and found on Sources, an AI flow that ends at the disabled start button without a spending authority, and page selection for a site whose `knowledge-site-discover` and `knowledge-site-start` are stubbed at the network. It uses no live site, no live GitHub repository and no paid model call. Do not run its worker concurrently with the integration suite against the same test database. Provider transport tests use synthetic installations, keys, commits and responses.

Production introduction is separate: register/install the GitHub App, enter production credentials, deploy the tested revision, enable the flag consistently, then perform the first explicitly authorized FamilyPlan import and review. Check worker state, source counts, partial scans, pending reviews and unknown budget reservations. Disabling the flag stops new workflow jobs and restores the old interface without deleting staging or confirmed knowledge. Existing source/fact revocation remains available for accepted content.

### First site read in production

Site sources need no migration and no schema hash; the existing flag `ORBIT_KNOWLEDGE_WORKSPACE` applies. Risk is high, because a background job reads outside sites and changes content automatically. As of this writing the work is not deployed and the first read has not happened.

1. After deployment the owner opens the FamilyPlan GitBook source on Sources, chooses "Read in content" and starts the read in the UI. The existing source is reused. Decide there whether weekly updates stay on.
2. Check the page count against the site (the GitBook published 37 German and 37 English pages on 2026-11-08) and the language split.
3. Ask a Support test question that a page answers, and open the citation.
4. Weekly updates can be switched off per source. Pausing a source stops a run at once and stops automatic changes from reaching Support.

Rollback is a code revert with one step before it.

**Before the revert:** remove `knowledge_analysis` from the task routes of every stored AI profile (project and organization AI settings). `taskRoutesSchema` in `packages/ai/src/routing.ts` is strict, so after a revert a saved `knowledge_analysis` route makes every AI configuration read of that project throw, and that takes chat, Support and Marketing down with it.

**What else a revert does:**

- The older strict `knowledgeDraft` schema rejects drafts that carry `rights` or `pages`, so those drafts can no longer be saved or previewed.
- Drafts marked `replaced` by a take-over reappear on Sources, because the older code does not know that status.
- Documents already read stay searchable until `maxAgeHours` passes, then the existing freshness warning appears. Stored `site` fields and `knowledge_site_runs` entries are ignored.

## Validation evidence (local, 2026-10-20)

- Final integrated targeted run: 124 tests passed in 11 files, including Knowledge provider/review/UI/isolation/queue coverage and the concurrent Support taxonomy/gateway changes. The Knowledge SQL subset passes 27 cases, including missing provider credentials before reservation, preview-time invalidation, failed-fetch preservation, cancellation and reverted-file scenarios.
- Real-stack browser workflow: desktop 1440 px and mobile 390 px, both passed. Screenshots are ignored local artifacts under `.runtime/knowledge-desktop.png` and `.runtime/knowledge-mobile.png`; each uses synthetic FamilyPlan data. The confirmation pass asserts exactly the three intended primary entries, with no Facts or Import entry.
- Typecheck, production build, source/import boundaries, Compose and secret-pattern scan passed. Framework validation passed after naming the UI text module `workspace-text.ts`.
- The design detector found only the pre-existing `globals.css` line with `border-left: 3px solid #a7d0f3` outside this patch. No existing unrelated style was changed to silence it.
- The existing I7b agent resume regression was independently reproduced against unchanged commit `dd902d8`, in a disposable worktree and its own isolated database. That worktree and database were removed afterward. It expects a paused agent job to return to queued but observes blocked_dependency / PROJECT_PAUSED. This feature changes no agent resume behavior.
- No real GitHub installation, private repository, paid provider call, production credential or deployment was used in this validation.

The broad suite recorded 2,864 passes and three failures across 267 files (506.96 seconds). One was the independently reproduced baseline I7b failure. Two Support renderer import failures occurred when the concurrent upstream Support commit was integrated during that run; both exact failed tests pass in the fresh integrated 124-test run. The broad run is therefore not represented as entirely green. Current build, lint, typecheck and focused integration/browser results are separate evidence.

## Analysis output limits and diagnostics (2026-10-20)

Model output is bounded by the configured route of the `knowledge_analysis` task class: the analyst requests at most `floor(maxOutputTokens / 900)` concise proposals with short whole-line evidence quotes, 13 at the default of 12,000 output tokens and never more than 30. Source selection and the model's output are separate limits; reading one README does not imply that every statement will be proposed. No automatic paid retry occurs.

Completed calls record content-free input/output token counts, the output ceiling and proposal limit in the run. A response reaching the ceiling is rejected as `KNOWLEDGE_OUTPUT_LIMIT` after settling its known usage; incomplete or invalid JSON never enters knowledge. Model verification and price readiness failures are preserved before reservation. The UI understands both structured worker codes and transport-humanized action errors, and explains missing consent, incorrect PEM format, model routing and output limits.

Live FamilyPlan introduction (2026-10-20, then on the shared `agent_research` route at 3,000 output tokens): GitHub installation and project authorization succeeded; the selected README was read. The initial model route used an unverified OpenAI model despite configured Claude credentials. Switching the project default to its saved Claude provider resolved readiness. One subsequent response was rejected as invalid output and settled at 38,908 micros (USD 0.038908), with no unknown or pending reservation. The old run did not retain enough diagnostics to prove truncation; output bounding and diagnostics address that uncertainty without replaying it.

Validation for the output-limit correction: 46 focused SQL/provider/UI tests passed; typecheck, lint/import boundaries, build, API generation and the bounded secret scan passed. Synthetic tests cover settled truncation without promotion or retry, unchanged evidence gates, route readiness before reservation and actionable errors. Risk is high because the code handles paid analysis; budget/consent/reservation guards remain unchanged. Rollback is a code revert; the additional diagnostic metadata is additive and requires no migration. Live verification uses only the already authorized FamilyPlan README and remains within its active USD 1 per-run / USD 10 monthly mandate.

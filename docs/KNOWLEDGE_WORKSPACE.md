# Reviewed project knowledge

`ORBIT_KNOWLEDGE_WORKSPACE=true` enables the reviewed workflow. It defaults to false and must be set consistently for the API and worker. The web uses the API's advertised feature state; it needs no public credential or separate build flag. Disabling it restores the prior navigation and forms. Existing accepted knowledge remains available under its normal rights. No database migration is needed: the new storage uses versioned Entity records, existing project RLS, and the module's declared private kinds.

## User workflow

The primary Knowledge pages are Project knowledge, Sources and To review. A new project opens the resumable four-step setup. Add a description and audience, choose a text/document/web page/GitHub source, inspect its bounded selection, and submit it for analysis. An owner can save unfinished setup and resume from Sources. Text can be submitted without a model; model analysis is explicit opt-in and requires the existing paid AI mandate. PDF, TXT, Markdown and HTML uploads are limited to 1 MB, with at most 100,000 extracted characters.

Project descriptions are setup metadata, not verified evidence for the assistant. Source text and analyst output remain in private staging records. Nothing enters retrieval before an owner accepts a proposal. Decisions select Marketing and/or Support, default to internal use, and preserve the proposal version, editor and evidence. Only the reviewed quote is ingested; the full repository never becomes a document corpus implicitly. Rejected proposals and decision versions are available in each source's history. Existing source/fact/library/import and diagnostic deep links remain reachable, with technical forms under Advanced.

Source Refresh reads a new immutable snapshot and opens its selection preview. Only changed file contents are analyzed, and repeated starts reuse the active run. Successful source previews immediately withdraw affected facts and revoke their reviewed document source via the shared knowledge engine before replacements can be accepted, including when subsequent AI analysis is blocked by a missing budget. Dependent evidence and module outputs receive the existing invalidation callbacks. Incomplete inventories do not prove an unseen file was removed; explicitly unreadable selected paths are withheld conservatively. Failed fetches preserve the last successfully confirmed knowledge and show the failure.

The analyst distinguishes documented from implemented. Neither a repository nor generated prose proves public release. Human confirmation controls public-use rights; no live deployment status is inferred.

## GitHub App setup (separate introduction step)

Create a GitHub App for the intended GitHub.com account. Set repository permissions to Contents: read and Metadata: read, install on **selected repositories**, and disable provider webhooks for this initial manual-refresh release. Use the installation URL linked by Orbit.

In the owner's Add knowledge → GitHub → App settings, enter App ID, app slug, OAuth Client ID, Client secret and the RSA private App key. Credentials are encrypted with the existing credential key and never returned by reads or project exports. Updating App settings invalidates existing connection bindings; connect again afterward.

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
- `knowledge-analysis-start`: preview ID → durable analysis run; duplicate active starts reuse it.
- `knowledge-analysis-cancel`: run ID; cancellation prevents promotion even if a transmitted model response arrives later.
- `knowledge-proposal-decide`: proposal ID/expected version, accept/reject, optional edited statement, public-use right and module audiences.
- `knowledge-github-configure` and `knowledge-github-connect`: encrypted App configuration and authorization start.

Input/output schemas shared with the web are in `packages/schemas/src/knowledge-workspace.ts`. The additive private kinds are `knowledge_profiles`, `knowledge_drafts`, `knowledge_previews`, `knowledge_runs`, `knowledge_proposals`, `knowledge_github_config`, `knowledge_github_connections` and `knowledge_github_oauth`. Generic collection access and exports do not expose these kinds. The explicit management read APIs expose them only inside the authorized project. Run snapshots never enter documents/chunks until review. Content-free audit events record queued/completed analysis and accepted/rejected decision identifiers.

The `knowledge_analysis` worker rechecks the initiating owner's membership, module and feature activation, source consent, project pause, current model configuration and spend mandate. It routes through `agent_research`, reserves the existing AI budget, makes one tool-free structured response call and settles reported usage. Invalid model output has known settled cost and never creates proposals. A transmitted call with an ambiguous result retains unknown spend and cannot automatically be retried. Reconcile the reservation through the existing budget operations before starting another analysis.

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

The test covers desktop and mobile, a real queued manual-source analysis, review, acceptance, evidence history, search, navigation and legacy diagnostics. It uses no live GitHub repository or paid model call. Do not run its worker concurrently with the integration suite against the same test database. Provider transport tests use synthetic installations, keys, commits and responses.

Production introduction is separate: register/install the GitHub App, enter production credentials, deploy the tested revision, enable the flag consistently, then perform the first explicitly authorized FamilyPlan import and review. Check worker state, source counts, partial scans, pending reviews and unknown budget reservations. Disabling the flag stops new workflow jobs and restores the old interface without deleting staging or confirmed knowledge. Existing source/fact revocation remains available for accepted content.

## Validation evidence (local, 2026-10-20)

- Final integrated targeted run: 124 tests passed in 11 files, including Knowledge provider/review/UI/isolation/queue coverage and the concurrent Support taxonomy/gateway changes. The Knowledge SQL subset passes 27 cases, including missing provider credentials before reservation, preview-time invalidation, failed-fetch preservation, cancellation and reverted-file scenarios.
- Real-stack browser workflow: desktop 1440 px and mobile 390 px, both passed. Screenshots are ignored local artifacts under `.runtime/knowledge-desktop.png` and `.runtime/knowledge-mobile.png`; each uses synthetic FamilyPlan data. The confirmation pass asserts exactly the three intended primary entries, with no Facts or Import entry.
- Typecheck, production build, source/import boundaries, Compose and secret-pattern scan passed. Framework validation passed after naming the UI text module `workspace-text.ts`.
- The design detector found only the pre-existing `globals.css` line with `border-left: 3px solid #a7d0f3` outside this patch. No existing unrelated style was changed to silence it.
- The existing I7b agent resume regression was independently reproduced against unchanged commit `dd902d8`, in a disposable worktree and its own isolated database. That worktree and database were removed afterward. It expects a paused agent job to return to queued but observes blocked_dependency / PROJECT_PAUSED. This feature changes no agent resume behavior.
- No real GitHub installation, private repository, paid provider call, production credential or deployment was used in this validation.

The broad suite recorded 2,864 passes and three failures across 267 files (506.96 seconds). One was the independently reproduced baseline I7b failure. Two Support renderer import failures occurred when the concurrent upstream Support commit was integrated during that run; both exact failed tests pass in the fresh integrated 124-test run. The broad run is therefore not represented as entirely green. Current build, lint, typecheck and focused integration/browser results are separate evidence.

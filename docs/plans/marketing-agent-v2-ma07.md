# MA-07 — period/source-aware reporting

## Risk Level / Environment
High / local. Base `e176be4` (MA-06), fetched main `333231f4` verified as an
ancestor. Branch `codex/marketing-agent-v2-ma07`. Primary profile: data pipeline;
AI-agent and fullstack rules supplement it. Existing modular monolith/preset and
scheduler/Entity/ActionRequest/notification/attention architecture are retained.
No new dependencies, paid providers, live publishing, deployment or production flags.

## Plan before implementation
1. Make stored metric aggregation dimension/period aware and expose specialist
   sampling limits; serialize imports/corrections and preserve stable metric IDs.
2. Persist one versioned report per plan/closed local period, with exact source
   snapshots, explicit no-data/partial states, publication attribution audit and
   separate source totals. Corrections invalidate reports and their proposals.
3. Schedule closed weekly reports and refresh invalidated reports through the
   existing sweep. Persist native owner attention independently of Telegram;
   reuse one optional notification event key per period and exact owner receipt.
4. Prepare a non-executing report-driven revision candidate. Materialize it only
   through the existing native strategic proposal/review path as a separate draft,
   retaining the active plan and its exact activation mandate.
5. Add report UI/routes, offline integration/browser regressions, full checks,
   changed-file/result documentation and MA-08 preparation only.

## Threat / test / rollback
Misattributed or double-counted measurements could cause unjustified spend changes.
Never join metrics by similar labels or add different source/account/currency/zone
or report denominators together. Preserve missing counters as unknown; flag overlap,
partial provider coverage and source/channel sampling. Do not claim causal results.
Reports confer no publication, source-use or spending authority. Keep report
assignments disabled until their distinct paid-task execution lifecycle is complete.
Current membership/module permissions guard every user read/write and native receipt;
background report generation reads only stored aggregates and never contacts providers.
Tests cover replay/races, corrections, no-data, four channels, source separation,
owner receipt, stale proposals, revoked/foreign roles and unchanged active mandates.
Cost: zero new model calls; bounded report generation reads. Metric-correction
invalidation scans the project report history, as documented below. Rollback: code revert; no new
schema migration or production operation. Existing opaque-ID Entity history remains.

## Implemented behavior

### Evidence and corrections
`analytics/metric-report.ts` supplies common source/account/report-family/currency/
timezone grouping to specialist summaries and the existing insight analyzer. Null
counters remain unknown; overlapping cumulative observations and unsafe integer
sums are withheld. Cross-source totals and causal claims are not produced.
Per-source observed days/freshness are visible and never establish full-period
coverage. The report distinguishes project measurements from explicit plan
attribution; project traffic alone is not evidence of plan performance.

A project-scoped advisory transaction lock serializes imports, corrections and
report snapshots. Matomo replay keeps stable metric IDs and unchanged versions;
concurrent replays create one identity. CSV retains its existing explicit conflict
workflow and now serializes duplicate imports. Corrections invalidate reports that
reference that metric. Approval/receipt guards also compare current rows/versions,
so new imports cannot make an old candidate approvable before the next sweep.
Matomo's yesterday/today schedule now subtracts a calendar day in the site's zone,
which avoids skipping yesterday after a short DST day.

### Report lifecycle and owner delivery
One internal `marketing_reports` Entity per plan and closed local date range stores
native version history, source refs, report revision, strategy snapshot, bounded
project and attributed groups, known publication IDs, and coverage/limitations.
The first report fixes the timezone/horizon for that period. Historical corrections
use that original strategy even when the live plan has moved to another horizon.
The scheduler generates the previous closed local Monday–Sunday week for active
plans and refreshes invalidated reports through the existing project sweep.
Project pause/module/agent gates remain in place. No report fetch contacts a provider.

Native owner attention exists without Telegram. Exact owner acknowledgement covers
the current revision; a corrected revision becomes visible under the same report ID.
The optional Telegram job uses `notify:marketing_report:<reportId>` once per period,
including revisions, and renders current evidence at dispatch. Existing sender
membership/module/owner checks remain binding; stale reports are not sent.

`marketing_report_status` and `marketing_report_propose_revision` are deferred
contributions to the existing Orbit Assistant. The read tool bounds its transport
and exposes omitted source groups. The proposal tool is `P_proposal`, not an
execution tool. No second assistant, provider, transport or spending loop was added.

### Attribution and revision proposals
Attribution audits only confirmed publications and exact native publication IDs or
an explicit opaque campaign key. Similar campaign names and bare remote IDs are
not joined. A prepared future URL uses an opaque plan key and preserves an existing
campaign parameter. It is explicitly not applied to existing content or releases.
Missing confirmed publication IDs remain a visible limitation; a Postiz draft or
ambiguous handoff is not declared a measured publication.

The candidate refreshes KPI references only from one unambiguous attributed source
with known counters, positive samples and at most ten native metric references.
Otherwise its baseline stays `no_data`. No target, conversion rate or causal
recommendation is invented. Materialization uses the existing strategic proposal
and ActionRequest service as a separate sibling plan, with an exact report-origin
binding. The active plan and owned assignments remain unchanged. Owned children
are linked at current versions for accurate budget accounting; linking is not
adoption or activation. Budget/channel/cadence increases remain pending and outside
policy ceilings are still refused. Default start moves into the remaining horizon;
its end is not silently extended. An expired horizon requires an explicit fresh spec.

Metric changes block old report-derived strategic reviews/activations, including
pending native ActionRequests. Read acknowledgement alone changes no evidence hash.
No report proposal grants publishing authority or approves unseen content.

### UI and API
The existing Analytics page now displays source-separated period evidence, nulls,
observed days/freshness, specialist channel/post/recent-day caps, attribution audit,
receipt and a link to the native proposed strategy. Report deep links fetch the exact
report even outside the latest twenty list rows. The affected analytics toolbar wraps
on mobile, and report forms use existing controls and a stacked mobile layout.

API: `GET/POST /api/projects/:projectId/marketing-reports`,
`GET /api/projects/:projectId/marketing-reports/:id`, and owner-only `POST .../:id/acknowledge`
plus writer `POST .../:id/proposal`. Authentication/current module roles precede body
validation. There is no generic write collection for report Entities. The access
matrix adds these five routes only; existing route/role expectations are unchanged.
OpenAPI and the generated client were regenerated. Assistant characterization changes
are the reviewed report guidance/tool discovery additions.

## Remaining limits

- Report assignments remain disabled. Periodic reports run through the existing
  plan/sweep lifecycle, without opening the separate paid specialist-assignment
  execution path. This phase does not claim that unfinished path is enabled.
- Reports use stored aggregates, not a new live Postiz/Matomo fetch. Unknown/missing
  source days and the specialist's three-channel/five-post/seven-day sampling are
  explicit; a four-channel plan is never described as completely sampled.
- Attribution is an audit and prepared future link. Existing approved texts/links
  are not rewritten. Legacy campaign labels without exact attribution stay in the
  project section; live attribution acceptance requires a separately authorized pilot.
- A report scans 1,000 metrics and 200 content/publication rows with sentinels, and
  exposes at most 20 source groups. Overflow marks evidence incomplete. Scheduling
  considers twenty recent active plans and refreshes twenty invalidated reports per
  sweep; larger installations can generate an exact plan/period manually. The UI
  lists twenty reports with explicit truncation and exact-ID deep links.
- Metric-correction invalidation scans the stored project report history to invalidate
  every dependent report. Large historical corpora need indexed dependency lookup
  and retention work before scaling; the generation/UI/sweep caps do not bound that
  correction fan-out.
- Proposals are conservative evidence/baseline updates, not automated causal strategy
  optimization or authority transfers. Expired horizons, stale source/policy/asset
  references and native work-link limits require a fresh explicit proposal. Native
  review and exact owner activation remain separate from report generation.
- No paid API, real Postiz/Telegram send, production flag/schema migration,
  branch push, deployment or live pilot acceptance occurred.

## MA-08 preparation only

Next: make project selection → assistant → saved plan → pending review the obvious
accessible route on desktop/mobile. Reuse the report deep links and the existing
Marketing shell/overview, chat cards and insights page. Keep Creator/manual missions/
assignments directly reachable, preserve legacy links, module-disabled and role-bound
navigation, and approvals from other modules. Start from this local MA-07 commit,
verify current main/in-flight work, and keep live/paid pilot rollout separately gated.
No MA-08 navigation redesign or MA-09 pilot is implemented here.

## Verification

The successful final full regression ran with frozen application/test source. No
application/test file changed during it. All results below are local verification;
no production rollout or live pilot acceptance is inferred.

| Check | Result |
| --- | --- |
| Final full regression | **3,026 tests passed in 278 files**, 514.93 seconds, dedicated local database |
| New report lifecycle/native-review cases | 17 tests passed |
| Recurring workflow and registry after fixture update | 40 tests passed in 2 files |
| Matomo import replay/concurrency/calendar cases | 11 tests passed |
| API access matrix / assistant characterization | 4 / 2 tests passed; five additive routes and reviewed report/tool snapshot changes |
| Desktop/mobile Playwright | 1 scenario passed, 1280×900 and 390×844; persisted receipt, exact deep link, native pending proposal, zero assignments/publications/drafts and no horizontal overflow |
| Lint / root and web typecheck / production build | Passed with final application source |
| OpenAPI / generated client | Regenerated, additive report routes only |
| Framework / secrets / diff / import boundaries | Passed, zero framework warnings/errors and zero import-boundary violations |

The full suite exposed a pre-existing wall-clock/DST-dependent MA-00/01 fixture.
It also fails unchanged at MA-06 (`e176be4`): its eight-day horizon can end before
the second weekly slot. The test horizon now covers the actual fixture slot; the
production horizon guard and repeated-publication assertions are unchanged. The
registry test explicitly lists the two new deferred report tools. Both files pass
all 40 tests after these updates.

Final native-review inspection found and closed an additional stale-evidence gap:
`validateSaved` now compares the live bounded metric snapshot as well as the saved
report status/hash. A seventeenth report case proves that newly imported rows block
both native ActionRequest approval and execution validation before the next sweep.
The focused report file passes all 17 tests; the successful final full run uses this source.

Final application/test source manifest: 974 files, SHA-256
`c5c29041814022a7813eb24078544bb6b7989d9ab884f0fab98ba060e7096714`.
The temporary manifest and deterministic-eval result are restored to HEAD rather
than included as product changes.

### Reproduction and isolation

Runtime: Node 24.18.0, pnpm 11.19.0, Vitest 5.0.1. The local test database is
`orbit_test_eds_orbit_marketing_ma07_7822d6`, with a dedicated Redis namespace.
Prepare an equivalent worktree-specific database using `node scripts/test-db-for-worktree.ts`;
its `.runtime/test.env` overrides the shared local runtime settings during tests.
No production database or provider is involved.

Checks: `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm build`,
`corepack pnpm api:generate`, `corepack pnpm framework:check`,
`corepack pnpm secrets:check`, `git diff --check`, `git diff --cached --check`.
Full regression: `node --env-file=<local-runtime-env> node_modules/vitest/vitest.mjs run`.
Focused tests include `apps/api/tests/marketing-reports.integration.test.ts`,
`apps/api/src/modules/marketing/analytics/matomo.integration.test.ts`, the route
access matrix, assistant characterization, attention query budget and existing
recurring workflow/specialist/publishing regressions.

Browser: run `node --env-file=<local-runtime-env> scripts/marketing-reports-browser.ts`
with the built local Next server at port 44430 pointing to the fixture API on 44431;
then `MARKETING_REPORT_E2E=true node --env-file=<local-runtime-env>
node_modules/@playwright/test/cli.js test --config scripts/marketing-reports-browser.config.ts`.
The fixture uses synthetic aggregates, a temporary account/project and no worker.
After the successful scenario, both servers were stopped and the fixture account,
project and credential file removed. Screenshots remain ignored local evidence.

## Changed files

- `apps/api/src/modules/agents/tools/registry.test.ts`
- `apps/api/src/modules/marketing/actions.ts`
- `apps/api/src/modules/marketing/agents/notification-messages.ts`
- `apps/api/src/modules/marketing/agents/notifications.ts`
- `apps/api/src/modules/marketing/agents/specialists/analytics.ts`
- `apps/api/src/modules/marketing/agents/specialists/runner.ts`
- `apps/api/src/modules/marketing/analytics/lifecycle.ts`
- `apps/api/src/modules/marketing/analytics/matomo-schedule.ts`
- `apps/api/src/modules/marketing/analytics/matomo.integration.test.ts`
- `apps/api/src/modules/marketing/analytics/matomo.ts`
- `apps/api/src/modules/marketing/analytics/metric-report.ts`
- `apps/api/src/modules/marketing/analytics/report-evidence.ts`
- `apps/api/src/modules/marketing/analytics/report-routes.ts`
- `apps/api/src/modules/marketing/analytics/report-schedule.ts`
- `apps/api/src/modules/marketing/analytics/reports.ts`
- `apps/api/src/modules/marketing/assistant/prompt.ts`
- `apps/api/src/modules/marketing/attention.ts`
- `apps/api/src/modules/marketing/manifest.ts`
- `apps/api/src/modules/marketing/pipeline/workflow.ts`
- `apps/api/src/modules/marketing/plans/service.ts`
- `apps/api/src/modules/marketing/routes.ts`
- `apps/api/src/modules/marketing/scheduler.ts`
- `apps/api/src/modules/marketing/tools/agent-tools.ts`
- `apps/api/src/modules/marketing/tools/index.ts`
- `apps/api/src/modules/marketing/tools/report-tools.ts`
- `apps/api/tests/__snapshots__/assistant-request.characterization.integration.test.ts.snap`
- `apps/api/tests/attention-marketing.integration.test.ts`
- `apps/api/tests/fixtures/access-matrix.json`
- `apps/api/tests/marketing-agent-v2.integration.test.ts`
- `apps/api/tests/marketing-reports.integration.test.ts`
- `apps/web/src/app/globals.css`
- `apps/web/src/modules/marketing/attention.tsx`
- `apps/web/src/modules/marketing/insights.tsx`
- `apps/web/src/modules/marketing/reports.test.tsx`
- `apps/web/src/modules/marketing/reports.tsx`
- `apps/web/tests/marketing-reports.spec.ts`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/REQUIREMENTS_TRACEABILITY.md`
- `docs/plans/marketing-agent-v2-ma07.md`
- `packages/api-client/src/generated.ts`
- `packages/schemas/openapi.json`
- `scripts/marketing-reports-browser.config.ts`
- `scripts/marketing-reports-browser.ts`

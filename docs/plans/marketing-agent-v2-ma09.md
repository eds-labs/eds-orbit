# MA-09 — gated uLiquid Desk pilot

## Risk Level / Environment
High for local integration/read-only live inspection; critical for any later live
write or deployment. Primary profile: AI agent app, supplemented by release and
production rules. Existing stack and native approval/readiness/budget/publishing
services are retained. This phase adds no main agent, provider or production flag. A narrow dependency
audit remediation is documented below.

## Plan before work
1. Integrate MA-08 `e9c5d9d` with current main `b9288c85`; preserve both independent
   status-document histories and upstream customer-context contract/test changes.
2. Verify the resulting local source with fresh required checks and deterministic
   recurring/recovery/report/navigation evidence. Local tests never attest live state.
3. Read live uLiquid project authority, readiness, sources, channel/policy scope and
   deployment records without changing them or calling paid providers.
4. Record each §9 gate as observed, unknown, blocked or awaiting approval. Prepare a
   concrete release/pilot sequence and an append-only two-week evidence worksheet.
5. Present the next actionable approval only after the exact source, changes, risk,
   rollback and unresolved runtime prerequisites are reviewable. Do not treat this
   work request as blanket permission to override the original no-paid/no-Postiz/
   no-production-deployment conditions or the plan's separately authorized live gate.

## Threat / validation / rollback
A healthy container, successful local suite or existing policy does not establish
that MA-00–08 is deployed or authorized. Existing assignments must not be re-confirmed,
resumed, enrolled or converted implicitly. Unknown paid/provider outcomes stop replay.
Readiness receipts must belong to the exact revision/project/channel/index and actual
provider. Require owner approval for exact content/media before any external handoff,
including Postiz drafts. No direct production DB access, credential exposure, blanket
flag activation, paid model call, send, scheduled task or monitoring job is performed.

The live pilot cannot be accepted without two real weekly cycles, exact publication
reconciliation and a delivered measured/no-data report. Synthetic clocks do not count.
Rollback must retain the human-each guard while such assignments exist: pause new v2
work and reconcile external intents, then use a reviewed compatible binary. Do not
roll back by deleting publications or replaying unknown writes.

## Current state
Read-only preflight is complete for the available connector projections. Local validation
is complete on candidate `8af5d09`. **MA-09 is not accepted; no live pilot has started.**


## Read-only preflight — 2026-10-21

Evidence snapshot: `docs/evidence/marketing-agent-v2-ma09-preflight.json`.
Collected around **13:25–13:27 Europe/Berlin** (11:25–11:27 UTC). These are
bounded connector observations, not credentials, raw customer data or a live grant.

| Gate (§9) | Observation | Decision |
| --- | --- | --- |
| Revision/runtime | Coolify recorded a finished webhook deployment of `b9288c85` at 13:21:19 Berlin. That commit does not contain MA-00–08. Application says `running:healthy`, but its Coolify application-level health-check flag is false; individual Compose-service checks are not attested; API/worker source identities, image digests, queues and flag values are unknown. | **BLOCKED**; local candidate `8af5d09` has the phase chain and current main, but is not deployed |
| Project authority | uLiquid project `21356dfc-ceaf-4a2e-92b4-11f54f0182f5`, Marketing/Knowledge enabled, English, Europe/Berlin, assisted, not paused. Intended owner/member/module roles and new pilot consent not established. | **PARTIAL** |
| Knowledge/profile | Profile v4 names the official English registration CTA. Four active sources and five revoked sources were listed. First 40 verified facts inspected, not a complete fact inventory. Manual source has stale=true/null sync despite facts verified Oct 19; current expiry/rights and profile-to-fact binding need native validation. No rights-approved image inspected. | **UNRESOLVED**, no wholesale source revocation or repair performed |
| Readiness/channels | Native status `test_ready`; `LIVE_RAG_EVAL_REQUIRED` and `CHANNEL_WRITE_VERIFICATION_REQUIRED`. Policy allows X and one Telegram community. A second Telegram integration is not allowed. Schedule/live blocked. | **BLOCKED**; no test post/draft sent |
| Cost | Existing AI policy: USD 10/day, 20/month, 10/run, valid through Dec 31. Does not establish remaining money, held/unknown exposure, model/price ceilings or a new authorization. | **UNKNOWN / AWAITING APPROVAL** |
| First cycle/publication | No MA-09 assignment, run, generated image, exact human release or remote publication receipt. | **NOT RUN** |
| Recovery | Synthetic regression covers the implemented guards; live restart, pause and ambiguous-provider recovery not exercised. | **LOCAL ONLY** |
| Feedback | Four performance entity projections have no source, period or counter fields. This cannot establish measurements, zero counts or a correct no-data report. | **UNKNOWN** |
| Recurrence | No two real weekly cycles observed. | **NOT RUN** |

A second fact page confirms the registration URL value in current fact
`44547700-36dc-4486-8c20-aa6e4c5200a0` v1; the profile still names a different fact
ID (`2c4845f9-7f50-4dc1-b818-9ff861144416`). Native current binding/expiry validation
remains required. Forty facts are inspected in total, still paginated/incomplete.
The browser read attempt reached sign-in only; no credentials were entered and no
authenticated active-work, model-route or ledger inventory was obtained.

Main acceptance is additionally failed at its dependency audit (run `39590721569`).
The local patched candidate resolves that high-severity audit gate; its remote CI
remains unrun. This does not certify live deployment or erase the failed main run.

The overall result is **NO-GO**. Healthy application status and ready draft capability
cannot override source/readiness/approval gates. The empty approvals/drafts projection
is not an inventory of active assignments, reservations, queues or unknown outcomes.

## Concrete release preparation — not executed

### Goal, target and scope
Integrate the already implemented MA-00–08 chain plus current main, then make its
native approval-first workflow available for a separately bounded uLiquid Desk pilot.
Candidate release revision: **`8af5d09`** (Vite audit fix), based on integration
**`221cdc5`** with parents `e9c5d9d` and `b9288c85`.
The final local documentation commit is recorded in Git; documentation does not change
this tested runtime source. No new runtime feature or second main agent is added.

Target: `eds-labs/eds-orbit`, production application
`vfnfmbkbyb8hkjb5h7eamv18` at `https://orbit.eds-labs.io`, existing API/web/worker,
PostgreSQL and Redis. A push/merge to main may trigger Coolify's webhook immediately;
therefore do not push main as a supposedly harmless preparation step.

### Risk, compatibility, backup and release sequence
Risk: **critical** for a later production rollout. Existing recurring work can straddle
versions; source, policy, owner rights and costs can change after this snapshot.
No migration, direct dependency or production flag default change exists in the phase
chain versus inspected main. The later audit remediation changes the workspace
override/lockfile as documented below. Verify the final diff against the release base; do not
manually run migration commands merely to deploy JSON/entity changes. The existing
Compose migrate service still runs during stack start; capture its successful grant/
RLS/migration checks and do not bypass it or run a competing migrator.

1. **Obtain exact release authorization first.** Refresh main/branch/CI/deployment
   state and review the complete MA-00–08 diff, not only this documentation phase.
   If main moves, integrate/retest the resulting source before approving that SHA.
   Remote CI is currently unverified because this branch has not been pushed.
2. Inventory active assignments/plans/runs, pending owner requests, reserved/unknown
   costs and ambiguous external intents through native scoped operations. Inventory
   actual configured model routes/price ceilings, flags and all current worker leases.
   Do not infer idle state from the connector's empty draft list. Stop on uncertainty.
3. Verify a recent restorable PostgreSQL backup, Redis/job recovery procedure and
   retained compatible image identifiers. Record backup reference/time and recovery
   owner without credentials. These are **unverified prerequisites**, not completed
   backups. Separately authorize any pause/configuration/write needed for rollout.
4. Use existing CI/release workflow and immutable tested source. Prevent old/new
   workers from concurrently processing affected v2 work; apply a reviewed pause/drain
   sequence via native controls, without silently pausing unrelated projects or
   adopting/converting legacy assignments. No blanket production flag activation.
5. After rollout, record API and worker build SHA/image identity, health, queue
   progress, feature/module/tool values, current role/policy, scoped ledger totals and
   native readiness. Compare them with the tested candidate. Recheck legacy behavior.
   Do not change health configuration simply because the generic application-level
   health-check flag is false; inspect individual Compose-service checks first.
6. Run authenticated **read-only** smoke: correct project and roles; Assistant → saved
   plans → review; disabled/reader access; pending requests and exact source projection.
   Any write-based smoke, model evaluation or provider probe needs its own reviewed
   target, content and cost approval. No generated request is auto-approved.
7. Leave pilot entry closed until all gates below have concrete evidence. Record the
   actual deployment/CI receipts; a local commit or a deployment record alone is not
   API/worker runtime attestation.

Monitoring: native run/operation attention, job state, approval audit, publication
intent/reconciliation and cost ledger. Verify actual logs/alerts availability before
starting; no new monitor, external notification or scheduled job is created here.

Rollback/forward-fix: halt admission of new v2 work and reconcile active/ambiguous
intents. Preserve exact human release guards and durable review/publication records.
A pre-MA-01 binary ignores `human_each`; **do not revert to it while such work is
active**. Prefer a reviewed compatible fix or paused affected work plus a proven
compatible image. No database deletion, blanket grant, re-confirmation, duplicate
provider retry or deletion of real posts is a rollback strategy. Communicate runtime
status and any required owner decision in the current chat; do not contact others.

### Approval boundary
The next decision is **release authorization**, not permission to spend or publish.
Release approval must name the exact reviewed source and cover main/webhook deployment
and any proposed native pause/flag change individually. Paid evaluation/generation,
channel-write proof and each exact post/media handoff remain separate decisions.
The original no-paid/no-Postiz/no-deployment conditions still bind this preparation.

## Bounded pilot proposal — pending, creates nothing

Proposed scope: **one** uLiquid Desk English organic X assignment on integration
`cmufswv260001pg89nlreglzx`, `human_each`, weekly cadence in Europe/Berlin,
**two actual weekly cycles** and then stop/review. This is a proposal, not a saved
assignment or approval. No Telegram cross-post, advertisement, newsletter, blog,
legacy conversion or autonomous report assignment. Use the existing Assistant,
plan/assignment confirmation, owner release, ActionRequests, policy and publisher.

Before creating it, the owner must confirm the exact two dates, delivery windows,
assignment allocation and backlog bound through native confirmation. Check that the
admitted horizon cannot create a third slot. Capture current daily/monthly/run limits,
remaining/held/unknown cost and model routes/prices for text, image, research and
review. The existing 10/20/10 USD policy is an observed ceiling, not a proposed spend
increase or new grant. If two runs do not fit remaining authorized limits, stop and
re-scope; do not invent a budget, substitute a model or raise limits. Unconfigured paid
routes/unknown price or exposure are blockers. Generation and native RAG evaluation
require an explicit finite authorization before calls, even if policy is already active.

1. Resolve source freshness/expiry/rights and profile-fact bindings using the native
   workflow, excluding revoked/unsupported material. Confirm the official English
   CTA `https://desk.uliquid.vip/en/register`, current product facts and brand rules.
   Inspect the exact logo/image rights and bytes; generated-image consent must cover
   the selected route. No financial-return, token/presale or unsupported feature claim.
2. Obtain bounded live RAG evaluation authorization and evaluate the current actual
   provider/model/source index. Attach the native receipt to the exact project and
   current readiness version. A mock receipt cannot satisfy live readiness.
3. Review the native channel-proof operation before execution. Capture exact account,
   integration, text/media capability, delivery mode, outbound payload and expected
   cost/effect. If proof creates an external draft/post/upload, obtain exact human
   approval of that data **before** the probe; count/reconcile its write. Metadata-only
   inspection must not be misrepresented as channel write proof. No test publication
   or deletion is silently allowed by the phrase “pilot”.
4. Confirm the native assignment from chat with `human_each`, finite allocation and
   dates. Strategy/assignment approval does not approve future content. Preserve
   independent project/module/member, policy, budget and source checks at execution.
5. Cycle 1: produce one text+image item with actual authorized providers. Inspect
   English quality, CTA, current source references, novelty, image attachment and
   asset rights. Record content/version/body/media hashes and selected channel.
   Agent review—even with automation and Telegram connected—must leave it awaiting
   exact human release. No Postiz write/upload/draft before that release.
6. Owner approves the **actual** item and media in the native owner-release surface.
   Any text/image/permission/approval-parameter change invalidates that release.
   At handoff revalidate current policy, rights, role and budget. Retry/concurrent
   approvals must preserve one intent and one remote publication. Capture provider
   receipt and reconcile published status; scheduled/draft is not published.
7. Stop on unknown provider outcome; reconcile the existing intent instead of replay.
   Recovery checks use synthetic staging/local fixtures for destructive scenarios.
   Do not crash production workers, revoke real rights or exhaust live budgets as a
   test without another exact approved operation. No posts deleted for test cleanup.
8. Let the same assignment's second real weekly slot execute without manually
   creating agent tasks. Repeat exact content release and reconciliation. Verify no
   duplicate post, bypass, third slot or unexplained provider/ledger cost. One week
   elapsed in a fake clock does not satisfy recurrence.
9. Close a real measurement period; inspect configured Matomo/Postiz scope, timezone,
   source/counter coverage and permissions. Deliver the native periodic report to the
   owner and record receipt. Missing counters remain unknown; use a correct no-data
   report only with evidence of actual scope/availability. Provide a versioned,
   reviewable strategy revision without activating budget/channel/cadence increases.
   Paid report assignments remain disabled as documented in MA-07.

### Proposed copy for later review (not approved)
> AI assists. You decide.
> Explore uLiquid Desk and register for the beta:
> https://desk.uliquid.vip/en/register

This uses only the inspected tagline and profile CTA. Revalidate their current native
fact/source binding before generation or release. No final image exists, so there is
**no publication-ready approval package** yet. Image brief: rights-cleared uLiquid Desk
brand asset or an explicitly consented generated visual, no fabricated UI, performance
claims or investment promises; record exact bytes/hash and the current usage grant.

## Append-only live acceptance worksheet

Do not prefill success. Add dated evidence beneath each row when it actually exists;
keep prior source/version/receipt observations when corrected. No credentials or
private customer content in this repository.

| Evidence | Cycle 1 | Cycle 2 |
| --- | --- | --- |
| Actual date/window/timezone | NOT RUN | NOT RUN |
| Deployed API/worker SHA + image/connector versions | UNKNOWN | UNKNOWN |
| Plan/assignment/version + native confirmation/request ID | NONE | NONE |
| Run/slot/content/version + exact text/media hashes | NONE | NONE |
| Sources/profile/asset rights versions + readiness receipt | NONE | NONE |
| Actual model routes/prices + bounded authorization | NONE | NONE |
| Reserved/settled/held/unknown/released cost | UNKNOWN | UNKNOWN |
| Exact human release event/actor/version + preflight | NONE | NONE |
| Publication intent/remote ID + reconciled published time | NONE | NONE |
| Recovery/duplicate/permission observations | NOT RUN | NOT RUN |
| Measurement source/scope/closed period/coverage | UNKNOWN | UNKNOWN |
| Report ID/version/delivered owner receipt | NONE | NONE |
| Proposed strategy delta/review request (not activated) | NONE | NONE |

Overall acceptance requires both real weekly cycles, current source/runtime/readiness,
finite authorized spend, exact per-item releases, reconciled actual publication and a
delivered measured/no-data report with a reviewable improvement proposal. Any unexpected
external write, tenant leak, excess spend or review bypass stops the pilot immediately.
No next implementation phase is started by this document.

## Changed files and verification

MA-09 changes include documentation/evidence and the observed CI audit remediation:
- `docs/plans/marketing-agent-v2-ma09.md` — observed gates, concrete release/pilot plan,
  rollback, pending two-cycle evidence and approval boundaries.
- `docs/evidence/marketing-agent-v2-ma09-preflight.json` — sanitized read-only snapshot.
- `pnpm-workspace.yaml` and `pnpm-lock.yaml` — patched Vite 8 override and resolved
  related Rolldown/oxc bindings; no unrelated package/version movement.
- `docs/IMPLEMENTATION_STATUS.md` and `docs/REQUIREMENTS_TRACEABILITY.md` — explicit
  prepared/blocked state, without claiming live completion.

Merge `221cdc5` separately integrates the 38 upstream files from current main. The two
status-document conflicts retain both independent histories. No upstream customer-
context contract runtime integration is implemented as part of MA-09.

Fresh final validation is recorded below; generated test artifacts are not committed.


### Observed upstream CI blocker and narrow remediation plan
Main's Orbit acceptance run `39590721569` failed at `pnpm audit --audit-level high`.
Local audit reproduces GHSA-587h-7wmj-h5pm in resolved **Vite 8.3.0** (not 8.3.2).
The upstream advisory affects Windows launch-editor behavior; this is a dependency
release-gate finding, not evidence of exploitation or Linux production exposure.
Primary reference: https://github.com/advisories/GHSA-587h-7wmj-h5pm .

Before any release proposal, pin only affected Vite 8 versions to patched **8.3.3**
through the workspace's existing override mechanism. Inspect the generated lockfile
for unrelated movement; retain package manifests/other version pins. Risk: medium,
local dependency tooling. Validation: clean high-severity audit, frozen install,
fresh full regression/lint/typecheck/build and browser navigation on final dependencies.
Rollback: revert only this override/lock change locally; never waive the audit gate.
The first full suite uses the old dependency graph and cannot certify the final graph.


The lockfile delta contains only Vite 8.3.0 → 8.3.3, its required Rolldown
1.2.8 → 1.2.14/native bindings and oxc types 0.149.0 → 0.154.0, plus corresponding
peer-context keys. No application dependency or test source changed. The first full
run was intentionally interrupted (exit 130) before installing the final graph;
it is not recorded as a pass. Post-update audit at the repository's high threshold
passes with **0 high/critical**, 3 moderate and 1 low findings remaining. This is a
bounded dependency audit, not a full security certification. Main's remote acceptance
is still failed historically; local remediation does not change its run result.


## Final local verification and reproduction

Node **24.18.0**, pnpm **11.19.0**, worktree-owned PostgreSQL test database and
Redis namespace from `node scripts/test-db-for-worktree.ts`. Test setup validates
local database URLs and overrides the shared environment with `.runtime/test.env`.
No production DB connection, real provider generation/publication or worker process
is used. Repository integration tests use synthetic fixtures and mocked providers.
The browser's scoped synthetic fixture ran alongside regression with its own users/
projects; it started no worker. Both fixture servers were terminated and their
credential file removal was verified.

| Check on candidate `8af5d09` | Result |
| --- | --- |
| Frozen dependency install / Prisma generation | PASS |
| Full Vitest regression on final dependency graph | **3,052 tests passed in 280 files**, 594.84 seconds; no skips/failures |
| Desktop/mobile existing navigation browser regression | **5 passed**, 15.0 seconds; 1280px/390px, keyboard/reload, viewer/none and Marketing-off Support approvals; zero POSTs after authentication or generated work |
| Lint / root and web typecheck / production build | PASS |
| Customer-context contract regeneration | PASS, no generated contract diff |
| Dependency audit at repository high threshold | PASS; 0 high/critical, 3 moderate and 1 low remain |
| Framework / secrets / import boundaries / diff | PASS; zero framework errors/warnings, 1,445 candidate text files scanned, zero import violations |
| Final application/test source manifest | **1,009 tracked files** match every byte of pre-run commit `8af5d09` via Git object comparison; aggregate SHA-256 `23d0c2d944c1133fe38c93ad7b068d3e740e8ca3e83919de8c8e9ba0ac253b02` |
| Remote candidate CI / actual deployment / live acceptance | NOT RUN |

Reproduce from this worktree with the pinned runtime:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm db:generate
node scripts/test-db-for-worktree.ts
node --env-file=<local-runtime-env> node_modules/vitest/vitest.mjs run
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm audit --audit-level high
corepack pnpm contract:customer-context
corepack pnpm framework:check
corepack pnpm secrets:check
```

Browser reproduction uses the existing MA-08 fixture/config described in
`docs/plans/marketing-agent-v2-ma08.md#reproduction`; use localhost ports 44430/44431,
`MARKETING_NAV_E2E=true`, no worker and external writes disabled. Stop both servers
and verify synthetic cleanup afterward. Do not reuse these local credentials on a
real account. Deterministic-eval and source-manifest generated outputs are restored
to HEAD before the documentation commit, not included as application changes.

**Implemented locally:** current-main integration, narrow CI audit remediation and
reviewable release/pilot evidence package. **Not deployed or accepted:** MA-09 live
pilot, paid readiness tests, publication, two weekly cycles and delivered feedback.


Source-integrity clarification: the existing unfiltered manifest includes ignored
`apps/web/tsconfig.tsbuildinfo`, rewritten by the parallel TypeScript/build checks.
Its 1,010-file aggregate changed from `cd03dcac...` to `5b2cfce4...`; those raw hashes
are **not** claimed equal. After restoring deterministic-eval output, every one of
its 1,009 tracked source files was individually compared with the pre-run `8af5d09`
Git blob and matched exactly. Only the ignored build cache falls outside that
comparison. No manifest-script refactor was added to this pilot-preparation phase.


## Authorized direct-main delivery — 2026-10-21

Mario explicitly approved direct-main delivery in this chat after the reviewed release
preview. This authorizes the push and associated webhook rollout; paid work, pilot
activation, production flag changes and exact post releases remain separate.

Refreshed main is `ccd7689`, containing an independently committed identical Vite
8.3.3 patch. Retain its narrower `vite@>=8.3.0 <8.3.3` override, remove the duplicate
broader local rule, and preserve both histories with a merge. The complete lockfile
importers/packages/snapshots are byte-identical to tested `8af5d09`; only override
selection/order differs. Frozen offline install and the high-threshold audit pass.
No application/test, migration, Compose, production flag or provider configuration
changes accompany this integration. Existing 3,052-test/five-browser verification
remains evidence for the same application and resolved dependencies; exact merge CI
and webhook/runtime results must be tracked separately.

Pre-push Coolify reports the existing application `running:healthy` and the enabled
03:00 UTC off-host backup task. Task presence alone is not a verified recent restore
or per-service runtime attestation. No backup/config/credential operation was performed.
The application-level health-check flag is unchanged. No pilot is started by delivery.

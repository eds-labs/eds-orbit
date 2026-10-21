# MA-06 — operational status and safe recovery

## Scope and provenance
Start from MA-05 `30d8060` on `codex/marketing-agent-v2-ma06`.
Fetched main `333231f4` is an ancestor. Original plan inherited from `a65e2ec`.
No paid calls, external writes, new schema migrations, production flag changes or deployment.

## Plan
1. Share one read-only projection of lifecycle, task states, delivery outcomes
   and scoped ledger totals across assignment management, plans, chat and tools.
2. Distinguish degraded optional inputs, required failure, unknown outcomes,
   owner approval and capacity holds. Offer targeted existing recovery surfaces.
3. Preserve safe image reuse, publisher reconciliation, dispatch guards and
   event-key notification deduplication. No global retry or second orchestrator.
4. Verify offline regressions and all repository gates; prepare MA-07 only.

## Threat, cost, test and rollback
High local risk: misleading completion could encourage duplicate paid work.
Unknown outcomes outrank completion. Unknown money is exposure, not settled cost.
All reads are tenant/project scoped; bounded scans disclose incomplete evidence.
Links confer no authority. Existing action and dispatch permissions remain binding.
No model cost; low bounded database read cost. Test optional versus required
failures, ledger partitions, isolation, ambiguity, notification deduplication,
image reuse and revoked dispatch permissions in the isolated MA-06 database.
Rollback is a code revert without schema or external-state changes.

## Implemented behavior

`agents/run-operation.ts` is the shared read model. It preserves the existing
run lifecycle and separately derives `state`, `degraded`, `complete`, task issue
codes and targeted existing recovery links. Ambiguous task/ledger/publication
outcomes outrank a `done` lifecycle. Optional-only failures are degraded; required
review failure stays failed. Waiting human review and capacity holds are explicit.
The detailed view aggregates reservation amounts directly in SQL using the same
model/image/retrieval key families as task budget enforcement. Settled actuals,
held funds, unknown reserved exposure and released reservations are disjoint.
Unknown exposure is not an asserted actual provider charge. Existing `costMicros`
remains for backwards compatibility. Small amounts display up to six USD decimals.

The same projection reaches plan-linked work, assignment management, chat cards
and `run_status`. Recent-run attention uses the same classification rules with
one bounded evidence batch rather than one query set per run. Detailed ledger
aggregation remains in the detailed views, not the attention badge endpoint.
Run-problem Telegram messages enrich the existing event-keyed job with current
status/cost evidence and one project-specific action link. No new notification
kind, queue, transport or generic retry is introduced.

A running visual task may complete local attachment from its committed image only
when all its reservations are settled/released and that image names the exact
settled reservation, task, run and assignment. This narrow path cannot call an
image/model provider even if the image disappears after claim. Current assignment
confirmation/plan/capacity guards still run; the local recovery rechecks image
consent and asset approval. Missing, unapproved or ambiguous evidence stops work.
Other paid interrupted work retains the existing failed/unknown semantics.

## Acceptance evidence

| Case | Evidence |
| --- | --- |
| Crash after committed image save | `assignment-copywriter-visual.integration.test.ts`: local attachment, concurrent workers, one original provider call and one asset; revoked/missing evidence never regenerates |
| Ambiguous publication never duplicated | Existing `marketing-agent-v2.integration.test.ts`, publisher and Postiz-draft recovery regressions; new shared-state and plan-view assertions retain unknown status |
| Optional research allows labeled degradation | `marketing-run-operation.integration.test.ts`, existing optional-dependency scheduler tests |
| Required review failure prevents delivery | Existing review/scheduling regressions and a separate isolated `scheduleFinishedRun` acceptance smoke: partial run with failed review plus misleading reviewed content flag creates zero publications/draft handoffs; new projection distinguishes required failure from degraded research |
| Revoked dispatch authority blocks sends | Existing MA-00/01 v2 owner/module/policy/assignment/image/schedule invalidation matrix and publishing/draft tests |
| One event, one actionable notification | Existing event idempotency keys; `agent-notifications.integration.test.ts` now races repeated terminal-run updates and asserts one job; same job gains one targeted link |
| Roles, scope, budget and bounded reads | New cross-project/ledger/100-task sentinel cases, existing access/RLS/budget suites; attention query-count regression |
| Saved results in desktop/mobile | Extended `marketing-plans.spec.ts`: synthetic unknown task/cost evidence persists across plan/assignment reload and plan pause; no worker runs |

## Known limits

- Recovery links open existing guarded controls; they are not a bulk-retry button.
  A completed paid task is never regenerated as part of recovery. Uncertain external
  outcomes still require existing provider reconciliation or explicit owner checks.
- Detailed run evidence scans 100 tasks plus a sentinel. Overflow reports incomplete
  totals and an unknown state. Attention considers the 50 most recently updated runs
  in the existing recent window and at most 10,000 task/delivery evidence rows plus
  a sentinel. It is an operational sample, not a historical reporting system.
- The ledger view is keyed to existing task reservation families. Legacy cached
  `costMicros` is retained but is not silently promoted to verified ledger spend.
- Image recovery is local only. Failed banner composition or unreadable/changed
  assets can still require owner intervention; no second image is purchased.
- No paid/live pilot, real Postiz write, production migration/flag/deployment,
  branch push or production acceptance is part of this local implementation.

## MA-07 preparation only

Next phase: audit attribution links, persist reports with explicit source and
period identity, deduplicate metric imports and owner delivery, and record metric
corrections as report revisions. Preserve `no_data`, source separation and visible
specialist channel-sampling limits. Build synthetic multi-channel metric fixtures
before any live pilot. Report-generated plan changes must remain proposed and
owner-approved, especially budget/channel/cadence increases. Keep `report`
assignments disabled until their full lifecycle and owner-visible delivery pass.
No periodic report engine, report assignment activation, attribution change or
new plan-revision automation is implemented in MA-06.

## Verification

Final local commands and results follow. The successful complete regression ran with
the final application/test source. No application/test file changed during it.

| Check | Result |
| --- | --- |
| Focused pre-final regression | 68 tests passed in 4 files; corrected strict plan-projection expectation then passed all 29 plan cases |
| Full final regression | **3,006 tests passed in 276 files**, 474.22 seconds; Node 24.18.0 / Vitest 5.0.1 against the dedicated MA-06 database |
| Desktop/mobile browser | 1 extended Playwright scenario passed; 1280×900 and 390×844, reload/activation/pause, unknown result and USD exposure; no page overflow |
| Lint / root and web typecheck / production build | Passed |
| OpenAPI and generated client | Regenerated; no contract-file diff (existing response envelopes are extensible) |
| Framework / secrets / diff / import boundaries | Passed; zero import-boundary violations |

Browser API/web processes were stopped and the temporary fixture account/project
and credentials removed after the scenario. Screenshots remain ignored local evidence.
The browser-fixture database setup was moved into a separate script so frontend
TypeScript/build never imports server/database libraries. Initial fixture type errors
were fixed before the successful lint/typecheck/build/browser checks.

The initial strict linked-run test expectation was updated for the additive
operation object, including explicit zero verified-ledger amounts beside a legacy
cached cost. All 29 plan cases passed before the successful full rerun. No business
logic was changed to accommodate that expectation. The isolated service smoke
required normal module-registry bootstrap before fixture creation and then passed.
Generated deterministic-eval output and temporary source-manifest output were
restored to HEAD rather than committed as product changes.

Commands: `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm build`,
`corepack pnpm api:generate`, `corepack pnpm framework:check`,
`corepack pnpm secrets:check`, `git diff --check`, and `git diff --cached --check`.
Tests: `node --env-file=<local-runtime-env> node_modules/vitest/vitest.mjs run`;
the worktree-specific test environment overrides the shared database settings.
Browser: `MARKETING_PLAN_E2E=true node --env-file=<local-runtime-env>
node_modules/@playwright/test/cli.js test --config scripts/marketing-plans-browser.config.ts`
with the synthetic API fixture and built local Next server, no worker.

Final source manifest: 962 files, SHA-256
`fe9cde3b149ac9841b883a8bea1b250b4a38126a9a1edcc70ea02f815e729ee9`.

## Changed files

- `apps/api/src/modules/marketing/agents/assignment-overview.ts`
- `apps/api/src/modules/marketing/agents/assignment-result.ts`
- `apps/api/src/modules/marketing/agents/notification-messages.ts`
- `apps/api/src/modules/marketing/agents/run-operation.ts`
- `apps/api/src/modules/marketing/agents/specialists/runner.ts`
- `apps/api/src/modules/marketing/agents/specialists/visual.ts`
- `apps/api/src/modules/marketing/attention.ts`
- `apps/api/src/modules/marketing/plans/service.ts`
- `apps/api/src/modules/marketing/tools/assignment-tools.ts`
- `apps/api/tests/agent-notifications.integration.test.ts`
- `apps/api/tests/assignment-copywriter-visual.integration.test.ts`
- `apps/api/tests/attention-marketing.integration.test.ts`
- `apps/api/tests/marketing-plan-activation.integration.test.ts`
- `apps/api/tests/marketing-plans.integration.test.ts`
- `apps/api/tests/marketing-run-operation.integration.test.ts`
- `apps/web/src/modules/marketing/assignments.tsx`
- `apps/web/src/modules/marketing/attention.tsx`
- `apps/web/src/modules/marketing/chat-extension.test.tsx`
- `apps/web/src/modules/marketing/chat-extension.tsx`
- `apps/web/src/modules/marketing/plan-card.tsx`
- `apps/web/src/modules/marketing/run-operation.tsx`
- `apps/web/tests/marketing-plans.spec.ts`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/REQUIREMENTS_TRACEABILITY.md`
- `docs/plans/marketing-agent-v2-ma06.md`
- `scripts/marketing-plans-browser.ts`
- `scripts/marketing-run-browser.ts`

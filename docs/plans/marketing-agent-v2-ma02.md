# Marketing Agent v2 — MA-02

## Scope and provenance

Base: origin/main bc01c075f7881c9b8d3909aac6dbb86ce8c23c74. MA-00/01 and the
original isolated plan were imported by cherry-picking bfb9c6e, 7d13f30 and
b0cb8c9. Both current-main and imported status entries are retained.

Risk: high; local only. Primary profile: ai-agent-app, supplemented by fullstack-saas
and web-frontend. Existing web-next-custom-postgres modular monolith; feature workflow.
No new runtime, database schema, provider, dependency or strategic plan engine.

## Implementation plan

1. Add a deferred read-only intake tool using authoritative project status,
   current assignments and current channel/policy intersection. Return a single
   focused budget/language question when missing or incompatible; no generation.
2. Make equivalent native chat proposals reuse existing non-ended work under the
   existing project transaction lock. Changed mandates still need explicit revision.
   Keep MCP origin/grant deduplication separate.
3. Project persisted latest runs, output IDs, actual costs and blockers into the
   existing assignment card on read/reload. Reuse owner review and existing links.
4. Extend deterministic chat/service and UI tests; retain MA-01 safety tests.
   Run lint, typecheck, build and full suite in an isolated database.

## Threats and rollback

Untrusted chat cannot establish a budget or change profile language. Intake only
reads within the current project scope; proposals still require an exact owner
ActionRequest, and future posts still require human_each approval. Deduplication
must not revive ended jobs, bypass changed approvals or mix MCP origins. Cards
never approve content and distinguish handoff from publication. Test cross-project
scope, missing budget, language mismatch, concurrent repeated proposals and saved
results after chat reload. Revert MA-02 code commits to roll back; no data migration.

## Validation and limitations

Implemented locally. Offline model transport replay verifies orchestration, not real-model
natural-language tool selection. Paid model evaluation and production rollout are
outside this task. MA-03 is not implemented here. The historical I7b failure was
traced to its wall-clock-dependent positive fixture (see below), not resolved by
changing the production pause/resume rules.

## Implemented behavior and limits

- Intake is assistant-only, read-only and deferred behind the existing agents feature.
  Missing budget means no proposal or specialist execution in the tested intake path;
  the assistant's own model turn still uses its normal project AI budget.
- `requestedLanguage` is optional on the model-facing proposal. A mismatch is refused;
  the profile remains the generation language authority. No per-assignment override
  or automatic profile mutation was added.
- Native-chat retries normalize topic whitespace/case, array ordering and name changes
  while retaining every budget, schedule, media and approval parameter. Exact matches
  reuse draft/active/paused work without reviving ended work. Expired/rejected draft
  requests are not reused. Semantic similarity is advisory to the assistant, not a
  fuzzy automatic merge. MCP-origin proposals are never folded into this dedupe path.
- Result cards use scoped persisted runs/tasks/content and existing delivery projection.
  They show image IDs where present, precise small costs, actionable outcome labels
  and uncertainty. Specific run queries include saved history, bounded to 20 runs;
  list/status replies render at most three assignment cards. Existing owner release
  and worker lifecycle remain authoritative.
- The budget regression fixture now uses two distinct topics: equivalent retries
  intentionally share one mandate, while two different mandates still compete for
  monthly capacity. Existing role/RLS fixtures are unchanged.
- The recurring E2E clock no longer moves backwards before its synthetic paid
  mandate's start when invoked in the afternoon.

## MA-03 prerequisites (prepared, not implemented)

1. Persist only the reviewed minimum plan contract described in the v2 plan; link
   existing assignment/run/content IDs rather than duplicate jobs or budget ledgers.
2. Preserve MA-01 exact human approval and this phase's native/MCP origin separation.
3. Define finite horizon, source/profile/policy revisions, channel/budget bounds and
   idempotent activation before adding multi-assignment orchestration (MA-04).
4. Add plan tenant/module/role/expiry/revision negatives and deterministic activation
   tests. Keep strategic persistence separate from the existing run-level strategist.
5. Retain deterministic positive and expired-slot pause/resume coverage. Arrange an
   explicitly authorized bounded real-model selection evaluation and later a separately
   authorized live pilot; no paid evaluation or provider write is implied here.

## Changed files (MA-02 delta)

- `apps/api/src/modules/agents/tools/registry.test.ts`
- `apps/api/src/modules/marketing/agents/assignment-overview.ts`
- `apps/api/src/modules/marketing/agents/assignment-result.ts`
- `apps/api/src/modules/marketing/agents/assignments.ts`
- `apps/api/src/modules/marketing/assistant/prompt.ts`
- `apps/api/src/modules/marketing/tools/assignment-tools.ts`
- `apps/api/tests/__snapshots__/assistant-request.characterization.integration.test.ts.snap`
- `apps/api/tests/agent-runner.integration.test.ts`
- `apps/api/tests/assignment-tools.integration.test.ts`
- `apps/api/tests/assignments.integration.test.ts`
- `apps/api/tests/marketing-agent-v2.integration.test.ts`
- `apps/web/src/modules/marketing/chat-extension.test.tsx`
- `apps/web/src/modules/marketing/chat-extension.tsx`
- `apps/web/tests/marketing-agent-v2.spec.ts`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/REQUIREMENTS_TRACEABILITY.md`
- `docs/plans/marketing-agent-v2-ma02.md`
- `scripts/marketing-agent-v2-browser.ts`

## Reproduction

Use the repository-pinned Node 24.18.0 and `corepack pnpm` 11.19.0. Install with
`corepack pnpm install --frozen-lockfile --offline`, generate Prisma with
`corepack pnpm db:generate`, and run `node scripts/test-db-for-worktree.ts`.
The helper accepts only the local isolated PostgreSQL and writes the worktree's
ignored `.runtime/test.env`; do not print credentials or reset the shared test DB.

Load the main checkout's local configuration as described in README, then run:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Focused coverage: `assignment-tools.integration.test.ts`,
`marketing-agent-v2.integration.test.ts`, `assignments.integration.test.ts`,
`mcp-proposal-flow.integration.test.ts`, tool registry and Marketing chat component
unit tests. The request-characterization snapshots were updated and reviewed for
the added deferred-tool instruction and changed assignment prompt only.

Browser reproduction: start `scripts/marketing-agent-v2-browser.ts` with the local
configuration, start Next with `ORBIT_API_ORIGIN=http://127.0.0.1:44331` on 44330,
then run `MARKETING_V2_E2E=true pnpm exec playwright test --config
scripts/marketing-agent-v2-browser.config.ts`. The fixture starts no worker and
stores only synthetic evidence; it does not prove generation itself (the SQL E2E
does). Terminating the fixture cleans its synthetic project/user and ignored
credential file. Desktop 1280x900 and mobile 390x844 screenshots were inspected.

## I7b fixture diagnosis

The existing positive resume case planned slots from the fixed `MORNING` fixture,
then resumed using the real clock. After those slots expired, `resumeAgentTasks`
correctly canceled the run and left the blocked job untouched. The previous
MA-00/01 baseline reproduction therefore demonstrated a time-dependent fixture,
not sufficient evidence of a production resume defect. The positive case now
explicitly keeps its slots 24 hours ahead. The separate expired-slot case retains
past slots and still verifies cancellation. No production recovery code changed.
All 20 specialist-runner cases pass after this test-only correction, including both
resume cases and the expired-slot negative.

## Final verification (local, 2026-10-20)

| Check | Result |
| --- | --- |
| Isolated worktree DB migration, least-privilege and real-role checks | PASS |
| Focused intake, chat replay, recurring approval-first E2E, tool registry and UI (4 files) | 72 passed |
| MCP-origin separation and assistant proposal regressions (2 files) | 36 passed after origin fix |
| Final assignment-budget, Marketing v2 E2E and result component regressions (3 files) | 39 passed |
| Assistant request characterization | 2 passed; reviewed snapshots updated |
| Real-stack Playwright, desktop 1280x900 and mobile 390x844, reload and overflow | 1 scenario passed (6.3 s); screenshots inspected |
| Full suite after production-code fixes | 2,903 passed / 1 failed, 269 files, 465.39 s |
| Full suite's sole failure | Existing time-dependent positive I7b fixture, compiled before its final test-only correction |
| Specialist runner after correcting that fixture | All 20 passed (3.36 s), including positive resume and expired-slot cancellation |
| Lint and source/import boundary checks | PASS; zero known/new boundary violations, also rerun after I7b test-data correction |
| Root/web typecheck and production build | PASS |
| OpenAPI/client generation | PASS; no generated contract diff |
| Framework validation / secret scan / diff whitespace | PASS; 0 framework errors/warnings |

No single all-green full-suite run is claimed after the last test-only fixture
correction: the full run and the focused 20-case rerun are separate evidence.
The production implementation is unchanged between them. The test-generated
knowledge evaluation artifact was restored to HEAD and excluded from this delta.

No paid provider, genuine Postiz write, production flag change, push or deployment.
Browser fixture processes and synthetic account/project were cleaned up; the
isolated test database remains available for reproduction. MA-03 is prepared only.

# Marketing Agent v2 — MA-05

## Plan, risk and boundary

High-risk local feature on `codex/marketing-agent-v2-ma05`, based on MA-04
`cb65448`; fetched origin/main remains `333231f`. Primary ai-agent-app profile,
complementary fullstack-saas/web-frontend; retain the modular Next/Fastify/Postgres
stack and feature workflow. No migration, provider, production flag or dependency.

1. Introduce one bounded Marketing history projection over local drafts/content,
   publication state, stored external history and held structured briefs. Expose
   truncation, history window and missing/stale/failed remote coverage explicitly.
2. Reserve canonical topic/angle/channel keys atomically under the existing project
   transaction lock before generation. Keep plan pillar metadata, exact retry
   identity and held/committed outcomes. Share checks across assignment briefs,
   package/manual/batch mission generation and manual content writes. Fact overlap
   alone is not a duplicate angle. Preserve source/rights and human approval gates.
3. Add an explicit optional pending-review limit to existing assignment mandates;
   absence preserves legacy behavior without an invented default. Owner confirmation
   binds it. Count waiting drafts and already admitted run capacity atomically;
   refuse a new run or paid work once full, while allowing its admitted run to
   complete. Display configuration/current blockers and support recovery on review.
4. Test concurrency, retries, project/module/role boundaries, partial remote history,
   pending-capacity admission, zero paid calls with a full backlog, release/recovery,
   distinct angles using shared facts and all existing generation/approval paths.
   Run repository checks and browser verification with synthetic fixtures only.

## Threat model, cost and rollback

History/model output is data, never authority. IDs and held rows are scoped; raw
collection writes cannot forge a reservation. A topic key is a conservative exact
normalized identity, not semantic similarity or a fact claim. Reservations grant
no spend or publication rights. Unknown transmitted work is never automatically
retried/released. Paid providers and live Postiz writes remain unexercised. No new
model/embedding calls: incremental cost is stored bounded reads and transactions.

Rollback: stop configured owned work before reverting enforcement; retain Marketing
kind ownership/access/export for saved reservations. Preserve exact assignment hashes
with absent legacy fields. No production rollout/migration is included.

## Implemented behavior

`marketingHistory` is the common bounded view for the assistant, strategy and every
mission-generation entry point (creator, package, batch, autopilot and assignment).
It combines current native drafts, publication state, stored Postiz posts (including
Orbit posts absent from local content), and held briefs. Current drafts can precede
the normal history window. Source kind stays explicit, so a cached remote ID never
masquerades as a native content ID. It scans at most 301 rows per source (300 usable),
returns at most eight entries per channel and bounds offered JSON. Source slots keep
external history/reservations visible beside a busy draft queue. `truncated`, the
window, timestamps and remote `fresh/stale/failed/unavailable` coverage are explicit;
remote `complete` is always false. No extra remote or model request was added. Source-backed text is offered only
with current model-ready evidence; invalid or withdrawn model-use rights produce
an explicit text-withheld placeholder, including when the original draft remains saved.

A Marketing-owned non-collection Entity kind, `marketing_topic_reservations`, holds
normalized channel/topic/angle identities. Pillar is descriptive metadata, not an
escape from an existing key. Strategy reserves all channels of a shared brief in
one savepoint before successor copy/image tasks are queued; a conflict drops only
that deliverable with a stored reason. Project transactions serialize competing
assignments. Retry identity reuses its existing hold. Generation/native content
writes can supply the same optional `novelty` structure. Manual POST/PATCH, generated
content, revisions and shared-channel copies use the scoped body check and contribute
to the common corpus. Fact placeholders are resolved before comparing saved bodies.

Exact cross-mission channel duplicates fail before content persistence. Existing
within-mission batch review detection remains in place. The editorial adaptation
and publishing preflight no longer reject a different angle for shared fact IDs
alone: near-identical wording is also required. A trivial appended CTA still counts
as a duplicate. Source rights, scope, evidence, policy, budget and exact human release
continue through existing components. No reservation grants spend or publish rights.

`pendingReviewLimit` is an optional integer from 1 to 100 in an exact owner mandate.
It must cover a complete configured run. A strategy may constrain each child's exact
limit; the activation envelope enforces it. No field/default is inserted into legacy
mandates. Changing a limit changes the assignment hash, returns it to draft and needs
fresh owner confirmation through the existing ActionRequest path. The assistant
asks for the owner's setting; it does not invent one.

Capacity counts current pending content plus unfilled slots of admitted runs. A
superseded revision does not consume another slot or release an unwritten one.
Concrete publication/draft handoffs leave the review queue; cancellation returns
content to the queue when appropriate. Admission and worker, retrieval, model and
image budget boundaries check capacity under the project lock. The current run
retains its admitted capacity so it can finish; other runs cannot spend it again.
A recovered pre-call task is parked in `queued`, including when a crash left its
previous state as `running` without a paid reservation. A full queue saves one native `ASSIGNMENT_REVIEW_BACKLOG_FULL` exception per assignment,
without depending on Telegram. Capacity recovery clears it and requeues only unsent
work through the existing job/outbox mechanism. Existing queued jobs, paid/unknown
outcomes and completed paid work are not replayed. Runs whose slots all expired are
canceled with the existing `SLOT_UNAVAILABLE` behavior.

Chat/native confirmation cards show the exact limit. Assignment management shows
waiting posts, held capacity and the configured bound, with a textual blocker.
The owner changes configuration through the existing assignment proposal/change
flow. The assignment table keeps a readable minimum width within its local horizontal
scroller; an accessible action-column label stays inside the table semantics. Existing role/module/project authorization remains authoritative.

## Validation and reproduction

All evidence is local, synthetic and isolated to worktree database
`orbit_test_eds_orbit_marketing_ma05_7afddf` and its queue namespace. The setup script
applied existing migrations and verified least-privilege/RLS grants; no schema
migration was added. The current suite/check totals are recorded below after the
final run. Providers are mocked or absent; no worker ran in browser fixtures.

- MA-05 real-DB negatives cover competing/replayed topic keys, distinct angles and
  channels, foreign-project isolation, atomic shared-channel conflict rollback,
  local/package/assignment/manual history, missing/stale/failed history, old pending
  drafts, bounded/truncated output, manual edits, exact body duplicates, zero-cost
  pre-generation conflicts, full queue admission, queued worker refusal, paid-query
  races, exact resumption, expired slots, handoff/cancellation capacity, revisions,
  fresh confirmation and unchanged absent-field hashes.
- Plan activation verifies that every exact child matches a configured strategy
  limit. Existing human_each/Telegram/agent-review, stale approval, rights, budget,
  concurrent publishing and legacy automatic paths remain in the regression suite.
- Existing regression fixtures now use different wording/topics where they intended
  different posts. Offline generation evaluation archives each measured candidate
  output before the next independent experiment, preserving the output/ledger while
  preventing novelty contamination between candidate comparisons. This is fixture
  isolation, not a runtime provider exception.
- OpenAPI/client changes are additive optional review limits. Assistant snapshots
  were reviewed for the new conditional guidance and optional tool field; access
  matrix expectations and module/role rules were not loosened.
- Browser reproduction: start `scripts/marketing-plans-browser.ts` with the local
  configuration; run built Next on localhost:44430 with API 127.0.0.1:44431, then
  `MARKETING_PLAN_E2E=true pnpm exec playwright test --config
  scripts/marketing-plans-browser.config.ts`. This covers strategy/chat/native
  persistence, exact owner activation/image consent, the configured review limit,
  management counts after reload and no overflow at 1280x900 and 390x844. Stop the
  fixture with SIGTERM to remove its synthetic owner/project and 0600 credential
  file. The API and web processes start no worker, paid AI or Postiz writer.

## Final verification (2026-10-20, local)

| Check | Result |
| --- | --- |
| Complete final `vitest run`, isolated worktree DB/queues | **2,995 passed / 275 files**, 469.44 seconds |
| MA-05 integration cases (included above) | **17 passed**, including revoked model-use rights and interrupted pre-call worker recovery |
| Affected real-stack Playwright scenario | **1 passed**, desktop 1280x900 and mobile 390x844; review limit, management reload, local table scrolling and no page overflow |
| `pnpm lint` and root/web `pnpm typecheck` | PASS |
| `pnpm build` (Prisma generation, root TypeScript, Next production build) | PASS |
| `pnpm api:generate`, reviewed OpenAPI/client and assistant snapshots | PASS |
| `pnpm framework:check` (script requires full validation) | PASS, zero errors/warnings |
| `pnpm secrets:check` | PASS, bounded repository pattern scan |
| Source/import guards and staged `git diff --check` | PASS, zero boundary violations |

The final run's application/test manifest digest is
`f20f3f7edb68a5c4e88fe620eedc8da5967b66cfea9ef5ffb97034951152463c`.
The manifest was checked again after the complete run; no application/test file
changed during it. Documentation/result bookkeeping followed. Earlier fixture and
mobile-layout failures were resolved before this final run. Browser fixtures,
processes and temporary credentials were removed; generated deterministic-eval
output was restored rather than included in the feature. No access-matrix row,
lockfile, production setting, source-use permission or budget grant was loosened.
These are local implementation/test results, not merge, deployment or live acceptance.

## Remaining limits

- Topic reservations compare exact normalized identities, not semantic equivalence.
  Paraphrases can escape identity matching. No embedding/model call was added to
  claim stronger novelty. Legacy unstructured missions share history/body checks;
  a general goal is never silently promoted to an exclusive topic constraint.
- Holds expire after 14 days. Failed/ambiguous work is conservatively retained until
  expiry; there is no automatic reassignment, semantic plan repair or bulk discard.
- History is an explicit bounded sample, not a complete remote archive. Older
  remote records outside the window and scan/byte truncation remain uncertainty.
- The review limit is per assignment and opt-in. Legacy work remains unbounded by
  this new setting until an owner confirms it. Admitted runs reserve their full
  slot envelope conservatively; unrelated extra pending content can hold them.
  More than 1,000 scanned content/run/handoff rows for an assignment fails closed.
- No live/paid pilot, real publication, production flag/migration, push or deployment
  was performed. Local checks do not establish production acceptance.

## MA-06 preparation only

Next work: unify operational projections across plan, assignment, run/task and
publishing services. Reuse current recovery and this backlog exception/state;
show exact degraded/failed/unknown states and held/settled/unknown ledger totals.
Do not introduce a global retry or a second orchestrator.

Required MA-06 acceptance cases: persisted image reused after crash; ambiguous
publication reconciled without a second post; optional research failure labeled
as degraded while required review failure prevents delivery; permissions rechecked
at dispatch; one state event yields one actionable notification. Start from this
branch's reviewed implementation and tests, inspect current main/in-flight changes,
and keep paid/live pilot and production rollout separately authorized. No MA-06
status redesign, new notification transport or recovery control is implemented here.

## Provenance and changed files

The original v2 plan is inherited from `a65e2ec` (traceable plan import and MA-00/01
baseline), through MA-03/04, rather than recreated from memory. MA-05 preserves that
plan and adds a local checkpoint. All implementation is on the separate branch.

- `apps/api/src/modules/marketing/agents/assignment-overview.ts`
- `apps/api/src/modules/marketing/agents/assignment-runs.ts`
- `apps/api/src/modules/marketing/agents/assignments.ts`
- `apps/api/src/modules/marketing/agents/channel-posts.ts`
- `apps/api/src/modules/marketing/agents/content-history.ts`
- `apps/api/src/modules/marketing/agents/novelty.ts`
- `apps/api/src/modules/marketing/agents/review-backlog.ts`
- `apps/api/src/modules/marketing/agents/shared-posts.ts`
- `apps/api/src/modules/marketing/agents/specialists/copywriter.ts`
- `apps/api/src/modules/marketing/agents/specialists/runner.ts`
- `apps/api/src/modules/marketing/agents/specialists/strategy.ts`
- `apps/api/src/modules/marketing/agents/topic-briefs.ts`
- `apps/api/src/modules/marketing/assistant/prompt.ts`
- `apps/api/src/modules/marketing/manifest.ts`
- `apps/api/src/modules/marketing/pipeline/editorial.integration.test.ts`
- `apps/api/src/modules/marketing/pipeline/editorial.ts`
- `apps/api/src/modules/marketing/pipeline/generation.ts`
- `apps/api/src/modules/marketing/plans/activation.ts`
- `apps/api/src/modules/marketing/policy/policy.ts`
- `apps/api/src/modules/marketing/routes.ts`
- `apps/api/src/modules/marketing/scheduler.ts`
- `apps/api/src/modules/marketing/tools/assignment-tools.ts`
- `apps/api/src/platform/assistant/cards.ts`
- `apps/api/src/platform/knowledge/retrieval.ts`
- `apps/api/src/server.ts`
- `apps/api/tests/__snapshots__/assistant-request.characterization.integration.test.ts.snap`
- `apps/api/tests/assignment-copywriter-visual.integration.test.ts`
- `apps/api/tests/content-history.integration.test.ts`
- `apps/api/tests/marketing-novelty-backlog.integration.test.ts`
- `apps/api/tests/marketing-plan-activation.integration.test.ts`
- `apps/api/tests/paid.integration.test.ts`
- `apps/api/tests/specialist-strategy.integration.test.ts`
- `apps/web/src/app/globals.css`
- `apps/web/src/modules/marketing/assignment-card.tsx`
- `apps/web/src/modules/marketing/assignments.test.tsx`
- `apps/web/src/modules/marketing/assignments.tsx`
- `apps/web/src/modules/marketing/plan-card.tsx`
- `apps/web/tests/marketing-plans.spec.ts`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/REQUIREMENTS_TRACEABILITY.md`
- `docs/plans/marketing-agent-v2-ma05.md`
- `docs/plans/marketing-agent-v2.md`
- `evals/generation/harness.ts`
- `packages/api-client/src/generated.ts`
- `packages/schemas/openapi.json`
- `packages/schemas/src/index.ts`
- `packages/schemas/src/marketing-plan.ts`
- `scripts/marketing-plans-browser.ts`

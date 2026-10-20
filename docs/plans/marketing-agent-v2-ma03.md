# Marketing Agent v2 — MA-03

## Scope, risk and implementation plan

Base: local MA-02 commit 60be8f9, integrated with current origin/main 333231f.
The original v2 plan and all MA-00–02 commits remain in the branch history.
Risk: high; environment: isolated local. Primary app profile: ai-agent-app,
with fullstack-saas and web-frontend rules. Existing web-next-custom-postgres
modular monolith; feature workflow. No schema migration or production dependency.

1. Persist a bounded Marketing-owned Entity contract with immutable EntityVersion
   history: objectives, audience/product, pillars, exact sources/facts/profile/policy,
   finite horizon, cadence/timezone, measured/no-data KPI references, existing work,
   human review mode, creative/delivery parameters, assumptions and budget projection.
2. Add bounded context/propose/status/change tools and native read/write/export
   services using current module/role/scope checks. Bind an existing ActionRequest
   to the exact strategic revision. Revisions invalidate previous strategic review.
3. Render the exact strategic review and current status in the existing assistant
   and native decision inbox, with persistent access outside any chat.
4. Verify real scoped DB/API/tool and UI flows with synthetic fixtures, no providers;
   run standard checks, generated contracts and full regression suite.

## Boundary with MA-04

MA-03 strategic approval records only that the owner reviewed the exact proposal.
The plan remains proposed (or dynamically blocked); it is never active. No child
assignment/mission creation, worker job, spend reservation, automatic plan execution
or publication is implemented. Existing linked work is referenced, never changed.
Plan approval does not approve unseen posts. Activation is deliberately unavailable
until MA-04 revalidates the reviewed revision and creates bounded children atomically.

## Threat model and rollback

Chat/model/source text cannot establish spend authority, edit project policy, change
profile language or grant publishing rights. Reject stale/foreign references, unusable
facts/source rights, disconnected or policy-denied channels, unsupported cadence,
missing/unbounded horizons, impossible budgets, hidden/disabled module access and
stale parallel edits. Recheck the exact revision on owner review. Read projections
must show invalidation without mutating history or silently reapproving a proposal.
Export is scoped; audits contain IDs/hashes/counts, not plan text. Generic collection
writes cannot bypass plan validation. Project deletion follows existing Entity
retention; plans and their version history persist independently of private chats.

Rollback locally: revert MA-03 code; existing assignments/content/budgets stay
untouched. If deployed data ever exists, retain the Marketing entity-kind ownership
and export/access filters during rollback, even when hiding tools/UI. Do not leave
stored strategies as unowned kinds. No production migration or rollout is included.

## Evidence

Implemented locally on `codex/marketing-agent-v2-ma03`. Validation results below
are local evidence, not deployment or live-model/provider acceptance.

## Contract and behavior

- Shared `marketingPlanSpec` is a closed versioned strategic contract. Horizon is
  finite, at most 90 days, current and within the active policy. Language, campaign
  class and CTA must match the current reviewed profile and official fact/link.
- Sources are derived from usable exact fact versions plus explicit source refs.
  The stored hash binds the spec and exact source-version snapshot. Marketing
  source audience, model/public rights, embargo and generation are checked. Fact,
  profile, source, policy, asset permission or linked-work drift blocks review.
- A proposed plan is a shared project artifact, independent of private chat rows.
  Editors/owners may propose or revise, viewers may read/export, only a current
  owner may approve strategy. Changes require the expected Entity version and
  invalidate/cancel the previous review. EntityVersion retains immutable history.
- `marketing_plan_context`, `marketing_plan_propose`, `marketing_plan_status`,
  `marketing_plan_change` remain deferred assistant tools behind the existing agents
  feature. The context carries the authoritative spec contract; internal `specJson`
  avoids a second manually maintained model schema. No raw-JSON UI is introduced.
- Context is capped at 32,000 UTF-8 bytes with explicit count/byte/profile truncation,
  freshness timestamp, usable facts, current channels, existing work/plans and
  measured/no-data baselines. It projects the existing month ledger's spent/held/
  unknown totals and mandate ceilings; it never reserves or settles spend.
- Exact retries reuse a pending/reviewed identical strategic proposal under the
  existing project transaction lock. A changed mandate becomes a new revision,
  never an implicit execution change. Similarity across different strategies is
  not an automatic merge.
- Native `marketing_plan.review` reuses ActionRequests and current-owner checks.
  A small optional module-owned `ActionDefinition.summary` callback lets native
  inboxes render the exact snapshot without platform imports of Marketing logic.
  The action costs zero, stores only strategic review and creates no jobs.
- Native Marketing → Plans, chat cards and the generic decisions inbox show
  inactive status, scope/cadence/budget, no-data state, hypotheses, evidence,
  source versions and linked existing work. Status includes actual linked assignment/mission/run
  IDs and state; those independently running records are never claimed as plan
  execution. Current blockers are derived on read; historical review stays auditable.
- No direct MCP plan proposal/action is exposed in MA-03. The existing default
  `mcpProposable` floor refuses delegated proposals for this action; no grant/client
  origin is silently converted to a native proposal. A future adapter must reuse
  these services with explicit requester/grant validation and separate deduplication.

## Native API and retention

- `GET/POST /api/projects/:projectId/marketing-plans`: latest 20 proposals / propose.
- `GET/PUT /api/projects/:projectId/marketing-plans/:id`: current projected status /
  complete validated replacement with `version`.
- `GET .../:id/export`: current spec, source snapshot and latest 50 Entity versions;
  `historyTruncated` explicitly marks older retained history. No delete/purge API.
- `GET .../marketing_plans` is the existing read-only registered collection. Generic
  collection writes refuse this kind. Standard project export includes the artifact;
  project deletion uses existing tenant cascades. No independent automatic retention
  expiry is introduced for a reviewed strategy or its EntityVersion history.
- Authentication, module availability and read/write permission run before schema
  validation, including malformed requests. The reviewed access matrix adds only
  five route rows; no existing rule changed. The extensibility fixture explicitly
  recognizes Marketing's added read-only collection and ownership.

## Remaining boundaries and MA-04 prerequisites

1. Add a separate exact owner activation action. Strategic approval is never a
   substitute for approval of bounded child deltas or unseen content. Reject old
   revisions, inactive/revoked reviewers, source/profile/policy drift and module loss.
2. Reserve no budget at strategic review. Recheck current ledger/assignment capacity
   and use existing assignment/mission validation atomically at activation; multiple
   reviewed strategies do not hold independent spend mandates.
3. Link/revise existing children with expected versions, record authorization origin,
   and create a single bounded child set under the project lock. Replay/parallel
   confirmation must not create copies or impersonate separate human clicks.
4. Capture the approved plan revision on new children/runs without changing legacy
   confirmation hashes. Recheck current creative asset versions and obtain required
   image usage consent before any paid creative execution.
5. Implement active/paused/completed/superseded lifecycle only with the actual
   execution/withdrawal contract. Enforce horizon expiry for owned children while
   leaving independently linked work unchanged. Retain MA-01 exact post approval and ambiguous
   provider outcome reconciliation; this phase starts no remote write.
6. Free-form real-model tool selection and live-provider acceptance remain untested.
   Offline transport replay is orchestration evidence only. Any bounded paid/live
   evaluation or rollout needs its separate authorization.

## Verification

| Check | Result |
| --- | --- |
| Isolated worktree DB migrations/least-privilege/real-role checks | PASS |
| Plan service/API/offline assistant/card/tool-registry focused coverage (5 files) | 57 passed |
| Plan plus access/RLS/worker queue safety coverage (7 files) | 53 passed |
| Final malformed-route/auth matrix/extensibility regression (3 files) | 12 passed |
| Assistant request characterization | 2 passed; reviewed prompt/tool-discovery snapshots |
| Final full suite | 2,946 passed, 273 files, 480.38 seconds |
| Real-stack Playwright with desktop 1280x900 and mobile 390x844 | 1 scenario passed, 7.5 seconds; includes list/detail client navigation, chat closure, owner review, reload, export and zero execution rows |
| OpenAPI/client generation | PASS; reviewed additive plan routes, parameters, request/response types |
| Final production build, lint and root/web typecheck | PASS |
| Source/import-boundary guards | PASS; zero known or new violations |
| Framework / secret scan / whitespace check | PASS; zero framework errors or warnings |

Lint, root/web typecheck and production build are run against the final sources.
No live model/provider behavior is claimed by offline orchestration or browser
fixtures. No worker/provider starts in the browser fixture. Its synthetic account,
project and ignored credential file are cleaned up on shutdown; the isolated test
database remains available for reproduction. The generated knowledge evaluation
artifact is restored to HEAD and excluded from this delta.

The first broad pass exposed validation-before-auth on the new routes and the
extensibility fixture's exact collection list. Authentication/module/write guards
now precede schema validation; malformed project IDs are validated after session
checking and before DB lookup. The matrix diff adds exactly five intended rows,
with anonymous/non-member refusal and viewer mutation refusal; every pre-existing
row is unchanged. Extensibility explicitly retains test-module behavior alongside
the new Marketing collection. The final broad and focused runs pass.

## Changed files (MA-03 delta)

- `apps/api/src/modules/action-requests.ts`
- `apps/api/src/modules/agents/tools/registry.test.ts`
- `apps/api/src/modules/marketing/action-types.ts`
- `apps/api/src/modules/marketing/agents/assignments.ts`
- `apps/api/src/modules/marketing/assistant/conversation.ts`
- `apps/api/src/modules/marketing/assistant/prompt.ts`
- `apps/api/src/modules/marketing/manifest.ts`
- `apps/api/src/modules/marketing/plans/routes.ts`
- `apps/api/src/modules/marketing/plans/service.ts`
- `apps/api/src/modules/marketing/routes.ts`
- `apps/api/src/modules/marketing/tools/index.ts`
- `apps/api/src/modules/marketing/tools/plan-tools.ts`
- `apps/api/src/platform/assistant/cards.ts`
- `apps/api/tests/__snapshots__/assistant-request.characterization.integration.test.ts.snap`
- `apps/api/tests/extensibility.integration.test.ts`
- `apps/api/tests/fixtures/access-matrix.json`
- `apps/api/tests/marketing-plan-chat.integration.test.ts`
- `apps/api/tests/marketing-plan-routes.integration.test.ts`
- `apps/api/tests/marketing-plans.integration.test.ts`
- `apps/api/tests/support/marketing-plan.ts`
- `apps/web/src/modules/marketing/chat-extension.tsx`
- `apps/web/src/modules/marketing/manifest.tsx`
- `apps/web/src/modules/marketing/plan-card.test.tsx`
- `apps/web/src/modules/marketing/plan-card.tsx`
- `apps/web/src/modules/marketing/plans-page.tsx`
- `apps/web/tests/marketing-plans.spec.ts`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/REQUIREMENTS_TRACEABILITY.md`
- `docs/plans/marketing-agent-v2-ma03.md`
- `packages/api-client/src/generated.ts`
- `packages/schemas/openapi.json`
- `packages/schemas/src/index.ts`
- `packages/schemas/src/marketing-plan.ts`
- `scripts/marketing-plans-browser.config.ts`
- `scripts/marketing-plans-browser.ts`

## Reproduction and delivery

Use Node 24.18.0 and Corepack pnpm 11.19.0. Install locked offline dependencies,
run `pnpm db:generate` and `node scripts/test-db-for-worktree.ts`. Load the local
configuration without printing credentials, then run `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm build` and the focused files listed above. API generation uses
canonical `APP_ORIGIN=http://localhost:4320` and the configured local Orbit file.

Browser: start `scripts/marketing-plans-browser.ts`, start Next on 44430 with
`ORBIT_API_ORIGIN=http://127.0.0.1:44431`, then run
`MARKETING_PLAN_E2E=true pnpm exec playwright test --config
scripts/marketing-plans-browser.config.ts`. Use only the isolated synthetic fixture;
it starts no worker, makes no paid call and writes no real Postiz content.

Implemented/tested locally on a separate branch; not pushed, merged, deployed,
production-enabled or live-accepted. MA-04 is prepared only.

# Marketing Agent v2 — MA-04

## Plan, risk and boundary

Local high-risk feature on `codex/marketing-agent-v2-ma04`, based on MA-03
`7c0140f` and fetched `origin/main` `333231f`. Primary profile: ai-agent-app;
complementary fullstack-saas/web-frontend. Existing modular Next/Fastify/Postgres
stack, feature workflow. No migration, dependency, second agent or provider change.

1. Add a separate bounded activation proposal and exact owner ActionRequest.
   Reuse assignment validation/confirmation without synthesizing child decisions.
   Persist authorization origin and approved plan revision outside legacy hashes.
2. Apply explicit create/adopt deltas atomically under the project lock; existing
   assignment/mission references are read-only unless explicitly adopted. Reject
   ambiguous prose changes rather than inventing a mutation. Preserve budget caps.
3. Guard owned work in scheduler and worker boundaries, including paid calls.
   Pause owned children via existing withdrawal/cancellation services; revisions
   pause previous owned execution. Recheck horizon, module, current authority and
   source/profile/policy/asset versions. Keep remote/unknown delivery facts intact.
4. Surface exact child mandates, image consent, lifecycle and actual linked work
   using existing chat, native plans and decisions. Test SQL concurrency/rollback,
   authorization/drift/horizon/pause/legacy behavior and isolated browser flow.

## Threat model and rollback

Model proposals cannot grant authority or spend. Approval binds the strategy hash,
source and asset versions, expected child versions, complete child contents and
current plan revision. Recheck current owner/module scope; human_each continues
through MA-01, including external drafts. Failed activation rolls back all children.
No paid/provider work is performed by proposal or activation itself. Existing run
and publication dedupe/reconciliation remains authoritative. No remote cancellation
is inferred from a local pause. No live model/provider acceptance is claimed.

Rollback: pause active plans using the shipped lifecycle before reverting execution
support. Retain ownership/access/export for persisted plan entities and fail-closed
checks on children carrying plan references; removing those checks while owned
children remain active would be unsafe. No production rollout is authorized.

## Results

The implementation and final local verification are complete. Evidence below
distinguishes the broad regression checkpoint from targeted verification after the
last delivery-time guard, and from unperformed live-provider/production acceptance.

## Implemented contract and lifecycle

- `marketing_plan.activate` is a separate owner ActionRequest, with a 24-hour TTL,
  immutable strategy/source/asset snapshots, expected Entity version and a bounded
  set of at most six exact assignment deltas. Native, chat and generic decision
  views display the actual child contents. Generated-image consent is required
  again at activation; banner additions retain the existing separate consent text.
- Proposing activation makes no child/job/content/reservation/provider write. Owner
  approval stages all children, then confirms them through the existing assignment
  validator/executor, in the same project-serialized transaction as the decision.
  No fake child approvals or `assignment.confirm` requests are generated. A storage,
  validation, consent or permission failure rolls back the complete decision/set.
- Create deltas make standing assignments. An adoption delta names an exact existing
  assignment/version and its full replacement content. Owned children record
  plan/revision/hash/child key/action-request origin outside the legacy assignment
  hash. New runs, generated missions and content retain that approved origin.
- Read-only assignment/mission links remain independent. Prose `proposedChange`
  cannot authorize a mutation: an assignment change needs its explicit child delta;
  mission mutations are refused. Another plan's owned child cannot be adopted.
- The executable envelope checks exact cadence, allowed channels/types, creative
  treatment, approval/delivery modes, official CTA, unique channel/type tuples,
  existing versions and combined replacement budgets. Existing committed capacity
  is credited only for explicitly replaced children, without creating a second
  ledger. Actual paid work still uses project/provider/run/month reservations.
- Native/API/chat pause uses existing run cancellation and unsent-work withdrawal.
  Plan revisions pause old owned work and invalidate strategic/activation review.
  Resumption needs a fresh exact activation adopting every previously owned child;
  it cannot silently create a second child set. A smaller revised budget is allowed.
- Scheduler planning and next-run projection enforce the finite horizon. Worker
  claims, model reservations, copy/image run-budget checks, human release and the
  shared final publication/draft gate recheck current plan authority. Module disable,
  owner loss, stale facts/sources/profile/policy/asset versions and changed child
  mandates stop new execution. Both moved scheduler slots and the actual delivery
  timestamp after owner rescheduling must stay inside the approved horizon. Missing origin preserves independent legacy behavior.
- Existing strategy/copywriter specialists receive approved plan context. Offered
  facts and brief claims stay inside exact plan fact references; campaign type,
  audience, product scope and CTA follow the reviewed plan. The existing DAG,
  scheduler, quality review and MA-01 human post approval remain in use.
- Status links actual owned and independent work, latest runs/costs and bounded raw
  publication/draft delivery states and remote IDs. Pause never relabels a provider
  `outcome_unknown` as canceled/published and does not attempt remote cancellation.

## API and assistant capabilities

- `POST /api/projects/:projectId/marketing-plans/:id/activation` takes `{version,
  children:[{key, assignment, existing?:{id,version}}]}`. `assignment` is the existing
  authoritative assignment contract. Returns the plan and exact pending action.
- `POST .../:id/pause` takes `{version}`. Editors/owners can stop owned work; only a
  current owner can approve activation. Auth/module/write gates precede schema
  validation. The access-matrix delta adds only these two routes (14 lines).
- Existing plan read/export/version history now include activation authority,
  lifecycle and actual linked delivery state. No database migration/retention change.
- Deferred `marketing_plan_activation_context` exposes the executable contract;
  `marketing_plan_activation_propose` accepts bounded internal `childrenJson` and
  expected plan version; `marketing_plan_pause` stops owned work. No model JSON UI.
  The separate context avoids exceeding the shared 12k model-tool output bound.
  Large status outputs explicitly truncate to references; the full saved card/API
  retains the exact reviewable mandate. No direct MCP activation is opted in.

## Remaining limits and MA-05 preparation

- This phase activates bounded standing assignments; existing missions can be linked
  read-only. It does not add an independent mission-edit executor or infer changes
  from prose. Those would need their own typed shared-service deltas and tests.
- A changed strategy retains its previous child provenance for explicit adoption;
  there is no automatic migration, detachment or guessed successor child. Individual
  assignment edits cannot silently replace a plan's execution authority.
- Horizon expiry blocks further owned preparation and dispatch. Existing assignment
  records/capacity, historical reviews and remote/unknown outcomes remain visible;
  no automatic archival, supersession or remote recall is claimed. Pause or a renewed
  reviewed horizon is explicit. Already transmitted paid/remote work keeps existing
  settlement/reconciliation behavior.
- Context and status are bounded projections, not full analytics attribution or a
  promise that every slot was generated/published. Shared quota allocation can expose
  unavailable slots. No new notification transport or periodic plan report is added.
- MA-05 is prepared only: reuse common content history across assignments/packages/
  manual batches, add structured topic/pillar/angle reservations atomically before
  generation, and a clearly owner-visible bounded review backlog setting. Preserve
  exact plan/child/source authority, reserved/unknown spend and human_each gates.
  Test concurrent novelty reservations, incomplete history, queue restart, backlog
  stop/recovery and legacy paths with synthetic providers. Do not implement MA-05
  or run a paid/live pilot as part of this phase.


## Verification and reproduction

Use Node 24.18.0 and Corepack pnpm 11.19.0. Locked offline dependencies and
`pnpm db:generate` were used. `node scripts/test-db-for-worktree.ts` created the
isolated `orbit_test_eds_orbit_marketing_ma04_c4dd51`, applied repository migrations
and verified least-privilege/real-role isolation. No production database was used.
Load the approved local configuration without printing credentials, then run
`pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm framework:check` and
`pnpm secrets:check`. Generate OpenAPI/client with canonical
`APP_ORIGIN=http://localhost:4320` and the local `ORBIT_CONFIG_FILE`.

For focused checks use `marketing-plan-activation.integration.test.ts`, existing
plan service/native route/offline chat tests, `assignment-runs.integration.test.ts`,
`marketing-agent-v2.integration.test.ts`, tool-registry, access-matrix and assistant
request characterization tests, and `plan-card.test.tsx`. The replayed chat/model,
image, Postiz and measurement providers are synthetic; no paid call is authorized.

For browser reproduction start `scripts/marketing-plans-browser.ts` with local
configuration; run Next on localhost:44430 with API at 127.0.0.1:44431. Run
`MARKETING_PLAN_E2E=true pnpm exec playwright test --config
scripts/marketing-plans-browser.config.ts`. The synthetic owner/project are removed
on fixture SIGTERM, including the ignored 0600 credential file. No worker/provider
starts. Browser checks cover desktop 1280x900 and mobile 390x844, strategy review,
chat/native persistence, exact activation, blocked button without image consent,
owner activation through the generic inbox, actual owned status, reload, pause,
export and zero generated jobs/content/publications. Screenshots are visually
inspected for overflow, consent labels, readable authority and correct state.

During development the expanded activation schema exceeded the shared model tool
transport limit; splitting the read context keeps valid JSON. Browser setup was
corrected to supply the required Origin header (the security guard remains).
The first broad test run overlapped lineage edits and caught a missing new
mission/content origin in its loaded generation module, plus the registry fixture's
exact new-tool order. Lineage and order checks subsequently pass on stable sources.
The broad result below is followed by final targeted delivery verification of the
last scheduled-time guard; development failures are not counted as passing results. Assistant snapshots change only agent-enabled
instructions/tool discovery; the always-loaded tool set and other setups remain.

| Final check | Result |
| --- | --- |
| Full Vitest regression checkpoint | 2,976 passed, 274 files, 503.94 seconds; followed by final targeted delivery-time verification |
| Final delivery-time guard, activation and existing publishing/draft/release/veto paths | 121 passed, 5 files, after the last delivery-time guard change |
| Focused activation/scheduler/provider-fake workflow | 82 passed, 3 files; includes both horizon-bound slot shifting and disabled successor queueing |
| Native auth matrix / tool registry / characterization / UI | 30 passed, 4 files |
| Real-stack browser, desktop/mobile | 1 passed, 10.7 seconds |
| Lint / root and web typecheck / production build | PASS on final sources |
| Generated OpenAPI/API client | PASS |
| Framework / secrets / whitespace / import boundaries | PASS |

## Changed files (MA-04 delta)

- `apps/api/src/modules/action-requests.ts`
- `apps/api/src/modules/agents/tools/registry.test.ts`
- `apps/api/src/modules/marketing/action-types.ts`
- `apps/api/src/modules/marketing/agents/assignment-runs.ts`
- `apps/api/src/modules/marketing/agents/assignments.ts`
- `apps/api/src/modules/marketing/agents/owner-release.ts`
- `apps/api/src/modules/marketing/agents/specialists/copywriter.ts`
- `apps/api/src/modules/marketing/agents/specialists/runner.ts`
- `apps/api/src/modules/marketing/agents/specialists/strategy.ts`
- `apps/api/src/modules/marketing/assistant/prompt.ts`
- `apps/api/src/modules/marketing/pipeline/generation.ts`
- `apps/api/src/modules/marketing/plans/activation.ts`
- `apps/api/src/modules/marketing/plans/execution.ts`
- `apps/api/src/modules/marketing/plans/lifecycle.ts`
- `apps/api/src/modules/marketing/plans/routes.ts`
- `apps/api/src/modules/marketing/plans/service.ts`
- `apps/api/src/modules/marketing/policy/policy.ts`
- `apps/api/src/modules/marketing/tools/plan-tools.ts`
- `apps/api/tests/__snapshots__/assistant-request.characterization.integration.test.ts.snap`
- `apps/api/tests/fixtures/access-matrix.json`
- `apps/api/tests/marketing-agent-v2.integration.test.ts`
- `apps/api/tests/marketing-plan-activation.integration.test.ts`
- `apps/api/tests/marketing-plan-routes.integration.test.ts`
- `apps/api/tests/marketing-plans.integration.test.ts`
- `apps/web/src/modules/marketing/manifest.tsx`
- `apps/web/src/modules/marketing/plan-card.test.tsx`
- `apps/web/src/modules/marketing/plan-card.tsx`
- `apps/web/src/modules/marketing/plans-page.tsx`
- `apps/web/tests/marketing-plans.spec.ts`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/REQUIREMENTS_TRACEABILITY.md`
- `docs/plans/marketing-agent-v2-ma04.md`
- `packages/api-client/src/generated.ts`
- `packages/schemas/openapi.json`
- `packages/schemas/src/marketing-plan.ts`
- `scripts/marketing-plans-browser.ts`

## Delivery state

Implemented and tested locally only. No push, merge into main, deployment,
production flag change, paid/live model/provider call or real Postiz write. MA-05
is prepared, not implemented. The retained test DB is for local reproduction only. Browser API/web processes and
synthetic credentials are removed; ignored screenshots remain for inspection. The
knowledge evaluator output is restored to HEAD and is not part of this change.

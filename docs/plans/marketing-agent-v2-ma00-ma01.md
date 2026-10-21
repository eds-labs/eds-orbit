# Marketing Agent v2 — MA-00 / MA-01 implementation record

## Baseline and provenance

Implementation branch: `codex/marketing-agent-v2-ma00-ma01`, created from fetched
`origin/main` at `e67cb711dbd94c62f76d31e170e26d2a3bbd64ac` on 2026-10-20.
The strategy document `docs/plans/marketing-agent-v2.md` was copied unchanged
from the uncommitted planning worktree `EDS-Orbit-marketing-plan`, branch
`codex/marketing-agent-v2-plan` (analysis base `dd902d8`). Its inventory is a
historical planning snapshot; implementation uses the newer base above.

## Risk / environment / approach

High risk, isolated local environment. AI-agent-app profile with fullstack-SaaS
and existing web-frontend conventions; feature workflow and existing modular
monolith. No new dependencies, migrations or production configuration.

Threats addressed: model approval mistaken for human authority; draft handoff
bypassing publishing approval; stale body/media/policy/assignment authorization;
removed owner permission; duplicate confirmation/worker dispatch. Existing
RLS, budgets, module activation and outbox identities are retained.

Implementation sequence: characterize existing legacy services; add creation-only
safe default and exact package gate; surface mode through chat and management;
exercise real services with synthetic transports; run focused regressions and
required repository checks. MA-02 is preparation only.

Rollback: pause new human-gated assignments before deploying an older binary
that cannot enforce the mode. Preserve records/approvals/publications and legacy
confirmation hashes. Never remove the server guard merely by hiding the UI.

## Verification

Local implementation commit: `7d13f30`; imported-plan commit: `bfb9c6e`.

- Focused safety/regression run: **244 tests passed across 17 files**.
- Assistant request characterization: **2 tests passed**, with 2 intentional
  snapshot updates reviewed against the approval-first prompt contract.
- Playwright: **1 test passed**, exercising both desktop and mobile, reload and
  the native app-approval card against the real isolated API/web/auth stack.
  Screenshots were inspected; the approval text and controls remain readable.
- Lint/source guards, import boundaries (zero new or baseline violations), root
  and web typecheck, production build, canonical OpenAPI/client regeneration,
  framework check (0 errors / 0 warnings), and secret-pattern scan passed.
- Final complete suite on the finished implementation: **2,897 passed / 1
  failed across 269 files** (554.12 s). The sole failure is the independently
  reproduced baseline I7b pause/resume defect. All MA-00/MA-01 scenarios and
  updated prompt/MCP contracts pass; the repository as a whole is not green.
- Synthetic browser API/web services and browser test users were stopped and
  cleaned up after acceptance. The separate baseline verification DB/worktree
  was removed. The implementation worktree's isolated test DB is retained for
  reproducibility and MA-02 development.

## Implemented behavior

- `approvalMode` is optional in persisted assignment JSON for legacy compatibility.
  Creation through chat, native proposal services and MCP defaults to `human_each`.
  `delegated_review`, or an absent field on an existing row, retains prior
  agent-review/Telegram/veto authority. Hash normalization omits the legacy
  default so existing confirmations remain valid.
- The mode is an exact confirmed assignment field, copied through mission and
  generated content. Changing it requires assignment reconfirmation. Human-gated
  content stays human-gated even if its parent assignment later changes mode.
- Agent quality review continues but cannot authorize external handoff for
  `human_each`. Every draft, including style-only copy, remains in owner review.
- Existing Owner Release records the human content review and existing package
  approval in every policy mode. Both publication and Postiz-draft paths recheck
  the exact package and the deciding user's current owner membership.
- Human approvals bind existing content version/body/title/channel/link/time,
  image version/hash, evidence version/hash and connector/policy snapshot, plus
  the assignment/confirmation hash and current profile version. No additional
  approval database or autonomous agent is introduced.
- Publication consumption remains single-use. Only the same claimed publication
  can continue using its consumed approval at final preflight; it cannot approve
  another publication or changed content.
- Postiz draft booking, preparation and send all enforce the guard, including
  revalidation after media reads and upload. Human-approved image failure cannot
  silently fall back to a text-only post. Legacy image fallback is unchanged.
- The article-to-Drive helper also rejects agent-only handoff for human-gated
  content. Blog/newsletter manual release remains a separate limitation below.
- Chat cards, the app-approval inbox and assignment management expose the mode
  separately from the delivery target. Human-gated cards explicitly explain
  preparation versus approval of each exact future post.

## MA-00 test scope and remaining gaps

`apps/api/tests/marketing-agent-v2.integration.test.ts` runs actual chat tool
selection/validation, ActionRequest confirmation, project scheduler, assignment
DAG, all six specialists, claim review, text and image persistence, human release,
publication claim/completion and the Postiz draft sender. Recorded chat/model
responses, synthetic image output and fake connector transports are used; DB
transactions/RLS and business services are real. The second weekly run is planned
without a new chat, and duplicate scheduler sweeps do not multiply it.

This is a deterministic service end-to-end test, not a live-model interpretation
assessment. The publishing path completes as `published_test`; the separate
Postiz draft path invokes a fake transport exactly once. Neither result proves
live Postiz delivery or authorizes any real provider call.

The Playwright case uses actual Next/Fastify/auth/SQL services and a synthetic
account, checks management and the owner confirmation card after reload at
1280×900 and 390×844, and verifies that the assignment remains a draft. No worker
is started by the browser fixture, and no model or external provider is called.

Known existing gap **I7b**: after project pause/resume, the agent research job stays
`blocked_dependency` with `PROJECT_PAUSED` instead of becoming `queued` with no
error. Independently reproduced on unchanged baseline `e67cb71` using a second
isolated test DB (`agent-runner.integration.test.ts -t I7b`: 1 failed, 2 passed,
17 skipped). This task does not silently repair or weaken that regression.

Other scope boundaries:

- A duplicate worker encountering a handoff already marked `sending` retains the
  existing conservative `outcome_unknown`/late-result handling. It never resends
  automatically; manual reconciliation may still be needed.
- New human-gated blog/newsletter work remains local until an explicit exact
  approval/export path is used. Owner Release is currently a social-post action;
  this task blocks automatic Drive handoff rather than adding an article-release UI.
- Existing owner release retains same-day slot selection; no campaign strategy,
  multi-assignment coordination, backpressure policy or analytics improvement
  manager is introduced in MA-00/MA-01.
- Feature defaults do not prove live activation. No paid model/image request,
  genuine external publication, migration or production flag change occurred.

## Reproduction

Use Node from `.nvmrc` and `corepack pnpm` (11.19.0), install with the frozen lockfile,
and run `node scripts/test-db-for-worktree.ts` in this worktree. Follow README's
"Parallel worktrees" instructions to load the main checkout's ignored local
configuration without displaying it; `.runtime/test.env` overrides the DB/queue
scope. Never point tests at a production or shared test database.

API scenario: `vitest run apps/api/tests/marketing-agent-v2.integration.test.ts`.
Relevant existing suites cover assignments/tools/routes, Owner Release, agent
review/veto, Postiz drafts, budgets, module/RLS/access matrices and worker dispatch.
Snapshot updates in the assistant-request characterization suite are intentional:
new mode descriptions and approval-first instructions replace the old contract;
behavioral safety assertions remain separate from those byte snapshots.

Browser fixture, from repository root with the local configuration loaded:

```sh
node --import tsx scripts/marketing-agent-v2-browser.ts
```

In a second terminal start Next in `apps/web`:

```sh
ORBIT_API_ORIGIN=http://127.0.0.1:44331 node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 44330
```

Then from repository root:

```sh
MARKETING_V2_E2E=true corepack pnpm exec playwright test --config scripts/marketing-agent-v2-browser.config.ts
```

The fixture refuses to run without the worktree DB file, writes only random
synthetic browser credentials to ignored mode-0600 storage, and cleans up its
project/user when stopped with SIGINT/SIGTERM. The legacy comparison assignment
is paused so even an independently started test worker has no browser work to run.

## MA-02 preparation only

MA-02 should connect the reference natural-language request to one bounded
approval-first assignment and useful progress/output cards. Prerequisites:

1. Keep `human_each` creation and external-write gates passing with review
   authority on, Telegram linked and both delivery targets selected.
2. Carry the mode through every new context/card/status projection, including
   the platform app-approval inbox; no UI fallback may label a new human-gated
   assignment as delegated.
3. Resolve budget, cadence and English-profile mismatch before proposing work;
   use only current connected/policy-authorized channel IDs.
4. Reuse matching assignments and show saved assignment/run/content/cost/blocker
   IDs. Add natural-language tool-selection evaluations separately from recorded
   transport replay; no paid evaluation without explicit authorization.
5. Account for the independently reproduced I7b resume defect before promising a
   pause/resume-capable pilot. Keep unknown Postiz handoffs visible and reconciled.

Do not start a new planning engine, strategy persistence, navigation redesign or
MA-02 implementation in this branch.

## Changed files

The branch contains these 30 scoped files, including the imported plan:

- `apps/api/src/modules/action-requests.ts`
- `apps/api/src/modules/marketing/agents/agent-review.ts`
- `apps/api/src/modules/marketing/agents/assignment-overview.ts`
- `apps/api/src/modules/marketing/agents/assignments.ts`
- `apps/api/src/modules/marketing/agents/owner-release.ts`
- `apps/api/src/modules/marketing/agents/specialists/copywriter.ts`
- `apps/api/src/modules/marketing/agents/specialists/review.ts`
- `apps/api/src/modules/marketing/assistant/prompt.ts`
- `apps/api/src/modules/marketing/pipeline/generation.ts`
- `apps/api/src/modules/marketing/policy/policy.ts`
- `apps/api/src/modules/marketing/publishing/postiz-draft.ts`
- `apps/api/src/modules/marketing/publishing/publisher.ts`
- `apps/api/src/modules/marketing/tools/assignment-tools.ts`
- `apps/api/src/platform/assistant/cards.ts`
- `apps/api/tests/__snapshots__/assistant-request.characterization.integration.test.ts.snap`
- `apps/api/tests/assignment-tools.integration.test.ts`
- `apps/api/tests/assignments.integration.test.ts`
- `apps/api/tests/marketing-agent-v2.integration.test.ts`
- `apps/api/tests/mcp-proposal-flow.integration.test.ts`
- `apps/web/src/modules/marketing/assignment-card.test.tsx`
- `apps/web/src/modules/marketing/assignment-card.tsx`
- `apps/web/src/modules/marketing/assignments.test.tsx`
- `apps/web/src/modules/marketing/assignments.tsx`
- `apps/web/tests/marketing-agent-v2.spec.ts`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/REQUIREMENTS_TRACEABILITY.md`
- `docs/plans/marketing-agent-v2-ma00-ma01.md`
- `docs/plans/marketing-agent-v2.md`
- `scripts/marketing-agent-v2-browser.config.ts`
- `scripts/marketing-agent-v2-browser.ts`

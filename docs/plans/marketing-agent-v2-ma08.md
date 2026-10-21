# MA-08 — assistant-led Marketing navigation

## Risk Level / Environment
High / local: navigation crosses module/role boundaries and leads to existing paid
work and approval surfaces. Base `de28a0c` (MA-07); fetched `origin/main` is still
`333231f4`, verified as an ancestor. Isolated branch `codex/marketing-agent-v2-ma08`.
Primary profile: web frontend, supplemented by fullstack/tenant rules. Retain the
existing Next/Fastify modular monolith and registered Orbit Assistant; no new agent,
route store, provider, dependency, migration or production flag.

## Plan before implementation
1. Add a compact module-owned Marketing entry to project home, the overview and the
   existing Assistant, with explicit links to plans, content approvals and reports.
   Promote Assistant planning; keep manual Creator/Studio, missions and assignments
   directly accessible at their existing URLs.
2. Reuse module chat contributions for templates/navigation. A template only fills
   the composer; navigation never sends a message, grants approval or starts work.
   Hide unavailable Marketing contributions and honor advertised module roles.
3. Make the saved plan list and detail explain the current next step, with exact
   links for strategy review, assignment preparation/activation and content release.
   Retain native versioned decisions, source guards and separate activation.
4. Preserve legacy paths and cross-module App approvals. Cover feature-off, module-
   disabled, module-role none/viewer, empty/loading/error states and project changes.
5. Verify component/route regressions and a synthetic desktop/mobile keyboard flow,
   then run repository lint/typecheck/full tests/build and document MA-09 preparation.

## Threat model / test / rollback
A prominent button must not imply a grant or bypass a human decision. Client role
presentation derives from current server-advertised module access; server authority
is unchanged. No content/credentials in URLs or persistent storage. Reuse the existing
project-bound temporary composer handoff. Module contributions disappear when access
is none/disabled; shared App approvals remain independent of Marketing. Use only
synthetic isolated database/browser fixtures and mock providers, no worker or live
provider calls for navigation. Regression tests retain safety matrices and budgets.
Rollback: revert this UI/contribution change; no schema/data migration or production
operation. No push/deployment/live pilot is implied by this phase.

## Implemented behavior

### One assistant and a clear path
The project-home Marketing card and module overview now lead with the registered
Orbit Assistant, followed by saved plans and deliberate per-post review. The module
contributes navigation and editable templates through the existing chat extension
contract. Marketing suggestions disappear when the module is hidden/disabled;
with agent functionality off the existing manual weekly-mission suggestions remain.
The new default plan template explicitly requests `human_each`, source checks and
separate strategy/assignment approval. It does not submit itself.

The existing project-bound session draft handoff is reused for planning and continuing
an exact saved plan. No new conversation store, assistant route, worker, API mutation,
provider call or implicit execution was introduced. A reader gets a stored-status
prompt and read navigation instead of proposal controls. Server-advertised module
roles drive module-page controls and each module's chat suggestions, including editor
and viewer overrides. Native current-role checks remain authoritative.

### Plans, review and manual work
The bounded saved-plan list now links to each exact saved plan and describes its next
step: check blockers, review strategy, approve exact assignments, prepare assignments
in the Assistant, review posts while active, or separately review resumption. These
are descriptions, never claims of approval/completion. The detailed view retains the
native versioned strategy and activation cards; it adds navigation to content release,
reports and shared App approvals. Loading/errors/empty states remain explicit.

Plans become the Marketing bottom-bar candidate after Approvals (rank 35). Home,
Assistant, Tickets and Approvals retain their priority; on a project without Support,
Plans now represents Marketing instead of Content. Creator/Studio, missions and
assignments stay direct sidebar/manual-tool links at their existing URLs. The report
section gets a stable anchor without changing report state or data.

### Feature metadata and compatibility
The authenticated module-status response now advertises `features.agents` using the
existing `agentsEnabled()` guard. It is one additive boolean on an existing read-only
endpoint; no flag or activation default changes. OpenAPI/client generation was run
and yields no artifact diff because this existing response envelope is not sealed.
`NavEntry.feature` filters only navigation; original deep-link routes remain registered.
A bookmarked plan URL explains when the feature is unavailable and links to manual
work. Legacy chat/content/mission/calendar/approval/result URLs retain their rewrites.
Shared App approvals and pending Support requests remain reachable with Marketing off.

### Accessibility, security and cost review
Native links/buttons, named navigation regions, headings, status/error states and
visible focus styles are retained. Desktop/mobile keyboard navigation reaches the
saved proposal. Mobile action buttons stack to avoid clipped text; text width and
page overflow are asserted in the browser. Colors and scoped styles reuse the
Arctic Blue system, without animation or a global redesign.

The compact home entry fetches no plans. The overview reuses the existing maximum-20
plan endpoint and shows at most three recent rows; detail reads the exact selected
ID. No new polling/N+1/read model or dependency. Module/feature absence stops the new
entry fetches. Escaped titles and project-bound links are covered. The isolated
browser flow records zero POSTs after authentication, and verifies zero assignments,
publications and Postiz drafts. The synthetic Support request is inspected only,
never approved/dispatched, and has no real customer or ticket destination.

## Remaining limits
- The shared mobile bar has four candidates plus More. With Support enabled, Tickets
  and Approvals retain priority; Plans remains reachable through the Assistant,
  project-home entry, module overview and drawer.
- Plans list at most twenty existing snapshots, the overview three; they are not a
  new complete historical search. All actual decisions, pending content and report
  evidence stay in the existing guarded surfaces.
- Feature/module data is navigation presentation, never authorization. Failed/unknown
  feature advertisement hides the new entry; the server continues checking roles,
  project pause, sources, policy, budget and exact approvals on all actions.
- No paid generation, external send, flag activation, migration, push, deployment or
  live pilot acceptance. Paid report assignments remain disabled as documented in MA-07.

## Verification
The successful final full regression ran with frozen application/test source.
No application/test file changed during it. These are local results; no merged,
deployed, enabled or live-accepted state is inferred.

| Check | Result |
| --- | --- |
| Final full Vitest regression | **3,037 tests passed in 279 files**, 595.49 seconds, dedicated MA-08 database |
| Targeted native feature and UI navigation cases | Passed, including server on/off advertisement and ten new component cases |
| Desktop/mobile Playwright | **5 scenarios passed**, 8.5 seconds; 1280×900 and 390×844, keyboard navigation, reload, exact pending review, manual/legacy paths, module none/viewer and Marketing-off Support approvals |
| Lint / root and web typecheck / production build | Passed |
| OpenAPI / generated client | Regenerated successfully; no artifact diff |
| Framework / secrets / import boundaries / diff | Passed; zero framework errors/warnings, zero import violations, 1,411 candidate text files scanned |

Source manifest: 981 application/test/script files, SHA-256
`3c0ed27dc4e187b1811c77316d37bc3aba202ddb9634e05a63049772b942e16f`.
Generated deterministic-eval/source-manifest outputs are restored to HEAD before
commit, rather than included as product changes.

The first browser run exposed missing agent-feature advertisement; the additive
server read field and real-API on/off test address it. Visual inspection then found
a narrow mobile button; scoped stacking plus an element-width assertion fix it.
Browser role negatives initially hit a shared local sign-in rate limit. Each case
now asserts successful sign-in and uses a synthetic test-network client IP, retaining
the native rate-limit checks. The final five-case browser run passed in 8.5 seconds.

### Reproduction

Use Node 24.18.0 and pnpm 11.19.0. Prepare the worktree's isolated database with
`node scripts/test-db-for-worktree.ts`; `.runtime/test.env` selects its own database
and Redis namespace, never the shared test or production database.

- `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm build`
- `node --env-file=<local-runtime-env> node_modules/vitest/vitest.mjs run`
- `APP_ORIGIN=http://localhost:4320 ORBIT_CONFIG_FILE=<local-runtime-env> corepack pnpm api:generate`
- `corepack pnpm framework:check`, `corepack pnpm secrets:check`, `git diff --check`, `git diff --cached --check`
- Browser fixture: `node --import tsx --env-file=<local-runtime-env> scripts/marketing-navigation-browser.ts`
- Built web: `ORBIT_API_ORIGIN=http://127.0.0.1:44431 node apps/web/node_modules/next/dist/bin/next start apps/web --hostname 127.0.0.1 --port 44430`
- Browser regression: `MARKETING_NAV_E2E=true node --env-file=<local-runtime-env> node_modules/@playwright/test/cli.js test --config scripts/marketing-navigation-browser.config.ts`

No worker is started. Stop both fixture servers after testing. Their signal handler
removes synthetic accounts/projects and the mode-0600 runtime credential file;
screenshots/traces remain ignored local evidence. This cleanup was verified locally.

## Changed files

- `apps/api/src/server.ts`
- `apps/api/tests/module-activation.integration.test.ts`
- `apps/web/src/app/globals.css`
- `apps/web/src/components/chat.tsx`
- `apps/web/src/components/orbit.tsx`
- `apps/web/src/modules/marketing/chat-extension.tsx`
- `apps/web/src/modules/marketing/chat-templates.ts`
- `apps/web/src/modules/marketing/home.tsx`
- `apps/web/src/modules/marketing/manifest.tsx`
- `apps/web/src/modules/marketing/marketing-entry.tsx`
- `apps/web/src/modules/marketing/marketing-navigation.test.tsx`
- `apps/web/src/modules/marketing/overview.tsx`
- `apps/web/src/modules/marketing/plan-navigation.tsx`
- `apps/web/src/modules/marketing/plans-page.tsx`
- `apps/web/src/modules/marketing/reports.tsx`
- `apps/web/src/platform/assistant/extensions.ts`
- `apps/web/src/platform/shell/nav-groups.test.tsx`
- `apps/web/src/platform/shell/routes.test.tsx`
- `apps/web/src/platform/shell/routes.ts`
- `apps/web/src/platform/shell/shell-context.tsx`
- `apps/web/src/platform/shell/types.ts`
- `apps/web/tests/marketing-navigation.spec.ts`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/MODULE_ACTIVATION.md`
- `docs/REQUIREMENTS_TRACEABILITY.md`
- `docs/plans/marketing-agent-v2-ma08.md`
- `scripts/marketing-navigation-browser.config.ts`
- `scripts/marketing-navigation-browser.ts`

## MA-09 preparation only
A live uLiquid Desk pilot remains separately authorized. Before it: integrate the
completed phase chain with current main, verify exact deployed revision and flags,
roles/source rights/policy/budgets/worker readiness, then obtain a concrete bounded
paid-spend and exact first-publication approval. Observe two weekly cycles and a
measured/no-data report. Do not enable paid report assignments or accept live delivery
from synthetic navigation tests. MA-09 is not executed in this phase.

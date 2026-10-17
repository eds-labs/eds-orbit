# 07 — Roadmap: prioritized work packages

**Status:** Accepted plan ([ADR 0009](../../docs/adr/0009-modular-platform.md), 2026-10-13). Each WP still needs its own go and, for production steps, its own approval. Each work package (WP) is meant to become one or a few small PRs.

**Effort** is given in person-days (PT) for one developer who knows the codebase. It includes tests and review fixes, but not production rollout waiting time.

**Risk class** follows `.agentic/routing/risk-classification.md`.

**Every phase ends in a deployable, fully working Orbit.** Until WP2.4, every PR is behaviour-neutral.

---

## Overview

| Phase | WP | Title | Risk | PT | Depends on |
|---|---|---|---|---|---|
| 0 | WP0.1 | Decision baseline (these documents, decisions D/Q) | low | 1 | — |
| 0 | WP0.2 | Safety net: RLS matrix, route×role matrix, worker smoke, no silent skip | medium | 4–6 | — |
| 0 | WP0.3 | Import-boundary checker (report mode) and baseline | low | 1–2 | — |
| 0 | WP0.4 | Characterization tests: knowledge invalidation, sweep order, prompt/tool snapshot | medium | 2–3 | — |
| 1 | WP1.1 | Extract platform kernel (shared, enqueue, scope, telemetry, budget mechanics) | medium | 3–4 | WP0.2, WP0.3 |
| 1 | WP1.2 | Spend mandate projection; knowledge stops importing marketing policy | medium | 2–3 | WP1.1 |
| 1 | WP1.3 | `module-contracts` and static registry with transitional manifests | medium | 2–3 | WP1.1 |
| 1 | WP1.4 | `ProjectModule` table, activation API, backfill (not enforced) | high | 3–4 | WP1.3 |
| 1 | WP1.5 | Permission catalogue reproducing today's checks | high | 4–6 | WP0.2, WP1.3 |
| 1 | WP1.6 | Open registries: tools, actions, task classes, run kinds, queues, scheduler, readiness | medium | 5–7 | WP1.3, WP0.4 |
| 1 | WP1.7 | Web shell: `platform/ui`, organization/project picker, project home, URL scheme, nav registry | medium | 6–9 | WP1.4 (read API) |
| 1 | WP1.8 | Pause hooks, export/retention hooks | medium | 2–3 | WP1.6 |
| 2 | WP2.1 | Move marketing server code into `modules/marketing`; worker uses registry | medium | 6–9 | WP1.6, WP1.8 |
| 2 | WP2.2 | Assistant prompt composition (byte-identical) and marketing proposals | medium | 2–3 | WP1.6, WP0.4 |
| 2 | WP2.3 | Move marketing UI into `web/modules/marketing`; module settings panels | medium | 5–7 | WP1.7 |
| 2 | WP2.4 | Enforce module activation behind `ORBIT_MODULES` | high | 3–4 | WP1.4, WP2.1, WP2.3 |
| 2 | WP2.5 | Connections registry, notification transport, callback routing | high | 4–6 | WP2.1 |
| 2 | WP2.6 | Production rollout of Phases 1–2 | high | 2–3 | all of the above |
| 3 | WP3.1 | Impact handlers replace marketing writes in `invalidate()` | high | 3–4 | WP0.4, WP2.1 |
| 3 | WP3.2 | Knowledge services facade, one `knowledge_search`, central `usableFacts` | medium | 3–5 | WP1.2, WP1.6 |
| 3 | WP3.3 | Knowledge module: server manifest, routes and actions, web module with URL tabs | medium | 4–6 | WP1.7, WP3.2 |
| 3 | WP3.4 | Marketing fact consumers; tenant vocabulary to profile | low | 2–3 | WP3.2 |
| 3 | WP3.5 | Source audiences (optional, Support prerequisite) | medium | 2–3 | WP3.2 |
| 4 | WP4.1 | Extensibility tests: activation, permissions, cross-module agent action (fixture module) | medium | 3–4 | WP2.4, WP3.3 |
| 4 | WP4.2 | Public ingress: webhook and public-API patterns, CORS, per-client rate limits, idempotency | high | 3–5 | WP4.1, F-02 fix |
| 4 | WP4.3 | Advisory-lock measurement, lock-free read path, Redis pub/sub real-time fan-out | high | 3–5 | WP2.6 |
| 4 | WP4.4 | Cross-module operator eval (offline) | low | 2–3 | WP4.1 |
| 4 | WP4.5 | Module-level roles | high | 3–4 | WP1.5, WP2.4 |
| 4 | WP4.6 | Platform files: object storage for attachments | high | 4–6 | WP1.1 |
| 4 | WP4.7 | E-mail connection, in-app notifications, notification preferences | high | 5–7 | WP2.5, Q-16 |
| M | WP-M1 | OAuth authorization server, consent and grants, Connected apps (`09`) | high | 5–7 | WP1.5, F-02 fix, AD-21 |
| M | WP-M2 | MCP gateway core (own service, transport, token to grant to scope, registry adapter, audit, limits) | high | 5–7 | WP-M1, WP1.6, WP2.4 |
| M | WP-M3 | MCP read surface: `search`/`fetch`, profile, projects, resources, reviewed read tools | medium | 3–5 | WP-M2, WP3.2 |
| M | WP-M4 | MCP proposal surface: ActionRequests, approval links and elicitation, quotas, budget | high | 3–5 | WP-M3 |
| M | WP-M5 | MCP client compatibility (ChatGPT, dots check, second client), security review, rollout | high | 3–5 | WP-M4 |
| M | WP-M6 | Optional MCP events (`subscriptions/listen`) | medium | 2–4 | WP-M2, WP4.3 |
| 5 | WP5.1 | Support module skeleton and data model | high | 4–6 | WP4.1, WP4.5, WP4.6 |
| 5 | WP5.2 | Agent workspace UI | medium | 8–12 | WP5.1, WP1.7 |
| 5 | WP5.3 | E-mail channel | high | 4–6 | WP5.1, WP4.2, WP4.7 |
| 5 | WP5.4 | Livechat widget | high | 8–12 | WP5.1, WP4.2, WP4.3 |
| 5 | WP5.5 | Support notifications and automations | medium | 4–6 | WP5.1, WP4.7 |
| 5 | WP5.6 | Support AI: triage, grounded drafts, widget answer, handoff | high | 6–9 | WP5.1, WP3.2, WP3.5, Q-12 |
| 5 | WP5.7 | Support statistics | low | 3–4 | WP5.1 |
| 5 | WP5.8 | Support privacy and operations | high | 3–4 | WP5.1 |
| 5 | WP5.9 | Support MVP pilot rollout | high | 2–3 | WP5.1–WP5.8 |
| 6 | E1–E14 | Support extensions (`06` §2.2), each planned separately | — | ≈ 50–80 | Support MVP |

**Totals:**

| Scope | PT |
|---|---|
| Phase 0 | 8–12 |
| Phase 1 | 27–39 |
| Phase 2 | 22–32 |
| Phase 3 | 14–21 |
| Phase 4 | 23–34 |
| **Modularization program (Phases 0–4)** | **≈ 94–138** |
| Track M: MCP gateway | 21–33 |
| **Modularization + MCP** | **≈ 115–171** |
| Phase 5: Support MVP | 42–62 |
| **Including MCP and Support MVP** | **≈ 157–233** |
| Phase 6: Support extensions | ≈ 50–80 (rough) |

**Critical paths:**
- Modularization: WP0.2 → WP1.1 → WP1.3 → WP1.6 → WP2.1 → WP2.4 → WP2.6 → WP3.1.
- Support MVP: WP3.2/WP3.5 and WP4.1–WP4.7 → WP5.1 → WP5.3/WP5.4/WP5.6 → WP5.9.
- MCP: WP1.5 + WP1.6 + WP2.4 + WP3.2 (+ F-02 fix) → WP-M1 → WP-M2 → WP-M3 → WP-M4 → WP-M5. Track M can run in parallel with Phase 4 and before Phase 5, so Support tools appear in MCP automatically.

---

## Phase 0: Analysis and safeguards

### WP0.1 Decision baseline
- **Status:** **done 2026-10-13.** Mario accepted AD-01 to AD-23 and answered Q-01, Q-02, Q-05, Q-06, Q-10, Q-14 and Q-22. The baseline is recorded in `docs/adr/0009-modular-platform.md` plus an addendum to ADR 0007.
- **Goal / result:** Mario accepts or adjusts AD-01 … AD-14 and answers the blocking open questions (Q-01, Q-02, Q-05, Q-06). The result is the accepted `08-risks-and-decisions.md` plus a short ADR `docs/adr/0009-modular-platform.md`.
- **Components:** documentation only.
- **Changes:** none in code.
- **Prerequisites:** these documents.
- **Acceptance:** each decision has the status accepted, changed or deferred, with a date.
- **Tests:** none.
- **Risks / rollback:** none.
- **Effort:** 1 PT.

### WP0.2 Safety net
- **Goal / result:** Refactoring regressions become visible automatically.
- **Components:** `apps/api/tests`, `apps/worker/tests`, `tests/setup.ts`, `.github/workflows/orbit-ci.yml`, `scripts/test-marketing-profile-migration.ts`.
- **Changes:**
  1. **RLS matrix test.** For every table with RLS (read from `pg_class.relrowsecurity` and `relforcerowsecurity`), as `orbit_app`:
     - an unscoped SELECT returns 0 rows;
     - project A's scope cannot read, update or insert project B's rows;
     - every business table is listed in the expected set, so a new table without RLS fails the test.
  2. **Route × role matrix.**
     - Enumerate registered routes (`app.printRoutes` / `onRoute`) and actions (the owner list plus the action set).
     - Assert the expected status for owner, editor, viewer and non-member.
     - Generate the expectation file once from today's behaviour, then review it.
  3. **Worker handler smoke tests** for the queues without direct tests (ingestion, embedding, reindex, index_evaluation, analytics, reconciliation, slack_notification), with stubbed providers.
  4. **CI guard.** In CI, a missing `TEST_DATABASE_URL` fails the run instead of skipping 69 files.
  5. Add `test:migration-profile` to CI.
- **Prerequisites:** none.
- **Acceptance:**
  - All new tests are green on `main`.
  - The matrix files are committed.
  - CI fails on an artificially removed RLS policy, verified locally.
- **Tests:** these are the tests.
- **Risks / rollback:**
  - The matrix may reveal existing permission bugs, for example `add-member` (see `08`, F-01). These are recorded but not fixed in this WP.
  - Rollback: revert the test PR.
- **Effort:** 4–6 PT.

### WP0.3 Import-boundary checker
- **Goal / result:** Module boundaries become measurable.
- **Components:** `scripts/source-check.mjs`, new baseline file scripts/boundaries.json.
- **Changes:**
  - A regex-based import resolver classifies files as `platform`, `modules/<id>`, `packages/<x>`, worker or web.
  - Rules from `02` §3.
  - Report mode: fail only on violations not in the baseline.
  - Print a module dependency summary.
- **Prerequisites:** none.
- **Acceptance:**
  - `pnpm lint` runs the check.
  - The baseline lists today's violations.
  - A deliberately added violation fails.
- **Tests:** unit test for the resolver on fixture files.
- **Risks / rollback:** false positives on dynamic imports. Rollback: disable the pass.
- **Effort:** 1–2 PT.

### WP0.4 Characterization tests
- **Goal / result:** The behaviour that later refactors must preserve is pinned.
- **Components:** `packages/knowledge` (`invalidate` via its 8 call sites), `lifecycle.ts`, `chat-runner.ts`, `agents/tools/*`.
- **Changes:**
  1. **Invalidation cascade.** For each call site, set up content, approvals, publications (each status), insights and jobs. Run the call, then snapshot the resulting kinds, statuses, purged fields, jobs and outbox rows.
  2. **Sweep order.** Snapshot the entity and outbox effects of one `sweepProject` run with assignments on and off, and with a due source sync.
  3. **Assistant snapshot.** Instructions, tool JSON definitions and the always-loaded or deferred split for each flag combination.
- **Prerequisites:** none.
- **Acceptance:** snapshots committed; green on `main`.
- **Tests:** these are the tests.
- **Risks / rollback:** none.
- **Effort:** 2–3 PT.

## Phase 1: Prepare the Orbit Platform

### WP1.1 Extract platform kernel
- **Goal / result:** `apps/api/src/platform/` exists with domain-neutral infrastructure. Behaviour is unchanged.
- **Components:** `shared.ts`, `workflow.ts:31-64` (`enqueue`), `chat.ts:53-61` (`chatScoped`), `telemetry.ts`, `ai-usage.ts`, `budget.ts`, `openai-configuration.ts`, `member-scope.ts`, `auth.ts`, `agents/runtime/*`.
- **Changes:**
  - Move the files and functions.
  - Leave re-export shims at the old paths.
  - Consolidate `CREDENTIAL_KEY` reads behind one `credentialKey()` accessor. Today about 13 raw `process.env` reads exist; the value is unchanged.
- **Prerequisites:** WP0.2, WP0.3.
- **Acceptance:**
  - `pnpm check` and `pnpm test:e2e` pass.
  - The boundary baseline does not grow.
  - No behaviour diff: same OpenAPI path set, same snapshots.
- **Tests:** existing suite, snapshots.
- **Risks / rollback:**
  - Merge conflicts with ongoing feature branches. Mitigation: shims, and announce the move window.
  - Rollback: revert.
- **Effort:** 3–4 PT.

### WP1.2 Spend mandate projection
- **Goal / result:** Paid operations depend on a domain-neutral `SpendMandate`. Knowledge orchestration no longer imports `policy.ts`.
- **Components:** `budget.ts`, `retrieval.ts`, `ingestion.ts`, `reindex.ts`, `index-evaluation.ts`, `chat-runner.ts`, `image-*`, `specialists/runner.ts`.
- **Changes:**
  - Add `activeSpendMandate()` (a projection of the active `policies` entity).
  - `reserve()` takes a `SpendMandate`.
  - All callers switch to it.
- **Prerequisites:** WP1.1.
- **Acceptance:**
  - Same error codes and same budget keys (I6).
  - The `retrieval`, `ingestion`, `reindex` and `index-evaluation` imports contain neither `policy.ts` nor `workflow.ts`.
- **Tests:**
  - `paid.integration`, `assignment-run-budget`, `index-generations.integration`, `chat-runner`.
  - New unit test for the projection.
- **Risks / rollback:** a subtle difference in which policy counts as "active". Mitigation: the projection calls the existing `activePolicy`. Rollback: revert.
- **Effort:** 2–3 PT.

### WP1.3 Module contracts and registry
- **Goal / result:** `packages/module-contracts` (types and zod only) and `apps/api/src/modules/registry.ts`, with two transitional manifests, `knowledge` and `marketing`, that wrap today's code without moving it.
- **Components:** new files; `apps/api/src/main.ts`; `apps/worker/src/main.ts`, which reads the registry but still uses its old handlers.
- **Changes:**
  - `validateRegistry()` runs at startup.
  - The kind-ownership map covers all ~48 kinds.
  - `publicEntity` reads public projections from the registry.
- **Prerequisites:** WP1.1.
- **Acceptance:**
  - Startup fails on duplicate kinds or unknown dependencies (unit tests).
  - All kinds are mapped.
- **Tests:** registry unit tests; existing suite.
- **Risks / rollback:** low. Revert.
- **Effort:** 2–3 PT.

### WP1.4 Module activation storage and API
- **Goal / result:** Per-project activation is persisted and readable. It is not enforced yet.
- **Components:**
  - New migration `<ts>_platform_project_module`;
  - `scripts/db-deploy.ts` grant list (`:144-165`);
  - `packages/db/prisma/schema.prisma`;
  - new routes `GET /api/projects/:id/modules` (member) and `PUT /api/projects/:id/modules/:moduleId` (owner, behind flag `ORBIT_MODULES`).
- **Changes:**
  - Table with composite FK, FORCE RLS `project_scope` and grants.
  - Backfill `knowledge` and `marketing` as enabled for all projects inside the migration.
  - New projects get `defaultEnabled` modules on creation (`server.ts:607`).
  - Audit events `module.enabled` and `module.disabled`.
- **Prerequisites:** WP1.3.
- **Acceptance:**
  - Migration applies on a copy of a production-like DB (restore drill DB `orbit_restore_test`).
  - The RLS matrix includes the table.
  - The unscoped read check in `db-deploy` is extended.
  - Dependency validation works.
- **Tests:** migration test, RLS matrix, API tests (owner, editor, viewer, non-member).
- **Risks / rollback:**
  - This is a schema change, so risk class **high**. It needs a risk analysis, test strategy and rollback plan per `AGENTS.md`.
  - The table is additive, so older images ignore it. Rollback: redeploy the previous image. Leave the table in place; no down-migration.
  - Production migration requires `ORBIT_RELEASE_APPROVAL` and explicit approval.
- **Effort:** 3–4 PT.

### WP1.5 Permission catalogue
- **Goal / result:** One place answers "who may do what". Today's behaviour is reproduced exactly.
- **Components:** `auth.ts` `scopeFor`, `server.ts` owner lists (`:1382`, `:1490-1537`), ~59 module-internal role checks, `slack.ts:56-70`, `action-requests.ts` `deciderRole`, tool `roles`.
- **Changes:**
  - `PermissionDef` declared by the platform and modules.
  - `can()` and `authorize()`.
  - Routes and actions declare a permission.
  - Module-internal checks call `authorize()` with the same semantics.
  - Tool `roles` are mapped to `permission`.
- **Prerequisites:** WP0.2 (matrix as oracle), WP1.3.
- **Acceptance:** the route × role matrix is unchanged, and so is every 403 or 404 code.
- **Tests:** matrix, `auth`, `member-scope`, the viewer flow in `workspace.spec.ts:685`.
- **Risks / rollback:** this touches authorization, so risk class **high** and a security review is required. Rollback: revert, since there is no data change.
- **Effort:** 4–6 PT.

### WP1.6 Open registries
- **Goal / result:** Every extension point is filled from module manifests. The marketing manifest registers exactly today's set.
- **Components:**
  - `agents/tools/registry.ts` (namespaces, cards, features), `tools/index.ts`;
  - `action-requests.ts:145-150`;
  - `packages/ai/src/routing.ts` (task classes, `taskRoutesSchema`);
  - `telemetry.ts` `RunKind`;
  - `worker/main.ts` queue classes, the per-class concurrency and pause rules (`:152-384`), and the lease rules (`:407-462`);
  - `lifecycle.ts` sweep and `nextSweepAt`;
  - `readiness.ts`, `action-readiness.ts`;
  - `chat-tools.ts` `ChatCard`.
- **Changes:**
  - Registries are populated from manifests.
  - Startup validation.
  - The scheduler calls module contributions.
  - Readiness aggregates contributors.
  - Optional `AgentRun.module` column, in the same migration window as WP1.4.
- **Prerequisites:** WP1.3, WP0.4.
- **Acceptance:**
  - The WP0.4 snapshots (prompt, tools, sweep effects) are unchanged.
  - Worker queue names and concurrency are unchanged.
  - The lazy `import()` in `action-requests.ts` is removed.
- **Tests:** snapshots, `tool-search`, `registry.test`, worker tests, `due-marker*`.
- **Risks / rollback:** the sweep order changes (`04` §4.1, cut 4). Mitigation: the snapshot, and marketing-first ordering if needed. Rollback: revert.
- **Effort:** 5–7 PT.

### WP1.7 Web shell and navigation
- **Goal / result:** The new user flow (login → organization → project → home → module) with deep-linkable URLs. The old paths redirect.
- **Components:** `apps/web/src/components/orbit.tsx`, `workspace-context.tsx`, `work.tsx` (shared helpers), `lib/api.ts`, `app/[[...route]]/page.tsx`.
- **Changes:**
  1. Extract `useCollection`, `PageHead`, `ResourceError`, `EntityRows`, `EvidenceItems` and `form.tsx` into `platform/ui` (this fixes the `advanced` ⇄ `work` cycle).
  2. Route registry plus web module manifests (transitional manifests point to the existing components).
  3. Organization picker (`GET /api/me` workspaces) and project picker.
  4. Project home page with module tiles, the assistant prompt box, approvals and exceptions. It reuses Overview parts.
  5. URL scheme `/p/:projectId/...` with redirects from the 13 legacy paths and from links in Telegram and Slack messages.
  6. A 404 view instead of a silent Overview.
  7. The mobile bottom nav derived from the manifests.
- **Prerequisites:** the read API from WP1.4. A fallback is possible: all modules enabled.
- **Acceptance:**
  - Every existing view is reachable.
  - Legacy URLs redirect.
  - Project switching changes the URL.
  - The 390 px layout works (`workspace.spec.ts:603`).
  - Keyboard navigation works.
  - DE/EN labels are present.
- **Tests:**
  - New Playwright nav spec: picker, home, every module route, legacy redirects.
  - Shell component tests.
  - Existing specs updated to the new URLs.
- **Risks / rollback:**
  - Bookmarks and external links break. Mitigation: permanent redirects.
  - Visual regressions. Mitigation: screenshots in `apps/web/design/actual` (`docs/VISUAL_FIDELITY.md`).
  - Rollback: revert.
- **Effort:** 6–9 PT.

### WP1.8 Pause, export and retention hooks
- **Goal / result:** Project pause, export and retention are platform operations that modules extend.
- **Components:** `pause.ts`, `server.ts:789-797` (export), `retention` action, `lifecycle.ts` (purge parts).
- **Changes:**
  - Platform pause: generation bump and chat stop.
  - Marketing `onProjectPause`: block publications, pause agent tasks, notify.
  - Export and retention sections contributed per module.
- **Prerequisites:** WP1.6.
- **Acceptance:** the `chat-pause`, `paused-posts`, workspace pause and export tests are unchanged.
- **Tests:** as listed.
- **Risks / rollback:** an ordering difference during pause. Mitigation: same transaction, same order. Rollback: revert.
- **Effort:** 2–3 PT.

## Phase 2: Extract the Marketing module

### WP2.1 Marketing server move
- **Goal / result:** All marketing code lives under `apps/api/src/modules/marketing/**` and is reached only through its manifest. The worker no longer imports module files.
- **Components:** the files listed in `04` §2.2, the `server.ts` dispatcher and marketing routes, `worker/main.ts`.
- **Changes:**
  - File moves by subdomain, with shims.
  - Action handlers extracted from the if-chain unchanged.
  - Routes registered with `legacy()` at the same paths.
  - Marketing jobs, scheduler, hooks, tools, action types, task classes, step handlers, cards and notification kinds declared in the manifest.
  - `server.ts` shrinks to the composition root and platform routes.
- **Prerequisites:** WP1.6, WP1.8.
- **Acceptance:**
  - Full suite and E2E green.
  - The boundary checker reports no platform → marketing import and no worker → module import.
  - OpenAPI path set is identical.
- **Tests:** all existing, plus snapshots.
- **Risks / rollback:**
  - A big diff. Mitigation: split into about 6 PRs by subdomain (pipeline, policy, publishing, brand, analytics, agents), each green.
  - Rollback per PR.
- **Effort:** 6–9 PT.

### WP2.2 Assistant composition and marketing proposals
- **Goal / result:** The assistant is platform code. Marketing contributes prompt fragments, tools, proposals and cards.
- **Components:** `chat-runner.ts:55-93`, `chat.ts:485-715`, `chat-tools.ts`, `tools/*`.
- **Changes:**
  - Platform base prompt plus module fragments.
  - `createProposal` and `confirmProposal` move to marketing.
  - `project_status` gets module sections.
  - Legacy tool names are kept.
- **Prerequisites:** WP1.6, WP0.4.
- **Acceptance:**
  - Prompt and tool snapshots are byte-identical for every flag combination.
  - `chat-runner-limits` headroom is unchanged.
- **Tests:** snapshots, `chat*`, `tool-search`, `evals/operator` offline, Playwright `chat.spec.ts`.
- **Risks / rollback:** prompt drift changes model behaviour. Mitigation: byte-identical gate. Rollback: revert.
- **Effort:** 2–3 PT.

### WP2.3 Marketing web module
- **Goal / result:** Marketing UI under `apps/web/src/modules/marketing`. Settings are separated into project and module panels.
- **Components:** see `04` §5.
- **Changes:**
  - Move components.
  - Split `management.tsx`, `advanced.tsx`, `operator-tools.tsx` and `lifecycle.tsx` by domain.
  - Register card renderers.
  - One shared `useDecideActionRequest` hook replaces the two decide paths.
  - Connectors page gets module-contributed provider panels.
- **Prerequisites:** WP1.7.
- **Acceptance:**
  - All views and settings reachable under the new URLs.
  - No functional change.
  - Component tests moved and green.
- **Tests:** component tests, Playwright, the accessibility checklist (`.agentic/quality-gates/`).
- **Risks / rollback:** UI regressions. Mitigation: screenshots and E2E. Rollback: revert.
- **Effort:** 5–7 PT.

### WP2.4 Activation enforcement
- **Goal / result:** Disabling a module hides and blocks it everywhere without losing data.
- **Components:** platform route guard, generic collections, tool availability, worker job dispatch, scheduler, web nav, the owner settings page "Modules".
- **Changes:**
  - `MODULE_DISABLED` checks.
  - Jobs of disabled modules complete as `skipped_module_disabled`.
  - Settings UI for owners.
  - Flag `ORBIT_MODULES` (default false: everything enabled regardless of the table).
- **Prerequisites:** WP1.4, WP2.1, WP2.3.
- **Acceptance (on a test project):**
  - Disabling marketing yields 404 on all marketing routes, actions and collections.
  - No marketing tools appear in chat, and no marketing jobs or sweeps run.
  - Re-enabling restores everything, with entity count and versions unchanged.
  - Knowledge cannot be disabled while marketing is enabled.
  - Impact handlers still run (`05` §4).
- **Tests:** new activation integration suite, Playwright module toggle.
- **Risks / rollback:**
  - A project accidentally loses marketing. Mitigation: owner-only, audit, confirmation dialog, and the flag defaults off.
  - Rollback: flag off.
- **Effort:** 3–4 PT.

### WP2.5 Connections, notifications, callbacks
- **Goal / result:**
  - Credential storage and capability states are platform-owned.
  - The Telegram bot is a platform notification transport.
  - Callbacks are routed by module prefix.
  - Marketing keeps the Postiz, Matomo and Slack semantics.
- **Components:**
  - `server.ts` `connector`/`connector-health` (~2268-2300);
  - `modules/telegram.ts` (`:250`, `:342`, `:460`, `:502`), `agents/notifications.ts`, `notification-sender.ts`;
  - `slack.ts`, `google-drive.ts` (OAuth and connection part).
- **Changes:**
  - `platform/connections` with `getConnection`, `decryptCredential` and capability helpers.
  - The notification registry: marketing registers its `NOTIFY_KINDS`.
  - The callback router keeps today's `callback_data` format exactly.
- **Prerequisites:** WP2.1.
- **Acceptance:**
  - Telegram preview, veto (Stop), `/pause` and the daily report work in an integration test with a stubbed Bot API.
  - The Slack interactive approve works.
  - The Drive connect and import flow works.
  - No change to stored credential formats.
- **Tests:** `telegram`, `agent-notifications`, `slack.integration`, `google-drive*`, `postiz-verification.integration`.
- **Risks / rollback:**
  - Breaking the production Telegram veto channel. Mitigation: identical callback format, staging verification with a test bot.
  - Rollback: previous image.
- **Effort:** 4–6 PT.

### WP2.6 Production rollout (Phases 1–2)
- **Goal / result:** The modular platform runs in production with marketing and knowledge enabled. The uLiquid assignment is unaffected.
- **Components:** Coolify deployment, `migrate` service, flags.
- **Changes:**
  1. Backup check (`docs/BACKUP_RESTORE.md`).
  2. Deploy with `ORBIT_MODULES=false`.
  3. Run the migration with release approval.
  4. Post-deploy checks: health/ready, chat package card, the next assignment run producing Postiz drafts, the Telegram preview, AI cost views.
  5. Optionally switch `ORBIT_MODULES=true` and verify again.
- **Prerequisites:** all of Phases 1–2. Explicit approval by Mario per step (production deployment and production migration).
- **Acceptance:** `.agentic/quality-gates/production-readiness*` and `release*` checklists; I1–I8 from `04` §1 verified in production.
- **Tests:** smoke checks, as in `docs/LIVE_ACTIVATION_CHECKLIST.md`.
- **Risks / rollback:**
  - A production incident during an assignment slot. Mitigation: deploy outside the 10:00/17:00 Berlin slots and the 04:00 run planning.
  - Rollback: previous image. The additive table stays.
- **Effort:** 2–3 PT (spread over days).

## Phase 3: Extract the Knowledge module

### WP3.1 Invalidation impact handlers
- **Goal / result:** `packages/knowledge` no longer writes marketing kinds. Marketing reproduces the cascade through a registered handler in the same transaction.
- **Components:** `packages/knowledge/src/index.ts:101-279` and its 8 call sites, platform knowledge services, marketing `impact.ts`.
- **Changes:** see `05` §4.
- **Prerequisites:** WP0.4, WP2.1.
- **Acceptance:**
  - The WP0.4 invalidation snapshots are unchanged.
  - The engine has no string literal of a marketing kind (grep check in the boundary script).
- **Tests:** snapshots, `knowledge.integration`, `core`, `safety`.
- **Risks / rollback:**
  - A missed invalidation would make stale or revoked evidence publishable. That is a safety risk, so risk class **high**.
  - Rollback: previous image (no schema change).
- **Effort:** 3–4 PT.

### WP3.2 Knowledge services
- **Goal / result:** One platform facade for retrieval, evidence, facts and the `knowledge_search` tool. `usableFacts` is central.
- **Components:** `retrieval.ts`, `ingestion.ts`, `reindex.ts`, `index-evaluation.ts`, `chat-tools.ts:219-236`, `agent-tools.ts:412-440`, `content-packages.ts:73-121`.
- **Changes:**
  - Move the orchestration into `platform/knowledge`.
  - One tool definition with two budget contexts.
  - `usableFacts` adopts the full rules (K-1), after the production read-only check.
- **Prerequisites:** WP1.2, WP1.6. Decision K-1.
- **Acceptance:**
  - Specialist and assistant searches produce the same budget keys.
  - The K-1 diff list is reviewed.
  - Tests are green.
- **Tests:** `content-packages`, `package-fact-duplicates`, `specialists-*`, `chat-runner`, `knowledge.integration`.
- **Risks / rollback:** K-1 can block facts the uLiquid assignment uses. Mitigation: the read-only check before switching. Rollback: revert.
- **Effort:** 3–5 PT.

### WP3.3 Knowledge module (server and web)
- **Goal / result:** The `knowledge` module owns management routes, actions and UI, with deep-linkable views.
- **Components:**
  - knowledge actions and routes in `server.ts`, `knowledge-import.ts`;
  - `knowledge.tsx`, `operator-tools.tsx` (IndexManagement, FactWithdrawal).
- **Changes:** see `05` §3 and §8.
- **Prerequisites:** WP1.7, WP3.2.
- **Acceptance:**
  - All knowledge flows work under `/p/:id/knowledge/...`.
  - Disabling knowledge is refused while marketing is enabled.
  - With knowledge disabled and marketing disabled, the assistant can still search existing sources.
- **Tests:** Playwright knowledge flow (`workspace.spec.ts:108`, `:982`), activation suite.
- **Risks / rollback:** UI regressions. Rollback: revert.
- **Effort:** 4–6 PT.

### WP3.4 Marketing fact consumers
- **Goal / result:** Marketing-specific fact logic sits in marketing, and tenant vocabulary is configuration.
- **Components:** `fact-claims.ts` (`:51-53`), `fact-placeholders.ts`, `mission-evidence.ts`, `marketing-profile.ts`.
- **Changes:**
  - Move the files.
  - The allowed-token list comes from the marketing profile. The profile defaults to today's list for existing projects; this needs a new profile version, so coordinate with active assignments, because profile saves invalidate packages (see the 12.10 incident).
- **Prerequisites:** WP3.2.
- **Acceptance:** `fact-claims.test`, `claim-repeat.test` and `safety` are unchanged.
- **Tests:** as listed.
- **Risks / rollback:** a profile version bump invalidates pending content. Mitigation: read the default in code when the field is absent (no profile save needed). Rollback: revert.
- **Effort:** 2–3 PT.

### WP3.5 Source audiences (optional)
- **Status:** implemented 2026-10-17 (draft PR, not merged). Mario's Q-13 decision (support runs inside the uLiquid project) made it a support prerequisite. The manifest check: audiences are not part of the chunk manifest and a change keeps the source generation, so the evaluation manifest hash is unchanged. Details: `docs/IMPLEMENTATION_STATUS.md`.
- **Goal / result:** Sources can be limited to the modules that may use them.
- **Components:** `packages/knowledge` `SourceData` and `retrieve` filter, the source editor UI.
- **Changes:**
  - Optional `audiences` attribute, defaulting to "all".
  - The retrieval context carries the consumer module.
  - The filter is applied in SQL eligibility (`index.ts:771`).
- **Prerequisites:** WP3.2.
- **Acceptance:**
  - No result change for existing sources.
  - The filter is unit and integration tested.
  - The evaluation manifest hash is unchanged. The attribute is not part of the chunk manifest; confirm this, or treat it as an index change.
- **Tests:** `knowledge.integration`, `index-generations.integration`.
- **Risks / rollback:** an unexpected evaluation invalidation would block live publishing. Mitigation: verify the manifest inputs first. Rollback: revert.
- **Effort:** 2–3 PT.

## Phase 4: Validate extensibility and add platform capabilities for Support

### WP4.1 Extensibility test suite
- **Goal / result:** It is proven that a third module can be added purely through the contracts.
- **Components:** new test-only fixture module tests/fixtures/modules/tasks, not registered in production.
- **Changes:** the fixture module declares:
  - a table (only in the test DB migration, or the Entity kind `fixture_tasks`);
  - a permission and a route;
  - a tool `tasks.propose_tasks` (P), an action type and a scheduler contribution.

  Tests then cover activation per project, the permission boundaries (viewer, editor, non-member), and an assistant run with scripted model steps that combines `knowledge_search`, `marketing.recent_content` and `tasks.propose_tasks` into two ActionRequests.
- **Prerequisites:** WP2.4, WP3.3.
- **Acceptance:** all tests green with no change outside `tests/` and the registry test hook.
- **Tests:** these are the tests.
- **Risks / rollback:** none (test only).
- **Effort:** 3–4 PT.

### WP4.2 Public ingress foundation
- **Goal / result:** The platform can safely accept traffic from non-Orbit-users, meaning inbound provider webhooks and the public widget API, without per-module hand-wiring (today Slack and Telegram are hand-wired at `server.ts:406, 434`). This meets requirement S-R4 in `06` §5.
- **Components:** `server.ts` hooks (the Origin/CSRF check at `:338-356`, rate limit at `:316-321`), `apps/web/src/app/api/[...path]/route.ts`, `@fastify/cors` (a dependency, not registered today).
- **Changes:**
  1. Route patterns `/api/hooks/:provider/:connectionId`: signature verification by the connection, store, enqueue, fast 200, idempotent by provider message ID, no project lock.
  2. `/api/public/<module>/:publicKey/...`: public-key lookup to the project scope, CORS from per-key allowed origins, a per-session bearer token (hashed), no cookies, and the Origin check exempted only for these routes.
  3. Per-client and per-session rate limits. **Requires the F-02 fix** (client IP forwarding).
  4. Size limits and a JSON-only body.
  5. The fixture module from WP4.1 uses both patterns.
- **Prerequisites:** WP4.1, F-02 fix.
- **Acceptance:**
  - A forged signature, unknown key, disallowed origin or replayed message ID is rejected and audited.
  - Rate limits apply per client.
  - Session routes stay unaffected.
- **Tests:** integration tests for every rejection path, a fuzzed payload size test and a CORS preflight test.
- **Risks / rollback:**
  - The new unauthenticated surface needs a **security review** (risk class high).
  - Rollback: disable the route groups by flag.
- **Effort:** 3–5 PT.

### WP4.3 Lock measurement and real-time fan-out
- **Goal / result:** Two outcomes:
  - Data on whether the per-project lock (`packages/db/src/index.ts:52`) limits concurrent use.
  - A real-time mechanism that does not poll the DB under the lock. This is now **mandatory** for the support live chat (S-R5).
- **Components:** `scoped()`, the chat SSE route (`server.ts:1258-1304`), Redis, the web proxy (45 s abort, `route.ts:66`).
- **Changes:**
  1. Measure lock wait times under a synthetic multi-user load.
  2. `scopedRead()` without the advisory lock (RLS still set) for proven read-only paths.
  3. A Redis pub/sub channel per project and stream: writers publish after commit, and SSE endpoints subscribe and replay from the DB with `Last-Event-ID`.
  4. Move chat SSE onto it (optional, after measurement).
- **Prerequisites:** WP2.6.
- **Acceptance:**
  - A measurement report.
  - SSE delivery under 1 s p95 without DB polling.
  - Reconnect after the 45 s proxy cut loses no events.
  - No read-after-write anomaly for the affected endpoints.
- **Tests:** concurrency tests, reconnect tests, and Redis-down degradation (fall back to slow polling).
- **Risks / rollback:**
  - Invariants may silently rely on the lock (risk class **high**). Only proven read-only paths use `scopedRead()`.
  - Rollback: revert to polling.
- **Effort:** 3–5 PT.

### WP4.4 Cross-module operator eval
- **Goal / result:** An offline regression eval for module-spanning assistant tasks.
- **Components:** `evals/operator`.
- **Changes:**
  - New cases: tool selection across modules, permission-filtered tool sets, and an ActionRequest per write.
  - Offline, with scripted model steps.
- **Prerequisites:** WP4.1.
- **Acceptance:** cases committed and green.
- **Tests:** these are the tests.
- **Risks / rollback:** none.
- **Effort:** 2–3 PT.

### WP4.5 Module-level roles
- **Goal / result:** A member can hold a different role per module, including `none`, for example support staff without marketing access (S-R6, Q-10).
- **Components:**
  - `ProjectMember`;
  - the permission catalogue (WP1.5);
  - `member-scope.ts`;
  - members UI (`advanced.tsx` `ProjectAdministration` → platform members view).
- **Changes:**
  1. Table `ProjectMemberModuleRole(projectId, userId, moduleId, role)`, managed by `orbit_auth` like `ProjectMember`.
  2. `can()` resolves the module role first, then the project role. `none` hides the module in navigation and tools.
  3. Members UI with a per-module role matrix.
  4. Audit events.
- **Prerequisites:** WP1.5, WP2.4.
- **Acceptance:**
  - The route × role matrix is extended with module overrides.
  - Without override rows, behaviour is identical.
  - A support agent with `marketing: none` cannot reach marketing routes, collections, tools or chat cards.
- **Tests:** the matrix, the assistant tool filtering, and the RLS of the new table.
- **Risks / rollback:**
  - An authorization change (risk class high, security review).
  - Rollback: previous image. The table is ignored by old code.
- **Effort:** 3–4 PT.

### WP4.6 Platform files
- **Goal / result:** Binary files are stored outside `Entity` JSON, in encrypted object storage with authorized download. This is required for support attachments and raw e-mail (S-R7). Today assets are base64 in `Entity.data` with 1–5 MB limits (`assets.ts:6-15`).
- **Components:**
  - New `platform/files`;
  - the existing `backup` service's S3/R2 setup as precedent (`docker-compose.yml:162-210`);
  - `.env.example`.
- **Changes:**
  1. Table `File(projectId, moduleId, key, size, mime, sha256, encryption, createdBy, deletedAt)` with FORCE RLS.
  2. An S3-compatible adapter (separate bucket and credentials from backups) with per-project key prefixes and server-side or client-side encryption.
  3. Upload through the API with streaming, size and type limits, and a sha256 check.
  4. Download only through an authorized API route.
  5. Deletion and retention hooks.
- **Prerequisites:** WP1.1, Q-19. A new bucket and credentials need approval (secrets change).
- **Acceptance:**
  - Uploads above the limit are rejected.
  - Another project's file is unreachable.
  - Deleting a file removes the object.
  - Marketing assets are unchanged. Migrating them is optional later.
- **Tests:** integration tests against a local S3-compatible test double, and RLS.
- **Risks / rollback:**
  - Credential handling.
  - Cost: small.
  - Rollback: flag off. Support attachments are unavailable while it is off.
- **Effort:** 4–6 PT.

### WP4.7 E-mail connection and notification channels
- **Goal / result:**
  - The platform can send and receive e-mail through one provider adapter.
  - Users receive in-app and e-mail notifications according to their preferences (S-R8).
- **Components:**
  - `platform/connections`;
  - the notification service (WP2.5), whose `notify` and sender job pattern comes from `agents/notifications.ts`;
  - readiness `MAIL_PROVIDER_NOT_CONFIGURED`.
- **Changes:**
  1. An e-mail connection adapter: send API, inbound webhook through WP4.2, and delivery events (bounce and complaint).
  2. Sending domain configuration (SPF, DKIM, DMARC). The DNS change needs approval.
  3. Table `Notification(userId, projectId, moduleId, kind, payload, readAt)` plus `NotificationPreference`.
  4. An in-app bell in the shell.
  5. An e-mail channel for notifications.
- **Prerequisites:**
  - WP2.5.
  - Q-16: a new external provider needs approval.
- **Acceptance:**
  - Test-mode send writes a receipt without real delivery. This follows the existing `EXECUTION_MODE=test` convention.
  - An inbound test webhook creates a normalized message.
  - Users can mute kinds.
- **Tests:**
  - integration tests with a stubbed provider;
  - preference filtering;
  - `outcome_unknown` on an ambiguous send.
- **Risks / rollback:**
  - Deliverability and DNS.
  - Rollback: disconnect the provider. In-app notifications keep working.
- **Effort:** 5–7 PT.

## Track M: Orbit MCP gateway

The design is in `09-mcp-gateway.md`. The gateway is a protocol and authentication adapter over platform services and contains no business logic.

### WP-M1 OAuth authorization server, consent, grants
- **Goal / result:** Orbit is an OAuth 2.1 authorization server for MCP clients. Users grant a client access to selected organizations, projects and scopes, and can revoke it.
- **Components:** `apps/api/src/auth.ts` (Better Auth), auth tables and `scripts/db-deploy.ts` (lines 131-143) (grants for `orbit_auth`), web consent page and Settings → Connected apps, Traefik routes for `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`, `/oauth2/*` and the JWKS.
- **Changes:**
  1. Better Auth OAuth provider, MCP and CIMD packages plus the `jwt` plugin, pinned past the known advisories.
  2. CIMD client registration through an SSRF-safe fetch. DCR only for backward compatibility, rate-limited.
  3. Authorization code with PKCE S256, `iss` in every response, resource indicator bound into `aud`, refresh rotation with reuse detection.
  4. The `McpGrant` table.
  5. Consent UI with organization, project and scope selection.
  6. Revocation UI for users and owners.
  7. Audit events.
- **Prerequisites:** WP1.5, the F-02 fix, AD-21 approval (new dependencies).
- **Acceptance:**
  - The discovery metadata validates.
  - The ChatGPT auth requirements in `09` §2.2 are met: S256, CIMD, `iss`, resource and `aud`, UserInfo.
  - A revoked grant fails on the next call.
  - Session login is unchanged.
- **Tests:** OAuth flow integration tests (PKCE, wrong verifier, wrong redirect, missing `resource`, refresh reuse), CIMD fetch SSRF tests, RLS and grants for the new tables.
- **Risks / rollback:**
  - A new authentication surface, so a **security review** is required.
  - Rollback: disable the OAuth routes by flag. Session auth stays unaffected.
- **Effort:** 5–7 PT.

### WP-M2 MCP gateway core
- **Goal / result:** A stateless MCP endpoint that serves the tool registry under the token's grant.
- **Components:** the new entrypoint `apps/api/src/mcp-main.ts`, `platform/mcp/*`, a `docker-compose.yml` service `mcp` built from the same image with a healthcheck, a Traefik path route `/mcp` (Q-22), and the `.env.example` entries for issuer and resource.
- **Changes:**
  1. Streamable HTTP for protocol revisions 2025-11-25 and 2026-07-28 through the official SDK (a new dependency needing approval).
  2. Protected Resource Metadata.
  3. JWT verification: JWKS, `iss`, `aud`, `exp`, scope.
  4. Grant and membership resolution to a `Scope`.
  5. Module activation and `authorize()`.
  6. A registry adapter (`exposure.mcp`, injected `projectId`, annotations, `securitySchemes`, `outputSchema`, `structuredContent`).
  7. The error mapping in `09` §6.4.
  8. Audit (`mcp.tool_call`) and `McpCallLog`.
  9. Per-grant, per-user and per-client rate limits.
- **Prerequisites:** WP-M1, WP1.6, WP2.4.
- **Acceptance:**
  - MCP Inspector conformance passes for both revisions.
  - A tool hidden by role, module or grant is absent from `tools/list` and refused on call.
  - The audit row is written without argument values.
  - The UI API is unaffected by MCP load: separate process.
- **Tests:** adapter unit tests, a permission-intersection matrix, protocol tests, rate-limit tests.
- **Risks / rollback:**
  - A new public endpoint, so a **security review** is required.
  - Rollback: stop the `mcp` service.
- **Effort:** 5–7 PT.

### WP-M3 MCP read surface
- **Goal / result:** Users can read and search their Orbit knowledge and project state from ChatGPT and other clients.
- **Components:** knowledge services (WP3.2), `project_status`, the reviewed marketing R0 tools, module resource templates.
- **Changes:**
  - `search` and `fetch` with the ChatGPT result shapes (`url`, `structuredContent`, `outputSchema`).
  - `orbit_profile` with `_meta["openai/profile"]`.
  - `orbit_projects`.
  - Knowledge, project and marketing-profile resources.
  - The `modelUse` filter on every returned passage or fact.
  - Paid query embeddings under the `mcp:` budget key, with a lexical fallback.
- **Prerequisites:** WP-M2, WP3.2.
- **Acceptance:**
  - A ChatGPT developer-mode connector can search and cite Orbit documents.
  - A source with `modelUse=false` never appears.
  - Cost appears in AI cost views.
- **Tests:** rights-filter tests, a `search`/`fetch` schema snapshot, a budget test.
- **Risks / rollback:**
  - Data leaving to an external model. Mitigation: `modelUse` enforcement and grant scoping.
  - Rollback: remove tools from exposure.
- **Effort:** 3–5 PT.

### WP-M4 MCP proposal surface
- **Goal / result:** External clients can propose actions safely. Decisions happen only in Orbit.
- **Components:** `action-requests.ts` (platform), the proposal tools, the approval page, the Telegram owner bot.
- **Changes:**
  - Expose the reviewed P tools.
  - `requestedBy: {kind:"mcp", clientId, grantId}`.
  - A stricter default mode for MCP-originated requests.
  - `orbit_action_status`.
  - `approveUrl` and URL-mode elicitation (MRTR `input_required`) where the client supports it.
  - Hard floors are never exposed.
  - Per-grant proposal quotas and a kill switch.
- **Prerequisites:** WP-M3.
- **Acceptance:**
  - No MCP call can cause an external side effect without an Orbit-side decision.
  - Client-side confirmation alone never suffices.
  - Exceeding a quota is refused with a clear code.
- **Tests:** an end-to-end proposal from MCP through decision in Orbit to executor; replay and hash-mismatch tests; quota tests.
- **Risks / rollback:**
  - Always-on agents (dots) spamming proposals. Mitigation: quotas.
  - Rollback: remove the P tools from exposure.
- **Effort:** 3–5 PT.

### WP-M5 Client compatibility, security review, rollout
- **Goal / result:** Production MCP access for Mario's ChatGPT, with verified behaviour.
- **Components:** production deployment, the Traefik path route for `/mcp` and the PRM well-known paths (no DNS change, Q-22).
- **Changes:**
  1. Re-verify the ChatGPT and dots documentation, which is moving.
  2. Test a ChatGPT developer-mode connector end to end.
  3. Check whether dots can use the server, either as a developer-mode connector or as a private plugin (Q-21).
  4. Test a second client (Claude or Codex).
  5. Run the security review checklist (`09` §9).
  6. Optional mTLS verification (Q-25).
  7. Write the runbook: revoke a client or grant, rotate JWKS.
- **Prerequisites:** WP-M4. Explicit approvals for the production deployment, the Traefik route change and the new dependencies.
- **Acceptance:** the checklist passes; Mario's account can read and propose from ChatGPT; an audit trail exists.
- **Tests:** manual end-to-end tests plus automated conformance tests.
- **Risks / rollback:**
  - Client behaviour changes. Mitigation: standards-only design.
  - Rollback: stop the `mcp` service and revoke clients.
- **Effort:** 3–5 PT.

### WP-M6 Optional MCP events
- **Goal / result:** Clients that support it receive list-change and resource notifications.
- **Components:** platform durable events, Redis fan-out (WP4.3), the gateway.
- **Changes:**
  - `subscriptions/listen` (2026-07-28).
  - Notifications `toolsListChanged`, `resourcesListChanged` and resource updates (ActionRequest decided, ticket changed), filtered by grant.
- **Prerequisites:** WP-M2, WP4.3.
- **Acceptance:** a subscribed test client receives filtered events, and nothing leaks across grants.
- **Tests:** a subscription filter matrix.
- **Risks / rollback:**
  - Long-lived connections and their resource use.
  - Rollback: disable subscriptions.
- **Effort:** 2–4 PT.

## Phase 5: Support MVP

The scope is defined in `06` §2.1. This phase is behind the module activation: it is enabled only on a pilot project.

### WP5.1 Support module skeleton and data model
- **Goal / result:** The `support` module is registered, with tables, permissions, settings (categories, SLA targets, automation switches) and inbox management.
- **Components:**
  - new `modules/support`;
  - migration `<ts>_support_core`;
  - the `db-deploy.ts` grant list;
  - the RLS matrix.
- **Changes:**
  1. The tables from `06` §3.1, plus a per-project ticket number sequence.
  2. The manifest with `permissions` and `settings`.
  3. Inbox CRUD, including the widget key and a vaulted secret.
  4. The `SupportChannelAdapter` contract.
- **Prerequisites:** WP4.1, WP4.5, WP4.6.
- **Acceptance:**
  - The migration applies on a restore-drill copy.
  - The RLS matrix covers all new tables.
  - The module can be enabled and disabled on a test project.
- **Tests:** migration, RLS, permission matrix and settings validation.
- **Risks / rollback:**
  - A schema change (risk class high). It is additive.
  - Rollback: disable the module. The tables stay.
- **Effort:** 4–6 PT.

### WP5.2 Agent workspace UI
- **Goal / result:** Agents work tickets entirely in Orbit.
- **Components:**
  - `web/modules/support`;
  - reused chat components (`chat-markdown.tsx`, card patterns);
  - primitives.
- **Changes:**
  1. Inbox views and filters, search, the ticket view with timeline, the composer (reply or internal note) and attachments.
  2. Assign, status, priority, category and tags.
  3. The contact panel and the contact list.
  4. Settings panels.
  5. A home tile.
- **Prerequisites:** WP5.1, WP1.7.
- **Acceptance:**
  - All MVP workspace functions work at 390 px and on desktop.
  - Keyboard navigation works.
  - DE and EN.
  - The accessibility checklist passes.
- **Tests:** component tests and a Playwright support flow.
- **Risks / rollback:**
  - UI size. Mitigation: deliver views incrementally.
  - Rollback: revert.
- **Effort:** 8–12 PT.

### WP5.3 E-mail channel
- **Goal / result:** Customers write to the inbox address and receive agent replies in the same thread.
- **Components:** the e-mail adapter for support, the WP4.7 connection and the WP4.2 ingress.
- **Changes:**
  1. Inbound parsing and threading (headers plus reply token), contact matching, ticket creation or reopening.
  2. Raw MIME and attachments stored in platform files.
  3. Loop and auto-responder protection.
  4. The `support_email_outbound` job with `outcome_unknown` semantics.
  5. Auto-acknowledgement.
- **Prerequisites:** WP5.1, WP4.2, WP4.7.
- **Acceptance:**
  - A reply lands in the right ticket.
  - A new mail creates a ticket.
  - A bounce is shown on the message.
  - No duplicate send after a worker crash.
- **Tests:**
  - a fixture corpus of real-world MIME shapes (multipart, inline images, forwarded threads, non-UTF-8);
  - crash and retry tests.
- **Risks / rollback:**
  - Parsing edge cases.
  - Mail loops.
  - Rollback: disable the inbox e-mail channel.
- **Effort:** 4–6 PT.

### WP5.4 Livechat widget
- **Goal / result:** Desk, FamilyPlan and other apps embed one script and their users can chat with support.
- **Components:**
  - `apps/web` (static widget bundle);
  - the public API (WP4.2);
  - real-time (WP4.3);
  - platform files.
- **Changes:**
  1. Widget script (Shadow DOM, theming, DE/EN, accessibility).
  2. Anonymous and HMAC-verified sessions.
  3. Messages and attachments.
  4. SSE with resume.
  5. Offline fallback to e-mail.
  6. A "talk to a human" button.
  7. A history view for verified users.
  8. An embed snippet and an integration guide for the app teams.
- **Prerequisites:** WP5.1, WP4.2, WP4.3.
- **Acceptance:**
  - Works embedded on a test page with a different origin.
  - An unverified user cannot read another user's history.
  - An Orbit outage leaves the host app fully functional (H05).
  - The bundle stays under the size budget, for example 50 KB gzip.
- **Tests:**
  - Playwright cross-origin embed;
  - security tests for the HMAC, the session token and CORS;
  - reconnect tests.
- **Risks / rollback:**
  - Public attack surface (security review).
  - Abuse and spam. Mitigation: rate limits and an optional proof-of-work or captcha decision later.
  - Rollback: disable the widget per inbox.
- **Effort:** 8–12 PT.

### WP5.5 Support notifications and automations
- **Goal / result:** Agents are informed, and routine ticket hygiene runs automatically.
- **Components:** notification service (WP4.7), scheduler contribution and events.
- **Changes:**
  1. Notification kinds (`06` §3.6).
  2. Auto-ack, auto-assign (round robin or fixed), SLA timers and at-risk or breach events.
  3. Auto-close after N days in `pending_customer`.
  4. Reopen on reply.
- **Prerequisites:** WP5.1, WP4.7.
- **Acceptance:**
  - Each rule can be switched per inbox.
  - SLA due times are computed on create and on priority change.
  - Notifications respect preferences.
- **Tests:** scheduler tests with frozen time, and event idempotency.
- **Risks / rollback:**
  - Notification spam. Mitigation: digest defaults.
  - Rollback: switch off the rules.
- **Effort:** 4–6 PT.

### WP5.6 Support AI
- **Goal / result:** Triage, grounded draft replies, an optional evidence-only widget answer, and a reliable handoff (`06` §3.5).
- **Components:**
  - the platform runner, runtime port, budget and telemetry;
  - knowledge services with the `support` audience (WP3.2, WP3.5);
  - the tool registry.
- **Changes:**
  1. Task classes `support.triage`, `support.draft_reply` and `support.widget_answer`, with strict output schemas.
  2. A deterministic evidence check (`validateEvidence`, `publicUse` for customer-visible text).
  3. Hard-rule filters: no financial or trading advice, no promises, sensitive categories go to handoff.
  4. The handoff state machine.
  5. AI draft cards in the composer.
  6. Support tools for the Orbit Assistant.
  7. An offline eval set in `evals/support`.
- **Prerequisites:**
  - WP5.1, WP3.2, WP3.5;
  - **Q-12**: legal basis for PII sent to OpenAI;
  - Q-17 (widget answer).
- **Acceptance:**
  - Drafts cite evidence or state the gap.
  - Every hard-rule case in the eval set goes to handoff.
  - Cost per ticket is visible.
  - The project pause stops AI activity.
- **Tests:**
  - offline eval (triage accuracy, citation validity, handoff recall on sensitive cases);
  - runner crash and recovery;
  - budget exhaustion.
- **Risks / rollback:**
  - A wrong or unsafe answer to a customer. Mitigation: drafts need a human by default, and the widget answer is off by default and evidence-only.
  - Rollback: set the inbox `aiMode` to `off`.
- **Effort:** 6–9 PT.

### WP5.7 Support statistics
- **Goal / result:** Volume, response and resolution times, backlog, SLA attainment, reopen rate, AI metrics and cost per ticket.
- **Components:** SQL aggregates over tickets and events, the stats view and the home tile.
- **Changes:**
  - Read-time aggregation with indexes.
  - Filters for date range, inbox, category and agent.
  - CSV export.
- **Prerequisites:** WP5.1.
- **Acceptance:** the numbers match a hand-computed fixture.
- **Tests:** aggregation tests on fixtures.
- **Risks / rollback:**
  - Query cost. Mitigation: add rollups when measured.
  - Rollback: revert.
- **Effort:** 3–4 PT.

### WP5.8 Support privacy and operations
- **Goal / result:** Customer data is handled lawfully, and the module can be operated.
- **Components:** `.agentic/compliance/`, platform export and retention hooks (WP1.8), files deletion and the runbook in `docs/OPERATIONS.md`.
- **Changes:**
  1. Retention per project (messages, attachments, contacts).
  2. Contact export (JSON plus files) and deletion with tombstones.
  3. A PII-free telemetry check (test asserting that no message text is in spans or audit).
  4. Abuse controls.
  5. A runbook covering mail outage, widget abuse and the AI kill switch.
- **Prerequisites:** WP5.1, Q-12.
- **Acceptance:**
  - Deleting a contact removes its rows and files.
  - The telemetry test passes.
  - The runbook is reviewed.
- **Tests:** as listed.
- **Risks / rollback:**
  - A legal non-compliance if this WP is skipped. It **blocks the pilot**.
- **Effort:** 3–4 PT.

### WP5.9 Support MVP pilot rollout
- **Goal / result:** One real inbox runs in production, for example the Desk app widget plus a support address.
- **Components:** production deployment, DNS, the widget embed in the app (done by the app team; Orbit only supplies the snippet).
- **Changes:**
  1. Backup check.
  2. Migration.
  3. Enable support on the pilot project.
  4. Connect the mail provider.
  5. Agent onboarding.
  6. Watch the metrics for two weeks.
- **Prerequisites:** WP5.1–WP5.8. Explicit approvals for the production deployment, migration, DNS and the new provider.
- **Acceptance:**
  - Tickets from both channels are handled end to end.
  - No marketing regression (I1–I8).
  - Pilot metrics are recorded.
- **Tests:** smoke checks and a live test ticket in each channel.
- **Risks / rollback:**
  - Customer-facing incidents.
  - Rollback: remove the widget embed or disable the inbox. Chatwoot or the old address stays available during the pilot.
- **Effort:** 2–3 PT.

## Phase 6: Support extensions

The extensions E1–E14 are listed in `06` §2.2, with ≈ 50–80 PT in total. Each becomes its own planned work package after the MVP pilot. Suggested order, by value and risk:

1. **E3:** macros and canned responses.
2. **E2:** SLA business hours.
3. **E5:** product data providers (after Q-09).
4. **E1:** autonomous AI replies, eval-gated.
5. **E4:** CSAT and quality review.
6. **E8:** knowledge gap loop.
7. **E6:** API tokens and outbound webhooks.
8. **E7:** support tools and resources in MCP. These are mostly automatic through the registry once Track M exists; only the reviewed `exposure.mcp` flags and resource templates are needed.
9. **E9:** further channels.
10. **E10:** Chatwoot import, if wanted.
11. **E11, E12, E13, E14.**

---

## Sequence check (feasibility in the stated order)

The check covers the stated order (requirement 11.6).

1. **Phase 0 has no prerequisites** and changes no production code, so it can start immediately.
2. **WP1.1 before WP1.2.** The spend mandate must live in the platform, and knowledge must import `enqueue` from the platform. Both need the platform folder.
3. **WP1.3 before WP1.4, WP1.5 and WP1.6.** All three read manifests.
4. **WP1.4 before WP1.7.** The shell needs the modules API. If WP1.7 must start earlier, it can use a client fallback in which all modules are enabled. The order is flexible.
5. **WP0.4 before WP1.6, WP2.2 and WP3.1.** The snapshots are the regression oracle for the sweep, the prompt and invalidation.
6. **WP1.6 and WP1.8 before WP2.1.** The marketing manifest needs every registry and hook to declare its contributions. Otherwise the worker would keep direct imports.
7. **WP2.1 and WP2.3 before WP2.4.** Enforcement needs every entry point to go through the platform guard, which the moves establish.
8. **WP2.1 before WP3.1.** The marketing impact handler needs a marketing manifest to register in.
9. **WP1.2 before WP3.2.** Knowledge services must already be free of the marketing policy.
10. **WP3.3 after WP1.7.** The knowledge UI needs the URL scheme.
11. **WP4.1 after WP2.4 and WP3.3.** Activation and the knowledge split must exist to be validated.
12. **The F-02 fix before WP4.2.** Public endpoints need per-client rate limits.
13. **WP4.6 is independent of the other Phase 4 WPs.** It needs only WP1.1, so it can be pulled forward to run in parallel with Phase 2 or 3.
14. **WP4.5, WP4.6 and WP4.7 before WP5.1, WP5.3 and WP5.5.** WP5.4 also needs WP4.2 and WP4.3. WP5.6 needs WP3.2 and WP3.5 (knowledge services with audiences) and the legal decision Q-12.
15. **WP5.8 before WP5.9.** No pilot runs without retention, export and deletion.
16. **Track M after WP1.5, WP1.6, WP2.4 and WP3.2.** The gateway only adapts the permission catalogue, the open tool registry, module activation and knowledge services; without them it would have to contain business logic, which the assignment forbids. WP-M1 also needs the F-02 pattern for per-IP limits on `/authorize` and `/token`. WP-M6 needs the Redis fan-out from WP4.3.

**Usability after each phase:**

| Phase | State |
|---|---|
| 0 | Unchanged product. |
| 1 | Unchanged product, plus the new shell, URLs and home. All modules are enabled. |
| 2 | Unchanged product in production. The activation toggle exists but defaults off. |
| 3 | Unchanged product, plus deep-linkable knowledge views. One deliberate behaviour change (K-1), gated by a check. |
| 4 | Unchanged product, plus platform capabilities: public ingress, real-time, module roles, files, e-mail and in-app notifications. None is used by a customer-facing feature yet. |
| M | Optional external access through MCP for granted users and clients. Without a grant, nothing changes. Revocable per grant and per client. |
| 5 | Support module live on a pilot project. Other projects are unaffected because the module is not enabled there. |

No phase requires a data migration of existing records. Support adds new tables only.

**Parallelization:** with two developers:
- WP1.7 and WP2.3 (web) can run in parallel with WP1.5, WP1.6 and WP2.1 (server).
- WP2.5 can run in parallel with WP2.2 and WP2.3.
- In Phase 5, WP5.2 (UI) can run in parallel with WP5.3, WP5.4 and WP5.6 once WP5.1 is merged.

## Where to start

**Start with WP0.2 (safety net).**

1. **The matrices protect the riskiest changes.** The RLS and route × role matrices are the oracle for the two highest-risk changes in the program: the permission catalogue (WP1.5) and module activation (WP2.4).
2. **The CI guard fixes a current risk.** The 69 test files that skip silently are a present-day risk, independent of modularization.
3. **It may surface existing permission bugs early.** The analysis already found one candidate (F-01, `08`).

Run WP0.3 and WP0.4 directly after it, or in parallel. Together they take about 1.5–2 weeks, before the first code move (WP1.1).

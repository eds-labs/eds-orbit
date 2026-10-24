# Module activation enforcement (WP2.4)

Work package WP2.4 of the modularization roadmap (ADR 0009). An owner can turn a module off for one project; Orbit then hides and blocks it everywhere without deleting anything. Risk class: **high** (`.agentic/routing/risk-classification.md`), because a mistake can hide a project's marketing work or stop its jobs.

## Behaviour

Enforcement is active only with `ORBIT_MODULES=true`. With the flag off (the default), every registered module counts as enabled, whatever `ProjectModule` records.

| Entry point | A disabled module |
|---|---|
| Module routes under `/api/projects/:projectId/…` | `404 MODULE_DISABLED`, after the membership check, so non-members learn nothing |
| `POST /api/projects/:id/actions/:name` | `404 MODULE_DISABLED` for the action's owner |
| Generic collections `GET/POST /api/projects/:id/:collection` | `404 MODULE_DISABLED` for the kind's owner |
| Assistant | its tools, prompt fragments and conversation sections are left out |
| Worker jobs of its queue classes | the job stops as `blocked_dependency` with error `MODULE_DISABLED`, like a job a project pause blocks; it is not retried automatically |
| Scheduler contribution and periodic tasks | not called |
| Notifications of its kinds (WP2.5b) | the platform's `telegram_notification` job is recorded as `skipped` with reason `MODULE_DISABLED`; nothing is sent |
| Telegram buttons of its callbacks (WP2.5a) | rejected like an invalid button (`telegram.callback_rejected`) |
| Signed Slack interactions (marketing, WP2.5d) | `404 MODULE_DISABLED` after the signature and identity checks; nothing is consumed, so the button works again once the module is on |
| Web | navigation, home section, chat parts, inbox views, settings sections and connector providers are hidden; module pages show a notice |

Not affected:

- **Platform services.** Pause, export and retention keep calling every module's hooks. They protect data, and a pause must still block a disabled module's publications.
- **Knowledge services.** Knowledge jobs and the source sync are still registered by the platform until WP3.3, so they keep running.
- **Data.** Turning a module off deletes nothing, and turning it on again restores it unchanged.

**Deviation from the plan.** Plan `07` names the job status `skipped_module_disabled`. Orbit uses `blocked_dependency` with the error `MODULE_DISABLED` instead. That is the established pattern of the project pause, and the existing `retry` action, the job views and the exception list already understand it. A new status would have made such a job impossible to retry.

The dependency rules of WP1.4 still apply: knowledge cannot be turned off while marketing is on, and marketing cannot be turned on while knowledge is off.

With marketing off, knowledge can be turned off too (WP3.3). Its routes (`knowledge-health`, `documents`, `indexes`), its actions and its collections (`sources`, `facts`, …) then answer `404 MODULE_DISABLED`. The knowledge services stay, because they belong to the platform: the assistant keeps `knowledge_search` (a platform tool, `alwaysOffered`) and can still search the existing sources.

Owners switch modules in **Settings → Modules**. Disabling asks for confirmation; every change is audited (`module.enabled`, `module.disabled`).

## Client feature and role presentation (MA-08)

`GET /api/projects/:projectId/modules` includes `features.agents`, the current
boolean value of the existing `ORBIT_AGENTS` guard. This read-only advertisement
changes neither the flag nor module activation/member authority. It complements
`features.knowledgeWorkspace` and each module's `enabled`/`access` fields.

The web shell uses advertised module access for module-page controls and contributed
Assistant templates. Marketing's plan/assignment navigation requires `agents=true`;
missing or false feature data hides those entries. Existing URLs remain registered,
with an understandable unavailable state for saved plan bookmarks. Creator/Studio
and manual missions stay reachable, and platform App approvals remain independent
of Marketing. The API remains authoritative after every navigation or role change.

## Risk analysis

| Risk | Effect | Mitigation |
|---|---|---|
| A project loses marketing by mistake | Missions, content and assignments vanish from the UI, and jobs stop | The flag is off by default. Switching is owner-only, with a confirmation dialog and an audit entry. Nothing is deleted; turning the module on restores everything. |
| A job is blocked although its module is on | Work silently stops | A job is blocked only when its owner module is recorded as disabled *and* the flag is on. Platform jobs are never blocked. Tests cover both cases. |
| A route stays reachable although its module is off | Disabled features keep working through the API | One guard per module route registration, plus the action and collection checks, derived from the registry. A test calls a route, an action and a collection of the disabled module. |
| A public webhook breaks | Slack or Telegram callbacks fail | The guard applies only to `/api/projects/:projectId/…` routes. Signed webhooks keep their own checks. |
| The assistant prompt changes while the flag is off | Model behaviour drifts | With the flag off, the filters let everything through. The byte-identical prompt snapshot (WP0.4) stays the gate. |
| Extra database load | One extra `ProjectModule` read per guarded request | Only with the flag on. The read is a single indexed row lookup inside the project transaction. |

## Test strategy

- A new integration suite (`module-enforcement.integration.test.ts`) runs with the flag on against a project with marketing turned off. It covers:
  - a marketing route, action and collection return `404 MODULE_DISABLED`, while knowledge keeps working;
  - the assistant offers no marketing tool;
  - the sweep does not call marketing;
  - a marketing job stops as `blocked_dependency` with `MODULE_DISABLED`.

  After turning marketing on again, entity count and versions are unchanged. With the flag off, a recorded "disabled" changes nothing.
- The existing suites stay green with the flag off: the access matrix, the prompt snapshots, the sweep characterization and the full suite.
- Web: component tests for the settings tab and the shell filtering. The Playwright suite runs in CI.

## Rollback

- Set `ORBIT_MODULES=false` and redeploy. Everything is enabled again immediately; no data migration is involved.
- Jobs that a disabled module blocked stay `blocked_dependency` / `MODULE_DISABLED`. They are not restarted automatically; once the module is on again, a writer can restart them with the existing `retry` action. Work the module's own scheduler plans (missed slots, assignments) is planned again by its next sweep.
- The code itself is rolled back by reverting the PR.

## Installation switches (ADR 0015)

`ORBIT_MARKETING=false` removes Marketing from the whole installation, as `ORBIT_SUPPORT` and `ORBIT_FINANCE` do for their modules. It applies whatever `ORBIT_MODULES` says.
- Its routes, actions and collections answer `404 MODULE_DISABLED`.
- Its tools, jobs, scheduler and navigation are gone.
- Support and Finance keep their own codes (`SUPPORT_DISABLED`, `FINANCE_DISABLED`, `unavailableCode` in their contributions).
- The platform's `knowledge_search` and the AI spending authority (Settings → AI & budget) stay.
- Without Marketing, the dashboard shows the platform's AI readiness (spending authority and text model) instead of Marketing's go-live readiness.

## Rollout

1. Merge with the flag off; no behaviour change.
2. Turn the flag on in staging. Turn marketing off and on again on a test project, and check the acceptance list above.
3. Production: turning the flag on is a separate, approved step (`AGENTS.md`). Turning it on alone changes nothing until an owner disables a module.

## Adding a module (WP4.1)

A module plugs in through its manifest (`ServerModule`) and its contributions (`ModuleContributions`), registered in `apps/api/src/modules/registry.ts`. The test-only fixture module `apps/api/tests/fixtures/modules/tasks` shows every part:
- entity kinds (`collection: true` makes one readable through `GET /api/projects/:id/<kind>`);
- permissions with the module's prefix;
- routes (guarded by activation);
- actions with their `actionPermissions`;
- assistant tools (own namespace);
- action types and a scheduler contribution.

Writes to the generic collection route stay per-kind code; a module writes through its own actions and routes. Tests add modules with `registerTestModules()`; production never calls it.

## Finance (opt-in, 2026-10-23, local; flag off)

Finance (`docs/FINANCE.md`) follows the Support pattern: `defaultEnabled: false`, a flag and an explicit project row.

| Layer | Rule |
|---|---|
| Installation | `ORBIT_FINANCE=true` (default `false`). While off, the module is unavailable: contributions do not count even with `ORBIT_MODULES` off, projects do not list it, owners cannot enable it, routes answer 404. |
| Project | An owner enables it in Settings → Modules, which writes an `enabled = true` row. While `ORBIT_MODULES` is off the platform counts every module as enabled **except** off-by-default modules, which count only with this row. |
| Member | `finance.read`, `.write`, `.export` (owner, editor) and `.settings` (owner), all sensitive; module roles may narrow them (`none` hides the module). |
| Disabled project | 404 `FINANCE_DISABLED` (or `MODULE_DISABLED` while module switching is on), after the membership check. The upload route checks membership, module, permission and content type before reading the body. |
| Jobs, tools, attention | The `finance_mail_receipt` and `finance_extract` jobs, the FX periodic task, the four assistant tools and the attention items are contributions and obey the same activation. |

Switching finance off deletes nothing. A mailbox bound to finance keeps its owner claim, so its mail waits unprocessed until the module is on again or the mailbox is unbound.

## Module roles per member (WP4.5)

With `ORBIT_MODULE_ROLES=true`, a project owner can give a non-owner member a role in a single module (also from the organization settings and the system administration, ADR 0013, and as part of an invitation):
- `editor` or `viewer` replaces the project role in that module;
- `none` hides the module for that member, like switching it off for them alone.

**Where it applies.** The places activation covers, and a few more:
- module routes, actions and collections (`MODULE_NOT_AVAILABLE` for `none`);
- assistant tools and prompt fragments;
- conversation sections;
- the shell (`GET /modules` returns `access`);
- platform files, by the file's module;
- decisions on action requests, by the action type's module;
- the export, the dashboard and the member's notification list, which leave out the module's records.

**Rules.**
- Owners always keep their role.
- The API is `GET/PUT /api/projects/:id/members/:userId/module-roles` (owners only, audited); the UI is "Module roles" in the members list.
- With the flag off, stored rows are ignored and the API answers 404.
- The flag stays off in production until the security review in `docs/SECURITY_REVIEW.md` is done.

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

## Rollout

1. Merge with the flag off; no behaviour change.
2. Turn the flag on in staging. Turn marketing off and on again on a test project, and check the acceptance list above.
3. Production: turning the flag on is a separate, approved step (`AGENTS.md`). Turning it on alone changes nothing until an owner disables a module.

# Modular platform rollout (WP2.6)

Production rollout of Phases 1–2 of the modularization (plans/orbit-modularization/07, WP2.6). Risk class **high**: one deployment changes the code layout of API, worker and web, and adds one table. This runbook authorizes nothing by itself. Each step marked **Approval** needs Mario's explicit OK for that step (`AGENTS.md`).

## What goes live

- **Release PR.** Branch `claude/release-modular-platform` → `main` contains the stacked PRs #93–#124 (WP0.1–WP2.5d) and production fix #108, already carried into the moved files.
- **One merge, one deployment.** Coolify deploys every push to `main`, so merging the release PR **is** the production deployment. Do not merge the 32 stacked PRs one by one; that would create one deployment each.
- **Behaviour.** With `ORBIT_MODULES=false` (the default, see `docker-compose.yml`) nothing changes for users. URLs, response shapes, error codes, hashes, prompts, queue classes, budget keys and flags stay the same (invariants I1–I7 of plan `04` §1). Local evidence: the full suite (153 files) and an unchanged OpenAPI document after every work package.
- **Migration `202610130001_platform_project_module`.** It is additive and is the only schema change.
  - It creates `ProjectModule` (FORCE RLS, project scope) and records `knowledge` and `marketing` as enabled for every existing project.
  - Existing tables and rows are untouched. The previous image ignores the table.
  - The `migrate` service applies it once before API and worker start. It needs `ORBIT_RELEASE_APPROVAL` (already set; update it to this change reference if desired).

## Timing

Deploy outside the assignment's busy times (Europe/Berlin): run planning 04:00, slots 10:00 and 17:00, daily report 20:00.

Recommended window: a working day between **11:00 and 16:30**, after the morning run has been checked. On 2026-10-15 that check also shows production fix #108 (live since 2026-10-14 11:08) on its own, before the rollout changes anything else.

## Before the merge (no production effect)

1. CI is green on the release PR (`validate`, `isolated-acceptance`).
2. Backup:
   - The daily encrypted off-host backup (Coolify Scheduled Task, 03:00 UTC, `docs/BACKUP_RESTORE.md`) ran successfully today. Mario checks the task run in Coolify.
   - `CREDENTIAL_KEY` is stored in the password manager.
3. Coolify environment:
   - `ORBIT_MODULES` is unset or `false`.
   - `ORBIT_RELEASE_APPROVAL` is present.
   - The other flags are unchanged: `ORBIT_AGENTS=true`, `ORBIT_AGENT_REVIEW_AUTHORITY=true`, `ENABLE_POSTIZ_DRAFTS=true` and the rest as today.
4. Note the current `main` commit as the rollback target (`7feafb4` at the time of writing).
5. The assignment `64e8b9cc…` is active and no run is in progress (Operations → AI runs).

## Step A — merge the release PR (Approval A: production deployment and migration)

Merge `claude/release-modular-platform` into `main` with a merge commit. Then, in Coolify:

1. Record the deployment ID and commit.
2. Confirm that `migrate` completed exactly once; its log names the migration.
3. Confirm that `api`, `worker`, `web`, PostgreSQL and Redis are healthy.

If `migrate` fails:
- leave the application stopped;
- do not delete or downgrade anything;
- apply a reviewed forward fix (`docs/deployment/COOLIFY.md`).

## Post-deploy checks (read-only)

| # | Check | Expected |
|---|---|---|
| 1 | `GET https://orbit.eds-labs.io/api/health/ready` and `/api/health/postiz` | `{status: "ok", database: "ok", worker: "ready"}`; Postiz delivery not degraded |
| 2 | Sign in, open uLiquid Desk | Home with Marketing and Knowledge sections. Navigation: Orbit Chat, Marketing pages, Knowledge, Approvals, Connectors, Operations, Settings |
| 3 | Settings → Modules | Knowledge and Marketing "on"; "Switching modules is not enabled on this installation" |
| 4 | Settings tabs | Assignments/Autopilot, Policy & budget, Brand, Project, Integrations as before; policy and assignment card unchanged |
| 5 | Connectors | Postiz (channels), Matomo, Slack, Telegram (linked) in the former order |
| 6 | Operations → AI runs and costs | Spend attributed as before |
| 7 | Telegram: send a short text such as `hilfe` to the bot | The help reply arrives (the webhook and the transport work). Do **not** send `/pause` |
| 8 | Next assignment run (04:00) and drafts after 10:00 | Run completes; Postiz drafts for X and the new Telegram channel; a `postiz_draft` notice in Telegram |
| 9 | Daily report 20:00 | Arrives as before |
| 10 | Optional, costs one chat turn (Mario's call) | Orbit Chat answers; a package request shows the package card |

Checks 1–7 right after the deployment; 8 and 9 at the next run and report. Invariant I8 (the uLiquid assignment keeps running) is proven by 8.

## Rollback

- **Triggers:**
  - `/api/health/ready` stays `degraded` (database or worker);
  - errors in the Telegram webhook;
  - the assignment run fails with a code error;
  - a page or action that worked before fails.
- **Action:** redeploy the previous `main` commit in Coolify. `ProjectModule` stays; the previous image ignores it. No down-migration. The data is untouched.
- **Pending Telegram buttons and notification jobs.** Their data formats and job keys are unchanged, so they keep working in either direction.

## Step B — module switching (optional, later; Approval B)

`ORBIT_MODULES=true` lets owners switch modules (`docs/MODULE_ACTIVATION.md`). Turning it on alone changes nothing until an owner disables a module.

Recommended: only after Step A has run cleanly for a few days, and never disable Marketing in uLiquid Desk. After the switch:
1. Repeat checks 2, 3 and 5.
2. Check that Settings → Modules now offers the toggle.

To roll back, set the flag back to `false` and redeploy.

## Record

After each step, record the following in `docs/IMPLEMENTATION_STATUS.md` (no secrets):
- deployment ID and commit;
- the migration result;
- the outcome of each check.

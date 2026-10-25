# Project management module (`work`)

The project management module manages initiatives ("Vorhaben"), milestones, tasks, subtasks and checklists inside one Orbit project. The decisions are in [ADR 0016](adr/0016-project-management-links-events.md), the plan in [`plans/project-management-phase-1.md`](plans/project-management-phase-1.md).

**State (2026-10-25): Phase 1 implemented on the branch `claude/work-module-phase-1`, local only.** Nothing is merged or deployed, and `ORBIT_WORK` is off everywhere. Merging to `main` deploys production with two migrations and needs Mario's approval; switching `ORBIT_WORK` on is a separate approved step.

## Terms

| UI (German) | Code / docs | Meaning |
|---|---|---|
| Orbit-Projekt | project | The tenant and work area. Unchanged. |
| Vorhaben | initiative | A planned undertaking inside one Orbit project, with a short key such as `UML` |
| Meilenstein | milestone | A dated checkpoint of one initiative |
| Aufgabe | task | A unit of work with a number (`#12`); optionally in an initiative and a milestone |
| Unteraufgabe | subtask | A task with a parent task (one level only) |
| Checkliste | checklist item | A tick-box inside a task |

## Switching it on

Like Support and Finance, the module is opt-in twice:

1. **Installation:** `ORBIT_WORK=true` (default `false`, in `packages/config`, `.env.example` and `docker-compose.yml`).
2. **Project:** an owner enables it in Settings → Modules (needs `ORBIT_MODULES=true`), which writes an explicit `ProjectModule` row.

While `ORBIT_WORK` is off, the module is unavailable everywhere: routes answer 404 `WORK_DISABLED`, its tools, attention, notifications and periodic task are gone. With the flag on but the project row missing, routes answer 404 `WORK_DISABLED` (or `MODULE_DISABLED` with module switching). Switching it off deletes nothing.

## Permissions

| Key | Roles | Covers |
|---|---|---|
| `work.read` | owner, editor, viewer | all reads, watching a task |
| `work.write` | owner, editor | initiatives, milestones, tasks, checklist, dependencies, comments, attachments, links, archive and restore |
| `work.delete` | owner | deleting tasks, milestones and initiatives |
| `work.settings` | owner | workflow, task categories, teams, due notices |

Viewers read only and do not comment (Mario, Q-P1-3). Module roles (`ORBIT_MODULE_ROLES`) narrow these per member; `none` hides the module. Assignees and team members must be owners or editors in the module.

## Data

Ten tables with forced row-level security and composite same-project keys (migration `202610250005_work_core`): `WorkInitiative`, `WorkMilestone`, `WorkTaskCounter`, `WorkTask`, `WorkChecklistItem`, `WorkTaskDependency`, `WorkComment`, `WorkAttachment`, `WorkTaskWatcher` and the append-only history `WorkEvent`. Triggers keep a milestone inside its task's initiative and subtasks one level deep. Task numbers are per project and never reused.

The platform tables `ObjectLink` and `DomainEvent` (migration `202610250004_platform_links_events`) hold links between objects of any module and content-free domain events.

**Content-free records.** History rows, audits and domain events carry ids, field names and keys only; title and description changes are recorded as `{"changed": true}`. A test checks that no title, description or comment text reaches them.

## Workflow

Statuses are configurable keys (Settings → Projektmanagement), each in one fixed category: `backlog`, `todo`, `in_progress`, `blocked`, `in_review`, `done`, `canceled`. Progress, overdue checks, attention and later automation read the categories only. Rules:

- a `done` and a `canceled` status are required; keys are unique;
- an optional allow-list of transitions per status (`WORK_TRANSITION_NOT_ALLOWED`);
- a status tasks still use cannot be removed (`WORK_STATUS_IN_USE`);
- moving a status to another category moves its tasks along;
- entering `done` sets the completion time, leaving it clears it;
- optional WIP limits per status only warn on the board.

## Features

- **Initiatives** with key (derived from the title's initials when not given), status, health, owner, dates, progress; archive, restore, delete (tasks are detached, never deleted).
- **Milestones** per initiative with due date and status; deleting one keeps its tasks.
- **Tasks** with description, status, priority, category, labels, assignee, team, dates, estimate, subtasks, checklist, dependencies (cycles refused), comments with notified members, attachments (platform files of module `work`), watchers, links and history.
- **Board** with drag and drop (`@dnd-kit`, approved 2026-10-25; pointer, touch, keyboard) and a Move menu with up/down buttons on every card.
- **Lists** with filters (status category, priority, assignee, initiative, archived, open only), full-text search with word prefixes and `#number`, sort (board order, due date, priority, last changed, newest, number).
- **My tasks** grouped as overdue, today, this week, later and without due date; **overview** with figures; **milestones** per initiative; a home card.
- **Attention:** own overdue tasks, blocked tasks, milestones due within a week with open tasks (counts only).
- **Notifications:** assigned (e-mail on by default), mentioned (on), due and overdue once a day (off), watched task changed (off). Needs `ORBIT_NOTIFICATIONS`.

Every change checks the version the member saw; a conflict answers 409 `WORK_VERSION_CONFLICT` and the web reloads with a notice.

## Links to other modules

Tasks and initiatives link to support tickets, marketing campaigns and assignments, knowledge documents and other tasks (`ObjectLink`, relations `relates_to`, `implements`, `documents`, …). Each module resolves its own objects. A reader without the target module's permission sees "Restricted object", without access to the module "Removed or unavailable object". Ticket subjects are marked sensitive and never go to MCP clients. Linking changes nothing in the other module; hard-deleting a task removes its links, and a weekly check removes links to deleted objects.

## API

Routes below `/api/projects/:projectId/work` (OpenAPI regenerated): `overview`, `members`, `settings`, `initiatives` (+ `:id`, `archive`, `restore`, `milestones`, `links`), `milestones`, `tasks` (+ `batch`, `:id`, `move`, `archive`, `restore`, `checklist`, `dependencies`, `comments`, `attachments`, `watch`, `links`), `checklist/:id`, `dependencies/:id`, `comments/:id`, `attachments/:id`, `links/:id`, `link-targets`, `my`. Bodies are strict; unknown fields answer 400 `VALIDATION_FAILED`.

## Assistant and MCP

Reads: `work_search_tasks`, `work_get_task`, `work_list_initiatives`, `work_progress`, `work_my_tasks`. Proposals: `work_propose_tasks` (1–25), `work_propose_initiative` (with milestones), `work_propose_task_update` (with the version read), `work_propose_comment`.

- Offered while the module is on (tool feature `work`); proposals only to owners and editors.
- Proposals are exact approval requests that an **owner or editor** decides (Mario, Q-P1-5); Support and Finance stay owner-only. Executors re-check versions and record the source (`assistant` or `mcp`).
- MCP needs the explicit content scope **`orbit:work`** (unchecked on the consent screen) plus `orbit:read` or `orbit:propose`. MCP proposals also need `ORBIT_MCP_PROPOSALS` and, like Support and Finance, `ORBIT_MCP_TASKS`.
- `work_get_task` leaves out titles of sensitive linked objects.

## Configuration guide (when approved)

1. Merge and deploy (Mario's approval; runs both migrations).
2. Set `ORBIT_WORK=true` in Coolify and redeploy (separate approval).
3. An owner enables Projektmanagement in Settings → Modules of the chosen project and reviews the workflow in Settings → Projektmanagement.
4. Optional: `orbit:work` for an MCP client means reconnecting it and ticking the scope.

## Rollback

- `ORBIT_WORK=false` and redeploy: the module disappears, data stays.
- The migrations are additive; tables stay in place when code is reverted. Removing them would be a separate approved database action.

## Testing

`apps/api/tests/links-events.integration.test.ts`, `work-module.test.ts`, `work-rank.test.ts`, `work-services.integration.test.ts`, `work-routes.integration.test.ts`, `work-integrations.integration.test.ts`, `work-mcp.integration.test.ts`; RLS and access matrices; web `apps/web/src/modules/work/work.test.tsx`; Playwright `apps/web/tests/work.spec.ts` (`E2E_WORK=1`, stack with `ORBIT_WORK` and `ORBIT_MODULES`).

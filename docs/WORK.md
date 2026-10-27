# Project management module (`work`)

The project management module manages initiatives ("Vorhaben"), milestones, tasks, subtasks and checklists inside one Orbit project. The decisions are in [ADR 0016](adr/0016-project-management-links-events.md), the plan in [`plans/project-management-phase-1.md`](plans/project-management-phase-1.md).

**State (2026-10-25): Phase 1 is deployed to production (`5f89cc00`) with both migrations, and `ORBIT_WORK` is off.** Switching `ORBIT_WORK` on is a separate approved step.

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

## AI project manager (Phase 2, ADR 0017)

**State (2026-10-26): on main (pushed with Mario's approval, migrations included); `ORBIT_WORK_PM` is off and no paid call was made.** The plan is [`plans/ai-project-manager-phase-2.md`](plans/ai-project-manager-phase-2.md).

The PM is part of this module. It is one implementation that loads one initiative at a time; it has no instance, process or memory of its own, and its state is rows in the database (`WorkPmState`, `WorkPlanProposal`, `WorkPmFinding`, `WorkPmReport`, `WorkHandoff`, `WorkCodingRun`; migrations `202610250007_work_pm_run_kind`, `202610250008_work_pm`, `202610250009_work_handoffs`). It never chats. It runs as background jobs (queue `work_pm`), and members reach it in the initiative view, the task view, the assistant and MCP.

**Switching it on.** `ORBIT_WORK_PM=true` on top of `ORBIT_WORK` and the module in the project. While off, every PM route but `status` answers 404 `WORK_PM_DISABLED`, and its tools, jobs, subscribers and attention items stay quiet. Per initiative, an owner switches monitoring on (Projektmanagement → Vorhaben → KI-Projektleiter). A plan the PM created starts watched; status reports stay off until switched on (Q-P2-2).

**Permissions.**

| Key | Roles | Covers |
|---|---|---|
| `work.pm.use` | owner, editor | ask for plans, reports, analyses, handoffs; draft and submit coding briefs |
| `work.pm.apply` | owner, editor | decide plan and task-change approvals |
| `work.pm.manage` | owner | PM settings, budgets, autonomy, repositories, monitoring per initiative |
| `work.coding.dispatch` | owner (sensitive) | approve every coding dispatch |

**Governance levels** (P-5):

- L0, read: rule scans and findings. Automatic and free.
- L1, prepare: AI reports, plan drafts and re-prioritization drafts. Automatic within the daily budget; they change nothing.
- L2, change work data: applying plans and bulk task changes. Each is an approval decided by an editor.
- L3, external agents: coding dispatch and paid handoffs. The owner approves each one.
- L4, critical actions (deployments, migrations, secrets, billing): the PM has none of them.

Autonomy is `propose` by default (Q-P2-3). `comment_only` is a setting only an owner can switch on.

**Planning.** "Plan with AI" (or the assistant tool `work_pm_request_plan`) queues one structured run (task class `pm_plan`) over a deterministic context. That context holds the request, today's date in the project's timezone, the members who may own work and, when extending, the initiative's tasks. The run reads with read tools only and searches knowledge unless the initiative's research mode is `off`. Web search is used only in mode `web`, which is off by default (Q-P2-5). The answer is checked deterministically:

- refs resolve and are unique;
- the dependencies have no cycle;
- subtasks are one level deep;
- dates fit;
- invented or viewer assignees are dropped (`assignee_dropped:<ref>`).

A valid plan gets one `work.plan.apply` approval, decided by an editor in Approvals. Applying creates the initiative (for a new plan), milestones, tasks with their acceptance criteria as checklist items, and dependencies. This happens once, in one transaction, as the PM (`source: pm_agent`, origin `work.pm`). Edits in the plan review make a new revision and withdraw the previous approval.

**Monitoring.** Nine rules run on status categories and dates only, with no AI: `overdue`, `due_soon_unstarted`, `blocked_long`, `dependency_late`, `dependency_canceled`, `stale_in_progress`, `milestone_at_risk`, `unassigned_priority` and `scope_creep`. Findings have stable fingerprints: they update, resolve when the condition clears, and come back after a dismissal ends. A scan runs after task, milestone or initiative events, at most once per initiative and five minutes and never because of the PM's own writes, and once a day. A newly critical finding notifies the initiative owner and the escalation list (`work_pm_escalation`, e-mail on), shows as attention and asks the analyst at most once a day.

**Reports and analyses** (task class `pm_analysis`). Reports run on request or on the schedule: weekly on Monday 08:00 or daily at 08:00, in the project's timezone. They are skipped when the state hash is unchanged. An analysis proposes priority, due date and assignee changes to open tasks, bound to their versions, as one `work.tasks.bulk_update` approval for an editor. Reports are labelled as AI-generated.

**Budget.** Every PM call needs the project's spend mandate (ADR 0015) and fits the PM's daily ceiling, which defaults to USD 2 per UTC day (Q-P2-1, Settings → Projektmanagement). When the ceiling is reached, requests are refused (`WORK_PM_BUDGET_EXHAUSTED`), queued AI work stops before any call, and members see an attention item. A call whose outcome is unclear is never resent.

**Handoffs.** A task can be handed to work another target owns: the PM's research and analysis, or targets that other modules register. An editor approves internal targets; the owner approves paid or external ones. The task links to the target with `delegated_to` and gets the target as its agent assignee. When the target reports progress (`platform.handoff.status_changed`), the task moves to *in progress* when the work starts and to *in review* when it finishes, never to *done*. Research and analysis answer with an agent comment. Research URLs are kept only when a web search of that run returned them.

**Coding work orders.** Orbit never runs code. A draft brief per task (written by a member or drafted by the PM) is redacted by `platform/privacy/redact.ts`: e-mails, phone numbers, credentials, wallet addresses and transaction hashes are removed, and only counts are kept. A person confirms that the brief holds no personal data, and the owner approves every dispatch (`work.coding.dispatch`). With the manual provider, a developer takes the brief and reports branch, pull request, commit and tests. The automation provider sends the brief to the repository's n8n workflow and follows its signed callback (contract: [`integrations/coding-agent.md`](integrations/coding-agent.md)). A finished run moves the task to *in review*, and a person closes it. The limits are one active run per task, a concurrency limit, a monthly coding budget for paid providers, and a timeout that sets the run to `outcome_unknown` with an attention item. A task with runs is archived, not deleted.

**MCP.** Reads (`work_pm_status`, `work_pm_findings`, `work_pm_get_report`, `work_pm_get_plan`) need `orbit:work`. The proposals are:

- `work_pm_propose_plan` and `work_pm_propose_report`: need `orbit:work.pm`; an editor decides; a plan then needs its own second approval;
- `work_pm_propose_changes`: needs `orbit:work`;
- `work_pm_propose_coding_run`: needs `orbit:work.coding`; the owner approves the exact redacted brief, and that approval is the dispatch.

Delegated MCP 2.0 work orders may read the PM's state, but never spend its budget or dispatch coding.

**Approvals for editors.** The approvals list (Approvals, `GET /action-requests`) now shows every pending request the member may decide. That includes the editor-decided project management requests, which were listed nowhere before.

**Evaluation.** `evals/work-pm/` scores plans structurally (see its README). Passing it is a condition for switching `ORBIT_WORK_PM` on. A live run needs Mario's approval of its budget (proposal: at most USD 2).

**Rollout (each step a separate approval).**

1. Merge and deploy; this runs the three additive migrations.
2. Verify and price routes for `pm_plan` and `pm_analysis` (Settings → AI).
3. Run the live evaluation within the approved budget, and pass it.
4. Set `ORBIT_WORK_PM=true` and redeploy.
5. An owner sets the PM budget and repositories, and switches monitoring on per initiative.
6. Optional: an n8n coding workflow, with its own approval of workflow, repository and GitHub rights.

**Failed plans.** A plan whose run failed shows the reason in words, for example "the AI provider was overloaded" or "the model is not available for this key", with its code. Members who may ask the PM can **plan again**: the request runs again as a new revision, after the budget check, and only once. Asking for the same plan again (also over MCP) does the same. A provider's refusal is not billed; its status and message are kept in the run's model-call span. See the incident note [plans/pm-plan-rejection-2026-10-26.md](plans/pm-plan-rejection-2026-10-26.md).

**Rollback.** `ORBIT_WORK_PM=false` and redeploy: the PM disappears and its data stays. The migrations are additive.

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

# Project management module (`work`)

The project management module manages initiatives ("Vorhaben"), milestones, tasks, subtasks and checklists inside one Orbit project. The decisions are in [ADR 0016](adr/0016-project-management-links-events.md), the plan in [`plans/project-management-phase-1.md`](plans/project-management-phase-1.md).

**State (2026-10-25): in implementation on the branch `claude/work-module-phase-1`.** Nothing is merged or deployed, and `ORBIT_WORK` is off everywhere.

## Terms

| UI (German) | Code / docs | Meaning |
|---|---|---|
| Orbit-Projekt | project | The tenant and work area. Unchanged. |
| Vorhaben | initiative | A planned undertaking inside one Orbit project |
| Meilenstein | milestone | A dated checkpoint of one initiative |
| Aufgabe | task | A unit of work; optionally in an initiative and a milestone |
| Unteraufgabe | subtask | A task with a parent task (one level) |
| Checkliste | checklist item | A tick-box inside a task |

## Switching it on

Like Support and Finance, the module is opt-in twice:

1. **Installation:** `ORBIT_WORK=true` (default `false`).
2. **Project:** an owner enables it in Settings → Modules (needs `ORBIT_MODULES=true`).

While `ORBIT_WORK` is off, every route answers 404 `WORK_DISABLED` and the module is hidden.

# ADR 0016: Project management module, object links and domain events

## Status

Accepted by Mario, 2026-10-25. The plan is [`docs/plans/project-management-phase-1.md`](../plans/project-management-phase-1.md); Mario answered its questions Q-P1-1 to Q-P1-5 on 2026-10-25 and asked to start the implementation. Implementation is local on the branch `claude/work-module-phase-1`; nothing is merged or deployed, and `ORBIT_WORK` is off.

## Context

ADR 0009 names "Projects" as a later module, but no work package and no code exist. Orbit has no task, milestone or checklist model, no link between objects of different modules, and no domain-event mechanism (the outbox is a job queue). The follow-up phases need all three:

- Phase 2 ([`ai-project-manager-phase-2.md`](../plans/ai-project-manager-phase-2.md)): an AI project manager that reacts to task changes and hands work to other modules.
- Phase 3 ([`issue-center-phase-3.md`](../plans/issue-center-phase-3.md)): an issue center that links support tickets, issues and development tasks, with status changes that must not loop.

"Project" already means the tenant (`Project`, `/p/:projectId`), and `tasks`, `orbit_tasks`, `agent_tasks` and `work_packages` are taken.

## Decision

1. **D-1 Module identity.** The module id is `work`. Display name "Projektmanagement" / "Project management"; the planned undertaking is a "Vorhaben" (initiative). Tables are prefixed `Work`, permissions `work.`, routes `/api/projects/:projectId/work/…`, web `/p/:projectId/work/…`, installation switch `ORBIT_WORK` (default off), opt-in per project. This deviates from the module name `projects` in ADR 0009.
2. **D-2 Single store for development work.** Initiatives, milestones and tasks are dedicated tables owned by `work`. Support tickets, marketing missions and assignments, MCP work orders and specialist steps stay where they are and are referenced, never copied.
3. **D-3 Object links.** A platform table `ObjectLink` holds bidirectional, same-project references `(sourceType, sourceId, relation, targetType, targetId)` between objects of any module. Modules contribute link types with a resolver (title, status, link, `sensitive`) and a `linkPermission`; readers without it see a restricted placeholder. Relations are a closed list: `relates_to`, `implements`, `reported_in`, `duplicates`, `delegated_to`, `documents`. Cross-project links are out of scope.
4. **D-4 Domain events.** A platform table `DomainEvent` records content-free events (`type`, subject, actor, `origin`, `causationId`, `correlationId`, `depth ≤ 5`, `data ≤ 4 KB`). Modules declare published types and subscribers; delivery is one idempotent job per subscriber on the platform queue `domain_event`. A subscriber never receives events of its own origin.
5. **D-5 Status categories.** Task statuses are configurable keys mapped to the fixed categories `backlog`, `todo`, `in_progress`, `blocked`, `in_review`, `done`, `canceled`. Automation reads categories only.
6. **D-6 Forward compatibility.** `WorkTask.assigneeAgentKey` and `WorkTask.source` exist from the start.
7. **D-7 Approvals.** Assistant and MCP writes are ActionRequest proposals. `approvedOperation` gains an optional `deciderRole`; work proposals use `editor` (Q-P1-5). Support and Finance keep `owner`.
8. **D-8 MCP scope.** New content scope `orbit:work`.
9. **D-9 No RAG indexing.** Tasks are not ingested into the knowledge corpus; the module searches with Postgres full text.
10. **D-10 Drag and drop.** `@dnd-kit/core` and `@dnd-kit/sortable` are approved as production dependencies (Q-P1-2); a keyboard/menu move path stays mandatory.

Further decisions of 2026-10-25: viewers cannot comment (Q-P1-3); the module's sidebar group follows Marketing (`groupOrder` 15, Q-P1-4).

## Alternatives

- **A platform-wide generic task table** that tickets, missions and issues also write into: duplicates module records, merges incompatible state machines and breaks module ownership (ADR 0009 AD-03).
- **Per-module-pair link tables:** real foreign keys, but one table and UI per pair.
- **Synchronous in-transaction hooks instead of events:** simpler, but couples modules and makes loop protection implicit.
- **Module name `projects`, `tasks` or `pm`:** collisions or opaque names (plan §2.2).

## Consequences

- Two additive platform tables and about twelve additive `Work*` tables with FORCE RLS, composite tenant keys and grants; the RLS matrix, access matrix and registry tests grow accordingly.
- Links have no foreign keys: modules call `removeLinksFor` when they hard-delete an object, resolvers report missing objects, and a periodic task prunes links whose target stays missing.
- `ModuleContributions` gains `linkTypes` and `events`; `ToolFeature` gains `work`; `Operation` gains `deciderRole`.
- Every production step (merge to `main`, which deploys and migrates, and switching `ORBIT_WORK`) needs Mario's separate approval.

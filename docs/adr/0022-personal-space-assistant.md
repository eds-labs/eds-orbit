# ADR 0022: Personal space and user-scoped Orbit Assistant

## Status

Accepted, 2026-11-04. Mario answered D-08, D-09, D-10 and D-17 on 2026-11-04 ([ADR 0021](0021-agent-platform.md) addendum "Phases 3 and 4: owner decisions"). This ADR turns those answers into the design that the [Phase 3 plan](../plans/agent-platform-phase-3.md) implements. Nothing here is live until its work package lands and `ORBIT_PERSONAL_ASSISTANT` is switched on.

It extends [ADR 0021](0021-agent-platform.md) (capability layer, principal, work orders), [ADR 0009](0009-modular-platform.md) AD-11 (one Orbit Assistant), [ADR 0013](0013-system-administration.md) (administration) and [ADR 0015](0015-ai-spend-policy.md) (spend authority).

## Context

Orbit Chat lives in one business project. Every chat table, job, outbox row, pause switch, AI configuration, spend authority, telemetry row and realtime channel is keyed by a project, and the RLS policy `chat_owner_scope` requires workspace, project and user. A user who works in several projects has no place to ask one question across them, and no assistant that follows them across pages. MCP already reaches several projects in one session: its adapter injects a `projectId` into every registry tool and authorizes each call in that project.

## Decision

1. **Personal space (D-08).** Each user gets at most one project of kind `personal` per organization (`Project.personalUserId`, partial unique index on `(workspaceId, personalUserId)`, CHECK that a personal project names its user). It is created lazily and idempotently on first assistant use. Its only member is that user, with the owner role.
   - **Membership rule.** For kind `personal` the implicit project-owner role of organization owners does not apply, and global administrators get no access. This is one rule in `projectMembership`, so API requests, worker actor checks and the MCP principal all follow it.
   - **Hidden from business lists.** `/api/me`, `/api/projects`, cross-project summaries, MCP project lists, administration lists, the social organization calendar and org-wide maintenance tasks exclude kind `personal` unless they act on the personal space explicitly. Administration shows counts at most.
   - **No business modules** are activated there. The assistant and the personal context work without `ProjectModule`. Pausing the personal space pauses only the assistant; an organization pause pauses it too.
   - **Lifecycle.** Deleted 30 days after the user leaves the organization (a daily platform `PeriodicTask`), and at once on user erasure. Its content is user-private and never exported to others.
2. **Payer (D-09).** The personal space pays its own model calls. Its spend authority is a read-only projection of the organization setting `OrganizationAiBudget.assistantPerUserMonthlyMicros`, with day and run limits derived from it. Org owners set it under organization settings → AI; without it the personal space has no paid authority. The user cannot raise it. `reserve` treats the personal space like any project, so organization budgets count its spend. Paid work inside a business project (an agent work order, a creative preview) stays on that project's spend authority and approvals.
3. **Bubble and project chat (D-10).** A floating bubble on every authenticated page opens the personal assistant with the current project as focus. `/p/:id/assistant` stays unchanged, with its tools, limits and deep links. The split is re-evaluated after Phase 3.
4. **Cross-project capability.** In personal mode, project tools are called with an explicit `projectId`. The capability layer opens the **target** project's own `userScoped` transaction with the user's current scope there and checks activation, module role, entitlement and pause in that project. The personal-space transaction is never held during a target-project call, so there are no nested project locks. Refusals are uniform (`PROJECT_FORBIDDEN`, `MODULE_DISABLED`, `PERMISSION_DENIED`) and return no data. The MCP adapter uses the same code; OAuth scopes, grant checks and client quotas stay MCP-only.
5. **Taint rule.** A personal turn records every project whose data entered it (`contextProjects`). A proposal in project B made in a turn that read project A carries `requestedBy.crossProjectContext = [A]`; `resolveAuthorization` then refuses mandate auto-approval with `CROSS_PROJECT_CONTEXT`, and the card names A. Every proposal belongs to exactly one project.
6. **Staged, provider-neutral tool loading.** A personal turn starts with at most eight platform user tools. Project tools enter only through `load_project_tools(projectId, goal)` or the focus-project preload (at most six). Loaded definitions are appended to the next model call within the same turn for both providers; the deferred list stays stable within a turn. Project mode keeps today's loading.
7. **Delegation and MCP work orders (D-05, D-06).** `agent_delegate` builds the principal as requester ∩ sponsor ∩ allowlist through the Phase 1 delegation core and returns a confirmation card. Finished work orders post one `notice` message (`ChatMessage.role = 'notice'`) with result cards into the originating conversation, without a model call. New MCP `orbit_create_task` calls persist as `AgentWorkOrder (target: assistant)`; the MCP read tools merge legacy `orbit_tasks` entities until task retention removes them. Tool names, shapes, scopes and approvals stay unchanged.
8. **Personal context: automatic memory with guardrails (D-17).** A user-private entity kind `personal_context` in the personal space.
   - The assistant saves an entry with `context_remember`, and the conversation shows "Remembered: …" with Undo. Nothing is saved silently.
   - Only what the user said in the turn may become an entry. A deterministic screen refuses third-party personal data, secrets and credentials, health and financial details, and text taken from tool results (`PERSONAL_CONTEXT_NOT_ALLOWED`).
   - A switch on "My context" turns automatic memory off; `context_remember` then returns a card that only the user's click saves.
   - Only the user lists, edits, archives, exports and deletes entries. Entries are never visible to org owners or administrators and never reach configured agents, work orders or MCP outputs.
   - At most 2 KB of active entries enter personal-mode instructions; an entry with a project scope only while that project is in focus.
9. **Page context is a hint.** The web shell may send `pageContext {projectId?, route?, entity?}`. The server keeps it only if the user may read that project and entity; it never grants access.

## Alternatives

- **Nullable `projectId` on the chat tables with a user-only RLS branch.** Rejected: jobs, outbox, worker pump, realtime and budgets are all keyed by project, so this would be a second, project-less data plane.
- **Home project** (personal conversations stored in whichever business project is open). Rejected: wrong payer, history lost with project access, mixed pause semantics.
- **New assistant tables.** Rejected: a parallel chat backend.
- **Propose-and-confirm memory only.** The plan's recommendation; Mario chose automatic memory (D-17). It stays available as the fallback mode.

## Consequences

- An authorization change: organization owners lose implicit access to a new kind of project. The access and RLS matrices gain personal-space rows, reviewed as a security change.
- Every project listing must state whether it includes personal spaces; a test enumerates the list endpoints.
- Two additive migrations: the personal-space columns and constraint (WP3.1) and the `notice` chat role (WP3.6). Each needs a Coolify-approved schema hash before the main push.
- Assistant cost becomes a per-user organization setting; without a configured cap the personal assistant cannot make paid calls.
- Rollback: `ORBIT_PERSONAL_ASSISTANT=false` hides the bubble, `/api/assistant` returns 404 and personal spaces stay inert. Constraints and columns stay. MCP keeps writing work orders to the table, and its reads handle both stores.

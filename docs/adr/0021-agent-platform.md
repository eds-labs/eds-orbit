# ADR 0021: Agent platform: one loop, two hosts, one capability layer

## Status

Accepted, 2026-11-04. Mario accepted the recommendations D-01 to D-07 and D-12 to D-14 of the [architecture plan](../plans/agent-platform-architecture.md) (§14) on 2026-11-04. On 2026-11-04 Mario also accepted the Phase 2 recommendations D-11, D-15 and D-16 (addendum "Phase 2: Support agent" below). On 2026-11-04 Mario answered the Phase 3 and 4 decisions D-08 to D-10 and D-17 to D-20 (addendum "Phases 3 and 4: owner decisions" below); D-17 and D-18 differ from the plan's recommendation.

This ADR extends [ADR 0005](0005-agent-runtime.md), [ADR 0007](0007-tool-registry.md), [ADR 0008](0008-action-approvals.md) and [ADR 0019](0019-agent-mandates.md). It **supersedes** the sentence in [`docs/plans/marketing-agent-v2.md`](../plans/marketing-agent-v2.md) §1 "Do not introduce another assistant, autonomous agent framework, scheduler…" for the scope described here. Marketing Agent v2 otherwise stays valid.

Implementation is staged by the [Phase 1 plan](../plans/agent-platform-phase-1.md). Nothing in this ADR is live until its work package lands and its flag is switched on.

## Context

Orbit already has one model loop (the `AgentRuntime` port with the `legacy_responses` adapter), a typed tool registry, ActionRequests with risk classes, agent mandates, durable delegated work orders (MCP 2.0), domain events, a due-marker worker, budgets with reservation and settlement, and per-run telemetry.

Mario wants users to configure their own agents, and later a personal assistant per user, on that platform. Three problems stand in the way:

1. The same budgeted call path exists four times (chat runner, `runStructured`, Marketing `runSpecialist`, Support `modelCall`), and the tool visibility filter exists twice (chat runner, MCP visibility). A configured-agent feature built on a fifth copy would make every later rule change five changes.
2. There is no principal for an agent. Marketing specialists run as `{userId: "worker", role: "owner"}` without execution-time checks; `runStructured` checks permissions once, before the run.
3. Agents exist only as code (Marketing specialists, Work PM, Issues triage). There is no data model for a user-configured agent, its triggers, its budget or its history.

## Decision

1. **Variant V2.** One loop, two hosts, one capability layer.
   - The `AgentRuntime` port stays the only model loop. No second runtime, no hosted agent runtime (ADR 0005 §5 still holds).
   - The **conversational host** (`platform/assistant/chat-runner.ts`) serves dialogue: project chat, MCP work orders and, later, the personal assistant.
   - The **task host** (`platform/agents/structured-run.ts`, `runStructured`) serves configured agents and module pipelines. Marketing's `runSpecialist` and Support's model call delegate to it over time.
   - A new **capability layer** (`platform/agents/capabilities.ts`) is the one place that decides which tools a principal may see in a project and that executes one tool call (host-side argument validation, per-call re-authorization, JSON-safe output cap). Both hosts and the MCP adapter use it.
2. **Principal: sponsor model (D-02).** An agent never has rights of its own. A configured agent acts on behalf of the owner who activated its current version (the *sponsor*). A manual or delegated run also acts for its *requester*. The effective rights of every tool call are the intersection of the agent's frozen allowlist, the sponsor's current rights and the requester's current rights, re-evaluated on every call. Service accounts with their own roles are deferred until SaaS self-service needs them.
3. **Who may do what (D-03).**
   - Create, edit, duplicate, activate, pause, resume and disable an agent: project owner (`platform.agents.manage`). Activation is a hash-bound action in the authenticated web UI only.
   - View agents and their executions, start a manual run, cancel: owner and editor (`platform.agents.read`, `platform.agents.run`), plus read permission in every module of the agent.
   - Viewers: no access.
4. **Scope (D-04).** Agents are project-scoped in Phase 1. Organization-level agent templates may follow later.
5. **Agent definitions are versioned data.** Entity kind `agent_definitions` with an `active` configuration (what runs) and a `draft` working copy. A definition references registry tools, knowledge sources, a model route, limits, a budget and triggers. It never contains code, SQL, HTTP or shell access, can never widen permissions, and can only name tools that are exposed to agents.
6. **Work orders (D-05).** One durable unit of agent work is a row in the new project table `AgentWorkOrder` (FORCE RLS, composite tenant foreign keys). It is executed by the existing worker through a new queue class. MCP 2.0 `orbit_tasks` stay as they are in Phase 1 and are folded into `AgentWorkOrder` in Phase 3 with read compatibility; the `ORBIT_MCP_TASKS` production state is verified before that step.
7. **Starting work (D-06).** A manual or delegated start needs the requester's confirmation (the requester must hold editor rights in the agent's modules) and stays within the agent's budget. A per-agent start mandate is optional and may follow later.
8. **Delegation limits (D-07).** Depth at most 2 (assistant → agent → agent), at most 10 children per work order, at most 3 running work orders per project by default, one open work order per (agent, subject), no cycles, monotonic narrowing of tools, modules, mode, knowledge and cost ceiling, and named delegation targets only.
9. **Approvals stay ActionRequests.** A proposal tool called by an agent creates an ActionRequest whose `requestedBy` names the agent, the agent version, the work order, the sponsor and the requester. External effects (`W1`, `W2`, `D*`, `F*`, `G`) are always human-approved. Customer replies and publishing are never automatic.
10. **Entitlements port (D-12).** `platform/entitlements/` exposes `entitlementsFor(workspaceId)`. Phase 1 ships a code default that returns "unlimited" for every key, so the self-hosted installation behaves as before. Enforcement points call the port from Phase 1 on. A table and an administration page come later; plans and billing are out of scope.
11. **Wording (D-13).** German UI terms: *Agenten*, *Ausführungen* (work orders). Marketing keeps *Aufträge* (assignments). *Persönlicher Bereich* is reserved for Phase 3.
12. **No generic workflow engine (D-14).** The Marketing assignment DAG stays in Marketing. A generic multi-step engine is reconsidered only when a second module needs one.
13. **Flags.** `ORBIT_AGENT_PLATFORM` (builder, manual runs) and `ORBIT_AGENT_AUTOMATION` (schedule and event triggers), both default off. The capability-layer and host consolidation refactors (WP1.1 to WP1.3) are flagless and behaviour-preserving.

## Addendum to ADR 0019: the agents channel

This addendum takes effect with WP1.2 and only while `ORBIT_AGENT_MANDATES` and `ORBIT_AGENT_PLATFORM` are both on.

- The `agent_mandates` record gains `channels.agents: boolean` (default false) and `agentIds: uuid[]` (at most 10).
- `resolveAuthorization` covers a request with `requestedBy.kind = "agent"` only if all of the following hold, in addition to every existing ADR 0019 condition:
  - the mandate's agents channel is on **and** names the agent id;
  - the agent's status is `active` and its active version equals the version on the request;
  - the grantor is still an owner in the type's module;
  - the sponsor and, if present, the requester still hold the operation's permission.
- Delegated MCP tasks stay uncovered (`DELEGATED_TASK_NOT_COVERED`). The Support inbox rule `mcpOwnerRepliesWithoutApproval` never applies to agents.
- A proposal made in a turn that read data from another project can never be auto-approved (cross-project taint, Phase 3).

## Alternatives

- **V1: configured agents as chat work orders in the conversational host.** Rejected as the primary host: chat tables are user-private by RLS (other owners could not inspect a sponsor's runs), the chat prompt and context fit dialogue rather than tasks, and there is no structured result. Kept for the assistant and MCP.
- **V3: generalize the Marketing DAG engine.** Deferred (D-14).
- **V4: a separate agent service.** Rejected: duplicates RLS, budgets and approvals.
- **V5: hosted agent runtimes.** Rejected for the reasons of ADR 0005 §5.
- **Service accounts with their own roles.** Deferred (D-02).

## Consequences

- One rule change for tool visibility or execution applies to chat, MCP and agents at once.
- Marketing specialists get a real on-behalf principal (WP1.9). A demoted confirming owner then blocks the specialist: an intended behaviour change, called out in its PR. Implemented as a per-call owner re-check (`authorizeOnBehalf`, task host hooks `guard` and `beforeTool`); details in the ADR 0005 addendum of 2026-11-04. Module-managed agents such as assignments appear read-only in the overview through `ModuleContributions.agentListings` (`GET /api/projects/:projectId/agents/managed`).
- New schema: one additive migration (`AgentWorkOrder`, the `AgentRun_kind_check` widening, agent spend attribution) that needs a Coolify-approved schema hash before the `main` push that deploys it.
- New operational surface: a queue class, a scheduler contribution, an event subscriber and a retention task, all inert while the flags are off.
- Rollback: switch the flags off. Routes return 404, triggers do nothing, stored definitions and work orders stay inert. The flagless refactors can be reverted on their own.

## Addendum (2026-11-04): Phase 2, Support agent

Mario accepted the [Phase 2 plan](../plans/agent-platform-phase-2.md) recommendations on 2026-11-04:

- **D-11 Provider for Support customer data.** OpenAI only, until Anthropic is legally reviewed. Enforced in code by a data-class provider allow-list (`platform/ai/data-class.ts`): a tool marked `dataClass: "customer_personal"` makes the task host refuse an agent route whose provider is not allowed, and the Support triage and draft pipelines refuse such a route too, before anything is sent (`AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA`). The allow-list is a code constant (`["openai"]`); widening it needs a recorded legal decision and a code change, not a setting.
- **D-15 Inbox mode.** `SupportInbox.aiMode` gains the explicit value `agent` (migration, constraint widen). In an `agent` inbox the automatic triage and draft jobs are not queued; an active Support agent whose event trigger covers the inbox does the work. There is no automatic fallback to `draft` when the agent is inactive (T2-1): an attention item names the inbox.
- **D-16 Mandatable Support types for agents.** Internal note (`support_add_note`), reply draft (`support_prepare_reply`) and the new triage application (`support_apply_triage`: priority, category and tags only, never a downgrade from `urgent`, never status or assignee). Customer replies (`W1`) are never mandatable and the inbox rule `mcpOwnerRepliesWithoutApproval` never applies to agents. Ticket field changes through `support_update_ticket` stay owner decisions.

Phase-local defaults T2-1 to T2-5 of the plan are taken as written.

## Addendum (2026-11-04): Phases 3 and 4, owner decisions

Mario answered the remaining decisions of the [architecture plan](../plans/agent-platform-architecture.md) (§14) on 2026-11-04. They are recorded here so the Phase 3 and 4 ADRs (0022 to 0024) start from them; nothing of Phases 3 and 4 is implemented yet.

- **D-08 Personal space.** As recommended: one project of kind `personal` per (user, organization), with exactly that user as member and no implicit access for org owners or admins.
- **D-09 Payer of assistant turns.** As recommended: the personal space pays its own model calls, within a spend authority derived from an org-level per-user monthly cap that org owners set and the user cannot raise. Paid work in a business project stays on that project's spend authority and approvals.
- **D-10 Bubble.** As recommended: the bubble opens the personal assistant with the current project as focus; `/p/:id/assistant` stays unchanged; re-evaluated after Phase 3.
- **D-17 Personal context: automatic memory, with guardrails** (differs from the recommendation "propose and confirm"). The assistant may save an entry itself. Guardrails:
  - every saved entry shows as a notice in the conversation ("Remembered: …") with an undo;
  - never saved: customer or third-party personal data, secrets and credentials, health or financial details, and content taken from tool results (only what the user said in the turn may become an entry);
  - a switch on "My context" lets the user fall back to "propose and confirm";
  - the user alone edits, archives, exports and deletes entries; entries never reach configured agents, work orders or MCP outputs.
- **D-18 Proactive channels: in-app, e-mail and per-user Telegram in Phase 4** (differs from the recommendation "Telegram later"). Per-user Telegram reuses the existing Orbit bot and its code-only linking, follows the same dedupe, digest, quiet-hour and per-kind rules as e-mail, and carries notice text only, never customer content. Its exact link model and bot-permission review are part of the Phase 4 ADR.
- **D-19 Voice.** As recommended: OpenAI transcription and speech behind a speech port; no audio stored by default, only text. The new processing purpose still needs Mario's provider approval before any live use.
- **D-20 Realtime voice.** As recommended: only a spike and an ADR after transcription and speech are in use; no implementation planned.

# ADR 0017: AI project manager

## Status

Accepted by Mario, 2026-10-25. The plan is [`docs/plans/ai-project-manager-phase-2.md`](../plans/ai-project-manager-phase-2.md); Mario answered its questions Q-P2-1 to Q-P2-6 on 2026-10-25 and asked to start the implementation after Phase 1 went live (`5f89cc00`). Implementation is local on the branch `claude/ai-pm-phase-2`; nothing is merged or deployed, and `ORBIT_WORK_PM` is off.

## Context

Phase 1 (ADR 0016) delivered the `work` module with initiatives, milestones, tasks, object links and domain events. Phase 2 adds an AI project manager ("PM") that plans initiatives, watches their progress, reports, proposes changes and hands work to other agents, including external coding agents.

Orbit has one conversational agent (ADR 0005), bounded runs and Postgres as the only state. Marketing's specialist runner is module code that no other module may import (`scripts/boundaries.mjs`). Task classes are a closed list, and every paid call takes the spend mandate path (ADR 0015). External execution has one signed, approvable path today: the n8n automation binding (ADR 0014), whose callback records status and codes only.

## Decision

1. **P-1 Placement.** The PM is a capability of the `work` module (`apps/api/src/modules/work/pm/`): one shared implementation that loads exactly one initiative's state per run, inside `scoped()` for one project. There is no agent instance, process or memory per initiative; durable state is explicit rows (`WorkPmState`, findings, reports, plan proposals). The PM never chats: it runs as background jobs, and the Orbit Assistant stays the user interface. Installation switch `ORBIT_WORK_PM` (default off) on top of `ORBIT_WORK`.
2. **P-2 Structured runs in the platform.** A domain-neutral helper `platform/agents/structured-run.ts` runs one bounded, schema-validated agent run on the existing runtime port: R0 read tools only, optional hosted web search, strict output schema, input size limit before any reservation, tool outputs capped, spend mandate, reservation per call, settlement, `outcome_unknown` never resent. PM roles (planner, analyst, reporter, researcher) are roles of this helper, not agent systems. New task classes `pm_plan` and `pm_analysis`; new run kind `work_pm`. Marketing's runner is not migrated in this phase.
3. **P-3 Handoff registry.** Modules contribute handoff targets (`ModuleContributions.handoffs`) that turn a task into work they own. The work module offers them without importing the target module; the task is linked with `delegated_to`, and target status events move it forward only, never to `done`.
4. **P-4 Coding agents.** Orbit never executes code and holds no shell or repository write credentials. It prepares a sanitized brief, asks the owner to approve each dispatch, dispatches through a provider adapter (`manual` first, then the n8n automation binding with a strictly validated, contract-specific callback result) and records branch, pull request and test numbers. A merged pull request moves the task to `in_review`; a person marks it done.
5. **P-5 Governance levels.** L0 read (rule scans, free, automatic); L1 prepare (AI reports and drafts within the PM daily budget, change nothing); L2 change work data (ActionRequest decided by an editor; `comment_only` autonomy optional per project); L3 external agents (ActionRequest decided by the owner, every time); L4 critical actions (deployments, migrations, secrets, billing) are not available to the PM at all.
6. **P-6 Rules before AI.** Monitoring runs deterministic rules on status categories with stable fingerprints and no AI cost. AI runs only on schedule, request or a new critical finding, skips unchanged state (`stateHash`) and stops at the daily ceiling.
7. **P-7 MCP.** PM reads use `orbit:work`; paid PM requests add the scope `orbit:work.pm`, coding dispatch proposals `orbit:work.coding`. MCP clients always go through approval; delegated MCP 2.0 work orders cannot dispatch coding.

Mario's decisions of 2026-10-25 (plan §11): PM daily budget default USD 2 per project and UTC day, still bounded by the spend mandate (Q-P2-1); status reports weekly on Monday 08:00 in the project's timezone, off for new initiatives until enabled (Q-P2-2); autonomy `propose` by default, `comment_only` only when an owner switches it on (Q-P2-3); manual coding provider first, then n8n with its own approval of workflow, repository and GitHub rights (Q-P2-4); web research off by default, switchable per initiative (Q-P2-5); no PM results inside the chat conversation in the MVP (Q-P2-6).

## Alternatives

- **An agent instance per initiative:** long-lived processes and memory contradict ADR 0005/0006 and duplicate state and cost; RLS and initiative scoping already isolate runs.
- **A second conversational agent next to the assistant:** two competing chat systems (ADR 0005 §6).
- **Reusing marketing's specialist runner:** forbidden cross-module import; moving it would refactor a live system without need.
- **Letting the PM write directly:** faster, but unreviewable; every change is a proposal except the narrow `comment_only` path.
- **Orbit running coding agents itself:** needs shell, repository credentials and sandboxing Orbit does not have; external systems already do this with their own controls.

## Consequences

- New tables `WorkPmState`, `WorkPlanProposal`, `WorkPmFinding`, `WorkPmReport` and `WorkCodingRun` with FORCE RLS and composite tenant keys; the RLS matrix and access matrix grow.
- `TaskClass` gains `pm_plan` and `pm_analysis`; the owner routes them in Settings → AI like every task class. `AgentRun.kind` gains `work_pm`.
- New ActionRequest types `work.pm.run`, `work.plan.apply`, `work.tasks.bulk_update`, `work.handoff` and `work.coding.dispatch`; new MCP scopes `orbit:work.pm` and `orbit:work.coding`.
- No test makes a paid call. Enabling `ORBIT_WORK_PM`, the budgets, live evaluations (proposal ≤ USD 2) and any live coding dispatch are separate approvals.

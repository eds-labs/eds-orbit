# Agent platform (configured agents)

User and operator guide for the agent platform of [ADR 0021](adr/0021-agent-platform.md). Not to be confused with the repository's root `AGENTS.md` (instructions for coding agents). Plans: [architecture](plans/agent-platform-architecture.md), [Phase 1](plans/agent-platform-phase-1.md).

State (2026-11-04): Phase 1 is implemented on branch `claude/agent-platform-architecture-128114`. It is not merged, not deployed, and both flags are off by default.

## What it is

Project owners configure their own **agents** (*Agenten*): versioned definitions that name registry tools, modules, an autonomy mode, limits, a budget and triggers. An agent's work is a durable **work order** (*Ausführung*), run by the Orbit worker on the existing model loop, tool registry, approvals and budgets. There is no second runtime, approval system or chat backend.

An agent never has rights of its own:
- It acts **on behalf of its sponsor**, the owner who activated its current version.
- A manual run also acts for its **requester**.
- Every tool call is authorized again against the agent's frozen allowlist, the sponsor's current rights and the requester's current rights.
- A lost right, a paused agent or a newly activated version stops the run at the next call (`AGENT_PRINCIPAL_FORBIDDEN`, `AGENT_NOT_ACTIVE`, `AGENT_VERSION_CHANGED`).

## Roles (D-03)

| Action | Owner | Editor | Viewer |
|---|---|---|---|
| See agents and executions (`platform.agents.read`) | yes | yes | no |
| Start a manual run, cancel, retry (`platform.agents.run`) | yes | yes, if editor in every module of the agent | no |
| Create, edit the draft, duplicate, activate, pause, resume, disable (`platform.agents.manage`) | yes | no | no |

Reading an agent or an execution also needs read access to every module the agent names, because results can contain module data.

## Definitions: draft and active

- An agent holds an **active** configuration (what runs) and a **draft** (the working copy). Edits change only the draft, so an active agent keeps running unchanged while it is edited.
- **Activation** is owner-only and bound to the draft shown: the request carries the agent's `version` and the draft's `configHash`.
  - The activating owner becomes the sponsor, and the activation version counts up.
  - Every work order records the activation version and hash.
- Saving and activation check the configuration against what exists and what the member may grant:
  - grantable tools in the named modules;
  - template guard rules;
  - declared event types;
  - named delegates in the project;
  - a verified model;
  - entitlements.
- At activation, the month ceilings of all active agents together must fit the monthly limit of the project's AI spending authority (`AGENT_BUDGET_EXCEEDS_PROJECT`).

## Tools agents can use

A tool reaches agents only through an explicit, reviewed opt-in: `exposure.agent` with an object output schema and a builder catalogue entry (English and German title and summary). Operation tools set `agent: {title, summary}` in `readOperation`/`approvedOperation`.

Phase 1 exposes:
- **Reads:** Work (initiatives, task search, task, progress), Issues (search, issue, figures, duplicates), Knowledge (sources, verified facts) and Marketing (campaigns, content drafts, performance).
- **Internal proposals:** propose a task comment, propose tasks, propose an issue report, propose a fact.

Modes:
- `read`: read tools only.
- `draft`: reads and proposals.
- `execute`: also internal writes (W0).

Proposals become ActionRequests that name the agent (`requestedBy.kind = "agent"` with `agentId`, `agentVersion`, `workOrderId` and the requester). This attribution is made centrally, whatever requester a tool itself passes.

## Approvals and mandates

- A person decides every proposal, unless an owner granted an agent mandate (ADR 0019) whose **agents channel names this agent**.
- A mandate covers the agent only while it is active at the version the request was made with, and only while `ORBIT_AGENT_PLATFORM` is on.
- External effects (customer replies, publishing, deletion, money, governance) are never mandatable.
- When the decision is made, the sponsor's **and** the requester's current rights are checked again.

## Work orders

| Origin | Started by | Idempotency |
|---|---|---|
| `manual` | An owner or editor (the click is the start confirmation, D-06) | `agent:<id>:manual:<requestId>` |
| `schedule` | Daily, weekly or interval slots in the project's timezone; slots older than 2 hours are skipped, not caught up | `agent:<id>:slot:<iso>` |
| `event` | A module-declared triggerable event matching the trigger's filter; events caused by agents never start agents | `agent:<id>:evt:<eventId>`, plus one open work order per agent and subject |

Each work order is one bounded turn on the task host:
- at most 8 model calls and 16 tool calls;
- a wall-time limit;
- the run ceiling and the agent's month ceiling, checked before every reservation;
- the project's spending authority and budgets, enforced by `reserve` as for every paid call.

Spend is attributed to the agent (`BudgetReservation.agentId`). Reaching the month ceiling sets the agent to `budget_exhausted`.

The history keeps:
- origin, on whose behalf, and the frozen allowlist;
- the step log: tool, risk and outcome code, never arguments or results;
- cost, the redacted result summary, the ActionRequests the work order created, and the error code.

Recovery:
- A crash before any paid call starts the work order over.
- A crash after a call was sent ends it as `outcome_unknown`; nothing is sent again.
- A failed work order sends the sponsor one in-app notice per agent, error code and UTC day. No model is called.

## Delegation limits (D-07)

Depth at most 2, at most 10 children per work order, at most 3 running work orders per project (configurable), no cycles, named targets only, and each child stays within the parent's tools, modules, mode, knowledge and remaining ceiling. The rules are in `platform/agents/work-orders/delegation.ts`. Phase 3 connects them to the personal assistant.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `ORBIT_AGENT_PLATFORM` | `false` | Routes, builder, manual runs, execution. Off: every agent route answers 404, queued work orders end `blocked AGENT_PLATFORM_DISABLED`. |
| `ORBIT_AGENT_AUTOMATION` | `false` | Schedule and event triggers. Off: no work order is started by a trigger. |
| `AGENT_WORK_CONCURRENCY` | `2` | Parallel agent work orders per worker process. |
| `AGENT_WORK_PROJECT_CONCURRENCY` | `3` | Running work orders per project. |

Entitlements (`platform/entitlements/`) return "unlimited" by default. A SaaS plan resolver can later limit agents, automation, trigger kinds, modules and models without code changes at the enforcement points.

## API

All routes are under `/api/projects/:projectId`:
- `GET` and `POST /agents`;
- `GET /agents/catalog`, `GET /agents/templates`;
- `GET` and `PATCH /agents/:id`;
- `POST /agents/:id/{duplicate,activate,pause,resume,disable}`;
- `GET /agents/:id/versions[/:version]`;
- `POST /agents/:id/runs`;
- `GET /agent-work-orders[/:id]`;
- `POST /agent-work-orders/:id/{cancel,retry}`.

The organization overview uses `GET /api/agents/summary`: per-project counts only, never another project's content.

## Retention

- Finished work-order trees are purged 90 days after they finish; `AgentRun`/`AgentSpan` rows after 180 days. A shorter project retention period purges earlier.
- Both run through the existing owner retention action. No periodic purge was added, because it would delete existing production telemetry without an owner action.

## Rollout runbook

1. The migration `202611040001_agent_platform` is additive. Approve its schema hash in Coolify **before** the `main` push that deploys it (`docs/deployment/COOLIFY.md`). The hash computed locally for this branch was `5c88c46ed8281657c7805ef0ac301805f1bab2fc8e70bbfee7784b83d23df05e`; recompute it with `sh scripts/check-pve-schema.sh --print-hash` after rebasing onto the current `main`.
2. Deploy with both flags off. Nothing changes for users.
3. Switch `ORBIT_AGENT_PLATFORM` on, still in a test project only. A first real run costs money and needs Mario's approval (at most USD 0.50).
4. Switch `ORBIT_AGENT_AUTOMATION` on later, separately.

Rollback: switch the flags off. Routes answer 404, triggers stop, and stored definitions and work orders stay inert. The table and column stay.

# Agent platform, Phase 1: general agent framework and agent builder

Status: **proposed plan, documentation only** (2026-11-04). Overview, terms, security model and decisions: [agent-platform-architecture.md](agent-platform-architecture.md). Decisions referenced as **D-nn** are listed there in §14. Work package numbers are **WP1.n**.

## 0. Goal and scope

**Goal.** A reusable agent framework, independent of Marketing, on the existing runtime, tools, approvals, budgets and worker. Owners create versioned agents in a global agent management area. Agents run manually, on a schedule or on module events, inside explicit, re-checked permissions.

**In scope**
- Consolidation of the duplicated call paths and tool filters.
- An agent principal.
- Agent definitions and the builder.
- Work orders.
- Triggers.
- Agent budgets.
- An entitlements port.
- Retention.
- Marketing convergence on shared primitives.

**Out of scope**
- The Support template and Support events (Phase 2).
- The personal space and the assistant's delegation tools (Phase 3).
- Digests and voice (Phase 4).
- Organization-level agents (D-04).
- A generic DAG engine (D-14).

Classification (AGENTS.md):
- **Risk: high.** Authorization, multi-tenant data access, background jobs with side effects, paid provider calls.
- **Environment:** local and preview until each production step is approved.
- **App profiles:** primary `.agentic/app-profiles/ai-agent-app.md`, with `fullstack-saas.md` (roles, tenants, plans) and `backend-api.md`.
- **Workflows:** `.agentic/workflows/feature.md`, `refactor.md` (WP1.1–WP1.3) and `migration.md` (WP1.4).

---

## 1. Starting point (facts that shape this phase)

Paths and line numbers are from the analysis of `cc8a14cf`; see architecture §2.

| Fact | Consequence for Phase 1 |
|---|---|
| One loop (`platform/agents/runtime/port.ts`, `legacy-responses.ts`), but four budgeted call paths: `chat-runner.ts`, `structured-run.ts`, Marketing `modules/marketing/agents/specialists/runner.ts`, Support `modules/support/ai.ts` | Consolidate before adding a fifth (WP1.1, WP1.3) |
| `runStructured` allows only `R0_read` tools and checks permission once before the run | Extend with principal-checked W0/P tools and per-call checks (WP1.3) |
| Tool filter logic duplicated in `chat-runner.ts` and `mcp/visibility.ts`; native MCP tools outside the registry | One capability layer (WP1.1); native tools move in Phase 3 |
| `ToolFeature`, `ToolNamespace`, `RunKind` (+ database CHECK), `TaskClass` and `ChatCard` are closed unions, partly naming Marketing concepts | Open them through registration (WP1.2, WP1.3) |
| Marketing specialists run as `{userId: "worker", role: "owner"}` without execution-time checks | On-behalf principal (WP1.9) |
| ActionRequest `requestedBy` knows `user`, `agent` (userId + agentRunId), `mcp`; mandates cover `assistant`/`mcp` channels only | Agent fields and an agents channel (WP1.2) |
| Work orders (`orbit_tasks`) are single chat turns in user-private conversations; no depth counter | New `AgentWorkOrder` table with delegation fields (WP1.4, WP1.6) |
| No cron; due marker `Project.workDueAt` and `SchedulerContribution.nextDueAt` | Schedule triggers as a platform scheduler contribution (WP1.7) |
| Domain events exist with per-subscriber idempotent jobs, depth ≤ 5 | Event triggers as a platform subscriber (WP1.7) |
| No retention for `AgentRun`/`AgentSpan` | Retention task (WP1.4) |
| No entitlements | Port with an "unlimited" default (WP1.4) |
| `apps/api/src/modules/agents/` holds Marketing re-export shims and is classified as Marketing | New code goes to `apps/api/src/platform/agents/` only |

---

## 2. Target design of this phase

### 2.1 Components

```text
apps/api/src/platform/agents/
  runtime/                    (exists) port, legacy adapter, contract tests
  structured-run.ts           (exists) task host, extended in WP1.3
  tools/registry.ts           (exists) OrbitTool, extended in WP1.2
  capabilities.ts             NEW  resolveCapabilities, executeCapability, quotas
  principal.ts                NEW  principal type, build/rebuild, intersection, narrowing
  definitions/
    schema.ts                 NEW  zod schema of agent_definitions
    service.ts                NEW  create, update, duplicate, activate, pause, resume, disable
    catalog.ts                NEW  grantable tools/modules/knowledge/models for the current user
    templates.ts              NEW  template registry (module contributions)
  work-orders/
    service.ts                NEW  create, claim, finish, cancel, retry, read models
    execute.ts                NEW  worker handler: principal → task host → result
    delegation.ts             NEW  parent/root/depth, fan-out, cycle check
    retention.ts              NEW  work orders, AgentRun/AgentSpan purge
  triggers/
    schedule.ts               NEW  scheduler contribution (nextDueAt, sweep)
    events.ts                 NEW  generic subscriber for triggerable events
  budget.ts                   NEW  agent month/run checks for budget.check
  routes.ts                   NEW  HTTP routes (registered as platform contributions)
apps/api/src/platform/entitlements/
  entitlements.ts             NEW  port + default resolver
apps/web/src/platform/agents/ NEW  overview, builder, versions, executions
```

### 2.2 Agent definition ([Proposal], entity kind `agent_definitions`, no migration)

```ts
// platform/agents/definitions/schema.ts (sketch)
const AgentConfig = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500),
  templateKey: z.string().regex(/^[a-z]+\.[a-z_]+$/).nullable(),   // e.g. "support.ticket_agent"
  instructions: z.string().max(6000),                               // user part only
  modules: z.array(ModuleId).min(1).max(5),
  tools: z.array(ToolName).min(1).max(24),                          // registry names with exposure.agent
  knowledge: z.object({ sourceIds: z.array(z.uuid()).max(50).optional(),
                        audiences: z.array(SourceAudience).optional() })  // existing source audiences (WP3.5)
             .nullable(),
  mode: z.enum(["read", "draft", "execute"]),                       // MCP 2.0 vocabulary
  model: z.object({ override: ModelId.nullable() }),                // task class agent_custom
  limits: z.object({ maxModelCalls: z.int().min(1).max(8), maxToolCalls: z.int().min(0).max(16),
                     wallSeconds: z.int().min(30).max(300), maxRunsPerDay: z.int().min(1).max(500),
                     maxConcurrent: z.int().min(1).max(3) }),
  budget: z.object({ monthlyCeilingMicros: z.bigint().positive(), runCeilingMicros: z.bigint().positive() }),
  triggers: z.array(Trigger).max(5),
  delegateTo: z.array(z.uuid()).max(5),                             // named agents this one may hand to
  outputs: z.object({ notify: z.array(z.enum(["sponsor","agent_managers"])),
                      onFailure: z.enum(["notify","silent"]) }),
});

const AgentDefinition = z.object({
  status: z.enum(["draft", "active", "paused", "disabled", "budget_exhausted"]),
  active: AgentConfig.nullable(),        // what runs; replaced only by activation
  draft: AgentConfig.nullable(),         // working copy; edits never touch `active`
  activation: z.object({ sponsorUserId: z.string(), activatedAt: z.iso.datetime(),
                         version: z.int(), configHash: z.string() }).nullable(),
});
```

**Triggers**

```ts
const Trigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("schedule"), rhythm: z.enum(["daily", "weekly", "interval"]),
             times: z.array(LocalTime).max(4), days: z.array(z.int().min(1).max(7)).optional(),
             everyMinutes: z.int().min(60).max(1440).optional() }),           // project timezone
  z.object({ kind: z.literal("event"), type: TriggerableEventType,           // module-declared
             filter: z.record(z.string(), z.unknown()),                      // validated by the declaration
             debounceSeconds: z.int().min(0).max(3600).default(0) }),
]);
```

**Rules**
- **Validation on both sides.** Save validates against the registry, the catalogue, the template guard rules and entitlements. Run validates again.
- **Draft and active configuration.** The entity holds `active: AgentConfig | null` (what runs) and `draft: AgentConfig | null` (the working copy). Edits change only `draft` and store a new entity version, so an active agent keeps running unchanged while it is edited. Each work order records `agentVersion` and `configHash` of the `active` configuration it ran with.
- **Activation** is owner-only, in the web UI, hash-bound (`{version, configHash}`) and audited (`agent.activated`). The activating owner becomes the **sponsor**.
- **Template guard rules** (for example "never `support_send_reply` outside `draft`", or a required tool) are re-applied on every save and every run. They are not editable.

### 2.3 Principal and authorization ([Proposal], architecture §7.1)

```ts
type Principal = {
  kind: "user" | "assistant" | "mcp" | "agent" | "delegated";
  userId: string;                     // sponsor (agent) or acting user
  requesterUserId?: string;           // manual/assistant/MCP requester of an agent work order
  agentId?: string; agentVersion?: number; workOrderId?: string;
  rootWorkOrderId?: string; depth: number;
  allow: { tools: ReadonlySet<string>; modules: ReadonlySet<string>;
           mode: "read" | "draft" | "execute"; knowledge: KnowledgeRestriction | null };
  ceilingMicros: bigint;
  mcp?: { clientId: string; grantId: string };
};
```

**What every call checks.** `executeCapability(principal, projectScope, tool, rawArgs)` rebuilds the human scopes with `actorScope` for the sponsor and the requester, then checks:
- module enabled;
- entitlement;
- module role ∩ tool permission for **each** human;
- mode against risk;
- the agent's status and version.

It then validates the arguments with the tool's zod schema on the host, runs the tool inside `moduleScope`, validates the output against `outputSchema` where present, and caps the output JSON-safely.

**Compatibility with today's mechanisms**
- `ToolContext.channel`, `ToolContext.agentTask` and the `delegatedExecution` AsyncLocalStorage are derived from the principal, so existing tools keep working unchanged.
- `delegation.ts` becomes a principal builder for `kind: "delegated"`.

### 2.4 Work order ([Proposal], new table, additive migration)

```prisma
model AgentWorkOrder {
  id                   String    @id @default(uuid()) @db.Uuid
  workspaceId          String    @db.Uuid
  projectId            String    @db.Uuid
  target               String    // 'agent' (Phase 1) | 'assistant' (Phase 3)
  agentId              String?   @db.Uuid
  agentVersion         Int?
  configHash           String?
  origin               String    // 'manual' | 'schedule' | 'event' | 'assistant' | 'agent' | 'mcp'
  originRef            String?   // event id, slot ISO time, parent id
  subjectType          String?
  subjectId            String?
  idempotencyKey       String
  requestedBy          Json      // {kind, userId, clientId?, grantId?}
  sponsorUserId        String?
  allow                Json      // frozen allowlist snapshot
  parentId             String?   @db.Uuid
  rootId               String?   @db.Uuid
  depth                Int       @default(0)
  goal                 String    // bounded, redacted input text (≤ 2,000 chars)
  input                Json      @default("{}")
  status               String    // queued | awaiting_start | running | waiting_approval | succeeded | failed | blocked | canceled | outcome_unknown
  errorCode            String?
  ceilingMicros        BigInt
  spentMicros          BigInt    @default(0)
  costUnknown          Boolean   @default(false)
  startRequestId       String?   @db.Uuid   // ActionRequest when a start needs confirmation
  jobId                String?   @db.Uuid
  conversationId       String?   @db.Uuid   // only target = 'assistant'
  result               Json?     // {outcome, summary, cards[], actionRequestIds[], handoffIds[]} capped 16 KB
  steps                Json      @default("[]") // [{i, tool, risk, outcome, code?, refs?}] capped 64 entries
  createdAt            DateTime  @default(now()) @db.Timestamptz(3)
  startedAt            DateTime? @db.Timestamptz(3)
  finishedAt           DateTime? @db.Timestamptz(3)
  expiresAt            DateTime? @db.Timestamptz(3)
  project              Project   @relation(fields: [workspaceId, projectId], references: [workspaceId, id], onDelete: Cascade)

  @@unique([workspaceId, projectId, id])
  @@unique([projectId, idempotencyKey])
  @@index([projectId, agentId, createdAt])
  @@index([projectId, status, createdAt])
  @@index([projectId, subjectType, subjectId])
  @@index([projectId, rootId])
}
```

**Migration constraints**
- CHECK constraints on `target`, `origin`, `status` and `depth BETWEEN 0 AND 2`.
- FORCE RLS with the foundation `project_scope` policy and grants for `orbit_app`.
- Composite foreign keys to `Project`, as in Support and Work.
- `parentId`/`rootId` as composite self-references, or validated in code (decided in WP1.4 after checking the Work tables' convention).

**Read access** for the history needs both `platform.agents.read` and read permission in **every** module of the frozen allowlist, because results can contain module data.

**Step log.** The log holds tool names, risk, outcome codes and record references only, never tool arguments or results (ADR 0006). The final `result.summary` is the agent's own output, capped and passed through `redact()`.

### 2.5 Execution path

```mermaid
sequenceDiagram
  participant Src as Trigger (manual/schedule/event)
  participant WO as work-orders/service
  participant Q as Outbox + BullMQ (agent_work)
  participant X as work-orders/execute
  participant H as runStructured (principal mode)
  participant C as capabilities
  Src->>WO: createWorkOrder(idempotencyKey, origin, subject, requester?)
  WO->>WO: definition active? entitlements? daily cap? concurrency? subject dedupe? budget headroom?
  WO->>Q: enqueue(tx, scope, "agent_work", id, key)
  Q->>X: claim (lease 360 s); re-read the definition version → mismatch = blocked AGENT_VERSION_CHANGED
  X->>X: build principal (actorScope sponsor ∩ requester ∩ allowlist)
  X->>H: instructions (base + template guard + user), input, tools, limits, budget.check, runKey agent-work-order:<id>
  loop model ≤ maxModelCalls, tools ≤ maxToolCalls
    H->>C: executeCapability (per call)
  end
  H-->>X: output {outcome, summary} | error code
  X->>WO: finish: status, cost, steps, result; publish platform.agent.work_order.finished|failed
```

**Rules**
- **Single turn.** One work order is one bounded task-host turn: no resume inside a turn. A crash after transmission gives `outcome_unknown`, with no second paid request. A crash before transmission restarts from scratch.
- **Output contract.** The base schema is `{outcome: "done" | "needs_human" | "nothing_to_do", summary ≤ 1,500 chars, details?}`. Templates may extend it.
- **Continuation after approval** ([Proposal]). When an ActionRequest created by a work order is decided, the new event `platform.action_request.decided` lets the work order start **one** continuation turn (`origin: agent`, same root, depth unchanged, `maxContinuations: 2`). That turn receives the decision outcome as input. This implements ADR 0008 §6 without in-turn state. It is off unless the template or definition enables it.
- **Cancellation.** The cancel route sets `canceled`; the host polls cooperatively as the chat runner does, and the result is `CHAT_CANCELED` semantics with cost settled or unknown.

### 2.6 Budget

**Before each reservation.** `budget.check` (the existing hook of `runStructured`) enforces:
- the run ceiling: work order spent + estimate ≤ `runCeilingMicros`, and ≤ the parent's remaining ceiling for children;
- the month ceiling: the agent's attributed month spend + estimate ≤ `monthlyCeilingMicros`. Exceeding it sets the definition to `budget_exhausted` (`AGENT_BUDGET_EXHAUSTED`) and notifies the sponsor.

**`reserve` stays the authority** for the spend authority, the project day/month/run limits, provider, grant, connection and org budgets.

**Attribution** ([Proposal], decided in WP1.4). Option a: a nullable, indexed `BudgetReservation.agentId` column, additive. Option b: a counter row keyed `agent:<id>:<yyyy-mm>`. The reason is that `reserve` already sums a whole month per call (architecture R-04); an attributed index keeps the agent check cheap.

**Activation check.** At activation, the sum of active agents' month ceilings must not exceed the project spend authority's monthly limit (`AGENT_BUDGET_EXCEEDS_PROJECT`). Module budgets such as Marketing assignments and Support's daily cap still apply inside their own code paths.

### 2.7 Triggers

| Kind | Mechanism | Idempotency | Guards |
|---|---|---|---|
| Manual | Route `POST …/agents/:id/runs`; later the assistant's `agent_delegate` | Client `requestId` | `platform.agents.run`; requester ∩ sponsor |
| Schedule | Platform `SchedulerContribution`: `nextDueAt` = earliest slot of active scheduled definitions in the project's timezone (`platform/time/zoned-time.ts`); `sweep` creates due work orders | `agent:<id>:slot:<iso>` | `ORBIT_AGENT_AUTOMATION`, entitlement `agents.automation`; slots older than 2 h are skipped, not caught up |
| Event | Modules declare triggerable events: `EventsContribution` gains `triggers: {[type]: {title, subject, filter: zod, sensitive?}}`. A platform subscriber with the pattern of each declared type matches active definitions | `agent:<id>:evt:<eventId>`; plus one open work order per (agent, subject) | Same flag and entitlement; ignore events whose actor is an agent; `debounceSeconds` coalesces bursts per subject; `maxRunsPerDay` |

`publishEvent` already rejects undeclared types and limits depth to 5. The trigger subscriber reads only the event's content-free data and loads the subject through tools later, under the principal.

### 2.8 Registry and catalogue additions

`OrbitTool` gains the following fields, all optional so existing tools are unchanged:
- `exposure.agent?: boolean` (default false);
- `catalog?: {title, summary, dataClass?: "internal" | "customer_personal" | "financial", cost?: "none" | "paid"}` (`title` and `summary` in English and German);
- `scopeShape?: "project" | "user" | "workspace"` (default `project`);
- `delegable?: boolean`;
- `idempotent?: "by_call"` (W0 tools receive `idempotencyKey = workOrderId:callIndex`).

**Rule.** `defineTool` refuses `exposure.agent` without `outputSchema` and `catalog`.

**Catalogue.** `GET …/agents/catalog` lists, for the **current user**, the tools they may grant: intersected with their module roles, module activation, entitlements and template guard rules. Each tool comes with its risk, cost, mandatable and data-class badges. Knowledge sources, models (`AiModelPrice.active` ∩ project verified models) and triggerable events are listed the same way.

**Open unions**
- `ToolFeature` and `ToolNamespace` become module-registered strings with uniqueness checks.
- The task class `agent_custom` is added in `packages/ai/src/routing.ts`: the task-class list, the strict route schema, default output tokens and the legacy tier, plus a route section in the AI settings UI.
- The run kind `agent_work` is added to `RunKind` and the database CHECK.
- `ChatCard` stays closed in Phase 1. Agent results use the generic `status` card. A card registry is a Phase 3 item (T-2).

### 2.9 Entitlements port

```ts
// platform/entitlements/entitlements.ts
export type Entitlements = {
  agentsMax: number | null;            // null = unlimited
  agentsAutomation: boolean;
  agentTriggerKinds: ReadonlySet<"manual" | "schedule" | "event">;
  modulesAllowed: ReadonlySet<string> | null;
  modelsAllowed: ReadonlySet<string> | null;
  assistantPersonal: boolean;
  assistantVoice: boolean;
  integrationsAdvanced: boolean;
};
export async function entitlementsFor(workspaceId: string): Promise<Entitlements>; // default: unlimited
```

Phase 1 enforcement points:
- agent create/duplicate: count over the org's projects with `platform.agents.read`-free internal counting;
- activation: trigger kinds and automation;
- catalogue: modules and models;
- run claim: automation still allowed.

No table is added in Phase 1 (D-12).

---

## 3. Work packages

### WP1.0 ADR 0021 and decision record (docs)

- Write `docs/adr/0021-agent-platform.md`. It records:
  - V2 as the chosen variant;
  - the principal model;
  - work orders;
  - the mandate extension (as an addendum plan for ADR 0019);
  - the supersession of `docs/plans/marketing-agent-v2.md` §1 ("no other agent framework").
- Record Mario's answers to D-01 to D-07 and D-12 to D-14.
- **Effort:** 0.5 day. **PR:** docs only.

### WP1.1 Capability layer: behaviour-preserving extraction

- **New** `platform/agents/capabilities.ts`:
  - `resolveCapabilities(principal, scope, {features, enabledModules})`;
  - `executeCapability(principal, scope, tool, rawArgs, ctx)`, with host-side zod validation, JSON-safe output cap and `checkToolResult`.
- **Changed**:
  - `platform/assistant/chat-runner.ts`: the filter (≈480–523) and execution (≈198–247);
  - `platform/mcp/visibility.ts`, which now calls the shared resolver for role, module and feature;
  - `platform/mcp/adapter.ts`, whose execute goes through `executeCapability` (it keeps the MCP-only scope and quota parts);
  - `platform/agents/structured-run.ts`, whose tool execution goes through `executeCapability`.
- **Behaviour.** Identical offered tool sets and error codes.
  - Host-side validation turns today's tool-internal validation errors into the same codes; verified per tool family by tests.
  - The output cap changes from a 12,000-character slice to a JSON-safe cap of the same size. This is a recorded deviation: no tool relies on cut JSON, verified by grep and tests.
- **Tests:**
  - an equivalence test comparing old and new filters over a fixture matrix (roles, module roles, features, delegation modes) before the old code is deleted;
  - the existing chat-runner, MCP gateway, delegated work order (`mcp-2-workflows`), structured-run (Work PM, Issues triage) and access-matrix suites;
  - a mutation check on the per-call re-authorization.
- **Effort:** 2–3 days. **PR:** 1, no flag, no migration.

### WP1.2 Principal, registry extensions, ActionRequest and mandate extension

- **New** `platform/agents/principal.ts`. `ToolContext` gains `principal`, and the existing `channel`/`agentTask` are derived from it. `platform/tasks/delegation.ts` builds a `delegated` principal.
- **`OrbitTool` gains** `exposure.agent`, `catalog`, `scopeShape`, `delegable` and `idempotent` (§2.8). `defineTool` rules and tests are updated.
- **Open unions.** `ToolFeature` and `ToolNamespace` become registered strings; `contributions.ts` validates uniqueness.
- **`requestedBy`.** The agent kind of `platform/governance/action-requests.ts` gains `agentId`, `agentVersion`, `workOrderId` and `requesterUserId` (all additive JSON). `approvedOperation`'s `onApproved` re-check covers the sponsor and the requester.
- **Mandates** (behind `ORBIT_AGENT_MANDATES` plus `ORBIT_AGENT_PLATFORM`):
  - `agent_mandates` input gains `channels.agents: boolean` and `agentIds: uuid[] ≤ 10`;
  - `resolveAuthorization` covers `requestedBy.kind = "agent"` only when the agent is named, the agent's status is active, its version equals the version on the request, and the grantor is still an owner;
  - delegated MCP tasks stay uncovered;
  - the ADR 0019 addendum is written in WP1.0.
- **MCP proposal quotas** move from `platform/mcp/adapter.ts` into the capability layer, so delegated and agent proposals count. The counters stay in-process for now; Redis before a second replica (architecture R-13).
- **Tests:**
  - a principal intersection truth table;
  - mandate coverage for agents (named or not named, version changed, grantor demoted);
  - `DELEGATED_TASK_NOT_COVERED` unchanged;
  - quotas for delegated proposals;
  - the existing `agent-mandates.integration.test.ts`.
- **Effort:** 2–3 days. **PR:** 1, no migration.

### WP1.3 Task host consolidation

- **`runStructured` gains:**
  - `tools: {mode: "read_only" | "principal"}`: `principal` permits W0/P through `executeCapability`;
  - `hostedTools` (web search with its own fee estimate);
  - `prepareInput`, `refresh` and `finalize` hooks;
  - `signal` for cancellation;
  - `onStep` for the work-order step log;
  - a normalized `sources` set;
  - a throwing adapter for existing callers.
- **Marketing.** `modules/marketing/agents/specialists/runner.ts`'s `runSpecialist` delegates to `runStructured`. The mapping:
  - `assertTaskBudget` → `budget.check`;
  - task status, pause, plan and backlog checks → `guard`;
  - `runKey = assignment-run:<runId>`;
  - `callKey = agent:<taskId>[:review1]`, which **keeps the reservation key prefixes used by crash recovery**.

  Watch the parse change (strict versus fence-tolerant JSON) and the research `finalize` source normalization.
- **Routing.** Add the task class `agent_custom` (`packages/ai/src/routing.ts`, four places) and the AI settings route section.
- **Run kind.** Add `agent_work` to `RunKind` (`platform/ai/telemetry.ts`). The database CHECK is widened in the WP1.4 migration.
- **Tests:**
  - the full Marketing agent suites (assignment runs, crash recovery, R75 run pool, review rounds, visual recovery);
  - the structured-run users;
  - new tests for principal mode (W0 executes only in `execute`, P creates a request with `requestedBy.kind = "agent"`).
- **Effort:** 2–3 days. **PR:** 1, no flag; Marketing behaviour unchanged.

### WP1.4 Data, entitlements and retention

- **Entity kind** `agent_definitions` in `platform/modules/platform-declaration.ts`: exported, retained while the project exists. Schema and service in `definitions/`.
- **Migration** `2026MMDD0001_agent_platform` (additive):
  - the `AgentWorkOrder` table (§2.4) with RLS, grants and indexes;
  - `AgentRun_kind_check` widened with `agent_work`;
  - agent spend attribution (option a or b, §2.6).
- **Entitlements port** (§2.9).
- **Retention** (`work-orders/retention.ts`, registered as a platform retention contribution):
  - work orders: default 90 days after finish, configurable per project in `ProjectModule` platform settings;
  - `AgentRun`/`AgentSpan`: default 180 days, which closes a pre-existing gap;
  - erasure: a work order whose subject is erased is deleted by the owning module's erasure event (Phase 2 subscribes Support).
- **Safety nets:**
  - new rows in `apps/api/tests/rls-matrix.integration.test.ts` for `AgentWorkOrder` (cross-project and cross-workspace probes);
  - `apps/worker/tests/queue-dispatch.integration.test.ts` for the new queue class.
- **Tests:** migration up on a fresh worktree database (`node scripts/test-db-for-worktree.ts`), RLS probes, retention by date, the entitlement default.
- **Effort:** 2–3 days. **PR:** 1. **Schema hash approval in Coolify required before the `main` push.**

### WP1.5 Permissions and API

- **Permission keys** (`platform/tenancy/permissions.ts`; D-03):
  - `platform.agents.read`: owner, editor;
  - `platform.agents.manage`: owner (create, edit, duplicate, activate, pause, resume, disable);
  - `platform.agents.run`: owner, editor; manual runs and cancel.

  The module role check applies on top, for each module of the agent.
- **Routes** (base `/api/projects/:projectId`; all behind `ORBIT_AGENT_PLATFORM`, 404 when off):
  - `GET /agents` and `POST /agents`;
  - `GET /agents/:id`, `PATCH /agents/:id` (edits the draft only), `POST /agents/:id/duplicate`;
  - `POST /agents/:id/activate` with `{version, configHash}` (owner, web session only);
  - `POST /agents/:id/pause`, `/resume`, `/disable`;
  - `GET /agents/:id/versions` and `GET /agents/:id/versions/:v`;
  - `GET /agents/catalog` and `GET /agents/templates`;
  - `POST /agents/:id/runs` with `{goal?, subject?, requestId}`;
  - `GET /agent-work-orders?agentId&status&cursor` and `GET /agent-work-orders/:id`;
  - `POST /agent-work-orders/:id/cancel` and `POST /agent-work-orders/:id/retry` (creates a new linked work order).
- **Cross-project overview.** `GET /api/agents/summary` uses one scoped transaction per accessible project, following `GET /api/action-requests/summary`. It returns per-project counts (active, paused, failing in the last 24 h) and never cross-project content.
- **Artifacts.** Run `pnpm api:generate` and review the OpenAPI diff. Add access-matrix rows for every route: viewer 403, editor read/run only, owner all, outsider 404.
- **Effort:** 1–2 days. **PR:** together with WP1.6.

### WP1.6 Work-order execution and delegation core

- **Platform `JobDef`** `agent_work`:
  - lease 360 s;
  - concurrency from the new config `AGENT_WORK_CONCURRENCY` (default 2);
  - `onLeaseExpired` → `outcome_unknown` if a reservation was transmitted, else a retry;
  - `onBlockedByPause` → `blocked PROJECT_PAUSED`.
- **Claim checks** (in the claim transaction):
  - definition status and version;
  - entitlements;
  - per-agent `maxConcurrent`;
  - per-project concurrency (default 3, config `AGENT_WORK_PROJECT_CONCURRENCY`);
  - `maxRunsPerDay`.
- **Execute.** Build the principal → task host with the base instructions, template guard and user instructions → finish.
- **Domain events:** `platform.agent.work_order.finished` and `platform.agent.work_order.failed` (content-free: ids, outcome, code, cost bucket), and `platform.action_request.decided` (for continuations, Phase 2+).
- **Delegation core** (`work-orders/delegation.ts`). `createChildWorkOrders(parent, targets[])` enforces:
  - monotonic narrowing;
  - depth ≤ 2;
  - no cycles;
  - fan-out ≤ 10;
  - `delegateTo` naming;
  - the child ceiling ≤ the parent's remaining ceiling;
  - no rights transfer between sponsors.

  It is used by the Phase 3 assistant tool and by agents with `delegateTo`.
- **Failure notice (minimal).** `notifyMembers` kind `agent_work_failed` for the sponsor, at most one per (agent, error code, UTC day), guarded by an idempotent job key. Phase 4 replaces this with notification dedupe keys.
- **Tests:**
  - **scenario D**: the sponsor is demoted between tool calls, giving `AGENT_PRINCIPAL_FORBIDDEN`, nothing executed and the pending request failing at decision;
  - an agent paused mid-run;
  - an edited version mid-run;
  - budget exhaustion;
  - a worker restart: lease expiry with a transmitted call gives `outcome_unknown` and no second call (provider spy); without transmission, a restart;
  - a lost Redis job re-dispatched;
  - cancel;
  - delegation limits (depth 3 refused, a cycle refused, fan-out 11 refused);
  - the failure notice once per day;
  - **scenario E** (Phase 1 part): no model call on failure handling (provider spy).
- **Effort:** 3–4 days. **PR:** 1 (with WP1.5), flag `ORBIT_AGENT_PLATFORM`.

### WP1.7 Triggers

- **Schedule:** `triggers/schedule.ts` as a platform `SchedulerContribution`, using `nextDueAt` and `sweep` with zoned time. Daylight-saving transitions are tested; there is no catch-up beyond 2 h.
- **Event triggers:**
  - `EventsContribution.triggers` declarations, validated at registration;
  - the generic platform subscriber `triggers/events.ts`;
  - filter matching against the declared zod schema;
  - debounce through `availableAt` and the subject key;
  - agent-actor events ignored.
- **Flag** `ORBIT_AGENT_AUTOMATION` (default false) gates both. Manual runs need only `ORBIT_AGENT_PLATFORM`.
- **Test-only trigger.** A synthetic triggerable event (`platform.test.ping`) is declared only when `NODE_ENV=test`, so Phase 1 needs no module to test event triggers. Support's real events come in Phase 2.
- **Tests:**
  - a duplicate event gives one work order;
  - a 50-event burst on one subject gives one work order per debounce window;
  - `maxRunsPerDay`;
  - agent-origin events are ignored;
  - a module disabled stops triggers;
  - the flag is off;
  - schedule slots across DST;
  - a skipped stale slot.
- **Effort:** 2–3 days. **PR:** 1.

### WP1.8 Web: global agent management

- **Routes** (web route registry, `apps/web/src/modules/registry.ts` pattern for platform views):
  - `/p/:projectId/agents`: overview with status, last run, failures in 24 h and month spend versus ceiling;
  - `/p/:projectId/agents/new?template=`;
  - `/p/:projectId/agents/:agentId`, with tabs Overview, Configuration, Versions and Executions;
  - `/p/:projectId/agents/:agentId/executions/:workOrderId`;
  - `/o/:orgId/agents`: cross-project overview through `/api/agents/summary`, linking into projects.
- **Navigation.** A platform entry *Agenten* in the grouped sidebar (UI restructure spec U1), not a module entry. It is hidden when the flag is off or the user lacks `platform.agents.read`. Existing deep links are unchanged.
- **Builder sections** (one page with anchored sections; built from `apps/web/src/platform/ui/form.tsx`, `collection.tsx` and `record-detail.tsx`):
  1. Basics and template.
  2. Instructions, with the template's locked part shown read-only.
  3. Capabilities: modules, then tools with risk, cost, "needs approval", "mandatable" and data-class badges. Only tools the user may grant are selectable; the others are shown disabled with the reason.
  4. Knowledge sources.
  5. Triggers.
  6. Model and limits.
  7. Budget.
  8. Autonomy: mode, with a link to Settings → Agent permissions for mandates.
  9. Review and activate: a version diff against the active version, and the configuration hash.
- **Executions view.**
  - List: filter, status and cost.
  - Detail: origin, principal summary (on behalf of whom), step log, linked ActionRequests (opening the approval renderers), result, readable error texts for every `AGENT_*` code, and a retry button.
- **Duplicate** and **disable** with confirmation (`Modal` from `components/ui/primitives.tsx`).
- **Mobile.** Single column, no horizontal scroll, 16 px gutters.
- **Tests:**
  - component tests (catalogue badges, disabled tools with reasons, diff, error texts);
  - Playwright `agents.spec.ts`: create from a blank template → activate → manual run with a scripted model on the test transport → execution detail. If no server-side model transport exists for e2e, follow the Work PM precedent (component tests plus a documented browser check on a local stack).
- **Accessibility.** `.agentic/quality-gates/accessibility-checklist.md`.
- **Effort:** 3–4 days. **PR:** 1.

### WP1.9 Marketing convergence (shared primitives, no domain change)

- **On-behalf principal.** Specialist tasks run under an `agent` principal on behalf of the assignment's confirming owner (`assignment.confirm` decider), with the specialist's static tool list as the allowlist. This replaces the worker/owner scope in `modules/marketing/agents/specialists/runner.ts`.
  - If that owner lost the owner role, the task ends `blocked AGENT_PRINCIPAL_FORBIDDEN` and the assignment shows an exception.
  - **Behaviour change**, called out in the PR and in Marketing docs.
- **`ModuleContributions.agentListings`.** Marketing lists its assignments (name, status, schedule, month spend versus budget, link). The overview shows them in a "Managed by Marketing" group, read-only.
- **No move of the assignment DAG,** slots, veto, review or executor steps (question 1).
- **Tests:** the Marketing agent suites; a new test for a demoted confirming owner; the overview listing.
- **Effort:** 1.5–2 days. **PR:** 1.

### WP1.10 Documentation and rollout preparation

- **Update** `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md` (new requirement rows), `docs/MODEL_ROUTING.md` (`agent_custom`) and `docs/MODULE_ACTIVATION.md` (agents and module activation).
- **New guide** `docs/AGENT_PLATFORM.md` (user and operator guide; named to avoid confusion with the root `AGENTS.md`).
- **Fix the drift items** of architecture §2.8 that Phase 1 touches: ADR 0005 and 0007 addenda, `ORBIT_CHAT_V1.md` limits, `MCP_2_0.md` call count.
- **Rollout runbook:**
  1. Schema hash approval.
  2. Deploy with the flags off.
  3. `ORBIT_AGENT_PLATFORM` on for one test project.
  4. A manual run with a scripted model is not possible in production; the first real run needs Mario's cost approval (≤ USD 0.50).
  5. `ORBIT_AGENT_AUTOMATION` later.
- **Effort:** 0.5–1 day. **PR:** docs, or with WP1.8.

---

## 4. Database changes (summary)

| Change | Kind | Migration |
|---|---|---|
| `agent_definitions` | entity kind | none |
| `AgentWorkOrder` | new table, FORCE RLS, grants, CHECKs, indexes | additive |
| `AgentRun_kind_check` + `agent_work` | constraint widen | additive |
| Agent spend attribution (`BudgetReservation.agentId` + index, or counter rows) | column or rows | additive |
| `agent_mandates` record fields `channels.agents`, `agentIds` | entity JSON | none |
| ActionRequest `requestedBy` agent fields | entity JSON | none |

All of these are covered by one migration directory, which needs **one Coolify-approved schema hash** (`docs/deployment/COOLIFY.md`, "Current production").

---

## 5. API and UI changes (summary)

- **API:** §3 WP1.5. Every route is new; existing routes are unchanged. Error codes:

  ```text
  AGENT_NOT_FOUND, AGENT_NOT_ACTIVE, AGENT_VERSION_CHANGED, AGENT_CONFIG_INVALID,
  AGENT_TOOL_NOT_GRANTABLE, AGENT_TEMPLATE_RULE, AGENT_PRINCIPAL_FORBIDDEN,
  AGENT_BUDGET_EXHAUSTED, AGENT_BUDGET_EXCEEDS_PROJECT, AGENT_RUN_LIMIT,
  AGENT_CONCURRENCY_LIMIT, AGENT_DELEGATION_DEPTH, AGENT_DELEGATION_CYCLE,
  AGENT_DELEGATION_FANOUT, AGENT_ENTITLEMENT, AGENT_ROUTE_UNAVAILABLE,
  AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA, AGENT_OUTPUT_INVALID (exists),
  AGENT_LIMIT (exists)
  ```

- **UI:** §3 WP1.8. Settings → AI & budget → Agent permissions gains the agent channel and named agents in the mandate form (WP1.2).

---

## 6. Permissions and security (checklist for this phase)

- **Least privilege.** The catalogue offers only tools the granting owner holds. The run intersects with the sponsor's and requester's current rights per call.
- **Inputs.** Arguments are validated on the host with zod; definitions are validated on save and on run.
- **Outputs.** Validated against `outputSchema`, with JSON-safe caps.
- **Approval gating.** W1, W2, D*, F* and G are never auto-approved. Mandates must name the agent.
- **Prompt injection.** Base instructions mark tool data as untrusted. The principal and the mode cannot be changed from text.
- **Data in prompts.** Only what tools return under the principal. Tools with a data class are bound to the provider allow-list (Phase 2 fills it for Support).
- **Telemetry.** Hashes and codes only; no secrets, no payloads.
- **Cost.** Per call (reserve), per run, per agent month, per project, per org.
- **Loops.** At most 8 model and 16 tool calls per turn, depth ≤ 2, fan-out ≤ 10, no event chaining by agents, 2 continuations at most.
- **Tenancy.** `AgentWorkOrder` FORCE RLS, composite foreign keys, cross-project probes return NOT_FOUND.
- **Audit:**

  ```text
  agent.created, agent.updated, agent.activated, agent.paused, agent.resumed,
  agent.disabled, agent.budget_exhausted, agent_work_order.started,
  agent_work_order.finished, agent_work_order.failed
  ```

Before closing the phase, run the quality gates `.agentic/quality-gates/ai-agent-checklist.md`, `security-checklist.md`, `data-safety-checklist.md`, `migration-checklist.md` and `review-checklist.md`.

---

## 7. Worker and scheduler requirements

| Requirement | Detail |
|---|---|
| New queue class | `agent_work`, platform-owned. Lease 360 s, `AGENT_WORK_CONCURRENCY` (default 2), not `runWhilePaused` |
| Claim fairness | Per-project and per-agent concurrency checked in the claim transaction; backpressure as today (>200 waiting defers dispatch) |
| Scheduler | Platform `SchedulerContribution` for schedule triggers; the due marker moves with the earliest slot |
| Events | Generic subscriber; per-subscriber idempotent jobs exist already |
| Recovery | Existing lease expiry and lost-job re-dispatch; `outcome_unknown` for transmitted calls |
| Load | Step logs written at step boundaries, never per token. Measure with the project-lock measurement harness of modularization WP4.3 Part A (`docs/IMPLEMENTATION_STATUS.md`, "Project lock measurement"): 20 concurrent agent work orders in one project while a chat runs |
| Redis namespace | New keys use `QUEUE_NAMESPACE`. The hard-coded `orbit:` keys are noted, not changed in this phase |

---

## 8. Dependencies

- **Before:** decisions D-01 to D-07 and D-12 to D-14.
- **After:**
  - Phase 2 needs WP1.1 to WP1.7. WP1.8 can follow in parallel.
  - Phase 3 needs WP1.1, WP1.2, WP1.4 and WP1.6.
  - Phase 4 needs the WP1.6 events.
- **Parallel work.** WP1.8 (web) and WP1.9 (Marketing) touch disjoint files after WP1.6 and can run in separate worktrees.

---

## 9. Migration and backward compatibility

- **WP1.1 to WP1.3 change no observable behaviour,** with two recorded deviations:
  - JSON-safe output caps;
  - host-side validation codes, kept equal per tool.
- **Marketing.** The specialist call path moves without changing its reservation keys, budgets or results. The on-behalf principal (WP1.9) is the only intended behaviour change: a demoted confirming owner now blocks the specialist.
- **MCP 2.0 work orders** stay on `orbit_tasks` in Phase 1 (folded in during Phase 3, D-05).
- **Flags.** Everything new is behind `ORBIT_AGENT_PLATFORM` and `ORBIT_AGENT_AUTOMATION`, both off by default and passed through Compose (API and worker). `pnpm test:coolify-compose` covers the new variables.
- **Rollback.**
  - Flags off: routes return 404, the scheduler and subscriber do nothing, and work orders stay readable to the database only.
  - The table and constraint stay. Revert PRs for WP1.1 to WP1.3 if a regression appears; they are independent of the schema.

---

## 10. Tests (summary)

| Level | Content |
|---|---|
| Unit | Definition schema; catalogue filter; principal intersection; mode against risk; delegation narrowing, depth, cycle and fan-out; schedule slots (DST); event filter; JSON-safe cap; host-side validation; entitlement default |
| Integration (worktree database) | Definition lifecycle and versions; activation hash; manual run with a scripted model; W0 and P through the capability layer; agent `requestedBy`; mandate agent channel; scenario D; pause and version change mid-run; budget exhaustion; restart and lost job; cancel; triggers (idempotency, burst, agent-origin ignored, disabled module); retention; failure notice once per day; scenario E (no model call) |
| Safety nets | `apps/api/tests/rls-matrix.integration.test.ts` (+`AgentWorkOrder`); `apps/api/tests/access-matrix.integration.test.ts` (+ all new routes; reviewed as a security change); `apps/worker/tests/queue-dispatch.integration.test.ts` (+`agent_work`) |
| Regression | Chat runner, MCP gateway and visibility, `mcp-2-workflows`, structured-run users (Work PM, Issues triage, knowledge evaluation), Marketing agents (assignment runs, crash recovery, R75, review, visual) |
| Web | Builder and executions component tests; `agents.spec.ts`, or a documented browser check |
| Commands | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e` (affected flows), `pnpm api:generate` (review the diff), `pnpm test:coolify-compose`, `node scripts/boundaries.mjs` through `pnpm lint`, `git diff --check` |
| Paid | None. The first live run is a separate approval |

---

## 11. Acceptance criteria

1. An owner creates a blank agent, selects two modules and four tools, writes instructions, restricts knowledge sources, sets a manual and a daily schedule trigger, a model, limits and a budget, and activates it. A later edit changes only the draft; the active configuration keeps running until the owner activates the draft, and the review step shows the diff.
2. An editor sees the agent and its executions, can run it manually, and cannot edit or activate it. A viewer gets 403. A member of another project gets 404.
3. The catalogue never offers a tool the current user does not hold. A forged tool name in a `PATCH` is refused with `AGENT_TOOL_NOT_GRANTABLE`.
4. A manual run executes on the worker, records a work order with origin, principal summary, step log, cost and result, and survives a worker restart as described in §2.5.
5. Permission loss, pause or version change during a run stops all further tool execution (scenario D).
6. A P tool called by an agent creates an ActionRequest that names the agent. It is auto-approved only by a mandate that names the agent. W1 and above are never auto-approved.
7. With `ORBIT_AGENT_AUTOMATION` on, schedule and event triggers create exactly one work order per slot or event and respect the debounce, daily cap and concurrency.
8. A failed work order produces one failure notice per agent, error code and day, without any model call (scenario E, Phase 1 part).
9. Marketing assignments run unchanged, and appear read-only in the overview.
10. Chat, MCP, Work PM and Issues triage pass their existing suites unchanged.
11. `AgentRun`/`AgentSpan` and work orders are purged by retention.
12. Boundaries report 0 violations. The access and RLS matrices include every new route and table.

---

## 12. Risks and open decisions

**Risks**

| # | Risk | Mitigation |
|---|---|---|
| R1-1 | Extraction regressions in the chat runner (architecture R-01) | Equivalence test before deletion; the full suites; split into small commits |
| R1-2 | Marketing budget or recovery parity when `runSpecialist` delegates | Keep the key prefixes; run the R75 and crash-recovery suites; compare reservations in a fixture run before and after |
| R1-3 | Lock contention from agent writes (architecture R-03) | Boundary-only writes; measurement in WP1.6 |
| R1-4 | Builder complexity overwhelms users | Templates first (Phase 2); badges and reasons; Review step with diff |
| R1-5 | Entitlement checks forgotten at a new enforcement point | One helper `requireEntitlement(key)`; a test enumerates the enforcement points |

**Technical decisions inside the phase** (made by the implementer, recorded in the PR)

| # | Decision | Default |
|---|---|---|
| T-1 | Agent spend attribution: column or counter (§2.6) | Column, if `EXPLAIN` on a fixture month shows an index-only sum |
| T-2 | Card registry now or in Phase 3 | Phase 3 |
| T-3 | Self-references on `AgentWorkOrder`: foreign key or code-validated | Follow the Work tables' convention |
| T-4 | Retention defaults | 90 days for work orders, 180 days for `AgentRun`/`AgentSpan` |

**Owner decisions:** D-01 to D-07 and D-12 to D-14 (architecture §14).

---

## 13. Effort and PR split

| PR | Content | Estimate | Flag | Migration |
|---|---|---|---|---|
| 1 | WP1.0 ADR 0021 (+ ADR 0019 addendum draft) | 0.5 d | — | — |
| 2 | WP1.1 capability layer | 2–3 d | — | — |
| 3 | WP1.2 principal, registry, requestedBy, mandate channel, quotas | 2–3 d | `ORBIT_AGENT_MANDATES` (existing) | — |
| 4 | WP1.3 task host consolidation + `runSpecialist` delegation + `agent_custom` | 2–3 d | — | — |
| 5 | WP1.4 schema, entitlements port, retention | 2–3 d | — | **yes** |
| 6 | WP1.5 + WP1.6 routes, permissions, execution, delegation core | 4–6 d | `ORBIT_AGENT_PLATFORM` | — |
| 7 | WP1.7 triggers | 2–3 d | `ORBIT_AGENT_AUTOMATION` | — |
| 8 | WP1.8 web | 3–4 d | `ORBIT_AGENT_PLATFORM` | — |
| 9 | WP1.9 Marketing convergence | 1.5–2 d | — | — |
| 10 | WP1.10 docs and runbook | 0.5–1 d | — | — |
| | **Total** | **20–29 d** | | |

Delivery follows the owner-approved main workflow (AGENTS.md):
- integrate `origin/main` and push fast-forward after the local checks;
- ask before every `main` push;
- PR 5 needs the schema hash first.

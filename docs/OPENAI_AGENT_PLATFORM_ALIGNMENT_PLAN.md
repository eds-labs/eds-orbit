# OpenAI Agent Platform Alignment Plan

**Status:** ACCEPTED by Mario on 2026-09-30 — planning only, nothing implemented\
**Date:** 2026-09-30 (one day after OpenAI DevDay 2026-09-29)\
**Base commit:** `497c83f`\
**Owner decisions:** recorded in §14; each production or paid step still needs its own approval

This plan compares the current Orbit architecture with the OpenAI platform as documented on 2026-09-30 and proposes a staged, non-rewrite migration. It migrates only where a concrete technical or economic benefit exists. It does not authorize production changes, paid calls, new dependencies or schema migrations.

Platform facts were verified against developers.openai.com on 2026-09-30. GPT-6.1 Sol and the Agents API were released one day earlier; pricing and behaviour may still move, so every model and price decision below goes through Orbit's existing verified-model allowlist and dated rate card.

---

## 1. Executive summary

Orbit already owns the hard parts that OpenAI does **not** provide: project-scoped RLS, versioned owner mandates, exact-package approvals, a pre-transmission budget journal, `outcome_unknown` handling, evidence packs, claim checks and verbatim fact placeholders. These are the product's safety core and stay.

What Orbit hand-rolls today and OpenAI (or its SDK) now provides better:

| Area | Today | Target |
| --- | --- | --- |
| Agent loop | 479-line custom Responses loop in `chat-runner.ts` | Agents SDK runner behind an Orbit port, gated by a spike (§5) |
| Tool definitions | Raw JSON, `strict:false`, separate zod validation | One registry: zod → strict schema, namespaces, risk class |
| Structured output | Hand-written JSON schema duplicating zod | `zodTextFormat` / generated strict schema |
| Model routing | Hardcoded 4-tier table, only 3 task names used, escalation unreachable | Task-class routing config with effort, tier and cache settings |
| Cost model | Rate card knows input/output only | Rate card v2: cached, cache-write, reasoning, tool fees, tier discounts |
| Observability | `logger:false`, no trace or per-call records | Postgres trace store + SDK trace processor + structured logs |
| Tool count scaling | 5 tools, all always loaded | Namespaces now; client-executed tool search when the count grows |
| Web research | None (only allowlisted ingestion) | Hosted `web_search` inside a bounded research tool |

Data stance (decision D2, §14): Orbit is currently single-user, so EU residency and zero data retention are not requirements. OpenAI-side storage and tracing are allowed as **secondary** aids; Postgres stays authoritative for architectural reasons (cost/approval joins, rehydration, provider independence), not for privacy reasons.

What Orbit should **not** adopt now: the hosted Agents API as runtime, OpenAI Conversations as state store, `file_search` as RAG replacement, the built-in image tool inside agent loops, hosted Drive connectors, the Responses multi-agent beta, background mode, Agent Builder (shutting down 2026-11-30) and the OpenAI Evals platform (shutting down 2026-11-30).

Recommended architecture: **one Orbit Operator agent plus typed tools and deterministic workflows**, with at most one specialist agent (Research) as an agent-as-tool. Publishing, generation pipelines, analytics import and approvals remain deterministic Orbit code. No agent swarm.

---

## 2. Current-state analysis (Ist-Analyse)

### 2.1 Architecture overview

```
Next.js web (no DB access)
      │ REST + SSE (DB-polled snapshots)
Fastify API ── modular monolith, server.ts 1,942 lines, ~60 string-switched actions
      │ Postgres (FORCE RLS, per-transaction scope, advisory lock per project)
      │ Outbox rows ──(pump every 1.5 s)──► BullMQ (10 queues) ──► Worker (single file)
      │                                                    ├─ generation  (single structured Responses call)
      │                                                    ├─ chat        (custom tool loop, ≤6 model / ≤8 tool calls)
      │                                                    ├─ publishing  (Postiz, preflight at claim + handoff)
      │                                                    ├─ ingestion / embedding / reindex / index_evaluation
      │                                                    └─ analytics / reconciliation / slack_notification
OpenAI (Responses, Embeddings, Images) — store:false, maxRetries:0, reservation before every call
```

### 2.2 Component assessment

| Component | Location | Assessment |
| --- | --- | --- |
| Agent architecture | `chat-runner.ts`, `chat-tools.ts` | One hand-rolled operator loop. Read tools `project_status`, `knowledge_search`, `approved_assets`, `analytics_memory`; one write tool `propose_campaign` (draft proposal only). Solid invariants (reserve → transmit mark → stream → settle, crash = `CHAT_OUTCOME_UNKNOWN`, no resend). Weak: `strict:false`, history re-sent as plain text (last 12 messages, tool calls dropped), cancellation and streaming via DB polling, regex status mapping. |
| OpenAI usage | `packages/ai/src/index.ts` | Single adapter; Responses (structured, streaming), Embeddings, Images. No `reasoning` settings, no prompt caching controls, no `responses.parse`. Usage parsed as input/output only. |
| Model routing | `packages/config/src/index.ts:3-52`, `packages/ai/src/index.ts:115-134`, `openai-configuration.ts` | Table duplicated in two places. Only `draft`/`blog`/`chat` reach `route()`. `plan`/`review`/`conflict`/`classify`/`extract`/`metadata` are dead; `attempt` is always 0, so the Astra escalation is unreachable. Per-project override exists and is owner-only. |
| Workflows / jobs | `workflow.ts`, `apps/worker/src/main.ts`, `lifecycle.ts` | Durable outbox with idempotency keys, leases, bounded retries, `blocked_dependency` + grouped exceptions as dead letter. Robust semantics; implementation scans all projects/jobs every tick and stores job state in JSON entities. |
| Content planning | `editorial.ts`, `planning.ts`, `workflow.ts` | **No LLM planning.** Briefs are local templates, follow-ups are rule-based, "weekly plan" exists only as a chat template. This is a capability gap, not replaceable infrastructure. |
| Content generation | `generation.ts`, `fact-placeholders.ts`, `policy.ts:checkClaims` | Strong: evidence retrieval, generation contract, dependency hash checks before and after the paid call, verbatim `{{fact:id}}` insertion, deterministic claim review, duplicate detection. Accepted live for uLiquid on `5587da6`. |
| Knowledge / RAG | `packages/knowledge`, `retrieval.ts`, `reindex.ts`, `index-evaluation.ts` | Strong and specific: hybrid FTS + pgvector + RRF, bitemporal versions, rights separation, immutable evaluated index generations. Better fit than `file_search` (rights, RLS, evaluation, activation/rollback). |
| Google Drive | `google-drive.ts` | OAuth, project-root confinement, import/upload, brand assets. Mock-tested; no live save/readback yet. |
| Postiz / social | `packages/connectors/src/postiz.ts`, `publisher.ts`, `postiz-draft.ts`, `postiz-verification.ts` | Single publishing gateway for X and Telegram. Draft handoff with image accepted live on 2026-09-29. Live publish implemented but disabled. Group delete intentionally not exposed. |
| Telegram / X | via Postiz only | No native adapters; `telegram` exists only as a notification-preference enum. |
| Matomo | `packages/connectors/src/matomo.ts`, `apps/api/src/modules/matomo.ts` | Read-only, five allowlisted methods, owner import. Deterministic arithmetic analysis. |
| Image generation | `image-generation.ts`, `packages/creative` | GPT Image 2.5 via Images API with per-request owner cost confirmation; deterministic brand composition. Image cost settled as `unknown`. No uLiquid visual accepted yet. |
| Brand / project context | `marketing-profile.ts` | Versioned marketing profile, deterministic `campaignGenerationContext`. Good. |
| Data storage | `schema.prisma` | Proper tables for auth, chat, knowledge, budget, audit, outbox; most domain objects are generic `Entity` JSON with `EntityVersion` history. |
| Chat UI | `apps/web/src/components/chat.tsx` | Deployed; SSE snapshots; escaped Markdown rendering; templates fill the composer only. |
| Orchestration | — | None beyond the chat loop and the mission lifecycle. |
| Worker / scheduler | `apps/worker/src/main.ts` | See jobs row. No BullMQ repeatables; time-based work runs in `sweepProject`. |
| Approval flows | `policy.ts`, `chat.ts:confirmProposal`, `slack.ts`, `workflow.ts` (live-draft-once), `postiz-draft.ts` | Five separate approval flavours with a shared idea (hash-bound, single-use, owner-only) but no shared model. Approvals are `Entity(kind="approvals")` with a hardcoded 24 h TTL (`policy.ts:409`). |
| Observability | `server.ts:197`, `shared.ts:audit` | Append-only audit + entity versions are good. No structured logs, request IDs, metrics, per-call model records, latency or tool-call traces. |
| Cost tracking | `budget.ts`, `BudgetReservation` | Strong reservation journal (daily/monthly/per-run, unknown-cost retention, single-use keys). Missing: cache/reasoning/tool pricing, attribution by agent/campaign/task, reconciliation with OpenAI billing. |

### 2.3 What is already well solved (keep as-is)

1. Tenancy: FORCE RLS, separate DB roles, composite tenant foreign keys.
2. Mandates and approvals: exact package hash, re-validation at intent, claim and handoff; Observe default.
3. Budget journal: reserve-before-transmit, single-use keys, unknown costs retained.
4. Side-effect safety: outbox, idempotency keys, `outcome_unknown`, bounded reconciliation, no blind resend.
5. Evidence and claims: evidence packs, claim ledger, verbatim fact placeholders, deterministic review.
6. Knowledge: evaluated immutable index generations with explicit activation.
7. Connector hygiene: SSRF-safe `boundedFetch`, encrypted credentials, capability flags, sanitized provider errors.

### 2.4 Hand-rolled parts that OpenAI tooling can simplify

1. The chat tool loop bookkeeping (turn limits, tool dispatch, `function_call_output` plumbing).
2. Raw JSON tool and output schemas.
3. Missing tracing (SDK trace processor hooks give spans for free).
4. Missing approval-resume mechanics inside agent runs (SDK `needsApproval` + serializable `RunState`).
5. Tool scaling (tool search with namespaces instead of an ever-growing tool list).

### 2.5 Hand-rolled parts that are unrelated to OpenAI (out of scope, noted)

Outbox full-table scans, JSON job state, regex retry classification, the monolithic `server.ts` router and the single-key AES-GCM helper without rotation are real technical debt, but OpenAI offers nothing that replaces them. New agent tables in this plan use proper indexed tables instead of `Entity` JSON so the debt does not grow.

### 2.6 Documentation drift found

- `docs/IMPLEMENTATION_STATUS.md` still says "no production deployment" while the uLiquid goal log records deployed releases through `5587da6`.
- `docs/MODEL_ROUTING.md` says text uses "no model tools"; the chat path uses function tools.

---

## 3. Gap analysis: Existing Orbit vs. OpenAI Agents SDK / Responses API / Agents API

| Capability | Existing Orbit | OpenAI offering (2026-09-30) | Verdict |
| --- | --- | --- | --- |
| Agent loop | Custom, 6/8 caps | Agents SDK `run()` with `maxTurns`, handoffs, agents-as-tools, guardrails | **Adopt SDK (spike-gated)** |
| Hosted agent runtime | — | Agents API beta: OpenAI-hosted sessions, US residency only, no ZDR, best-effort usage, no scheduling | **Do not adopt now** (beta since 2026-09-29, best-effort usage conflicts with exact budget settlement, no scheduling; residency is no longer a blocker per D2). Re-evaluate after Phase 4. |
| Conversation state | Postgres, `store:false` | Conversations API (kept until deleted, not ZDR-eligible), `previous_response_id` (30 days) | **Keep Postgres as authority**; custom SDK `Session` on Prisma. `store:true` is allowed per D2 as an optional debugging aid, not as state. |
| Human approval in runs | Proposals + separate confirm | SDK `needsApproval`, `RunState` serialize/resume (docs require server-side storage and atomic consume) | **Adopt**, bound to Orbit approval records |
| Tracing | None | SDK tracing; `addTraceProcessor()` / `setTraceProcessors()` | **Adopt with own Postgres processor** plus OpenAI dashboard export as a configurable secondary sink (allowed per D2) |
| Guardrails | Prompt text + deterministic post-checks | SDK input/output/tool guardrails | **Adopt for input/tool**, keep deterministic claim checks as authority |
| Structured output | Hand JSON schema | Strict `json_schema`, zod helpers | **Adopt** |
| Tool scaling | 5 static tools | `tool_search`, `defer_loading`, namespaces, client-executed search (gpt-5.4+) | **Adopt when triggered** (§6.4) |
| Web research | None | Hosted `web_search` ($10 / 1k calls + tokens) | **Adopt in bounded research tool** |
| RAG | Own hybrid RAG with rights and evals | `file_search` + vector stores | **Keep own** |
| Image generation | Images API with confirmation | Built-in `image_generation` tool | **Keep Images API**; no built-in tool in loops |
| Drive | Native OAuth, root-confined | `connector_googledrive` (token handed to OpenAI) | **Keep native** |
| MCP | None | Hosted MCP (OpenAI calls server), SDK local/streamable MCP clients | **Registry MCP-shaped now; MCP later** (§6.3) |
| Computer use | None | GA `computer` tool (GPT-6.1 Sol); Agents API hosted browser | **Last resort only** (§7) |
| Skills | — | `/v1/skills` bundles for shell environments | **Not now**; use versioned Orbit playbooks |
| Prompt caching | Implicit only, never measured | Explicit breakpoints, 30 min TTL, writes 1.25×, reads 0.1× (0.05× on 6.1 Sol) | **Adopt**, measure `cached_tokens` and `cache_write_tokens` |
| Batch / Flex | Not used | 50 % of standard | **Adopt for non-urgent work** |
| Background mode | Worker is already async | `background:true`, not ZDR-compatible | **Not needed** |
| Spend limits | Own journal | Org/project hard spend limits (eventually consistent), Costs API | **Add as outer safety net + reconciliation** |
| Evals | In-repo retrieval evals | Evals platform read-only 2026-10-31, shut down 2026-11-30 | **Keep in-repo; add generation evals** |

---

## 4. Keep / replace / simplify recommendations

### 4.1 Keep (no migration)

Policy engine and preflight, package-hash approvals, budget journal, outbox/worker semantics, RLS/tenancy, knowledge layer and index evaluation, evidence/claim/fact-placeholder pipeline, marketing profile, connectors (Postiz, Drive, Matomo, Slack), deterministic creative rendering, single-shot structured generation for drafts.

Rationale: all of these encode Orbit-specific business rules or safety guarantees. No OpenAI feature covers them, and replacing them would remove verified acceptance evidence.

### 4.2 Replace

| Replace | With | Benefit |
| --- | --- | --- |
| Custom chat loop mechanics | Agents SDK runner behind `AgentRuntime` port | Less loop code, handoffs/agents-as-tools, approval resume, trace hooks, tool search and MCP helpers |
| Raw JSON tool definitions | Tool registry generating strict schemas from zod | One schema source, `strict:true`, fewer malformed calls (the Phase 6 proposal schema failure came from this class of bug) |
| Hand-written output JSON schema in `generate()` | Schema generated from `structuredOutput` zod | Removes duplication |
| Hardcoded `modelRoutes` / `routeTask` | Task-class routing registry (§8) | Configurable, testable, covers new models |

### 4.3 Simplify / extend

| Area | Change |
| --- | --- |
| Rate card | v2 with cached input, cache write, reasoning, long-context multiplier, service-tier factor, tool fees |
| Chat context | Stable cacheable prefix; session summary instead of raw last-12 messages; keep tool results as structured items |
| Streaming relay | Keep DB snapshots as durable truth; optionally add Redis pub/sub for lower latency later (not required) |
| Approvals | One `ActionRequest` model shared by all five flavours (§9) with configurable TTL |
| Status mapping | Replace regex status/retry classification in new code with typed error classes |

---

## 5. Target architecture

### 5.1 Layered view

```
┌──────────────────────────────── Orbit Web (Chat, Approvals Inbox, Agent Runs, Settings) ────────────────────────────────┐
└──────────────────────────────────────────────┬──────────────────────────────────────────────────────────────────────────┘
                                               │ REST / SSE
┌──────────────────────────────────────────────▼──────────────────────────────────────────────────────────────────────────┐
│ Fastify API — authn/z, project scope, business validation                                                               │
│                                                                                                                         │
│  Governance core (KEEP)            Agent layer (NEW, thin)                       Deterministic workflows (KEEP)          │
│  ─ Policy engine / preflight       ─ AgentRuntime port                           ─ Generation pipeline (single call)     │
│  ─ ActionRequest + approvals       │   └─ Agents SDK adapter (spike-gated)       ─ Review / claim checks                 │
│  ─ Budget journal (v2 rate card)   ─ BudgetedModel (reserve→call→settle)         ─ Publisher (Postiz) + reconciliation   │
│  ─ Evidence / claims / placeholders─ Tool registry (namespaces, risk, roles)     ─ Ingestion / reindex / evaluation      │
│  ─ Audit + entity versions         ─ Session store (Prisma) + summaries          ─ Analytics import (Matomo, CSV)        │
│                                    ─ Trace processor → Postgres                  ─ Drive sync, image generation          │
│                                    ─ Model router (task classes)                                                         │
└──────────────────────────────────────────────┬──────────────────────────────────────────────────────────────────────────┘
                                               │ Outbox → BullMQ
┌──────────────────────────────────────────────▼──────────────────────────────────────────────────────────────────────────┐
│ Worker — executes agent runs and workflows; the only place that talks to OpenAI and providers                            │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
        │ Responses API (store:false)          │ Postiz / Drive / Matomo / Slack (native connectors)
        ▼                                      ▼
     OpenAI                               External providers
```

### 5.2 Core principles

1. **Agents propose, Orbit executes.** No model output performs an external write. Tools with side effects create `ActionRequest`s; deterministic executors run them after policy and approval checks, with just-in-time preflight.
2. **Postgres is the only source of truth.** Sessions, run state, summaries and traces live in Orbit's database. Nothing important exists only in model context or on OpenAI's side.
3. **Every model call is budgeted.** The `BudgetedModel` wrapper is the only path to OpenAI inside agent runs; it reserves before transmission and settles from provider usage.
4. **Provider independence at the edge.** The SDK is wrapped behind `AgentRuntime` so a breaking pre-1.0 release (current `@openai/agents` 0.18.0) cannot leak into business modules.
5. **Measure before migrating.** Observability and cost attribution land before any runtime or model switch.

### 5.3 Agents SDK adoption conditions (spike go/no-go)

The spike (Phase 3) must demonstrate all of the following, with the existing `apps/api/tests/chat-runner.integration.test.ts` semantics preserved:

| # | Criterion |
| --- | --- |
| G1 | A custom `Model`/`ModelProvider` wrapper reserves budget before each model request and settles after, with `maxRetries:0` on the underlying client. |
| G2 | A crash after transmission yields `outcome_unknown` and no second paid request on resume. |
| G3 | `RunState` is persisted per turn in Postgres; resume after approval works across a worker restart; decisions are consumed atomically and cannot be replayed. |
| G4 | Every span reaches the Orbit Postgres trace processor regardless of the OpenAI export setting; OpenAI export can be switched on/off by configuration (`addTraceProcessor` vs. `setTraceProcessors`). |
| G5 | `maxTurns`, tool-call caps, input-byte caps and cancellation map to current limits. |
| G6 | Net code reduction or equal code with added capability (approvals, handoff, tool search) — measured, not assumed. |
| G7 | Exact version pin, lockfile review, dependency audit clean, license recorded. |

If any of G1–G4 fails, Orbit keeps the custom loop and only applies §4.2/§4.3 modernizations (strict tools, caching, manual tool search integration).

---

## 6. Agent, tool and MCP concept

### 6.1 Is a multi-agent system sensible?

Mapping the proposed tree onto Orbit's actual needs:

| Proposed agent | Decision | Reason |
| --- | --- | --- |
| Orbit Orchestrator | **Agent** — "Orbit Operator" | Interactive, multi-step, needs tools and judgment. Evolves from Chat v1. |
| Research Agent | **Agent-as-tool** (Phase 5) | Web search burns many tokens and pulls untrusted content; an isolated context and cheaper model protect the operator context and budget. Returns a structured research brief with citations. |
| Content Strategist | **Not a separate agent** | Same context as the operator; realized as the operator on a quality model route plus a `propose_campaign_plan` tool. |
| Writer | **Deterministic workflow** | The existing generation pipeline (single strict structured call + evidence + placeholders) is accepted live. An agent loop would add cost and weaken guarantees. |
| Creative Agent | **Tool** (`propose_image`) | Image generation needs per-request cost confirmation; rendering is deterministic. |
| Publishing Agent | **Never an agent** | Publishing is a policy-gated deterministic executor. An LLM must not own external writes. |
| Analytics Agent | **Tools + deterministic analysis** | Metrics come from Matomo/CSV and arithmetic; the operator interprets via `analytics_*` read tools. Revisit only if analyses need long independent multi-step exploration. |

Result: **one agent plus one optional specialist.** Handoffs are not needed initially; agents-as-tools keep the operator in control and keep one budget/run ceiling. The Responses multi-agent beta is not used (beta, no `max_tool_calls` support).

### 6.2 Tool taxonomy

Every tool is declared once in a registry:

```ts
// Conceptual shape — not implemented
type OrbitTool = {
  name: string;                 // e.g. "content.search"
  namespace: "project" | "knowledge" | "content" | "brand" | "assets"
           | "analytics" | "calendar" | "drive" | "research" | "proposals";
  description: string;
  input: ZodSchema;             // → strict JSON schema
  output: ZodSchema;            // validated + size-capped before returning to the model
  risk: "R0_read" | "W0_internal" | "P_proposal";   // agents never get W1+ tools
  roles: Array<"viewer" | "editor" | "owner">;
  requires?: { capability?: string; policyFlag?: string; connector?: string };
  costCategory?: string;        // e.g. "tool_web_search"
  deferLoading: boolean;
};
```

| Integration | Exposure | Tools (agent-facing) | Notes |
| --- | --- | --- | --- |
| Project knowledge | Internal function tools | `knowledge.search`, `knowledge.fact_get` | Existing hybrid retrieval; results untrusted; cannot create Verified Facts |
| Content repository | Internal function tools | `content.search`, `content.get`, `content.list_by_campaign` | New read tools over drafts/missions |
| Brand assets / profile | Internal function tools | `brand.profile_get`, `assets.approved_list` | Existing `approved_assets` generalized |
| Matomo | Internal function tools over imported data | `analytics.metrics_query`, `analytics.memory` | Reads Orbit's imported metrics; live Matomo read stays an owner import job |
| Google Drive | Internal function tools (read) + proposal | `drive.list_brand_folder` (read); save only via workflow | Native connector; no hosted Drive connector |
| Postiz | Proposal only | `proposals.postiz_draft`, `proposals.publication` | Executor = existing `postiz-draft.ts` / publisher after `ActionRequest` |
| X / Telegram | Via Postiz only | — | No native write adapters; Telegram as a future approval/notification channel (§9.6) |
| Web research | OpenAI built-in `web_search` inside `research.run` | `research.run` (agent-as-tool) | Output stored as research notes; promotion to a knowledge source uses the existing source approval flow |
| Image generation | Proposal | `proposals.image` | Executor = existing `image-generation.ts` with owner confirmation |
| Campaign planning | Proposal | `proposals.campaign` (existing), `proposals.weekly_plan` | Confirmation creates missions as today |
| Calendar | Internal function tools | `calendar.slots`, `calendar.blocks` | Read-only |

### 6.3 MCP

- **Orbit-owned data stays on internal function tools**, not hosted MCP. Hosted MCP means OpenAI's servers call the MCP endpoint directly, bypassing Orbit's per-transaction RLS scope, role checks and budget journal, and requiring credentials to be reachable by OpenAI.
- **The registry is MCP-shaped** (name, description, JSON schema, read/write annotation) so a later Orbit MCP server needs no tool rewrite.
- **Orbit MCP server (read-only)** for external clients such as Codex or ChatGPT is a P3 option. It is an explicit non-goal in `ORBIT_ULIQUID_PRODUCTION_GOAL.md` and needs Mario's decision to lift it.
- **Consuming external MCP servers** (for example the existing uLiquid Analysis / Matomo MCP service on the VPS) would run as an SDK client inside the worker with a tool allowlist, read-only filter and output caps. Not needed while the native Matomo connector covers the use case.

### 6.4 Tool search / deferred loading

- **Now (5 tools):** no tool search. Tool definitions are a few hundred tokens and cache well.
- **Design now:** namespaces in the registry, `deferLoading` flag per tool, a stable always-loaded core (`project.status`, `knowledge.search`, `proposals.campaign`).
- **Trigger:** enable when the operator exposes more than ~15 tools or tool definitions exceed ~3,000 tokens.
- **Mode:** **client-executed** tool search. The application returns only tools the current user role, project policy and verified connector capabilities allow — exactly the "tenant state" case the OpenAI guide describes. Hosted search over all tools would let the model discover tools it may not use.
- **Cost note:** loaded tools are appended at the end of the context so the cached prefix survives; changing the loaded set breaks the cache from that point. Keep namespaces under 10 tools each (OpenAI guidance).

### 6.5 Skills

OpenAI Skills (`/v1/skills`) are bundles for hosted/local shell environments. Orbit has no shell tool and should not add one for marketing work. Instead, introduce **Orbit Playbooks**: versioned, owner-reviewed instruction modules per channel/content type (Telegram post, X thread, blog article, weekly plan), stored alongside channel rules and the marketing profile, loaded into the stable prompt prefix or via a deferred namespace. Re-evaluate OpenAI Skills only if a hosted shell becomes necessary.

---

## 7. Computer use

Integration priority: **native API → function tool / MCP → computer use.**

Current state: every integrated service (Postiz, Drive, Matomo, Slack, OpenAI) has an API. AdsGram has no confirmed API and is already handled by CSV import. **There is no current need for computer use.**

If a concrete service without API or stable MCP must be automated later:

| Rule | Detail |
| --- | --- |
| Scope | Read-only extraction first (reports, stats). Writes only per explicit approval. |
| Environment | Isolated browser with origin allowlist, no host mounts, no access to Orbit internals, destroyed after each run. Both a self-hosted Playwright container and the Agents API hosted browser are candidates (residency is no blocker per D2); choose per service by cost and reliability. |
| Credentials | Never typed by the model. Pre-authenticated session profiles provisioned by the owner, stored encrypted, scoped per service. |
| Approvals | Every consequential action (submit, send, pay, delete, change settings) requires an `ActionRequest` approval. Payments, credential changes and deletions are forbidden. |
| Untrusted input | Screen content is data, never instructions; a detected instruction aborts the run. |
| Limits | Max steps, wall time, screenshots, and cost ceiling per run; separate budget category `computer_use`. |
| Evidence | Store action log and redacted screenshots per step in the trace store. |
| Model | `gpt-6.1-sol` with the GA `computer` tool (documented model for this path). `pending_safety_checks` fields no longer appear in the docs, so all safety enforcement is Orbit's responsibility. |

Computer use is Phase 9 (P3) and starts only with a named service, a comparison against CSV/manual alternatives and Mario's approval.

---

## 8. Model routing concept

### 8.1 Task classes

Routing moves from four hardcoded tiers to named task classes, each with a configurable route:

```ts
// Conceptual shape — not implemented
type ModelRoute = {
  model: string;                           // must be in verified allowlist
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  maxOutputTokens: number;
  serviceTier: "standard" | "flex" | "batch";
  cacheMode: "implicit" | "explicit";
  fallback: { model: string; allowed: boolean } | null; // never for sensitive tasks
  maxCostMicrosPerCall: number;
};
type TaskClass =
  | "intent_classify" | "metadata" | "summarize_short" | "session_summary"
  | "chat_operator" | "chat_operator_complex"
  | "draft_social" | "draft_blog" | "channel_variant"
  | "campaign_plan" | "weekly_plan" | "research" | "analytics_interpret"
  | "escalation";
```

### 8.2 Initial candidate routes (to be validated by evals, not assumed)

Prices per 1M tokens, standard tier, ≤272K input, verified 2026-09-30:

| Model | Input | Cached | Cache write | Output |
| --- | --- | --- | --- | --- |
| `gpt-6-luna` | $0.10 | $0.01 | $0.125 | $0.50 |
| `gpt-5.6-luna` (current fast) | $0.20 | $0.02 | $0.25 | $1.20 |
| `gpt-5.6-terra` (current standard, used live) | $2.00 | $0.20 | $2.50 | $12.00 |
| `gpt-6.1-sol` | $2.00 | $0.10 | $2.50 | $10.00 |
| `gpt-5.6-sol` (current quality, promo price) | $4.00 | $0.40 | $5.00 | $20.00 |
| `gpt-6-astra` (current escalation) | $10.00 | $1.00 | $12.50 | $50.00 |

| Task class | Candidate | Effort | Tier | Rationale |
| --- | --- | --- | --- | --- |
| `intent_classify`, `metadata`, `summarize_short`, `session_summary` | `gpt-6-luna` | none/low | standard | Half the price of `gpt-5.6-luna`; supports `effort:none` |
| `chat_operator` | `gpt-6-luna` or `gpt-5.6-terra` | low | standard | Status/lookup questions; A/B by eval |
| `chat_operator_complex`, `campaign_plan`, `weekly_plan`, `research`, `analytics_interpret` | `gpt-6.1-sol` | medium | standard | Near-Astra at terra-level input price; cheaper output and cache reads than terra |
| `draft_social`, `channel_variant` | `gpt-5.6-terra` (current) vs `gpt-6.1-sol` | low/medium | standard; flex for future-dated batches | Switch only if the generation eval shows equal or better claim-review pass rate at equal or lower cost per accepted draft |
| `draft_blog` | `gpt-6.1-sol` | medium | standard/flex | Long-form quality |
| `escalation` | `gpt-6-astra` | medium | standard | Structured trigger only, max once, own budget (master spec §5) |

Notes:

- `gpt-6.1-sol` has no `none`/`minimal` effort; do not route cheap tasks to it.
- Reasoning tokens are billed as output; higher effort can erase the lower list price. Measure cost per **accepted** draft, not per call.
- Prompts over 272K input tokens cost 2× input and 1.5× output; the router rejects such inputs for all task classes except explicitly configured long-context ones.
- Operator complexity routing: a `gpt-6-luna` intent classification (fractions of a cent) chooses between `chat_operator` and `chat_operator_complex` only when the eval shows net savings.

### 8.3 Configuration and governance

- Routes live in a versioned `model_routing` configuration per project (extending `openai_configuration`), editable by owners only, with workspace defaults.
- Every route model must be in the verified allowlist with a rate card entry verified within 31 days (existing rule).
- Sensitive tasks never fall back silently to a weaker model (master spec §5). Low-risk tasks may fall back when explicitly configured.
- Route changes are audited and apply to new runs only; each run records the route version it used.
- Dead code in `routeTask` is removed; escalation becomes an explicit structured trigger (for example `FACT_VALUE_MISMATCH` after two correction attempts) rather than a hidden attempt counter.

### 8.4 Generation eval harness (prerequisite for any switch)

OpenAI's Evals platform shuts down on 2026-11-30, so evals stay in-repo:

- Golden set from accepted uLiquid drafts and their evidence packs (for example the accepted Contents `322b16ab…`, `ba81892b…`), plus negative cases (stale facts, missing CTA fact, over-length).
- Metrics: claim-review pass rate, `FACT_PLACEHOLDER_UNRESOLVED` rate, channel-limit violations, duplicate rate, owner-edit rate, tokens (incl. cached/reasoning), cost per accepted draft, latency.
- Offline deterministic checks run in CI with recorded outputs; live comparisons run only with an approved bounded paid budget.

---

## 9. Approval and security concept

### 9.1 Action catalogue and risk classes

| Class | Meaning | Examples |
| --- | --- | --- |
| R0 | Read inside the project | knowledge search, analytics read, drafts read |
| W0 | Internal write, reversible, no external effect | save draft, save research note, create proposal, session summary |
| C1 | Paid AI inside an active mandate | model calls, embeddings |
| C2 | Paid generation with material cost | image generation, large research runs |
| W1 | External, non-public write | Postiz draft, Drive save |
| W2 | External public write | publish/schedule social post, edit/cancel a scheduled post |
| D1 | Local deletion/archival | archive draft, withdraw content |
| D2 | External deletion | remote post delete |
| F1 | Paid media / ads creation | create ad campaign |
| F2 | Budget and spend changes | change ads budget, change AI limits |
| G | Governance | policy/mandate, credentials, connectors, roles, new channel/audience |

### 9.2 Approval modes

`auto` · `auto_within_policy` (autopilot conditions and all gates) · `approval_required` (single-use owner approval of the exact package) · `approval_required_reauth` (owner approval plus fresh session re-authentication) · `ui_only` (never available to agents; only a human in the UI) · `forbidden`.

### 9.3 Default matrix

| Action | Class | Default | Can policy relax it? |
| --- | --- | --- | --- |
| Research, plan, analyze | R0 | `auto` | — |
| Create content / save draft | W0 | `auto` | — |
| Create proposal (campaign, weekly plan) | W0 | `auto`; confirmation to create missions: `approval_required` | Yes → `auto_within_policy` |
| Paid model calls within mandate | C1 | `auto_within_policy` | Limits only |
| Image generation | C2 | `approval_required` (current exact cost confirmation) | Yes → `auto_within_policy` under per-image and daily caps |
| Postiz draft handoff, Drive save | W1 | `approval_required` | Yes → `auto_within_policy` |
| Publish / schedule social post | W2 | `approval_required` (Assisted) | Yes → `auto_within_policy` (Autopilot, all live gates) |
| Edit / cancel scheduled post | W2 | `approval_required` | Yes |
| Delete/archive existing local content | D1 | `approval_required` | No |
| Delete external content | D2 | `ui_only` (manual provider review, as today) | No |
| Create ad campaign | F1 | `approval_required_reauth` (no executor yet) | No |
| Change budget (ads or AI) | F2 | `ui_only` — agents may only propose | No |
| Policy, credentials, connectors, roles, new channel/audience | G | `ui_only` | No |
| Infrastructure, SSH, Docker, DNS, payments | — | `forbidden` (absent from tools) | No |

Hard floors (D1, D2, F1, F2, G, infrastructure) are code constants and cannot be loosened by policy, prompt, imported document or model output. Agent-initiated actions default one step stricter than user-initiated ones where the mode is configurable.

### 9.4 `ActionRequest` model

One shared model replaces the five approval flavours incrementally (adapters first, no big-bang):

```
ActionRequest
  id, workspaceId, projectId
  actionType, riskClass, approvalMode (resolved at creation, with policy version)
  requestedBy { kind: user|agent|workflow, userId?, agentRunId?, agentName? }
  packageHash, payloadRef (versioned snapshot), costCeilingMicros?
  status: pending | approved | rejected | expired | consumed | superseded | canceled
  expiresAt (per action type, configurable; replaces hardcoded 24 h)
  decision { userId, decidedAt, channel: web|slack|telegram, reauthAt? }
  consumedBy { executionId, consumedAt }   // atomic single use
```

Flow for agent-initiated side effects:

```
Operator tool call (proposals.*) ──► ActionRequest(pending) ──► Approvals Inbox / Slack
         │  (run ends or pauses with RunState saved)                │ decision (atomic)
         ▼                                                          ▼
   Agent answer to user                        Deterministic executor: preflight at claim + just-in-time
                                              → existing publisher / postiz-draft / image-generation
```

The agent run normally does **not** resume to perform the action; the executor does. SDK `needsApproval` + `RunState` resume is used only where the agent must continue reasoning with the approved result (for example "generate image, then write caption").

### 9.5 Security rules for the agent layer

1. Tool results, retrieved content, web pages and screenshots are untrusted data; guardrails flag instruction-like content; nothing retrieved can grant authority.
2. Agents never receive credentials, connector tokens or raw SQL/shell capability.
3. Tool availability is computed per run from role, policy and verified capability (and enforced again on execution).
4. SDK input and tool guardrails supplement, never replace, deterministic claim checks and preflight.
5. `safety_identifier` per Orbit user (hashed) on OpenAI requests.
6. Pause and policy changes fence running agent runs through the existing project `generation` counter.

### 9.6 Approval channels

Web UI (primary, always available) → Slack (existing signed one-use approvals) → Telegram bot (P3, same signing/replay/one-use pattern, owner mobile approvals).

---

## 10. Observability concept

### 10.1 Trace store (Postgres, RLS, indexed tables — not `Entity` JSON)

```
AgentSession   id, workspaceId, projectId, userId?, kind (chat|campaign|weekly|research),
               subjectRef (campaignId/missionId), summaryVersion, createdAt, lastActiveAt

AgentRun       id, sessionId?, traceId, parentRunId?, projectId, agentName, taskClass,
               trigger (user|schedule|workflow), routeVersion, status, errorCode,
               attempt, startedAt, endedAt, durationMs,
               tokensIn, tokensCached, tokensCacheWrite, tokensOut, tokensReasoning,
               costReservedMicros, costSettledMicros, costUnknownMicros,
               modelCalls, toolCalls, approvalRequestIds[], resultRef

AgentSpan      id, runId, parentSpanId?, type (model_call|tool_call|guardrail|approval|handoff|retrieval),
               name, model?, reasoningEffort?, serviceTier?, openaiResponseId?,
               budgetReservationId?, status, errorCode, retryOf?, startedAt, durationMs,
               usage JSON (raw provider usage), inputHash, outputHash, redactedPreview?
```

- Existing `ChatRun` stays; each chat run gets an `AgentRun` link. Generation, retrieval embeddings, images, research and evaluations emit spans through one `withSpan()` helper, so non-agent paths are observable too.
- Prompts and outputs are stored as hashes plus short redacted previews by default. Full capture only in a time-limited debug mode set by the owner.
- `openaiResponseId` is recorded even with `store:false` for support correlation.

### 10.2 Sources

- Agents SDK: `orbitPostgresProcessor` is always registered. OpenAI dashboard export is a configuration switch (default on while Orbit is single-user, per D2): `addTraceProcessor` keeps it, `setTraceProcessors` removes it. Reconsider when other users or customer data enter Orbit.
- Direct Responses/Embeddings/Images calls: `withSpan()` in `packages/ai`.
- Budget journal: spans reference `budgetReservationId`, so tokens and settled cost are joinable.

### 10.3 Logging and metrics

- Enable Fastify's built-in logger (pino ships with Fastify; no new dependency) with request IDs and redaction of authorization, cookies and credential fields; the worker logs with `jobId`/`runId`/`traceId`.
- Metrics as SQL views first: cost per agent/project/campaign/task/day, run success rate, p50/p95 latency, tool error rate, cache hit ratio (`cached / input`), approval latency, abort reasons.
- UI: "Agent Runs" section in Operations with run timeline, spans, costs and linked approvals.
- OpenTelemetry export is optional later and needs dependency approval.

---

## 11. Cost and budget concept

### 11.1 Rate card v2

```
cost = uncachedInput × inputRate
     + cachedInput   × cachedRate
     + cacheWrite    × cacheWriteRate
     + output (incl. reasoning) × outputRate
     × longContextMultiplier (input >272K: 2× input/cache, 1.5× output)
     × serviceTierFactor (flex/batch 0.5, fast 2.0)
     + toolFees (web_search $10/1k calls, containers per session)
```

Reservation estimates include cache writes at 1.25× input for explicit breakpoints and the output ceiling including reasoning. Unknown outcomes keep the reservation (existing rule). The inclusion of reasoning tokens in `output_tokens` is verified against a real response before settlement relies on it.

### 11.2 Attribution

Additive columns on `BudgetReservation`: `agentName`, `taskClass`, `agentRunId`, `sessionId`, `missionId`, `campaignId`, `contentId`, `toolName`, `routeVersion`. Enables cost per agent, project, campaign, task and tool.

### 11.3 Budget hierarchy

```
Workspace monthly cap (new)
 └─ Project daily / monthly caps (existing)
     └─ Campaign/mission total cap (new; complements maxContents work packages)
         └─ Agent-class daily caps, e.g. research (new)
             └─ Run ceiling (existing per-run)
                 └─ Call ceiling = route.maxCostMicrosPerCall (new)
```

Outer safety net outside Orbit: an OpenAI project-level hard spend limit, set by the owner in the dashboard. It is eventually consistent, so Orbit's journal stays authoritative.

### 11.4 Limits per run

`maxTurns` (default 6 for operator), tool calls (default 8), `max_tool_calls` on each Responses request, `max_output_tokens` per task class, input byte cap, web-search calls per run (default 3), wall-clock timeout, max concurrent agent runs per project (default 1–2).

### 11.5 Abort conditions

Budget refusal before transmission · unknown cost outcome · same tool with same arguments three times · three consecutive tool errors · no new tool result for two turns · guardrail tripwire · pause/policy change (generation fence) · wall-clock limit · route unavailable for a sensitive task. Every abort records a typed reason on `AgentRun`.

### 11.6 Cost levers

- Prompt caching: stable prefix order (instructions → playbook → tool core → project profile → session summary → turn); explicit breakpoints on the stable parts; measure hit ratio.
- Flex for non-urgent generation (future-dated drafts, batch drafts); Batch API for bulk embeddings and reindexing.
- Cheapest capable model per task class via the eval harness.
- Reconciliation: optional daily job against the OpenAI Costs API (requires a separate admin key — owner decision).

---

## 12. Sessions and context

| Layer | Storage | Lifetime | Examples | Authority |
| --- | --- | --- | --- | --- |
| Persistent project knowledge | Postgres (facts, sources, profile, brand, memory rules, insights) | Versioned, long-lived | Verified facts, marketing profile v2 | **Authoritative** |
| Durable work state | Postgres (campaigns/missions, content, approvals, jobs, research notes) | Business lifecycle | Mission, draft v8, ActionRequest | **Authoritative** |
| Agent session | Postgres (`AgentSession`, messages, `RunState`, summary) | Days–weeks; disposable | Campaign thread, weekly-planning thread | Derived, never authoritative |
| Task context | In memory per run; hashed into spans/evidence | One run | Evidence pack, tool outputs | Snapshot for provenance |

Rules:

1. Sessions resume by **rehydrating from durable state** (campaign record, latest insights, open ActionRequests) plus a short session summary — not by replaying long transcripts.
2. Anything a future run must rely on (decisions, preferences, conclusions of a multi-day analysis) is written as a durable entity (for example `analysis_note`, confirmed preference) through a W0 tool, with evidence references.
3. OpenAI Conversations and `previous_response_id` are not used as state: they would duplicate Postgres and tie sessions to one provider. `store` becomes a configuration value (default `false`; `true` allowed per D2 for debugging in the OpenAI dashboard). A custom SDK `Session` implementation on Prisma replaces the current "last 12 plain messages" approach and preserves tool items.
4. Session summaries are generated on the `session_summary` route, versioned, and invalidated when underlying facts or profile versions change.

Sessions that benefit: campaign-bound threads, weekly planning (a scheduled job opens or continues the week's session), multi-day campaign analysis. Single questions and one-off drafts need no persistent session.

---

## 13. Migration strategy and implementation phases

Strangler approach: new capability arrives behind ports next to existing code; each phase is independently releasable, reversible and keeps `EXECUTION_MODE=test` / `ENABLE_EXTERNAL_WRITES=false` semantics.

| Phase | Priority | Content | Risk | Exit criteria |
| --- | --- | --- | --- | --- |
| **0 — Decisions & hygiene** | P0 | ADRs (agent runtime, state/retention, tool registry, approvals); fix doc drift; bump `openai` 7.17.0 → current 7.x after changelog review; record cost/latency baseline from existing receipts | low | ADRs accepted by Mario; tests green |
| **1 — Observability & cost foundation** | P0 | Trace tables (additive migration), `withSpan()` around all OpenAI calls, Fastify/worker structured logging, rate card v2, reservation attribution columns, cost views | high (schema, paid-path code) | No behaviour change; paid-mock tests show correct v2 costs incl. cached/cache-write; spans for chat, generation, embeddings, images |
| **2 — Model routing v2 + generation evals** | P0/P1 | Task-class registry, per-project versioned routes, remove dead routing, explicit escalation trigger, generation eval harness (offline CI + optional bounded live run) | high | Routing tests; eval report comparing terra vs 6.1 Sol vs 6 Luna (live part only with approved budget) |
| **3 — Tool registry, ActionRequest, Agents SDK spike** | P1 | zod-based registry with strict schemas and namespaces; `ActionRequest` + adapters for existing approval flavours; configurable TTLs; SDK spike with `BudgetedModel`, Prisma `Session`, Postgres trace processor | high (approvals, new dependency) | G1–G7 go/no-go documented; approval flows unchanged for users |
| **4 — Operator migration** | P1 | Move `chat-runner` onto `AgentRuntime` (SDK if go, modernized custom loop if no-go); new read tools (content, brand, calendar, analytics query, drive list) and proposal tools (weekly plan, Postiz draft, image); prompt caching with stable prefix; session summaries; Approvals Inbox UI | high | Existing chat integration + e2e tests pass; cache hit ratio measured; one approved live acceptance run |
| **5 — Research capability** | P2 | `research.run` agent-as-tool with hosted `web_search`, domain allow/deny config, research notes, promotion into the source approval flow, budget category | medium/high | Citations stored; no automatic fact creation; per-run web-search caps enforced |
| **6 — Planning intelligence** | P2 | LLM campaign and weekly planning as proposals on `gpt-6.1-sol`; analytics interpretation over imported Matomo/CSV data | medium | Proposals pass existing validation; owner acceptance on uLiquid |
| **7 — Tool search & cost levers** | P2 | Client-executed tool search when trigger met; Flex for future-dated drafts; Batch for reindex embeddings; optional Costs API reconciliation | medium | Token savings measured vs. baseline |
| **8 — MCP & Telegram approvals** | P3 | Read-only Orbit MCP server (requires lifting non-goal); external MCP client for allowlisted services; Telegram approval/notification channel | high | Separate security review |
| **9 — Computer use** | P3 | Only for a named service without API; isolated browser executor per §7 | high/critical | Service-specific risk analysis and approval |

Dependencies: 1 → 2 → (3 ∥ eval-driven route switch) → 4 → 5/6 → 7. Phases 8 and 9 are need-driven.

Rollback per phase: code revert on `main` (existing runbook); migrations are additive only, so a revert leaves unused tables; model routes revert by selecting the previous route version; the SDK adapter is behind a per-project runtime flag so the custom loop remains selectable until Phase 4 is accepted.

---

## 14. Owner decisions

Decided by Mario on 2026-09-30:

| ID | Decision | Consequence |
| --- | --- | --- |
| D1 | **Approved:** add `@openai/agents` (0.18.x, exact pin) as a dependency for the Phase 3 spike. | Dependency audit, license record and lockfile review remain required. Keeping it after the spike depends on G1–G7. |
| D2 | **No data-residency or ZDR requirement** while Orbit is used only by Mario. `store:false` and disabled OpenAI tracing are not mandatory. | OpenAI tracing export and `store:true` become configuration options. Postgres stays authoritative for architectural reasons. Revisit when other users, customers or personal data enter Orbit. |
| D3 | **Approved:** paid budget of at most **$5** for the Phase 2 live model comparison. | Applies only to that comparison. The exact dataset, models and ceiling are shown before transmission; the run stops on an unknown cost outcome. |
| D4 | **Approved:** default approval matrix in §9.3 as written. | Hard floors stay code constants. |

Still open:

5. **Optional:** OpenAI admin key for Costs API reconciliation; OpenAI project hard spend limit as outer safety net.
6. **Later:** lifting the "Orbit MCP Server" non-goal (Phase 8).

These decisions do not authorize production deployments, production migrations, external writes or paid calls outside D3; those keep their separate approvals.

---

## 15. Expected affected files and components

| Area | Files |
| --- | --- |
| AI adapter & routing | `packages/ai/src/index.ts`, `packages/config/src/index.ts`, `apps/api/src/modules/openai-configuration.ts` |
| Agent layer (new) | `apps/api/src/modules/agents/` (runtime port, SDK adapter, `BudgetedModel`, session store, trace processor, router) or a new `packages/agent-runtime` |
| Tool registry (new) | `apps/api/src/modules/agents/tools/` (namespaced tools); refactor of `apps/api/src/modules/chat-tools.ts` |
| Chat / operator | `apps/api/src/modules/chat-runner.ts`, `apps/api/src/modules/chat.ts`, `apps/web/src/components/chat.tsx` |
| Approvals | `apps/api/src/modules/policy.ts`, `workflow.ts`, `postiz-draft.ts`, `image-generation.ts`, `slack.ts`, `apps/web/src/components/work.tsx` (+ new Approvals Inbox) |
| Budget & cost | `apps/api/src/modules/budget.ts`, `docs/adr/0003-cost-accounting.md` |
| Paid-call paths (spans, attribution) | `generation.ts`, `retrieval.ts`, `ingestion.ts`, `reindex.ts`, `index-evaluation.ts`, `draft-batch.ts` |
| Research / planning (new tools) | `editorial.ts`, `planning.ts`, new research module |
| Server & worker | `apps/api/src/server.ts` (logger, routes), `apps/api/src/shared.ts`, `apps/worker/src/main.ts` |
| Data | `packages/db/prisma/schema.prisma`, new additive migration(s), `packages/db/prisma/security.sql` (RLS for new tables) |
| API contract | `packages/schemas/src/index.ts`, `packages/schemas/openapi.json`, `packages/api-client/src/generated.ts` |
| Web | Operations/Agent Runs view, Settings (routing, approval matrix, limits) |
| Evals | new `evals/generation/`, tests under `apps/api/tests/` |
| Dependencies | `package.json`, `pnpm-lock.yaml` (`openai` bump, `@openai/agents` after approval) |
| Docs | `MODEL_ROUTING.md`, `AUTONOMY_POLICY.md`, `ORBIT_CHAT_V1.md`, `OPERATIONS.md`, `IMPLEMENTATION_STATUS.md`, `REQUIREMENTS_TRACEABILITY.md`, `CONNECTOR_DEVELOPMENT.md`, new ADRs `0005`–`0008` |

---

## 16. Sources (retrieved 2026-09-30)

- Models and pricing: https://developers.openai.com/api/docs/models/gpt-6.1-sol, https://developers.openai.com/api/docs/models/gpt-6-luna, https://developers.openai.com/api/docs/pricing
- Tool search: https://developers.openai.com/api/docs/guides/tools-tool-search
- Conversation state and retention: https://developers.openai.com/api/docs/guides/conversation-state, https://developers.openai.com/api/docs/guides/your-data
- Prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching
- Latest-model features (multi-agent beta, compaction, reasoning): https://developers.openai.com/api/docs/guides/latest-model
- Agents API: https://developers.openai.com/api/docs/guides/agents-api/overview
- Agents SDK (TypeScript) 0.18.0: https://github.com/openai/openai-agents-js/releases (guides: running agents, sessions, human-in-the-loop, tracing, MCP, tools)
- Computer use: https://developers.openai.com/api/docs/guides/tools-computer-use
- Skills: https://developers.openai.com/api/docs/guides/tools-skills
- MCP and connectors: https://developers.openai.com/api/docs/guides/tools-connectors-mcp
- Spend limits and Costs API: https://developers.openai.com/api/docs/guides/spend-limits
- Deprecations (Agent Builder, Evals, prompts, Assistants): https://developers.openai.com/api/docs/deprecations

---

## 17. Progress log

### 2026-09-30 — Phase 0 complete (local, no production change)

- ADRs: [0005](adr/0005-agent-runtime.md) agent runtime, [0006](adr/0006-agent-state-and-data-retention.md) agent state and data retention, [0007](adr/0007-tool-registry.md) tool registry/MCP/tool search, [0008](adr/0008-action-approvals.md) generic action approvals.
- Documentation drift fixed: `IMPLEMENTATION_STATUS.md` now opens with the current production state; `MODEL_ROUTING.md` describes chat tools and the actual routing coverage.
- `openai` 7.17.0 → 7.25.0 after changelog review (7.18.0–7.25.0: features and fixes only); release-age exclusion updated in `pnpm-workspace.yaml`; frozen install passes the supply-chain policy.
- Baseline: [agent-platform-baseline-2026-09-30](evidence/agent-platform-baseline-2026-09-30.md) from settled production receipts (single draft 5,158–7,650 micros, batch draft run about 13,700–17,900, chat run with proposal attempt 35,024). Latency, cache and attribution metrics are not measurable yet.
- Verification on Node 24.18.0: lint, typecheck, build, framework check, secret scan and high-severity audit pass; 382/383 tests pass. The failing real-Redis worker lifecycle test also fails on the pre-upgrade commit `9e62a0b`; the local test database holds about 2,467 accumulated projects and the pump iterates all projects per tick. Tracked as a separate follow-up.

Next: Phase 1 (observability and cost foundation). It needs an additive schema migration, local only until a separate production release approval.

### 2026-09-30 — Phase 1 complete (local, no production change)

- Cost model v2 (`packages/ai/src/cost.ts`): optional `cachedInputMicrosPerMillion` (default input rate) and `cacheWriteMicrosPerMillion` (default `ceil(1.25 x input)`); settlement splits ordinary, cached, cache-write and output tokens; usage without cache details settles all input at the higher of the input and cache-write rate. Estimates charge all input at the cache-write rate, so chat proposal ceilings rise by up to about 25 % of the input part. Existing price error codes are unchanged. See [ADR 0003](adr/0003-cost-accounting.md) addendum and `MODEL_ROUTING.md`.
- Migration `202609300001_agent_telemetry` (additive, forced RLS): `AgentRun`, `AgentSpan`, and nullable `BudgetReservation.agentRunId/taskClass/model/missionId`.
- Non-throwing telemetry recorder (`apps/api/src/modules/telemetry.ts`) storing only codes, hashes, counts and IDs. Instrumented: chat (run per chat run, model and tool spans, crash recovery closes the run as blocked/`CHAT_OUTCOME_UNKNOWN`), generation, retrieval, ingestion, reindex, index evaluation and images. Query embeddings made during generation carry the draft task class; a successful image call records cost null, the reservation stays unknown.
- Editor/owner endpoints `GET /api/projects/:projectId/agent-runs` and `GET /api/projects/:projectId/ai-cost` (groupBy day, category, model, taskClass, mission; default current UTC month, at most 93 days). See `API_CONTRACT.md`.
- API logging: pino request/response lines with random request IDs, no query strings, bodies or secrets (auth/cookie headers redacted), failure lines `{code,status}` without message or stack, health probes at warn, `LOG_LEVEL`. Worker logging is unchanged and remains for a later step.
- Verification on Node 24.18.0: lint, typecheck, build and secret scan pass; 429/430 tests pass. The one failure is the known real-Redis worker lifecycle test (`apps/worker/tests/workflow.integration.test.ts`, timeout with the large local test database), unchanged from Phase 0 (382/383, +47 tests). `framework:check` passes once line-range suffixes in backticked paths are avoided in the Phase 1 plan files.

Next: Phase 2. The telemetry migration is local only until a separate production release approval.


### 2026-10-01 — Phase 0 and Phase 1 released to production

- Mario approved merging PR #15; merged as `dce2ad4` on 2026-10-01 06:54 UTC and deployed by the Coolify webhook.
- Read-only post-deploy checks on `https://orbit.eds-labs.io`: `/api/health/ready` returns `{"status":"ok","database":"ok","worker":"ready"}`; the new `/api/projects/:projectId/agent-runs` and `/ai-cost` routes answer `401 UNAUTHENTICATED` without a session (they did not exist before), so the new API is live. The API only starts after `migrate` completes, so `202609300001_agent_telemetry` is applied.
- The release also carries `next` 16.3.6 (GHSA-vcvr-r3jv-pc5j) and the e2e fixes for the settings tabs and chat archive control that came from `main`.
- Still to confirm with an owner session: `GET …/ai-cost` and `…/agent-runs` for uLiquid, structured API logs in Coolify, and that no pending chat proposal hit `PROPOSAL_COST_CHANGED`.

### 2026-10-01 — Phase 2 complete (local, no production change)

- Task-class routing (`packages/ai/src/routing.ts`): `chat_operator`, `draft_social`, `draft_blog` resolve to `{ model, reasoningEffort?, maxOutputTokens }`; an owner-saved task route wins, otherwise the legacy tier with the previous defaults (standard, standard, quality; 3,000/1,800/1,800 tokens; no `reasoning` key). `routeTask` and `route()` are removed. Unverified route models fail at save (`ROUTED_MODEL_NOT_VERIFIED`) and at call time (`MODEL_CAPABILITY_NOT_VERIFIED`), never with a silent fallback.
- Routes are stored in the `openai_configuration` entity and edited in its dialog with the effective route per task class. Its entity version is the route version, stored on `AgentRun.routeVersion` (migration `202610010001_agent_run_route_version`, additive). A configuration save during a run stops it before the next paid call (`GENERATION_DEPENDENCY_CHANGED`, `CHAT_ROUTE_CHANGED`). Chat proposals and generation estimates use the route's `maxOutputTokens`; blog proposals are now priced with `draft_blog`.
- A completed response with usage but unusable output settles its known cost (`MODEL_OUTPUT_NOT_VALID`, `INSUFFICIENT_EVIDENCE`) instead of leaving the reservation unknown.
- Generation evals (`evals/generation/`): offline harness on the real `generateMissionLive` + `checkClaims` path with recorded outputs in `pnpm test`; manual live runner `pnpm eval:generation` with a dry run, a $5 hard ceiling (D3) and a confirmation hash that binds dataset, rate card, verification date and ceiling. Dry run on 2026-10-01: 8 cases x 4 candidates x 2 repetitions = 64 calls, worst case $5.149 against the $5 ceiling (the run may stop early with a partial report). The live eval has not been run; Mario runs it with his own key.
- Verification on Node 24.18.0: lint, typecheck, build, secret scan and framework check pass; 506/507 tests pass before PR #14 (known real-Redis worker lifecycle timeout); after merging `main` with PR #14, 519/519 pass. Migration `202610010001_agent_run_route_version` applies cleanly on top of `202609300001_project_work_due`.
- Release notes: see `OPERATIONS.md` "Model routes and generation evals" (confirm or discard pending blog proposals before deploy; save routes when no run is active).

Next: Mario reviews the dry-run plan and runs the live eval; a route switch then needs the eval report and an owner save. Production release of Phase 2 needs a separate approval.

### 2026-10-01 — Phase 2 and the worker queue pump released to production

- Mario approved merging PR #14 (worker queue pump proportional to due work) and PR #16 (Phase 2). PR #14 was verified locally on its merge with `main` first (lint, typecheck, build, secret scan and framework check pass; 467/467 tests, including the real-Redis worker lifecycle test) and merged as `f68c050` at 11:37 UTC. PR #16 was then updated with that `main` (519/519 tests; its migration applied cleanly on a local test database on top of `202609300001_project_work_due`), passed CI (`validate`, `isolated-acceptance`) and was merged as `cb23603` at 11:49 UTC. The Coolify webhook deploys `main`.
- The deploy applies two additive migrations: `202609300001_project_work_due` (`Project.workDueAt`, its index and marker triggers) and `202610010001_agent_run_route_version` (`AgentRun.routeVersion`). The API only starts after `migrate` completes.
- Read-only check on `https://orbit.eds-labs.io` after the merge: `/api/health/ready` returns `{"status":"ok","database":"ok","worker":"ready"}`. Phase 2 adds no unauthenticated endpoint, so the deployed version cannot be told apart from outside.
- With no task route saved, every task class routes exactly as before; no route was changed in production.
- Still to confirm with an owner session: the OpenAI configuration dialog shows the three task routes with their effective route, new `AgentRun` rows carry `routeVersion`, worker logs show the due-marker pump without errors, and no pending blog proposal hit `PROPOSAL_COST_CHANGED`. Open from Phase 1: `ai-cost`/`agent-runs` for uLiquid and structured API logs in Coolify.

Next: Mario runs the live generation eval with his own key; a route switch then needs the eval report and an owner save. Follow-ups are the deferred minors listed in PR #16, first the double meaning of `INSUFFICIENT_EVIDENCE` for a paid model abstention.

### 2026-10-01 — Follow-up: separate code for a paid model abstention (local)

- A completed, priced response with an empty body now ends with `MODEL_EVIDENCE_ABSTENTION` instead of `INSUFFICIENT_EVIDENCE`. Before, such a job looked like the free evidence failure that `start-approved-live-draft-once` may recover, so the owner was offered a recovery that then failed with `RESERVATION_ALREADY_USED`. Now the recovery refuses it with `JOB_NOT_QUEUED`, and operations can tell a paid abstention from a free evidence failure. The worker still classifies the code as not retryable (it contains `EVIDENCE`). The eval report counts it as `abstained`.
- Jobs that already ended with `INSUFFICIENT_EVIDENCE` after a paid abstention since the Phase 2 release keep that code; their recovery still fails closed with `RESERVATION_ALREADY_USED`.

### 2026-10-01 — Follow-up: refused requests and fail-closed route tests (local)

- A request the provider refuses before any model work (HTTP 400, 401, 403, 404, 422, 429; for example an unsupported reasoning effort or output ceiling chosen for a task route) now settles its reservation at 0 and ends with `MODEL_REQUEST_NOT_ACCEPTED`, in generation and in chat. Before, it settled as `unknown` and stayed counted against the budget until reconciled. Transport errors, timeouts, other statuses and errors inside a started stream stay `unknown`.
- The generation eval counts such a refusal per candidate (`rejected`, cost 0) and continues, instead of stopping the whole eval as `UNEXPECTED`; a candidate with an unsupported effort then shows up in the report rather than ending the run early. The dry-run confirmation is unchanged.
- Integration tests now cover a task route whose price is older than 31 days (generation and chat: `CURRENT_PRICE_REQUIRED`) and a stored route whose model is no longer verified (generation: `MODEL_CAPABILITY_NOT_VERIFIED`), each with no text reservation and no provider call.

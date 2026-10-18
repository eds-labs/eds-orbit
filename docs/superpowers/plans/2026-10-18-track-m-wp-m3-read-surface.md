# Track M, WP-M3: MCP read surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP clients (ChatGPT developer mode first) can search and cite Orbit knowledge and read project state: native `search`, `fetch` and `orbit_profile`, plus the first reviewed registry tools `marketing_project_status` and `support_insights`, all under the WP-M2 gateway's grant and permission checks and only with `modelUse` content.

**Architecture:** Stacked on WP-M2 (PR #165, branch `claude/track-m-wp-m2`). Native tools gain arguments and a request context. The gateway starts the `mcp` `AgentRun` before a tool executes, so paid query embeddings are attributed to it. `search` runs the existing knowledge retrieval with `forModel: true` (hybrid when the project's spend mandate allows, lexical otherwise) across the principal's projects and returns ChatGPT-shaped hits with resolvable ids. `fetch` resolves those ids through new eligibility-checked read services that mirror the retrieval rules. Registry tools are exposed only after a per-tool review with strict output schemas.

**Tech Stack:** Fastify, MCP SDK 2.3.1, Prisma, `packages/knowledge` retrieval engine, Vitest.

**Spec:** `plans/orbit-modularization/09-mcp-gateway.md` §2.2, §5.2, §5.4, §6.3, §7 and `07-roadmap.md` (WP-M3). OpenAI contract (re-checked 2026-10-18, developers.openai.com/api/docs/mcp): `search(query: string)` → `{ results: [{ id, title, url }] }`; `fetch(id: string)` → `{ id, title, text, url, metadata? }`; both as `structuredContent` plus a JSON text copy in `content`, each with an output schema; citations only when `url` is a non-empty string; both read-only.

## Risk, environment, profile

- **Risk:** high (Orbit content leaves to external models). Mitigation: `modelUse`/eligibility on every passage and fact, grant scoping, tests that `modelUse=false` never appears.
- **Environment:** local; draft PR on top of #165; nothing runs in production (WP-M5).
- **App profile:** `ai-agent-app` primary, `backend-api`, security and privacy rules (Q-12: no support PII).

## Decisions for this plan (controller rulings; report them in the PR)

| # | Decision | Why |
|---|---|---|
| D-M3-1 | MCP `resources` (`orbit://…`) are **deferred**; everything is reachable through `fetch`. | `09` §5.3: ChatGPT resource support is undocumented; roadmap acceptance needs only search/fetch. |
| D-M3-2 | Budget: per call, `retrievalJobKey = mcp:<grantId>:<requestId>:<projectId>`, `budgetRunKey = mcp:<grantId>:<requestId>`; category stays `query_embedding`; the reservation is attributed to the call's `mcp` AgentRun (`trace.agentRunId`). Not the spec's daily `mcp:<grantId>:<date>` run key. | A daily run key accumulates against `perRunBudgetMicros` and fails with `RUN_BUDGET_EXCEEDED`; daily/monthly project caps still apply; cost shows in AI cost views through the AgentRun. |
| D-M3-3 | Lexical fallback when the paid path is unavailable **before any spend** (`POLICY_REQUIRED`, `PAID_MANDATE_EXPIRED`, `BUDGET_NOT_APPROVED`, `BUDGET_EXCEEDED`, `RUN_BUDGET_EXCEEDED`, `PROJECT_PAUSED`, `NO_ACTIVE_EMBEDDING_INDEX`, `OPENAI_API_KEY_REQUIRED`); never after a reservation exists. The result reports the mode per project. | `09` §5.2. |
| D-M3-4 | MCP knowledge calls pass **no consumer** (WP3.5): they see only sources open to all modules. | Fail-closed; marketing-only and support-only sources stay internal. |
| D-M3-5 | `search` covers at most **5** of the principal's projects per call (deterministic order: projects where the knowledge module is visible and the role can read, by name then id); with an explicit optional `projectId` argument only that project. | Bounds cost, evidence rows and latency per call. |
| D-M3-6 | Ids are self-describing: `p:<projectId>:chunk:<chunkId>` and `p:<projectId>:fact:<factId>`. `fetch` re-authorizes the project from the id on every call. | `fetch` takes only an id; the project must never come from trust in the id alone. |
| D-M3-7 | `url` = the source's safe canonical URL (`safeCitation`), else the Orbit deep link `${APP_ORIGIN}/p/<projectId>/knowledge/library` (chunks) or `/knowledge/facts` (facts); never empty. | Citations need a non-empty `url`; per-entity web anchors do not exist yet. |
| D-M3-8 | `fetch` returns the chunk's document version text (active, eligible) truncated at **48 KB** UTF-8 with `metadata.truncated`; facts return `key: value [unit/currency]`. | Gateway cap is 64 KB. |
| D-M3-9 | First registry tools exposed: `project_status` (as `marketing_project_status`) and `support_insights`; nothing else in WP-M3. | Smallest reviewed set; the others need output pinning and privacy review (drafts, spend, external posts). |
| D-M3-10 | `search` gets its own bucket: **30 calls/min per grant** in addition to the WP-M2 limits. | `09` §7 paid-search bucket. |
| D-M3-11 | Tool execution timeout **25 s** in the adapter (`isError` `TIMEOUT`, work may still finish server-side); per-project concurrency (R-10) stays a WP-M5 item. | Bound client waits without new infrastructure. |

## Global Constraints

- Only content that `retrieve(… forModel: true, purpose: "public")` could return is ever returned: source active, not generated, `publicUse` and `modelUse` true, not embargoed, open to all consumers, current generation, valid and fresh; document version active and current; facts verified and usable under K-1 (`usableFacts` rules).
- No credentials, encrypted fields, audit data, other users' chats or support ticket text/PII in any result (`09` §5.4, Q-12).
- Every result is validated against a strict zod object `outputSchema`, capped by the WP-M2 64 KB limit; native tools return `structuredContent` plus the JSON text copy (adapter).
- Every project-bound call re-checks grant + membership + module visibility + permission (`projectScope`, `visibleMcpTools`/`authorizeMcpCall` or the same checks for natives); a project outside the grant answers `NOT_FOUND` without revealing existence.
- Audit/telemetry: project calls write `AuditEvent mcp.tool_call` with `call.projectId`; cross-project calls `McpGrantEvent mcp.call`; argument values never stored.
- `orbit_profile` returns the opaque user id, never an e-mail.
- English code and docs; new files in `scripts/boundaries.json`; no new dependency.

## Review Focus

- **A `modelUse=false` source, a marketing-only source, a superseded version or an expired fact** must not appear in `search` and must not be fetchable by a guessed id → Task 2 tests `ineligible content is invisible to search and fetch`.
- **A fetch id naming a project outside the grant, or a chunk of another project under a granted project's prefix** → `NOT_FOUND` → Task 3 test `fetch ids cannot cross projects`.
- **No spend mandate or a paused project** → `search` still answers (lexical, `mode` reported), no reservation written → Task 3 test `search falls back to lexical without spending`.
- **A paid search** → one `query_embedding` reservation attributed to the call's `mcp` AgentRun, visible in the AI cost aggregation → Task 3 test `paid search is attributed to the mcp run`.
- **A query that matches nothing** → `{ results: [] }`, not an error → Task 3 test `empty search is an empty list`.

---

### Task 1: Gateway plumbing — native tool context, run before execute, search bucket, timeout

**Files:** Modify `apps/api/src/platform/mcp/native-tools.ts`, `adapter.ts`, `audit.ts`, `limits.ts`, `server.ts` (if the bucket needs the tool name); Test `apps/api/tests/mcp-gateway.integration.test.ts`, `mcp-gateway-audit.integration.test.ts`.

**Interfaces (produces):**
- `NativeTool.run(principal: McpPrincipal, args: Record<string, unknown>, ctx: NativeToolContext): Promise<unknown>` with `NativeToolContext = { requestId: string; clientId: string; grantId: string; agentRunId: string | null; setAuditProject(projectId: string): void; log: FastifyBaseLogger }`; `NativeTool.inputSchema` is used by the SDK; `NativeTool.meta?: Record<string, unknown>` lands in the tool definition's `_meta` (for `openai/profile`).
- The adapter starts the `mcp` AgentRun before executing a project-bound call (registry tools, and natives once they call `setAuditProject` before work — natives start it lazily through a ctx helper `startRun(projectId)` returning the run id) and passes its id as `ToolContext.runId`; it finishes the run after the call. If the run cannot be created, `runId` falls back to the request id (telemetry stays best effort).
- `limits.ts`: bucket `search:<grantKey>` 30/min charged only for `tools/call` of `search`.
- Adapter timeout 25 s → `isError` code `TIMEOUT`, audited outcome `TIMEOUT`.
- [ ] Tests first: native receives args and ctx; `orbit_projects` unchanged; registry call's `runId` equals the created AgentRun id; timeout path with a fixture tool that never resolves (fake timers); 31st `search` call in a minute → 429 while other tools still pass.
- [ ] Implement; run gateway/audit/principal tests; commit `feat(mcp): native tool context, runs before execution, search bucket and timeout (WP-M3)`.

### Task 2: Knowledge read services for MCP

**Files:** Create `apps/api/src/platform/knowledge/mcp-read.ts` (or extend `packages/knowledge` with a pure eligibility helper reused by both — prefer extracting the eligibility predicate from the engine over duplicating it); Test `apps/api/tests/mcp-knowledge-read.integration.test.ts`.

**Interfaces (produces):**
- `searchForModel(scope: Scope, query: string, options: { budget: SearchBudget | null; trace?: { agentRunId: string; taskClass: string } }): Promise<{ mode: "hybrid" | "lexical_degraded"; hits: KnowledgeHit[] }>` with `KnowledgeHit = { kind: "chunk"; chunkId; documentVersionId; sourceId; title; canonicalUrl: string | null } | { kind: "fact"; factId; sourceId; key; canonicalUrl: string | null }` — built from `knowledgeSearch` plus its evidence Entity (documentVersionId and canonical URL live there), no consumer (D-M3-4); applies D-M3-3 fallback.
- `fetchChunkForModel(scope, chunkId): Promise<{ title; text; truncated: boolean; documentVersionId; sourceId; canonicalUrl: string | null; fetchedAt: string }>` — throws `NOT_FOUND` (404) unless the chunk, its version, document and source pass every eligibility rule of `retrieve(forModel:true, purpose:"public")` incl. audiences open to all, current generation, validity and freshness; text = the active version text truncated at 48 KB on a character boundary (D-M3-8).
- `fetchFactForModel(scope, factId): Promise<{ key; value; unit?: string; currency?: string; sourceId; canonicalUrl: string | null }>` — `NOT_FOUND` unless usable under K-1 for the project's language (and market if set).
- [ ] Tests first (seed sources/documents/facts like existing knowledge tests): eligible chunk/fact fetchable; Review Focus `ineligible content is invisible to search and fetch` for modelUse false, publicUse false, embargoed, generated authority, inactive source, superseded version, stale generation, expired validity, restricted audience, unverified/conflicting fact; truncation at 48 KB; lexical mode without budget.
- [ ] Implement; run knowledge tests (packages/knowledge + apps/api knowledge suites) to prove retrieval behaviour unchanged; commit `feat(knowledge): model-eligible search hits and fetch for MCP (WP-M3)`.

### Task 3: Native `search`, `fetch`, `orbit_profile`

**Files:** Modify `apps/api/src/platform/mcp/native-tools.ts` (or split into `native/search.ts`, `native/fetch.ts`, `native/profile.ts` if the file grows past ~250 lines); Test `apps/api/tests/mcp-read-surface.integration.test.ts`.

**Interfaces (produces):**
- `search`: input `{ query: string (1..2000), projectId?: uuid }` (strict); output `{ results: [{ id: string; title: string; url: string }] }` (strict, ≤ 30 results). Projects per D-M3-5 (skipping projects where the knowledge module is not visible or the role cannot read); per project: budget per D-M3-2 when a mandate exists else lexical (D-M3-3); ids per D-M3-6; url per D-M3-7; title = passage title or fact key (clipped 160). Audit: a single-project call sets the audit project; a multi-project call is project-less (McpGrantEvent).
- `fetch`: input `{ id: string (≤ 200) }`; output `{ id; title; text; url; metadata: { projectId; kind: "chunk" | "fact"; sourceId; documentVersionId?: string; fetchedAt?: string; truncated?: boolean } }` (strict). Parses the id, `projectScope(principal, projectId)` (404 outside grant), knowledge module visible + `PROJECT_READ`, then Task 2 services; malformed ids → `NOT_FOUND`.
- `orbit_profile`: input `{}`; output `{ id: string }` (opaque user id); tool `_meta: { "openai/profile": true }`.
- All three: `risk: "R0_read"` (`orbit:read`), annotations read-only.
- [ ] Tests first (real WP-M1 tokens through the gateway): search/fetch schema snapshot (inline snapshot of the tool definitions' input/output JSON Schemas); Review Focus tests `fetch ids cannot cross projects`, `search falls back to lexical without spending`, `paid search is attributed to the mcp run` (stub the embedding provider the way existing retrieval tests do; assert one reservation with `agentRunId` of the call's mcp run), `empty search is an empty list`; profile returns the user id and no e-mail; modelUse=false content absent end-to-end.
- [ ] Implement; run; commit `feat(mcp): native search, fetch and orbit_profile (WP-M3)`.

### Task 4: First reviewed registry tools

**Files:** Modify `apps/api/src/modules/marketing/tools/read-tools.ts` (+ `chat-tools.ts` result schema if needed), `apps/api/src/modules/support/tools.ts`; Test `apps/api/tests/mcp-registry-tools.integration.test.ts`, existing tool tests.

**Interfaces (produces):**
- `project_status`: `exposure: { assistant: true, mcp: true }` and a strict `outputSchema` pinning every returned field (incl. `readiness` from its provider; nested objects strict, arrays bounded); the assistant output is unchanged.
- `support_insights`: `exposure: { assistant: true, mcp: true }` and a strict `outputSchema` for both shapes (`available: false` | counts); still gated by `ORBIT_SUPPORT`, the project module row and `SUPPORT_STATS_READ`.
- Per-tool double-parse review documented in the tool file (parameters parsed by SDK then adapter: no transforms/non-idempotent defaults).
- [ ] Tests first: both tools listed for a member whose grant/scope/module allow, absent otherwise; call through the gateway returns schema-valid output; assistant chat behaviour unchanged (existing chat/tool tests); support tool returns counts only.
- [ ] Implement; run; commit `feat(mcp): expose project status and support insights to MCP clients (WP-M3)`.

### Task 5: Documentation and the full check

**Files:** `docs/IMPLEMENTATION_STATUS.md` (WP-M3 entry: tools, ids, URLs, budget and fallback, decisions D-M3-1…11, limits, known limitations, updated WP-M5 checklist and WP-M4 items), `docs/REQUIREMENTS_TRACEABILITY.md` (WP-M3 acceptance → tests; ChatGPT connector run → WP-M5), `plans/orbit-modularization/09-mcp-gateway.md` (dated notes for D-M3-1/2/5/6/7), `docs/SECURITY_REVIEW.md` status line if relevant.

- [ ] Docs; full vitest run (`node scripts/test-db-for-worktree.ts` first), `tsc` root + web, compose check, source-check/boundaries, secrets check, framework check (`python3 scripts/check_framework.py --require-full-validation`); commit `docs: WP-M3 status, traceability and notes`.

## Risk analysis

| Risk | Mitigation |
|---|---|
| Ineligible content leaks | Eligibility mirrors `retrieve`; Task 2 ineligibility matrix; fetch re-checks from the id. |
| Cost runaway from always-on clients | Search bucket 30/min, ≤5 projects/call, per-call run key, project daily/monthly caps, lexical fallback. |
| Cross-project access through ids | `projectScope` on every fetch; tests. |
| Assistant behaviour changes | Exposure is additive; output schemas validate MCP output only; existing tests. |

## Rollback

Remove `exposure.mcp` from the two registry tools and the natives from `nativeTools`; the gateway stays off in production. No migration expected (if one becomes necessary, stop and record it).

## Task findings

*(appended during execution)*

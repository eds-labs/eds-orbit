# Phase 2 — Model Routing v2 and Generation Evals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded four-tier model table with configurable, versioned task-class routes (model, reasoning effort, output ceiling), and add a generation eval harness that measures claim-review pass rate, tokens, cost and latency per model with Orbit's real generation and review code — offline in CI, and live under the approved $5 budget.

**Architecture:** `packages/ai` gains a small routing module: three task classes in use (`chat_operator`, `draft_social`, `draft_blog`), each resolved to a `ModelRoute`; legacy tier routes stay readable. Routes are stored in the existing `openai_configuration` entity, whose entity version becomes the route version recorded on every `AgentRun`. The eval harness seeds a synthetic project in the local test database, runs the real `generateMissionLive` + `checkClaims` path with deterministic embeddings, and reads tokens/cost/latency from the Phase 1 telemetry.

**Tech Stack:** TypeScript 6, Node 24.18.0, Fastify 5, Prisma 7.10 + PostgreSQL 17 (FORCE RLS), Vitest 5, `openai` 7.25.0, Next.js 16.3.6.

**Spec:** `docs/OPENAI_AGENT_PLATFORM_ALIGNMENT_PLAN.md` §8 (model routing), §13 Phase 2, §14 decision D3 ($5 live comparison budget); ADR 0005.

**Base:** a new branch `claude/orbit-phase2-model-routing` created from `main` after PR #15 is merged (Phase 1 cost and telemetry code is a prerequisite).

## Global Constraints

- Node 24.18.0 (`export PATH=/private/tmp/claude-501/-Users-marioeuchner-EDS-Labs-Development-EDS-Orbit--claude-worktrees-orbit-openai-agent-alignment-061f16/f95d65a8-d165-4a59-88bb-97ba53da1954/scratchpad/bin:$HOME/.nvm/versions/node/v24.18.0/bin:$PATH`).
- Local only. No production migration, deployment or paid call during implementation. The live eval is run by Mario with his own key after he has seen the exact dataset, models and ceiling (D3); implementers never receive or handle an OpenAI key.
- Env file `../../../.runtime/local.env` relative to the worktree root is sourced, never printed; it contains no OpenAI key.
- Behaviour-preserving defaults: with no new configuration saved, every task resolves to the same model as today (`chat_operator` → standard, `draft_social` → standard, `draft_blog` → quality), no `reasoning` parameter is sent, and output ceilings stay 3,000 (chat) and 1,800 (drafts).
- Every routed model must be in the verified allowlist with a current rate card entry (existing rules). Estimates must use the route's `maxOutputTokens`, so reservations stay worst-case.
- Sensitive tasks never fall back silently to another model; an unverified route model fails closed with `MODEL_CAPABILITY_NOT_VERIFIED`.
- Migrations additive; no edits to applied migrations.
- The eval harness never writes to non-local databases, never runs in default `pnpm test` in live mode, and aborts on the first unknown cost outcome.
- English docs/comments; required checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm secrets:check`, `pnpm framework:check`, `pnpm api:generate` when routes change, `pnpm test:e2e` impact noted for UI changes.
- Do not modify `apps/worker/src/main.ts` unless PR #14 has landed and a change is required.

## Risk Analysis

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Routing refactor changes which model a live project uses | Unexpected cost/quality change in production | Default resolution reproduces today's tier mapping; unit tests pin legacy configs |
| `reasoning.effort` sent to a model that rejects it | Paid path error, reservation `unknown` | Effort is optional and omitted by default; owner sets it per route; docs warn; eval measures before use |
| Larger `maxOutputTokens` raises reservations | Budget refusals | Bounded 256–16,000; estimates follow the route; proposal ceilings documented |
| Eval harness pollutes local test DB | Slower local tests (known issue) | Harness deletes its synthetic workspace in `finally` |
| Live eval overspends | Budget breach | Eval project policy caps daily/monthly/per-run spend at `min(ORBIT_EVAL_MAX_USD, 5)`; budget journal enforces it; dry run shows ceiling first |
| A06 traceability loses its escalation evidence | Acceptance regression | Pure escalation-eligibility guard stays tested; doc updated |

## Test Strategy

- Unit: routing resolution (defaults, legacy tiers, task routes, verification, effort/limits), escalation guard, configuration schema.
- Integration (local PG): `generate()`/`streamChat` receive route effort and ceiling; estimates use the route ceiling; `AgentRun.routeVersion` recorded; settings API round trip.
- E2E: settings form shows and saves task routes (Playwright, CI).
- Eval harness: offline test with recorded model outputs covering pass, placeholder-unresolved, CTA duplication and channel-limit cases; live runner dry-run mode tested without a key.

## Rollback

`git revert` of the phase commits. The migration only adds a nullable column. Stored `taskRoutes` are ignored by reverted code, which falls back to the legacy tiers.

## Review Focus

1. A project whose stored configuration predates this change (only `modelRoutes` tiers) must keep routing exactly as before, including `blog` → quality.
2. A task route whose model is not verified, or whose rate is stale, must fail closed before any reservation or transmission.
3. A route with `reasoningEffort` unset must produce a request without any `reasoning` key; with it set, exactly `{ effort }`.
4. The chat proposal ceiling and generation estimate must use the route's `maxOutputTokens`, never a smaller constant.
5. The live eval must refuse to transmit without `ORBIT_EVAL_OPENAI_API_KEY` and an explicit `ORBIT_EVAL_CONFIRM=<dataset hash>` matching the dry-run output.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/ai/src/routing.ts` (new) | `TaskClass`, `ModelRoute`, schemas, `resolveRoute`, `escalationEligible` |
| `packages/ai/src/routing.test.ts` (new) | Unit tests |
| `packages/ai/src/index.ts` | Re-export routing; `generate()`/`streamChat()` take a `ModelRoute`; remove `route()` |
| `packages/config/src/index.ts` | Keep `modelRoutes` tier defaults; remove `routeTask` |
| `apps/api/src/modules/openai-configuration.ts` | `taskRoutes` input/storage/public view, `routeVersion` |
| `apps/api/src/modules/chat.ts`, `chat-runner.ts`, `generation.ts` | Use `resolveRoute`, route ceilings in estimates, pass `routeVersion` to runs |
| `apps/api/src/modules/telemetry.ts` | `startRun` accepts `routeVersion` |
| `packages/db/prisma/migrations/<timestamp>_agent_run_route_version/migration.sql` (new), `schema.prisma` | Nullable `AgentRun.routeVersion` |
| `apps/web/src/components/management.tsx` | Task-route fields in the OpenAI settings dialog |
| `apps/web/tests/workspace.spec.ts` | Settings form test update |
| `evals/generation/fixtures-v1.json` (new) | Synthetic generation cases |
| `evals/generation/harness.ts` (new) | Seed, run, score, report |
| `evals/generation/offline.test.ts` (new) | CI test with recorded outputs |
| `evals/generation/live.eval.ts`, `evals/generation/vitest.eval.config.ts`, `evals/generation/candidates-v1.json` (new) | Live runner (manual) |
| `package.json` | `eval:generation` script |
| Docs | `MODEL_ROUTING.md`, `REQUIREMENTS_TRACEABILITY.md` (A06), `evals/generation/README.md`, plan §17, `IMPLEMENTATION_STATUS.md` |

---

### Task 1: Task-class routing core

**Files:**
- Create: `packages/ai/src/routing.ts`, `packages/ai/src/routing.test.ts`
- Modify: `packages/ai/src/index.ts` (remove `route`, re-export routing), `packages/config/src/index.ts` (remove `routeTask`), `apps/api/tests/unit.test.ts` (replace A06 and `route(...)` assertions)

**Interfaces:**
- Produces:

```ts
export const taskClasses = ["chat_operator", "draft_social", "draft_blog"] as const;
export type TaskClass = (typeof taskClasses)[number];
export const reasoningEfforts = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export const modelRouteSchema = z.object({
  model: z.string().trim().min(1).max(120),
  reasoningEffort: z.enum(reasoningEfforts).optional(),
  maxOutputTokens: z.number().int().min(256).max(16000),
}).strict();
export type ModelRoute = z.infer<typeof modelRouteSchema>;
export const taskRoutesSchema = z.object({
  chat_operator: modelRouteSchema.optional(),
  draft_social: modelRouteSchema.optional(),
  draft_blog: modelRouteSchema.optional(),
}).strict();
export const defaultOutputTokens: Record<TaskClass, number> = { chat_operator: 3000, draft_social: 1800, draft_blog: 1800 };
export const legacyTier: Record<TaskClass, "standard" | "quality"> = { chat_operator: "standard", draft_social: "standard", draft_blog: "quality" };
export function resolveRoute(taskClass: TaskClass, runtime: Pick<OpenAiRuntimeConfig, "verifiedModels" | "modelRoutes" | "taskRoutes">): ModelRoute;
export function escalationEligible(correctionAttempts: number, escalationsUsed: number): boolean; // true only when correctionAttempts >= 2 && escalationsUsed === 0; throws RETRY_LIMIT when correctionAttempts > 2
```

`resolveRoute` precedence: `runtime.taskRoutes?.[taskClass]` → else `{ model: (runtime.modelRoutes ?? defaultTierRoutes)[legacyTier[taskClass]], maxOutputTokens: defaultOutputTokens[taskClass] }` (no effort). Throws `MODEL_CAPABILITY_NOT_VERIFIED` if the model is not in `verifiedModels`. `OpenAiRuntimeConfig` gains `taskRoutes?: z.infer<typeof taskRoutesSchema>` and `routeVersion?: number`.

- [ ] **Step 1: Failing tests** (`packages/ai/src/routing.test.ts`):
  1. No `modelRoutes`/`taskRoutes`: `resolveRoute("draft_blog", {verifiedModels:["gpt-5.6-sol"]})` → `{ model: "gpt-5.6-sol", maxOutputTokens: 1800 }` without a `reasoningEffort` key; `chat_operator` → `gpt-5.6-terra`, 3000; `draft_social` → `gpt-5.6-terra`, 1800.
  2. Legacy tiers `{fast:"f",standard:"s",quality:"q",escalation:"e"}` with all verified: `draft_social`→`s`, `draft_blog`→`q`, `chat_operator`→`s`.
  3. Task route overrides tiers and carries effort and ceiling verbatim.
  4. Unverified model (task route or tier) throws `MODEL_CAPABILITY_NOT_VERIFIED`.
  5. `modelRouteSchema` rejects `maxOutputTokens` 255 and 16001, unknown keys and an unknown effort.
  6. `escalationEligible(2,0)` true; `(1,0)` false; `(2,1)` false; `(3,0)` throws `RETRY_LIMIT`.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/ai/src/routing.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `routing.ts`; re-export from `index.ts`; delete `routeTask` from `packages/config` (keep `modelRoutes` constant as the default tier source). Replace the A06 unit test in `apps/api/tests/unit.test.ts` with an equivalent over `resolveRoute` + `escalationEligible` (same intent: task-dependent routing, bounded escalation eligibility, unverified model denied) and update the `route('draft',0,0,runtime)` assertion to `resolveRoute("draft_social", runtime).model`. To keep each commit green, keep a deprecated `route(task, attempt, escalations, runtime)` wrapper in `index.ts` that maps `"chat"`→`chat_operator`, `"blog"`→`draft_blog`, else `draft_social` and returns `.model`; Task 3 deletes it.
- [ ] **Step 4:** Run routing + unit tests, `pnpm typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: add task-class model routing with legacy tier fallback`.

---

### Task 2: Route configuration storage and API

**Files:**
- Modify: `apps/api/src/modules/openai-configuration.ts`
- Test: `apps/api/tests/unit.test.ts` (configuration schema/public view), a new `apps/api/tests/openai-configuration.integration.test.ts` (round trip through the API)

**Interfaces:**
- Consumes: `taskRoutesSchema`, `resolveRoute`, `taskClasses` (Task 1).
- Produces: input field `taskRoutes` (optional, default `{}`); stored alongside `modelRoutes`; `publicOpenAiConfiguration` returns `taskRoutes` (stored), `effectiveRoutes: Record<TaskClass, ModelRoute | { error: "MODEL_CAPABILITY_NOT_VERIFIED" }>`, and `routeVersion` (the entity version, or `null` for environment configuration); `runtimeOpenAiConfiguration` returns `taskRoutes` and `routeVersion`.

- [ ] **Step 1: Failing tests:**
  1. Input with a `taskRoutes.draft_social` whose model is not in `verifiedModels` → `ROUTED_MODEL_NOT_VERIFIED` (same message as tier validation).
  2. Input without `taskRoutes` parses to `{}`; stored configs without `taskRoutes` load (legacy).
  3. Public view of a stored row with version 4 exposes `routeVersion: 4` and `effectiveRoutes` for all three classes; environment fallback exposes `routeVersion: null`.
  4. API round trip: owner saves `taskRoutes.draft_blog = { model, reasoningEffort: "low", maxOutputTokens: 4000 }`, GET returns it and `routeVersion` increments on the next save; editor save is refused with the existing owner-only code.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. `stored()` parses `taskRoutes` with `taskRoutesSchema.default({})`.
- [ ] **Step 4:** Run tests → PASS; `pnpm api:generate` if the OpenAPI output changes; `pnpm typecheck`.
- [ ] **Step 5:** Commit `feat: store versioned task-class routes in OpenAI configuration`.

---

### Task 3: Use routes on every paid text path and record the route version

**Files:**
- Create: `packages/db/prisma/migrations/<timestamp>_agent_run_route_version/migration.sql`
- Modify: `packages/db/prisma/schema.prisma`, `packages/ai/src/index.ts` (`generate`, `streamChat`, delete the deprecated `route` wrapper), `apps/api/src/modules/generation.ts`, `chat.ts`, `chat-runner.ts`, `telemetry.ts`
- Test: `apps/api/tests/chat-runner.integration.test.ts`, `apps/api/tests/paid.integration.test.ts`, `apps/api/tests/chat.integration.test.ts`

**Interfaces:**
- Consumes: `resolveRoute`, `ModelRoute`, runtime `routeVersion` (Tasks 1–2).
- Produces:
  - `generate(params: { task: string; goal: string; evidence: unknown; route: ModelRoute; reservationId: string; runtime?: OpenAiRuntimeConfig; signal?: AbortSignal })` — replaces `model`; sends `model: route.model`, `max_output_tokens: route.maxOutputTokens`, and `reasoning: { effort: route.reasoningEffort }` only when set.
  - `streamChat({ route: ModelRoute, ... })` likewise; `CHAT_MAX_OUTPUT_TOKENS` constant removed in favour of the route.
  - `startRun(scope, { ..., routeVersion?: number | null })`; `AgentRun.routeVersion INTEGER NULL`.

Migration:

```sql
-- Records which OpenAI configuration version routed a run. Additive only.
ALTER TABLE "AgentRun" ADD COLUMN "routeVersion" INTEGER;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_routeVersion_check" CHECK ("routeVersion" IS NULL OR "routeVersion" > 0);
```

Call sites:
- `generation.ts`: task class `draft_blog` when `contentType === "blog"`, else `draft_social`; precondition check uses `resolveRoute`; estimate `estimateCost(route.model, bytes + 4000, route.maxOutputTokens, ai)`; `generate({ route, ... })`; `startRun(..., routeVersion: ai.routeVersion ?? null)` — the run is started after the precondition transaction, so return `routeVersion` from that transaction.
- `chat.ts` (proposal create and confirm): first-draft ceiling uses the draft route for the proposal's content type (`draft_blog` for blog, else `draft_social`) and `route.maxOutputTokens` instead of `1800`.
- `chat-runner.ts`: `resolveRoute("chat_operator", runtime)`; estimate with `route.maxOutputTokens`; `streamChat({ route, ... })`; `startRun(..., routeVersion)`.

- [ ] **Step 1: Failing tests:**
  1. `paid.integration`: with stored `taskRoutes.draft_social = { model: "gpt-5.6-terra", reasoningEffort: "low", maxOutputTokens: 2400 }`, the mocked `generate` receives exactly that route; the `text` reservation amount equals `estimateCost(model, bytes + 4000, 2400, runtime)`; the generation `AgentRun.routeVersion` equals the configuration entity version.
  2. Same without `taskRoutes`: `generate` receives `{ model: <standard tier>, maxOutputTokens: 1800 }` with no `reasoningEffort` key.
  3. `chat-runner.integration`: `streamChat` receives the `chat_operator` route; the chat `AgentRun.routeVersion` is set.
  4. A packages/ai unit test with a stubbed OpenAI client (`vi.mock("openai")`) asserts the request body contains `reasoning: { effort: "low" }` when set and has no `reasoning` key when unset, and `max_output_tokens` equals the route ceiling.
  5. `chat.integration`: proposal ceiling uses the route ceiling (a route with `maxOutputTokens: 3600` doubles the output component versus 1800).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; apply the migration to the local test DB (`MIGRATION_DATABASE_URL="$TEST_MIGRATION_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" AUTH_DATABASE_URL="$TEST_AUTH_DATABASE_URL" pnpm exec tsx scripts/db-deploy.ts`); `pnpm db:generate`; `pnpm test:migration-profile`.
- [ ] **Step 4:** Run the listed integration tests, `pnpm typecheck`, `pnpm lint`, full `pnpm test` → PASS (except the known local worker timeout, if still present).
- [ ] **Step 5:** Commit `feat: route chat and drafts through task-class routes and record route versions`.

---

### Task 4: Settings UI for task routes

**Files:**
- Modify: `apps/web/src/components/management.tsx` (OpenAI configuration dialog), `apps/web/tests/workspace.spec.ts` (OpenAI configuration test)

**Interfaces:** consumes the public view fields `taskRoutes`, `effectiveRoutes`, `routeVersion` (Task 2).

- [ ] **Step 1:** Extend the Playwright test: the dialog shows one group per task class (Chat operator, Social drafts, Blog drafts) with model, reasoning effort (`Default (not sent)`, none, low, medium, high, xhigh, max) and maximum output tokens; saving a Blog drafts route with effort `low` and 4000 tokens sends `taskRoutes.draft_blog` with those values; the dialog shows `Route version N`.
- [ ] **Step 2:** Implement with the existing `FormField` pattern; keep the four legacy tier fields under a "Fallback tier models" heading (escalation stays configurable). Every input has a visible label; effort default submits no `reasoningEffort` key.
- [ ] **Step 3:** `pnpm --dir apps/web typecheck`, `pnpm build`; the Playwright spec runs in CI.
- [ ] **Step 4:** Accessibility self-check against `.agentic/quality-gates/accessibility-checklist.md` (labels, keyboard order, error text) — record in the report.
- [ ] **Step 5:** Commit `feat: configure task-class routes in the OpenAI settings dialog`.

---

### Task 5: Offline generation eval harness

**Files:**
- Create: `evals/generation/fixtures-v1.json`, `evals/generation/harness.ts`, `evals/generation/offline.test.ts`

**Interfaces:**
- Produces:

```ts
export type EvalCase = {
  id: string; language: "en" | "de"; contentType: "social" | "blog";
  channel: { provider: "telegram" | "x"; characterLimit: number | null };
  profile: { positioning: string; voice: string; guardrails: string[]; primaryCta: string; officialUrl: string };
  facts: Array<{ key: string; value: string }>;
  goal: string;
  recorded?: Record<string, { title: string; body: string; claims: Array<{ text: string; factKey?: string; kind: "fact" | "quote" | "style" }> }>;
};
export type EvalCandidate = { label: string; route: ModelRoute };
export type EvalResult = { caseId: string; candidate: string; valid: boolean; problems: string[]; costMicros: number | null; inputTokens: number | null; cachedTokens: number | null; cacheWriteTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; durationMs: number | null; errorCode: string | null };
export type EvalReport = { datasetVersion: string; datasetHash: string; startedAt: string; candidates: EvalCandidate[]; results: EvalResult[]; summary: Array<{ candidate: string; runs: number; passRate: number; costPerAcceptedMicros: number | null; totalCostMicros: number; p50DurationMs: number | null; problemCounts: Record<string, number> }> };
export async function runEval(options: { cases: EvalCase[]; candidates: EvalCandidate[]; repetitions: number; maxCostMicros: number; runtime: OpenAiRuntimeConfig; datasetVersion: string }): Promise<EvalReport>;
export function datasetHash(cases: EvalCase[], candidates: EvalCandidate[], repetitions: number, maxCostMicros: number): string;
export function renderMarkdown(report: EvalReport): string;
```

`runEval` (runs inside Vitest so `embed` can be mocked by the caller):
1. Creates one synthetic workspace/project/owner via `authDb` (pattern from `apps/api/tests/paid.integration.test.ts` / `chat-runner.integration.test.ts`), a source, verified public facts, marketing profile, active policy with `approvedPaidTests: true` and daily/monthly/per-run budgets = `maxCostMicros`, the channel assignment needed by channel rules, and an `openai_configuration` row whose `taskRoutes` select the candidate route (updated per candidate, so `routeVersion` differs).
2. For each case × candidate × repetition: creates a mission (fact keys from the case, CTA = `profile.primaryCta`, target URL = `profile.officialUrl`), calls `generateMissionLive(scope, missionId, jobId)`, then `checkClaims` on the created content; reads the generation `AgentRun` and its `model_call` span for tokens/cost/duration. A thrown error is recorded as `errorCode` (via `errorCode()` from telemetry) with `valid: false`.
3. Stops immediately when any reservation of the eval project is `unknown`, or when the budget journal refuses (`BUDGET_EXCEEDED`/`RUN_BUDGET_EXCEEDED`).
4. Deletes the synthetic workspace and user in `finally`.

`fixtures-v1.json`: 8 synthetic cases (no production data): 5 English/German Telegram and X social posts (X with 280-character limit), 1 blog, 2 negative cases whose goal tempts an unsupported claim. Each case has 2–4 facts and recorded outputs for labels `good`, `unresolved_placeholder`, `double_cta`, `over_limit` where applicable.

- [ ] **Step 1: Failing test** (`offline.test.ts`, `describe.skipIf(!process.env.TEST_DATABASE_URL)`): mock `generate` to return the recorded output for the current candidate label and `embed` with deterministic vectors; run `runEval` on 3 cases × 4 candidates × 1 repetition; assert `good` passRate 1; `unresolved_placeholder` → `FACT_PLACEHOLDER_UNRESOLVED`; `double_cta` → `MULTIPLE_PRIMARY_CTAS`; `over_limit` (X) → `CHANNEL_LIMIT_EXCEEDED`; each `costMicros` equals its settled reservation; `datasetHash` stable and sensitive to `maxCostMicros`; synthetic workspace deleted afterwards; `renderMarkdown` has one summary row per candidate.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement using production modules only (`generateMissionLive`, `checkClaims`, profile/fact/policy helpers); no reimplemented review rules.
- [ ] **Step 4:** Run → PASS; `pnpm typecheck`; full `pnpm test`.
- [ ] **Step 5:** Commit `feat: add offline generation eval harness on the real review path`.

---

### Task 6: Live eval runner (manual, budget-capped)

**Files:**
- Create: `evals/generation/candidates-v1.json`, `evals/generation/live.eval.ts`, `evals/generation/vitest.eval.config.ts`, `evals/generation/live-dry-run.test.ts`, `evals/generation/README.md`
- Modify: `package.json` (`"eval:generation": "vitest run --config evals/generation/vitest.eval.config.ts"`)

`candidates-v1.json` (prices per 1M tokens verified 2026-09-30, USD micros):

```json
{
  "verifiedAt": "2026-09-30T00:00:00.000Z",
  "rateCard": {
    "gpt-5.6-terra": { "inputMicrosPerMillion": 2000000, "cachedInputMicrosPerMillion": 200000, "cacheWriteMicrosPerMillion": 2500000, "outputMicrosPerMillion": 12000000 },
    "gpt-6.1-sol": { "inputMicrosPerMillion": 2000000, "cachedInputMicrosPerMillion": 100000, "cacheWriteMicrosPerMillion": 2500000, "outputMicrosPerMillion": 10000000 },
    "gpt-6-luna": { "inputMicrosPerMillion": 100000, "cachedInputMicrosPerMillion": 10000, "cacheWriteMicrosPerMillion": 125000, "outputMicrosPerMillion": 500000 },
    "text-embedding-3-small": { "inputMicrosPerMillion": 20000, "outputMicrosPerMillion": 0 }
  },
  "candidates": [
    { "label": "terra-default", "route": { "model": "gpt-5.6-terra", "maxOutputTokens": 1800 } },
    { "label": "sol-6.1-low", "route": { "model": "gpt-6.1-sol", "reasoningEffort": "low", "maxOutputTokens": 4000 } },
    { "label": "sol-6.1-medium", "route": { "model": "gpt-6.1-sol", "reasoningEffort": "medium", "maxOutputTokens": 6000 } },
    { "label": "luna-6-none", "route": { "model": "gpt-6-luna", "reasoningEffort": "none", "maxOutputTokens": 1800 } }
  ],
  "repetitions": 2
}
```

`live.eval.ts`: always mocks `embed` deterministically, never mocks `generate`; `maxCostMicros = min(Number(ORBIT_EVAL_MAX_USD ?? 5), 5) * 1_000_000`; dry run by default (prints dataset version, cases, candidates, repetitions, planned calls, worst-case estimate, ceiling, dataset hash; transmits nothing); live run requires `ORBIT_EVAL_OPENAI_API_KEY` and `ORBIT_EVAL_CONFIRM` equal to the printed hash; never logs the key; writes `docs/evidence/generation-eval-<UTC timestamp>.json` and `.md`. `vitest.eval.config.ts` includes only `live.eval.ts`, 30-minute timeout, no file parallelism, same setup file.

- [ ] **Step 1: Failing test** (`live-dry-run.test.ts`, normal suite): `planLiveEval(env, fixtures, candidates)` returns calls = cases × candidates × repetitions, ceiling ≤ 5,000,000 micros even with `ORBIT_EVAL_MAX_USD=50`, stable hash; `assertLiveAllowed(env, hash)` throws `EVAL_KEY_REQUIRED` without a key and `EVAL_CONFIRMATION_MISMATCH` with a wrong confirmation.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; README documents: dry run → show Mario → Mario runs `ORBIT_EVAL_OPENAI_API_KEY=… ORBIT_EVAL_CONFIRM=<hash> pnpm eval:generation` with the local env sourced.
- [ ] **Step 4:** Run the dry-run test and `pnpm eval:generation` without key; `pnpm typecheck`; `pnpm lint`.
- [ ] **Step 5:** Commit `feat: add budget-capped live generation eval runner with dry run`.

---

### Task 7: Documentation and full verification

**Files:** `docs/MODEL_ROUTING.md`, `docs/REQUIREMENTS_TRACEABILITY.md` (A06), `docs/OPENAI_AGENT_PLATFORM_ALIGNMENT_PLAN.md` §17, `docs/IMPLEMENTATION_STATUS.md`, `docs/OPERATIONS.md`, `evals/generation/README.md`.

- [ ] **Step 1:** Document task classes, precedence, legacy fallback, effort semantics, output ceilings and reservations, route version on runs, the eval procedure and what a switch requires (eval report + owner save; new runs only).
- [ ] **Step 2:** Full verification: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm secrets:check && pnpm framework:check` and `pnpm eval:generation` dry run; record exact counts.
- [ ] **Step 3:** Security self-review: key handling in the eval runner, no key in logs/reports, eval confined to local DB.
- [ ] **Step 4:** Commit `docs: record phase 2 model routing and generation evals`.

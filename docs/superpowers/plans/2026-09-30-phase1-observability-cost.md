# Phase 1 — Observability and Cost Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every paid OpenAI call in Orbit measurable (tokens incl. cache and reasoning, settled cost, latency, errors) and attributable (run, task class, model, mission), and settle GPT-5.6+ cache writes correctly, without changing any user-visible behaviour or safety gate.

**Architecture:** A pure cost module in `packages/ai` computes cost from full Responses usage (ordinary, cached, cache-write, output). A small telemetry module writes `AgentRun`/`AgentSpan` rows in their own scoped transactions after the budget journal has committed, so telemetry can never block or undo a settlement. Budget reservations gain nullable attribution columns. Two read-only endpoints expose runs and cost summaries. Fastify gets structured, redacted request logging.

**Tech Stack:** TypeScript 6, Node 24.18.0, Fastify 5.12.5 (built-in pino logger), Prisma 7.10 + PostgreSQL 17 (FORCE RLS), Vitest 5, `openai` 7.25.0.

**Spec:** `docs/OPENAI_AGENT_PLATFORM_ALIGNMENT_PLAN.md` §10 (observability), §11 (cost), §13 Phase 1; ADRs 0003, 0005, 0006.

## Global Constraints

- Node 24.18.0 (`export PATH=~/.nvm/versions/node/v24.18.0/bin:$PATH`); pnpm via `corepack pnpm` (or a corepack shim on `PATH`).
- Local only. No production migration, deployment or paid call. The local env file (`../../../.runtime/local.env` from the worktree) is sourced, never printed; it contains no OpenAI key.
- Migrations are additive and immutable once applied; no change to existing migration files.
- The budget journal stays authoritative. Telemetry is observational: a telemetry failure must never throw into a paid path, change a reservation or trigger a retry.
- Reservations stay conservative: estimates must never be lower than the worst-case cost of the call.
- New tables use FORCE RLS with the existing `project_scope` policy shape and are granted to `orbit_app` in `scripts/db-deploy.ts`.
- No prompts, outputs, credentials or personal data in telemetry rows or logs; only hashes, counts, codes and IDs.
- Do not modify `apps/worker/src/main.ts` in this phase (a parallel session is changing the pump). Worker-side structured logging is deferred.
- Docs and code comments in English; required checks before completion: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm secrets:check`, `pnpm api:generate` when routes change.

## Risk Analysis

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Cost change under-settles or double-counts | Budget reports wrong | Pure `computeCost` with unit tests against the documented formula; conservative defaults when a rate or usage detail is missing |
| Higher estimates change chat proposal ceilings | Owner sees slightly higher ceilings (≈ +25 % of the input part) | Intended: estimates now include the documented 1.25× cache-write price; documented in `MODEL_ROUTING.md` |
| Telemetry insert fails inside a paid path | Paid call considered failed, possible retry | Telemetry runs in a separate transaction after settlement, wrapped in `safely()`; tests inject failures |
| Extra scoped transactions add advisory-lock contention | Slightly slower runs | ≤ 2 small writes per model call; measured in tests |
| Logging leaks secrets or OAuth codes | Security incident | Custom serializers log method, path without query, status, request ID; redact auth headers and cookies; test asserts absence |
| Migration conflicts with the parallel pump fix | Merge conflict | Separate migration timestamp, no worker file changes |

## Test Strategy

- Unit: `packages/ai/src/cost.test.ts` (formula, defaults, missing details, embeddings, rounding).
- Integration (real local PostgreSQL, RLS): telemetry isolation between projects, failure tolerance, chat-runner spans and attribution, generation/retrieval spans, cost summary and agent-run endpoints (auth: viewer denied, editor allowed).
- Logging: `buildServer` with an injected log stream; assert redaction.
- Regression: full suite; existing chat-runner, paid and safety tests must stay green without weakening assertions.

## Rollback

`git revert` of the phase commits. The migration only adds two tables and nullable columns; a reverted app ignores them. No data backfill, no destructive step.

## Review Focus

1. A Responses usage object without `input_tokens_details` (older snapshot, mock or partial failure) must settle conservatively: all input at the cache-write rate, never at the cheaper ordinary rate.
2. A rate card saved before this change (only input/output fields) must still load, save and estimate; missing cache prices default conservatively.
3. A crash or DB error while writing a span after a successful settlement must leave the reservation `settled` and the chat run/job result unchanged.
4. A viewer, or a member of another project, must not read agent runs or cost summaries of a project.
5. Request logs for `/api/google-drive/callback?code=…&state=…` and requests with `Cookie`/`Authorization` headers must not contain the query or header values.

Each item has a test in the owning task below.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/ai/src/cost.ts` (new) | Rate schema v2, usage normalization, `computeCost`, conservative estimate |
| `packages/ai/src/cost.test.ts` (new) | Unit tests for the cost module |
| `packages/ai/src/index.ts` | Re-export cost module; return normalized usage from `generate()`/`embed()` |
| `packages/db/prisma/migrations/202609300001_agent_telemetry/migration.sql` (new) | `AgentRun`, `AgentSpan`, reservation attribution columns, RLS |
| `packages/db/prisma/schema.prisma` | Prisma models for the above |
| `scripts/db-deploy.ts` | Grants for new tables |
| `apps/api/src/modules/telemetry.ts` (new) | `startRun`, `recordSpan`, `finishRun`, `safely`, `hashText` |
| `apps/api/tests/telemetry.integration.test.ts` (new) | RLS isolation, failure tolerance, endpoints |
| `apps/api/src/modules/budget.ts` | Optional attribution on `reserve()` |
| `apps/api/src/modules/chat-runner.ts` | Run + model/tool spans, cost v2 settlement, attribution |
| `apps/api/src/modules/generation.ts`, `retrieval.ts`, `ingestion.ts`, `reindex.ts`, `index-evaluation.ts`, `image-generation.ts` | Spans + attribution |
| `apps/api/src/modules/ai-usage.ts` (new) | Queries for agent runs and cost summary |
| `apps/api/src/server.ts` | Two read routes, logger configuration, `buildServer` options |
| `apps/web/src/components/management.tsx` | Rate card hint text only |
| `docs/MODEL_ROUTING.md`, `docs/OPERATIONS.md`, `docs/API_CONTRACT.md`, `docs/adr/0003-cost-accounting.md`, plan §17 | Documentation |

---

### Task 1: Cost model v2

**Files:**
- Create: `packages/ai/src/cost.ts`, `packages/ai/src/cost.test.ts`
- Modify: `packages/ai/src/index.ts` (rate schema, `estimateCost`, `generate()`, `embed()`)
- Modify: `apps/web/src/components/management.tsx:1464` (hint text)

**Interfaces:**
- Produces:
  - `type Rate = { inputMicrosPerMillion: number; outputMicrosPerMillion: number; cachedInputMicrosPerMillion?: number; cacheWriteMicrosPerMillion?: number; verifiedAt: string }`
  - `type NormalizedUsage = { inputTokens: number; cachedTokens: number; cacheWriteTokens: number; outputTokens: number; reasoningTokens: number; detailsKnown: boolean }`
  - `normalizeResponsesUsage(usage: unknown): NormalizedUsage` — throws `USAGE_UNKNOWN` when `input_tokens`/`output_tokens` are missing
  - `computeCost(model: string, usage: NormalizedUsage, runtime: OpenAiRuntimeConfig): number` (USD micros, integer ≥ 1)
  - `estimateCost(model, inputTokens, outputTokens, runtime)` keeps its signature; input is charged at the cache-write rate
  - `Usage` type gains `cachedTokens`, `cacheWriteTokens`, `reasoningTokens`

- [ ] **Step 1: Write the failing tests** — `packages/ai/src/cost.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { computeCost, estimateCost, normalizeResponsesUsage } from "./cost.ts";

const verifiedAt = new Date().toISOString();
const runtime = (rate: Record<string, unknown>) => ({
  verifiedModels: ["m"],
  rateCard: { m: { verifiedAt, ...rate } },
}) as any;
const base = { inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 12_000_000 };

describe("normalizeResponsesUsage", () => {
  it("reads cache and reasoning details", () => {
    expect(
      normalizeResponsesUsage({
        input_tokens: 1000,
        output_tokens: 200,
        input_tokens_details: { cached_tokens: 300, cache_write_tokens: 500 },
        output_tokens_details: { reasoning_tokens: 50 },
      }),
    ).toEqual({ inputTokens: 1000, cachedTokens: 300, cacheWriteTokens: 500, outputTokens: 200, reasoningTokens: 50, detailsKnown: true });
  });
  it("marks missing details as unknown", () => {
    expect(normalizeResponsesUsage({ input_tokens: 100, output_tokens: 30 })).toMatchObject({ cachedTokens: 0, cacheWriteTokens: 0, detailsKnown: false });
  });
  it("rejects usage without token counts", () => {
    expect(() => normalizeResponsesUsage({ output_tokens: 3 })).toThrow("USAGE_UNKNOWN");
    expect(() => normalizeResponsesUsage(null)).toThrow("USAGE_UNKNOWN");
  });
});

describe("computeCost", () => {
  it("applies the documented formula with explicit cache prices", () => {
    const usage = { inputTokens: 1_000_000, cachedTokens: 200_000, cacheWriteTokens: 300_000, outputTokens: 100_000, reasoningTokens: 40_000, detailsKnown: true };
    // ordinary 500k*2 + cached 200k*0.2 + write 300k*2.5 + output 100k*12 = 1.0+0.04+0.75+1.2 USD
    expect(computeCost("m", usage, runtime({ ...base, cachedInputMicrosPerMillion: 200_000, cacheWriteMicrosPerMillion: 2_500_000 }))).toBe(2_990_000);
  });
  it("defaults cached reads to the input rate and writes to 1.25x input", () => {
    const usage = { inputTokens: 1_000_000, cachedTokens: 200_000, cacheWriteTokens: 300_000, outputTokens: 0, reasoningTokens: 0, detailsKnown: true };
    // 500k*2 + 200k*2 + 300k*2.5 = 1.0+0.4+0.75
    expect(computeCost("m", usage, runtime(base))).toBe(2_150_000);
  });
  it("charges all input at the cache-write rate when details are unknown", () => {
    const usage = { inputTokens: 1_000_000, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, detailsKnown: false };
    expect(computeCost("m", usage, runtime(base))).toBe(2_500_000);
  });
  it("rounds up and never returns zero", () => {
    const usage = { inputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, detailsKnown: true };
    expect(computeCost("m", usage, runtime(base))).toBe(1);
  });
  it("fails closed on stale or missing prices", () => {
    const usage = { inputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, detailsKnown: true };
    expect(() => computeCost("x", usage, runtime(base))).toThrow("CURRENT_PRICE_REQUIRED");
    const stale = { verifiedModels: ["m"], rateCard: { m: { ...base, verifiedAt: "2020-01-01T00:00:00.000Z" } } } as any;
    expect(() => computeCost("m", usage, stale)).toThrow("CURRENT_PRICE_REQUIRED");
  });
  it("rejects cache counts larger than input", () => {
    const usage = { inputTokens: 10, cachedTokens: 8, cacheWriteTokens: 8, outputTokens: 0, reasoningTokens: 0, detailsKnown: true };
    expect(() => computeCost("m", usage, runtime(base))).toThrow("USAGE_INCONSISTENT");
  });
});

describe("estimateCost", () => {
  it("is conservative: input at the cache-write rate", () => {
    expect(estimateCost("m", 1_000_000, 100_000, runtime(base))).toBe(2_500_000 + 1_200_000);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm exec vitest run packages/ai/src/cost.test.ts`
Expected: FAIL — `Cannot find module './cost.ts'`.

- [ ] **Step 3: Implement** — `packages/ai/src/cost.ts`

```ts
import { z } from "zod";

export const rateSchema = z.object({
  inputMicrosPerMillion: z.number().nonnegative(),
  outputMicrosPerMillion: z.number().nonnegative(),
  cachedInputMicrosPerMillion: z.number().nonnegative().optional(),
  cacheWriteMicrosPerMillion: z.number().nonnegative().optional(),
  verifiedAt: z.iso.datetime(),
});
export type Rate = z.infer<typeof rateSchema>;
export const rateCardSchema = z.record(z.string(), rateSchema);
export type CostRuntime = { rateCard: Record<string, Rate> };

export type NormalizedUsage = {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  detailsKnown: boolean;
};

const count = z.number().int().nonnegative();
const responsesUsage = z.object({
  input_tokens: count,
  output_tokens: count,
  input_tokens_details: z
    .object({ cached_tokens: count.optional(), cache_write_tokens: count.optional() })
    .optional(),
  output_tokens_details: z.object({ reasoning_tokens: count.optional() }).optional(),
});

/** Normalizes a Responses API usage object. Missing cache details are marked unknown, never assumed zero-cost. */
export function normalizeResponsesUsage(usage: unknown): NormalizedUsage {
  const parsed = responsesUsage.safeParse(usage);
  if (!parsed.success) throw new Error("USAGE_UNKNOWN");
  const u = parsed.data;
  const details = u.input_tokens_details;
  const detailsKnown =
    details?.cached_tokens !== undefined && details?.cache_write_tokens !== undefined;
  return {
    inputTokens: u.input_tokens,
    cachedTokens: details?.cached_tokens ?? 0,
    cacheWriteTokens: details?.cache_write_tokens ?? 0,
    outputTokens: u.output_tokens,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    detailsKnown,
  };
}

function currentRate(model: string, runtime: CostRuntime): Required<Omit<Rate, "verifiedAt">> {
  const rate = runtime.rateCard?.[model];
  if (!rate || Date.now() - new Date(rate.verifiedAt).valueOf() > 31 * 86400000)
    throw new Error("CURRENT_PRICE_REQUIRED");
  return {
    inputMicrosPerMillion: rate.inputMicrosPerMillion,
    outputMicrosPerMillion: rate.outputMicrosPerMillion,
    // Conservative defaults: a cached read is never cheaper than configured, a write costs the documented 1.25x.
    cachedInputMicrosPerMillion: rate.cachedInputMicrosPerMillion ?? rate.inputMicrosPerMillion,
    cacheWriteMicrosPerMillion:
      rate.cacheWriteMicrosPerMillion ?? Math.ceil(rate.inputMicrosPerMillion * 1.25),
  };
}

/** Cost in USD micros per the documented formula: ordinary + cached + cache writes + output (reasoning is part of output). */
export function computeCost(model: string, usage: NormalizedUsage, runtime: CostRuntime) {
  const rate = currentRate(model, runtime);
  if (usage.cachedTokens + usage.cacheWriteTokens > usage.inputTokens)
    throw new Error("USAGE_INCONSISTENT");
  const input = usage.detailsKnown
    ? (usage.inputTokens - usage.cachedTokens - usage.cacheWriteTokens) * rate.inputMicrosPerMillion +
      usage.cachedTokens * rate.cachedInputMicrosPerMillion +
      usage.cacheWriteTokens * rate.cacheWriteMicrosPerMillion
    : usage.inputTokens * Math.max(rate.inputMicrosPerMillion, rate.cacheWriteMicrosPerMillion);
  return Math.max(1, Math.ceil((input + usage.outputTokens * rate.outputMicrosPerMillion) / 1_000_000));
}

/** Pre-transmission estimate. Charges all input at the cache-write rate because implicit caching may write it. */
export function estimateCost(model: string, inputTokens: number, outputTokens: number, runtime: CostRuntime) {
  return computeCost(
    model,
    { inputTokens, cachedTokens: 0, cacheWriteTokens: 0, outputTokens, reasoningTokens: 0, detailsKnown: false },
    runtime,
  );
}

/** Embedding usage: no caching, input only. */
export function embeddingUsage(totalTokens: number): NormalizedUsage {
  return { inputTokens: totalTokens, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, detailsKnown: true };
}
```

- [ ] **Step 4: Wire into `packages/ai/src/index.ts`**
  - Remove the local `Rate`, `rateCardSchema`, `rateCard()`-independent `estimateCost` definitions; add `export * from "./cost.ts";` and import `{ computeCost, estimateCost, normalizeResponsesUsage, embeddingUsage, rateCardSchema, type Rate, type NormalizedUsage }`.
  - Keep `rateCard(runtime)` (it throws `VERIFIED_PRICE_CONFIGURATION_REQUIRED` for an empty card) and call it at the start of `computeCost` callers that previously relied on it: in `estimateCost` wrappers nothing changes because `currentRate` throws `CURRENT_PRICE_REQUIRED` for an unknown model.
  - Extend `Usage`:

```ts
export type Usage = {
  model: string;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costMicros: number;
};
```

  - In `generate()` replace the usage block with:

```ts
  const usage = normalizeResponsesUsage(response.usage);
  return {
    output,
    responseId: response.id,
    usage: { model: params.model, ...usage, costMicros: computeCost(params.model, usage, runtime) },
  };
```

  (drop `detailsKnown` from the spread by destructuring: `const { detailsKnown, ...counts } = usage;` and spread `counts`.)
  - In `embed()` use `const usage = embeddingUsage(result.usage.total_tokens);` and return `{ model: profile.model, inputTokens: usage.inputTokens, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, costMicros: computeCost(profile.model, usage, runtime) }`.

- [ ] **Step 5: Update the rate card hint** in `apps/web/src/components/management.tsx` (the `hint` of the `rateCard` field):

```ts
hint: "Each model needs inputMicrosPerMillion, outputMicrosPerMillion and an ISO verifiedAt date. Optional: cachedInputMicrosPerMillion and cacheWriteMicrosPerMillion (defaults: input rate and 1.25x input).",
```

  and extend the local `rateCard` type there with the two optional numbers.

- [ ] **Step 6: Run tests**

Run: `corepack pnpm exec vitest run packages/ai/src/cost.test.ts apps/api/tests/unit.test.ts` then `corepack pnpm typecheck`
Expected: PASS. Fix any type errors where callers construct `Usage` objects (test mocks may need the three new numeric fields; add them as `0`).

- [ ] **Step 7: Commit**

```bash
git add packages/ai/src apps/web/src/components/management.tsx apps/api/tests
git commit -m "feat: settle OpenAI cache writes and cached reads with rate card v2"
```

---

### Task 2: Telemetry schema

**Files:**
- Create: `packages/db/prisma/migrations/202609300001_agent_telemetry/migration.sql`
- Modify: `packages/db/prisma/schema.prisma`, `scripts/db-deploy.ts` (lines 144-160)

**Interfaces:**
- Produces Prisma models `AgentRun`, `AgentSpan` and `BudgetReservation` fields `agentRunId`, `taskClass`, `model`, `missionId` used by Tasks 3–6.

- [ ] **Step 1: Write the migration**

```sql
-- Agent/model-call telemetry and budget attribution. Additive only.
ALTER TABLE "BudgetReservation"
  ADD COLUMN "agentRunId" UUID,
  ADD COLUMN "taskClass" TEXT,
  ADD COLUMN "model" TEXT,
  ADD COLUMN "missionId" UUID;
CREATE INDEX "BudgetReservation_workspaceId_projectId_agentRunId_idx" ON "BudgetReservation"("workspaceId", "projectId", "agentRunId");

CREATE TABLE "AgentRun" (
  "id" UUID PRIMARY KEY,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "agentName" TEXT NOT NULL,
  "taskClass" TEXT NOT NULL,
  "subjectType" TEXT,
  "subjectId" TEXT,
  "missionId" UUID,
  "status" TEXT NOT NULL DEFAULT 'running',
  "errorCode" TEXT,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMPTZ(3),
  "durationMs" INTEGER,
  CONSTRAINT "AgentRun_workspaceId_projectId_id_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "AgentRun_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE,
  CONSTRAINT "AgentRun_kind_check" CHECK ("kind" IN ('chat','generation','retrieval','ingestion','reindex','evaluation','image')),
  CONSTRAINT "AgentRun_status_check" CHECK ("status" IN ('running','succeeded','failed','blocked','canceled','unknown')),
  CONSTRAINT "AgentRun_duration_check" CHECK ("durationMs" IS NULL OR "durationMs" >= 0)
);
CREATE INDEX "AgentRun_workspaceId_projectId_startedAt_idx" ON "AgentRun"("workspaceId", "projectId", "startedAt" DESC);
CREATE INDEX "AgentRun_workspaceId_projectId_subject_idx" ON "AgentRun"("workspaceId", "projectId", "subjectType", "subjectId");

CREATE TABLE "AgentSpan" (
  "id" UUID PRIMARY KEY,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "parentSpanId" UUID,
  "type" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "model" TEXT,
  "status" TEXT NOT NULL,
  "errorCode" TEXT,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "inputTokens" INTEGER,
  "cachedTokens" INTEGER,
  "cacheWriteTokens" INTEGER,
  "outputTokens" INTEGER,
  "reasoningTokens" INTEGER,
  "costMicros" BIGINT,
  "budgetReservationId" UUID,
  "providerResponseId" TEXT,
  "inputHash" TEXT,
  "outputHash" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentSpan_run_fkey" FOREIGN KEY ("workspaceId", "projectId", "runId") REFERENCES "AgentRun"("workspaceId", "projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "AgentSpan_type_check" CHECK ("type" IN ('model_call','tool_call','embedding','image')),
  CONSTRAINT "AgentSpan_status_check" CHECK ("status" IN ('succeeded','failed','unknown','blocked')),
  CONSTRAINT "AgentSpan_nonnegative" CHECK ("durationMs" >= 0 AND ("costMicros" IS NULL OR "costMicros" >= 0))
);
CREATE INDEX "AgentSpan_workspaceId_projectId_runId_idx" ON "AgentSpan"("workspaceId", "projectId", "runId");

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['AgentRun','AgentSpan'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY project_scope ON %I USING ("workspaceId"=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND "projectId"=nullif(current_setting(''app.project_id'',true),'''')::uuid) WITH CHECK ("workspaceId"=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND "projectId"=nullif(current_setting(''app.project_id'',true),'''')::uuid)', table_name);
  END LOOP;
END $$;
```

- [ ] **Step 2: Add Prisma models** to `schema.prisma` (mirror the SQL: `@db.Uuid`, `@db.Timestamptz(3)`, `BigInt` for `costMicros`, relation `AgentRun.project` to `Project` via `[workspaceId, projectId]`, `AgentSpan.run` via `[workspaceId, projectId, runId]` → `AgentRun.[workspaceId, projectId, id]` with `@@unique([workspaceId, projectId, id])` on `AgentRun`; back-relations on `Project`). Add the four nullable fields to `BudgetReservation`.

- [ ] **Step 3: Grant** — add `"AgentRun"` and `"AgentSpan"` to the `business` array in `scripts/db-deploy.ts`.

- [ ] **Step 4: Validate schema/migration parity on a disposable database**

Run: `corepack pnpm db:generate && corepack pnpm typecheck`
Then apply to the local test database (sourced env; migration URLs point to localhost only):

```bash
set -a; . ../../../.runtime/local.env; set +a
MIGRATION_DATABASE_URL="$TEST_MIGRATION_DATABASE_URL" DATABASE_URL="$TEST_DATABASE_URL" AUTH_DATABASE_URL="$TEST_AUTH_DATABASE_URL" corepack pnpm exec tsx scripts/db-deploy.ts
```

Expected: migration `202609300001_agent_telemetry` applied, role checks pass. Then `corepack pnpm exec prisma migrate diff --from-migrations packages/db/prisma/migrations --to-schema packages/db/prisma/schema.prisma --script --config packages/db/prisma.config.ts` shows no table/column drift (RLS/check constraints are SQL-only, as in earlier migrations).

- [ ] **Step 5: Run migration profile test** — `corepack pnpm test:migration-profile` (disposable DB, forced RLS verification). Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db scripts/db-deploy.ts
git commit -m "feat: add agent telemetry tables and budget attribution columns"
```

---

### Task 3: Telemetry module

**Files:**
- Create: `apps/api/src/modules/telemetry.ts`, `apps/api/tests/telemetry.integration.test.ts`

**Interfaces:**
- Produces:

```ts
export type RunKind = "chat" | "generation" | "retrieval" | "ingestion" | "reindex" | "evaluation" | "image";
export type SpanInput = {
  type: "model_call" | "tool_call" | "embedding" | "image";
  name: string; model?: string; status: "succeeded" | "failed" | "unknown" | "blocked";
  errorCode?: string; attempt?: number; startedAt: Date; durationMs: number;
  usage?: { inputTokens: number; cachedTokens: number; cacheWriteTokens: number; outputTokens: number; reasoningTokens: number } | null;
  costMicros?: number | null; budgetReservationId?: string | null; providerResponseId?: string | null;
  inputHash?: string; outputHash?: string; parentSpanId?: string;
};
export async function startRun(scope: Scope, input: { kind: RunKind; agentName: string; taskClass: string; subjectType?: string; subjectId?: string; missionId?: string | null }): Promise<string | null>;
export async function recordSpan(scope: Scope, runId: string | null, span: SpanInput): Promise<void>;
export async function finishRun(scope: Scope, runId: string | null, status: "succeeded" | "failed" | "blocked" | "canceled" | "unknown", errorCode?: string): Promise<void>;
export function hashText(value: string): string; // sha256 hex
export function errorCode(error: unknown): string; // DomainError code or "UNEXPECTED"
```

`startRun` returns `null` if the insert fails; `recordSpan`/`finishRun` are no-ops for `null` and never throw. Each call runs in its own `scoped()` transaction. Failures are reported once via `console.error("Orbit telemetry write failed", code)` with the error class name only.

- [ ] **Step 1: Write failing integration tests** (`telemetry.integration.test.ts`, `describe.skipIf(!process.env.TEST_DATABASE_URL)`), creating two synthetic projects with `authDb` like `chat-runner.integration.test.ts` does:
  1. `startRun` → `recordSpan` (with usage and cost) → `finishRun("succeeded")` stores one run with `durationMs ≥ 0` and one span with the token columns.
  2. RLS: a `scoped()` read under project B returns zero `AgentRun`/`AgentSpan` rows of project A.
  3. Failure tolerance: `recordSpan(scope, randomUUID(), …)` for a non-existent run (FK violation) resolves without throwing and writes nothing; `startRun` with an invalid scope returns `null`.
  4. `recordSpan` rejects prompt text: calling it with a `name` longer than 120 characters truncates to 120.

- [ ] **Step 2: Run to verify failure** — `corepack pnpm exec vitest run apps/api/tests/telemetry.integration.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `apps/api/src/modules/telemetry.ts` using `scoped` from `packages/db/src/index.ts`, `randomUUID`, `createHash`. Wrap every body in:

```ts
async function safely<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    console.error("Orbit telemetry write failed", error instanceof Error ? error.name : "unknown");
    return fallback;
  }
}
```

`finishRun` sets `endedAt = now()` and `durationMs = now - startedAt` via one `updateMany` scoped to the project. `name` and `errorCode` are sliced to 120 characters.

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: add failure-tolerant agent telemetry recorder"`

---

### Task 4: Attribution and chat instrumentation

**Files:**
- Modify: `apps/api/src/modules/budget.ts` (`reserve`), `apps/api/src/modules/chat-runner.ts`
- Test: `apps/api/tests/chat-runner.integration.test.ts`

**Interfaces:**
- Consumes: `computeCost`, `normalizeResponsesUsage` (Task 1); `startRun`, `recordSpan`, `finishRun`, `hashText`, `errorCode` (Task 3).
- Produces: `reserve(tx, scope, key, category, amount, policy, now?, runKey?, attribution?: { agentRunId?: string | null; taskClass?: string; model?: string; missionId?: string | null })`.

- [ ] **Step 1: Failing tests** in `chat-runner.integration.test.ts`:
  1. After a normal two-call run: exactly one `AgentRun` with `kind='chat'`, `subjectType='chat_run'`, `subjectId=<runId>`, `status='succeeded'`; two `model_call` spans with `model`, token counts, `costMicros` equal to the settled reservation amounts and `budgetReservationId` set; one `tool_call` span per executed tool with `durationMs ≥ 0`.
  2. Every `chat_text` reservation of the run has `agentRunId` = that run, `taskClass='chat_operator'`, `model` set.
  3. With the mock usage lacking `input_tokens_details`, settled cost equals `computeCost` with `detailsKnown:false` (input at 1.25× in the test rate card).
  4. Telemetry failure: mock `recordSpan` to throw once (via `vi.spyOn` on the telemetry module) — the run still ends `succeeded`, reservations `settled`.
  5. Incomplete mode: run `failed`/`blocked` with `errorCode='CHAT_MODEL_OUTPUT_LIMIT'`, one `model_call` span `status='unknown'`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**
  - `reserve`: accept `attribution` and pass `agentRunId`, `taskClass`, `model`, `missionId` into `budgetReservation.create`.
  - `chat-runner.ts`:
    - At run start: `const agentRunId = await startRun(scope, { kind: "chat", agentName: "orbit_operator", taskClass: "chat_operator", subjectType: "chat_run", subjectId: runId });`
    - Pass `{ agentRunId, taskClass: "chat_operator", model }` to `reserve`.
    - Record `const callStartedAt = new Date()` before `streamChat`; after settlement: `await recordSpan(scope, agentRunId, { type: "model_call", name: "responses.stream", model, status: "succeeded", startedAt: callStartedAt, durationMs: Date.now() - callStartedAt.valueOf(), usage, costMicros: actual, budgetReservationId: reservationId, providerResponseId: completed.id })` where `usage = normalizeResponsesUsage(completed.usage)` and `actual = computeCost(prepared.model, usage, prepared.runtime)` (replaces the old `estimateCost` settlement).
    - Around each tool execution: record a `tool_call` span with `name` = tool name, status from the outcome, `inputHash: hashText(call.arguments)`.
    - In the existing error paths that settle `null`: record a `model_call` span with `status: "unknown"` and `errorCode`.
    - In the final status block: `await finishRun(scope, agentRunId, <mapped status>, errorCode)`, mapping chat statuses `succeeded|blocked|failed|canceled` directly.

- [ ] **Step 4: Run** `corepack pnpm exec vitest run apps/api/tests/chat-runner.integration.test.ts apps/api/tests/chat.integration.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: trace and attribute Orbit Chat model and tool calls"`

---

### Task 5: Instrument generation, retrieval, ingestion, reindex, evaluation and images

**Files:**
- Modify: `apps/api/src/modules/generation.ts`, `retrieval.ts`, `ingestion.ts`, `reindex.ts`, `index-evaluation.ts`, `image-generation.ts`
- Test: `apps/api/tests/paid.integration.test.ts`

**Interfaces:** consumes Task 3 and Task 4 (`reserve` attribution).

| Module | Run kind / taskClass | Span | Attribution |
| --- | --- | --- | --- |
| `generation.ts` (`generateMissionLive`) | `generation` / `draft_social` or `draft_blog` from mission content type; subject `job` | `model_call` `responses.create` with `outcome.usage`, `outcome.responseId` | `missionId`, model |
| `retrieval.ts` (query embedding) | `retrieval` / `query_embedding`; subject `retrieval_key` | `embedding` | model |
| `ingestion.ts` (`embedDocument`) | `ingestion` / `document_embedding`; subject `document_version` | `embedding` per batch | model |
| `reindex.ts` | `reindex` / `index_build`; subject `index_generation` | `embedding` per batch | model |
| `index-evaluation.ts` | `evaluation` / `index_evaluation`; subject `index_generation` | `embedding` | model |
| `image-generation.ts` | `image` / `image_generation`; subject `asset_request` | `image` with `costMicros: null`, status `unknown` cost | model |

Generation passes its run ID into retrieval so the query-embedding reservation gets the same `agentRunId`: add an optional `agentRunId` parameter to the retrieval helper used by generation, and skip creating a separate retrieval run in that case (record the embedding span under the generation run).

- [ ] **Step 1: Failing tests** in `paid.integration.test.ts` (existing mocked-provider setup):
  1. A successful mission generation creates one `generation` run with one `embedding` span (query) and one `model_call` span; both reservations carry that `agentRunId` and the mission ID.
  2. A generation whose mocked `generate` throws leaves the reservation `unknown`, the span `unknown` and the run `failed` with `MODEL_OUTCOME_OR_COST_UNKNOWN`.
  3. Existing assertions (`settled(category, cost)`) stay unchanged and pass.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per the table. Mocks of `generate` in tests must return the extended `Usage` (add the three counts as `0` and `responseId: "resp_test"`).
- [ ] **Step 4: Run** `corepack pnpm exec vitest run apps/api/tests/paid.integration.test.ts apps/api/tests/safety.integration.test.ts apps/api/tests/live-draft-once.integration.test.ts apps/api/tests/draft-batch.integration.test.ts packages/knowledge/tests` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: trace generation, embedding and image calls with budget attribution"`

---

### Task 6: Read endpoints for runs and cost

**Files:**
- Create: `apps/api/src/modules/ai-usage.ts`
- Modify: `apps/api/src/server.ts` (two routes next to `/operations`), `apps/api/src/openapi.ts` if route schemas are declared there
- Test: `apps/api/tests/telemetry.integration.test.ts` (extend), `apps/api/tests/auth.integration.test.ts` (viewer denial)

**Interfaces:**
- `GET /api/projects/:projectId/agent-runs?cursor=<uuid>&kind=<kind>` → `{ runs: Array<{ id, kind, agentName, taskClass, subjectType, subjectId, missionId, status, errorCode, startedAt, durationMs, modelCalls, toolCalls, inputTokens, cachedTokens, cacheWriteTokens, outputTokens, reasoningTokens, costMicros }>, nextCursor: string | null }` — 50 per page, newest first, aggregates from spans.
- `GET /api/projects/:projectId/ai-cost?from=<ISO>&to=<ISO>&groupBy=day|category|model|taskClass|mission` → `{ from, to, groupBy, rows: Array<{ key: string | null, reservedMicros: string, settledMicros: string, unknownMicros: string, count: number }> }`. BigInt values serialized as strings. Default range: current UTC month; maximum range 93 days (`RANGE_TOO_LARGE`).
- Both require `scopeFor(auth, req, projectId, true)` (editor or owner).

- [ ] **Step 1: Failing tests**: pagination and aggregation correctness on seeded runs/spans; `groupBy=model` sums settled and in-flight/unknown separately; viewer gets 403, other project gets 404/403 as existing routes do; invalid `groupBy` → 400.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** queries with Prisma `groupBy` on `BudgetReservation` (day grouping via `$queryRaw` with `date_trunc('day', "createdAt" AT TIME ZONE 'UTC')`, parameterized) and span aggregates via `agentSpan.groupBy({ by: ["runId"], _sum: …, _count: … })`.
- [ ] **Step 4: Run tests**, then `corepack pnpm api:generate` and commit the regenerated `packages/schemas/openapi.json` and `packages/api-client/src/generated.ts`.
- [ ] **Step 5: Commit** — `git commit -m "feat: expose agent runs and AI cost summaries to project editors"`

---

### Task 7: Structured, redacted API logging

**Files:**
- Modify: `apps/api/src/server.ts:194-197` (`buildServer` signature and Fastify options)
- Test: `apps/api/tests/logging.unit.test.ts` (new; needs `DATABASE_URL` env like other server tests — use `describe.skipIf(!process.env.TEST_DATABASE_URL)`)

**Interfaces:** `buildServer(diagnostic?: (error: unknown) => void, options?: { logStream?: NodeJS.WritableStream })`.

- [ ] **Step 1: Failing test**: build the server with a `PassThrough` log stream, inject `GET /api/google-drive/callback?code=secret-code&state=secret-state` with headers `cookie: orbit.session_token=secret-cookie` and `authorization: Bearer secret-token`, then assert the captured log lines contain the path `/api/google-drive/callback`, a `reqId`, the status code, and none of `secret-code`, `secret-state`, `secret-cookie`, `secret-token`.
- [ ] **Step 2: Run** → FAIL (logger disabled).
- [ ] **Step 3: Implement**

```ts
const app = Fastify({
  bodyLimit: 1500000,
  trustProxy: false,
  genReqId: () => randomUUID(),
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    ...(options?.logStream ? { stream: options.logStream } : {}),
    redact: { paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'], censor: "[redacted]" },
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, path: String(req.url).split("?")[0] }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  },
});
```

  Keep existing error handling; add `req.log.error({ code }, "request failed")` in the error handler with the domain code only (no error message or stack for domain errors). Document `LOG_LEVEL` in `.env.example`.
- [ ] **Step 4: Run** the logging test and `apps/api/tests/auth.integration.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: enable structured redacted API request logging"`

---

### Task 8: Documentation and full verification

**Files:** `docs/MODEL_ROUTING.md`, `docs/OPERATIONS.md`, `docs/API_CONTRACT.md`, `docs/adr/0003-cost-accounting.md`, `docs/OPENAI_AGENT_PLATFORM_ALIGNMENT_PLAN.md` §17, `docs/IMPLEMENTATION_STATUS.md`.

- [ ] **Step 1: Document**
  - `MODEL_ROUTING.md`: rate card v2 fields and defaults; settlement formula; conservative estimate (input at cache-write rate); effect on proposal ceilings.
  - `ADR 0003`: addendum "2026-09-30: cache-aware settlement" with the formula and unknown-details rule.
  - `OPERATIONS.md`: telemetry tables, endpoints, `LOG_LEVEL`, what is and is not logged, how to read cost per model/mission.
  - `API_CONTRACT.md`: the two endpoints.
  - Plan §17 and `IMPLEMENTATION_STATUS.md`: Phase 1 progress entry with test counts.
- [ ] **Step 2: Full verification**

```bash
set -a; . ../../../.runtime/local.env; set +a; unset OPENAI_API_KEY
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build && corepack pnpm secrets:check && corepack pnpm framework:check
```

Expected: all pass except the known local worker-lifecycle timeout unless the parallel pump fix has landed; record the exact counts.
- [ ] **Step 3: Security self-review** against `.agentic/quality-gates/security-checklist.md` (no secrets/prompts in telemetry or logs, RLS on new tables, authz on endpoints).
- [ ] **Step 4: Commit and push**

```bash
git add docs
git commit -m "docs: record phase 1 observability and cost foundation"
git push
```

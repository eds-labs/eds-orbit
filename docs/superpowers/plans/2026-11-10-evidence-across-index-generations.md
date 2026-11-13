# Evidence Across Index Generations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evidence from a live-evaluated index generation stays valid after another generation is activated, as long as every cited item still passes its existing checks.

**Architecture:** One new predicate in `packages/knowledge/src/indexes.ts` decides whether an evidence pack's origin generation qualifies. `validateEvidence` in `packages/knowledge/src/index.ts` calls it only when `indexId` differs from the active index. The predicate replaces the plain id comparison; nothing else in validation changes.

**Tech Stack:** TypeScript, Prisma over PostgreSQL (scoped transactions with row-level security), Vitest integration tests.

**Spec:** `docs/superpowers/specs/2026-11-10-evidence-across-index-generations-design.md`

## Global Constraints

- No schema change, no migration, no provider call, no new cost, no feature flag.
- The reason code stays `index_generation_changed`, and its web texts stay unchanged.
- Freshness window: reuse `EVALUATION_MAX_AGE_MS` (30 days) from `indexes.ts`; do not copy the number.
- The origin qualifies only if `evaluation.passed === true`, `evaluation.provenance === "live"`, `evaluation.manifestHash === index.manifestHash`, `executedAt <= evidence.createdAt` and `evidence.createdAt - executedAt <= EVALUATION_MAX_AGE_MS`.
- `activatedAt` is not checked, because a rollback overwrites it.
- Evidence without `indexId` keeps today's behaviour: the check is skipped.
- Item-level checks, `validateActiveIndexEvaluation`, activation and rollback stay exactly as they are.
- Code comments and docs in English.

## Review Focus

1. A malformed origin evaluation record (`executedAt` not a date, or fields missing) must count as not evaluated: fail closed, never throw.
2. Evidence missing `createdAt` or with an unparsable `createdAt` must fail closed with `index_generation_changed` when the ids differ.
3. A missing origin index (deleted, or an id from another project) must give `index_generation_changed`, not an exception. The lookup is scoped by workspace and project.
4. With a qualifying origin, a broken citation must still be reported by its item reason (`chunk_unavailable`), and `index_generation_changed` must not hide or replace it.
5. After a rollback to the origin generation (ids equal again), the evidence stays valid, so the `activatedAt` overwrite does not matter.

Tests for 1 to 5 are in Task 1.

---

### Task 1: Origin-generation rule in `validateEvidence`

**Files:**
- Modify: `packages/knowledge/src/indexes.ts` (new exported function after `currentEvaluationConfig`, which starts at line 472; `EVALUATION_MAX_AGE_MS` is at line 471)
- Modify: `packages/knowledge/src/index.ts:913-914` (the `index_generation_changed` check)
- Test: `packages/knowledge/tests/index-generations.integration.test.ts` (new `it` placed directly **before** `"revocation purges every vector generation…"`, which purges the fixture)
- Modify: `docs/KNOWLEDGE_ARCHITECTURE.md` (sections "Controlled index generations", line 61, and the `validateEvidence` paragraph, line 53)
- Modify: `docs/IMPLEMENTATION_STATUS.md` (one entry dated 2026-11-10)

**Interfaces:**
- Consumes: `getActiveIndex(tx, s)`; `EVALUATION_MAX_AGE_MS`; `EvidenceData.indexId?: string` and `EvidenceData.createdAt: string`.
- Produces: `export async function evidenceOriginEvaluated(tx: DbTx, s: Scope, indexId: string, evidenceCreatedAt: string): Promise<boolean>` in `indexes.ts`. It is re-exported through `export * from "./indexes.js"`.

**Prerequisite (once per worktree):** `corepack pnpm install --frozen-lockfile`, `./node_modules/.bin/prisma generate --config packages/db/prisma.config.ts`, then `node scripts/test-db-for-worktree.ts`. These need the local Postgres container on 127.0.0.1:55432. If it is gone (it was on 2026-11-03), stop and ask Mario before running `pnpm local:setup`.

- [ ] **Step 1: Write the failing test** `it("keeps evidence from a live-evaluated generation valid after a switch", …)`

At entry, `smallId` (1536) is active and `largeId` (3072) is retired; both hold synthetic evaluations. Set up:
- Save `before = { small, large }` (each index row's `evaluation` JSON).
- Helper `setEvaluation(id, patch)`: `tx.knowledgeIndex.update({ where: { id }, data: { evaluation: { ...current, ...patch } } })`.
- `markLive(id, executedAt: Date)` = `setEvaluation(id, { provenance: "live", executedAt: executedAt.toISOString() })`.
- `reasons = async (id) => (await run((tx) => validateEvidence(tx, s, id))).reasons`.

Sequence and assertions:
1. `markLive(smallId, now - 1 day)`. `ev = retrieve(…, query "INDEXGEN728", purpose "public", queryVector vector(1536), profile EMBEDDING_PROFILE)`. Expect `ev.data.indexId === smallId`.
2. `markLive(largeId, now - 1 hour)`, then `rollbackIndexGeneration(tx, s, largeId, { allowSyntheticForTest: true })`. Expect `validateEvidence(ev.id)` to be `{ valid: true, reasons: [] }`.
3. Clone `ev` as a new `evidence` entity with `items[0].chunkId = randomUUID()`. Expect `reasons(clone)` to contain `"chunk_unavailable"` and not `"index_generation_changed"` (Review Focus 4).
4. `setEvaluation(smallId, { executedAt: ev.createdAt - 31 days })`. Expect `reasons(ev)` to contain `"index_generation_changed"`.
5. `setEvaluation(smallId, { executedAt: ev.createdAt + 60 s })`. Expect `"index_generation_changed"`.
6. `setEvaluation(smallId, { executedAt: "not-a-date" })`. Expect `"index_generation_changed"`, and the call does not throw (Review Focus 1).
7. `markLive(smallId, now - 1 day)` plus `setEvaluation(smallId, { manifestHash: "other" })`. Expect `"index_generation_changed"`.
8. `markLive(smallId, now - 1 day)` plus `setEvaluation(smallId, { provenance: "synthetic_test" })`. Expect `"index_generation_changed"`.
9. Clone `ev` with `createdAt` removed. Expect `"index_generation_changed"` (Review Focus 2).
10. Clone `ev` with `indexId = randomUUID()`. Expect `"index_generation_changed"` (Review Focus 3).
11. `markLive(smallId, now - 1 day)`, then `rollbackIndexGeneration(tx, s, smallId, { allowSyntheticForTest: true })`. Expect `validateEvidence(ev.id).valid === true` (Review Focus 5).
12. In `finally`: make sure `smallId` is active, then write `before.small` and `before.large` back, so the following tests see the fixture unchanged.

Steps 1 to 3, 11 and 12 rely on activation accepting a `live` record without receipts. `activateIndexGeneration` checks only `currentEvaluationConfig`, so it does.

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run packages/knowledge/tests/index-generations.integration.test.ts -t "live-evaluated generation"`
Expected: FAIL at assertion 2. `reasons` is `["index_generation_changed"]`.

- [ ] **Step 3: Implement `evidenceOriginEvaluated(tx, s, indexId, evidenceCreatedAt): Promise<boolean>` in `indexes.ts`**

Use `tx.knowledgeIndex.findFirst({ where: { ...where(s), id: indexId } })`. Read the evaluation as `Record<string, unknown> | null`. Return `true` only when every condition in Global Constraints holds. Parse both timestamps with `Date.parse` and return `false` if either is `NaN`. Do not throw. Add a short doc comment that names the spec.

- [ ] **Step 4: Use it in `validateEvidence` (`index.ts:913-914`)**

Replace the condition with: `d.indexId`, the active id differs, and `!(await evidenceOriginEvaluated(tx, s, d.indexId, d.createdAt))`. Then push `"index_generation_changed"`. Import the function from `./indexes.js` next to `getActiveIndex`.

- [ ] **Step 5: Run the file and verify everything passes**

Run: `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run packages/knowledge/tests/index-generations.integration.test.ts`
Expected: all tests PASS, including the existing `oldEvidence` assertion (`index_generation_changed` for a synthetic origin) and the revocation test after the new one.

- [ ] **Step 6: Update the docs**

- `KNOWLEDGE_ARCHITECTURE.md` line 61: replace "execution preflight refuses evidence from a different active generation" with this rule: evidence from another generation passes only if that generation's stored evaluation passed, is `live`, belongs to its manifest and was at most 30 days old when the evidence was created; item checks still apply.
- Line 53: add one sentence saying that the item checks cover knowledge changes and the origin generation's live evaluation covers retrieval quality.
- `IMPLEMENTATION_STATUS.md`: an entry with the date, the summary and the spec link.

- [ ] **Step 7: Commit**

```bash
git add packages/knowledge/src/indexes.ts packages/knowledge/src/index.ts packages/knowledge/tests/index-generations.integration.test.ts docs/KNOWLEDGE_ARCHITECTURE.md docs/IMPLEMENTATION_STATUS.md
git commit -m "fix(knowledge): keep evidence from a live-evaluated generation valid after index activation"
```

(The commit message ends with the attribution line from the session.)

### Task 2: Full verification and delivery handoff

**Files:** none changed, unless a check fails.

- [ ] **Step 1: Run the callers' suites that cover `EVIDENCE_INVALID`**

Run: `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run apps/api/src/modules/marketing packages/knowledge apps/api/tests/rls-matrix.integration.test.ts apps/api/tests/access-matrix.integration.test.ts`
Expected: PASS. A failure that expects `index_generation_changed` for a *live* origin is an intended change: report it and do not edit the test silently.

- [ ] **Step 2: Run the standard checks**

Run: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Use the pnpm shim from `corepack enable --install-directory <scratchpad>/bin pnpm` if `pnpm` hangs.
Expected: all green. Revert any touched `evals/knowledge/last-deterministic-run.json` and `apps/web/next-env.d.ts`.

- [ ] **Step 3: Integrate `origin/main` and stop for approval**

`git fetch origin && git merge origin/main` (fast-forward history, no force push). Re-run Step 1 if `main` touched `packages/knowledge` or Marketing policy.
Then **stop**: report the results to Mario and ask before `git push origin HEAD:main`, because a push deploys production. No schema hash is needed (no migration).

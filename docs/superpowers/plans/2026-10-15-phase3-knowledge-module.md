# Phase 3: Knowledge Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Knowledge as a module (WP3.1–WP3.5): the engine stops writing marketing state, a platform knowledge facade serves every consumer, the knowledge module owns its routes and UI, and marketing owns its fact consumers.

**Architecture:** `packages/knowledge` stays the engine. `apps/api/src/platform/knowledge/*` becomes the permission- and budget-aware facade that binds the registered impact handlers. `apps/api/src/modules/knowledge/*` and `apps/web/src/modules/knowledge/*` own management. Marketing reacts to knowledge changes only through a registered impact handler that runs in the caller's transaction.

**Tech Stack:** TypeScript (Node 24), Fastify, Prisma/Postgres with RLS, Vitest (unit, integration, snapshot), Playwright, Next.js web app.

**Spec:** `plans/orbit-modularization/05-knowledge-migration.md` (design), `plans/orbit-modularization/07-roadmap.md` §Phase 3 (work packages, acceptance), ADR `docs/adr/0009-modular-platform.md`.

## Global Constraints

- Risk class: WP3.1 **high** (a missed invalidation makes revoked evidence publishable); WP3.2 medium (K-1 behaviour change); WP3.3–WP3.5 medium. Environment: local only; every production deployment needs Mario's explicit approval per step.
- No table, kind or column is renamed, moved or rewritten. No migration in WP3.1–WP3.4. WP3.5 adds only an optional JSON attribute.
- Invariants I1–I7 (`04` §1): URLs, response shapes, error codes, hashes, prompts, queue classes, budget keys and flags stay the same.
- Impact handlers run in the caller's transaction and run even when marketing is disabled for the project (`05` §4).
- The active index generation, its manifest hash and its evaluation must stay valid (`INDEX_EVALUATION_CORPUS_CHANGED` blocks live publishing).
- Boundary baseline stays 0 (`scripts/boundaries.json`).
- Code comments and docs in English.

## Review Focus

1. A handler throws mid-cascade: the whole engine call rolls back; no evidence is left invalidated without its content. Pinned in Task 1 (`rolls back evidence when an impact handler throws`).
2. A composition root that never registered modules (a script, a new worker) calls the engine: it must fail closed with `MODULE_CONTRIBUTIONS_NOT_REGISTERED`, never skip marketing invalidation. Pinned in Task 2 (`registeredImpactHandlers fails closed`), and `scripts/backup-restore-test.ts` registers modules.
3. Marketing disabled for the project: revoking a source still invalidates its content. Pinned in Task 2 (`registeredImpactHandlers ignores module activation`).
4. Records related to a source without any evidence (insights with `sourceIds`, jobs with `resourceId = sourceId`): still invalidated when `evidenceIds` is empty. Covered by the characterization fixture (`insight-source`, `job-source-queued`), so the handler must run unconditionally.
5. HTTP responses of `withdraw-fact`, `revoke-source`, `source-rights`, `revoke-document`: the `impact` object keeps `{ evidenceIds, contentIds }`. Pinned in Task 1 (engine returns handler-reported `contentIds`) and the existing `core`/`safety` suites.

---

## WP3.1 Invalidation impact handlers (detailed)

Risk analysis: the cascade moves verbatim; the danger is a call path that runs the engine without the marketing handler. Mitigations: the engine parameter is required (type error when missing), the platform wrapper reads the registry which fails closed, and every test and script switches to the wrapper. Test strategy: WP0.4 snapshots unchanged, engine handler tests, registry tests, full `core`/`safety`/`knowledge.integration` suites. Rollback: redeploy the previous image; no schema change.

### Task 1: Engine keeps Part A and calls impact handlers

**Files:**
- Modify: `packages/knowledge/src/types.ts` (new types)
- Modify: `packages/knowledge/src/index.ts:101-279` (`invalidate`) and the six exported callers
- Test: `packages/knowledge/tests/knowledge.integration.test.ts`

**Interfaces:**
- Produces (in `types.ts`, exported):
  - `type KnowledgeImpact = { sourceId: string; reason: string; factId?: string; purge: boolean; evidenceIds: readonly string[] }`
  - `type ImpactResult = { contentIds?: readonly string[] }`
  - `type ImpactHandler = (tx: DbTx, s: Scope, impact: KnowledgeImpact) => Promise<ImpactResult | void>`
- Produces (engine signatures, new trailing required parameter `handlers: readonly ImpactHandler[]`): `ingest(tx, s, input, handlers)`, `setFact(tx, s, input, handlers)`, `withdrawFact(tx, s, id, version, handlers)`, `revokeSource(tx, s, sourceId, handlers)`, `setSourceRights(tx, s, id, rights, handlers)`, `revokeDocument(tx, s, id, handlers)`. Return types unchanged; `impact` stays `{ evidenceIds: string[]; contentIds: string[] }`, where `contentIds` is the de-duplicated union of what handlers report, in handler order.

- [ ] **Step 1: Write failing engine tests** in `knowledge.integration.test.ts`:
  - `passes affected evidence to every impact handler in order`: two recording handlers; `revokeSource` → both called once with `{ sourceId, reason: "source_revoked", purge: true, evidenceIds: [<evidence referencing the source>] }`, first before second.
  - `reports the content ids handlers return`: handler returns `{ contentIds: ["a"] }`, second returns `{ contentIds: ["a","b"] }` → `impact.contentIds` equals `["a","b"]`.
  - `calls handlers even when no evidence is affected`: source without evidence → handler called with `evidenceIds: []`.
  - `rolls back evidence when an impact handler throws`: handler throws inside `scoped()`; afterwards the evidence row still has `status: "ready"` and its version is unchanged.
- [ ] **Step 2: Run** `node --env-file=<main>/.runtime/local.env ./node_modules/vitest/vitest.mjs run packages/knowledge/tests/knowledge.integration.test.ts` → FAIL (type/arity).
- [ ] **Step 3: Implement.** `invalidate(tx, s, handlers, sourceId, reason, factId?, purge?)` keeps only the evidence loop (find, revise to `invalidated`, gaps, purge, version delete), then awaits each handler sequentially with the same `tx`, collecting `contentIds`. Thread `handlers` through the six exported functions. No marketing kind literal remains in `packages/knowledge/src`.
- [ ] **Step 4: Run** the engine test file → PASS. The characterization test now fails to typecheck until Task 2; that is expected.
- [ ] **Step 5: Commit** `refactor(knowledge): engine invalidates evidence and delegates dependents to impact handlers (WP3.1)`.

### Task 2: Marketing impact handler, registry and platform wrapper

**Files:**
- Create: `apps/api/src/modules/marketing/pipeline/knowledge-impact.ts`
- Create: `apps/api/src/platform/knowledge/engine.ts`
- Modify: `apps/api/src/platform/modules/contributions.ts` (field `knowledgeImpact`, function `registeredImpactHandlers`)
- Modify: `apps/api/src/modules/marketing/contributions.ts` (register the handler)
- Modify callers to import from the wrapper: `apps/api/src/server.ts`, `apps/api/src/modules/ingestion.ts`, `apps/api/src/modules/knowledge-import.ts`, `apps/api/src/modules/knowledge/actions.ts`, `scripts/backup-restore-test.ts` (also calls `registerModules()` first), and every test that calls the six functions (`grep -rn -E "\b(ingest|setFact|withdrawFact|revokeSource|setSourceRights|revokeDocument)\(" apps scripts`)
- Test: `apps/api/tests/module-registry.test.ts`, `apps/api/tests/knowledge-invalidation.characterization.integration.test.ts` (import switch only; snapshot file untouched)

**Interfaces:**
- Consumes: `ImpactHandler`, `KnowledgeImpact` (Task 1).
- Produces:
  - `invalidateMarketingForKnowledge: ImpactHandler` — Part B of the old `invalidate` verbatim (content `needs_review`, approvals `invalidated`, insights `retracted`, publications `blocked_dependency`/`reconciliation_required`, terminal receipts and finished jobs keep their status, purge fields, reconciliation job + outbox with key `knowledge-reconcile:<id>:<version+1>`); returns `{ contentIds }`.
  - `ModuleContributions.knowledgeImpact?: ImpactHandler`.
  - `registeredImpactHandlers(): readonly ImpactHandler[]` — platform first, then registry order; never filtered by activation; throws `MODULE_CONTRIBUTIONS_NOT_REGISTERED` before registration.
  - `platform/knowledge/engine.ts` exports `ingest`, `setFact`, `withdrawFact`, `revokeSource`, `setSourceRights`, `revokeDocument` with the old signatures (no handler parameter), each passing `registeredImpactHandlers()`.

- [ ] **Step 1: Write failing registry tests** in `module-registry.test.ts`: `registeredImpactHandlers returns the marketing handler` (contains `invalidateMarketingForKnowledge`); `registeredImpactHandlers ignores module activation` (function takes no enabled set; assert the list equals the full list after `registerModules()`); `registeredImpactHandlers fails closed` is covered by the existing `current()` guard — assert via a fresh module import with `vi.resetModules()` that it throws `MODULE_CONTRIBUTIONS_NOT_REGISTERED`.
- [ ] **Step 2: Run** the registry test → FAIL.
- [ ] **Step 3: Implement** handler, contribution field, `registeredImpactHandlers`, wrapper; switch all callers and test imports.
- [ ] **Step 4: Run** characterization (snapshots must pass without `-u`), registry, `core`, `safety`, `knowledge.integration`, `content-packages`, `paid` → PASS. Then `tsc --noEmit` → clean.
- [ ] **Step 5: Commit** `refactor(marketing): reproduce the knowledge invalidation cascade as an impact handler (WP3.1)`.

### Task 3: Boundary check forbids marketing kinds in the engine

**Files:**
- Modify: `scripts/boundaries.mjs` (function `checkForbiddenLiterals(files, config)`; wired into `checkRepository`, merged into `violations` as `forbidden-literal: <file> -> "<kind>"`)
- Modify: `scripts/boundaries.json` (`"forbiddenLiterals": { "package:knowledge": ["content", "approvals", "publications", "insights", "jobs"] }` with a `$comment`)
- Test: `scripts/boundaries.test.mjs`

- [ ] **Step 1: Failing tests:** `flags a forbidden kind literal in a zone` (`'kind: "content"'` in a `package:knowledge` file → one violation); `ignores the word outside a string literal and in other zones`.
- [ ] **Step 2: Run** `vitest run scripts/boundaries.test.mjs` → FAIL.
- [ ] **Step 3: Implement** a quoted-literal match (`"x"`, `'x'`, `` `x` ``) per configured zone.
- [ ] **Step 4: Run** the test and `node scripts/source-check.mjs` → PASS, baseline 0.
- [ ] **Step 5: Commit** `test(boundaries): forbid marketing kind literals in the knowledge engine (WP3.1)`.

### Task 4: Documentation and DoD

- [ ] `docs/IMPLEMENTATION_STATUS.md`: WP3.1 entry (behaviour unchanged, evidence, rollback). `docs/KNOWLEDGE_ARCHITECTURE.md`: invalidation now engine Part A + registered handlers. `docs/REQUIREMENTS_TRACEABILITY.md` if it lists invalidation.
- [ ] Run the full suite, `tsc --noEmit`, `node scripts/source-check.mjs`; revert `evals/knowledge/last-deterministic-run.json` if touched.
- [ ] Check `.agentic/quality-gates/definition-of-done.md`, `review-checklist.md`, `security-checklist.md`.
- [ ] Commit, push, open a PR to `main`. Merging deploys to production, so it needs Mario's approval.

---

## WP3.2–WP3.5 (outline; detailed plan per WP before it starts)

**WP3.2 Knowledge services (3–5 PT).** Move `retrieval.ts`, `ingestion.ts`, `reindex.ts`, `index-evaluation.ts` into `apps/api/src/platform/knowledge/` behind shims; one `knowledge_search` tool definition with an assistant and a specialist budget context (same budget keys as today, asserted by test); `usableFacts` in the facade. **Decision gate K-1:** before switching `listUsableFacts` to the full rules, run a read-only SQL (`scripts/rollout/`) against production and show Mario which facts the uLiquid assignment would lose; ship the switch only after his decision.

**WP3.3 Knowledge module server and web (4–6 PT).** Knowledge actions and routes move into `modules/knowledge` contributions (`server.ts` knowledge parts, `knowledge-import.ts`); web routes `/p/:id/knowledge/{overview,sources,…,inspector}` replace the nine local tabs; `EvidenceItems` moves to `web/platform/ui/evidence.tsx`; the "Marketing Memory" card becomes a marketing contribution. Acceptance: disabling knowledge is refused while marketing is enabled; the assistant can still search with both disabled; Playwright knowledge flows green.

**WP3.4 Marketing fact consumers (2–3 PT).** `fact-claims.ts`, `fact-placeholders.ts`, `mission-evidence.ts` are already under `modules/marketing/policy|pipeline`; remaining work is the tenant vocabulary (`fact-claims.ts:51-53`) read from the marketing profile with the in-code default when the field is absent, so no profile save is needed (a save would invalidate pending packages, see 12.10). Acceptance: `fact-claims`, `claim-repeat`, `safety` unchanged.

**WP3.5 Source audiences (2–3 PT, optional).** Optional `audiences` on `SourceData` (default all), consumer module in the retrieval context, filter in SQL eligibility. Before coding, confirm the attribute is outside the chunk manifest so the active evaluation stays valid.

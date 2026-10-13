# 05 — Extracting the Knowledge module

**Status:** Proposal, 2026-10-13. This step comes after the Platform/Marketing separation (`04`). Work package IDs refer to `07-roadmap.md`.

**Legend:** **[Fact]** current code · **[Proposal]** target · **[Open]** decision needed.

---

## 1. Starting point

**[Fact]** Knowledge is already the best-separated part of Orbit:

- `packages/knowledge` imports only `@orbit/db` (`packages/knowledge/src/index.ts:1`).
- Its tables are relational and dedicated: `KnowledgeDocument`, `DocumentVersion`, `KnowledgeChunk`, `ChunkEmbedding`, `KnowledgeIndex`.
- Its retrieval, index generations and evaluation gate are self-contained (`docs/KNOWLEDGE_ARCHITECTURE.md`).

There are three couplings to remove:

1. **Data-level inverse dependency.** `invalidate()` (`packages/knowledge/src/index.ts:101-279`) rewrites marketing entities (`content`, `approvals`, `publications`, `insights`, `jobs`) and creates reconciliation outbox rows.
2. **Orchestration depends on marketing.** `retrieval.ts`, `ingestion.ts`, `reindex.ts` and `index-evaluation.ts` import `policy.activePolicy`. Three of them also import `workflow.enqueue`.
   - After WP1.1 and WP1.2 (see `04`) this is already resolved, because `enqueue` and the spend mandate are in the platform.
3. **Mixed UI.**
   - `knowledge.tsx` imports `EvidenceItems` from the marketing `work.tsx` and shows a "Marketing Memory" card (`:139-142`).
   - Index management and fact withdrawal live in `operator-tools.tsx`.
   - Facts are read by marketing UI directly through `useCollection("facts")` (`work.tsx:1204-1207`, `advanced.tsx:60-62`, `management.tsx:1502-1505`).

## 2. Split: central knowledge infrastructure versus Knowledge module

**[Proposal] (AD-08)**

| Layer | Content | Location | Available when the Knowledge module is disabled? |
|---|---|---|---|
| **Knowledge engine** | Extraction, safe fetch, chunking, FTS/pgvector, RRF, index generations and evaluation gate, fact versioning/rights/conflicts, evidence packs, revocation, tombstones | `packages/knowledge` (unchanged, except `invalidate`) | yes |
| **Knowledge services** (platform) | Permission- and budget-aware facade: `retrieve`, `retrieveHybrid`, `validateEvidence`, `usableFacts`, `getFact`, `onImpact`. Embedding, reindex and evaluation job handlers. Periodic source sync scheduler contribution. Tool `knowledge_search`. | `apps/api/src/platform/knowledge/*` | yes: existing sources stay searchable for the assistant, marketing and support |
| **Knowledge module** | Management: sources CRUD, URL/file import, Import Center (JSON/CSV), facts editor and conflicts, document library, index management UI, health, inspector, revocation dialogs. Permission keys `knowledge.*`. | `apps/api/src/modules/knowledge/*`, `apps/web/src/modules/knowledge/*` | no (UI and management routes return `MODULE_DISABLED`) |
| **Marketing consumers** | Claims ledger (`checkClaims`), `fact-claims.ts`, `fact-placeholders.ts`, `mission-evidence.ts`, official link facts, `LIVE_RAG_EVAL_REQUIRED` publish gate, invalidation impact handler | `modules/marketing/*` | n/a |

**Why the services belong in the platform and not the module:**

- The assistant needs `knowledge_search` regardless of which modules are enabled.
- Marketing generation needs `retrieveHybrid` and `validateEvidence`.
- The future Support module needs RAG without depending on the knowledge management UI. The assignment requires this explicitly.

Keeping one service layer avoids parallel RAG implementations.

**Dependency direction:**

- Marketing has a hard dependency on the `knowledge` module, because facts must stay maintainable.
- Support has only an optional dependency on it, because it can use services only.
- The knowledge module never depends on marketing.

## 3. Ownership of existing assets

| Asset | Owner after Phase 3 | Notes |
|---|---|---|
| Kinds `sources`, `facts`, `evidence`, `revocations`, `sync_requests`, `retrieval_runs`, `index_evaluations`, `knowledge_imports` | knowledge (data owned by the services layer; management through the module) | No data move. `evidence` is created by retrieval and read by marketing through `validateEvidence` only. |
| Tables `Knowledge*`, `DocumentVersion`, `ChunkEmbedding` | knowledge | No change. Grants unchanged. |
| `ingestion.ts`, `retrieval.ts`, `reindex.ts`, `index-evaluation.ts` | platform/knowledge | Moved; logic unchanged. |
| `knowledge-import.ts` | module knowledge | |
| `lifecycle.ts` source-sync part (`:258-278`, `nextSweepAt` sync part) | platform/knowledge scheduler contribution | |
| Server actions `import`, `retrieve`, `revoke-source`, `source-pause`, `revoke-document`, `knowledge-import-*`, `withdraw-fact`, `begin/build/evaluate/activate/rollback-index`, `embed-document`; routes `knowledge-health`, `documents`, `indexes`; collections POST `sources` and `facts` | module knowledge | `retrieve` stays viewer-readable (`server.ts:1553`). |
| `chat-tools.ts:219-236` `knowledge_search`, `agent-tools.ts:412-440` agent variant | platform/knowledge tool | One definition with two budget contexts (assistant vs specialist). |
| `content-packages.ts:73-121` `usableFact`/`listUsableFacts` | replaced by `knowledgeServices.usableFacts` | Today it is a weaker re-implementation: it does not check source status or generation, language or market. The central version applies the full rules. **Behaviour change:** make it explicit and test it (see §5). |
| `fact-claims.ts`, `fact-placeholders.ts`, `mission-evidence.ts` | marketing | The tenant vocabulary in `fact-claims.ts:51-53` ("uliquid", "uliq", "desk") becomes data in the marketing profile (follow-up T-04). |
| Web `knowledge.tsx`, `operator-tools.tsx` (`IndexManagement`, `FactWithdrawal`) | `web/modules/knowledge/*` | The "Marketing Memory" card moves to marketing as a home or knowledge-slot contribution. |
| Web `EvidenceItems` | `web/platform/ui/evidence.tsx` | Used by marketing content detail and the knowledge inspector. |
| `google-drive.ts`, `google-drive.tsx` | **not knowledge** (platform connections and marketing assets) | [Fact] Drive does not feed knowledge today. |

## 4. Replacing `invalidate()` with impact handlers

**[Fact]** `invalidate()` is called in eight places:

- `ingest` (`:477`);
- fact change, supersede and conflict (`:583`, `:598`, `:613`);
- `withdrawFact` (`:960`);
- `revokeSource` with purge (`:979`);
- `setSourceRights` (`:1039`);
- `revokeDocument` with purge (`:1073`).

It runs inside the caller's `scoped()` transaction.

**[Proposal] (WP3.1)** Split it into two parts.

**Part A: stays in the knowledge engine.**
- Find evidence that references the source or fact.
- Mark that evidence `blocked_dependency` (or purge its excerpts).
- Compute `affectedEvidenceIds`.
- Write the knowledge-own revocation tombstones.

**Part B: moves to the marketing impact handler, registered through `onImpact`.**
- content → `needs_review` (purged fields: text, body, claims, subject, previewText, altText …);
- approvals → `invalidated`;
- insights → `retracted`;
- publications → `blocked_dependency` / `reconciliation_required`;
- reconciliation `jobs` and `Outbox` rows.

```ts
// packages/knowledge — engine stays free of module imports
export type ImpactHandler = (tx: DbTx, s: Scope, impact: KnowledgeImpact) => Promise<void>;
export async function revokeSource(tx, s, sourceId, opts, impactHandlers: ImpactHandler[]) { … }
// platform/knowledge passes registry.impactHandlers() into every engine call
```

**Equivalence.**
1. The handlers run **in the same transaction**, so atomicity is preserved.
2. The WP0.4 characterization tests pin the before/after entity states for every one of the eight call sites, both with and without purge.
3. The PR is accepted only if those tests are unchanged.

**Default when marketing is disabled.** Part B handlers are registered by the marketing manifest. If marketing is disabled for a project, its handler **still runs**: impact handlers protect data integrity, not features.

This is an explicit exception to "disabled modules do nothing". The reason is that a revocation must also invalidate content that was dormant while marketing was off. Otherwise re-enabling marketing could publish content backed by revoked evidence.

## 5. Behavioural changes to decide explicitly

These are not pure refactors. Each needs Mario's decision before it ships.

| # | Change | Recommendation |
|---|---|---|
| K-1 | `usableFact` adopts the full rules: source status and generation, language, market. Some facts accepted today could be rejected. | Do it. It is safer and aligns with retrieval. Before switching, run a read-only check that lists facts that would become unusable in production (SQL in `scripts/rollout/`). |
| K-2 | Bulk-imported facts are auto-verified (`knowledge-import.ts:84`). | Keep it for now: it is existing behaviour. Raise it as a separate decision (Q-08). |
| K-3 | Source "collections" or "audiences", so support-only sources are never used for marketing claims and vice versa. | Prepare it in WP3.5 as an optional attribute with the default "all". There is no behaviour change until a module sets it. |
| K-4 | Automatic embedding after ingest; document embedding profile following the active index profile (today pinned to small, `ingestion.ts:80`). | Treat as a separate feature, outside the modularization. List as follow-up T-05. |
| K-5 | Inspector uses hybrid retrieval instead of always-lexical (`knowledge.tsx:1599`). | Separate UX fix, T-06. |

## 6. Preserving data and permissions

- **No table or kind is renamed, moved or rewritten.** Ownership is a code mapping, so data loss is structurally excluded for this phase.
- **RLS is unchanged.** All knowledge tables keep FORCE RLS `project_scope`. The RLS matrix test (WP0.2) covers them.
- **Permissions** are reproduced through the catalogue (WP1.5):

  | Key | Today | Default roles |
  |---|---|---|
  | `knowledge.sources.manage` | owner collections `sources` (`server.ts:1382`) | `["owner"]` |
  | `knowledge.facts.manage` | owner collections `facts` | `["owner"]` |
  | `knowledge.index.manage` | index actions | `["owner"]` |
  | `knowledge.search` | `retrieve` | `["owner","editor","viewer"]` |

- **Export.** `/export` includes knowledge data today (`docs/KNOWLEDGE_ARCHITECTURE.md:51-53`). It stays a platform export that asks every module for its export section.
- **Index generations and evaluations** are untouched. The active generation, its manifest hash and its evaluation stay valid, because no chunk or manifest changes. This matters because any manifest change blocks live publishing (`INDEX_EVALUATION_CORPUS_CHANGED`).

## 7. Keeping marketing and the assistant working

| Consumer | After Phase 3 | Test |
|---|---|---|
| `generation.ts:358` `retrieveHybrid` | `knowledgeServices.retrieveHybrid` (same function, moved) | `core`, `paid`, `generation` evals offline |
| `policy.ts` `validateEvidence`, `checkClaims`, `validateActiveIndexEvaluation` | knowledge services | `safety`, `official-target-link`, `package-fact-duplicates` |
| Specialists research and strategy (`agentKnowledgeSearch`) | platform `knowledge_search` tool with specialist budget context | `specialists-analytics-research`, `specialist-strategy` |
| Assistant `knowledge_search` | platform tool, always loaded | `chat-runner`, `tool-search`, `evals/operator` |
| Readiness `CURRENT_PUBLIC_KNOWLEDGE_REQUIRED`, `LIVE_RAG_EVAL_REQUIRED` | knowledge readiness contributor | `drive-readiness`, `rollout-phase0` |
| Content packages `listUsableFacts` | `usableFacts` (K-1) | `content-packages`, `package-fact-duplicates`, `package-profile-limits` |

## 8. UI plan

`web/modules/knowledge/`:

- **Routes:** `/p/:id/knowledge/{overview,sources,sources/:sourceId,facts,facts/:factId,import,library,library/:documentId,health,inspector}`.
  - These replace the nine local tabs (`knowledge.tsx:66-76`).
  - "conflicts" becomes a filter on facts; "impact" merges into health. Today both duplicate other tabs.
- **Settings panel:** source defaults (maxAgeHours, sync interval) and index management.
- **Home tile:** source freshness, fact conflicts, index status.
- **Cross-module reads:** marketing pickers keep using the generic `facts` and `sources` collections. These stay readable while the knowledge module is enabled, which marketing guarantees through `dependsOn`. Long term they should use a small platform `useFacts()` hook backed by `usableFacts`.

## 9. Order and effort

| WP | Content | Effort (PT) |
|---|---|---|
| WP3.1 | Impact handler refactor of `invalidate()` | 3–4 |
| WP3.2 | Knowledge services facade, `knowledge_search` consolidation, `usableFacts` (K-1) | 3–5 |
| WP3.3 | Knowledge module: routes, actions, manifest, web module, URL tabs | 4–6 |
| WP3.4 | Marketing-specific fact consumers moved, tenant vocabulary to profile | 2–3 |
| WP3.5 | Source audiences (optional, prerequisite for support) | 2–3 |
| **Total** | | **14–21 person-days** |

**Prerequisites:**
- WP0.4 (characterization tests) before WP3.1.
- WP1.1 and WP1.2 (enqueue and spend mandate in the platform) before any move.
- WP1.6 (tool registry open) before WP3.2.
- WP1.7 (web shell) before WP3.3.

**Rollback:** WP3.1 is the only step with semantic risk. Its rollback is the previous image, because it introduces no schema change. All other steps are moves behind shims.

# RAG evaluation report

Dataset: `evals/knowledge/deterministic-v1.json`, version `2026-09-17.v1`: 64 synthetic DE/EN cases (48 lexical/exact-identifier retrieval cases, 16 source-purpose/time/revocation/project safeguards). Twelve separate paraphrase questions are in `semantic-v1.json` for an authorized live embedding evaluation. No real user data is in fixtures.

Implementation: `hybrid-rrf-v1`, `structure-v1`, exact PostgreSQL pgvector cosine baseline, profile `openai:text-embedding-3-small:1536:chunk-v1`. No ANN index is enabled. Synthetic vectors exercise SQL branch execution and RRF; they do not establish embedding-model semantic quality.

## Gates

- Live answered-case Recall@10 >= 0.90; measure MRR and source attribution independently.
- Zero foreign-project, revoked, forbidden-internal or forbidden-model material in corresponding negative tests.
- All deterministic fact-conflict, temporal, stale-version, import/revocation and publication-preflight blocks must pass.
- Record latency, context size, provider usage/cost, dataset/config/index version and commit for each actual run. Do not substitute the agent's evaluation of its own writing for retrieval measurement.

## Execution status

The initial implementation includes unit and isolated database tests in `packages/knowledge/tests`. Database tests require explicitly configured `TEST_DATABASE_URL` (nonprivileged app role) and `TEST_AUTH_DATABASE_URL` (limited auth role). The test suite never falls back to a production or general runtime URL. `last-deterministic-run.json` is written only by an actual configured database run and records measured timing; its existence alone is not a pass claim—use the corresponding test output.

Live embedding evaluation: **NOT YET PASSED**. The signed-in uLiquid production view on 2026-09-25 showed an active generation with zero embedded corpus chunks, one active website document with 124 extracted passages, and five stale sources. A paid chat call under the project's existing mandate does not prove embedding retrieval quality. The website source must be refreshed, its current permitted chunks embedded in a complete generation, and 60–120 independently labeled cases evaluated with settled provider receipts before the live gate can pass. Semantic Recall/MRR and real embedding cost remain unmeasured. Provider test vectors or lexical hits cannot authorize productive factual autopilot. Controlled profile generations are implemented and tested using explicitly synthetic vectors; normal activation requires a passed live evaluation and positive settled provider receipts. No alternative live profile has been evaluated or activated.

The measurements below come from executed local tests. No production or paid provider system was used.

## Local execution checkpoint — 2026-09-17

- `node node_modules/vitest/vitest.mjs run packages/knowledge/tests/algorithms.test.ts` under Node 24.18.0: **PASS_TEST**, 55/55, 610 ms runner duration. Real synthetic PDF and DOCX parser fixtures are included.
- The first run caught a compressed-IPv6 leading-segment validation bug; it was corrected and the complete affected suite rerun. `::`, loopback and IPv4-mapped IPv6 now fail closed.
- Independent source review found ZIP directory-count/duplicate-entry bypasses, an unbounded DNS phase and robots wildcard backtracking. All were corrected and executable regression cases pass. PDF parsing moved into a bounded child process; total native-memory acceptance remains a container resource-limit requirement.
- Prisma 7.10.0 schema validation and generated client: **PASS_TEST**. TypeScript reports no errors in the database/knowledge packages or database deployment command at this checkpoint. Whole-product checks belong to the integrated report.
- Real-role PostgreSQL 17 / pgvector 0.8.6 integration: **PASS_TEST**, 87/87 database tests (82 knowledge/SQL gold and five generation scenarios), plus 55 unit/parser tests: **142/142 total**. This includes all 64 DE/EN SQL gold cases, 18 lifecycle/security regressions and five index-generation scenarios. All migrations and role grants were applied to the new local `orbit` and `orbit_test` databases, followed by real-role privilege checks. Neither runtime role owns business tables or bypasses RLS.
- Gold cases: lexical Recall@8 **1.00**, lexical MRR **1.00**, negative safeguards **16/16**. Latest timing, dataset/code hashes, index/config/runtime and commit status are in `evals/knowledge/last-deterministic-run.json`; lexical gold metrics are separate from the synthetic-vector hybrid SQL regression.
- Document title-only and validity changes create new versions and invalidate previous evidence; three-way fact correction rejects incomplete groups and preserves predecessor histories; mandatory source restrictions apply to both SQL branches; revocation creates a worker-readable durable reconciliation job.
- Isolated backup/restore: **PASS_TEST**. `docs/BACKUP_RESTORE_TEST_RESULT.json` records the actual dump/restore, persistent tombstone/audit/uncertain-publication checks and absence of external writes or publishers. This does not validate production off-host backup operations.
- Whole-project `tsc --noEmit`: **PASS_TEST** at this checkpoint. Subsequent integrated changes must retain that check.

## Index-generation mechanics — executed, synthetic only

`packages/knowledge/tests/index-generations.integration.test.ts` builds a second small/1536 profile generation and a large/3072 generation, rejects incomplete builds and missing live cost receipts, evaluates exact SQL with public/internal permission fixtures, atomically activates a test generation, checks mixed-dimension isolation and evidence fencing, rolls back to an evaluated generation, and verifies that revocation deletes every vector copy and blocks stale build/rollback. Its 60-case mechanics fixtures are intentionally repetitive and **are not part of the semantic gold dataset or a claim of model quality**. No paid calls occur. Both migrations and updated least-privilege grants passed on the new local runtime/test databases.

An executed 64-case gold run at 2026-09-17T13:11:19.401Z recorded p50 33 ms, p95 40 ms, maximum estimated selected context 76 tokens and zero provider spend. These are small synthetic local fixtures with other test activity, not a production capacity benchmark. The repository had no commit at that time (`UNCOMMITTED_LOCAL_WORKTREE`). The exact knowledge source SHA-256 was `39248a1b40aca57d125c6347011606e38652461cb749bcc217ad68f6a4de8c7a`; dataset SHA-256 was `8bbd9c59ef15573989c11d745b9436335c7b9eacf78a0da8a0a9ba84df31f5dc`. The machine-readable result records subsequent actual reruns.

The six owned test files passed **165/165** together at the final combined checkpoint. A subsequent focused paid-workflow run passed **14/14** after adding completed-job resume coverage, bringing the distinct verified owned cases to **166**: 142 knowledge, 14 paid lifecycle, nine Matomo normalization/import and one Matomo transport. Whole-project `tsc --noEmit` passed at the combined checkpoint; final integrated verification is reported separately by the root workstream.

## Paid-call lifecycle regressions — real journal, mocked provider

`apps/api/tests/paid.integration.test.ts` executes the actual scoped PostgreSQL cost and evidence workflow with provider functions mocked locally. Fourteen scenarios pass, including: source/model-use withdrawal after a response; project pause during generation; expiry during generation; unknown provider outcome retaining a nonzero reservation; query-policy pause; document-embedding revocation; reindex rights quarantine; duplicate concurrent generation jobs; and resuming a completed job with identical content, one work package and no additional query/text charge. Actual successful mocked usage is settled before dependent output is refused, and a retry does not generate another query/model charge. Additional scenarios exercise shared query/text per-run limits, unresolved mission-state blocking, 64 evaluation queries in exactly two bounded batches, failed evaluation-budget/coverage gates and rights-change quarantine. Evaluation never activates its own index. The same mocked-provider test explicitly activates a completed fixture checkpoint only to test the release validator; no real model-quality proof is asserted. Runtime readiness requires an actual passed live-provenance record bound to the active profile/model/dimensions, retriever/chunk versions, dataset hash, current source/chunk manifest and positive settled index/dataset receipts, no older than 30 days. An environment flag alone fails, and expiry or source changes revoke the gate. This validates application settlement and fencing, not provider availability, real pricing, live model output or real billing.

Independent index review also identified two readiness gaps that were corrected and regressed: an alternate profile now requires an evaluated baseline checkpoint for truthful rollback, and live evaluation rejects unrelated/index-mismatched/dataset-mismatched spending receipts. Synthetic mechanics remain separate from live acceptance.

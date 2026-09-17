# EDS Orbit RC acceptance report

Date: 2026-09-17. Scope: the complete Unified Codex Master v3 and its read-only VPS appendix. Outcome: **integrated application RC passes local application and Linux standalone/shared-host acceptance. This is not live/provider or production approval.**

## Implemented product

EDS Orbit contains a real authenticated Next.js workspace and Fastify API, separate durable BullMQ workers, PostgreSQL 17/pgvector knowledge storage, restricted database roles and project RLS. The original EDS mark, Arctic Blue palette and Liquid Glass surfaces are used across desktop and mobile views.

The tested vertical path is source import → verified fact/current evidence → bounded mission → persisted work package/content → claims review → exact-version approval → durable test publication → source withdrawal impact → deterministic measurements/memory → bounded follow-up. Supporting functions include granular source/model/public rights, file/website/GitBook ingestion, conflict resolution, index generation/evaluation/rollback, channel adaptations, community imports/grouping, calendar blackouts, PNG templates, article/newsletter exports, Matomo/CSV reports, experiments, retention and fact/memory lifecycle controls, signed Slack decisions, project/workspace pause and actual Operations state.

Natural-language intake produces a clearly labeled conservative local proposal; the owner completes missing dates, audience, channels and numeric limits. It does not pretend to infer a paid marketing plan. Semantic duplicate protection is conservative evidence/claim overlap plus exact normalized text, not an unmeasured model-based novelty score. Automatic expensive escalation is disabled; unresolved claims require review.

## Executed evidence

| Area | Actual result | Evidence |
| --- | --- | --- |
| Application tests | **253/253 across 18 files**,18.81s | `docs/evidence/full-test.log`, `vitest-results.json` |
| Framework | **12/12** tests; full JSON Schema/YAML check **0 errors/0 warnings** | `framework-tests.log`, `framework-check.log` |
| Browser against production build | **4/4**,22.7s; installed Chrome, real localhost API/worker, desktop and 390px | `browser-tests.log`, `apps/web/tests/workspace.spec.ts` |
| Build and contracts | Next production build, whole-project/web TypeScript, source/lint guards, Prisma and OpenAPI/client generation passed | `web-build.log`, `typecheck.log`, `lint.log`, `api-generation.log` |
| Retrieval |64 versioned DE/EN synthetic SQL cases;142 knowledge/parser/index tests | `RAG_EVALUATION_REPORT.md`, `evals/knowledge/last-deterministic-run.json` |
| Paid-call controls |14 real-DB journal/race tests with mocked provider; no real spend | `apps/api/tests/paid.integration.test.ts` |
| Worker | Actual Redis queues, autonomous test publication, kill/restart, missing-follow-up isolation and source revocation | `worker-integration.log`, full-test results |
| Scheduling/auth |5 real SQL/API tests for repeated/missing DST hours, parallel channel quota/spacing, workspace-owner pause vs project editor | `apps/api/tests/scheduling.integration.test.ts` |
| Restore |Real pg_dump/pg_restore,303861bytes,456ms; paused Observe target and preserved tombstone/audit/unknown receipt/index configuration | `BACKUP_RESTORE_TEST_RESULT.json` |
| Supply chain |0 critical/high/moderate/low advisories at recorded audit;406 dependency/license entries | `dependency-audit.json`, `dependency-inventory.json`, `DEPENDENCY_RISKS.md` |
| Secrets |Bounded source pattern scan and generated public-artifact comparison against local credential values passed | `secret-scan.log`, `artifact-secret-scan.log` |
| Visuals |Seven actual screenshots, original-logo checksum and concept comparison | `VISUAL_FIDELITY.md`, `ASSET_MANIFEST.md`, `apps/web/design/actual` |
| Linux deployment |Fresh standalone and shared-host installations passed on linux/arm64; migrations, restricted roles, HTTPS auth, non-root/read-only runtime, enforced CPU/RAM/PID limits, four PNG formats and worker outage/recovery | `docs/evidence/container-acceptance.json`, `SHARED_HOST_DEPLOYMENT.md` |
| Existing infrastructure |Three current VPS inventoried read-only; measurements and unknown costs separated | `VPS_INVENTORY.md`, `RESOURCE_AND_COST_COMPARISON.md` |

The production-browser run repeats the same four workflows that passed against development in 25.4s. It covers knowledge/content/approval/revocation, reviewed-parent adaptation, mobile/keyboard/language/reduced motion, owner-created viewer with server403, editable briefs, community grouping/linkage, calendar release, fact withdrawal and missing-provider/operator boundaries. It does not send a provider message or pay for a model call.

The seven-day cycle is simulated time over real SQL functions with a mocked provider outage, an explicit pause/exception, source update, measured memory and finite follow-up. Real worker restart is a separate executable test. This is not seven elapsed production days or measured marketing performance.

## Corrections verified during acceptance

Review found and fixed paid-cost rollback and repeated transmission, combined-run budget undercount, stale document/index attachment, early saved-schedule dispatch, truncated safety history, approval/connector binding, interrupted remote state handling, terminal retries, parser/archive/network limits, authentication ID creation, runtime proxy/container paths, and several responsive UI issues.

The final integration run also exposed that one incomplete follow-up reference could abort the global queue pump. Missing content now creates a blocked mission/exception, each project sweep is isolated, and a real Redis regression proves independent valid work completes. All 253 tests subsequently passed. Historical earlier logs can contain failures; `full-test.log` and `vitest-results.json` are the canonical final application test result.

## Remaining gates

The 88-row matrix is `REQUIREMENTS_TRACEABILITY.md`: **79 PASS_TEST, 3 PASS_LIVE** (authorized existing-host read observations only), **6 BLOCKED_EXTERNAL, 0 NOT_RUN**. All executable internal acceptance gates are complete. The six external rows are A05, A14, A17, H07, H08 and K08.

The tested Linux image is `sha256:e86ed404b50794cf7e4fdbb7471bb20c79f19c07fc516ed24ec4817bcc4e1a2f` on ARM64. Shared-host application/database/Redis services publish no host ports; only the web service joins the external proxy network. The test proxy used isolated ports, without replacing 80/443. The 40-request health-read probe at concurrency 8 returned all200 with p95 10ms; it is not a production capacity measurement. Disk I/O guarantees, sustained marketing workloads and an AMD64 image were not proven. Test stacks were stopped without deleting their volumes; the local application preview remains available.

External gates: genuine OpenAI structured-output/semantic embedding acceptance needs application credentials and an approved finite budget; actual Postiz and Slack delivery/response tests need explicit account mandates; off-host backup/key escrow and independent alarm delivery need configured destinations. Runtime Matomo reads and any blog/mail/ad/community downstream system need their own credentials/scope. No selected blog target exists, so complete portable export is implemented and live CMS publishing is explicitly unavailable.

Postiz account/instance-specific proof requires observed publication, with separate PNG proof. HTTP acceptance is insufficient. Routine schedules remain local until due-time handoff; whole-group remote deletion is not exposed because membership cannot be proven from the documented API. Unknown outcomes remain visible and cannot blindly resend. No global exactly-once or automatic retraction guarantee is made.

## Handoff and authority

Start with `README.md`, `DEPLOYMENT_BOOTSTRAP.md`, `OPERATIONS.md` and `BACKUP_RESTORE.md`. The local production preview uses localhost:4310 and an isolated local API/database/worker. Local synthetic login material remains in ignored `.runtime/e2e-user.json`; it is not a production default or part of repository artifacts.

The local source set is recorded in `docs/evidence/source-manifest.json`: 155 source files, SHA256 `b341d0e5d298f442852309a43b69b7a58a6b94b1cea89d828eeb223f77e722a2`. The initial private Git commit is `528e9fa24defa5d890562fef456071470bb198be`; the manifest identifies its source set.

No existing server restart/update/migration, DNS/firewall change, purchase, real post/mail/ad, paid model call, or training/backtest was performed. The tested local source was pushed only to a private EDS-Labs repository. Public code licensing, reserved original brand marks, operational evidence redaction and a production release/cutover mandate must be resolved before publication/deployment. `RELEASE_READINESS.md` records the remaining decision boundary.

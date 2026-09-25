# Orbit Chat and live readiness follow-up

## Risk and scope

The Chat budget-context and Markdown fixes are high risk because they affect a paid AI answer and render model output. They add no migration, provider, credential or write capability. Live RAG evaluation changes the production knowledge index and incurs OpenAI embedding charges. Postiz write verification creates a real provider post and requires a separately reviewed production change. Neither live gate is satisfied by the code fix.

## Observed production prerequisites (2026-09-25)

- uLiquid has an approved $10 daily AI budget and a successful paid Chat run, but the Chat response incorrectly described the policy limit as lacking a currency and assigned budget. The server tool exposed only `perRunBudgetMicros`; the UI displayed raw Markdown.
- The active `openai:text-embedding-3-small:1536:chunk-v1` index has zero embedded corpus chunks. The one active website document for `https://uliquid.vip/` has 124 extracted passages; its source was last fetched on 2026-09-18. Five sources are stale.
- Only uLiquid X and uLiquid Desk Telegram are assigned to uLiquid. Neither is identified as a sandbox account. FamilyPlan and EDS-Labs integrations remain unassigned. `ENABLE_EXTERNAL_WRITES=false` and `EXECUTION_MODE=test` were verified in the running API.

## Local code release

Run lint, typecheck, tests, build, secret scan and authenticated Playwright against an isolated local database. Review the exact commit and CI. Before a production deploy, capture a fresh database backup and verify it can be listed or restored in isolation. Deploy only the reviewed SHA with external writes disabled. Check API/web/worker health, the budget wording and rendered Chat answer in Chrome. Roll back code to the preceding SHA if the Chat path regresses; the change has no database migration.

## Live RAG evaluation

1. After explicit approval for the exact production source refresh, re-import only the existing approved `https://uliquid.vip/` source. Inspect the new document version, source rights, current chunk count and dependent invalidations. Stop if extraction or rights are unexpected.
2. Prepare a replacement index generation without activating it. Obtain a checked estimate from the current verified model price and policy. After explicit approval for paid embedding, build the eligible corpus in bounded batches, settle receipts and stop on unknown costs.
3. Independently label 60–120 queries against the resulting chunk IDs: at least 48 positive evidence cases and 12 negative rights/project/time cases. Review labels and source versions before transmission. After explicit approval for the exact dataset and cost ceiling, queue the evaluation. Require Recall@10 >= 0.90, zero forbidden hits, recorded MRR, source attribution, latency and settled cost.
4. Activate only a passing, current live evaluation after reviewing the affected content. A failed or incomplete evaluation leaves the prior active index and `LIVE_RAG_EVAL_REQUIRED` gate intact. Keep external writes disabled throughout.

## Publisher write verification

Use a separately designated, authorized sandbox integration. Prepare the exact owner-scoped Postiz package and review its account, text, reference, expiration and cleanup. The current production flags block execution; no provider write is authorized by preparing the package. Only after explicit approval of that exact package and a time-bounded write-capability change may the owner execute it. Require a matching provider receipt and observed `PUBLISHED` status on the same integration. Stop on an unknown outcome without retry. Review and remove the test post in Postiz only with separate cleanup authorization. Leave general campaign publication disabled until all live gates, policy, rights and monitoring pass.

## Monitoring and rollback

Watch Chat budget reservations, API/worker errors, index job receipts, readiness blockers, Postiz verification state and independent uptime alerts. On a bad index result, do not activate it; on an unexpected source update, pause the source and use versioned correction rather than rewriting history. On an unknown Postiz write, reconcile the provider manually and do not send a second test. Restore external-write flags to disabled immediately after any approved verification window.

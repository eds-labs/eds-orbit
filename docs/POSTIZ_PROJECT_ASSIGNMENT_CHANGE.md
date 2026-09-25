# Production Change Plan

## Ziel

Make Postiz integrations explicitly assignable to an Orbit project before they appear in the content editor, qualify for a publisher write test, or pass live publication preflight. The assignment is empty for existing connectors until the project owner selects exact account IDs. Add reusable Orbit Chat prompts and enough bounded tool steps for a weekly plan.

## Betroffene Systeme

Orbit API, web UI and worker deployment. The existing project-scoped connector entity stores `assignedIntegrationIds`; no schema migration or Postiz credential change is needed. Postiz and the uLiquid website are not changed by deploying this code.

## Risiko-Level

High: project authorization and external publisher routing. A wrong assignment could direct an approved post to the wrong account. The current uLiquid connector lists uLiquid, FamilyPlan and EDS-Labs integrations under one Postiz credential. Existing connectors fail closed after deployment until an owner assigns channels. The live RAG evaluation and publisher write verification are separate gates.

Observed in the signed-in uLiquid UI on 2026-09-25: readiness is `test_ready`; the active embedding generation reports zero corpus chunks, five sources are stale, the official website source was last retrieved on 2026-09-18, and there is no Postiz write-verified integration. Therefore a live RAG evaluation needs current retrievable corpus content, a complete index generation, the required evaluation dataset and settled live receipts. A Postiz sandbox write needs a separately reviewed exact packet and temporary write capability. Neither gate is established by this code change.

## Change Steps

1. Keep `ENABLE_EXTERNAL_WRITES=false`; deploy the reviewed code only after the production change approval below.
2. In uLiquid Connections, assign only `uLiquid · x` (`cmufswv260001pg89nlreglzx`) and `uLiquid Desk · telegram` (`cmu9g999m0001o18n6dfzymud`), then inspect the saved assignment. Leave `FamilyPlan · facebook` (`cmufs9sra0001qm87aaxugx2k`), `FamilyPlan · instagram` (`cmufsb4kx0003qm87rrudkj65`), and `EDS-Labs · x` (`cmufsbzsu0005qm875p50ujs3`) unassigned. Verify editor choices and preflight blockers.
3. Separately prepare an exact Postiz sandbox write packet for one assigned integration. Execute it only after approval of its content, destination and cleanup. Enable external writes only after the index evaluation, publisher verification, project policy, evidence, media rights and monitoring are all reviewed.

## Datenbank/Migrationen

No migration. Connector entity JSON gains `assignedIntegrationIds`. Existing data remains intact; absence means no assigned channels. The versioned connector update invalidates stale approval packages.

The owner-only action `POST /api/projects/:projectId/actions/postiz-assign-channels` accepts `{connectorId,version,integrationIds}`. IDs must be unique, enabled accounts in the most recent project connector snapshot. The server derives project and role from the session, checks the expected connector version, writes the assignment and audit event, and returns the versioned public connector.

## Secrets/Config

No secret change is part of this code change. Do not expose the Postiz token. `ENABLE_EXTERNAL_WRITES` stays disabled during deployment and assignment. Enabling it is a separate global production change because it affects more than uLiquid.

## Tests vor Deploy

Run lint, typecheck, integration tests with isolated database, full tests, build, browser tests, secret check and remote CI. Confirm an unassigned or disabled integration fails verification and publication preflight; confirm owner role and connector version checks. Review the diff and current production configuration before deploy.

## Deployment Plan

Record deployed image and database backup/restore status. Deploy the tested image with writes disabled. Confirm the exact deployed revision and check that unassigned provider accounts are absent from the uLiquid content editor. Do not infer deployment from a push or webhook response.

## Post-Deploy Checks

Inspect uLiquid project selection, assignment list, content editor, Chat templates, history reload, bounded weekly plan answer and readiness blockers. Check that no unexpected Postiz post or duplicate mission/job was created. Check FamilyPlan in its own project before any external write.

## Monitoring/Alerts

Watch API/worker error codes, Postiz verification and publication receipts, project audit entries, budget usage, and independent service alerts. Treat `outcome_unknown` as a stop condition requiring reconciliation rather than a retry.

## Rollback/Forward-Fix

If deployment or assignment is wrong, keep external writes disabled and remove the assignment through the versioned owner action. An older image without this gate must never be used while external writes are enabled. Prefer a forward fix to retain the fail-closed behavior. Do not rewrite historical mission or publication records.

## Approval

- Required: yes, for the production deploy, exact uLiquid channel assignment, any sandbox Postiz write, and any later global external-write activation.
- Approved by: pending
- Date: pending

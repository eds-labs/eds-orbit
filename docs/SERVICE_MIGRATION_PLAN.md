# Service Migration Plan

Checkpoint: 2026-09-17. **Existing-service migration was not executed or authorized.** The full proposed procedure, rollback boundaries and individual approval requirements are in `MIGRATION_PLAN_NOT_EXECUTED.md`. The completed read-only inventory is `VPS_INVENTORY.md`.

Orbit's own two fresh local container installations and synthetic backup/restore drill passed. These were isolated test projects, not rehearsals against copied production Postiz/Matomo/Chatwoot state and not permission to move those services. Desk, Forecast and FamilyPlan/Supabase remain outside the migration scope.

| Stage | Required result before advancing |
| --- | --- |
| Complete inventory | Real contracts, residents/owners, immutable versions, data/media sizes, writers, domains/callbacks and restore evidence established. |
| Select target | Exact region/tariff/storage/backup/monitoring quote and separate order approval; validate the conditional 32 GiB plan with representative load. |
| Prepare isolated target | Approved provisioning/security change; private service networks, independent recovery and monitoring; no provider writers enabled. |
| Deploy Orbit first | Production-host version of the local acceptance checks, real permission/quality gates and recovery evidence. |
| Move approved sites/MCP adapters | Preserved domains/discovery/OAuth/signatures and explicit endpoint ownership. |
| Move Matomo | Same-version consistent DB/files restore; stable site IDs/tracking/retention; exactly one archive scheduler and controlled intake across cutover. |
| Move Postiz | Full application/Temporal/database/Redis/search/media recovery set; all accepted/unknown operations reconciled; exactly one publisher. |
| Handle Chatwoot | Separate owner/privacy/migration decision. If it remains, preserve the source contract and do not count it as a saving. |
| Observe and retire | An agreed operating/scheduler window, recovery retention and separate cancellation and later deletion approval after every resident is clear. |

Do not combine migration with major version upgrades or assume a short-notice window near the planned September 19 presale. Never drain or consume queues for discovery. Fence source writers before enabling target writers; DNS alone is not a writer fence.

Rollback before target writes can restore the unchanged authoritative source after verification. Once the target has accepted database/queue writes or external effects, fence both sides and reconcile data, provider IDs, billing outcomes and idempotency history before selecting one authoritative writer. DNS reversal alone is insufficient; blind republishing or older database replacement can duplicate or lose state. Existing service backup/export/restore, DNS/OAuth changes, cutover, cancellation and deletion each require the specific later authorization described in the full plan.

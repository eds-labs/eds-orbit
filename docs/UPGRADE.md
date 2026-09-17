# Upgrading an existing installation

This is a prepared operator runbook. The RC was tested with fresh isolated installations and an isolated restore; no existing production installation was upgraded. Production deployment, migration and key changes require an approved concrete change. Do not apply this procedure to Desk, Forecast or another service stack.

## Prepare a reviewable release

1. Record the current and proposed source/lock/image identifiers, host architecture, Compose project name, migration history and configured provider versions. Review release notes, API/schema compatibility, dependency advisories and the source diff. Use a pinned image; an ARM64 test does not establish AMD64 compatibility.
2. Run the repository checks listed in README and the affected real PostgreSQL/Redis/browser regressions. Apply the proposed forward migrations to a new isolated restored copy, with external writes disabled and projects paused/Observe. Never rewrite a migration already applied anywhere.
3. Rehearse the target image, role/grant checks, proxy/authentication, rendering, worker recovery and evidence/rights behavior against that restored copy. Record results and the old-image/new-schema compatibility decision. A failed rehearsal blocks the rollout.
4. Prepare an encrypted, recoverable backup of the database, referenced assets and separate credential-key escrow. Check restoration and the approved recovery-point/time objectives. Copy neither live credentials nor private data into source, public artifacts or test fixtures.
5. Obtain the approved maintenance window, concrete migration/cutover plan and rollback decision. Neither a populated `ORBIT_RELEASE_APPROVAL` variable nor successful tests alone grant production authority.

## Execute only within the approved window

1. Pause the workspace and reconcile accepted/unknown remote actions and paid reservations. Stop the old worker and prevent an alternate host/instance from becoming a competing publisher. Do not delete jobs, queues, receipts or budget history to clear failures.
2. Stop Orbit API/web while migrations run; keep its database and Redis volumes. Confirm a final backup/checkpoint. Keep live-write and paid-model configuration disabled for the new application's initial validation.
3. Use the same explicit Compose project, private environment file and selected topology as the running installation. Validate with `config --quiet`; do not print resolved secrets. Run the proposed image's maintenance `migrate` service with the real approved change reference, as described in `DEPLOYMENT_BOOTSTRAP.md`.
4. Require successful forward migrations, least-privilege grants and real app/auth role isolation checks. On failure, leave application services stopped and inspect sanitized diagnostics. `--grants-only` is a deliberate repair step after confirming schema state, not an automatic bypass.
5. Start the new API/worker/web with writes disabled. Validate HTTPS sessions/Origin checks, project isolation, Operations queues/heartbeat, current evidence, assets and unknown-state preservation. Record running image IDs and migration state. Check the actual target's resource pressure and alarm delivery.
6. Reconcile provider state again. Retest or refresh model/index/connector evidence invalidated by a version, instance, corpus or profile change. Restore only the separately approved finite project mandates and live gates. Monitor the pilot's jobs, cost journal and remote outcomes.

## Roll back without losing authority history

If the previous image is proven compatible with the applied schema, stop the new worker/API/web and restart the previous immutable image under the same paused/write-disabled conditions. Do not run automatic down migrations. For incompatible schema or corruption, stop all Orbit writers and use the separately approved restore procedure into a new isolated target, retaining the failed target for analysis according to the agreed retention policy.

Before any restored target can publish, reconcile publications, source withdrawals and paid calls that happened after its backup point. A database restore cannot retract a remote post or refund a call. Preserve tombstones, audit evidence and unknown outcomes; fence the old instance. See `BACKUP_RESTORE.md` and `LIVE_ACTIVATION_CHECKLIST.md` before resuming.

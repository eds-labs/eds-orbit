# Backup and Restore Runbook

Checkpoint: 2026-09-17. **The isolated synthetic database restore passed. Production/off-host backup and recovery remain unperformed.** The actual result is `BACKUP_RESTORE_TEST_RESULT.json`, produced by `scripts/backup-restore-test.ts`.

## Executed local evidence

At 12:41:35 UTC the drill dumped `orbit_test` and restored into the new `orbit_restore_test_20260917_1242` database. The 303,861-byte dump has SHA-256 `888e14b97efda4cc5ddeb1e3a86d0aaf03c9cc99153eb1ea907963c204ad4c9b`. It preserved three audit events, one revocation tombstone, one uncertain publication and one active-index configuration. Revoked source content stayed unavailable to retrieval; a stale importer could not revive it. All restored projects were paused in Observe, real-role grants/isolation were checked, no publisher started, no external write occurred and no database was deleted.

This was a small synthetic database drill, not a production-sized performance test. The reported 456 ms covers its measured local operation and is not an RTO guarantee. Its private local dump was created with mode 0600; encrypted off-host transport, separate encryption-key recovery, original media-file restoration and a real production restore were not exercised.

## Repeat the bounded synthetic drill

Use the pinned Node 24 environment and the existing isolated `eds-orbit-local` PostgreSQL stack. `.runtime/local.env` must contain the three `TEST_*DATABASE_URL` roles targeting exactly `127.0.0.1:55432/orbit_test`. The script also checks the Docker project/service identity. It refuses every other source target and refuses to overwrite an existing restore database.

Choose a fresh lowercase suffix of at most 24 letters/digits/underscores; for example:

```sh
ORBIT_RESTORE_TEST_SUFFIX=manual_20260917_1600 node --env-file=.runtime/local.env --import tsx scripts/backup-restore-test.ts
```

The script adds synthetic fixtures, creates a custom-format dump under ignored `.runtime/backups/`, creates a fresh restore database, restores without inherited owner/privilege statements, pauses all projects, applies exact grants and runs the checks above. It records a new result JSON only on success. On failure it retains the target for inspection, suppresses raw driver details and exits nonzero. Select another suffix after review; do not drop or overwrite a previous target as an automatic retry.

## Production recovery set — prepared procedure

A separately approved production backup must cover the matching schema/migrations and application image; tenants and ACLs; original controlled source files and document/version metadata; chunks, vectors and active-index generations; content/assets and approvals; jobs/outbox/idempotency records; provider IDs and uncertain outcomes; usage reservations/receipts; audit, revocation and deletion journals. Back up any media/object-store files consistently with their database references. Source-file hashes and tombstones must survive independently of an index rebuild.

Store encrypted backups outside the application's failure domain with bounded retention and checksums. Protect and test the credential-encryption key and any backup-decryption material separately from the database dump. A database copy alone cannot recover encrypted connector credentials if the key is lost. Never put keys in the backup manifest, repository, logs or a command argument. Provider VM snapshots supplement this recovery set; they do not establish application-consistent recoverability.

## Authorized restore sequence

1. Name the operator, exact backup/checkpoint, destination and human-approved change reference. Verify checksums, required keys, image/schema compatibility and available storage before starting.
2. Restore into a new isolated database/storage namespace with provider/model/network writes blocked. Keep workers stopped. Do not replace the authoritative database during diagnosis.
3. Apply reviewed role grants and current revocation/deletion journals, including changes after the backup checkpoint. Pause every project and set Observe before any application process can execute work. Preserve provider IDs and outcome-unknown records.
4. Validate real-role isolation, login, source/asset hashes, tombstones, index profile/dimensions, retrieval/citation rights and cost/usage journals. Rebuild indexes only from controlled permitted originals; a rebuild must not resurrect removed sources.
5. Reconcile accepted/in-flight publication, notification and paid-provider operations individually. An older database is not proof that an external effect failed. Never replay unknown writes automatically or reuse consumed approvals/receipts.
6. Perform authenticated read-only acceptance first. Enable a single writer only after an explicit release decision and any required fresh approvals; keep the original recovery point and audit trail.

If validation fails, preserve both databases and evidence and choose a reviewed forward repair or another recovery point. After target-side writes, DNS reversal or a blind older restore can lose data or duplicate effects. Fence writers and reconcile first; see `MIGRATION_PLAN_NOT_EXECUTED.md`.

## Recovery objectives and limits

Routine RPO ≤24 hours and RTO ≤4 hours are discussion targets, not achieved production guarantees. Agree service-specific objectives and measure production-sized restore, independent alert delivery, key recovery and off-host retention before committing to them. Planned publishing cutovers require a final consistent checkpoint and explicit accounting for every accepted operation, regardless of the routine RPO. Existing Postiz/Matomo/Chatwoot backups and restore procedures are separate service scopes; this Orbit drill did not back up or restore them.

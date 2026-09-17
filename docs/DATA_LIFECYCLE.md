# Data lifecycle and revocation

Scope: new local Orbit implementation. Existing production systems were not changed.

## Data classes

Authentication stores identities/session/account verification records under a separate least-privilege role. Business data is workspace/project scoped. Imported original bytes are processed in memory and are not retained by the knowledge package; extracted text, versions, chunks and embeddings are stored in PostgreSQL. Source names, technical references, rights and minimal audit metadata have separate value from document text. Provider credentials must remain outside knowledge data and model prompts.

## Immediate revocation

`revokeSource` writes a durable source status and increments its generation while holding the same project lock as ingestion and preflight. It invalidates evidence and dependent drafts, approvals, publication intents and insights. Remote-scheduled, sending or uncertain publication states become `reconciliation_required` and create a durable `jobs` entity and `reconciliation` outbox event. Terminal test/published/canceled execution receipts and their snapshots retain their original status, while `dependencyInvalidated` records the change. A real published receipt additionally receives `reconciliationStatus: required` and a read-only reconciliation job; a database update cannot recall a real external publication.

The transaction removes all source documents and cascades through versions, chunks and embeddings. Evidence copies and associated snapshots are purged; dependent content/insight text fields are cleared and their snapshots removed. Fact values from that source become removed/revoked records and old snapshots are deleted. Audit retains references, action and counts without original text. Source import thereafter fails before storage or provider work.

`revokeDocument` applies a persistent source/external-ID tombstone and source generation fence. Deleting only one version is supported, but the source generation invalidates old asynchronous work conservatively. Reimport of the tombstoned external identity is denied; restoring source content requires a separately designed authorized process rather than silently undoing a tombstone.

Rights/pause changes increment generation and invalidate dependants. They do not physically purge the source. Existing old-generation documents are unavailable until reindexed; resume cannot accidentally reactivate a stale job. A website content update activates a complete new version, requires review of related verified facts, and invalidates affected evidence. Unrelated sources/projects remain usable.

## Correction, export and retention

Facts are versioned, with explicit validity intervals and supersession. `withdrawFact` checks optimistic version equality, records revoked status, and invalidates its evidence and dependent workflow; correction history remains available to authorized project members. The source deletion path separately purges removed source values and historical copies. Export routes must use authenticated scoped transactions and enforce source-use permissions before emitting text. A structured fact key alone is not authorization. General marketing-memory retention/export functions live in the product service; the knowledge package handles referenced source removal.

No unbounded in-process prompt/retrieval cache or external document telemetry is used by this package. The source deletion path is implemented. The product retention action also deletes expired insights/preferences with audit records. A scheduled document-version retention policy remains separate; operators must explicitly review retained version growth. Auth session retention follows Better Auth configuration.

## Backups and external artefacts

Database deletion does not instantly remove historical backups or files previously exported by a user. Backup expiry, encrypted off-host storage, restricted restore and independent revocation-journal retention are required operational controls. Restore starts with external writes disabled, reapplies any newer revocations and reconciles remote actions before workers resume. Re-embedding after restore requires permission and budget; it must not resurrect revoked data.

No production backup/restore, remote data erasure or provider retention policy is asserted to have been verified. OpenAI may receive only source content with explicit model-use permission and only through separately budgeted adapters. Self-hosted vectors do not make the model processing local.

## Isolated local restore evidence — 2026-09-17

`scripts/backup-restore-test.ts` successfully dumped the explicitly isolated `orbit_test` database and restored it into a fresh `orbit_restore_test` target (a strict local suffix permits repeat runs without dropping prior evidence) on the owned loopback PostgreSQL service. It refused existing restore targets, deleted no databases, retained three synthetic audit records, one document tombstone and one uncertain publication and the active index configuration, and demonstrated that revoked data could neither be retrieved nor reimported. All cloned projects were forced into Observe mode and paused before any app-role verification. No publisher or paid reindex process started; external writes were disabled. Exact measurements are in `docs/BACKUP_RESTORE_TEST_RESULT.json`. The local unencrypted test dump contains synthetic fixtures only and is excluded from Git. This does not establish production off-host backup readiness.

Matomo report ingestion stores a bounded normalized projection with explicit timezone/currency/report provenance. Repeated reports deduplicate; changed measurements preserve metric versions and invalidate dependent insights through the correction lifecycle. Missing rows from an incomplete report are not treated as deletion authority. See `docs/MATOMO_IMPORT.md` for the implemented import and remaining live connector acceptance boundary.

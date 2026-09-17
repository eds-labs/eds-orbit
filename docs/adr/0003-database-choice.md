# ADR 0003: Database choice

## Status

Accepted for isolated implementation, 2026-09-17. This completes the imported framework template and complements [the architecture decision](0001-stack-and-boundaries.md).

## Context and decision

Use dedicated PostgreSQL 17 with pgvector 0.8.6 for business state, versioned knowledge, exact vector retrieval, full-text search and audit/outbox records. Prisma 7.10.0 with the matching PostgreSQL adapter handles normal relations; parameterized SQL handles pgvector, full-text search and transaction-local scope. Redis is queue transport, not the authoritative action or cost ledger.

Generic typed entity envelopes retain business-object versions; normalized document/version/chunk/embedding/index relations enforce knowledge scope and lifecycle. Composite scoped constraints, forced RLS and separate nonprivileged app/auth roles support server authorization. Scoped transactions set workspace/project context and take a project advisory lock so imports, revocation, budgets and scheduling races share one durable boundary. Exact vector search is the initial baseline; no ANN performance claim or index is implied.

## Migration and recovery

Applied migrations are immutable. Subsequent schema changes use additive migrations; `202609170001_foundation` and `202609170002_index_generations` are the initial chain. The explicit one-shot bootstrap applies migrations and role grants, then verifies the role matrix using real limited-role connections. Migration credentials never enter the web process.

Backup/restore must preserve source tombstones, current index configuration, evidence versions, action journals and unresolved provider outcomes. Restored projects start paused in Observe with external writes disabled. Local isolated restore passed; production encrypted off-host backups and agreed RPO/RTO remain separate operational acceptance. See [deployment bootstrap](../DEPLOYMENT_BOOTSTRAP.md), [backup/restore](../BACKUP_RESTORE.md) and [data lifecycle](../DATA_LIFECYCLE.md).

## Alternatives and consequences

A separate vector database would add a second permission, deletion and restore boundary. A hosted database could simplify operations but would weaken the requested self-hosted portability. PostgreSQL keeps transactional invariants together, at the cost of explicit capacity planning and operator ownership. [Knowledge architecture](../KNOWLEDGE_ARCHITECTURE.md) defines immutable index profiles; [cost accounting](0003-cost-accounting.md) defines reservation and uncertainty semantics.

# ADR 0001: Stack choice

## Status

Accepted for isolated implementation, 2026-09-17. This completes the imported framework template; [the detailed architecture decision](0001-stack-and-boundaries.md) records the module and trust boundaries.

## Context and decision

Orbit needs a self-hosted web product with authenticated projects, long-running jobs, a relational knowledge store, and independently controlled external actions. The leading framework preset is `web-next-custom-postgres`, adapted explicitly to self-hosted PostgreSQL.

Use a TypeScript monorepo: Next.js App Router for the web interface, Fastify for the validated API, Better Auth for sessions, Prisma with the PostgreSQL driver adapter, PostgreSQL/pgvector for durable state and retrieval, and a separate BullMQ worker with Redis transport. Shared packages contain schemas, AI adapters, connectors, knowledge, database access and creative rendering. The web process has no database credentials. PostgreSQL outbox and business records remain authoritative across queue restarts.

The verified runtime is Node.js 24.18.0 with pnpm 11.19.0. The frozen lockfile and [dependency inventory](../evidence/dependency-inventory.json) are the version authority; framework example versions are not installation instructions.

## Alternatives and consequences

`web-next-supabase` could provide hosted database/auth convenience, but adds an external platform lifecycle that conflicts with the requested independent server stack. Running all jobs inside the web request process would reduce process count but couple publishing/recovery to HTTP availability and request deadlines.

The selected stack requires explicit migrations, role grants, backup operations and worker supervision. In return, project authorization, source rights, paid-call reservations and publication fencing have one durable transactional boundary. [Database](0003-database-choice.md), [authentication](0002-auth-provider.md), [owner mandates](0002-owner-mandates.md), and [hosting](0004-deployment-target.md) are separate decisions. Local acceptance does not authorize deployment or live provider actions.

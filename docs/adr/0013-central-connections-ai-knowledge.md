# ADR 0013: Central connections, AI infrastructure and shared organization knowledge

## Status

Proposed, 2026-10-23. Mario decided the four open questions on 2026-10-23 (decisions E1–E4 below). The work plan is [CENTRAL_INTEGRATIONS_AI_KNOWLEDGE.md](../plans/CENTRAL_INTEGRATIONS_AI_KNOWLEDGE.md); it is phase 3 of [the global administration plan](../plans/GLOBAL_ADMINISTRATION.md) and builds on [ADR 0012](0012-system-administration.md). Nothing is implemented yet. Production connections and keys are not touched by this ADR.

## Context

Every external connection lives inside exactly one project today. There are three storage patterns:
- generic `connectors` entities (Postiz, Matomo, Slack, mailboxes, customer context);
- own entity kinds (Telegram, Google Drive, GitHub, AI configuration);
- environment variables (Drive OAuth app, system SMTP, files S3, backup, AI fallback keys).

As a result, a second project that uses the same Postiz, n8n gateway, GitHub App or OpenAI key must store the same secret again. The right to use a connection is implicit: whatever row is found first in the project. The generic connector actions are not audited.

AI configuration is per project (`openai_configuration`), with the environment as a bootstrap fallback. Budgets, rate cards, route versions and the provider budget are per project only; ADR 0010 deferred a shared budget "until a second project shares the key".

Knowledge is strictly per project:
- forced row-level security on `(workspaceId, projectId)` for every knowledge table;
- composite foreign keys;
- one active index generation per project;
- evidence and invalidation within one project.

The only multi-project read is the MCP search, which loops over the projects a grant covers, one scoped transaction each. Orbit is an MCP server (OAuth, grants, gateway); it is not an MCP client of other servers.

## Decision

1. **A connection and the permission to use it are separate records.**
   - A `Connection` has an owner scope: system, organization or project. It holds non-secret configuration, status and health.
   - Its secret lives in versioned `ConnectionSecret` rows, encrypted as today with AES-GCM, plus a key id for master-key rotation.
   - A `ConnectionGrant` lets one organization or one project use a connection, limited to purposes and modules, optionally with a budget.
   - Nobody can use a connection without an active grant for the consuming project, the owning project included. Grants never cross organizations unless a system administrator grants a system connection.
2. **The database enforces the permission.**
   - Administration writes connections and grants through the control-plane role (`orbit_auth`).
   - The business role (`orbit_app`) may only SELECT a connection or secret inside a project transaction, and only when an active project grant of that connection exists for `app.workspace_id`/`app.project_id`. This is a row-level security policy with an EXISTS on the grant.
   - A revoked grant or a disabled connection is therefore invisible to the API, the worker and MCP on the next transaction.
3. **Grant hierarchy (E2).** A system connection reaches an organization only through a grant by a system administrator, which always carries a monthly organization budget. The organization owner then grants it to projects within that budget. A project grant points to its parent organization grant, and revoking the parent revokes the children in the same transaction.
4. **Organization connections (E3).** Organization owners create connections, AI keys included, for their organization and grant them to its projects. System administrators see metadata and usage of all connections, never a secret value. They cannot grant an organization's connection to another organization.
5. **Central AI infrastructure.**
   - OpenAI and Anthropic accounts become connections of kind `ai_provider` with the purposes `text`, `image` and `embedding`.
   - Models, verified model lists, rate cards, task routes, tiers and fallback form an `AiProfile`, resolved from system to organization to project override. The existing per-project `openai_configuration` stays valid and wins as the project override, so nothing breaks during the migration.
   - A paid call must pass every applicable limit:
     - the project spend mandate (unchanged);
     - the project provider budget (unchanged);
     - the project grant budget;
     - the organization grant budget;
     - the connection's system budget.
   - Cross-project totals use per-grant spend counters, locked in the reserving transaction. `BudgetReservation` gains `connectionId` and `grantId` for attribution.
   - The route version becomes the combination of the profile versions that applied. A change to any of them stops in-flight runs before their next paid call, as today.
6. **MCP.**
   - Orbit as an MCP server keeps its grants, scopes, per-project boundaries and the rule that a client's confirmation is never Orbit authorization. The administration adds the central view: clients, a client disable, all grants as metadata, and revocation.
   - Orbit as an MCP client of external servers (E4) is designed but not built. It would be a connection of kind `mcp_server`, executed only in the worker, with a tool allowlist, read-only by default, through the tool registry's risk classes and budgets.
7. **n8n is an external integration layer.**
   - An `n8n` connection holds the instance URL, a management key and a signing secret. Workflows are bound to defined, product-neutral Orbit contracts (customer context v1 today; a generic signed automation contract later) and granted to organizations and projects. Execution status comes from signed callbacks and the n8n API.
   - Product mappings (FamilyPlan, uLiquid Desk) stay in n8n; the Orbit core never names a product.
8. **Organization knowledge via a library project and explicit shares (E1).**
   - An organization can hold knowledge in its own library project, which uses the existing tables, RLS, indexes and evaluation unchanged.
   - A `KnowledgeShare` grants one consumer project selected sources (or all) of a library project for selected modules.
   - Retrieval for a consumer runs one scoped transaction per authorized share, in the library project's own scope, then fuses the results. Evidence items record their origin project and are validated in that origin's scope.
   - Revoking or narrowing a share, or changing a source in the library, bumps the share generation and invalidates dependent evidence and derived content in every consumer project, through the existing impact handlers.
   - Project knowledge without a share stays fully isolated, and no RLS policy of a knowledge table changes.
9. **Infrastructure secrets stay in the environment:** database, Redis, `AUTH_SECRET`, `CREDENTIAL_KEY`, files and backup storage, system SMTP. The administration shows "configured / missing" and health only.

## Alternatives

- Keeping per-project copies with a "copy to project" helper: duplicate secrets, rotation in many places, no usage view. Rejected.
- An external secret vault service: a new availability and operations dependency that Orbit does not need yet. The `keyId` leaves room for one.
- Physically shared knowledge rows with an optional `projectId` and widened policies. Rejected because it changes every knowledge table, constraint and query and risks tenant isolation (E1).
- Copying shared documents into each project: duplicate embedding cost, revocation lag and drift. Rejected.
- Hosted MCP tools at the model provider for Orbit's own data. Rejected earlier (alignment plan §6.3): they bypass row-level security, roles and the budget journal.

## Consequences

- New control-plane tables and row-level security policies, and a resolver that every connection consumer calls. That includes about 15 copies of the Postiz lookup.
- A migration that adopts legacy project connections one-to-one, with dual reads until each provider is cut over.
- AI calls check more limits.
- Knowledge retrieval and validation gain an origin dimension.
- The access matrix, RLS matrix and cross-organization negative tests grow accordingly.

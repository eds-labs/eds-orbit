# ADR 0009: Modular Orbit Platform

## Status

Accepted by Mario, 2026-10-13 (work package WP0.1 of the modularization plan). The accepted decisions AD-01 to AD-23 are listed and justified in [`plans/orbit-modularization/08-risks-and-decisions.md`](../../plans/orbit-modularization/08-risks-and-decisions.md), and the design is in documents 01–09 of the same folder. This ADR records the baseline. It changes no code.

## Context

Orbit began as a marketing workspace. It is to become a central, modular work platform:

- After login a user picks an organization and a project, then works in the modules enabled for that project.
- The modules are Marketing, Knowledge, then Support, Projects and Meetings.
- A central assistant coordinates tasks across modules.
- External AI clients (ChatGPT, dots, other MCP clients) reach the same capabilities through an MCP gateway.

The analysis (`plans/orbit-modularization/01-current-architecture.md`) found two things:

- **Strong, domain-neutral safety mechanisms:** RLS, separate DB roles, a budget ledger, ActionRequests, outbox, telemetry and an agent runtime port.
- **No enforced boundaries:** about 48 entity kinds in one table, one 2,300-line `server.ts`, a worker importing 19 API modules, closed tool and action registries, and a budget source fused with the marketing policy.

## Decision

1. **Modular monolith with a static module registry** (AD-01). There is no dynamic plugin system and there are no microservices. Modules declare a typed manifest covering:
   - routes, actions, jobs and scheduler contributions;
   - tools, action types and task classes;
   - permissions, settings, events and web navigation.
2. **Naming** (AD-02, Q-01):
   - *Orbit Platform* is the domain-neutral kernel.
   - *Orbit Assistant* is the cross-module main agent.
   - *Orbit Core* keeps its historical meaning: the operator, content packages and agents (`docs/plans/ORBIT_CORE_*`).
3. **Data stays where it is** (AD-03, AD-04):
   - Existing entity kinds and tables are not renamed or moved. Module ownership is a code registry.
   - New modules with relational query needs (Support, Projects) get dedicated tables with composite tenant FKs, FORCE RLS and grants.
4. **Layout and boundaries** (AD-05, AD-13, AD-14):
   - `apps/api/src/platform` and `apps/api/src/modules/<id>`.
   - The worker imports only the registry.
   - The boundaries are enforced by an extension of `scripts/source-check.mjs`.
   - Existing API URLs, payloads and error codes stay stable.
5. **Organization and activation** (AD-06, Q-02):
   - The UI calls today's `Workspace` an **Organization**; the table is not renamed. An organization picker is built and skipped when the user has only one organization.
   - Modules are enabled per project (new table `ProjectModule`). Disabling never deletes data.
6. **Permissions** (AD-07, Q-10):
   - A catalogue of module-declared permission keys, mapped to the three existing roles.
   - **Module-level roles** (`ProjectMemberModuleRole`, including `none`) are planned in WP4.5.
7. **Knowledge** (AD-08, AD-09):
   - Knowledge services (retrieval, evidence, facts, `knowledge_search`) live in the platform. The knowledge module provides management only.
   - Knowledge invalidation runs marketing impact handlers in the same transaction.
8. **AI spend mandate** (AD-10, Q-05): the platform reads the AI budget as a projection of the active marketing policy. There is no data change and no hash change. Separate storage is deferred until a non-marketing module needs paid AI.
9. **One assistant** (AD-11) with module-contributed tools, prompt fragments and cards. Writes go only through ActionRequests. Tool search is mandatory above about 15 tools.
10. **Web** (AD-12): a route registry, the URL scheme `/p/:projectId/<module>/…`, and redirects from the old paths.
11. **Support** (AD-15 to AD-19, Mario's addendum of 2026-10-13):
    - An own, integrated ticket and communication system (e-mail, livechat widget, AI with human handoff).
    - **Chatwoot is not a dependency.** A Chatwoot import is optional later.
    - Support AI keeps a human in the loop by default.
    - The MVP and the extensions are separated as in `06-support-readiness.md`.
12. **MCP gateway** (AD-20 to AD-23, Mario's addendum of 2026-10-13; see the addendum to ADR 0007):
    - A central MCP gateway as platform infrastructure. It is a pure protocol and authentication adapter over the shared services.
    - Orbit is its own OAuth 2.1 authorization server.
    - Client-side confirmation never counts as authorization.
    - **Placement (Q-22):** an own `mcp` service built from the same image and served under the path **`https://orbit.eds-labs.io/mcp`**. There is no new subdomain.
13. **Assets** (Q-06): the existing brand assets stay marketing-owned with their current storage. The new platform file storage (WP4.6) serves Support attachments. Migrating the assets is optional later.
14. **Working agreement** (Q-14): the large moves (WP2.1, WP2.3) run in announced move windows of 1–2 days per subdomain, with no parallel feature PRs touching the same files.

## Alternatives

The alternatives for each decision are in `08-risks-and-decisions.md`. The main ones rejected:

- **A plugin loader:** no external module authors, and a weaker trust model.
- **Microservices:** split transactions and RLS, plus higher operating cost.
- **Per-module tables for existing kinds:** migration and hash risk for no functional gain.
- **An external IdP for MCP:** a second identity store.
- **Chatwoot as the support backend:** a second system of record and provider lock-in.

## Consequences

**Implementation follows `plans/orbit-modularization/07-roadmap.md`.** The order is:

1. Phase 0: safety net.
2. Phase 1: platform preparation.
3. Phase 2: marketing module.
4. Phase 3: knowledge module.
5. Phase 4 and Track M: platform capabilities for Support, and the MCP gateway.
6. Phase 5: Support MVP.

**Continuity:**
- Each phase leaves Orbit fully usable.
- No phase migrates existing records.

**Approvals and decisions still required:**
- Every production deployment and production migration still needs its own approval, per `AGENTS.md`.
- New dependencies need approval: the Better Auth OAuth, MCP and CIMD packages, the MCP SDK, an e-mail provider and an attachment bucket.
- Decisions deferred to their work packages are listed in `08-risks-and-decisions.md` §4 with the WP that needs them.

**Support and personal data:** support processes customer data. ADR 0006 explicitly asks to be revisited when Orbit holds customer or personal data, so Q-12 must be decided before WP5.6.

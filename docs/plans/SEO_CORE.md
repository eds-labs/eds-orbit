# Orbit SEO Core

## Phase 0. Repository analysis

Initial review used upstream `main` at `722c2e57`. The implementation was rebased onto `00c3d6ea`, including the latest Matomo reporting changes. The repository inventory covers the Next.js web app, Fastify API and MCP services, BullMQ worker, the packages, deployment and migration scripts, and the tests. Current source and the registry determine which capabilities are implemented. Legacy plans document decisions and do not establish availability.

| Area | Existing implementation and reuse |
|---|---|
| Module system | ADR 0009, `packages/module-contracts`, `apps/api/src/modules/registry.ts`, and the activation and contribution services in `platform/modules`. SEO follows the opt-in Content and Ads module patterns, with its own routes, roles, tools and web manifest. |
| Organizations, projects and roles | `platform/tenancy`, `ProjectModule` and member module-role overrides. Orbit's organization is a Workspace in storage. Project membership, effective SEO role, explicit activation, and organization entitlements apply on each SEO entry point. |
| System integrations and Google OAuth | `platform/connections` and `platform/management` already own the Integration Center, grant, audit and encrypted vault lifecycle. Drive uses Google OAuth for a different scope. Ads/Social show how to use module-owned OAuth state and central app grants. SEO uses the same vault and grant lifecycle with a dedicated read-only Google consent. |
| Marketing and Matomo | Marketing's Matomo sync imports analytics using its own property mapping, reports, and scheduler. The latest Marketing reports also import daily Search Console impressions and clicks via Matomo's optional Search Engine Keywords Performance feature. The SEO module reads Search Console directly using its own verified properties, independent project roles and date, page, query, country and device reports. SEO has no Marketing activation, data or code dependency. |
| Content and project management | CMS owns editorial content, URL metadata and publication approvals. Work owns tasks and initiatives. The older Content Hub plan assigned SEO measurement to Marketing. With this request the measurement surface belongs to SEO. Publishing and task handoffs can use module contracts when added. |
| Orbit agents and MCP | Orbit tools are registered capabilities for the assistant, configured agents, and the separate MCP gateway. The MCP gateway already has client consent, project grants, live membership checks and tool audit. SEO contributes read tools under a separate consent scope. |
| Workers and scheduler | BullMQ, the contribution registry and periodic dispatch serve maintenance such as OAuth-state expiry. Agent scheduling can use the existing configured agent platform and SEO tools. Search Analytics reads are fetched on demand in Phase 1. |
| Database and audit | Dedicated project tables use composite tenant keys, restricted application grants and FORCE RLS. The existing project advisory lock serializes writes. Project audit records store internal IDs and action metadata, and the central vault audits its own changes. |
| Approvals and UI | The existing ActionRequest system remains the boundary for any future proposals that mutate an external service. Phase 1 has owner-operated setup and provider reads. The web uses the Orbit Design System, registry navigation and project Integration Center. |

## Phase 1. Implementation sequence

1. Register `seo` without module dependencies, add default-off installation availability and explicit project activation, define `seo.read` and owner-only `seo.manage`, and reuse the organization entitlement resolver for availability and a configurable per-project website limit.
2. Add active or archived websites and provider property bindings. Keep one mapping per provider per website. Multiple properties for a provider can be registered as separate websites, including recognized URL prefixes. Multiple Google accounts may be connected to a project.
3. Register the Search Console OAuth app in system integrations, use project-scoped OAuth state, and store the resulting grant and credential in the existing vault. The provider-neutral contract supplies connection status, property discovery and bounded performance reads.
4. Add project SEO navigation and performance, and setup in project Settings. Expose the same reads through the Assistant and through the separate SEO MCP consent scope. Keep credentials and property management out of agent tools.
5. Apply the additive migration to the worktree database only, regenerate API artifacts, and verify tenant boundaries, role and activation states, OAuth replay, read scope, project entitlement limits, browser usability and existing platform regressions.

## Risk and validation

High risk, local environment. Primary profile is fullstack SaaS with AI agent and backend guidance. The existing `web-next-custom-postgres` preset covers the shared UI, API and DB boundaries. A separate Fastify service would add a second tenancy and OAuth integration surface.

OAuth callbacks require the same signed-in owner, a current grant, unexpired single-use state and PKCE. User-supplied website URLs are metadata. Outbound requests use fixed Google endpoints and only provider-confirmed property identifiers. REST, tool and provider response boundaries bound requests and sanitize errors. The project tables are isolated by both workspace and project. Cross-project IDs, lost grants, disabled projects, denied scopes and quota races are test cases. Search Analytics rows are returned on demand and are not indexed in Knowledge, stored as snapshots, or logged as audit content.

The migration is additive with no backfill. Deploy the schema before application code in a separately authorized rollout with the normal schema hash gate. For rollback, switch off the installation flag and restore the previous application version while preserving the additive tables. A project owner can disable the module without losing configuration.

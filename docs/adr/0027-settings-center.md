# ADR 0027: Settings center (one administration surface for four scopes)

## Status

Decisions D-1 to D-9 accepted by Mario on 2026-11-11, all as recommended in [the plan](../plans/SYSTEM_MANAGEMENT_V2.md). Nothing is implemented. Amends decision 1 of [ADR 0013](0013-system-administration.md) (the four addresses) and builds on [ADR 0014](0014-central-connections-ai-knowledge.md) and [ADR 0009](0009-modular-platform.md). Production activation needs separate approval per rollout step.

## Context

Settings are spread over the system administration (`/admin`), the organization page (`/o/:id/settings`), the project settings (`/p/:id/settings?section=…`), the project connections page (`/p/:id/connectors`), the account pages and several module pages. The inventory in the plan lists about 65 places. The same thing is edited in more than one place: project connections on three surfaces, mailboxes in four places, AI model tiers, prices and provider limits in three editors each. Personal and organization data (connected apps, the organization-wide pause) sit inside project pages. The web app learns what a member may do from three sources and by probing for 404.

The backend already separates the four levels and enforces them: system administrators reach no project route without membership, administration code uses only the control-plane database role, and connections are usable only through grants.

## Decision

1. **One surface at `/manage` (D-1).** The settings center has four scopes: `/manage/system`, `/manage/o/:orgId`, `/manage/p/:projectId` and `/manage/me`, each followed by `/<area>[/<section>[/<id>]]`. Sections are path segments. The old addresses (`/admin…`, `/o/:id/settings`, `/p/:id/settings` with `?section=`, `/p/:id/connectors`, `/account…`) redirect to their new place through one permanent table; links stored in notifications keep working.
2. **One frame for every scope (D-2).** Scope switcher and search on top, a grouped section list, the content, advanced settings collapsed. The project scope uses this frame too, without the project sidebar; the sidebar's settings links lead into it.
3. **One canonical place per setting.** Credentials, connections, developer apps, grants and connected accounts belong to Integrations in the scope that owns the record. AI providers, models, prices, budgets, the spending authority and agent permissions belong to the AI area. Members and roles belong to Members. Module behaviour stays a module section under `…/modules/<module>`. Modules show state and link to central settings; they keep only the choice of which connection they use.
4. **A section registry.** The platform and the modules register sections with scope, area, owning module, required capability, canonical route and optional connection provider. Today's `WebModule.settings` contributions are adapted, and a module's sections are collected only while the module is shown for the project. The registry opens no access: every route keeps its server-side check.
5. **Capabilities come from the server.** One read-only endpoint tells the web app which scopes, areas and sections the caller may open and edit. It is computed by the same guard functions the routes use and is a hint for navigation and search only.
6. **Read-only additions, no rebuild.** The integrations catalog, the project and organization integration lists, the effective AI configuration with the origin of each value, the list of projects that follow or override an organization standard, and more system status fields are new read-only endpoints with explicit field lists. No schema change. Two existing writes change additively: the AI profile save checks an expected version, and the Google Drive callback redirects into the project it connected.
7. **Who sees integrations across projects (D-4).** An organization owner gets a metadata list of the integrations of the organization's projects; owners are owners of every business project already. System administrators get no such list across organizations; the metadata-only boundary of ADR 0013 stays.
8. **Integrations.** Availability in the catalog follows the registered adapters, so nothing unbuilt is shown as ready. One uniform state (not set up, stored, verified, ready, needs attention, disabled) is mapped from the existing vocabularies. The setup wizard runs over the existing writes; the developer app, the connection, the grant and the connected account stay separate records.
   - **E-mail (D-5):** mailboxes are grouped by server in the UI. Mailboxes shared across projects are not part of V2; they would make `email` a central provider and need a cutover.
   - **Social accounts (D-6):** connected and managed in the integrations center; the Social page shows their state and links there. Publishing rules stay in Social.
9. **AI configuration.** Every value is shown with its origin and whether a project exception is active. A project that follows the organization standard cannot edit model fields; it can switch to a preset or its own choice. Forms save only the fields they show, built from stored values. The guided organization UI edits the organization caps; profile budgets stay in an advanced section and project budgets in the project (D-7). No mechanism is removed. This replaces phase D of the central AI plan; removing project keys and prices (phase E) is not part of V2.
10. **No permission changes (D-8, D-9).** A system administrator can still assign organization and project roles in any organization and still receives a reset link when system mail did not send; V2 adds a confirmation that names the consequence. Whether organization owners may read audit entries about their organization is decided separately. A system administrator who is not a member reaches a foreign organization through System → Organizations only, with members and invitations.
11. **Rollout flag with three stages (D-3).** `ORBIT_SETTINGS_CENTER` is `off` (default: nothing changes, the new routes answer 404), `preview` (the center is reachable next to the old pages) or `on` (navigation points to the center and old addresses redirect). The scopes follow their existing flags. The flag is a temporary rollout switch and is removed with the old pages; the settings center is part of the platform, not a module.

## Alternatives

- **Keep the four addresses and unify only the frame.** No redirects needed, but sections keep query-string addresses and each level keeps its own navigation code. Rejected (D-1).
- **Project settings inside the project shell.** Keeps the module sidebar visible, but the four scopes then look and navigate differently. Rejected (D-2).
- **A capabilities object computed in the web app** from `/api/me` and probes. No new endpoint, but the organization rules differ per section and several flags are only learnable by probing. Rejected.
- **A cross-organization integration inventory for system administrators.** Convenient for operations, but it reads project-level data through the administration and breaks ADR 0013 decision 4. Rejected (D-4).
- **Central, shareable mailboxes now.** Meets "shared mailboxes" fully, but reverses an earlier decision not to cut mailboxes over and needs a data cutover. Deferred (D-5).
- **A boolean flag.** Simpler, but a production check next to the old pages and the switch of every old address would be one step. Rejected (D-3).

## Consequences

- One new web package (`apps/web/src/platform/settings-center/`) and one new API package (`apps/api/src/platform/management/`). The shell resolves the project of `/manage/p/:projectId` like a project page, so the project scope reuses the existing project context.
- `manage` becomes a reserved first path segment. The redirect table is permanent and unit-tested row by row.
- Every new route is flag-gated by a route predicate and enters the access matrix; fixture changes are reviewed as security changes.
- The AI forms get safe-save fixes with regression tests before they are mounted in the new frame.
- Modules that held connection management (Social accounts, Knowledge GitHub, the Marketing connectors) contribute it through the registry instead of their own pages.
- Until the last step the old pages stay in the code; rollback per stage is the flag. There is no data or schema to undo.

## Update 2026-11-13: rollout finished (row 5.4)

Decision 11, the rollout flag with three stages, is finished. Row 5.4 (branch `claude/settings-center-row-5-4`, delivered to `main` on 2026-11-13) removes `ORBIT_SETTINGS_CENTER`, the old page shells and the stage in `/api/me` and in the capabilities answer. The settings center is unconditional, `/api/management/*` is always registered with its own authentication, and the redirect table is permanent: old addresses, stored links and messages already sent keep resolving through it. Details and the one-release constant `settingsCenter: "on"` in `/api/me` are in [SYSTEM_MANAGEMENT_V2.md](../plans/SYSTEM_MANAGEMENT_V2.md) section 10 and in `docs/IMPLEMENTATION_STATUS.md`. The decision text above is left as it was taken.

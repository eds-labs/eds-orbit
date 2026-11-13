# Settings Center Phase 3 (Integrations Center) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `ORBIT_SETTINGS_CENTER=preview`, every scope of the settings center opens its `integrations` area on one catalog of every integration Orbit has code for, each with a uniform state computed on the server, and a member can set up a central connection end to end (create, check, grant, bind) from the center alone over the existing writes.

**Architecture:** One pure server function maps the existing status vocabularies to six uniform states. Three new read-only endpoints under `/api/management/` (catalog, project list, organization usage) build on the provider registry, a new optional `category`/`authType` on provider registrations, integration descriptors and project-integration contributions that the platform and modules register like any other contribution; the admin overview gains environment status fields. The web adds `apps/web/src/platform/settings-center/integrations/` (state labels, provider card, catalog, guided setup), a first `integrations` section in each scope, and `WebModule.integrations` so the Social module contributes its accounts section without the shell importing it.

**Tech Stack:** TypeScript, Next.js App Router (client shell), Fastify, Prisma (`authDb` for control-plane reads, `scopedRead` for project reads), zod, Vitest (`renderToStaticMarkup` and pure functions in the web; integration tests over `app.inject` in the API), Playwright.

**Spec:** [docs/plans/SYSTEM_MANAGEMENT_V2.md](../../plans/SYSTEM_MANAGEMENT_V2.md) (sections 3.4–3.6, 4.1–4.3, 5.1, 5.4, 5.6, 5.8, 8, 11 D-4/D-5/D-6, 14, 15), [docs/adr/0027-settings-center.md](../../adr/0027-settings-center.md), [docs/adr/0014-central-connections-ai-knowledge.md](../../adr/0014-central-connections-ai-knowledge.md). Phase 2 plan for the conventions: [2026-11-11-settings-center-phase-2.md](2026-11-11-settings-center-phase-2.md).

## Global Constraints

- Work in the worktree `.claude/worktrees/system-management-v2` on branch `claude/settings-center-phase-3` (equal to `main` at `9a90b828`). Before Task 1: `pnpm install --frozen-lockfile`, `pnpm db:generate`, `node scripts/test-db-for-worktree.ts`.
- No database migration, no schema change, no new dependency, no change to roles or permissions, no new capability (the four existing ones `system.connections`, `organization.connections`, `project.integrations`, `system.overview` gate everything).
- No new write path. The only change to an existing write is the Drive callback redirect address (Task 7). Writes in the guided setup are the existing `POST …/connections`, `POST …/connections/:id/check`, `POST …/connections/:id/grants`, `PUT …/connections/:id/channels`, `POST /api/projects/:id/actions/connector-attach`.
- With `ORBIT_SETTINGS_CENTER=off` nothing differs from today, except that the Drive callback redirects to `/p/<projectId>/settings?googleDrive=…`, which the old settings page opens on its Integrations section.
- Old pages (`/admin…`, `/o/:id/settings`, `/p/:id/settings`, `/p/:id/connectors`, `/p/:id/social/accounts`, `/account…`) render and behave exactly as before in every flag state. A shared component changes only through an optional prop whose default keeps the old behaviour; the old pages pass none.
- Every new API route lives below `/api/management/` (covered by `isManagementRoute`, no new predicate), takes no body, validates path parameters with `z.uuid()`, answers with explicit field lists: never a secret, never free-form `config`, never `health` as stored. Each gets one row in `apps/api/tests/fixtures/access-matrix.json` (review that diff as a security change: exactly the new rows), OpenAPI is regenerated (`pnpm api:generate`), `docs/API_CONTRACT.md` documents it.
- Project data is read only inside that project's `scopedRead` transaction, as the member who asked (organization usage: as the organization owner, whose `projectMembership` role is `owner` for every business project). Personal spaces are never read (`businessProjectsWhere` excludes them).
- The platform holds no list of module provider ids, on the server or in the web: categories, auth types and descriptors come from registrations; module sections come from `WebModule.integrations`. Exception carried over from today: `granted-connections.tsx` keeps its existing filter.
- The web never derives a uniform state. It labels the `state` strings the server sends; "not set up" is shown only for a catalog entry with no record in the server's answer.
- Section labels and descriptions are `Label` literals next to the section; all other new wording goes to `settings-center/integrations/texts.ts` (German typed against the English keys; no inline `de ? … : …` in new files). Existing files keep their own pattern.
- Documentation and code comments are English. Commit messages end with `Co-Authored-By: Claude <noreply@anthropic.com>`; no model name anywhere.
- Do not push, do not deploy, do not change a production flag. Each needs Mario's approval.
- Local commands (Node 24: `export PATH=~/.nvm/versions/node/v24.18.0/bin:$PATH`): tests `node --env-file=/Users/marioeuchner/EDS-Labs/Development/EDS-Orbit/.runtime/local.env ./node_modules/vitest/vitest.mjs run <files>`; types `./node_modules/.bin/tsc --noEmit` (root and `apps/web`); boundaries `node scripts/source-check.mjs`. The whole vitest suite, `next build` and the Playwright runs are the controller's (Task 12). After any broader run, `git checkout -- evals/knowledge/last-deterministic-run.json`.

## Review Focus

1. **A viewer or editor reads the project integrations list.** Expected: provider, label, category, scope, state, last check and (mailboxes only) the server host; nothing that `GET /api/projects/:id/connectors` does not already show them; no Telegram owner bot and no Knowledge GitHub item (both owner-only routes today). Pinned in Task 4 (`never exposes more than the existing reads`, `owner-only items`).
2. **A module is switched off for the project, or the member's module role is `none`.** Expected: none of that module's items in the project list or in the organization usage, no module section under the project's Integrations, its address shows "Not available". Pinned in Task 4 (`module off or hidden contributes nothing`), Task 9 (`collects integration sections only from shown modules`) and Task 12 (e2e).
3. **A grant is revoked, a central connection disabled, a check failed, an account needs re-consent, a Drive token was rejected.** Expected: `disabled` or `needs_attention`, never `ready`. Pinned in Task 1 (the whole mapping table) and Task 4 (`maps revoked, disabled, failed and reconnect_required`).
4. **A system administrator who is not an owner, or the owner of another organization, opens an organization's usage.** Expected: 404, and no project read happens; a member's personal space never appears. Pinned in Task 5.
5. **The Google Drive OAuth return while the browser's last project is another one.** Expected: the browser lands on `/p/<connected project>/settings` with the Integrations section open. Pinned in Task 7 and Task 12.

---

## File Structure

**New (API)**

| File | Responsibility |
| --- | --- |
| `apps/api/src/platform/connections/integrations.ts` | Vocabularies (state, category, auth type, storage), `IntegrationDescriptor`, `ProjectIntegrationsContribution`, `integrationState()` |
| `apps/api/src/platform/management/integration-catalog.ts` | `integrationCatalog()`, `catalogCategory()` |
| `apps/api/src/platform/management/project-integrations.ts` | `projectIntegrationRecords()`, `publicIntegration()` |
| `apps/api/src/platform/management/organization-integrations.ts` | `organizationIntegrations()` |
| `apps/api/src/platform/administration/environment-status.ts` | `environmentStatus()` for the admin overview |
| `apps/api/tests/integration-state.test.ts` | The mapping table |
| `apps/api/tests/integration-registry.test.ts` | Categories, descriptors, registry validation, catalog |
| `apps/api/tests/management-integrations.integration.test.ts` | The three endpoints per role |

**New (web), all under `apps/web/src/platform/settings-center/integrations/`**

| File | Responsibility |
| --- | --- |
| `types.ts` | Mirrors of the server shapes |
| `texts.ts` | All wording of the integrations center |
| `paths.ts` | Request paths of the integration reads |
| `state.tsx` | `StateBadge`, `stateTone` |
| `provider-card.tsx` | `ProviderCard` (presentational) |
| `catalog.tsx` | `catalogGroups`, `CatalogView`, the three scope containers |
| `setup.tsx` | `setupOffers`, `setupSteps`, `SetupStepsView`, the three scope containers |
| `*.test.tsx` next to each | Unit tests |

**Modified**

| File | Change |
| --- | --- |
| `apps/api/src/platform/connections/connections.ts` | `ConnectionProvider.category?`, `.authType?` |
| `apps/api/src/platform/modules/contributions.ts` | `integrations?`, `projectIntegrations?`; validation; `registeredIntegrationDescriptors()`, `registeredProjectIntegrations()` |
| `apps/api/src/platform/modules/platform-contributions.ts` | Platform descriptors |
| Provider files: `platform/email/connection.ts`, `platform/customer-context/connection.ts`, `platform/ai/connection-providers.ts`, `platform/connections/github-app.ts`, `platform/automation/workflows.ts`, `modules/marketing/publishing/connection-providers.ts`, `modules/social/accounts/providers.ts`, the Issues webhook provider (`grep -rn "issuesWebhookConnectionProvider =" apps/api/src/modules/issues`) | `category`, `authType` |
| `apps/api/src/modules/knowledge/contributions.ts`, `apps/api/src/modules/webmail/contributions.ts`, `apps/api/src/modules/social/contributions.ts` | Descriptors and project-integration contributions |
| `apps/api/src/platform/connections/google-drive.ts`, `telegram.ts` | Read helpers inside a given transaction |
| `apps/api/src/platform/administration/connections.ts` | `state`, `checkedAt` in the connection view |
| `apps/api/src/platform/administration/routes.ts`, `apps/api/src/platform/jobs/runtime-health.ts` | Environment status in the overview; `redis` reachability |
| `apps/api/src/platform/management/routes.ts` | Three routes |
| `apps/api/src/server.ts` | Drive callback redirect |
| `apps/api/tests/fixtures/access-matrix.json`, OpenAPI artifacts | Three rows |
| `apps/web/src/platform/shell/types.ts`, `shell-context.tsx`, `apps/web/src/components/orbit.tsx` | `IntegrationContribution`, `WebModule.integrations`, `ShellContext.integrations` |
| `apps/web/src/platform/settings-center/registry.ts`, `sections/system.tsx`, `sections/organization.tsx`, `sections/project.tsx` | `adaptIntegrationSections`; the `integrations` and `setup` sections |
| `apps/web/src/modules/social/manifest.tsx` | `integrations: [accounts]` |
| `apps/web/src/platform/administration/connections-ui.tsx`, `admin-area.tsx`, `apps/web/src/components/granted-connections.tsx`, `email-connection.tsx` | Optional props (`provider`, `groupByServer`) |
| `apps/web/src/app/globals.css` | Card grid and stepper styles |
| `apps/web/tests/settings-center.spec.ts` | Integrations scenarios |
| `docs/API_CONTRACT.md`, `docs/DESIGN_SYSTEM.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md`, `docs/CONNECTOR_CAPABILITIES.md`, `docs/plans/SYSTEM_MANAGEMENT_V2.md` | Documentation; finding F-5 |

---

### Task 1: Uniform integration state

**Files:**
- Create: `apps/api/src/platform/connections/integrations.ts`, `apps/api/tests/integration-state.test.ts`

**Interfaces:**
- Produces (in `integrations.ts`):

```ts
export const INTEGRATION_STATES = ["not_set_up", "stored", "verified", "ready", "needs_attention", "disabled"] as const;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];
export const INTEGRATION_CATEGORIES = ["email", "social", "google", "ai", "automation", "mcp", "development", "analytics", "other"] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];
export const INTEGRATION_AUTH_TYPES = ["api_key", "json_secret", "oauth_app", "oauth_account", "bot_token", "password", "webhook_secret", "environment"] as const;
export type IntegrationAuthType = (typeof INTEGRATION_AUTH_TYPES)[number];
export type IntegrationStorage = "central" | "project" | "environment";

export type StateSource =
  | { kind: "central"; status: string; disabled: boolean; revoked: boolean;
      /** "none": read without a consuming organization or project. */
      grant: "none" | "active" | "revoked";
      binding: "not_needed" | "missing" | "present" }
  | { kind: "project_connector"; status: string | null }
  | { kind: "social_account"; status: string; capability: string }
  | { kind: "drive"; connected: boolean; reconnectRequired: boolean; rootConfigured: boolean }
  | { kind: "telegram"; status: "none" | "pending" | "linked" | "disabled" }
  | { kind: "installation"; configured: boolean; installed: boolean };

export function integrationState(source: StateSource): IntegrationState;
```

**Mapping** (rules apply top to bottom within a kind; nothing else produces a state):

| Kind | Condition | State |
| --- | --- | --- |
| central | `revoked` or `disabled` | `disabled` |
| central | `grant === "revoked"` | `disabled` |
| central | `status === "failed"` | `needs_attention` |
| central | `status` is neither `read_verified` nor `write_verified` | `stored` |
| central | verified and `grant === "none"` | `verified` |
| central | verified, `grant === "active"`, `binding === "missing"` | `verified` |
| central | verified, `grant === "active"`, `binding` is `not_needed` or `present` | `ready` |
| project_connector | `status` null or `""` | `not_set_up` |
| project_connector | `status` is `revoked` or `disabled` | `disabled` |
| project_connector | `status === "failed"` | `needs_attention` |
| project_connector | `read_verified` or `write_verified` | `ready` |
| project_connector | anything else (`configured`, unknown) | `stored` |
| social_account | `status === "disabled"` | `disabled` |
| social_account | `status === "reconnect_required"` | `needs_attention` |
| social_account | `status === "active"` and `capability === "write_verified"` | `ready` |
| social_account | `status === "active"` | `verified` |
| social_account | anything else | `stored` |
| drive | not `connected` | `not_set_up` |
| drive | `reconnectRequired` | `needs_attention` |
| drive | `rootConfigured` | `ready` |
| drive | otherwise | `verified` |
| telegram | `none` / `pending` / `linked` / `disabled` | `not_set_up` / `stored` / `verified` / `disabled` |
| installation | `installed` | `ready` |
| installation | `configured` | `stored` |
| installation | otherwise | `not_set_up` |

A project connection's own key is `project_connector`; a project connection bound to a central one (`centralConnectionId`) is `central` with the central connection's status. Telegram `linked` stays `verified` (spec 5.8 names it there).

- [ ] **Step 1: Write the failing test** `apps/api/tests/integration-state.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { INTEGRATION_STATES, integrationState, type StateSource } from "../src/platform/connections/integrations.ts";

const central = (o: Partial<Extract<StateSource, { kind: "central" }>>): StateSource => ({
  kind: "central", status: "read_verified", disabled: false, revoked: false, grant: "active", binding: "present", ...o,
});

describe("uniform integration state", () => {
  it("maps central connections", () => {
    expect(integrationState(central({ disabled: true }))).toBe("disabled");
    expect(integrationState(central({ revoked: true }))).toBe("disabled");
    expect(integrationState(central({ grant: "revoked" }))).toBe("disabled");
    expect(integrationState(central({ status: "failed" }))).toBe("needs_attention");
    expect(integrationState(central({ status: "configured" }))).toBe("stored");
    expect(integrationState(central({ status: "something_new" }))).toBe("stored");
    expect(integrationState(central({ grant: "none" }))).toBe("verified");
    expect(integrationState(central({ binding: "missing" }))).toBe("verified");
    expect(integrationState(central({ status: "write_verified", binding: "not_needed" }))).toBe("ready");
    expect(integrationState(central({}))).toBe("ready");
  });
  it("never calls a failed, revoked or disabled record ready", () => {
    for (const o of [{ status: "failed" }, { grant: "revoked" as const }, { disabled: true }, { revoked: true }])
      expect(integrationState(central(o))).not.toBe("ready");
  });
  it("maps project connectors", () => {
    expect(integrationState({ kind: "project_connector", status: null })).toBe("not_set_up");
    expect(integrationState({ kind: "project_connector", status: "revoked" })).toBe("disabled");
    expect(integrationState({ kind: "project_connector", status: "failed" })).toBe("needs_attention");
    expect(integrationState({ kind: "project_connector", status: "read_verified" })).toBe("ready");
    expect(integrationState({ kind: "project_connector", status: "configured" })).toBe("stored");
  });
  it("maps social accounts", () => {
    const s = (status: string, capability = "read_verified") => integrationState({ kind: "social_account", status, capability });
    expect(s("disabled")).toBe("disabled");
    expect(s("reconnect_required", "write_verified")).toBe("needs_attention");
    expect(s("active", "write_verified")).toBe("ready");
    expect(s("active")).toBe("verified");
  });
  it("maps Drive, Telegram and installations", () => {
    const d = (o: Partial<{ connected: boolean; reconnectRequired: boolean; rootConfigured: boolean }>) =>
      integrationState({ kind: "drive", connected: true, reconnectRequired: false, rootConfigured: false, ...o });
    expect(d({ connected: false })).toBe("not_set_up");
    expect(d({ reconnectRequired: true, rootConfigured: true })).toBe("needs_attention");
    expect(d({ rootConfigured: true })).toBe("ready");
    expect(d({})).toBe("verified");
    expect(["none", "pending", "linked", "disabled"].map((status) =>
      integrationState({ kind: "telegram", status: status as "none" }))).toEqual(["not_set_up", "stored", "verified", "disabled"]);
    expect(integrationState({ kind: "installation", configured: true, installed: true })).toBe("ready");
    expect(integrationState({ kind: "installation", configured: true, installed: false })).toBe("stored");
    expect(integrationState({ kind: "installation", configured: false, installed: false })).toBe("not_set_up");
  });
  it("returns only states of the vocabulary", () => {
    expect(INTEGRATION_STATES).toEqual(["not_set_up", "stored", "verified", "ready", "needs_attention", "disabled"]);
  });
});
```

- [ ] **Step 2: Run it; expected FAIL** (module not found).
- [ ] **Step 3: Implement `integrations.ts`** (vocabularies and `integrationState` only; the descriptor types follow in Task 2). It imports nothing from `modules/`.
- [ ] **Step 4: Run it; expected PASS.**
- [ ] **Step 5: Commit** `feat(platform): uniform integration state`

---

### Task 2: Integration registrations

**Files:**
- Modify: `apps/api/src/platform/connections/integrations.ts`, `apps/api/src/platform/connections/connections.ts` (`ConnectionProvider`, after `callbackPath`), `apps/api/src/platform/modules/contributions.ts` (type `ModuleContributions` after `connections`; validation in `registerContributions` next to the connection providers; two `registered…` functions after `registeredConnectionProviderIds`), `apps/api/src/platform/modules/platform-contributions.ts`, the provider files listed in the File Structure, `apps/api/src/modules/knowledge/contributions.ts`, `apps/api/src/modules/webmail/contributions.ts`
- Create: `apps/api/tests/integration-registry.test.ts`

**Interfaces:**
- Consumes: Task 1 vocabularies; `telegramEnabled` (`connections/telegram.ts:91`); `moduleAvailable` (`contributions.ts:872`)
- Produces:

```ts
// integrations.ts
/** An integration outside the provider registry, contributed by its owner. */
export type IntegrationDescriptor = {
  /** /^[a-z][a-z0-9_.]{1,63}$/, unique across descriptors and provider ids. */
  id: string;
  label: { en: string; de: string };
  category: IntegrationCategory;
  authType: IntegrationAuthType;
  /** Owner scopes, as for providers; [] for environment-only items. */
  scopes: ReadonlyArray<"system" | "workspace" | "project">;
  storage: readonly IntegrationStorage[];
  checkable: boolean;
  /** Default: always available (the owner module's availability still applies). */
  available?: () => boolean;
};
/** One project-level record a module lists; the platform adds category and group. */
export type ContributedIntegration = {
  id: string; provider: string; label: string;
  scope: "central" | "project"; state: IntegrationState; checkedAt: string | null;
};
/** Runs in the project's read transaction with the member's role in the module. */
export type ProjectIntegrationsContribution = (tx: DbTx, scope: Scope) => Promise<ContributedIntegration[]>;

// connections.ts, ConnectionProvider gains
category?: IntegrationCategory;   // default "other"
authType?: IntegrationAuthType;   // default: callbackPath ? "oauth_app" : secretFields?.length ? "json_secret" : "api_key"

// contributions.ts, ModuleContributions gains
integrations?: readonly IntegrationDescriptor[];
projectIntegrations?: ProjectIntegrationsContribution;
export function registeredIntegrationDescriptors(): Array<IntegrationDescriptor & { owner: string }>; // platform first, then registry order
export function registeredProjectIntegrations(): Array<[string, ProjectIntegrationsContribution]>;   // modules only, registry order
```

**Registrations** (every provider and descriptor that has code; nothing else):

| Id | Owner | Category | Auth type | Where set |
| --- | --- | --- | --- | --- |
| `email` | platform | email | password | `platform/email/connection.ts` |
| `customer_context` | platform | automation | json_secret | `platform/customer-context/connection.ts` |
| `openai`, `anthropic` | platform | ai | api_key | `platform/ai/connection-providers.ts` |
| `n8n` | platform | automation | json_secret | `platform/automation/workflows.ts` |
| `github_app` | platform | development | json_secret | `platform/connections/github-app.ts` |
| `postiz` | marketing | social | api_key | `modules/marketing/publishing/connection-providers.ts` |
| `matomo` | marketing | analytics | api_key | same |
| `slack` | marketing | other | bot_token | same |
| `social.app.meta`, `social.app.x` | social | social | oauth_app (derived from `callbackPath`) | `modules/social/accounts/providers.ts` |
| `social.account.x`, `.facebook`, `.instagram` | social | social | oauth_account | same (in `account()`; telegram overrides) |
| `social.account.telegram` | social | social | bot_token | same |
| `issues_webhook` | issues | development | webhook_secret | the Issues provider file |
| descriptor `google_drive` | platform | google | oauth_account; scopes `["project"]`; storage `["project"]`; checkable true | `platform-contributions.ts` |
| descriptor `telegram_owner_bot` | platform | other | bot_token; `["project"]`; `["project"]`; checkable false; `available: telegramEnabled` | same |
| descriptor `mcp_server` | platform | mcp | environment; `[]`; `["environment"]`; false; `available: () => loadConfig().ORBIT_MCP_OAUTH === "true"` | same |
| descriptor `system_mail` | platform | email | environment; `[]`; `["environment"]`; false | same |
| descriptor `knowledge_github` | knowledge | development | oauth_account; `["project"]`; `["project"]`; false | `modules/knowledge/contributions.ts` |
| descriptor `webmail` | webmail | email | environment; `[]`; `["environment"]`; false | `modules/webmail/contributions.ts` |

Descriptor labels: `google_drive` "Google Drive" / "Google Drive"; `telegram_owner_bot` "Telegram owner bot" / "Telegram-Inhaber-Bot"; `mcp_server` "Orbit MCP server" / "Orbit-MCP-Server"; `system_mail` "System e-mail" / "System-E-Mail"; `knowledge_github` "GitHub for Knowledge" / "GitHub für Wissen"; `webmail` "Webmail" / "Webmail".

**Validation** in `registerContributions` (pushed to `problems`, so a mistake throws `MODULE_CONTRIBUTIONS_INVALID` at startup like the other contributions): a descriptor id that fails the pattern; a descriptor id equal to another descriptor's or to a provider id; a `category` (provider or descriptor) not in `INTEGRATION_CATEGORIES`; an `authType` not in `INTEGRATION_AUTH_TYPES`.

- [ ] **Step 1: Write the failing test** `apps/api/tests/integration-registry.test.ts` (calls `registerModules()` from `apps/api/src/modules/registry.ts`; the last case uses `registerContributions` with a fresh `validateRegistry([], platformDeclaration)`-built registry the way `apps/api/tests` already builds broken registries — find one with `grep -ln "MODULE_CONTRIBUTIONS_INVALID" apps/api/tests`)

```ts
it("gives every registered provider a category from the vocabulary", () => {
  for (const id of registeredConnectionProviderIds())
    expect(INTEGRATION_CATEGORIES).toContain(registeredConnectionProvider(id)!.category ?? "other");
  expect(registeredConnectionProvider("postiz")!.category).toBe("social");
  expect(registeredConnectionProvider("matomo")!.category).toBe("analytics");
  expect(registeredConnectionProvider("openai")!.category).toBe("ai");
});
it("registers the descriptors of the integrations outside the provider registry", () => {
  expect(registeredIntegrationDescriptors().map((d) => [d.id, d.owner])).toEqual([
    ["google_drive", "platform"], ["telegram_owner_bot", "platform"], ["mcp_server", "platform"],
    ["system_mail", "platform"], ["knowledge_github", "knowledge"], ["webmail", "webmail"],
  ]);
});
it("lists the social and knowledge project contributions", () => {
  expect(registeredProjectIntegrations().map(([owner]) => owner)).toEqual(["knowledge", "social"]); // registry order
});
it("refuses a descriptor id that is already a provider id", () => {
  expect(() => registerContributions(registry, { integrations: [{ ...drive, id: "email" }],
    connections: { providers: { email: {} } } }, {})).toThrow(/MODULE_CONTRIBUTIONS_INVALID/);
});
```

(The project contributions of the third case are added in Task 4; write that case in Task 4, not here.)

- [ ] **Step 2: Run it; expected FAIL** (`category` undefined, `registeredIntegrationDescriptors` missing).
- [ ] **Step 3: Implement** the types, the two optional fields, the contribution fields, the validation, the two `registered…` functions and the registrations of the table.
- [ ] **Step 4: Run** the new test and `apps/api/tests/*contribution*.test.ts` (find with `ls apps/api/tests | grep -i contribution`); expected PASS. `node scripts/source-check.mjs`: 0 violations.
- [ ] **Step 5: Commit** `feat(platform): integration categories and descriptors`

---

### Task 3: Catalog endpoint

**Files:**
- Create: `apps/api/src/platform/management/integration-catalog.ts`, `apps/api/tests/management-integrations.integration.test.ts`
- Modify: `apps/api/src/platform/management/routes.ts`, `apps/api/tests/integration-registry.test.ts`, `apps/api/tests/fixtures/access-matrix.json`, OpenAPI artifacts, `docs/API_CONTRACT.md`

**Interfaces:**
- Consumes: Task 2; `providerScopes` (`connections.ts:169`); `sessionFor` (`tenancy/auth.ts:124`)
- Produces:

```ts
export type CatalogEntry = {
  id: string;
  label: { en: string; de: string };
  category: IntegrationCategory;
  authType: IntegrationAuthType;
  scopes: Array<"system" | "workspace" | "project">;
  checkable: boolean;
  storage: IntegrationStorage[];
  available: boolean;
  /** "platform" or the module id. */
  owner: string;
};
export function integrationCatalog(): CatalogEntry[];
/** The category of a provider or descriptor id; "other" when unknown. */
export function catalogCategory(id: string): IntegrationCategory;
// GET /api/management/integrations/catalog → { items: CatalogEntry[] } (401 without a session)
```

**Rules**

- Providers: `scopes = providerScopes(def)`; `storage` holds `"central"` when `scopes` has `system` or `workspace`, and `"project"` when it has `project` (Postiz: both); `checkable = Boolean(def.check)`; `label = def.label ?? { en: id, de: id }`; `available = moduleAvailable(owner)` (platform: true).
- Descriptors: their own fields; `available = moduleAvailable(owner) && (descriptor.available?.() ?? true)`.
- Order: by the index of `category` in `INTEGRATION_CATEGORIES`, then `label.en`.
- TikTok and an external MCP client are not entries (they have no code; the web lists them, Task 8).

- [ ] **Step 1: Write the failing tests**

In `integration-registry.test.ts`:

```ts
it("marks an entry available only while its module is installed", () => {
  process.env.ORBIT_SOCIAL = "false";
  expect(integrationCatalog().find((e) => e.id === "social.app.meta")!.available).toBe(false);
  process.env.ORBIT_SOCIAL = "true";
  expect(integrationCatalog().find((e) => e.id === "social.app.meta")!.available).toBe(true);
  // restore in finally
});
it("stores Postiz centrally and per project, Drive per project, system mail in the environment", () => {
  const by = (id: string) => integrationCatalog().find((e) => e.id === id)!;
  expect(by("postiz").storage).toEqual(["central", "project"]);
  expect(by("google_drive").storage).toEqual(["project"]);
  expect(by("system_mail").storage).toEqual(["environment"]);
  expect(by("social.app.meta").authType).toBe("oauth_app");
});
it("lists nothing without code", () => {
  expect(integrationCatalog().map((e) => e.id)).not.toContain("tiktok");
});
```

In `management-integrations.integration.test.ts` (fixtures as in `management-capabilities.integration.test.ts`: its `signUp`, `signIn`, `call` helpers, one `CLIENT_IP_HEADER` per sign-in; environment `ORBIT_ADMINISTRATION`, `ORBIT_CONNECTIONS`, `ORBIT_MODULES`, `ORBIT_MODULE_ROLES`, `ORBIT_SOCIAL` `"true"`, `ORBIT_CONNECTIONS_CUTOVER: "postiz,matomo"`, `ORBIT_SETTINGS_CENTER: "preview"`; people `admin` (system administrator, no membership), `owner` (organization owner), `editor`, `viewer` (project members), `outsider` (owner of another organization)):

```ts
it("answers 404 before authentication while the flag is off")   // ORBIT_SETTINGS_CENTER="off", no cookie → 404
it("answers 401 without a session")
it("gives every signed-in member the same catalog without secrets", …)
// viewer and admin: 200, equal bodies; JSON.stringify(body) contains no "secret", "config", "health"
```

- [ ] **Step 2: Run them; expected FAIL** (module and route missing).
- [ ] **Step 3: Implement `integration-catalog.ts` and the route.**
- [ ] **Step 4: Run them; expected PASS.**
- [ ] **Step 5: Access matrix:** run `UPDATE_ACCESS_MATRIX=1 … vitest run apps/api/tests/access-matrix.integration.test.ts`; the diff is exactly one new entry `GET /api/management/integrations/catalog`: anonymous `unauthenticated`, every other role `allowed:200`.
- [ ] **Step 6:** `pnpm api:generate`, review the diff; add the endpoint and the rules above to `docs/API_CONTRACT.md` under the settings center section.
- [ ] **Step 7: Commit** `feat(platform): integrations catalog`

---

### Task 4: Project integrations list

**Files:**
- Create: `apps/api/src/platform/management/project-integrations.ts`
- Modify: `apps/api/src/platform/management/routes.ts`, `apps/api/src/platform/connections/google-drive.ts`, `apps/api/src/platform/connections/telegram.ts`, `apps/api/src/modules/social/contributions.ts` (and a new function in `apps/api/src/modules/social/accounts/accounts.ts`), `apps/api/src/modules/knowledge/contributions.ts` (and a new function in `apps/api/src/modules/knowledge/github.ts`), `apps/api/tests/management-integrations.integration.test.ts`, `apps/api/tests/integration-registry.test.ts`, access matrix, OpenAPI, `docs/API_CONTRACT.md`

**Route choice.** `GET /api/management/projects/:projectId/integrations`: below `/api/management/`, so `isManagementRoute` gates it and no new predicate is needed (the spec's `/api/projects/:id/integrations` would need one).

**Interfaces:**
- Consumes: Tasks 1–3; `grantedConnections` (`connections/central.ts:43`); `list`, `data` (`platform/shared.ts`); `CONNECTION_KIND`, `cutoverEnabled` (`connections.ts`); `enabledModules` (`modules/enforcement.ts:22`); `ownerEnabled`, `registeredConnectionProvider`; `hiddenModules`, `moduleScope` (`tenancy/module-roles.ts`); `can`, `PROJECT_OWN`; `scopeFor`; `scopedRead` (`packages/db`); `SOCIAL_READ` (`modules/social/permissions.ts:7`)
- Produces:

```ts
export type ProjectIntegration = {
  id: string; provider: string; label: string; category: IntegrationCategory;
  scope: "central" | "project"; state: IntegrationState; checkedAt: string | null;
  /** The mail server host of a mailbox (D-5 grouping); null otherwise. */
  group: string | null;
};
/** Internal: also what the organization usage needs. */
export type ProjectIntegrationRecord = ProjectIntegration & { connectionId: string | null; bound: boolean };
export async function projectIntegrationRecords(tx: DbTx, scope: Scope): Promise<ProjectIntegrationRecord[]>;
export function publicIntegration(record: ProjectIntegrationRecord): ProjectIntegration; // drops connectionId, bound
// GET /api/management/projects/:projectId/integrations → { items: ProjectIntegration[] }
//   PROJECT_READ through scopeFor (404 without membership, so 404 for a system administrator who is not a member)

// google-drive.ts
export async function driveIntegrationSource(tx: DbTx, scope: Scope): Promise<Extract<StateSource, { kind: "drive" }>>;
// telegram.ts (no owner check; the caller decides who sees it)
export async function telegramIntegrationSource(tx: DbTx, scope: Scope): Promise<{ status: TelegramStatus; linkedAt: string | null }>;
// social/accounts/accounts.ts
export const socialProjectIntegrations: ProjectIntegrationsContribution;
// knowledge/github.ts
export const knowledgeGithubIntegrations: ProjectIntegrationsContribution;
```

**What the list holds** (`usable(owner)` = `ownerEnabled(owner, enabled) && !hiddenModules(scope).includes(owner)`, with `enabled = await enabledModules(tx, scope)`, as `attention.ts:83-113`; nothing else is listed):

| Item | Source | Listed for | id | label | scope | state source | checkedAt | group |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Granted central connection | `grantedConnections(tx, scope)`, provider owner `usable` | every member | `connection:<connectionId>` | connection label | central | `central`, `grant: "active"`, `binding`: `not_needed` when the provider's scopes lack `project`, else `present`/`missing` by a `connectors` row with that `centralConnectionId` | the bound row's `verifiedAt`, else null (`grantedConnections` returns no `health`) | null |
| Bound row whose grant is gone | `connectors` row with `centralConnectionId` not among the granted ones, provider owner `usable` | every member | `connector:<rowId>` | provider label | central | `central`, `status` of the row, `grant: "revoked"` | row `verifiedAt` | null |
| Own project connection | `connectors` row without `centralConnectionId`, registered provider whose owner is `usable` (Postiz, Matomo, Slack, customer context, mailboxes, Issues sources) | every member | `connector:<rowId>` | `data.label ?? data.name ?? data.fromAddress ?? provider label` | project | `project_connector`, row `status` | `verifiedAt ?? checkedAt ?? null` | `smtpHost` for provider `email`, else null |
| Google Drive | `driveIntegrationSource` | every member (the Drive status route is `PROJECT_READ`), only when `connected` | `google_drive` | "Google Drive" | project | `drive` | null | null |
| Telegram owner bot | `telegramIntegrationSource` | project owners only (`can(scope, PROJECT_OWN)`; today's route is owner-only, `telegram.ts:164`), only while `telegramEnabled()` and status is not `none` | `telegram_owner_bot` | "Telegram owner bot" | project | `telegram` | `linkedAt` | null |
| Module contributions | `registeredProjectIntegrations()`, owner `usable`, called with `moduleScope(scope, owner)` and wrapped like `attention.ts`'s `contributed` (a throwing contribution adds nothing) | as the contribution decides | as contributed | as contributed | as contributed | as contributed | as contributed | null |

- `socialProjectIntegrations`: `[]` unless `can(scope, SOCIAL_READ)`; one item per `SocialAccount` of the project whose status is not `disabled`: id `social:<accountId>`, provider `social.account.<platform>`, label `handle`, scope `project`, state from `social_account`, `checkedAt` = `settings.lastCheckedAt ?? null`.
- `knowledgeGithubIntegrations`: `[]` unless `can(scope, PROJECT_OWN)` (the Knowledge GitHub route is owner-only, `modules/knowledge/routes.ts:33-38`); a `knowledge_github_config` row and no connection → one item `knowledge_github` with state `installation {configured: true, installed: false}`; else one item per `knowledge_github_connections` row: id `knowledge_github:<rowId>`, label `data.account`, state `installation {configured: true, installed: true}`.
- `category` of every item is `catalogCategory(provider)`; contributed items get `group: null`, `connectionId: null`, `bound: false`. Order: central first, then project items, each in source order.
- `projectIntegrationRecords` sets `connectionId` (central items) and `bound` (`binding` is `present` or `not_needed`).

- [ ] **Step 1: Write the failing tests** (in `management-integrations.integration.test.ts`; fixture data through `authDb` and `scoped` as the existing connection suites do: a system Postiz connection granted to the organization and the first project and bound there with `connector-attach`; an organization Matomo connection granted and not bound; an own project Slack connector row with `encryptedCredential`, `config`-like fields `baseUrl`, `channelId`; a mailbox row `{provider: "email", fromAddress, smtpHost: "mail.example.test", encryptedCredential, status: "read_verified"}`; a social account row (connection through `createProjectConnection` with `moduleId: "social"`, `provider: "social.account.x"`); a Telegram row with status `linked`; a `knowledge_github_connections` row)

```ts
it("lists the project's integrations with a uniform state", …)
// owner: ids include "connection:<postiz>" (state "ready"), "connection:<matomo>" (state "verified"),
// a connector item for Slack (scope "project"), the mailbox (group "mail.example.test"),
// "social:<account>", "telegram_owner_bot", "knowledge_github:<row>"
it("maps revoked, disabled, failed and reconnect_required", …)
// set the Matomo connection status "failed" → "needs_attention"; disable the Postiz connection (authDb) →
// its bound row becomes item "connector:<row>" with state "disabled"; revoke the Matomo grant → item gone;
// set the social account status "reconnect_required" → "needs_attention"; none of them "ready"
it("never exposes more than the existing reads", …)
// viewer: every item has exactly the keys id, provider, label, category, scope, state, checkedAt, group;
// JSON.stringify(body) contains neither "encryptedCredential", "baseUrl", "channelId", "config", "health", nor any secret value used in the fixture
it("shows owner-only items to owners only", …)
// viewer and editor: no "telegram_owner_bot", no "knowledge_github…"; owner: both present
it("module off or hidden contributes nothing", …)
// switch social off for the project (ProjectModule enabled=false) → no "social:" item; switch marketing off → no Postiz,
// Matomo or Slack item; set the viewer's module role for social to "none" → no "social:" item for the viewer
it("answers 404 to non-members and to a system administrator who is not a member", …)
```

In `integration-registry.test.ts` add the case of Task 2 that lists `["knowledge", "social"]`.

- [ ] **Step 2: Run them; expected FAIL** (route missing).
- [ ] **Step 3: Implement** the two read helpers (they reuse the queries of `connectionStatus` and `telegramStatus` inside the given transaction; those two functions keep their behaviour), the two module contributions (registered as `projectIntegrations` in their `contributions.ts`), `project-integrations.ts` and the route (`scopeFor(auth, req, z.uuid().parse(projectId))`, then `scopedRead(scope.workspaceId, scope.projectId, (tx) => projectIntegrationRecords(tx, scope))`, mapped with `publicIntegration`).
- [ ] **Step 4: Run them; expected PASS.** Also run the unchanged suites `connection-cutover`, `connections`, `social-accounts` (find with `ls apps/api/tests apps/api/src/modules/social | grep -i "cutover\|connections\|social-accounts"`); expected PASS.
- [ ] **Step 5: Access matrix:** exactly one new entry `GET /api/management/projects/{projectId}/integrations`: anonymous `unauthenticated`, outsider `not_found`, viewer, editor, owner `allowed:200`, sysadmin `not_found`.
- [ ] **Step 6:** `pnpm api:generate`; `docs/API_CONTRACT.md` with the table above.
- [ ] **Step 7: Commit** `feat(platform): project integrations with a uniform state`

---

### Task 5: Organization usage

**Files:**
- Create: `apps/api/src/platform/management/organization-integrations.ts`
- Modify: `apps/api/src/platform/management/routes.ts`, `apps/api/tests/management-integrations.integration.test.ts`, access matrix, OpenAPI, `docs/API_CONTRACT.md`

**Interfaces:**
- Consumes: Task 4; `workspaceOwnerFor` (`administration/authz.ts:73`); `administrationEnabled`; `projectMembership` (`tenancy/member-scope.ts`); `businessProjectsWhere`; `connectionsEnabled`; `authDb`
- Produces:

```ts
export type OrganizationIntegrations = {
  connections: Array<{
    id: string; provider: string; label: string; category: IntegrationCategory;
    scope: "system" | "workspace"; state: IntegrationState; checkedAt: string | null;
    /** Projects of this organization holding an active grant of it. */
    projects: Array<{ id: string; name: string; bound: boolean }>;
  }>;
  projects: Array<{ id: string; name: string; integrations: ProjectIntegration[] }>;
};
export async function organizationIntegrations(userId: string, workspaceId: string): Promise<OrganizationIntegrations>;
// GET /api/management/organizations/:workspaceId/integrations → OrganizationIntegrations
//   404 while ORBIT_ADMINISTRATION is off (ruling R2 of phase 2); else workspaceOwnerFor (404 for everyone who is not an owner, system administrators included, D-4)
```

**Rules**

- `connections` (empty while `connectionsEnabled()` is false): from `authDb`, the same set `listConnections` gives an owner (`administration/connections.ts:167-182`): the organization's own, and system connections with an active organization grant. `state` = `integrationState({kind: "central", status, disabled: Boolean(disabledAt), revoked: false, grant: scope === "system" ? "active" : "none", binding: "not_needed"})`; `checkedAt` = `health.at` when it is a string, else null.
- `projects` of a connection: active project grants (`revokedAt: null`, `projectId` not null, this `workspaceId`) with the project name; `bound` from that project's records below (`connectionId` equal, `bound` true).
- `projects`: every project of `authDb.project.findMany({ where: { workspaceId, ...businessProjectsWhere(userId) } })`, one after another: `const membership = await projectMembership(project.id, userId)`; skip when null; build the `Scope` exactly as `scopeFor` does (role and `moduleRoles` from the membership) and read `projectIntegrationRecords` in `scopedRead(workspaceId, project.id, …)`; `integrations` are the `publicIntegration` of each.
- No secret, no `config`, no `health`; the projects of another organization never appear.

- [ ] **Step 1: Write the failing tests**

```ts
it("gives the owner every connection with the projects that use it", …)
// owner: connections contains the Postiz system connection with projects [{ first project, bound: true }]
// and the Matomo organization connection with projects [{ first project, bound: false }];
// projects contains both projects, the first with its "connection:<postiz>" integration
it("refuses everyone who is not an owner of the organization", …)
// admin (system administrator, not a member), viewer, editor, outsider → 404; ORBIT_ADMINISTRATION="false" → 404 for owner
it("never reads a personal space", …)
// the owner's personal space (create it the way management-capabilities.integration.test.ts does) is not in projects
it("lists nothing of another organization", …)
// outsider's own organization: no id of the first organization's connections or projects in the body
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them; expected PASS.**
- [ ] **Step 5: Access matrix:** exactly one new entry `GET /api/management/organizations/{workspaceId}/integrations`: anonymous `unauthenticated`, outsider, viewer, editor, sysadmin `not_found`, owner `allowed:200`.
- [ ] **Step 6:** `pnpm api:generate`; `docs/API_CONTRACT.md`, stating D-4 (no list for system administrators).
- [ ] **Step 7: Commit** `feat(platform): organization integration usage`

---

### Task 6: System status fields and connection state in the central lists

**Files:**
- Create: `apps/api/src/platform/administration/environment-status.ts`
- Modify: `apps/api/src/platform/administration/routes.ts` (overview at line 114, `Deps` at line 72), `apps/api/src/platform/jobs/runtime-health.ts`, `apps/api/src/platform/administration/connections.ts` (`view`, line 126), `apps/api/tests/administration.integration.test.ts`, the connections test that asserts the list shape (find with `grep -ln "secretVersion" apps/api/tests`), `docs/API_CONTRACT.md`

**Interfaces:**
- Consumes: Task 1; `filesConfig` (`platform/files/files.ts:99`); `loadConfig`
- Produces:

```ts
export type EnvironmentStatus = {
  redis: { configured: boolean; reachable: boolean };
  files: { configured: boolean };
  googleDriveApp: { configured: boolean };
  aiFallbackKeys: { openai: boolean; anthropic: boolean };
  credentialKeys: { ring: boolean };
  mcp: { oauth: boolean; gateway: boolean; dcr: boolean; tasks: boolean; proposals: boolean;
         projectConfiguration: boolean; projectAdministration: boolean };
  connectionsCutover: string[];
};
export function environmentStatus(input: { redisReachable: boolean }): EnvironmentStatus;
// runtimeHealth() additionally returns redis: "ok" | "unreachable" ("unreachable" in its catch branch)
// GET /api/admin/overview: system gains `environment: EnvironmentStatus`
// connection view (admin and owner lists, create/update/check answers) gains
//   state: IntegrationState   // integrationState({kind:"central", status, disabled, revoked:false, grant:"none", binding:"not_needed"})
//   checkedAt: string | null  // health.at when a string
```

**Values:** `redis.configured` = `Boolean(REDIS_URL)`; `files.configured` = `filesConfig() !== null`; `googleDriveApp.configured` = both `GOOGLE_DRIVE_CLIENT_ID` and `_SECRET` set; `aiFallbackKeys` = `Boolean(OPENAI_API_KEY)`, `Boolean(ANTHROPIC_API_KEY)`; `credentialKeys.ring` = `Boolean(CREDENTIAL_KEYS)`; `mcp.*` = the seven `ORBIT_MCP_*` switches `=== "true"`; `connectionsCutover` = `ORBIT_CONNECTIONS_CUTOVER` split at commas, empty entries dropped. Names and booleans only: no URL, host, key id or count.

- [ ] **Step 1: Write the failing tests**

```ts
it("reports the environment as names and booleans", …)
// admin GET /api/admin/overview: body.system.environment has exactly the keys above; with OPENAI_API_KEY set
// aiFallbackKeys.openai === true; ORBIT_CONNECTIONS_CUTOVER="postiz,matomo" → connectionsCutover ["postiz","matomo"];
// JSON.stringify(body) contains neither the REDIS_URL value nor OPENAI_API_KEY's value
it("keeps the overview for administrators only", …)   // owner → 404 (unchanged)
it("states each central connection uniformly", …)
// admin list: a configured connection has state "stored", a disabled one "disabled", a failed check "needs_attention"
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement.** The old `/admin` overview page reads only the fields it knows, so it renders as before.
- [ ] **Step 4: Run them, `administration-boundary.test.ts` and `access-matrix`; expected PASS** (no fixture change).
- [ ] **Step 5: Commit** `feat(platform): environment status and uniform connection state`

---

### Task 7: Drive callback into its project; finding F-5

**Files:**
- Modify: `apps/api/src/server.ts` (line 1222), the Drive callback test (find with `grep -ln "google-drive/callback" apps/api/tests apps/api/src`), `apps/web/src/platform/shell/settings-nav.test.tsx`, `docs/plans/SYSTEM_MANAGEMENT_V2.md` (row F-5 of 4.1)

**Interfaces:**
- Produces: the callback answers `302` to `${APP_ORIGIN}/p/${encodeURIComponent(projectId)}/settings?googleDrive=${ready ? "ready" : "choose-root"}`.

- [ ] **Step 1: Write the failing tests**

API (in the callback test, with the existing mocked token exchange): `location` header equals `` `${APP_ORIGIN}/p/${projectId}/settings?googleDrive=ready` ``.

Web (`settings-nav.test.tsx`), next to the existing `?googleDrive=ready` case at line 202: `locate("/p/p1/settings", table)` is the project settings place for `p1` (not `legacy`, not `redirect`), and `sectionFromSearch("?googleDrive=choose-root", available)` is `"integrations"`.

- [ ] **Step 2: Run them; expected FAIL** (API: the location is `/settings?googleDrive=ready`).
- [ ] **Step 3: Change the redirect.** `orbit.tsx` and `settings-nav.tsx` need no change: `/p/:id/settings` is the settings page and `sectionFromSearch` already opens Integrations for `?googleDrive=` (`settings-nav.tsx:124-135`).
- [ ] **Step 4: Run them; expected PASS.**
- [ ] **Step 5: Verify F-5 from the code and record it.** Read `apps/api/src/platform/http/public-api.ts` (`createPublicKey`, `listPublicKeys` at 334-341), `apps/api/src/modules/support/widget.ts:55-80` and `apps/web/src/components/public-keys.tsx:60-90`. Replace the F-5 row's "Resolution" cell in `docs/plans/SYSTEM_MANAGEMENT_V2.md` with what the code shows. Expected content (adjust only if the code says otherwise): "Verified 2026-11-11: one store. Support widget keys are `PublicClientKey` rows with `moduleId: "support"`, issued through the platform's `createPublicKey` (`support/widget.ts:65`); the project's public keys list (`public-api.ts:334-341`, `public-keys.tsx`) shows them too, so a widget key appears on two pages and can be revoked from either. No change in phase 3 (the center has no public-access section yet and the old panel stays unchanged); phase 5 lists each key once under `p/integrations/public-access` and marks widget keys as managed by their inbox."
- [ ] **Step 6: Commit** `fix(platform): drive callback returns to its project; record F-5`

---

### Task 8: Web building blocks

**Files:**
- Create (in `apps/web/src/platform/settings-center/integrations/`): `types.ts`, `texts.ts`, `texts.test.tsx`, `paths.ts`, `paths.test.tsx`, `state.tsx`, `state.test.tsx`, `provider-card.tsx`, `provider-card.test.tsx`, `catalog.tsx` (pure part and `CatalogView` only), `catalog.test.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Produces:

```ts
// types.ts: exact mirrors of Tasks 1, 3, 4, 5, 6
export type IntegrationState = "not_set_up" | "stored" | "verified" | "ready" | "needs_attention" | "disabled";
export type IntegrationCategory = "email" | "social" | "google" | "ai" | "automation" | "mcp" | "development" | "analytics" | "other";
export type IntegrationAuthType = "api_key" | "json_secret" | "oauth_app" | "oauth_account" | "bot_token" | "password" | "webhook_secret" | "environment";
export type CatalogEntry = { /* as Task 3 */ };
export type ProjectIntegration = { /* as Task 4 */ };
export type OrganizationIntegrations = { /* as Task 5 */ };
export type EnvironmentStatus = { /* as Task 6 */ };
/** One record shown on a card. */
export type CardRecord = { key: string; label: string; state: IntegrationState; checkedAt: string | null; detail?: string };

// texts.ts
export function integrationText(locale: Locale): (key: IntegrationTextKey) => string;
export const stateLabel: (state: IntegrationState, locale: Locale) => string;
export const categoryLabel: (category: IntegrationCategory, locale: Locale) => string;
export const authTypeLabel: (authType: IntegrationAuthType, locale: Locale) => string;

// paths.ts
export function integrationPaths(scope: ManageScope): {
  catalog: "/management/integrations/catalog";
  records: string | null;   // project: /management/projects/<id>/integrations; organization: /management/organizations/<id>/integrations; else null
  connections: string | null; // system: /admin/connections; organization: /organizations/<id>/connections; project: null
  overview: string | null;  // system: /admin/overview; else null
};

// state.tsx
export const stateTone: Record<IntegrationState, "neutral" | "warning" | "success" | "danger">;
// not_set_up neutral, stored warning, verified success, ready success, needs_attention danger, disabled neutral
export function StateBadge(props: { state: IntegrationState; locale: Locale }): JSX.Element;

// provider-card.tsx
export function ProviderCard(props: {
  entry: Pick<CatalogEntry, "id" | "label" | "category" | "authType" | "storage" | "available">;
  records: readonly CardRecord[];
  /** Section that manages it; null shows `managedInModule`. */
  manageHref: string | null;
  /** Guided setup address; null hides the button. */
  setupHref: string | null;
  locale: Locale;
}): JSX.Element;

// catalog.tsx
export const NOT_AVAILABLE_YET: ReadonlyArray<{ id: string; label: Label }>; // tiktok "TikTok"/"TikTok"; external_mcp "MCP servers of other providers"/"MCP-Server anderer Anbieter"
export function catalogGroups(entries: readonly CatalogEntry[], scope: ScopeKind):
  Array<{ category: IntegrationCategory; entries: CatalogEntry[] }>;
export function CatalogView(props: {
  groups: ReturnType<typeof catalogGroups>;
  unavailable: readonly CatalogEntry[];          // available === false, shown in the "not available yet" group
  recordsOf(entryId: string): readonly CardRecord[];
  manageHrefOf(entry: CatalogEntry): string | null;
  setupHrefOf(entry: CatalogEntry): string | null;
  extra?: ReactNode;                             // environment panel (system scope)
  locale: Locale;
}): JSX.Element;
```

**Rules**

- `catalogGroups(entries, scope)`: only `available` entries; system: `scopes` has `system` or `storage` has `environment`; organization: `scopes` has `workspace`; project: `scopes` has `project` or `workspace` (a granted AI key or GitHub App shows its state in the project); entries with `environment` storage never. Groups in `INTEGRATION_CATEGORIES` order, empty groups left out, entries in the order received.
- `ProviderCard`: heading `h3` with the label; one line "category · auth type · storage"; with no records a `StateBadge` `not_set_up`, else one row per record (label, `StateBadge`, `lastCheck` with the date or `neverChecked`, optional `detail`); an unavailable entry shows `switchedOff` and no action; links "Manage" and "Set up" as given.
- `CatalogView`: one `section` per group with an `h2` (category label) and a card grid; then the group `notAvailableYet` with every `unavailable` entry and every `NOT_AVAILABLE_YET` item as a card without actions and the text `notAvailableBody`.
- CSS: `.integration-grid` (`repeat(auto-fit, minmax(min(280px, 100%), 1fr))`), `.integration-card`, `.setup-steps` (ordered list; current step marked with `aria-current="step"`); no new colours.

**Exact copy**

| Key | English | German |
| --- | --- | --- |
| state `not_set_up` | Not set up | Nicht eingerichtet |
| state `stored` | Stored, not checked | Gespeichert, nicht geprüft |
| state `verified` | Verified | Geprüft |
| state `ready` | Ready | Bereit |
| state `needs_attention` | Needs attention | Braucht Aufmerksamkeit |
| state `disabled` | Disabled | Deaktiviert |
| category `email` / `social` / `google` / `ai` | E-mail / Social media / Google / AI providers | E-Mail / Social Media / Google / KI-Anbieter |
| category `automation` / `mcp` / `development` / `analytics` / `other` | Automation / MCP / Development / Analytics / Other | Automatisierung / MCP / Entwicklung / Analyse / Weitere |
| auth `api_key` / `json_secret` / `oauth_app` / `oauth_account` | API key / Key set (JSON) / Developer app (OAuth) / Account sign-in (OAuth) | API-Schlüssel / Schlüsselsatz (JSON) / Entwickler-App (OAuth) / Kontoanmeldung (OAuth) |
| auth `bot_token` / `password` / `webhook_secret` / `environment` | Bot token / Server login / Signed webhook / Set on the server | Bot-Token / Server-Anmeldung / Signierter Webhook / Auf dem Server gesetzt |
| storage `central` / `project` / `environment` | Central connection / Project / Server environment | Zentrale Verbindung / Projekt / Serverumgebung |
| `lastCheck` | Last check | Letzte Prüfung |
| `neverChecked` | Never checked | Nie geprüft |
| `manage` | Manage | Verwalten |
| `setUp` | Set up | Einrichten |
| `managedInModule` | Managed in its module. | Wird im Modul verwaltet. |
| `switchedOff` | Switched off in this installation. | In dieser Installation abgeschaltet. |
| `notAvailableYet` | Not available yet | Noch nicht verfügbar |
| `notAvailableBody` | Planned; there is nothing to set up yet. | Geplant; es gibt noch nichts einzurichten. |
| `usedBy` | Used by | Genutzt von |
| `bound` | bound | eingebunden |
| `grantedNotBound` | granted, not bound | freigegeben, nicht eingebunden |
| `projectsTitle` | Integrations of the projects | Integrationen der Projekte |
| `environmentTitle` | Server environment | Serverumgebung |
| `environmentBody` | Set on the server; shown as state only. | Auf dem Server gesetzt; nur als Zustand angezeigt. |
| `configured` / `missing` | Configured / Missing | Eingerichtet / Fehlt |
| `reachable` / `unreachable` | Reachable / Not reachable | Erreichbar / Nicht erreichbar |
| `envRedis` / `envFiles` / `envDriveApp` | Redis / Files storage / Google Drive app | Redis / Dateispeicher / Google-Drive-App |
| `envAiKeys` / `envKeyRing` / `envMcp` / `envCutover` | AI fallback keys / Key ring / MCP switches / Connection cutover | KI-Ersatzschlüssel / Schlüsselbund / MCP-Schalter / Verbindungsumstellung |
| `none` | None | Keine |

- [ ] **Step 1: Write the failing tests**

```ts
// texts.test.tsx
it("has German for every English key and no extra key", …)
it("labels every state, category and auth type in both languages", …) // loops over the type's values; no label equals its key
// paths.test.tsx
it("builds encoded request paths per scope", …)
// project "p 1" → records "/management/projects/p%201/integrations", connections null;
// organization "w1" → records "/management/organizations/w1/integrations", connections "/organizations/w1/connections";
// system → records null, connections "/admin/connections", overview "/admin/overview"
// state.test.tsx
it("labels a state without deriving one", …) // renderToStaticMarkup(<StateBadge state="needs_attention" locale="de"/>) contains "Braucht Aufmerksamkeit"
// provider-card.test.tsx
it("shows not set up without records and one row per record", …)
it("offers no action on an unavailable entry", …)       // no <a>, text "Switched off in this installation."
it("says where it is managed when no section manages it", …)
// catalog.test.tsx
it("groups available entries by category per scope", …)
// entries postiz(social, scopes [project,workspace,system]), openai(ai, [system,workspace]), google_drive(google, [project]),
// system_mail(email, [], environment) → system: email, social, ai; organization: social, ai; project: social, google, ai
it("lists TikTok and external MCP servers without actions, with unavailable entries", …)
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and `tsc --noEmit` in `apps/web`; expected PASS.**
- [ ] **Step 5: Commit** `feat(web): integration states, cards and catalog`

---

### Task 9: Catalog sections in the three scopes; module integration sections

**Files:**
- Modify: `apps/web/src/platform/shell/types.ts`, `apps/web/src/platform/shell/shell-context.tsx`, `apps/web/src/components/orbit.tsx` (the `base` memo, lines 384–453), `apps/web/src/platform/settings-center/registry.ts`, `registry.test.tsx`, `integrations/catalog.tsx` (containers), `sections/system.tsx`, `sections/organization.tsx`, `sections/project.tsx` and their tests, `apps/web/src/modules/social/manifest.tsx`, `apps/web/src/components/orbit` shell test that covers `settings` collection (find with `grep -ln "settings: active" apps/web/src` → its test, or `apps/web/src/platform/shell/shell.test.tsx`)

**Interfaces:**
- Consumes: Task 8; `useResource`; `manageHref` (`settings-center/routes.ts`); `sectionPath`
- Produces:

```ts
// shell/types.ts
export type IntegrationContribution = {
  id: string;                     // section id segment, /^[a-z][a-z0-9-]*$/
  label: Label;
  description: Label;
  order: number;
  /** Catalog ids this section manages; their cards link here. */
  providers?: readonly string[];
  /** The component renders its own PageHead. */
  ownHead?: true;
  component: ComponentType;
};
// WebModule gains: integrations?: readonly IntegrationContribution[];
// ShellContextValue gains: integrations: ReadonlyArray<IntegrationContribution & { moduleId: string }>; // from `active` only

// registry.ts
export function adaptIntegrationSections(
  contributed: ReadonlyArray<IntegrationContribution & { moduleId: string }>,
): ResolvedSection[];
// id "<moduleId>/<id>", scope "project", area "integrations", no `moduleId` field (navGroups would move it
// into the module groups, registry.ts:161-175), order 100 + contribution order, ownHead passed through

// catalog.tsx containers
export function SystemCatalog(props: SectionProps): JSX.Element;
export function OrganizationCatalog(props: SectionProps): JSX.Element;
export function ProjectCatalog(props: SectionProps): JSX.Element;
export function manageHrefOf(entry: CatalogEntry, ctx: {
  scope: ManageScope; hrefOf(area: string, ...rest: string[]): string;
  moduleSections: ReadonlyArray<{ id: string; providers?: readonly string[] }>; // adapted ids "<module>/<id>"
}): string | null;
```

**Sections** (all `area: "integrations"`; the existing `connections` and `google-drive` sections stay as they are):

| Scope | id | Address | Order | Capability | Content |
| --- | --- | --- | --- | --- | --- |
| system | `integrations` | `/manage/system/integrations` | -10 | `system.connections` | `SystemCatalog` |
| organization | `integrations` | `/manage/o/<id>/integrations` | -10 | `organization.connections` | `OrganizationCatalog` |
| project | `integrations` | `/manage/p/<id>/integrations` | -10 | `project.integrations` | `ProjectCatalog` |
| project | `social/accounts` (contributed) | `/manage/p/<id>/integrations/social/accounts` | 100 | shown only while Social is shown for the project | `AccountsView` (`ownHead`) |

Labels and descriptions: `integrations` — "All integrations" / "Alle Integrationen"; "Every integration Orbit has code for, with its state here." / "Jede Integration, für die Orbit Code hat, mit ihrem Zustand hier." Social contribution: label "Social accounts" / "Social-Media-Konten"; description "Connect, check and disconnect the project's social media accounts." / "Social-Media-Konten des Projekts verbinden, prüfen und trennen."; `providers: ["social.account.x", "social.account.facebook", "social.account.instagram", "social.account.telegram"]`. The page `/p/:id/social/accounts` keeps mounting the same `AccountsView` unchanged.

**Containers**

- `SystemCatalog`: catalog, `GET /admin/connections` (records per provider: each connection's `label`, `state`, `checkedAt`), `GET /admin/overview` → `extra` = an environment panel (`h2` `environmentTitle`, `environmentBody`, a `dl` of the seven `env…` rows: Redis "Configured/Missing" plus "Reachable/Not reachable"; files, Drive app: configured/missing; AI keys: "OpenAI", "Anthropic" each configured/missing; key ring: configured/missing; MCP: the names of switches that are on, else `none`; cutover: the list, else `none`).
- `OrganizationCatalog`: catalog and `GET /management/organizations/<id>/integrations`; records per provider from `connections` (detail: `usedBy` and the project names, each with `bound` or `grantedNotBound`); below the catalog a section `projectsTitle` with one table per project (provider label, `StateBadge`, last check).
- `ProjectCatalog`: catalog and `GET /management/projects/<id>/integrations`; records per provider from `items`; mailboxes (`provider === "email"`) carry `detail` = their `group`.
- Loading → `Loading`; error → `ResourceError` with retry; never a catalog built from guesses.
- `manageHrefOf`: an entry listed in a module section's `providers` → that section's address; else project scope: `google_drive` → `hrefOf("integrations", "google-drive")`, `storage` has `project` → `hrefOf("integrations", "connections")`, else (central only) null; organization and system scope: `storage` has `central` → `hrefOf("integrations", "connections")`, `environment` → null; `knowledge_github` gets null (its page stays in the Knowledge module until phase 5). `setupHrefOf` (Task 10) returns null until Task 10.

- [ ] **Step 1: Write the failing tests**

```ts
// registry.test.tsx
it("adapts module integration sections under Integrations", () => {
  const [s] = adaptIntegrationSections([{ moduleId: "social", id: "accounts", label, description, order: 0, component: Marker }]);
  expect(s).toMatchObject({ id: "social/accounts", area: "integrations", scope: "project", order: 100 });
  expect(s.moduleId).toBeUndefined();
  expect(navGroups([s], "project", () => undefined).map((g) => g.id)).toEqual(["integrations"]);
  expect(resolveSection([s], "integrations", ["social", "accounts"])).toMatchObject({ section: { id: "social/accounts" } });
  expect(resolveSection([s], "integrations", ["social", "nope"])).toBeNull();
});
// sections/*.test.tsx
it("registers valid sections", () => validateSections(projectSections)); // and system, organization
it("opens the area on the catalog", …) // resolveSection(visibleSections(list, kind, caps), "integrations", []) → id "integrations"; sectionPath → ["integrations"]
it("keeps connections and google-drive reachable", …) // ["connections"], ["google-drive"] still resolve
it("links each card to the section that manages it", …)
// manageHrefOf(postiz, project) → "/manage/p/p1/integrations/connections"; google_drive → ".../integrations/google-drive";
// social.account.x with a social section → ".../integrations/social/accounts"; openai in project → null;
// postiz in organization → "/manage/o/w1/integrations/connections"; system_mail in system → null
// shell test
it("collects integration sections only from shown modules", …)
// registry with Social enabled → shell.integrations has moduleId "social"; Social disabled or access "none" → empty
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement.** In `orbit.tsx` add one line next to `settings:` in the `base` memo: `integrations: active.flatMap((m) => (m.integrations ?? []).map((c) => ({ ...c, moduleId: m.id })))`. `ProjectScopeView` appends `adaptIntegrationSections(shell?.integrations ?? [])` to its section list.
- [ ] **Step 4: Run** the new tests, `apps/web/src/platform/shell/*.test.tsx`, `apps/web/src/modules/social/*.test.tsx`, `tsc --noEmit`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): integrations catalog in every scope`

---

### Task 10: Guided setup

**Files:**
- Create: `apps/web/src/platform/settings-center/integrations/setup.tsx`, `setup.test.tsx`
- Modify: `apps/web/src/platform/administration/connections-ui.tsx` (`createFields`, `ConnectionsPanel`), `apps/web/src/platform/administration/admin-area.tsx` (`Integrations`), `apps/web/src/components/granted-connections.tsx`, `integrations/texts.ts`, `integrations/catalog.tsx` (`setupHrefOf`), `sections/system.tsx`, `sections/organization.tsx`, `sections/project.tsx`, `apps/web/src/platform/administration/connections-ui.test.tsx` (or the file that tests `createFields`; find with `grep -ln "createFields" apps/web/src`)

**Interfaces:**
- Consumes: Tasks 8–9
- Produces:

```ts
// connections-ui.tsx (defaults keep both old pages unchanged)
export function createFields(providers, mode, locale, origin, preset?: string): FormField[];
//   preset: the provider select offers only that provider and has it as `value`
ConnectionsPanel props gain: provider?: string; // list and create form limited to it
// admin-area.tsx
export function Integrations({ locale, provider }: { locale: Locale; provider?: string }): JSX.Element; // passes provider through
// granted-connections.tsx
GrantedConnections props gain: provider?: string; // only grants of that provider

// setup.tsx
export type SetupStepId = "choose" | "configure" | "check" | "authorize" | "assign" | "validate";
export type SetupWho = "admin" | "owner" | "projectOwner" | "anyone";
export type SetupStep = { id: SetupStepId; who: SetupWho; done: boolean; mine: boolean; href: string | null };
export function setupOffers(entries: readonly CatalogEntry[], scope: ScopeKind): CatalogEntry[];
export function setupSteps(input: {
  scope: ScopeKind;
  entry: CatalogEntry;
  role: { admin: boolean; organizationOwner: boolean; projectOwner: boolean };
  /** States of the provider's records as the server sent them, in the current scope. */
  states: readonly IntegrationState[];
  granted: boolean;   // system: a connection has activeGrants > 0; organization: a connection has projects; project: an item scope "central"
  bound: boolean;     // organization: a project with bound; project: an item in state "ready"
  links: { organization: string | null; project: string | null }; // where other scopes' steps are done
}): SetupStep[];
export function SetupStepsView(props: { entry: CatalogEntry; steps: readonly SetupStep[]; locale: Locale; workbench: ReactNode }): JSX.Element;
export function SystemSetup(props: SectionProps): JSX.Element;
export function OrganizationSetup(props: SectionProps): JSX.Element;
export function ProjectSetup(props: SectionProps): JSX.Element;
```

**Sections** (`takesId: true`; `id` is the catalog entry id):

| Scope | id | Address | Order | Capability |
| --- | --- | --- | --- | --- |
| system | `setup` | `/manage/system/integrations/setup[/<entryId>]` | -5 | `system.connections` |
| organization | `setup` | `/manage/o/<id>/integrations/setup[/<entryId>]` | -5 | `organization.connections` |
| project | `setup` | `/manage/p/<id>/integrations/setup[/<entryId>]` | -5 | `project.integrations` |

Label "Set up an integration" / "Integration einrichten"; description "Step by step: connection, check, grants and assignment." / "Schritt für Schritt: Verbindung, Prüfung, Freigaben und Zuordnung." Without an id the section lists `setupOffers` as links to `…/setup/<entryId>`; an id that is not among the offers shows the frame's "Not available" notice (`notPermittedTitle`/`notPermittedBody` from `settings-center/texts.ts`).

**Rules**

- `setupOffers`: available entries; system: `scopes` has `system`; organization: `scopes` has `workspace`; project: `scopes` has `project` and `storage` lacks `environment`.
- Steps and who (nothing else): `choose` anyone (always done once an entry is open); `configure`, `check`: system scope → admin; organization scope → owner; project scope → projectOwner for project-stored entries without `central`, else owner (the organization's); `authorize`: system → admin (to an organization), organization and project → owner (to projects); `assign` and `validate`: projectOwner. `mine` is true when the member's role covers `who` (`admin` ⇐ role.admin; `owner` ⇐ role.organizationOwner; `projectOwner` ⇐ role.projectOwner or role.organizationOwner; `anyone` always). `href`: null when `mine`; else the other scope's setup address from `links` (`links.organization` for owner steps, `links.project` for project steps), null when the member cannot open that scope.
- `done`: `configure` ⇐ some state other than `not_set_up`; `check` ⇐ some state `verified` or `ready`; `authorize` ⇐ `granted`; `assign` ⇐ `bound`; `validate` ⇐ some state `ready`.
- Workbench (the existing panels, mounted once below the steps): system → `<Integrations locale provider={id} />` (create, check, grant to organizations); organization → `<ConnectionsPanel base mode="owner" targets provider={id} />` (create, check, grant to projects, channels); project → `<GrantedConnections connectors provider={id} />` for an entry with `central` storage (bind), and a link "Manage" to the entry's `manageHrefOf` for project-stored entries.
- `SetupStepsView`: `h2` with the entry label; an ordered list with one item per step (label, who, `Done` or `Your step` or `Done by: <who>` with the link `Open`); the first not-done step carries `aria-current="step"`; then the workbench. After a write the panels refresh their own data; the steps' records are refreshed by a "Refresh state" button under the list (`useResource().refresh`), because none of the mounted panels reports its writes.
- In test execution mode nothing reaches a provider: create, grant, channels and bind make no provider call; the browser test answers the two check requests itself (Task 12).

**Exact copy**

| Key | English | German |
| --- | --- | --- |
| `setupTitle` | Guided setup | Geführte Einrichtung |
| `stepChoose` | Choose provider | Anbieter wählen |
| `stepConfigure` | Configure connection or developer app | Verbindung oder Entwickler-App einrichten |
| `stepCheck` | Check | Prüfen |
| `stepAuthorize` | Authorize organization and projects | Organisation und Projekte freigeben |
| `stepAssign` | Assign account or channel | Konto oder Kanal zuordnen |
| `stepValidate` | Validate | Abschließend prüfen |
| `whoAdmin` | System administrator | Systemadministration |
| `whoOwner` | Organization owner | Inhaber der Organisation |
| `whoProjectOwner` | Project owner | Projektinhaber |
| `whoAnyone` | Anyone who may set it up | Alle, die einrichten dürfen |
| `stepDone` | Done | Erledigt |
| `stepYours` | Your step | Dein Schritt |
| `stepOthers` | Done by: | Erledigt durch: |
| `openStep` | Open | Öffnen |
| `refreshState` | Refresh state | Zustand aktualisieren |
| `chooseProviderHint` | Choose what to set up. | Wähle, was du einrichten möchtest. |

- [ ] **Step 1: Write the failing tests**

```ts
// setup.test.tsx
it("offers per scope only what can be set up there", …)  // postiz in all three; openai not in project; system_mail nowhere
it("gives each step to its role and links the others", …)
// project scope, postiz, role {projectOwner:true} → configure/check/authorize mine=false, href = links.organization;
// assign, validate mine=true, href null; role {organizationOwner:true} → every step mine
it("marks steps done from the server's states", …)
// states ["verified"], granted true, bound false → configure, check, authorize done; assign, validate not
// states ["ready"], bound true → all done
it("marks the first open step as current", …) // renderToStaticMarkup: exactly one aria-current="step"
// connections-ui test
it("limits the create form to a preset provider", …) // createFields(providers, "owner", "en", origin, "matomo"): provider field options ["matomo"], value "matomo"
it("keeps the full form without a preset", …)          // options equal today's
// sections tests
it("opens a provider's setup by address and refuses an unknown one", …)
// resolveSection(sections, "integrations", ["setup", "postiz"]) → section "setup", id "postiz"
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement** (the optional props first, then `setup.tsx`, then the sections and `setupHrefOf` in `catalog.tsx`: `…/integrations/setup/<entryId>` for entries in `setupOffers` of the scope, else null).
- [ ] **Step 4: Run** the new tests, `apps/web/src/platform/administration/*.test.tsx`, `apps/web/src/components/*.test.tsx`, `tsc --noEmit`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): guided setup over the existing connection writes`

---

### Task 11: Mailboxes grouped by server (D-5)

**Files:**
- Modify: `apps/web/src/components/email-connection.tsx`, its test (find with `ls apps/web/src/components | grep email`; create `email-connection.test.tsx` if none), `apps/web/src/platform/settings-center/sections/project.tsx` (the `connections` section's component), `apps/web/src/components/management.tsx` (`Connectors` passes the prop through)

**Interfaces:**
- Produces:

```ts
// email-connection.tsx
export type MailServerPreset = { smtpHost: string; smtpPort: number; smtpTls: "implicit" | "starttls"; imapHost: string; imapPort: number; imapTls: "implicit" | "starttls" };
/** Mailboxes by SMTP host, hosts in first-connected order. */
export function serverGroups<T extends { connection: { data: Record<string, unknown> } }>(mailboxes: readonly T[]): Array<{ host: string; preset: MailServerPreset; mailboxes: T[] }>;
/** The form fields of a mailbox; a preset fills host, port and TLS of a new one. */
export function mailboxFields(current: Record<string, any> | null, locale: Locale, preset?: MailServerPreset): FormField[];
EmailConnection props gain: groupByServer?: boolean;   // default false: today's flat list
Connectors props gain: groupMailboxes?: boolean;        // passed to EmailConnection; default false
```

**Behaviour.** With `groupByServer`, the mailboxes render under one `h3` per host ("Mail server <host>" / "Mailserver <host>"), each group ending with a button "Add mailbox on this server" / "Postfach auf diesem Server hinzufügen" that opens the existing form with `preset`; the general "add mailbox" button stays. Without it, markup is unchanged. The center's project `connections` section renders `<Connectors embedded groupMailboxes />`; the old `/p/:id/connectors` page passes nothing.

- [ ] **Step 1: Write the failing tests**

```ts
it("groups mailboxes by SMTP host", …) // two on "mail.a.test", one on "mail.b.test" → hosts ["mail.a.test","mail.b.test"], counts [2,1]
it("prefills a new mailbox from its server", …) // mailboxFields(null, "en", preset): smtpHost value "mail.a.test", smtpPort 587, smtpTls "starttls"; fromAddress ""
it("keeps today's form without a preset", …)    // mailboxFields(null, "en"): smtpPort 465, smtpTls "implicit", imapPort 993
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement** (extract today's inline field list into `mailboxFields` without changing it, then add the grouping).
- [ ] **Step 4: Run them and `apps/web/src/components/*.test.tsx`; expected PASS.**
- [ ] **Step 5: Commit** `feat(web): mailboxes grouped by server in the settings center`

---

### Task 12: Browser acceptance, documentation, controller verification

**Files:**
- Modify: `apps/web/tests/settings-center.spec.ts`, `docs/API_CONTRACT.md` (check complete), `docs/DESIGN_SYSTEM.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md`, `docs/CONNECTOR_CAPABILITIES.md` (its capability matrix: category and auth type per provider, the descriptors), `docs/plans/SYSTEM_MANAGEMENT_V2.md` (phase 3 status)

**Interfaces:**
- Consumes: everything above; the `login` helper and seeded installation of `settings-center.spec.ts`

**Test transports.** Creating, granting, assigning channels and binding make no provider call. The two checks (`POST /api/admin/connections/:id/check`, `POST /api/organizations/:id/connections/:id/check`) are answered in the browser with `page.route(…, route.fulfill({ json: {...connection, status: "read_verified", state: "verified"} }))`, the pattern of `apps/web/tests/chat.spec.ts:975-1013`. No Playwright spec touches the database, so the stored status stays `configured`: after a routed check the test also routes the reads that carry that connection's state (`GET …/connections`, `GET /api/management/…/integrations`) with the verified status, while create, grant and bind go to the real local API. That the server maps a verified, granted, bound connection to `ready` is proven by Task 4's integration test, not by the browser. `EXECUTION_MODE=test` stays the default.

- [ ] **Step 1: Add the Playwright scenarios** (skip unless `/api/me` reports `settingsCenter` other than `"off"`; the setup scenarios additionally skip unless `identity.connections` is true)

```ts
test("opens Integrations on the catalog in each scope", …)
// /manage/system/integrations, /manage/o/<org>/integrations, /manage/p/<project>/integrations: heading "All integrations",
// a group "Not available yet" with "TikTok"; a card "Postiz" with a state badge
test("sets up a Matomo connection from the organization to the project", …)
// /manage/o/<org>/integrations/setup/matomo → create (label, URL, key) → routed check → Grants → the project →
// /manage/p/<project>/integrations/setup/matomo → Bind → the project catalog shows Matomo "Ready"
test("grants a system connection to an organization and from there to a project", …)
// as administrator-owner: /manage/system/integrations/setup/postiz → create → routed check → grant to the organization;
// /manage/o/<org>/integrations/setup/postiz → grant to the project; project setup → bind; state "Ready"
test("shows a viewer states without actions", …)   // viewer: no "Set up" link on project cards, no secret in the page text
test("hides a disabled module's integration section", …)
// Social off for the project: no "Social accounts" in the section list; /manage/p/<project>/integrations/social/accounts shows "Not available"
test("returns from Google Drive into the connected project", …)
// with localStorage last project = another project, navigate to /p/<project>/settings?googleDrive=ready → the Integrations section of that project is open
test("keeps the old connectors and social pages", …) // /p/<project>/connectors and /p/<project>/social/accounts render their headings
```

- [ ] **Step 2: Write the documentation.** `docs/API_CONTRACT.md`: the three endpoints, the uniform state table, the new overview and connection fields. `docs/DESIGN_SYSTEM.md`: a paragraph on the integrations catalog (cards by category, state badges, "not available yet" group, guided setup stepper) after the settings center paragraph. `docs/CONNECTOR_CAPABILITIES.md`: category and auth type per provider and the descriptors. `docs/IMPLEMENTATION_STATUS.md`: a new top entry (local, not on `main`; what was built; verification counts; not in phase 3: public-access section, redirects, shared mailboxes, project AI keys in the list). `docs/REQUIREMENTS_TRACEABILITY.md`: WP 3.1–3.7 rows with their tests. `docs/plans/SYSTEM_MANAGEMENT_V2.md`: phase 3 implemented locally.
- [ ] **Step 3: Run** `./node_modules/.bin/tsc --noEmit` (root and `apps/web`), `node scripts/source-check.mjs`, `git diff --check`; expected clean.
- [ ] **Step 4: Commit** `test(web): integrations center in the browser; docs`
- [ ] **Step 5: Controller verification** (not the implementer's; listed so the controller runs exactly this):
  1. Whole vitest suite on a fresh worktree test database.
  2. Whole Playwright suite with the flag off (`ORBIT_ADMINISTRATION=true` only, today's CI flags).
  3. Whole Playwright suite with `ORBIT_ADMINISTRATION=true ORBIT_ACCOUNT=true ORBIT_SETTINGS_CENTER=preview`.
  4. `apps/web/tests/settings-center.spec.ts` alone with additionally `ORBIT_CONNECTIONS=true ORBIT_MODULES=true ORBIT_CONNECTIONS_CUTOVER=postiz,matomo`.
  5. `next build` (after the dev stack is stopped), `pnpm test:coolify-compose`, the secret scan.
  6. Flag-off check by hand: `/manage…` not found, `/api/management/*` 404, the Drive return lands on `/p/<id>/settings` with Integrations open.
- [ ] **Step 6: Request review** with `superpowers:requesting-code-review` on the whole branch and the Review Focus list; then report to Mario and wait for approval before any push to `main`.

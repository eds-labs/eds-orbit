# Settings Center Phase 2 (Frame) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `ORBIT_SETTINGS_CENTER=preview`, a signed-in member reaches one settings center at `/manage` with four scopes (system, organization, project, account), sees only what their role permits, and every old page keeps working unchanged.

**Architecture:** A new web package `apps/web/src/platform/settings-center/` holds a URL model, a section registry, a capability filter and one frame; its sections mount the existing panels. A new API package `apps/api/src/platform/management/` adds the rollout flag and one read-only capabilities endpoint computed from the existing role checks. The shell (`orbit.tsx`) resolves `/manage/p/:projectId` like a project page, so the project context is reused without moving code.

**Tech Stack:** TypeScript, Next.js App Router (client shell), Fastify, Prisma (`authDb`), zod, Vitest (`renderToStaticMarkup` and pure functions in the web; integration tests over `app.inject` in the API), Playwright.

**Spec:** [docs/plans/SYSTEM_MANAGEMENT_V2.md](../../plans/SYSTEM_MANAGEMENT_V2.md) (sections 5 and 7) and [docs/adr/0027-settings-center.md](../../adr/0027-settings-center.md). Read both before starting.

## Global Constraints

- Work in the worktree `.claude/worktrees/system-management-v2` on branch `claude/system-management-v2`. Before Task 1: `git fetch origin main && git rebase origin/main` (the branch holds only docs), then `pnpm install --frozen-lockfile`, `pnpm db:generate` and `node scripts/test-db-for-worktree.ts`.
- No database migration, no schema change, no new dependency, no change to roles or permissions.
- With `ORBIT_SETTINGS_CENTER=off` (the default) nothing differs from today: `/manage` shows "not found", `/api/management/*` answers 404 before authentication, the user menu is unchanged.
- With `preview` only one thing is added to existing UI: one user menu entry. No old page, link or redirect changes. The redirect table of spec 5.3 is phase 5, not this plan.
- No AI form is mounted in the new frame (spec section 14, "4.3 before 4.4"). The AI areas link to the existing AI pages.
- Every new API route: zod `.strict()` input where it takes input, explicit field lists in the response, flag check in the `onRequest` hook by route pattern, a row in `apps/api/tests/fixtures/access-matrix.json` (review that diff as a security change).
- The shell never imports a module (`scripts/boundaries.json`); module settings reach the center only through `ShellContext.settings`.
- Texts: English and German for every string. New text files follow `apps/web/src/platform/project-settings/texts.ts` (German typed against the English keys). No inline `de ? … : …` in new files.
- Documentation and code comments are English. Commit messages end with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Do not push to `main`, do not deploy, do not change a production flag. Each needs Mario's approval.
- Local commands (Node 24): unit and integration tests `node --env-file=<main checkout>/.runtime/local.env ./node_modules/vitest/vitest.mjs run <files>`; types `./node_modules/.bin/tsc --noEmit` (root and `apps/web`); boundaries `node scripts/source-check.mjs`. After a full test run, `git checkout -- evals/knowledge/last-deterministic-run.json`.

## Review Focus

1. **A member opens `/manage/p/<id>` of a project they do not belong to, or `/manage/o/<id>` of an organization they do not own.** Expected: the "not found" page, no request for that scope's data, the id not shown in the switcher. Pinned in Task 6 (`notFoundTarget`) and Task 11 (e2e).
2. **The capabilities request fails or is still loading.** Expected: a loading state, then an error with retry; never a navigation built from guesses and never an empty frame. Pinned in Task 6 (`centerState`).
3. **A section's capability disappears while the page is open** (role removed, module switched off). Expected: after the next load the section is gone from navigation and search, and its URL shows "not found"; the server already refuses the writes. Pinned in Task 4 (`resolveSection` returns null for a hidden section) and Task 2 (capabilities follow the current role on every request).
4. **An id in the URL that looks like a section name, or a section name that looks like an id** (`/manage/system/users/invitations` versus `/manage/system/users/<userId>`). Expected: a registered section wins; anything else is passed to the area's first section as its id. Pinned in Task 4.
5. **A module contributes a settings section while it is disabled, or the member's module access is `none`.** Expected: the section is absent from navigation, search and by URL. Pinned in Task 9 (`adaptModuleSections` receives only what `ShellContext.settings` holds, which the shell already filters) and Task 11 (e2e with a disabled module).

---

## File Structure

**New (API)**

| File | Responsibility |
| --- | --- |
| `apps/api/src/platform/management/flag.ts` | Stage of the rollout flag; route predicate |
| `apps/api/src/platform/management/capabilities.ts` | Capability vocabulary and `managementCapabilities(userId)` |
| `apps/api/src/platform/management/routes.ts` | `registerManagementRoutes(app, auth)` |
| `apps/api/tests/management-route-rule.test.ts` | Predicate rule |
| `apps/api/tests/management-capabilities.integration.test.ts` | Capabilities per role, compared with route answers |

**New (web), all under `apps/web/src/platform/settings-center/`**

| File | Responsibility |
| --- | --- |
| `types.ts` | `Capability`, `ManagementCapabilities`, `ManageScope`, `ManagementSection`, `ResolvedSection`, `SectionProps` |
| `routes.ts` | Parse and build `/manage` URLs; default scope |
| `registry.ts` | Areas, visibility by capability, section resolution, search, module section adapter |
| `texts.ts` | All wording of the frame and the platform sections |
| `capabilities.ts` | `useManagementCapabilities`, `centerState` |
| `scope-switcher.tsx` | `scopeOptions` and the switcher control |
| `settings-center.tsx` | The frame: switcher, search, navigation, section content, overviews |
| `sections/system.tsx`, `sections/organization.tsx`, `sections/project.tsx`, `sections/account.tsx` | The platform's sections of each scope |
| `*.test.tsx` next to each of the above | Unit tests |
| `apps/web/tests/settings-center.spec.ts` | Playwright |

**Modified**

| File | Change |
| --- | --- |
| `packages/config/src/index.ts`, `.env.example`, `docker-compose.yml`, `docker-compose.pve.yml`, `docker-compose.pve.source.sha256`, `scripts/check-coolify-compose.mjs` | The flag |
| `apps/api/src/server.ts` | Hook line, route registration, `/api/me` field |
| `apps/api/tests/access-matrix.integration.test.ts`, `apps/api/tests/fixtures/access-matrix.json` | Flag in the environment block; new row |
| `apps/web/src/lib/api.ts`, `apps/web/src/lib/i18n.ts` | `Identity.settingsCenter`; label `manageTitle` |
| `apps/web/src/platform/shell/routes.ts`, `routes.test.tsx` | Reserved segment, `manage` place |
| `apps/web/src/platform/shell/user-menu.tsx`, `user-menu.test.tsx` | Menu entry |
| `apps/web/src/components/orbit.tsx` | Project id for `/manage/p/:id`, capabilities resource, render branch |
| `apps/web/src/platform/administration/admin-area.tsx` | Export the section components; `hrefOf` prop |
| `apps/web/src/platform/administration/organization-manager.tsx` | `asAdministrator` confirmation (D-8) |
| `apps/web/src/components/management.tsx` | Export `ProjectSummaryPanel`, `ProjectReadinessPanel`; `Connectors` gets `embedded` |
| `apps/web/src/app/globals.css` | Frame styles |
| `docs/DESIGN_SYSTEM.md`, `docs/API_CONTRACT.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/deployment/COOLIFY.md` | Documentation |

---

### Task 1: Rollout flag `ORBIT_SETTINGS_CENTER`

**Files:**
- Create: `apps/api/src/platform/management/flag.ts`, `apps/api/tests/management-route-rule.test.ts`
- Modify: `packages/config/src/index.ts` (after `ORBIT_KNOWLEDGE_SHARES`), `.env.example`, `docker-compose.yml`, `docker-compose.pve.yml`, `docker-compose.pve.source.sha256`, `scripts/check-coolify-compose.mjs`, `apps/api/src/server.ts` (hook near line 413, `/api/me` near line 693)
- Test: `apps/api/tests/management-route-rule.test.ts`, `apps/api/tests/auth.integration.test.ts` or the file that already asserts `/api/me` fields (find with `grep -ln "knowledgeShares" apps/api/tests`)

**Interfaces:**
- Produces:
  - config key `ORBIT_SETTINGS_CENTER: "off" | "preview" | "on"`, default `"off"`
  - `settingsCenterStage(): "off" | "preview" | "on"`, `settingsCenterEnabled(): boolean`, `isManagementRoute(url: string): boolean` in `flag.ts`
  - `/api/me` field `settingsCenter: "off" | "preview" | "on"`

- [ ] **Step 1: Write the failing rule test**

```ts
import { describe, expect, it } from "vitest";
import { isManagementRoute } from "../src/platform/management/flag.ts";

describe("management route rule", () => {
  it("covers exactly the routes below /api/management/", () => {
    expect(isManagementRoute("/api/management/capabilities")).toBe(true);
    expect(isManagementRoute("/api/management")).toBe(false);
    expect(isManagementRoute("/api/admin/overview")).toBe(false);
    expect(isManagementRoute("/api/projects/:projectId/management/x")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it; expected FAIL** (module not found).

- [ ] **Step 3: Add the config key and `flag.ts`**

Config: `ORBIT_SETTINGS_CENTER: z.enum(["off", "preview", "on"]).default("off")`, with a comment that names the three stages as in spec 5.7. `flag.ts` reads it through `loadConfig()` on every call, like `administrationEnabled` in `apps/api/src/platform/administration/authz.ts:13`. `isManagementRoute` is `url.startsWith("/api/management/")`.

- [ ] **Step 4: Run the rule test; expected PASS.**

- [ ] **Step 5: Write the failing `/api/me` assertions**

In the test file that asserts the `/api/me` flags, add: with the variable unset the response has `settingsCenter: "off"`; with `process.env.ORBIT_SETTINGS_CENTER = "preview"` it has `"preview"` (restore the variable in `finally`).

- [ ] **Step 6: Run it; expected FAIL** (`settingsCenter` undefined).

- [ ] **Step 7: Add `settingsCenter: settingsCenterStage()` to the `/api/me` response and the hook line**

Hook (after the `isShareRoute` line): `if (isManagementRoute(req.routeOptions.url ?? "") && !settingsCenterEnabled()) throw new DomainError("NOT_FOUND", 404);`

- [ ] **Step 8: Add the variable to the environment files**

`.env.example`: `ORBIT_SETTINGS_CENTER=off`. Both compose files, next to `ORBIT_ACCOUNT`: `ORBIT_SETTINGS_CENTER: ${ORBIT_SETTINGS_CENTER:-off}`. `scripts/check-coolify-compose.mjs`: add the name to every list that contains `"ORBIT_SPEND_POLICY_SOURCE"` and add the default assertion next to the one at line 311 (`"off"`). Recompute `docker-compose.pve.source.sha256` and the "Canonical docker-compose.yml SHA256" header the way the script expects (run it; it prints the expected value on mismatch).

- [ ] **Step 9: Verify**

Run: the two test files, `pnpm test:coolify-compose` (or `node scripts/check-coolify-compose.mjs`), `./node_modules/.bin/tsc --noEmit`.
Expected: all pass.

- [ ] **Step 10: Commit** `feat(platform): rollout flag for the settings center`

---

### Task 2: Capabilities endpoint

**Files:**
- Create: `apps/api/src/platform/management/capabilities.ts`, `apps/api/src/platform/management/routes.ts`, `apps/api/tests/management-capabilities.integration.test.ts`
- Modify: `apps/api/src/server.ts` (register after `registerAccountRoutes`), `apps/api/tests/access-matrix.integration.test.ts` (environment block: `ORBIT_SETTINGS_CENTER: "preview"`), `apps/api/tests/fixtures/access-matrix.json`, `docs/API_CONTRACT.md`, OpenAPI artifacts

**Interfaces:**
- Consumes: `settingsCenterStage` (Task 1); `isSystemAdmin`, `administrationEnabled`, `accountEnabled` (`administration/authz.ts`); `connectionsEnabled` (`connections/central.ts`); the share flag helper used by `isShareRoute`'s hook line; `personalAssistantEnabled` (`assistant/personal-space.ts`); the condition under which `/api/mcp-grants` is registered (`mcp-auth/routes.ts`); `businessProjectsWhere` (`tenancy/member-scope.ts`); `sessionFor` (`tenancy/auth.ts`)
- Produces:

```ts
export const CAPABILITIES = [
  "system.overview", "system.users", "system.organizations", "system.connections",
  "system.ai", "system.mcp", "system.audit",
  "organization.overview", "organization.members", "organization.connections",
  "organization.ai", "organization.knowledge", "organization.apps",
  "project.overview", "project.profile", "project.members", "project.modules",
  "project.integrations", "project.ai", "project.data",
  "account.profile", "account.apps", "account.assistant",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type ManagementCapabilities = {
  stage: "preview" | "on";
  system: Capability[];
  account: Capability[];
  organizations: Array<{ id: string; name: string; capabilities: Capability[] }>;
  projects: Array<{
    id: string; name: string; workspaceId: string;
    role: "owner" | "editor" | "viewer"; capabilities: Capability[];
  }>;
};
export async function managementCapabilities(userId: string): Promise<ManagementCapabilities>;
export function registerManagementRoutes(app: FastifyInstance, auth: Auth): void;
// GET /api/management/capabilities → ManagementCapabilities (401 without a session)
```

**Rules** (the whole decision table; nothing else grants a capability):

| Capability | Granted when |
| --- | --- |
| `system.overview`, `system.users`, `system.organizations`, `system.mcp`, `system.audit` | `administrationEnabled()` and `isSystemAdmin(userId)` |
| `system.connections`, `system.ai` | the row above and `connectionsEnabled()` |
| `organization.overview`, `organization.members` | `administrationEnabled()` and `WorkspaceMember.role === "owner"` in that organization |
| `organization.connections`, `organization.ai` | the row above and `connectionsEnabled()` |
| `organization.knowledge` | organization owner and the share flag is on |
| `organization.apps` | organization owner and the MCP grant routes are registered |
| `project.overview`, `project.profile`, `project.modules`, `project.integrations` | any role in the project |
| `project.members`, `project.ai`, `project.data` | role `owner` (an organization owner counts as owner of every business project, as in `/api/me`) |
| `account.profile` | `accountEnabled()` |
| `account.apps` | the MCP grant routes are registered |
| `account.assistant` | `personalAssistantEnabled()` |

`organizations` lists only organizations with at least one capability (so only owned ones; a system administrator's foreign organizations are not listed, decision D-9). `projects` lists the projects of `businessProjectsWhere(userId)`; personal spaces never appear. A banned user has no session, so no special case.

- [ ] **Step 1: Write the failing integration test**

Model the fixtures on `apps/api/tests/administration.integration.test.ts` (its `signUp`, `signIn`, `call` helpers and environment block; at most three sign-ins per ten seconds from one address, so give each its own `CLIENT_IP_HEADER`). Environment: `ORBIT_ADMINISTRATION`, `ORBIT_ACCOUNT`, `ORBIT_CONNECTIONS` `"true"`, `ORBIT_SETTINGS_CENTER: "preview"`. People: `admin` (system administrator, no membership), `owner` (organization owner), `projectOwner` (project role owner, organization role viewer), `editor`, `viewer`, `outsider` (owner of another organization). One organization with two projects; `projectOwner`, `editor` and `viewer` belong to the first only.

Tests and their assertions:

```ts
it("answers 404 before authentication while the flag is off", …)
// ORBIT_SETTINGS_CENTER="off": GET without a cookie → 404 (not 401)

it("answers 401 without a session", …)

it("gives a system administrator the system scope and nothing of the organization", …)
// admin: system contains "system.users" and "system.connections"; organizations = []; projects = []

it("gives an organization owner the organization and every project as owner", …)
// owner: system = []; organizations[0].capabilities contains "organization.members",
// "organization.connections"; both projects listed with role "owner" and "project.ai"

it("limits a project owner to their project", …)
// projectOwner: organizations = []; projects = [first] with "project.members"; second project absent

it("gives editors and viewers no owner sections", …)
// editor, viewer: capabilities contain "project.overview", not "project.members", "project.ai", "project.data"

it("lists nothing of another organization", …)
// outsider: no id of the first organization or its projects anywhere in the body

it("follows the flags", …)
// ORBIT_CONNECTIONS="false": owner has no "organization.connections", admin no "system.ai"

it("agrees with the routes", …)
// for each person and for each pair below: capability present ⇔ the route answers 200
//   "system.users"             GET /api/admin/users
//   "organization.connections" GET /api/organizations/:id/connections
//   "organization.members"     GET /api/organizations/:id        (admin excepted: allowed by the route, not listed by D-9)
//   "project.members"          GET /api/projects/:id/members
//   "project.ai"               GET /api/projects/:id/ai-spend-policy
//   "project.overview"         GET /api/projects/:id/modules

it("follows a role change on the next request", …)
// demote projectOwner to viewer with authDb, call again: "project.members" is gone
```

- [ ] **Step 2: Run it; expected FAIL** (route answers 404 in every case).

- [ ] **Step 3: Implement `capabilities.ts` and `routes.ts`, register the routes**

Use `authDb` only (control-plane tables), three queries at most: the user's role, their workspace memberships with the workspace name, their business projects with their own membership. Compute the project role exactly as `/api/me` does (`apps/api/src/server.ts:706-712`). The route returns the object as is; it has no input.

- [ ] **Step 4: Run the test; expected PASS.**

- [ ] **Step 5: Access matrix**

Add `ORBIT_SETTINGS_CENTER: "preview"` to the environment block, run `UPDATE_ACCESS_MATRIX=1 … vitest run apps/api/tests/access-matrix.integration.test.ts`, and check the diff: exactly one new entry, `GET /api/management/capabilities`, `anonymous: unauthenticated`, every signed-in role `allowed:200`. Any other changed line is a defect.

- [ ] **Step 6: Regenerate the API artifacts and document**

`pnpm api:generate` (or the direct commands in the worktree notes of the README); review the diff. Add the endpoint to `docs/API_CONTRACT.md` with the rule table above.

- [ ] **Step 7: Verify**

Run: the new test, `access-matrix`, `administration-boundary.test.ts`, `tsc --noEmit`, `node scripts/source-check.mjs`.
Expected: all pass, 0 boundary violations.

- [ ] **Step 8: Commit** `feat(platform): capabilities for the settings center`

---

### Task 3: URL model

**Files:**
- Create: `apps/web/src/platform/settings-center/types.ts`, `routes.ts`, `routes.test.tsx`
- Modify: `apps/web/src/platform/shell/routes.ts` (`RESERVED`, `Place`, `locate`), `apps/web/src/platform/shell/routes.test.tsx`

**Interfaces:**
- Produces (in `types.ts`): `Capability` and `ManagementCapabilities` exactly as in Task 2, and

```ts
export type ManageScope =
  | { kind: "system" }
  | { kind: "organization"; organizationId: string }
  | { kind: "project"; projectId: string }
  | { kind: "account" };
export type ScopeKind = ManageScope["kind"];
/** `scope` null is the bare /manage; `rest` is what follows the area. */
export type ManageTarget = { scope: ManageScope | null; area: string | null; rest: readonly string[] };
```

- Produces (in `routes.ts`):

```ts
export function parseManagePath(parts: readonly string[]): ManageTarget | null; // parts after "manage", already decoded
export function manageHref(scope: ManageScope, area?: string, ...rest: string[]): string;
export function scopeKey(scope: ManageScope): string; // "system" | "o:<id>" | "p:<id>" | "me"
export function defaultScope(caps: ManagementCapabilities, lastProjectId: string | null): ManageScope | null;
```

- Produces (in `shell/routes.ts`): `Place` gains `{ kind: "manage"; target: ManageTarget }`.

- [ ] **Step 1: Write the failing tests** (`settings-center/routes.test.tsx`)

```ts
it("parses the four scopes", () => {
  expect(parseManagePath([])).toEqual({ scope: null, area: null, rest: [] });
  expect(parseManagePath(["system"])).toEqual({ scope: { kind: "system" }, area: null, rest: [] });
  expect(parseManagePath(["system", "users", "u1"])).toEqual({ scope: { kind: "system" }, area: "users", rest: ["u1"] });
  expect(parseManagePath(["o", "w1", "ai", "budget"])).toEqual({ scope: { kind: "organization", organizationId: "w1" }, area: "ai", rest: ["budget"] });
  expect(parseManagePath(["p", "p1", "modules", "finance", "accounts"])).toEqual({ scope: { kind: "project", projectId: "p1" }, area: "modules", rest: ["finance", "accounts"] });
  expect(parseManagePath(["me", "profile"])).toEqual({ scope: { kind: "account" }, area: "profile", rest: [] });
});
it("refuses what is not a scope", () => {
  for (const parts of [["o"], ["p"], ["admin"], ["x", "y"]]) expect(parseManagePath(parts)).toBeNull();
});
it("builds encoded addresses that parse back", () => {
  expect(manageHref({ kind: "system" })).toBe("/manage/system");
  expect(manageHref({ kind: "organization", organizationId: "w 1" }, "ai", "budget")).toBe("/manage/o/w%201/ai/budget");
  expect(manageHref({ kind: "account" }, "profile")).toBe("/manage/me/profile");
});
it("opens the last project, else the first scope the member has", () => {
  // caps with projects p1, p2: lastProjectId "p2" → project p2; null → project p1
  // no projects, account ["account.profile"] → account
  // no projects, no account, system non-empty → system
  // nothing at all → null
});
```

In `shell/routes.test.tsx` add: `locate("/manage", table)` → `{ kind: "manage", target: { scope: null, area: null, rest: [] } }`; `locate("/manage/p/p%201/ai", table)` has `projectId: "p 1"`; `locate("/manage/x", table)` → `{ kind: "notFound" }`; a platform view or module with path or id `manage` makes `routeTable` throw `WEB_ROUTES_INVALID`.

- [ ] **Step 2: Run them; expected FAIL.**

- [ ] **Step 3: Implement** `types.ts`, `routes.ts`, and in `shell/routes.ts` add `"manage"` to `RESERVED` and a `first === "manage"` branch in `locate` before the `p` branch.

- [ ] **Step 4: Run the tests; expected PASS**, and `apps/web/src/platform/shell/*.test.tsx` still pass.

- [ ] **Step 5: Commit** `feat(web): address scheme of the settings center`

---

### Task 4: Section registry, visibility and search

**Files:**
- Create: `apps/web/src/platform/settings-center/registry.ts`, `registry.test.tsx`
- Modify: `apps/web/src/platform/settings-center/types.ts`

**Interfaces:**
- Consumes: `Capability`, `ScopeKind`, `ManageScope` (Task 3); `Label`, `SettingsSection` (`shell/types.ts`); `Identity` (`lib/api.ts`)
- Produces (in `types.ts`):

```ts
export type SectionProps = {
  scope: ManageScope;
  /** The path part after the section, e.g. a user id. */
  id?: string;
  locale: Locale;
  identity: Identity;
  /** Address of another section of the same scope. */
  hrefOf(area: string, ...rest: string[]): string;
};
/** What navigation and search need; `id` may hold a slash ("finance/accounts"). */
export type SectionMeta = {
  id: string; scope: ScopeKind; area: string; moduleId?: string;
  label: Label; description: Label; keywords?: Label; order: number; advanced?: true;
};
export type ManagementSection = SectionMeta & {
  capability: Capability;
  component: ComponentType<SectionProps>;
};
export type ResolvedSection = SectionMeta & { render(props: SectionProps): ReactNode };
export type Area = { id: string; label: Label; order: number };
```

- Produces (in `registry.ts`):

```ts
export const AREAS: Readonly<Record<ScopeKind, readonly Area[]>>;
export function validateSections(sections: readonly ManagementSection[]): void; // throws SETTINGS_SECTIONS_INVALID
export function visibleSections(sections: readonly ManagementSection[], scope: ScopeKind, capabilities: readonly Capability[]): ResolvedSection[];
export function resolveSection<T extends { area: string; id: string; order: number }>(sections: readonly T[], area: string | null, rest: readonly string[]): { section: T; id?: string } | null;
export function sectionPath(section: { area: string; id: string }): string[]; // [area, ...id.split("/")]
export function navGroups(sections: readonly SectionMeta[], scope: ScopeKind, moduleName: (id: string) => Label | undefined): Array<{ id: string; label: Label; sections: SectionMeta[] }>;
export function searchSections<T extends SectionMeta>(sections: readonly T[], query: string): T[];
export function moduleSectionId(moduleId: string, tabKey: string, platformKeys: readonly string[]): string;
```

**Areas** (ids in this order; labels in `texts.ts`, Task 5):

| Scope | Areas |
| --- | --- |
| system | `overview`, `users`, `organizations`, `integrations`, `ai`, `mcp`, `security` |
| organization | `overview`, `members`, `integrations`, `ai`, `knowledge`, `policies` |
| project | `overview`, `profile`, `members`, `modules`, `integrations`, `ai`, `data` |
| account | `profile`, `connections`, `assistant` |

**Rules**

- `validateSections`: ids unique per scope and area; every `area` is in `AREAS[scope]`; `id` segments match `/^[a-z][a-z0-9-]*$/`.
- `resolveSection`: `area` null opens the first area that has a section. Within the area, in this order:
  1. the longest prefix of `rest` that equals a section's `id.split("/")` selects it, and the next segment is the `id`;
  2. else, when `rest` has one segment and sections exist whose id starts with `rest[0] + "/"` (a module), the first of them by `order` is selected, without an `id`;
  3. else, when `rest` has one segment, the area's first section by `order` gets it as `id`;
  4. else null. Also null when the area has no section.
- `navGroups`: one group per area in `AREAS` order, holding the sections without `moduleId`; in the project scope each module with sections follows the `modules` group as its own group, labelled by `moduleName(moduleId)`, in the order the sections arrive. Groups without sections are left out.
- `searchSections`: empty or whitespace query returns `[]`; otherwise case-insensitive substring match on `label`, `description` and `keywords` in both languages, in the given order.
- `moduleSectionId(moduleId, tabKey, platformKeys)`: `"<moduleId>/settings"` when `tabKey === moduleId` or `platformKeys` contains `tabKey`; `"<moduleId>/<rest>"` when `tabKey` starts with `"<moduleId>-"`; else `"<moduleId>/<tabKey>"`. Examples: `("work","work")` → `work/settings`; `("finance","finance-accounts")` → `finance/accounts`; `("marketing","policy")` → `marketing/policy`; `("webmail","integrations", ["integrations"])` → `webmail/settings`.

- [ ] **Step 1: Write the failing tests** (`registry.test.tsx`)

One `it` per rule above with these cases as assertions:

```ts
// validateSections
expect(() => validateSections([a, { ...a }])).toThrow(/SETTINGS_SECTIONS_INVALID/);          // duplicate
expect(() => validateSections([{ ...a, area: "nope" }])).toThrow(/SETTINGS_SECTIONS_INVALID/);
// visibleSections
expect(visibleSections([users, audit, orgMembers], "system", ["system.users"]).map((s) => s.id)).toEqual(["users"]);
// resolveSection, sections: users(order 0) and invitations(order 10) in area "users"
expect(resolveSection(s, "users", [])).toMatchObject({ section: { id: "users" }, id: undefined });
expect(resolveSection(s, "users", ["invitations"])).toMatchObject({ section: { id: "invitations" } });
expect(resolveSection(s, "users", ["u-123"])).toMatchObject({ section: { id: "users" }, id: "u-123" });
expect(resolveSection(s, "users", ["u-123", "x"])).toBeNull();
expect(resolveSection(s, "audit", [])).toBeNull();                                            // hidden or unknown area
expect(resolveSection(s, null, [])).toMatchObject({ section: { id: "users" } });
// module ids with a slash
expect(resolveSection(m, "modules", ["finance", "accounts"])).toMatchObject({ section: { id: "finance/accounts" } });
expect(resolveSection(m, "modules", [])).toMatchObject({ section: { id: "switches" } });
expect(resolveSection(m, "modules", ["finance"])).toMatchObject({ section: { id: "finance/mailboxes" }, id: undefined }); // the module's first section
// navGroups: project scope with switches, finance/accounts, finance/currencies, marketing/policy
//   → ids ["modules", "finance", "marketing"], labels of the last two from moduleName
// searchSections
expect(searchSections(all, "  ")).toEqual([]);
expect(searchSections(all, "MITGLIED").map((x) => x.id)).toContain("members");               // German label
expect(searchSections(all, "invoice").map((x) => x.id)).toContain("finance/accounts");       // keyword
// moduleSectionId: the four examples above
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement `registry.ts` and the types.**
- [ ] **Step 4: Run the tests; expected PASS.**
- [ ] **Step 5: Commit** `feat(web): section registry of the settings center`

---

### Task 5: Texts, scope switcher and frame

**Files:**
- Create: `texts.ts`, `texts.test.tsx`, `scope-switcher.tsx`, `scope-switcher.test.tsx`, `settings-center.tsx`, `settings-center.test.tsx` (all in `settings-center/`)
- Modify: `apps/web/src/app/globals.css`, `apps/web/src/lib/i18n.ts` (label `manageTitle`)

**Interfaces:**
- Consumes: Tasks 3 and 4; `SettingsNav`, `SettingsGroup` (`shell/settings-nav.tsx`); `PageHead` (`platform/ui/collection.tsx`); `Input`, `Empty` (`components/ui/primitives.tsx`)
- Produces:

```ts
// texts.ts
export function centerText(locale: Locale): (key: CenterTextKey) => string;
export const areaLabel: (scope: ScopeKind, area: string) => Label;
// scope-switcher.tsx
export function scopeOptions(caps: ManagementCapabilities, locale: Locale): Array<{ label: string | null; options: Array<{ key: string; label: string; href: string }> }>;
export function ScopeSwitcher(props: { caps: ManagementCapabilities; current: ManageScope; locale: Locale; onSelect(href: string): void }): JSX.Element;
// settings-center.tsx
export function SettingsCenterView(props: {
  scope: ManageScope; scopeName: string;
  sections: readonly ResolvedSection[];           // visible sections of this scope
  target: ManageTarget; caps: ManagementCapabilities;
  identity: Identity; locale: Locale;
  moduleName(id: string): Label | undefined;
  navigate(href: string): void;
  backHref: string; backLabel: string;
}): JSX.Element;
```

**Exact copy** (label `manageTitle` and the frame):

| Key | English | German |
| --- | --- | --- |
| `manageTitle` | Administration & settings | Verwaltung & Einstellungen |
| `scopeLabel` | Applies to | Gilt für |
| `scopeSystem` | Whole system | Gesamtes System |
| `scopeOrganizations` | Organizations | Organisationen |
| `scopeProjects` | Projects | Projekte |
| `scopeAccount` | My account | Mein Konto |
| `searchLabel` | Search settings | Einstellungen suchen |
| `searchEmpty` | No setting matches. | Keine Einstellung passt dazu. |
| `advanced` | Advanced | Erweitert |
| `notPermittedTitle` | Not available | Nicht verfügbar |
| `notPermittedBody` | This page does not exist or your role does not include it. | Diese Seite gibt es nicht oder deine Rolle umfasst sie nicht. |
| `overviewHint` | Choose an area. Each one says what it is for. | Wähle einen Bereich. Jeder sagt, wofür er da ist. |

Area labels (EN / DE): Overview / Übersicht; Users / Benutzer; Organizations & projects / Organisationen & Projekte; Integrations / Integrationen; AI / KI; MCP / MCP; Security & audit / Sicherheit & Protokoll; Members / Mitglieder; Knowledge / Wissen; Policies / Richtlinien; Profile / Profil; Modules / Module; Data / Daten; Connections / Verbindungen; Assistant / Assistent.

**Behaviour**

- `scopeOptions`: first group without a label holds "Whole system" (only when `caps.system` is non-empty) and "My account" (only when `caps.account` is non-empty); then the group "Organizations" with one option per `caps.organizations`; then one group per organization that has projects in `caps.projects` (label: the organization's name when the member has it in `caps.organizations`, else "Projects"), each project an option. `key` is `scopeKey`, `href` is `manageHref(scope)`.
- `ScopeSwitcher`: a labelled native `<select>` with `<optgroup>`s (label `scopeLabel`), the current scope selected.
- `SettingsCenterView` layout: page head with `manageTitle` as eyebrow and `scopeName` as title; a row with the switcher and the search field; below it `SettingsNav` (groups from `navGroups`, `key` = `sectionPath(section).join("/")`, `hrefOf` = `manageHref(scope, …)`) beside the content. Content: the search result list while the query is not empty (each hit a link with label and description); else the resolved section (`PageHead` with its label and description, then `section.render(props)`; an `advanced` section inside `<details>` with summary `advanced`); else, when `target.area` is null and no section resolves, the overview (one link card per group with the group label and its sections' labels); else the `notPermitted` notice.
- The section list marks the open section with `aria-current="page"`; the search field is a labelled `<input type="search">`; the frame adds no heading level above `h1`.
- CSS: reuse `.admin-layout`, `.settings-nav`, `.settings-content`; add `.manage-toolbar` (switcher and search in one row, stacked at 760 px and below) and `.manage-cards` (overview grid, `repeat(auto-fit, minmax(min(280px, 100%), 1fr))`). No new colours.

- [ ] **Step 1: Write the failing tests**

```ts
// texts.test.tsx
it("has German for every English key and no extra key", …)   // Object.keys equal; every German value non-empty
it("labels every area of AREAS in both languages", …)
// scope-switcher.test.tsx
it("offers the system only to administrators and the account only while it exists", …)
it("groups projects under their organization and lists no organization the member does not own", …)
it("renders a labelled select with the current scope selected", …)   // renderToStaticMarkup: <label for=…>, selected option
// settings-center.test.tsx (renderToStaticMarkup)
it("marks the open section and renders its content", …)              // aria-current="page" on the link; the section's marker text present
it("shows the overview for a scope without an area", …)              // one card per nav group
it("shows the not-available notice for a hidden or unknown section", …) // target area "ai" with no visible ai section
it("wraps an advanced section in a disclosure", …)                   // <details> present, no `open` attribute
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement the three files and the CSS.**
- [ ] **Step 4: Run the tests; expected PASS.**
- [ ] **Step 5: Commit** `feat(web): frame of the settings center`

---

### Task 6: Shell integration

**Files:**
- Create: `apps/web/src/platform/settings-center/capabilities.ts`, `capabilities.test.tsx`
- Modify: `apps/web/src/lib/api.ts` (`Identity.settingsCenter?: "off" | "preview" | "on"`), `apps/web/src/platform/shell/user-menu.tsx`, `user-menu.test.tsx`, `apps/web/src/components/orbit.tsx`

**Interfaces:**
- Consumes: Tasks 3 to 5; `useResource` (`lib/api.ts`)
- Produces:

```ts
// capabilities.ts
export function useManagementCapabilities(enabled: boolean): { data: ManagementCapabilities | null; loading: boolean; error: { status?: number; message: string } | null; refresh(): void };
export type CenterState =
  | { kind: "off" } | { kind: "loading" } | { kind: "error"; message: string }
  | { kind: "redirect"; href: string } | { kind: "notFound" }
  | { kind: "scope"; scope: ManageScope; capabilities: readonly Capability[]; name: string };
export function centerState(input: {
  stage: "off" | "preview" | "on" | undefined;
  target: ManageTarget;
  caps: ManagementCapabilities | null; loading: boolean; error: { message: string } | null;
  lastProjectId: string | null;
}): CenterState;
// user-menu.tsx: userMenuEntries(...) additionally returns `manage: string | null`
```

**Rules for `centerState`**

- `stage` undefined or `"off"` → `off`.
- Error → `error`; no data yet → `loading`.
- `target.scope` null → `redirect` to `manageHref(defaultScope(caps, lastProjectId))`, or `notFound` when there is no scope at all.
- Scope `system` with empty `caps.system`, `account` with empty `caps.account`, an organization not in `caps.organizations`, a project not in `caps.projects` → `notFound`.
- Else `scope` with that scope's capabilities and its name (organization or project name; `scopeSystem` and `scopeAccount` are resolved by the caller, so `name` is `""` for those).

**Changes in `orbit.tsx`** (no code moves)

1. `projectId` (line 150) also takes `place.target.scope.projectId` when `place.kind === "manage"` and the scope is a project. `project`, the module states and `shell` then load as for a project page.
2. `const caps = useManagementCapabilities(place.kind === "manage" && Boolean(identity.data?.settingsCenter) && identity.data?.settingsCenter !== "off")`, placed next to `moduleStates` (before every early return).
3. A redirect effect: when `centerState(...)` is `redirect`, `router.replace(href)`.
4. A render branch before `place.kind === "organizations"`: for `place.kind === "manage"`, by `centerState`: `off` and `notFound` → `frame(<NotFound t={t} project={false} />)`; `loading` and `redirect` → the boot loading view; `error` → `frame` with an `Alert` and a retry button calling `caps.refresh`; `scope` → `frame(…, true)` around a `StandaloneContext.Provider` (same value as for standalone pages) and the scope's component from Tasks 7 to 10. For the project scope additionally wrap in `ShellContext.Provider value={shell}` and `WorkspaceContext.Provider` with the same value the project page builds (lines 955-966; role from the project role, no module role), show `Loading` while `waitsForModuleStates(...)`, and key the subtree by project id and the enabled module ids like the project page does.
5. Document title for the place: `manageTitle`.
6. `LAST_PROJECT` is written for the project scope too (the existing effect does it once `project` is set).

**User menu:** `manage` is `"/manage"` when `identity.settingsCenter` is `"preview"` or `"on"`, else null. The entry (icon `Settings`, label `manageTitle`) comes first. The three existing entries stay.

- [ ] **Step 1: Write the failing tests**

```ts
// capabilities.test.tsx
it("is off without the flag", …)                                   // stage undefined and "off"
it("waits, then reports an error with its message", …)
it("redirects the bare address to the last project", …)            // redirect.href === "/manage/p/p2"
it("refuses a project the member does not belong to and an organization they do not own", …)  // notFound
it("refuses the system scope to a non-administrator", …)
it("names the open organization and project", …)
// user-menu.test.tsx
it("offers the settings center only while its flag is not off", …)
// userMenuEntries(base).manage === null; with settingsCenter "preview" → "/manage"; markup contains href="/manage" before href="/account"
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement `capabilities.ts`, the user menu entry and the `orbit.tsx` changes.** Until Tasks 7 to 10 exist, the `scope` branch renders `SettingsCenterView` with an empty section list (the overview says nothing is available).
- [ ] **Step 4: Run** the new tests and all of `apps/web/src/platform/shell/*.test.tsx` and `apps/web/src/components/*.test.tsx`; expected PASS. `tsc --noEmit` in `apps/web`.
- [ ] **Step 5: Commit** `feat(web): open the settings center from the shell`

---

### Task 7: System scope

**Files:**
- Create: `apps/web/src/platform/settings-center/sections/system.tsx`, `sections/system.test.tsx`
- Modify: `apps/web/src/platform/administration/admin-area.tsx`, `apps/web/src/platform/administration/organization-manager.tsx`, `settings-center/texts.ts`, `apps/web/src/components/orbit.tsx` (mount the scope)

**Interfaces:**
- Consumes: `ManagementSection`, `SectionProps`, `visibleSections`, `SettingsCenterView`
- Produces:
  - `export const systemSections: readonly ManagementSection[]`
  - `export function SystemScope(props: { capabilities: readonly Capability[]; target: ManageTarget; caps: ManagementCapabilities; identity: Identity; locale: Locale; navigate(href: string): void }): JSX.Element`
  - from `admin-area.tsx`: exported `Overview`, `UserList`, `UserDetail`, `Organizations`, `Projects`, `Invitations`, `Audit`, `Integrations`; `UserList`, `UserDetail`, `Organizations` and `Projects` take an optional `hrefOf?: (section: string, id?: string) => string` that defaults to `adminHref`
  - from `organization-manager.tsx`: `OrganizationManager` takes `asAdministrator?: boolean`; exported `grantsAccess(change: { kind: "organizationRole" | "projectRole" | "invitation" | "removal" }): boolean`

**Sections**

| Area | id | Capability | Content |
| --- | --- | --- | --- |
| overview | `status` | `system.overview` | `Overview`, `WebmailStatusPanel` |
| users | `users` | `system.users` | `UserList`, or `UserDetail` when `id` is set |
| users | `invitations` | `system.users` | `Invitations` |
| organizations | `organizations` | `system.organizations` | `Organizations`, or with `id`: a back link and `OrganizationManager asAdministrator` |
| organizations | `projects` | `system.organizations` | `Projects` |
| integrations | `connections` | `system.connections` | `Integrations` |
| ai | `overview` | `system.ai` | a panel with the text below and a link to `/admin/ai` |
| mcp | `clients` | `system.mcp` | `McpAdmin` |
| security | `audit` | `system.audit` | `Audit` |

`hrefOf` passed to the admin components: `users` → `manageHref(system, "users", id)`; `organizations` → `manageHref(system, "organizations", id)`. Labels and descriptions: one sentence each in `texts.ts`, taken from the page heads these components already show.

AI link panel copy: EN "AI standards, models and prices are still edited on the current page. They move here once their forms save safely." / DE "KI-Standards, Modelle und Preise werden noch auf der bisherigen Seite bearbeitet. Sie ziehen hierher um, sobald ihre Formulare sicher speichern." Button: "Open AI settings" / "KI-Einstellungen öffnen".

**D-8 confirmation.** `grantsAccess` is true for `organizationRole`, `projectRole` and `invitation`, false for `removal`. With `asAdministrator`, `OrganizationManager` opens a `Modal` before sending a change for which `grantsAccess` is true, and sends it only on confirm. Without the prop nothing changes. Copy:

| | English | German |
| --- | --- | --- |
| Title | Assign this role as system administrator? | Diese Rolle als Systemadministrator vergeben? |
| Body | You are acting as a system administrator, not as an owner of this organization. The role gives the person access to the content of the projects it covers. The change is recorded in the system audit log. | Du handelst als Systemadministrator, nicht als Inhaber dieser Organisation. Die Rolle gibt der Person Zugriff auf die Inhalte der betroffenen Projekte. Die Änderung wird im System-Audit protokolliert. |
| Confirm / cancel | Assign role / Cancel | Rolle vergeben / Abbrechen |

- [ ] **Step 1: Write the failing tests**

```ts
it("registers valid sections", () => validateSections(systemSections));
it("shows the connection and AI sections only with their capability", …)
// visibleSections(systemSections, "system", ["system.overview","system.users"]) has no "connections" and no ai "overview"
it("links users and organizations inside the center", …)
// the hrefOf handed to UserList maps ("users","u1") → "/manage/system/users/u1"; ("organizations","w1") → "/manage/system/organizations/w1"
it("asks before a change that grants access, not before a removal", …)   // grantsAccess
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement.** In `admin-area.tsx` only add `export` and thread `hrefOf` through the eight `adminHref(...)` call sites inside those components; `AdminArea` itself is unchanged.
- [ ] **Step 4: Run** the new tests, `apps/web/src/platform/administration/*.test.tsx`, `tsc --noEmit`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): system scope of the settings center`

---

### Task 8: Organization scope

**Files:**
- Create: `sections/organization.tsx`, `sections/organization.test.tsx`
- Modify: `settings-center/texts.ts`, `apps/web/src/components/orbit.tsx`

**Interfaces:**
- Produces: `organizationSections: readonly ManagementSection[]`; `OrganizationScope(props)` with the same props as `SystemScope` plus `organizationId: string`

**Sections**

| Area | id | Capability | Content |
| --- | --- | --- | --- |
| overview | `summary` | `organization.overview` | name, member and project counts from `GET /organizations/:id` (the request `OrganizationManager` makes), and links to the other areas and to `/o/:id/agents` |
| members | `members` | `organization.members` | `OrganizationManager` (name, members × projects, invitations) |
| integrations | `connections` | `organization.connections` | `ConnectionsPanel mode="owner"` with `base` and `targets` exactly as `organization-integrations.tsx:36-41` |
| ai | `usage` | `organization.ai` | `AiUsagePanel` (read-only) |
| ai | `overview` | `organization.ai` | the link panel of Task 7, linking to `/o/:id/settings` |
| knowledge | `shares` | `organization.knowledge` | `KnowledgeSharesPanel` with the props of `organization-integrations.tsx:57-63` |
| policies | `apps` | `organization.apps` | the organization's connected apps: `GrantList` over `GET /workspaces/:id/mcp-grants`, with the handlers `ConnectedApps` uses at `connect/connected-apps.tsx:266-291` |

Not in this plan: the organization-wide pause (it reads the project context today; it moves in phase 5 and stays on Operations until then).

- [ ] **Step 1: Write the failing tests**

```ts
it("registers valid sections", () => validateSections(organizationSections));
it("shows integrations and AI only with their capabilities", …)
it("shows knowledge only with organization.knowledge and apps only with organization.apps", …)
it("offers no AI form", …)   // the ai sections' components are the usage panel and the link panel only
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and `tsc --noEmit`; expected PASS.**
- [ ] **Step 5: Commit** `feat(web): organization scope of the settings center`

---

### Task 9: Project scope and module sections

**Files:**
- Create: `sections/project.tsx`, `sections/project.test.tsx`
- Modify: `apps/web/src/components/management.tsx`, `settings-center/registry.ts` (adapter), `settings-center/texts.ts`, `apps/web/src/components/orbit.tsx`

**Interfaces:**
- Consumes: `ShellContext` (`settings`, `modules`), `useWorkspace`, `moduleSectionId` (Task 4)
- Produces:
  - from `management.tsx`: exported `ProjectSummaryPanel` and `ProjectReadinessPanel` (the two inline blocks of the `project` tab, lines 585-708, moved into components without changing markup; `ProjectSettings` renders them), and `Connectors` takes `embedded?: boolean` (no `PageHead` when true)
  - `export function adaptModuleSections(contributed: ReadonlyArray<{ section: SettingsSection; shown: ReturnType<SettingsSection["useSection"]> }>, modules: ReadonlyArray<{ id: string; displayName: Label }>, platformKeys: readonly string[]): { sections: ResolvedSection[]; notices: ReactNode[] }` in `registry.ts`
  - `projectSections: readonly ManagementSection[]`; `ProjectScope(props)` (same props as `SystemScope`; it reads the project from `useWorkspace()`)

**Platform sections**

| Area | id | Capability | Content |
| --- | --- | --- | --- |
| overview | `summary` | `project.overview` | `ProjectSummaryPanel`, `ProjectReadinessPanel` |
| profile | `profile` | `project.profile` | `ContentLanguagesPanel`, `ProfileLinksPanel`, `ProjectAdministration` |
| members | `members` | `project.members` | `ProjectMembers` |
| modules | `switches` | `project.modules` | `ModuleSettings`, `SignalSettingsSection` |
| integrations | `connections` | `project.integrations` | `Connectors embedded` |
| integrations | `google-drive` | `project.integrations` | `GoogleDriveSettings` |
| ai | `overview` | `project.ai` | the link panel of Task 7, linking to `shell.hrefOf("settings") + "?section=ai"` |
| data | `retention` | `project.data` | `RetentionControl` |

**Module sections.** `ProjectScope` calls `useSection()` of every entry of `shell.settings` on every render, in order, exactly as `ProjectSettings` does (`management.tsx:526-529`), and passes the results to `adaptModuleSections`:

- a section whose hook returned null is left out;
- `area` is `"modules"`, `moduleId` is `section.tab.group`, `id` is `moduleSectionId(moduleId, section.tab.key, platformKeys)` with `platformKeys = ["project","members","integrations","ai","retention","modules","apps"]`;
- several contributions with the same resulting id become one section whose content renders them by `section.order`;
- `label` is `shown.label ?? section.tab.label`, except for an id ending in `/settings` that came from a platform key, where it is the module's `displayName`; `description` is the module's `description`; `order` is `section.tab.order`;
- `notices` collects every `shown.notice`; `ProjectScope` renders them above the section content.

`shell.settings` already holds only the sections of modules that are shown for the project, so a disabled module or module access `none` contributes nothing.

- [ ] **Step 1: Write the failing tests**

```ts
it("registers valid sections", () => validateSections(projectSections));
it("gives viewers overview, profile, modules and integrations, and owners members, AI and data too", …)
it("adapts module sections under their module", () => {
  // webRegistry modules' settings with shown = { content: <marker/> }:
  // ids include "marketing/policy", "marketing/brand", "work/settings", "issues/settings",
  // "support/settings", "finance/mailboxes", "finance/accounts", "webmail/settings"
});
it("leaves out a section whose hook returned null and keeps its notice out", …)
it("joins contributions with the same id in their order", …)
it("resolves a module section by its address", () => {
  // resolveSection(sections, "modules", ["finance","accounts"]) → that section
  // resolveSection(sections, "modules", ["finance"]) → the first finance section
});
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement.** Extract the two panels first and run `apps/web/src/components/*.test.tsx` and `apps/web/src/platform/project-settings/*.test.tsx` before going on; they must still pass.
- [ ] **Step 4: Run the tests and `tsc --noEmit`; expected PASS.**
- [ ] **Step 5: Commit** `feat(web): project scope of the settings center`

---

### Task 10: Account scope

**Files:**
- Create: `sections/account.tsx`, `sections/account.test.tsx`
- Modify: `settings-center/texts.ts`, `apps/web/src/components/orbit.tsx`

**Interfaces:**
- Produces: `accountSections: readonly ManagementSection[]`; `AccountScope(props)` (same props as `SystemScope`)

**Sections**

| Area | id | Capability | Content |
| --- | --- | --- | --- |
| profile | `account` | `account.profile` | `AccountView` (profile, e-mail, password, sessions) |
| connections | `apps` | `account.apps` | the member's connected apps: `GrantList` over `GET /mcp-grants`, with the handlers `ConnectedApps` uses at `connect/connected-apps.tsx:250-265` |
| assistant | `context` | `account.assistant` | `PersonalContextView` |

`AccountView` and `PersonalContextView` read `useStandalone()`; Task 6 provides that context. Splitting the account page into profile, security, language and notifications is phase 5.

- [ ] **Step 1: Write the failing tests**

```ts
it("registers valid sections", () => validateSections(accountSections));
it("shows each section only with its capability", …)   // [] → none; ["account.apps"] → only "apps"
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and `tsc --noEmit`; expected PASS.**
- [ ] **Step 5: Commit** `feat(web): account scope of the settings center`

---

### Task 11: Browser acceptance, documentation, full checks

**Files:**
- Create: `apps/web/tests/settings-center.spec.ts`
- Modify: `docs/DESIGN_SYSTEM.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/deployment/COOLIFY.md` (flag and its stages), `docs/plans/SYSTEM_MANAGEMENT_V2.md` (phase 2 status)

**Interfaces:**
- Consumes: everything above; the seeded e2e installation and `login` helper pattern of `apps/web/tests/administration.spec.ts`

- [ ] **Step 1: Write the Playwright spec** (skips unless `/api/me` reports `settingsCenter` other than `"off"`; run the stack with `ORBIT_ADMINISTRATION=true ORBIT_ACCOUNT=true ORBIT_SETTINGS_CENTER=preview`)

```ts
test("reaches the four scopes through the account menu and the switcher", …)
// menu entry "Administration & settings" → /manage/p/<last project>; switcher lists Whole system, My account,
// the organization and the project; choosing each shows its overview with its name as the heading
test("opens a section by address and marks it", …)
// /manage/system/users → link "Users" has aria-current="page"; /manage/system/users/<id> shows the user detail
test("searches settings", …)        // typing "audit" lists "Audit log"; choosing it opens /manage/system/security/audit
test("refuses a foreign project and an unknown section", …)
// /manage/p/00000000-0000-4000-8000-000000000000 and /manage/system/nope → the not-found text
test("hides a disabled module's settings", …)
// with a module off for the project: no group of that module in the section list, and its address shows "Not available"
test("keeps the old pages", …)      // /admin, /o/<id>/settings, /p/<id>/settings?section=members, /account still render their headings
test("works on a phone", …)         // 390 × 844: the section list is the labelled select; no horizontal scroll (scrollWidth ≤ clientWidth)
test("is keyboard operable", …)     // Tab reaches switcher, search, first section link in this order; Enter opens the section
```

- [ ] **Step 2: Run it against the local stack; expected PASS.** If a local stack cannot be started, say so in the report and name the tests that did not run.

- [ ] **Step 3: Run the full checks**

`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:coolify-compose`. Expected: all pass; report the counts. Revert `evals/knowledge/last-deterministic-run.json` and `apps/web/next-env.d.ts` if they changed.

- [ ] **Step 4: Check both flag states by hand in the browser**

`off`: `/manage` shows "not found", the user menu has no new entry, `GET /api/management/capabilities` answers 404. `preview`: German and English at 1440, 768 and 390 px, light check of focus order and of reduced motion.

- [ ] **Step 5: Write the documentation**

`docs/DESIGN_SYSTEM.md`: a paragraph on the settings center frame (switcher, search, section list, overview cards) after the settings paragraph. `docs/deployment/COOLIFY.md`: the flag, its three stages and that `preview` needs approval. `docs/IMPLEMENTATION_STATUS.md`: a new top entry with state (local, not on `main`), what was built, the verification results with counts, and what is not in phase 2 (redirects, integrations catalog, AI area, organization pause, account split). `docs/plans/SYSTEM_MANAGEMENT_V2.md`: mark phase 2 as implemented locally.

- [ ] **Step 6: Commit** `test(web): settings center in the browser; docs`

- [ ] **Step 7: Request review.** Use `superpowers:requesting-code-review` on the whole branch, with the Review Focus list. Then report to Mario and wait for his approval before any push to `main`.

# Settings Center Phase 5 (Flag `on`: Redirects, Navigation, Module Sections, Public Access) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `ORBIT_SETTINGS_CENTER=on`, every old settings address lands on its section of the settings center, the navigation points there, module pages that duplicated central configuration show state and a link, and revoking a public key that a Support inbox uses no longer leaves the inbox pointing at it.

**Architecture:** One pure table maps an old address to a center address; the shell applies it with `on` after checking the member's capabilities, so a redirect never ends on "Not available" where the old page worked. The same table drives the navigation helpers, so links and redirects cannot disagree. Module settings keep reaching the center through the existing adapter, which gains descriptions, search words and a validation that runs over the real registry. The public keys list moves into the center as its own section; a new module contribution lets a module release its reference when a key is revoked. With `off` and `preview` nothing changes.

**Tech Stack:** TypeScript, Next.js App Router (client shell), Fastify, Prisma (`scoped` project transactions, `authDb`), zod, Vitest (`renderToStaticMarkup` and pure functions in the web; integration tests over `app.inject`), Playwright.

**Spec:** [docs/plans/SYSTEM_MANAGEMENT_V2.md](../../plans/SYSTEM_MANAGEMENT_V2.md) (sections 5.1, 5.2, 5.3, 5.4, 5.7, 10 rows 5.1 to 5.3, 11 D-6, 14, 15; finding F-5 in 4.1; inventory row J3), [docs/adr/0027-settings-center.md](../../adr/0027-settings-center.md). Earlier plans describe what this one builds on: [phase 2](2026-11-11-settings-center-phase-2.md), [phase 3](2026-11-11-settings-center-phase-3-integrations.md), [phase 4](2026-11-11-settings-center-phase-4-ai.md).

**Not in this plan (its own plan after `on` is accepted in production, spec row 5.4 and dependency "5.3 before 5.4"):** switching the links the API sends to the new addresses; removing `ProjectSettings`, `Connectors`, the admin area's navigation, the organization page and dead code; removing the flag. Also not here: the organization's name on system catalog cards, the issue webhook's project state, tier names in German, the D-8 confirmation copy, mailboxes shared across projects (D-5).

## Decisions taken in this plan (Mario confirms them with the plan review)

| No | Decision | Why |
| --- | --- | --- |
| P5-D1 | With `on`, the project sidebar shows one entry "Administration & settings" in place of "Settings"; the "Connectors" entry is not shown. | Spec 5.2: one entry. The old address still works through the table. |
| P5-D2 | Revoking a public key always succeeds. A module that uses the key releases its reference in the same step (Support clears the inbox's key); nothing can veto a revocation. | A leaked key must be revocable from one place at once. |
| P5-D3 | With `on`, the Social accounts page and the Knowledge "GitHub App" tab show state and a link to their section in the center; the editors live only in the center. | Spec 5.1, 5.2 and D-6: one canonical place. |
| P5-D4 | The Google Drive return lands on the project's Google Drive section (`…/integrations/google-drive`), not on the catalog. | That section is the one that handles the return; one click less. |
| P5-D5 | A redirect needs the member to be able to open the target. If the member lacks the target area, the redirect goes to the first area of that scope they can open; if the scope itself is not available to them (its flag is off, or no capability), the old page stays. | The old page must not be replaced by "Not available". |
| P5-D6 | Module sections get no declared access floor (spec row 5.1 lists "required permission"). Who may see a module's section stays in the module's own hook and on the server. | Two modules decide by module role, not by project role (Webmail's owner check, Work's project manager); a declared project-role floor would hide the section from members who may use it. |

## Global Constraints

- Work in the worktree `.claude/worktrees/system-management-v2` on the branch the controller names (cut from the current `main`). Before Task 1: `node scripts/test-db-for-worktree.ts`.
- With `ORBIT_SETTINGS_CENTER` `off` or `preview`, behaviour and markup are unchanged: no redirect, no changed navigation entry, no changed link, the old pages as they are. Every new behaviour is behind the value `on`, except Task 5 (the key release, a correctness fix that holds in every flag state) and Task 4 (metadata the center reads under `preview` as well).
- No database migration, no schema change, no new dependency, no change to roles or permissions. No stored setting or data is deleted. The only changed write path is `POST …/public-keys/:keyId/revoke` (Task 5).
- The redirect table is permanent (spec 5.3). Nothing in this plan removes an old page or an old route.
- Redirects use `router.replace`, never `push`; a `/manage…` address is never mapped again; search and hash are kept unless the table maps them; the `section` parameter is dropped once mapped.
- The platform never imports `apps/web/src/modules/<id>/` or `apps/api/src/modules/<id>/`; modules contribute through `WebModule` and `ModuleContributions` (`node scripts/source-check.mjs`: 0 new violations). A test may import `@/modules/registry`.
- Texts: English and German for every new string. Center texts live in the texts file of their folder (German typed against the English keys); module texts in the module's labels file; no inline `de ? … : …` in new files.
- Opening a page or following a redirect never writes. Tests never reach a provider.
- A new or changed API answer has an explicit field list and never carries a key's secret part beyond what the route returns today; access-matrix fixture changes are reviewed as security changes; `pnpm api:generate` after an API change; `docs/API_CONTRACT.md` updated.
- Documentation and code comments are English. In documents, do not write a repository path with a line number in backticks (the framework check reads it as a path). Commit messages end with exactly `Co-Authored-By: Claude <noreply@anthropic.com>`; no assistant model names anywhere.
- Do not push, deploy or change a production flag; each needs Mario's approval.
- Local commands (Node 24: `export PATH=~/.nvm/versions/node/v24.18.0/bin:$PATH`): tests `node --env-file=/Users/marioeuchner/EDS-Labs/Development/EDS-Orbit/.runtime/local.env ./node_modules/vitest/vitest.mjs run <files>`; types `./node_modules/.bin/tsc --noEmit` (root and `apps/web`); boundaries `node scripts/source-check.mjs`. The whole suite and the browser runs are the controller's (Task 11).

## Review Focus

1. **A bookmark to a module's settings while the module is off or the member's module role is `none`.** Expected: the member lands on the module's address in the center, which says the settings are not available; never a blank page, never a loop back to the old address. Pinned in Task 1 (mapping of every registered module tab) and Task 10 (browser).
2. **A member who may not open the target** (an editor opening `?section=members`; `/account` while `ORBIT_ACCOUNT` is off; `/admin` for a non-administrator). Expected: P5-D5; a non-administrator on `/admin` sees "not found" exactly as today. Pinned in Task 2.
3. **Search and hash on the way.** `?googleDrive=choose-root`, `#assistant-budget`, `?connected=2`, `?error=SOCIAL_OAUTH_CANCELLED`, an unknown extra parameter. Expected: kept; `section` dropped; the hash row maps to the budget section. Pinned in Task 1.
4. **Loops and history.** A `/manage…` address, a mapped address whose target equals the current address, the stage changing while a tab is open, capabilities still loading. Expected: no second redirect, a loading screen while waiting, one history entry. Pinned in Task 2.
5. **Revoking a key under change.** An already revoked key, a key of another project, a key no module uses, a key whose inbox was changed a moment ago. Expected: idempotent, 404 for the other project, only this project's reference is cleared, and a failed release revokes nothing. Pinned in Task 5.

---

## File Structure

**New (web)**

| File | Responsibility |
| --- | --- |
| `apps/web/src/platform/settings-center/redirects.ts` | `mapOldAddress` (the table), `oldAddressTarget` (table plus the member's access), `moduleTabIndex` |
| `apps/web/src/platform/settings-center/redirects.test.tsx` | One test per row; exhaustiveness against the registries |
| `apps/web/src/platform/settings-center/sections/public-access.tsx` | The project's "Public access" section |
| `apps/web/src/modules/social/accounts-page.tsx` | The Social accounts page: forwards an OAuth result and shows state and a link with `on` |
| `apps/web/tests/settings-center-on.spec.ts` | Playwright for `on` |

**New (API)**

| File | Responsibility |
| --- | --- |
| `apps/api/tests/public-key-use.integration.test.ts` | Revocation releases a module's reference; the list says who uses a key |

**Modified**

| File | Change |
| --- | --- |
| `apps/web/src/components/orbit.tsx` | Redirect effect with `on`; shell helpers `settingsHref`, `connectionsHref`; sidebar entries; `moduleSettings` |
| `apps/web/src/platform/shell/routes.ts`, `settings-nav.tsx`, `nav-groups.ts`, `user-menu.tsx`, `attention-list.tsx`, `shell-context.tsx`, `types.ts` and their tests | Navigation with `on`; exported `MOVED`; `moduleSettings`; section description and search words |
| `apps/web/src/platform/settings-center/registry.ts`, `sections/project.tsx`, `integrations/scopes.tsx`, `texts.ts` and tests | Module section metadata and validation; public access section; Knowledge GitHub no longer special-cased |
| `apps/web/src/components/public-keys.tsx`, `project-administration.tsx` | `PublicKeysPanel`; "used by"; revoke confirmation; the button is not shown inside the center |
| `apps/web/src/modules/{social,knowledge,support,finance,webmail,marketing}/…`, `apps/web/src/platform/agents/builder.tsx`, `apps/web/src/platform/drive/drive-page.tsx`, `apps/web/src/lib/exception-text.ts` | Links through the shell helpers; contributions; state-and-link views |
| `apps/api/src/platform/modules/contributions.ts`, `apps/api/src/platform/http/public-api.ts`, `apps/api/src/server.ts` | `publicKeyUse`; release on revoke; `usedBy` in the list |
| `apps/api/src/modules/support/contributions.ts`, `inboxes.ts` (or `widget.ts`) | Support's `publicKeyUse` |
| `.github/workflows/orbit-ci.yml` | A browser run with `ORBIT_SETTINGS_CENTER: 'on'` |
| `docs/API_CONTRACT.md`, `docs/SUPPORT_WIDGET.md`, `docs/plans/SYSTEM_MANAGEMENT_V2.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md`, `docs/DESIGN_SYSTEM.md` | Documentation |

---

### Task 1: The redirect table

**Files:**
- Create: `apps/web/src/platform/settings-center/redirects.ts`, `redirects.test.tsx`
- Modify: `apps/web/src/platform/shell/settings-nav.tsx` (export `MOVED`)

**Interfaces:**
- Consumes: `locate`, `RouteTable`, `ADMIN_SECTIONS` (`shell/routes.ts`); `moduleSectionId` (`settings-center/registry.ts`); `PLATFORM_TAB_KEYS` (`sections/project.tsx`); `MOVED` (`shell/settings-nav.tsx`); `ManageScope`, `manageHref` (`settings-center/routes.ts`)
- Produces:

```ts
export type OldAddress = { pathname: string; search: string; hash: string };
export type CenterAddress = { scope: ManageScope; area: string; rest: string[]; search: string; hash: string };
/** Module settings tab key → module id, over every registered module (shown or not). */
export function moduleTabIndex(modules: ReadonlyArray<{ id: string; settings?: ReadonlyArray<{ tab: { key: string } }> }>): ReadonlyMap<string, string>;
export type MapContext = {
  table: RouteTable;
  tabs: ReadonlyMap<string, string>;
  platformKeys: readonly string[];
  /** Whether the module is shown in that project; null while unknown. Asked only for a key that has a MOVED entry. */
  moduleShown(projectId: string, moduleId: string): boolean | null;
};
/** The center address of an old settings address; null when the address is not an old settings address; "wait" while moduleShown is unknown. */
export function mapOldAddress(address: OldAddress, ctx: MapContext): CenterAddress | "wait" | null;
export function centerHref(target: CenterAddress): string; // manageHref(...) + search + hash
```

**The table** (project id `P`, organization id `O`; every other address returns null, including `/manage…`, `/connect…`, `/invite`, `/reset-password`, `/account/confirm-email`, `/data-deletion`, `/o/:id/agents`, pickers and all module pages)

| Old address | Scope | Area, rest | Search and hash |
| --- | --- | --- | --- |
| `/admin` | system | `overview` | kept |
| `/admin/integrations`, `/admin/ai`, `/admin/mcp` | system | the same word | kept |
| `/admin/audit` | system | `security`, `audit` | kept |
| `/admin/users`, `/admin/users/:id` | system | `users` [, `:id`] | kept |
| `/admin/invitations` | system | `users`, `invitations` | kept |
| `/admin/organizations`, `/admin/organizations/:id` | system | `organizations` [, `:id`] | kept |
| `/admin/projects` | system | `organizations`, `projects` | kept |
| `/o/O/settings` | organization O | `overview` | kept |
| `/o/O/settings#assistant-budget` | organization O | `ai`, `budget` | hash kept |
| `/account` | account | `profile` | kept |
| `/account/assistant` | account | `assistant` | kept |
| `/p/P/settings` without `section` and without `googleDrive` | project P | `overview` | kept |
| `…?googleDrive=<v>` (with or without `section=integrations`) | project P | `integrations`, `google-drive` | `googleDrive` kept, `section` dropped |
| `…?section=integrations` | project P | `integrations` | `section` dropped |
| `…?section=members` | project P | `members` | `section` dropped |
| `…?section=ai` | project P | `ai` | `section` dropped |
| `…?section=retention` | project P | `data` | `section` dropped |
| `…?section=modules` | project P | `modules` | `section` dropped |
| `…?section=apps` | account | `connections` | `section` dropped |
| `…?section=project` or an unknown key | project P | `overview` | `section` dropped |
| `…?section=<k>`, `k` a module tab key of module `m`, and (`k` has no `MOVED` entry, or `moduleShown(P, m)` is true) | project P | `modules`, then `moduleSectionId(m, k, platformKeys)` split at `/` | `section` dropped |
| the same with a `MOVED` entry and `moduleShown(P, m)` false | project P | the row of `MOVED[k]` | `section` dropped |
| the same with a `MOVED` entry and `moduleShown(P, m)` null | | `"wait"` | |
| `/p/P/connectors` | project P | `integrations` | kept |
| `/p/P/social/accounts` with `connected` or `error` in the search | project P | `integrations`, `social`, `accounts` | kept |
| `/p/P/social/accounts` without them | | null (the page stays, Task 8) | |

A module tab whose key is a platform key (Webmail's `integrations`) follows the platform row. The legacy addresses `/settings…` and `/connectors` have no row: the shell first resolves them to the last project as today and maps the result (Task 2).

- [ ] **Step 1: Write the failing tests** (`redirects.test.tsx`; `ctx(over)` builds a `MapContext` from the real registry: `routeTable(webRegistry)`, `moduleTabIndex(webRegistry.modules)`, `PLATFORM_TAB_KEYS`, `moduleShown: () => true`)

```ts
it.each(ROWS)("maps %s", (from, to) => {              // one entry per table row above, written out as literals
  expect(hrefOf(mapOldAddress(parse(from), ctx()))).toBe(to);
});
// e.g. ["/admin/audit", "/manage/system/security/audit"],
//      ["/o/w1/settings#assistant-budget", "/manage/o/w1/ai/budget#assistant-budget"],
//      ["/p/p1/settings?section=finance-mailboxes", "/manage/p/p1/modules/finance/mailboxes"],
//      ["/p/p1/settings?section=work", "/manage/p/p1/modules/work/settings"],
//      ["/p/p1/settings?googleDrive=choose-root", "/manage/p/p1/integrations/google-drive?googleDrive=choose-root"],
//      ["/p/p1/settings?section=members&x=1", "/manage/p/p1/members?x=1"],
//      ["/p/p1/social/accounts?connected=2", "/manage/p/p1/integrations/social/accounts?connected=2"]
it("leaves every other address alone", () => {
  for (const a of ["/manage/system", "/p/p1/social/accounts", "/p/p1/knowledge", "/invite", "/account/confirm-email", "/o/w1/agents", "/"])
    expect(mapOldAddress(parse(a), ctx())).toBeNull();
});
it("sends a moved key to its new home while its module is off, and waits while that is unknown", () => {
  expect(hrefOf(mapOldAddress(parse("/p/p1/settings?section=policy"), ctx({ moduleShown: () => false })))).toBe("/manage/p/p1/ai");
  expect(mapOldAddress(parse("/p/p1/settings?section=policy"), ctx({ moduleShown: () => null }))).toBe("wait");
  expect(hrefOf(mapOldAddress(parse("/p/p1/settings?section=policy"), ctx()))).toBe("/manage/p/p1/modules/marketing/policy");
});
it("maps every admin section, every platform tab and every registered module tab", () => {
  // ADMIN_SECTIONS, PLATFORM_TAB_KEYS and moduleTabIndex(webRegistry.modules): each yields a CenterAddress, none null
});
it("lands on a section the center has", () => {
  // for every row and every key of the previous test: resolveSection(<all sections of the target scope, every capability,
  // module sections from projectModuleSections with every module shown, integration sections>, area, rest) is not null
});
```

- [ ] **Step 2: Run them; expected FAIL** (module missing).
- [ ] **Step 3: Implement** `moduleTabIndex`, `mapOldAddress` (built on `locate` for the path, `URLSearchParams` for the search) and `centerHref`; export `MOVED`.
- [ ] **Step 4: Run** the new test, `apps/web/src/platform/shell/*.test.tsx`, `tsc --noEmit` in `apps/web`, `node scripts/source-check.mjs`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): table from old settings addresses to the settings center`

---

### Task 2: The shell redirects with `on`

**Files:**
- Modify: `apps/web/src/platform/settings-center/redirects.ts`, `redirects.test.tsx`, `apps/web/src/components/orbit.tsx`, `apps/web/src/platform/settings-center/capabilities.ts` (only if the capabilities request must also load outside `/manage`)

**Interfaces:**
- Consumes: Task 1; `ManagementCapabilities`, `centerState`; `visibleSections`, the four section lists
- Produces:

```ts
export type RedirectContext = MapContext & {
  stage: "off" | "preview" | "on" | undefined;
  /** The member's capabilities; null while loading; undefined when the request failed. */
  caps: ManagementCapabilities | null | undefined;
};
export type Redirect = { kind: "go"; href: string } | { kind: "wait" } | { kind: "stay" };
/** What the shell does with an address. */
export function oldAddressTarget(address: OldAddress, ctx: RedirectContext): Redirect;
```

**Rules**

- `stage !== "on"` → `stay`. `mapOldAddress` null → `stay`; `"wait"` → `wait`.
- A mapped address with `caps === null` → `wait`; with `caps === undefined` (the request failed) → `stay`.
- With capabilities (P5-D5): the target area is one the member can open in that scope (a platform section of that area is in `visibleSections` for the member's capabilities of that scope; for area `modules` the capability `project.modules` decides, the module's own notice is the center's) → `go` to the target. Otherwise, if the member can open any area of that scope → `go` to that scope's first area in registry order, with search and hash dropped. Otherwise → `stay`.
- A target whose href equals the current address → `stay`.
- `orbit.tsx`: with `stage === "on"`, the capabilities are requested for every address `mapOldAddress` does not return null for (today they are requested only below `/manage`). The existing redirect effect gains one branch: `go` → `router.replace(href)`; `wait` → the loading screen that the `legacy` and `redirect` places show today; `stay` → today's rendering. For a `legacy` place the effect first builds today's project address (`projectHref(defaultProject(…), place.route) + keptSuffix(…)`) and, with `on`, passes it through `oldAddressTarget`; one `router.replace` with the final address. `moduleShown` reads the shell's module states of the open project (null until they are loaded).
- A non-administrator on `/admin…` and a member without access to the organization on `/o/:id/settings` see what they see today (`stay`: the scope is not available to them).

- [ ] **Step 1: Write the failing tests** (`redirects.test.tsx`, second `describe`; `caps(over)` builds capabilities)

```ts
it("does nothing unless the stage is on", …)                    // off, preview, undefined → stay
it("waits for the capabilities and stays when they cannot be read", …) // null → wait; undefined → stay
it("goes to the target the member can open", …)                 // owner: /p/p1/settings?section=members → go /manage/p/p1/members
it("falls back to the scope's first area the member can open", …) // editor without project.members → go /manage/p/p1/overview (no search)
it("stays when the scope is not available to the member", …)    // /account without account capabilities; /admin for a non-administrator
it("never maps a center address or its own target", …)          // /manage/p/p1/members → stay
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement** `oldAddressTarget` and the `orbit.tsx` branch. Extract the effect's decision into a pure function only if the existing effect is not already one; do not move other code.
- [ ] **Step 4: Run** the tests, `apps/web/src/platform/shell/*.test.tsx`, `apps/web/src/platform/settings-center/*.test.tsx`, `tsc --noEmit` in `apps/web`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): old settings addresses open the settings center when the flag is on`

---

### Task 3: Navigation and links with `on`

**Files:**
- Modify: `apps/web/src/platform/shell/user-menu.tsx`, `user-menu.test.tsx`, `shell-context.tsx`, `nav-groups.ts`, `attention-list.tsx` and its test, `apps/web/src/components/orbit.tsx`, `apps/web/src/platform/shell/sidebar-nav.tsx` (only if the entry label needs it), `apps/web/src/platform/agents/builder.tsx`, `apps/web/src/platform/drive/drive-page.tsx`, `apps/web/src/modules/knowledge/add-flow.tsx`, `apps/web/src/components/management.tsx` (its two `settingsSectionHref` call sites), `apps/web/src/modules/social/accounts.tsx` (the organization settings link), `apps/web/src/modules/support/action-requests.tsx`, `apps/web/src/modules/marketing/overview.tsx`, `policy-editor.tsx`, `apps/web/src/lib/exception-text.ts` (only if its constants are rendered without `projectAwareHref` or `attentionTarget`)

**Interfaces:**
- Consumes: Tasks 1 and 2
- Produces:

```ts
// shell-context.tsx, ShellContextValue gains (both always defined; with off and preview they return today's addresses):
//   settingsHref(key: string): string;   // today: settingsSectionHref(hrefOf("settings"), key)
//   connectionsHref(): string;           // today: hrefOf("connectors"); with on: /manage/p/<id>/integrations/connections
//   organizationSettingsHref(organizationId: string): string; // today: /o/<id>/settings; with on: /manage/o/<id>/overview
// user-menu.tsx
export function userMenuEntries(identity, organizationId): { manage?: string; account?: string; organization?: string; admin?: string };
// with stage "on": only `manage`; with "preview": all as today; with "off": as today without `manage`
```

**Rules**

- The three shell helpers compute the old address and, with `on`, pass it through `mapOldAddress` with `moduleShown` from the shell (a `"wait"` or null result returns the old address; the redirect then decides). No helper asks for capabilities: a link may lead through a redirect fallback, it never leads nowhere.
- Sidebar (P5-D1), with `on`: the registry nav entry `settings` renders with the label of the user menu's center entry and the address `manageHref({ kind: "project", projectId })`; the entry `connectors` is not rendered. Module groups' "Settings" links use `shell.settingsHref(key)`.
- `attentionTarget` and `projectAwareHref`: with `on`, the address they return is passed through the same mapping, so an attention item with `/settings?section=ai` renders the center address directly. They take the mapping as a parameter (a function `(href: string) => string`, identity by default), supplied by the shell; no import from `settings-center` into a file that today has none, unless the boundary check allows it.
- Every listed call site of `settingsSectionHref(shell.hrefOf("settings"), key)` becomes `shell.settingsHref(key)`; `shell.hrefOf("connectors")` used as a link becomes `shell.connectionsHref()`; the hard-coded organization settings address becomes `shell.organizationSettingsHref(id)`. Find further call sites with `grep -rn 'settingsSectionHref\|hrefOf("settings")\|hrefOf("connectors")\|/settings?section=' apps/web/src` and treat them the same; list them in the report.
- With `off` and `preview`, every rendered address is byte-identical to today's (the existing tests of these files stay green unchanged).

- [ ] **Step 1: Write the failing tests**

```ts
// user-menu.test.tsx
it("offers only the center when the flag is on", …)      // on → { manage: "/manage" } and no account, organization, admin
it("keeps every entry in preview", …)                    // unchanged expectations
// a new shell test next to the helpers (pure builder extracted from orbit.tsx, e.g. `shellLinks({ stage, projectId, map })`)
it("links to the old addresses unless the flag is on", …) // settingsHref("ai") → "/p/p1/settings?section=ai"; connectionsHref() → "/p/p1/connectors"
it("links into the center when the flag is on", …)        // "/manage/p/p1/ai"; "/manage/p/p1/integrations/connections"; module key → "/manage/p/p1/modules/finance/mailboxes"
// nav / sidebar test
it("shows one settings entry and no connectors entry when the flag is on", …)
// attention-list test
it("renders an attention link as a center address when the flag is on", …) // "/settings?section=ai" → "/manage/p/p1/ai"; identity mapping → today's address
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `apps/web/src/platform/shell/*.test.tsx`, the test files of every touched module and platform folder, `tsc --noEmit` in `apps/web`, `node scripts/source-check.mjs`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): navigation and links point to the settings center when the flag is on`

---

### Task 4: Module sections carry their own description; the registry validates them

**Files:**
- Modify: `apps/web/src/platform/shell/types.ts` (`SettingsSection`), `apps/web/src/platform/shell/routes.ts` and `routes.test.tsx` (`moduleSettings`), `apps/web/src/components/orbit.tsx` (one line), `apps/web/src/platform/settings-center/registry.ts`, `registry.test.tsx`, `sections/project.tsx`, `sections/project.test.tsx`, the settings contributions of `apps/web/src/modules/{marketing,finance,issues,support,work,webmail}`

**Interfaces:**
- Produces:

```ts
// shell/types.ts — SettingsSection gains two optional fields
//   description?: Label;                 // what this section is for; shown as the page head's explanation and searched
//   keywords?: Label;                    // extra search words
// shell/routes.ts — sibling of moduleIntegrations and moduleAiCeilings, same module filter
export function moduleSettings(modules: readonly WebModule[], enabled: (id: string) => boolean): Array<SettingsSection & { moduleId: string }>;
// registry.ts
export function adaptModuleSections(contributed, modules, platformKeys): { sections; notices }; // signature unchanged
/** Checks adapted module and integration sections; throws one Error("SETTINGS_MODULE_SECTIONS_INVALID: …"). */
export function validateModuleSections(sections: readonly ResolvedSection[]): void;
```

**Rules**

- `adaptModuleSections`: a merged section's `description` is the first contribution's (by `order`) that has one, else the module's description as today; `keywords` of the merged contributions are joined. Nothing else changes: who sees a section is decided by the module filter and the section's hook, as today (P5-D6).
- `validateModuleSections`: every id is `<moduleId>/<segments>` or, for integration sections, `<moduleId>/<id>`, each segment matching the registry's segment pattern; no duplicate id within an area; label and description non-empty in both languages.
- Contributions (new text):

| Module, tab key | Description EN / DE |
| --- | --- |
| marketing `policy` | Who may publish what, in which language and when. / Wer was, in welcher Sprache und wann veröffentlichen darf. |
| marketing `brand` | Brand profile, approvals and the brand kit for images. / Markenprofil, Freigaben und das Marken-Kit für Bilder. |
| finance `finance-mailboxes` | Which mailboxes Finance reads receipts from. / Aus welchen Postfächern Finance Belege liest. |
| finance `finance-accounts` | Accounts and categories for bookings. / Konten und Kategorien für Buchungen. |
| finance `finance-cost-centers` | Cost centers for bookings. / Kostenstellen für Buchungen. |
| finance `finance-currencies` | Currencies and exchange rates. / Währungen und Wechselkurse. |
| finance `finance-ai` | Reading receipts with AI and its daily ceiling. / Belege mit KI auslesen und die tägliche Obergrenze dafür. |
| issues `issues` | Issue intake, triage and its AI ceiling. / Annahme und Einordnung von Meldungen und die KI-Obergrenze dafür. |
| support `support` | Inboxes, channels and rules of Support. / Postfächer, Kanäle und Regeln des Supports. |
| work `work` (both contributions) | Workflow of project management and the AI project manager. / Ablauf des Projektmanagements und der KI-Projektleiter. |
| webmail `integrations` | Which mailboxes open in Webmail. / Welche Postfächer in Webmail geöffnet werden. |

- `orbit.tsx`: `settings: moduleSettings(registry.modules, enabled)` in place of the inline `active.flatMap(…)`, same output.

- [ ] **Step 1: Write the failing tests**

```ts
// routes.test.tsx
it("collects settings only from shown modules", …)   // one module off, one with access "none" → their sections are absent; order as the registry
// registry.test.tsx
it("uses a section's own description and falls back to the module's", …)
it("joins the search words of merged contributions", …)
it("refuses a module section with a bad id, a duplicate or an empty text", …) // validateModuleSections throws SETTINGS_MODULE_SECTIONS_INVALID naming each problem
// sections/project.test.tsx
it("the real registry's module and integration sections are valid", () => {
  // every module of webRegistry shown, hooks replaced by a stub that returns content → validateModuleSections does not throw
});
it("every real module section has its own description in both languages", …)
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `apps/web/src/platform/shell/*.test.tsx`, `apps/web/src/platform/settings-center/**/*.test.tsx`, the six modules' test files, `tsc --noEmit` in `apps/web`, `node scripts/source-check.mjs`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): module settings sections carry their own description; the registry validates them`

---

### Task 5: Revoking a public key releases the module's reference (F-5, API)

Today `revokePublicKey` sets `revokedAt` and knows nothing of `SupportInbox.publicClientKeyId`; the inbox keeps pointing at the revoked key and its widget answers 404 until someone presses "Widget key" again. The mailbox removal already has the pattern for this: `MailboxUse` in `ModuleContributions`.

**Files:**
- Modify: `apps/api/src/platform/modules/contributions.ts`, `apps/api/src/platform/http/public-api.ts`, `apps/api/src/server.ts` (the list route's answer), `apps/api/src/modules/support/contributions.ts`, `apps/api/src/modules/support/inboxes.ts` or `widget.ts`, `docs/API_CONTRACT.md`, `docs/SUPPORT_WIDGET.md`, OpenAPI artifacts
- Create: `apps/api/tests/public-key-use.integration.test.ts`

**Interfaces:**
- Produces:

```ts
// contributions.ts, next to MailboxUse
export type PublicKeyUse = {
  /** Who uses this key in the project, as a name to show; null when nobody does. Never a secret. */
  usedBy(tx: DbTx, scope: Scope, keyId: string): Promise<{ label: string } | null>;
  /** Drops the module's reference to the key, inside the caller's project transaction. Idempotent. */
  release(tx: DbTx, scope: Scope, keyId: string): Promise<void>;
};
// ModuleContributions gains: publicKeyUse?: PublicKeyUse;
// public-api.ts
export async function listPublicKeys(scope: Scope): Promise<Array<ExistingFields & { usedBy: { moduleId: string; label: string } | null }>>;
// revokePublicKey(scope, id, tx?) keeps its signature
```

**Rules**

- `revokePublicKey`: after the owner check and the lookup of the key in this project (404 for a key of another project, as today), inside one `scoped` project transaction (the caller's `tx` when one is passed): call `release` of every module that contributes `publicKeyUse` (in registry order), write the audit entry, and as the last statement inside that transaction set `revokedAt` through `authDb`. A `release` or the update that throws rolls the transaction back: nothing is released, nothing is revoked, and the error surfaces. A key that is already revoked: `release` is still called (idempotent; it heals an inbox left pointing at it), `revokedAt` is not changed.
- The modules' uses reach `revokePublicKey` and `listPublicKeys` the way `MailboxUse` reaches the e-mail connection code (follow that registration and lookup); the list of uses is a last parameter whose default is the registry's, so a test can pass one that throws.
- Support's `release`: `tx.supportInbox.updateMany({ where: { projectId, publicClientKeyId: keyId }, data: { publicClientKeyId: null } })` and, when a row changed, an audit entry `support.inbox.widget_key_released` with the inbox id (no key value). Support's `usedBy`: the inbox whose `publicClientKeyId` is the key → `{ label: <inbox name> }`.
- Support's own paths that revoke (`enableWidgetKey`, `syncWidgetKey`) keep working: they call `revokePublicKey`, which now releases first; the pointer they write afterwards stays as they write it. Check both for a double audit entry and remove the duplicate if one appears.
- The list reads `usedBy` per key inside one project transaction; a revoked key has `usedBy: null`.
- No veto, no new error code (P5-D2). The route's guard and its access-matrix row are unchanged.

- [ ] **Step 1: Write the failing tests** (fixtures as in the Support widget integration tests: a project with Support on, an inbox with the widget channel and a key from `POST …/support/inboxes/:id/widget-key`)

```ts
it("clears the inbox's key when the key is revoked on the public keys route", async () => {
  // POST /api/projects/:p/public-keys/:keyId/revoke → 200
  // the inbox read through the Support API has publicClientKeyId null; the widget's public route answers 404
  // audit: public_key.revoked and support.inbox.widget_key_released, neither contains the key
});
it("says which inbox uses a key", …)            // GET …/public-keys → item.usedBy { moduleId: "support", label: "<inbox name>" }; null for a key nobody uses and for a revoked key
it("heals an inbox that still points at a revoked key", …) // set revokedAt directly, keep the pointer; revoke again → 200, pointer null
it("leaves other projects alone", …)            // a key of project B through project A's route → 404, B's inbox unchanged
it("revokes nothing when a release fails", …)   // a test module contribution whose release throws → 500, revokedAt still null, the inbox still points at the key
it("keeps the inbox's own key change working", …) // POST …/widget-key again → new key id on the inbox, old key revoked, one widget_key audit entry
```

- [ ] **Step 2: Run them; expected FAIL** (the pointer stays; `usedBy` is undefined).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new file, the Support widget and inbox integration tests, `access-matrix.integration.test.ts` (no row may change), `rls-matrix.integration.test.ts`, `pnpm api:generate` (review: additive), `tsc --noEmit`, `node scripts/source-check.mjs`; expected PASS.
- [ ] **Step 5: Commit** `fix(platform): revoking a public key releases the module that used it (F-5)`

---

### Task 6: "Public access" in the project's integrations

**Files:**
- Create: `apps/web/src/platform/settings-center/sections/public-access.tsx` and its test
- Modify: `apps/web/src/components/public-keys.tsx`, `project-administration.tsx`, `apps/web/src/platform/settings-center/sections/project.tsx`, `sections/project.test.tsx`

**Interfaces:**
- Consumes: Task 5 (`usedBy`)
- Produces:

```ts
// public-keys.tsx
/** The list, the create form and revoke; no frame. */
export function PublicKeysPanel(): JSX.Element;
export function PublicKeys(props: { onClose(): void }): JSX.Element; // the modal, now a frame around PublicKeysPanel
export function PublicKeysView(props: { items: PublicKeyItem[]; modules: string[]; locale: Locale; onRevoke(id: string): void; … }): JSX.Element; // presentational, for tests
// project-administration.tsx
export function ProjectAdministration(props?: { publicKeys?: boolean }): JSX.Element; // default true; false hides the public keys button
```

**Section** (project scope, area `integrations`, capability `project.integrations`, order 30, after `google-drive`)

| id | Address | Content |
| --- | --- | --- |
| `public-access` | `/manage/p/:id/integrations/public-access` | for an owner: `PublicKeysPanel`; for everyone else the text `ownerOnly` (the list route is for owners) |

The center's profile section mounts `ProjectAdministration` with `publicKeys={false}`; the old page keeps the button and the modal.

**Rules**

- A key with `usedBy` shows `usedBy` with the label after the module name. Revoking any key asks first (the file's existing confirmation pattern, or `window.confirm` if the file has none); for a key with `usedBy` the question adds `revokeUsed`.
- Copy (in `public-keys.tsx`'s existing text style; the section's label and description are `Label` literals next to the section):

| Key | English | German |
| --- | --- | --- |
| section label | Public access | Öffentlicher Zugriff |
| section description | Public keys for what the modules offer to the outside, for example the Support widget. | Öffentliche Schlüssel für das, was Module nach außen anbieten, zum Beispiel das Support-Widget. |
| `usedBy` | Used by: {label} | Genutzt von: {label} |
| `revokeAsk` | Revoke this key? Whatever uses it stops working at once. | Diesen Schlüssel widerrufen? Was ihn nutzt, funktioniert sofort nicht mehr. |
| `revokeUsed` | "{label}" loses its key and its widget stops. A new key means a new embed code. | „{label}“ verliert seinen Schlüssel, und sein Widget funktioniert nicht mehr. Ein neuer Schlüssel bedeutet einen neuen Einbettungscode. |
| `ownerOnly` | Only owners of the project manage public keys. | Öffentliche Schlüssel verwalten nur Owner des Projekts. |

- [ ] **Step 1: Write the failing tests**

```ts
it("names the inbox that uses a key and warns before revoking it", …) // PublicKeysView with usedBy → "Used by: Help desk"; the revoke question contains revokeUsed with the label
it("registers public access under the project's integrations", …)    // id "public-access", area "integrations", after "google-drive"; resolves at ["public-access"]
it("shows no keys to someone who is not an owner", …)                 // the ownerOnly text, no request component
it("keeps the public keys button out of the center's profile section and on the old page", …)
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement** by moving the modal's content into `PublicKeysPanel` unchanged, then adding `usedBy` and the confirmation.
- [ ] **Step 4: Run** `apps/web/src/components/*.test.tsx`, `apps/web/src/platform/settings-center/**/*.test.tsx`, `tsc --noEmit` in `apps/web`; expected PASS. Add the row to Task 1's table test: the section exists (no old address maps to it).
- [ ] **Step 5: Commit** `feat(web): public access section; the keys list says who uses a key`

---

### Task 7: Knowledge's GitHub App in the integrations center

**Files:**
- Modify: `apps/web/src/modules/knowledge/manifest.tsx`, `github-page.tsx`, `workspace.tsx`, the module's labels file and tests, `apps/web/src/platform/settings-center/integrations/scopes.tsx` and its test

**Interfaces:**
- Consumes: `IntegrationContribution` (`shell/types.ts`), `adaptIntegrationSections`, `manageHrefOf`
- Produces: Knowledge's `integrations: [{ id: "github", label, description, order: 10, providers: ["knowledge_github"], ownHead: true, component: KnowledgeGithubPage }]`; `export function GithubAppSummary(): JSX.Element` (state and link)

**Rules**

- `manageHrefOf` loses its special case for `knowledge_github`: the card now links to the contributed section like every other provider with a module section. Its test for "managed in its module" switches to an entry that still has no section.
- With `on`, the Knowledge workspace's "GitHub App settings" tab renders `GithubAppSummary`: whether the app is configured (the request the page makes today) and one link to `manageHref(project, "integrations", "knowledge", "github")`; `GithubSource`'s link to the settings uses the same address. With `off` and `preview` the tab renders `KnowledgeGithubPage` as today. The stage comes from `useWorkspace().identity.settingsCenter`.
- The page's own owner check stays (a non-owner sees its read-only text in the center as well).
- Copy:

| Key | English | German |
| --- | --- | --- |
| contribution label | Knowledge: GitHub App | Wissen: GitHub-App |
| contribution description | The GitHub App Knowledge reads repositories with. | Die GitHub-App, mit der Wissen Repositories liest. |
| `githubManaged` | The GitHub App is managed in Administration & settings. | Die GitHub-App wird in Verwaltung & Einstellungen verwaltet. |
| `githubConfigured` / `githubMissing` | Configured / Not configured | Eingerichtet / Nicht eingerichtet |
| `githubOpen` | Open GitHub App settings | GitHub-App-Einstellungen öffnen |

- [ ] **Step 1: Write the failing tests**

```ts
it("contributes the GitHub App to the integrations center", …)    // adaptIntegrationSections(moduleIntegrations(webRegistry.modules, () => true)) contains "knowledge/github"
it("links the Knowledge GitHub card to its section", …)           // manageHrefOf(knowledge_github, project ctx) → "/manage/p/p1/integrations/knowledge/github"
it("shows state and a link on the module tab when the flag is on", …) // GithubAppSummary markup: the state word and the link; with preview the tab renders the editor
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the Knowledge module's tests, `apps/web/src/platform/settings-center/**/*.test.tsx`, `apps/web/src/platform/shell/*.test.tsx`, `tsc --noEmit` in `apps/web`, `node scripts/source-check.mjs`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): Knowledge's GitHub App is managed in the integrations center`

---

### Task 8: The Social accounts page with `on`

`AccountsView` is today both the page `/p/:id/social/accounts` and the center section `integrations/social/accounts`, and the OAuth callback returns to the page with `?connected=` or `?error=` (the API only accepts a return below `/p/:id/social`, which stays).

**Files:**
- Create: `apps/web/src/modules/social/accounts-page.tsx` and its test
- Modify: `apps/web/src/modules/social/manifest.tsx` (the page view mounts `SocialAccountsPage`; the integration section keeps `AccountsView`), `accounts.tsx` (export the read-only list as `AccountsSummaryView`), the module's labels file

**Interfaces:**
- Produces: `export function SocialAccountsPage(): JSX.Element`; `export function AccountsSummaryView(props: { accounts: …; locale: Locale; manageHref: string }): JSX.Element`; a pure `socialReturnTarget(stage, projectId, search): string | null`

**Rules**

- `socialReturnTarget`: with `on` and `connected` or `error` in the search → `manageHref(project, "integrations", "social", "accounts") + search`; else null. `SocialAccountsPage` replaces the address with it (the shell's redirect of Task 2 covers the same address; this is the module's own guard so the result is never shown on a page without the editor).
- With `on` and no result in the search: the page shows `AccountsSummaryView`: each account with its provider, name and the state badge the editor shows, no connect, check or disconnect control, and one link `manageAccounts` to the center section. With `off` and `preview`: `AccountsView` as today.
- Copy:

| Key | English | German |
| --- | --- | --- |
| `accountsManaged` | Accounts are connected, checked and disconnected in Administration & settings. | Konten werden in Verwaltung & Einstellungen verbunden, geprüft und getrennt. |
| `manageAccounts` | Manage accounts | Konten verwalten |

- [ ] **Step 1: Write the failing tests**

```ts
it("forwards an OAuth result to the center only when the flag is on", () => {
  expect(socialReturnTarget("on", "p1", "?connected=2")).toBe("/manage/p/p1/integrations/social/accounts?connected=2");
  expect(socialReturnTarget("on", "p1", "?error=SOCIAL_OAUTH_CANCELLED")).toBe("/manage/p/p1/integrations/social/accounts?error=SOCIAL_OAUTH_CANCELLED");
  expect(socialReturnTarget("on", "p1", "")).toBeNull();
  expect(socialReturnTarget("preview", "p1", "?connected=2")).toBeNull();
});
it("lists accounts with their state and no action when the flag is on", …) // no button "Connect", "Check" or "Disconnect"; the link to the center
```

- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the Social module's tests, `tsc --noEmit` in `apps/web`, `node scripts/source-check.mjs`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): social accounts page shows state and a link when the center manages the accounts`

---

### Task 9: Mailbox choice in Support and Finance links to where mailboxes are managed

Support's inbox form and Finance's mailbox section only choose among the project's mailboxes; the credentials are edited in the platform's e-mail connection UI (the old connectors page, the center's `integrations/connections`). Neither says so.

**Files:**
- Modify: `apps/web/src/modules/support/settings.tsx`, `apps/web/src/modules/finance/settings.tsx`, both modules' labels files and tests

**Rules**

- Below the mailbox select (Support) and above the mailbox list (Finance): the text `mailboxesManaged` and a link `openMailboxes` to `shell.connectionsHref()` (Task 3: the old connectors page, or the center's connections section with `on`). Shown in every flag state. No other change to either form.
- Copy (both modules, each in its own labels file):

| Key | English | German |
| --- | --- | --- |
| `mailboxesManaged` | Mailboxes are added and checked under Integrations. | Postfächer werden unter Integrationen angelegt und geprüft. |
| `openMailboxes` | Open mailboxes | Postfächer öffnen |

- [ ] **Step 1: Write the failing tests** (each module: the rendered form or section contains the link with the address the shell helper returned, for a stubbed helper returning a marker address)
- [ ] **Step 2: Run them; expected FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both modules' tests, `tsc --noEmit` in `apps/web`; expected PASS.
- [ ] **Step 5: Commit** `feat(web): Support and Finance say where mailboxes are managed`

---

### Task 10: Browser acceptance for `on`; CI

**Files:**
- Create: `apps/web/tests/settings-center-on.spec.ts`
- Modify: `apps/web/tests/settings-center-helpers.ts` (a `stage(page)` helper), `apps/web/tests/navigation.spec.ts`, `workspace.spec.ts`, `administration.spec.ts`, `settings-center.spec.ts`, `settings-center-ai.spec.ts` (only where a scenario cannot hold with `on`), `.github/workflows/orbit-ci.yml`

**Rules**

- The new spec skips unless `/api/me` reports `settingsCenter: "on"`. Each scenario is gated on the flags and capabilities it needs and creates its fixtures after the gate (phase 3 and 4 rule); it is re-runnable and leaves shared state as it found it.
- With `on`, every existing spec passes or skips, never fails. A scenario that is about an old page itself ("keeps the old pages", the user menu's "Administration" entry, `?section=` opening the old settings page) skips with `on` and names the scenario of the new spec that replaces it in its skip reason. A scenario that only passes through an old address on its way (a form that is the same component in the center) is changed so that it passes in both states, by addressing the form by its role and name instead of the page around it. List every changed scenario in the report.
- CI: the browser job gains a second run with `ORBIT_SETTINGS_CENTER: 'on'`, built like the existing run with `'preview'` (same other flags, fresh seed).

- [ ] **Step 1: Write the spec.** Stack flags for the local run: `ORBIT_ADMINISTRATION=true ORBIT_ACCOUNT=true ORBIT_CONNECTIONS=true ORBIT_MODULES=true ORBIT_SETTINGS_CENTER=on`.

```ts
test("every old address opens its section of the center", …)
// table of [old, expected pathname+search] taken from Task 1's rows for the seeded owner; after goto(old): the URL equals the target,
// the section's nav entry has aria-current, the text "Not available" is absent, and history.length grew by one entry at most
test("legacy addresses without a project land in the last project's center", …)   // /settings?section=ai, /connectors
test("the Google Drive return opens the project's Drive section", …)              // /p/<p>/settings?googleDrive=ready → /manage/p/<p>/integrations/google-drive?googleDrive=ready
test("the user menu and the sidebar offer one entry", …)                           // no "Account", "Organization settings", "Administration", "Connectors"; "Administration & settings" in both
test("a module group's Settings link opens the module's section", …)               // Marketing → /manage/p/<p>/modules/marketing/policy
test("an attention link opens the center", …)                                      // only if the seeded stack shows an attention item with a settings link; else skip with the reason
test("a member who may not open the target lands on what they may open", …)        // second person (project editor): /p/<p>/settings?section=members → /manage/p/<p>/overview
test("public access lists keys and the profile section has no keys button", …)
test("the Social accounts page shows state and a link", …)                         // skip unless Social is shown for the project
test("opening old addresses writes nothing", …)                                    // no non-GET /api/ request during the first scenario's walk
```

- [ ] **Step 2: Run** the new spec twice in a row and then the whole suite once, against the controller's local stack with `on`; adapt the existing specs by the rule above until every spec passes or skips. Run the whole suite once more with the controller's `preview` stack to show the adaptations hold there (the controller restarts the stack).
- [ ] **Step 3: CI step** as above; `git diff --check`.
- [ ] **Step 4: Commit** `test(web): settings center with the flag on; CI runs it`

---

### Task 11: Documentation, controller verification

**Files:**
- Modify: `docs/plans/SYSTEM_MANAGEMENT_V2.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md`, `docs/API_CONTRACT.md` (rule check), `docs/SUPPORT_WIDGET.md` (rule check), `docs/DESIGN_SYSTEM.md` (the state-and-link pattern of module pages)

- [ ] **Step 1: Write the documentation** (implementer): `SYSTEM_MANAGEMENT_V2.md` section 10 with the state of rows 5.1 to 5.3, the decisions P5-D1 to P5-D5 and every deviation from this plan (from the ledger); section 5.3's table corrected where this plan decided differently (the Drive row, the fallback rule); F-5 marked fixed. `IMPLEMENTATION_STATUS.md`: a new top entry (state: local, not on `main`; what `on` does; what changes in every flag state: Task 5, the mailbox links, section descriptions; what is not proven in a browser; "Verification: see the controller's entry below."). `REQUIREMENTS_TRACEABILITY.md`: rows for work packages 5.1 to 5.3 and F-5 with their tests.
- [ ] **Step 2: Run** `tsc --noEmit` (root and `apps/web`), `node scripts/source-check.mjs`, `python3 scripts/check_framework.py --require-full-validation` (errors only inside the git-ignored `.superpowers` folder do not count), `git diff --check`; commit `docs: settings center phase 5`.
- [ ] **Step 3: Controller verification** (not the implementer's): stop any dev stack and remove a worktree `.runtime/local.env` before the suite; reset this worktree's test database; then:
  1. the whole Vitest suite, not across midnight UTC (three marketing report tests fail between 23:00 and 24:00 UTC); revert `evals/knowledge/last-deterministic-run.json` afterwards; a failure of the Social media concurrency test is re-run alone before it is judged;
  2. the whole Playwright suite with the flag off (`ORBIT_ADMINISTRATION=true`), with the CI flags and `preview`, and with the CI flags and `on`, each on a fresh seed; `settings-center-on.spec.ts` with the flags of Task 10, twice; never two spec runs back to back within the API's rate window;
  3. by hand with `off` and with `preview`: every address of Task 1's table still opens its old page, the navigation is unchanged, no management request leaves a page with `off`;
  4. by hand with `on`: the walk of Task 10's first scenario in German at 1280 and 390 pixels, screenshots of the sidebar, the user menu, the public access section, the two state-and-link pages;
  5. `next build`, both compose checks, the secret scan;
  6. fill the status entry and commit.
- [ ] **Step 4: Request review** with `superpowers:requesting-code-review` on the whole branch and the Review Focus list; one fix wave; report to Mario and wait for his approval before any push to `main`.

**Rollout after delivery** (each step needs Mario's approval; none is part of the implementation): `main` with the production flag unchanged; then `preview` in production if it is not set yet, with a smoke test in Mario's session; then `on`, followed by the regression walk over old links (spec section 15); after acceptance, the plan for row 5.4.

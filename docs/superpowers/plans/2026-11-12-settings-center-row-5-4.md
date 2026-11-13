# Settings Center Row 5.4 (Center Addresses from the API, Removal of the Old Pages and of the Flag) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The settings center is the only settings surface: the old pages and the rollout flag are gone, every link the API, the worker and the web produce addresses the center directly, and every old address keeps working through the permanent redirect table.

**Architecture:** The center becomes unconditional, so the stage disappears from the API, the web, the compose files and CI. The old routes stay in the route table as redirect-only places (the redirect table resolves old addresses through `locate`), but none of them renders a page: an old address ends on its center section, on the first area the member can open, or on the center's "Not available" message. The API gets one small builder for center addresses; a fixture of every address the API sends is checked by a web test against the real section registry, so the two sides cannot drift. Panels that the center mounts stay where they are; only the page shells, their navigation and code that nothing else uses are deleted.

**Tech Stack:** TypeScript, Next.js App Router (client shell), Fastify, Prisma, zod, Vitest (`renderToStaticMarkup` and pure functions in the web; integration tests over `app.inject`), Playwright.

**Spec:** [docs/plans/SYSTEM_MANAGEMENT_V2.md](../../plans/SYSTEM_MANAGEMENT_V2.md) (section 5.3 "the table stays permanently", section 10 row 5.4, section 13 "Removed in 5.4", section 14 rollback), [docs/adr/0027-settings-center.md](../../adr/0027-settings-center.md). Builds on [phase 5](2026-11-12-settings-center-phase-5.md); its known limits are in `docs/IMPLEMENTATION_STATUS.md`.

**Precondition (spec row 5.4):** the flag value `on` is accepted in production. It is `on` since 2026-11-12 18:47 UTC; Mario's walk over old links is the acceptance. No task of this plan is delivered before he confirms it.

**Not in this plan:** rewriting stored rows or messages already sent (they keep old addresses and resolve through the table); the Social OAuth return address (P54-D6); the known limits M-2 and M-5 to M-8, N-1 to N-3 of phase 5; mailboxes shared across projects (D-5); the D-8 confirmation copy.

## Decisions taken in this plan (Mario confirms them with the plan review)

| No | Decision | Why |
| --- | --- | --- |
| P54-D1 | One delivery after the acceptance of `on`. Rollback is a revert of this delivery's commits (spec section 14); the commits are grouped (links, old addresses, deletions, flag) so that a part can be reverted alone. | After this plan there is no flag to set back. |
| P54-D2 | `ORBIT_SETTINGS_CENTER` is removed everywhere; `/api/me` loses `settingsCenter`, the capabilities answer loses `stage`, `/api/management/*` is always registered (authentication and its own checks stay). The variable in Coolify becomes unused; Mario may delete it. | One stage is left. |
| P54-D3 | An old address whose scope the member cannot open shows the center's "Not available" message with a link home, where today the old page stays (P5-D5). A failed capabilities request shows an error with "Try again". The fallback to the first open area of the scope stays. | There is no old page left to stay on. |
| P54-D4 | A system administrator who is not an owner of the organization and opens `/o/:id/settings` lands on the system section of that organization (`/manage/system/organizations/:id`). The organization's connections and AI panels are no longer reachable for them. | D-9: the center does not list foreign organizations for a system administrator; the old page was the only place that did. |
| P54-D5 | Stored notification links and messages already sent are not rewritten. | The redirect table is permanent; no migration and no data change. |
| P54-D6 | The Social OAuth return keeps landing on the module's accounts page, which forwards to the center. | The return address is validated to lie below the project's Social pages; widening that check is a security change with no gain. |
| P54-D7 | Where a section fits better than the table's area, the API links name it: budget and spending-authority items lead to `ai/budget`; the Drive return leads to `integrations/google-drive`. Every other link equals what the redirect table gives for the old address. | One click less; no other change of meaning. |

## Global Constraints

- Work in the worktree `.claude/worktrees/system-management-v2` on the branch the controller names (cut from the current `main`). Before Task 1: `node scripts/test-db-for-worktree.ts`.
- The redirect table (`mapOldAddress` and its rows) is permanent. No row is removed; every old address that lands on a center section today lands on the same section afterwards, except where P54-D3, P54-D4 and P54-D7 say otherwise.
- The route table keeps recognising the old addresses (`settings`, `connectors` with their legacy paths, the `admin` and `organizationSettings` places, `account`, `account-assistant`, the Social accounts page). `/account/confirm-email` stays a page.
- A panel the center mounts is not changed in behaviour. Deleted is only what no remaining code imports. No setting, action or panel that exists only on an old page may be lost: the inventory found three such things and each has a ruling (the "AI providers" pointer panel is dropped, it is a link only; the keys modal is replaced by the Public access section; the old page head text is dropped).
- No database migration, no schema change, no new dependency, no change to roles or permissions, no change to a write path. No stored setting or data is deleted.
- The platform never imports `apps/web/src/modules/<id>/` or `apps/api/src/modules/<id>/` (`node scripts/source-check.mjs`: 0 new violations). A test may import the module registries.
- Texts: English and German for every new or changed string, in the texts file of its folder; no inline `de ? … : …` in new files.
- Opening a page or following a redirect never writes. Tests never reach a provider.
- Access-matrix fixture changes are reviewed as security changes; `pnpm api:generate` after an API change; `docs/API_CONTRACT.md` updated.
- Documentation and code comments are English. In documents, do not write a repository path with a line number in backticks. Commit messages end with exactly `Co-Authored-By: Claude <noreply@anthropic.com>`; no assistant model names anywhere.
- Do not push, deploy or change a production setting; each needs Mario's approval.
- Local commands (Node 24: `export PATH=~/.nvm/versions/node/v24.18.0/bin:$PATH`): tests `node --env-file=/Users/marioeuchner/EDS-Labs/Development/EDS-Orbit/.runtime/local.env ./node_modules/vitest/vitest.mjs run <files>`; types `./node_modules/.bin/tsc --noEmit` (root and `apps/web`); boundaries `node scripts/source-check.mjs`. The whole suite and the browser runs are the controller's (Task 9).

## Review Focus

- A stored notification link `/p/:id/settings?section=ai` opened from the bell by a member who is not an owner: lands on the first area they can open, never on a dead page (Task 2).
- An old address while the capabilities request fails (API down, session expired): an error with "Try again", no blank screen and no loop (Task 2).
- A Telegram button of an old message (`/p/:id/settings`) and a bookmark with `?section=` of a module that is switched off: land on the project overview and the moved place as today (Task 2, table rows unchanged).
- A Drive sign-in started before the deploy returns to the old callback address, one started after it to the new one: both end on the Drive section with the result shown (Task 5).
- A browser tab that still runs the previous web bundle after the deploy: `/api/me` no longer carries `settingsCenter`, the old bundle falls back to its own old pages, whose API routes are unchanged, until the tab reloads (Task 6: no API route that an old page used is removed).

## File Structure

- Create `apps/api/src/platform/management/links.ts`: builders for center addresses (API side).
- Create `apps/api/tests/fixtures/center-links.json` and `apps/api/tests/center-links.test.ts`: every address the API sends.
- Create `apps/web/src/platform/settings-center/api-links.test.tsx`: resolves the fixture in the real registry.
- Create `apps/web/src/platform/shell/former-address.tsx`: the screens for an old address that cannot be forwarded.
- Modify `apps/web/src/components/orbit.tsx`, `platform/shell/{shell-links.ts,user-menu.tsx,nav-groups.ts,routes.ts,settings-nav.tsx,attention-list.tsx,shell-context.tsx}`, `platform/settings-center/{redirects.ts,capabilities.ts,types.ts}`, `modules/registry.ts`, `lib/api.ts`.
- Delete page shells and code only they use (Task 3 lists them).
- Modify API producers (Task 5 lists them), `packages/config/src/index.ts`, `apps/api/src/server.ts`, `apps/api/src/platform/management/{flag.ts,capabilities.ts,routes.ts}`, both compose files, `scripts/check-coolify-compose.mjs`, `.env.example`, `.github/workflows/orbit-ci.yml`; delete scripts/e2e-stage-check.mjs.

---

### Task 1: The web no longer reads a stage

**Files:**
- Modify: `apps/web/src/components/orbit.tsx`, `apps/web/src/platform/shell/shell-links.ts`, `user-menu.tsx`, `nav-groups.ts`, `apps/web/src/platform/settings-center/capabilities.ts`, `redirects.ts`, `types.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/modules/social/accounts-page.tsx`, `apps/web/src/modules/knowledge/workspace.tsx`, `modules/knowledge/github-page.tsx`
- Test: the unit tests beside each of them

**Interfaces:**
- Produces: `shellLinks({ hrefOf, map }): ShellLinks` (no `stage`); `userMenuEntries` without a stage parameter (always the one center entry); `moduleSettingsHref` and `navEntryHref` without `on`; `withCenterEntry` always applied; `RedirectContext` without `stage`; `centerState` without the result `off`; `Identity` without `settingsCenter`; `ManagementCapabilities` (web type) without `stage`.

- [ ] **Step 1:** In each unit test file, delete the cases that pin `off` or `preview` (`user-menu.test.tsx`, `shell-links.test.tsx`, `settings-nav.test.tsx` "without on", `redirects.test.tsx` "does nothing unless the stage is on", `capabilities.test.tsx` "is off without the flag", the off and preview halves of `accounts-page.test.tsx` and of the Knowledge `workspace.test.tsx` GitHub cases, `mailbox-note.test.tsx` and Finance `settings.test.tsx` cases that pass a stage) and change the remaining ones to the new signatures. Run them: they fail to compile against the old signatures.
- [ ] **Step 2:** Remove the stage from the listed files; every branch keeps its `on` side. The Social accounts page always shows the summary or forwards an OAuth result; the Knowledge tab always shows `GithubAppSummary`; `github-page.tsx` loses its fallback to the old tab address.
- [ ] **Step 3:** Run the web unit tests under `platform/shell/`, `platform/settings-center/`, `components/`, `modules/social/`, `modules/knowledge/`, `modules/support/`, `modules/finance/`, both type checks and the source check. Expected: pass.
- [ ] **Step 4:** Commit `refactor(web): the settings center no longer has stages`.

### Task 2: An old address never renders an old page

**Files:**
- Create: `apps/web/src/platform/shell/former-address.tsx`, `former-address.test.tsx`
- Modify: `apps/web/src/platform/settings-center/redirects.ts`, `redirects.test.tsx`, `apps/web/src/components/orbit.tsx`, `apps/web/src/platform/settings-center/texts.ts`

**Interfaces:**
- Consumes: `mapOldAddress`, `oldAddressTarget`, `redirectFor`, `redirectScreen` (phase 5).
- Produces: `redirectFor(ctx): { kind: "none" } | { kind: "wait" } | { kind: "go"; href: string } | { kind: "closed" } | { kind: "failed" }`, where `none` is returned only for an address that is not an old address; `OldAddressScreen({ kind, onRetry })` for `closed` and `failed`, rendered inside the assistant wrapper like the loading screen.
- `mapOldAddress` gains one input, `systemAdminOnly(organizationId): boolean` (true when the member is a system administrator and not an owner of that organization): then `/o/:id/settings` maps to `/manage/system/organizations/:id`, hash and search dropped (P54-D4).

- [ ] **Step 1: Failing tests** in `redirects.test.tsx`: an old project address with a failed capabilities request gives `failed`; an old organization address for a member without that organization gives `closed`; for a system administrator who is not an owner it gives `go` to `/manage/system/organizations/w1`; an owner still gets `/manage/o/w1/overview` and `/manage/o/w1/ai/budget#assistant-budget`; a member without the target area still gets the first open area; `/account/confirm-email` and a path that is no old address give `none`; every row of the existing table test still passes unchanged. In `former-address.test.tsx`: `closed` renders the "Not available" text and a link to `/`; `failed` renders the error text and a "Try again" button; both in German.
- [ ] **Step 2:** Run them. Expected: fail.
- [ ] **Step 3:** Implement. In `orbit.tsx` the places `admin`, `organizationSettings`, the standalone `account` and `account-assistant` routes and the project routes `settings` and `connectors` no longer render a page: each is decided by `redirectFor` alone. "Try again" refetches the capabilities.
- [ ] **Step 4:** Run the tests of Step 1, the web unit tests under `platform/shell/` and `platform/settings-center/`, and both type checks. Expected: pass.
- [ ] **Step 5:** Commit `feat(web): old settings addresses forward or say why not`.

### Task 3: Delete the old page shells

**Files (delete or reduce; a symbol goes only when nothing imports it after Task 2):**
- `apps/web/src/components/management.tsx`: `ProjectSettings` with its "AI providers" pointer panel and its `/mcp-grants` request; the page head and the `embedded` and `groupMailboxes` props of `Connectors` (it always renders as the center mounts it).
- `apps/web/src/components/ai-settings.tsx`: `AiSettings` and `AiSettingsView` (the panels stay).
- `apps/web/src/components/public-keys.tsx`: the `PublicKeys` modal; `project-administration.tsx`: the `publicKeys` prop and the keys button.
- `apps/web/src/platform/administration/admin-area.tsx`: `AdminArea`, its `NAV`, `BackLink`, the mobile select and the inline AI composition (the section components stay); `organization-integrations.tsx`: the component (the type of the same name under `settings-center/integrations/` stays).
- `apps/web/src/platform/shell/settings-nav.tsx`: `collectSettingsTabs`, `groupSettings`, `sectionFromSearch` (`platformSettingsTabs`, `MOVED`, `SettingsNav`, `moduleSettingsSection`, `settingsSectionHref` stay while something uses them).
- `apps/web/src/modules/registry.ts`: the page components of the routes `settings` and `connectors` (the route entries and legacy paths stay as redirect-only entries; `connectors` leaves the sidebar).
- Their unit tests: `lib/capability-text.test.tsx` "project settings capability list", the `groupSettings`, `sectionFromSearch` and old-page cases of `settings-nav.test.tsx`, the modal cases of `public-keys.test.tsx`, the editor-on-module-page cases of Social and Knowledge.

- [ ] **Step 1:** Add a test `apps/web/src/platform/shell/removed-pages.test.tsx` that fails while an old shell exists: the module registry's routes `settings` and `connectors` have no page component, and `@/components/management` does not export `ProjectSettings`.
- [ ] **Step 2:** Run it. Expected: fail.
- [ ] **Step 3:** Delete as listed. For each deleted export run a search for remaining imports; a remaining import is a finding to report, not a reason to keep the shell. Remove CSS rules in `app/globals.css` that only the deleted shells used (search each class name first).
- [ ] **Step 4:** Run the whole web unit suite, both type checks, the source check and `(cd apps/web && ./node_modules/.bin/next build)`. Expected: pass.
- [ ] **Step 5:** Commit `refactor(web): remove the old settings page shells`.

### Task 4: The web's own links address the center

**Files:**
- Modify: `apps/web/src/platform/shell/shell-context.tsx`, `shell-links.ts`, `attention-list.tsx`; `platform/assistant/{assistant-panel.tsx,assistant-page.tsx,budget-notice.tsx}`, `platform/account/{account-view.tsx,personal-context.tsx,token-pages.tsx}`, `platform/drive/drive-page.tsx`, `platform/settings-center/sections/system.tsx` (`adminLinkInCenter`), `lib/exception-text.ts`, `modules/support/action-requests.tsx`, `modules/marketing/{overview.tsx,policy-versions.tsx,policy-editor.tsx}`, `modules/finance/overview.tsx`, `components/management.tsx`, and their tests

**Interfaces:**
- Produces: `ShellContextValue.projectCenterHref(area: string, ...rest: string[]): string` (the open project's center address); `attentionTarget` accepts a link that starts with `/manage/` and returns it unchanged; a project-relative link keeps today's handling.

- [ ] **Step 1: Failing tests:** `budget-notice.test.tsx` expects `/manage/o/w1/ai/budget#assistant-budget`; `drive-page.test.tsx` expects `/manage/p/p1/integrations/google-drive`; `home.test.tsx` expects `attentionTarget("/manage/p/p1/ai/budget", …)` to return the same address and an old relative link to keep mapping; a new case renders `AccountView` and `PersonalContextView` and finds `/manage/me/assistant` and `/manage/me/profile`, no `/account` address; `adminLinkInCenter` returns a `/manage/system/…` address for every admin section of the table.
- [ ] **Step 2:** Run them. Expected: fail.
- [ ] **Step 3:** Implement: the raw links of M-3 and the hardcoded old addresses listed above are written as center addresses (through `manageHref` or `projectCenterHref`); the mapping stays in place for links whose address comes from data (stored notification links, old relative attention links).
- [ ] **Step 4:** Run the web unit suite and both type checks. Expected: pass.
- [ ] **Step 5:** Commit `feat(web): settings links name their center section`.

### Task 5: The API sends center addresses

**Files:**
- Create: `apps/api/src/platform/management/links.ts`, `apps/api/tests/center-links.test.ts`, `apps/api/tests/fixtures/center-links.json`, `apps/web/src/platform/settings-center/api-links.test.tsx`
- Modify: `apps/api/src/server.ts` (Drive callback), `platform/signals/initial.ts`, `platform/attention/platform-items.ts`, `platform/assistant/user-tools.ts`, `platform/notifications/notify.ts`, `modules/marketing/attention.ts`, `modules/marketing/agents/run-operation.ts`, `modules/marketing/agents/notification-messages.ts`, `modules/finance/attention.ts`, `modules/social/attention.ts`, `modules/social/notifications.ts`, and the tests that pin their links

**Interfaces:**
- Produces: `projectCenterLink(projectId: string, area: string, ...rest: string[]): string` (`/manage/p/<id>/<area>/…`, each segment encoded); `moduleSectionLink(projectId: string, moduleId: string, section: string): string` (`/manage/p/<id>/modules/<moduleId>/<section>`); `inProject(projectId: string, link: string): string`, which returns a link that starts with `/manage/` unchanged and prefixes any other with `/p/<id>` (used wherever a relative attention or signal link is made absolute today).
- Targets (P54-D7): AI budget signal, provider budget item and spending-authority item → `ai/budget`; Marketing publishing-rules item → `modules/marketing/policy`; Finance items → `modules/finance/mailboxes` and `modules/finance/currencies`; Social account item and notification → `integrations/social/accounts`; Marketing "resume project" recovery and its Telegram button → `overview`; Drive callback → `/manage/p/<id>/integrations/google-drive?googleDrive=ready` or `choose-root`. Attention items keep their `navKey`.
- Fixture: a JSON array of `{ "producer": string, "link": string }` with the ids `p1` and `w1`.

- [ ] **Step 1: Failing tests:** `center-links.test.ts` builds each producer's link for project `p1` and compares the list with the fixture (`UPDATE_CENTER_LINKS=1` rewrites it); the existing integration tests that pin old links (`proactive-signals`, `attention-marketing`, `finance-tools`, `drive-callback`, `proactive-delivery`) expect the new addresses; `inProject` leaves a `/manage/` link alone. `api-links.test.tsx` reads the fixture and resolves every link with `resolveSection` over the real registry (all modules shown, an owner's capabilities): each must end on an existing section, none on "not found".
- [ ] **Step 2:** Run them. Expected: fail.
- [ ] **Step 3:** Implement. Module files keep their own link constants and use the platform's builders.
- [ ] **Step 4:** Run the API tests named in Step 1, the access and RLS matrices, the web test, both type checks and the source check. Expected: pass; no matrix row changes.
- [ ] **Step 5:** Commit `feat(api): links to settings name their center section`.

### Task 6: Remove the flag

**Files:**
- Modify: `packages/config/src/index.ts`, `apps/api/src/server.ts` (the 404 gate, the `settingsCenter` field of `/api/me`), `apps/api/src/platform/management/capabilities.ts` (`stage`), `routes.ts`, `docker-compose.yml`, `docker-compose.pve.yml`, `scripts/check-coolify-compose.mjs`, `.env.example`, `docs/API_CONTRACT.md`
- Delete: apps/api/src/platform/management/flag.ts
- Test: `management-capabilities`, `management-ai`, `management-integrations`, `administration`, `access-matrix` integration tests

- [ ] **Step 1:** In the tests, delete the cases "answers 404 while the flag is off" and the `/api/me` stage cases, remove the flag from their environment set-up, and add to `management-capabilities.integration.test.ts`: the answer has no `stage`; an unauthenticated request answers 401. Run: the new cases fail.
- [ ] **Step 2:** Remove the flag as listed. No API route that an old page used is removed (Review Focus, old bundles).
- [ ] **Step 3:** Run those tests, `node scripts/check-coolify-compose.mjs`, `node scripts/check-pve-compose.mjs`, `pnpm api:generate` (expected: no diff), both type checks. Expected: pass.
- [ ] **Step 4:** Commit `refactor: remove the settings center rollout flag`.

### Task 7: Texts that name old pages

**Files:**
- API: `platform/proactive/{briefing.ts,digest.ts}`, `platform/ai/mcp-tools.ts`, `modules/marketing/publishing/integrations-admin.ts`, `platform/agents/work-orders/execute.ts`, `modules/marketing/readiness/blocker-catalog.ts`
- Web: `lib/exception-text.ts`, `lib/budget-refusals.ts`, `lib/readiness-text.ts`, `lib/i18n.ts`, `modules/knowledge/{workspace-parts.tsx,add-flow.tsx}`, `modules/marketing/advanced.tsx`, `modules/finance/labels.ts`, `components/{telegram-connection.tsx,signal-settings.tsx}`

**Rule:** a text that sends the reader to a place names it as the center shows it: "Administration & settings → <area title> → <section title>" ("Verwaltung & Einstellungen → …"), with the titles of `apps/web/src/platform/settings-center/registry.ts` and of the module's section. A text that already links to the place loses the path words. Stored notification bodies are not rewritten.

- [ ] **Step 1:** Add `apps/web/src/platform/settings-center/place-words.test.tsx`: no string in the listed web files matches `Settings → ` or `Einstellungen → ` unless it starts with the center's name. Add the same check for the listed API files in `apps/api/tests/center-links.test.ts`. Run: fail.
- [ ] **Step 2:** Change the texts by the rule; update tests that pin the old wording.
- [ ] **Step 3:** Run the web unit suite and the API tests of the touched folders. Expected: pass.
- [ ] **Step 4:** Commit `fix: texts name settings places as the center shows them`. The report lists every changed sentence in English and German for the controller's wording review.

### Task 8: Browser tests and CI

**Files:**
- Modify: `apps/web/tests/{settings-center.spec.ts,settings-center-ai.spec.ts,settings-center-on.spec.ts,settings-center-helpers.ts,navigation.spec.ts,workspace.spec.ts,administration.spec.ts,knowledge-workspace.spec.ts}`, `.github/workflows/orbit-ci.yml`
- Delete: scripts/e2e-stage-check.mjs

- [ ] **Step 1:** Delete the five tests that assert old pages (the inventory's list: "keeps the old pages", "keeps the old connectors and social pages", "old AI pages keep working", "module settings links open their section of the grouped settings", "settings open by ?section and the legacy path forwards"); keep from the last one the legacy forwards as rows of the redirect walk. Remove the `stage` helper and every branch on it, keeping the center side; `settings-center-on.spec.ts` runs without its stage gate.
- [ ] **Step 2:** Add to `settings-center-on.spec.ts`: an old address of a project the member has no access to shows "Not available" or "not found" and never an old page heading; with the capabilities request aborted (route interception) an old address shows the error and "Try again" loads the section; the Drive return address of Task 5 shows the Drive section.
- [ ] **Step 3:** CI: the browser job drops `ORBIT_SETTINGS_CENTER`; the job `browser-settings-center-on` and its guard step are deleted.
- [ ] **Step 4:** Run the changed specs against the controller's stack (ADMINISTRATION, ACCOUNT, CONNECTIONS, MODULES; 75 seconds between runs). Expected: pass, with the two seeded-stack skips (attention, Social).
- [ ] **Step 5:** Commit `test(web): one settings surface in the browser suite; CI runs one job`.

### Task 9: Documents and verification (controller)

- [ ] **Step 1:** Update `docs/IMPLEMENTATION_STATUS.md` (new entry: what was removed, what an old address does now, P54-D1 to D7, what stays as known limit), `docs/plans/SYSTEM_MANAGEMENT_V2.md` (status line, section 10 row 5.4 as built, section 5.7 the flag is gone, section 14 rollback), `docs/REQUIREMENTS_TRACEABILITY.md` (rows for 5.4; SC2-1 marked superseded), `docs/adr/0027-settings-center.md` (rollout finished), `docs/deployment/COOLIFY.md` (the flag row removed, the unused variable named), `docs/API_CONTRACT.md`, `docs/DESIGN_SYSTEM.md`, `docs/MODEL_ROUTING.md`, and the operator documents of the inventory that send readers to old pages.
- [ ] **Step 2:** Whole unit and integration suite on a fresh test database; type checks, source check, both compose checks, secret scan, framework check, web build.
- [ ] **Step 3:** Whole browser suite twice on fresh seeds: with the CI flags (ADMINISTRATION, ACCOUNT) and with ADMINISTRATION, ACCOUNT, CONNECTIONS, MODULES. Walk by hand in German at 1280 and 390 px: the twelve old addresses of the phase 5 walk, a stored notification link from the bell, the user menu, the sidebar, `/account/confirm-email`.
- [ ] **Step 4:** Whole-branch review on the most capable model, one fix wave, scoped re-review.
- [ ] **Step 5:** Report to Mario with the changed sentences of Task 7 and the list of deleted files; ask for approval before any push to `main`. After delivery: Coolify deployments finished and healthy, `/api/setup` 200, `/api/management/capabilities` 401 without a session, and an old address in production forwards (Mario's session).

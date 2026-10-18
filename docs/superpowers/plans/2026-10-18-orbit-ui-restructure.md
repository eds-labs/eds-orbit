# Orbit UI Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group the sidebar by module with collapsible groups, give every module its own overview page, reduce the home page to a cross-module attention list plus module cards, and sort the settings by module.

**Architecture:**
- The web shell's navigation becomes data: `ViewDef.navGroup` places each page in a group, and a pure `buildNavGroups()` turns the route table into the grouped sidebar.
- A new read-only platform endpoint `GET /api/projects/:id/attention` collects items that modules contribute through `ModuleContributions.attention`. The platform filters them by module state and module role.
- The web renders the items by kind, through renderers that each `WebModule` contributes. One shared `useAttention()` feeds both the home page and the sidebar badges.

**Tech Stack:** Next 16.3.8 (single client route, own shell router), React 19.3, hand-written CSS in `apps/web/src/app/globals.css`, lucide-react, Fastify + Prisma 7 (API), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-18-orbit-ui-restructure-design.md` (decisions U1–U10). The mockups are on the canvas "Orbit UI Restructure" (claude.ai artifact `Vd2aGpwT1ZgVaq2m2sN96u`).

## Global Constraints

- Five PRs, one per phase, in this order: navigation (Tasks 1–4), module overviews (5–8), attention (9–13), home (14–15), settings (16–17). Each merge deploys to production and needs Mario's approval. Each phase leaves the app fully working.
- No schema change, no migration, no new permission, no new dependency, no feature flag (U10).
- Risk class **medium**. Rollback is a revert and a redeploy.
- Support notification links stay `/p/:id/support?ticket=<id>`. The web redirects them (spec §6).
- `localStorage` may hold only `orbit.locale`, `orbit.lastProject` and the new `orbit.nav.collapsed`, which is a JSON array of group ids. Every access goes through try/catch.
- Every UI string exists in EN and DE. Code comments and docs are in English.
- Every new data view has a loading state (`Skeleton`), an empty state (`Empty`) and an error state (`ResourceError`). A 404 from a module endpoint renders nothing. An unknown value renders `—`.
- The attention response has at most 50 items, `Cache-Control: no-store`, no audit row, and only counts in logs.
- Tests:
  - Run `node scripts/test-db-for-worktree.ts` once per worktree.
  - Unit tests: `node ./node_modules/vitest/vitest.mjs run <path>`.
  - Integration tests: `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run <path>`.
  - E2E tests: `./node_modules/.bin/playwright test <spec>`.
  - Use Node 24 (`export PATH=~/.nvm/versions/node/v24.18.0/bin:$PATH`).
- Never `git add` a symlinked `node_modules`. Stage files by name.

## Review Focus

1. **A member with module role `none`, or a disabled module, sees nothing of that module.** That covers the sidebar group, the badges, the attention items and the home card. Pinned in Task 2 (nav) and Task 9 (API).
2. **Stored links still work.** Old notification links `/support?ticket=<id>`, the legacy paths (`/missions`, `/approvals`, …), bookmarks to `/knowledge/<tab>`, and settings opened without `?section` must all still open the right page. Pinned in Tasks 1, 7, 8 and 16.
3. **The collapse state is broken or stale.** This covers storage that is unavailable, a stored id of a module that is gone, and the active page sitting inside a collapsed group. Defaults apply, unknown ids are ignored, and the active group stays open. Pinned in Task 3.
4. **The attention load fails or a new kind is unknown.** On failure, the home page shows an error row, the badges disappear and navigation keeps working. An unknown kind renders the generic row. Pinned in Task 13.
5. **A viewer sees owner-only data.** Action requests and unknown AI cost belong to owners only. Pinned in Task 12.

---

## Phase 1 — Navigation (PR 1)

### Task 1: Navigation groups in the route contract and registry

**Files:**
- Modify: `apps/web/src/platform/shell/types.ts`. Add `ViewDef.navGroup?: string`, `NavEntry.mobileRank?: number` and `WebModule.groupOrder?: number` (sidebar position of the module's group: marketing 10, support 20, knowledge 30, set in the three manifests).
- Modify: `apps/web/src/platform/shell/routes.ts`. Make three changes:
  - `routeTable` validates `navGroup`.
  - Add `navGroupOf(route: Route): string`.
  - Make `crumbs()` return the group label first.
- Modify: `apps/web/src/modules/registry.ts`. Platform views get groups and ranks.
- Modify: `apps/web/src/modules/support/manifest.tsx`. `support-contacts` and `support-stats` get nav entries (orders 20 and 30) and lose `navKey`. The root keeps the inbox for now, labelled Tickets.
- Modify: `apps/web/src/modules/knowledge/manifest.tsx`:
  - `sources`, `facts`, `conflicts`, `import` and `library` get nav entries, with orders 10–50 in that order.
  - The root gets the label Übersicht/Overview.
  - `health`, `impact` and `inspector` keep `navKey: "knowledge"`.
- Modify: `apps/web/src/modules/marketing/manifest.tsx`. Set `content` mobile rank 40.
- Modify: `apps/web/src/lib/i18n.ts`. Add the keys `overview` (already present), `tickets`, `contacts`, `statistics`, `navModules`, `navProject`, `sources`, `facts`, `conflicts`, `import`, `library`, en and de.
- Test: `apps/web/src/platform/shell/routes.test.tsx`

**Interfaces:**
- Produces:
  - `navGroupOf(route: Route): string`: returns `route.navGroup ?? route.moduleId ?? "top"`.
  - `crumbs(route, table, locale, groupLabel?: (group: string) => string | undefined): string[]`.
- `routeTable` adds a problem in three cases:
  - a `navGroup` that is not `"top"`, `"project"` or a known module id;
  - a module view whose `navGroup` differs from its module id;
  - a `nav.mobileRank` without `nav.mobile`.
- Platform values:

  | key | navGroup | mobile / rank |
  |---|---|---|
  | home | top | rank 0 |
  | chat | top | rank 10 |
  | approvals | marketing | rank 30, order 45 |
  | connectors, operations, settings | project | — |

- [ ] **Step 1: Replace the test "keeps the sidebar and mobile order of the old navigation"**

  The new test is "groups the navigation by module". It asserts:
  - `navGroupOf` of `home` and `chat` is `"top"`.
  - `navGroupOf` of `approvals` is `"marketing"`.
  - `connectors`, `operations` and `settings` are in `"project"`.
  - `support-contacts` and `support-stats` have `nav`.
  - Every `nav` has EN and DE labels.

  Add three more tests:
  - "rejects an unknown navGroup": a registry with `navGroup: "nope"` throws `/WEB_ROUTES_INVALID/`.
  - "rejects a module page in another module's group".
  - "crumbs show the group": `crumbs(route("knowledge-sources"), table, "de", g => g === "knowledge" ? "Wissen" : undefined)` equals `["Wissen", "Quellen"]`. `crumbs(route("home"), …)` has length 1.

  Keep the LEGACY test unchanged.

- [ ] **Step 2: Run `node ./node_modules/vitest/vitest.mjs run apps/web/src/platform/shell/routes.test.tsx`.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement the type, validation, `navGroupOf`, `crumbs` and the registry and manifest changes listed above.**
- [ ] **Step 4: Run the same command.** Expected: PASS. Run `./node_modules/.bin/tsc --noEmit -p apps/web`. Expected: no errors, apart from call sites of `crumbs`, which Task 3 updates. If there are such errors, pass `undefined` for now.
- [ ] **Step 5: Commit** `feat(web): navigation groups in the route contract`.

### Task 2: `buildNavGroups()`

**Files:**
- Create: `apps/web/src/platform/shell/nav-groups.ts`
- Test: `apps/web/src/platform/shell/nav-groups.test.tsx`

**Interfaces:**
- Consumes: `navGroupOf`, `navOrder`, `routeEnabled` (Task 1, `routes.ts`).
- Produces:
  ```ts
  export type NavGroup = {
    id: string;                 // "top" | module id | "project"
    label: Label | null;        // null for "top"; module displayName; {en:"Project",de:"Projekt"}
    entries: Route[];           // sorted by nav.order
    settingsHref?: string;      // filled by the shell from ShellModule.settingsSection (Task 16)
  };
  export function buildNavGroups(
    routes: readonly Route[],
    modules: ReadonlyArray<{ id: string; displayName: Label; enabled: boolean; groupOrder?: number }>,
  ): NavGroup[];
  export function mobileEntries(routes: readonly Route[], enabled: (id: string) => boolean): Route[]; // first 4 by mobileRank
  ```
- The group order is `top`, then the modules by `groupOrder` (ties in registry order), then `project`. A group without entries is left out. A route that is not enabled (`routeEnabled`) is left out, so approvals disappears when marketing is off.

- [ ] **Step 1: Write the failing tests** using `routeTable(webRegistry)`:
  - "orders top, modules by groupOrder, project": all modules enabled gives the ids `["top","marketing","support","knowledge","project"]`.
  - "drops a disabled module and its approvals entry": with marketing `enabled:false`, no group has an entry with key `approvals`.
  - "puts approvals into marketing after calendar": the marketing entry keys contain `approvals` directly after `calendar`.
  - "mobile picks four by rank": with all modules on, the result is `["home","chat","support","approvals"]`. With support off, it is `["home","chat","approvals","content"]`. Use the key the support root has in Task 1 (`support`); Task 7 changes it to `support-tickets` and updates this test.
- [ ] **Step 2: Run** `node ./node_modules/vitest/vitest.mjs run apps/web/src/platform/shell/nav-groups.test.tsx`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `buildNavGroups` and `mobileEntries` in `nav-groups.ts`.**
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): grouped navigation model`.

### Task 3: Collapsible sidebar and mobile bar in the shell

**Files:**
- Create: `apps/web/src/platform/shell/sidebar-nav.tsx`
- Create: `apps/web/src/platform/shell/nav-collapse.ts`, for storage
- Modify: `apps/web/src/components/orbit.tsx:523-539` and `:646-669`. Replace the flat `<nav>` with `<SidebarNav>`, and drive the mobile bar from `mobileEntries`. Pass group labels to `crumbs`.
- Modify: `apps/web/src/app/globals.css`. Add the classes `.nav-group`, `.nav-group-head`, `.nav-group-list`, `.nav-sub-link`, `.nav-badge`, `.nav-section-label`, after `.nav-link` (around line 256). Use the canvas look:
  - group header 13.5 px / 600;
  - sub-entries indented 18 px with a 1 px `#d3e3ef` guide line;
  - active `#dbeafe` / `#0a4fc2`;
  - badge 20 px pill `#0969ff` (warning `#fff1cc` / `#7a5a10`);
  - chevron rotation disabled under `prefers-reduced-motion`.
- Test: `apps/web/src/platform/shell/sidebar-nav.test.tsx`, `apps/web/src/platform/shell/nav-collapse.test.tsx`

**Interfaces:**
- Consumes: `NavGroup`, `buildNavGroups` (Task 2).
- Produces:
  - `readCollapsed(): Set<string>` and `writeCollapsed(ids: Set<string>): void` in `nav-collapse.ts`, using key `orbit.nav.collapsed`. Both swallow storage errors, and `readCollapsed` ignores non-string entries.
  - `<SidebarNav groups={NavGroup[]} activeKey={string | undefined} hrefOf={(r: Route) => string} badges={Record<string, number>} locale="en"|"de" />`. `badges` is keyed by route key and defaults to `{}`. Task 13 supplies real values.
- Behavior:
  - The `top` group renders without a header.
  - Before the first module group, render a section label "Module"/"Modules". Before `project`, render "Projekt"/"Project".
  - Each other group header is `<button aria-expanded aria-controls>`.
  - Collapsing writes storage.
  - The group that contains `activeKey` is always rendered open, and its toggle still works for the other groups.
  - A collapsed group shows the sum of its entries' badges.

- [ ] **Step 1: Write the failing tests.** Use React Testing Library, as `shell.test.tsx` already does.
  - `nav-collapse`:
    - "returns an empty set when storage throws": stub `localStorage.getItem` to throw.
    - "ignores non-string ids": the stored value `["marketing",3]` gives `{"marketing"}`.
  - `sidebar-nav`:
    - "toggles a group and remembers it": clicking "Support" sets `aria-expanded="false"` and stores `["support"]`.
    - "keeps the active group open": stored `["marketing"]` with `activeKey="missions"` shows the Missionen link.
    - "sums badges of a collapsed group": with badges `{approvals:3}` and marketing collapsed, the header contains "3".
    - "an unknown stored id is harmless": stored `["gone"]` renders all groups open.
- [ ] **Step 2: Run** `node ./node_modules/vitest/vitest.mjs run apps/web/src/platform/shell/sidebar-nav.test.tsx apps/web/src/platform/shell/nav-collapse.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement both files and wire them into `orbit.tsx`.** The drawer keeps its focus trap. Its selector `.sidebar` stays, and the group buttons are focusable. The mobile bar maps `mobileEntries(...)` and keeps the "More" button. Update `apps/web/src/platform/shell/shell.test.tsx` wherever it pinned the flat list.
- [ ] **Step 4: Run** the two new tests and `apps/web/src/platform/shell`. Expected: PASS. Run `tsc --noEmit -p apps/web`. Expected: clean.
- [ ] **Step 5: Commit** `feat(web): collapsible module groups in the sidebar`.

### Task 4: E2E navigation and phase-1 docs

**Files:**
- Modify: `apps/web/tests/navigation.spec.ts`
- Modify: `docs/DESIGN_SYSTEM.md`. In "Composition" add the grouped sidebar. In the `localStorage` sentence add `orbit.nav.collapsed`.
- Modify: `docs/IMPLEMENTATION_STATUS.md`. Add a UI restructure section with phase 1 and update the post-deploy check at line 739 to the grouped sidebar.

- [ ] **Step 1: Write the failing e2e tests:**
  - "sidebar groups collapse and stay collapsed after reload": click the Marketing header, reload, and `Missionen` is hidden while on Start.
  - "the open page's group stays open": go to `/p/:id/marketing/missions` with marketing collapsed, and the link is visible with `aria-current="page"`.
  - "mobile bar shows Start, Chat and two module entries plus More" at 390×844.
- [ ] **Step 2: Run** `./node_modules/.bin/playwright test apps/web/tests/navigation.spec.ts`. Expected: the new tests PASS, because Task 3 is implemented. If a test fails, fix the component, not the test.
- [ ] **Step 3: Update the two docs.**
- [ ] **Step 4: Run** `node ./node_modules/vitest/vitest.mjs run apps/web` and `./node_modules/.bin/tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `test(web): grouped navigation e2e; docs`. Open PR 1.

## Phase 2 — Module overviews (PR 2)

### Task 5: Marketing overview at the module root

**Files:**
- Create: `apps/web/src/modules/marketing/overview.tsx`. Move `Overview` from `work.tsx:80-300` here as `MarketingOverview`.
- Modify: `apps/web/src/modules/marketing/manifest.tsx`. Add the view `{ key: "marketing-overview", path: "", component: MarketingOverview, nav: { label: Übersicht/Overview, icon: LayoutDashboard, order: 0 } }`. Keep `home: MarketingHome` rendering `<MarketingOverview embedded />` until Task 15.
- Modify: `apps/web/src/modules/marketing/work.tsx`. Remove the moved code and re-export nothing.
- Test: `apps/web/src/modules/marketing/overview.test.tsx`

**Interfaces:**
- Produces: `MarketingOverview({ embedded?: boolean })`. Its layout follows spec §5.3:
  - head: eyebrow "Modul", h1 "Marketing", actions "Content erstellen" (to content) and "Neue Mission";
  - mode band;
  - four metrics:
    - active missions;
    - open approvals: `approvalItems(content).length` plus the open exceptions;
    - published in 7 days: publications with status `published` and `scheduledAt` in the last 7 days;
    - AI budget of the month: `/ai-cost?from=<month start>&to=<now>` sum of `spentMicros` against `budget.monthlyLimitMicros`, `—` when unknown;
  - the `AgentActivityPanel`;
  - "Nächste 7 Tage": `/assignment-posts` where available (else the publications in the next 7 days), sorted by `scheduledAt`, at most 6;
  - missions (first 4) and the readiness panel.
- The "Recent" jobs panel is removed. Betrieb already lists jobs.

- [ ] **Step 1: Write the failing tests:**
  - "renders four metrics with — for an unknown budget": mock `useResource` the way existing marketing tests do.
  - "lists at most six next posts sorted by time".
  - "has no recent-jobs panel".
- [ ] **Step 2: Run** `node ./node_modules/vitest/vitest.mjs run apps/web/src/modules/marketing/overview.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and `apps/web/src/platform/shell/routes.test.tsx`. Expected: PASS. Update the "resolves every project page" expectations if needed: `/p/:id/marketing` now resolves to a view instead of a redirect.
- [ ] **Step 5: Commit** `feat(web): marketing overview page`.

### Task 6: Support API — SLA order, open filter, tickets per day

**Files:**
- Modify: `apps/api/src/modules/support/workspace.ts:36-47` (`listInput`) and `listTickets`.
- Modify: `apps/api/src/modules/support/common.ts`. Add `slaDueAt(ticket): Date | null` and `slaWhere(now: Date, range: { lt?: Date; gte?: Date })`, used by `ticketSummary` and later by Task 10.
- Modify: `apps/api/src/modules/support/stats.ts`. Add `volume.byDay`.
- Modify: `apps/web/src/modules/support/api.ts`. Add `byDay` to the stats type.
- Modify: `docs/API_CONTRACT.md`
- Test: `apps/api/tests/support-tickets.integration.test.ts` (extend the existing support test file if there is one, otherwise create it)

**Interfaces:**
- Produces:
  - `listInput` adds `sort: z.enum(["updated","sla"]).default("updated")` and `openOnly: z.enum(["true","false"]).default("false")`.
  - With `sort=sla`:
    - restrict to `SLA_ACTIVE_STATUSES`, not merged;
    - order by `slaDueAt` ascending, nulls last, then `id`;
    - the cursor is `base64url("sla|<iso or ->|<id>")`. A cursor of the other sort gives 400 `CURSOR_INVALID`.
  - `openOnly=true` adds `status in OPEN_STATUSES` and `mergedIntoTicketId: null`.
  - `slaDueAt(t) = t.firstRespondedAt ? (t.resolvedAt ? null : t.resolutionDueAt) : t.firstResponseDueAt`.
  - `volume.byDay`: `Record<"YYYY-MM-DD", number>` in the project's timezone (read the project `timezone`, default `UTC`). Every day of the range is present, zeros included.

- [ ] **Step 1: Write the failing integration tests:**
  - "sort=sla orders by the earliest open due time and skips resolved tickets": create three tickets with different due times and one resolved ticket.
  - "openOnly excludes resolved, closed and merged tickets".
  - "sla cursor pages without duplicates": limit 2 over 3 tickets.
  - "rejects an updated-cursor with sort=sla" with 400.
  - "stats byDay counts per project-local day with zero days": 14-day range, 2 tickets on one day.
  - "ticketSummary unchanged": the existing summary test still passes after the refactor to `slaWhere`.
- [ ] **Step 2: Run** `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run apps/api/tests/support-tickets.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** For `sort=sla`, select the page's ids with `tx.$queryRaw` ordered by `CASE WHEN "firstRespondedAt" IS NULL THEN "firstResponseDueAt" ELSE "resolutionDueAt" END ASC NULLS LAST, id ASC`, with the keyset condition from the cursor and `LIMIT limit+1`. Then load the rows with the existing `findMany` include by those ids and restore the order. Always inside the scoped `tx` (RLS), never `authDb`.
- [ ] **Step 4: Run** the file and the other support tests (`node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run support`). Expected: PASS.
- [ ] **Step 5: Update `docs/API_CONTRACT.md` and commit** `feat(support): SLA order, open filter and tickets per day`.

### Task 7: Support overview at the root, inbox at `/support/tickets`

**Files:**
- Create: `apps/web/src/modules/support/overview.tsx`
- Modify: `apps/web/src/modules/support/manifest.tsx`. Make two changes:
  - root `{ key: "support", path: "", component: SupportOverview, nav: Übersicht, order 0 }`;
  - `{ key: "support-tickets", path: "tickets", component: SupportInbox, nav: Tickets, order 10, mobile: true, mobileRank: 20 }`.
- Modify: `apps/web/src/modules/support/home.tsx`. The link goes to `hrefOf("support")`, the overview.
- Modify: `apps/web/src/platform/shell/nav-groups.test.tsx`. The mobile expectation now uses `support-tickets`.
- Modify: `docs/SUPPORT.md`. Document the inbox URL and that old links redirect.
- Test: `apps/web/src/modules/support/overview.test.tsx`

**Interfaces:**
- Consumes: `/support/summary`, `/support/tickets?sort=sla&limit=5`, `/support/tickets?view=mine&openOnly=true&limit=5`, `/support/stats?from=<now-14d>&to=<now>` (Task 6), `/support/inboxes` (existing).
- Produces:
  - `SupportOverview()`, laid out as spec §5.3.
  - `ticketRedirect(search: string): string | null`, a pure export. If the query has `ticket=<uuid>`, it returns `"tickets?ticket=<id>"`. On mount the overview calls `router.replace(hrefOf("support-tickets") + "?ticket=" + id)`.

- [ ] **Step 1: Write the failing tests:**
  - "redirects ?ticket to the tickets page": `ticketRedirect("?ticket=<uuid>")` returns `"tickets?ticket=<uuid>"`; `ticketRedirect("?ticket=x")` returns null.
  - "shows five metrics with — for missing stats".
  - "lists urgent tickets in API order".
  - "renders 14 bars from byDay".
- [ ] **Step 2: Run** `node ./node_modules/vitest/vitest.mjs run apps/web/src/modules/support`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node ./node_modules/vitest/vitest.mjs run apps/web`. Expected: PASS. Add the e2e test "an old support notification link opens the ticket" to `apps/web/tests/workspace.spec.ts`. Skip it when support is off in the e2e project, the way `support-widget.spec.ts` checks.
- [ ] **Step 5: Commit** `feat(support): overview page, inbox at /support/tickets`.

### Task 8: Knowledge overview redesign without the tab bar

**Files:**
- Modify: `apps/web/src/modules/knowledge/knowledge.tsx:78-135`:
  - Remove the `<Tabs>` row (lines 106-115).
  - Keep the head with the actions.
  - Sub-pages other than the overview get a back link "← Wissen" above the head.
- Create: `apps/web/src/modules/knowledge/overview.tsx`. Move `KnowledgeHealth impact={false}` out of the overview and into the `health` tab only.
- Create: `apps/web/src/modules/knowledge/home.tsx`, the compact card used in Task 15. Create it now so it shares the queries.
- Test: `apps/web/src/modules/knowledge/overview.test.tsx`

**Interfaces:**
- Consumes: `/knowledge-health` (fields `conflicts`, `staleSources`, `failedImports`), `/sources` (collection; fields `name`, `type`, `lastSuccessfulSyncAt`, `maxAgeHours`), `/facts?status=verified` count via the collection, and `/indexes` (owner only; ignore 403 and 404).
- Produces:
  - `sourceExpiry(source): { expiresAt: Date | null; state: "fresh" | "expiring" | "stale" }`, a pure export:
    - expiring within 48 h of `now`;
    - stale when `lastSuccessfulSyncAt` is null or past `lastSuccessfulSyncAt + maxAgeHours`.
  - `KnowledgeOverview()` per spec §5.3, with links to `hrefOf("knowledge-health")`, `knowledge-impact` and `knowledge-inspector`.

- [ ] **Step 1: Write the failing tests:**
  - "sourceExpiry": `maxAgeHours` 168 with a sync 7 days minus 1 h ago gives `expiring`; a sync 8 days ago gives `stale`; no sync gives `stale` with `expiresAt` null.
  - "sources sorted by expiry, stale first".
  - "no tab bar on the overview": no `role="tablist"`.
  - "a sub-page shows the back link".
- [ ] **Step 2: Run** `node ./node_modules/vitest/vitest.mjs run apps/web/src/modules/knowledge`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node ./node_modules/vitest/vitest.mjs run apps/web`. Expected: PASS. Run the existing knowledge e2e in `workspace.spec.ts` and replace tab clicks with sidebar links.
- [ ] **Step 5: Update `docs/IMPLEMENTATION_STATUS.md` (phase 2) and commit** `feat(knowledge): overview page without tab bar`. Open PR 2.

## Phase 3 — Attention (PR 3)

### Task 9: Platform attention contract and route

**Files:**
- Create: `apps/api/src/platform/attention/types.ts`, `apps/api/src/platform/attention/attention.ts`, `apps/api/src/platform/attention/routes.ts`
- Modify: `apps/api/src/platform/modules/contributions.ts`. Add `attention?: AttentionContribution` to `ModuleContributions` and `registeredAttention(): Array<[moduleId, AttentionContribution]>`.
- Modify: `apps/api/src/server.ts:426`. Register `registerAttentionRoutes(app, auth)` next to `registerNotificationRoutes(app, auth)`.
- Modify: `docs/API_CONTRACT.md`
- Test: `apps/api/tests/attention.integration.test.ts`

**Interfaces:**
- Produces, in `types.ts`, exactly as spec §4.1:
  - `AttentionSeverity`, `AttentionItem`, `AttentionResponse`;
  - `type AttentionContribution = (tx: DbTx, scope: Scope, now: Date) => Promise<AttentionItem[]>`.
- `attention.ts`:
  - `sortAttention(items: AttentionItem[]): AttentionItem[]`: sort by severity rank (critical 0, warning 1, info 2), then `dueAt` ascending with missing values last, then `since` ascending, then `id`.
  - `projectAttention(scope: Scope, now = new Date()): Promise<AttentionResponse>`:
    1. Open one `scoped()` transaction.
    2. Get `enabledModules`.
    3. For each registered contribution, skip modules that are not enabled or are in `hiddenModules(scope)`. Call it with `moduleScope(scope, id)`.
    4. Add the platform items. The hook is `platformAttention` from Task 12; until then return `[]`.
    5. Build `counts` per `navKey` before capping, then cap at 50.
    6. Build `status`. Task 12 fills it in; until then use `{ paused: <project paused flag> }`.
- Route: `GET /api/projects/:projectId/attention`, via `scopeFor`. It sets `reply.header("Cache-Control","no-store")`. Any project member may call it.

- [ ] **Step 1: Write the failing tests.** Register two test contributions (`fake-a`, `fake-b`) through the test-setup hook that `module-contributions.test.ts` uses.
  - "sorts critical before warning, then by dueAt".
  - "skips a disabled module": enforcement on, module off.
  - "skips a module with role none": `ORBIT_MODULE_ROLES=true`, override `none`.
  - "counts per navKey before the 50 cap": 60 items, `items.length` 50, `counts.x` 60.
  - "contribution receives the module scope": a viewer raised to editor sees `scope.role === "editor"`.
  - "answers no-store".
  - "a contribution that throws": the route fails with 500 and logs the module id. It does not hide the error. This is deliberate; document it in the code comment.
- [ ] **Step 2: Run** `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run apps/api/tests/attention.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file and `apps/api/tests/module-contributions.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): project attention endpoint`.

### Task 10: Support attention items

**Files:**
- Create: `apps/api/src/modules/support/attention.ts`
- Modify: the support contributions object in `apps/api/src/modules/registry.ts` (where support registers): add `attention: supportAttention`.
- Test: `apps/api/tests/attention-support.integration.test.ts`

**Interfaces:**
- Consumes: `slaDueAt`, `slaWhere`, `OPEN_STATUSES`, `SLA_ACTIVE_STATUSES`, `SLA_AT_RISK_MINUTES` (Task 6, `common.ts`).
- Produces: `supportAttention: AttentionContribution`. It emits these items:

  | kind | id | severity | navKey | link | params |
  |---|---|---|---|---|---|
  | `support_sla_breached` | `support:sla:<ticketId>` | critical | `support-tickets` | `/support/tickets?ticket=<id>` | `{ number, subject, channel, assigned: boolean }` |
  | `support_sla_at_risk` | `support:sla:<ticketId>` | warning | `support-tickets` | `/support/tickets?ticket=<id>` | same as above |
  | `support_unassigned` | `support:unassigned` | warning | `support-tickets` | `/support/tickets` | none |

  - Breached and at-risk each take at most 5 tickets, ordered by due time. Their `dueAt` is `slaDueAt`.
  - `support_unassigned` is aggregated: `count`, and `since` = the oldest `createdAt`. It is emitted only when the count is above 0.
- A member without `SUPPORT_TICKETS_READ` gets `[]`: check `can(scope, SUPPORT_TICKETS_READ)` (`apps/api/src/platform/tenancy/permissions.ts:44`) first. All queries use the scoped `tx` (RLS).

- [ ] **Step 1: Write the failing tests:**
  - "breached ticket is critical with dueAt".
  - "at-risk within 60 minutes is warning".
  - "unassigned aggregated with oldest since".
  - "at most five per SLA kind".
  - "merged and resolved tickets never appear".
  - "the counts agree with /support/summary": compare `breached` and `atRisk`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(support): attention items`.

### Task 11: Marketing attention items

**Files:**
- Create: `apps/api/src/modules/marketing/attention.ts`
- Create: `apps/api/src/modules/marketing/approval-state.ts`. It holds the server copies of `APPROVAL_STATUSES` and `isPausedPost(publication, now)`, so the web and the API share one status list: the web `approvalItems` and `pausedPosts` import their status constant from `packages/schemas`. Add `APPROVAL_STATUSES` there next to the content schemas, with the list from `apps/web/src/modules/marketing/draft-cleanup.ts:8-21`.
- Modify: the marketing contributions in `apps/api/src/modules/registry.ts`: `attention: marketingAttention`.
- Test: `apps/api/tests/attention-marketing.integration.test.ts`

**Interfaces:**
- Produces: `marketingAttention: AttentionContribution`. Kinds:
  - `marketing_draft_release`:
    - one per assignment draft awaiting the owner;
    - only while `agentsEnabled()`;
    - only for owners;
    - params `{ assignmentName, channelName, slotAt }`, `dueAt` = `slotAt`;
    - navKey `approvals`, link `/approvals`.
  - `marketing_content_review`: aggregated `count`, navKey `approvals`.
  - `marketing_exception`:
    - one per open exception code, `count` = the number of resources;
    - critical when the code ends in `_OUTCOME_UNKNOWN`;
    - params `{ code }`, navKey `approvals`.
  - `marketing_paused_posts`: aggregated, navKey `approvals`.
  - `marketing_run_problem`: from the agent-activity health issues `RUN_FAILED` and `BUDGET_EXHAUSTED`, critical, navKey `marketing-overview`, link `/marketing`.
- Reuse the queries behind `/assignment-drafts` and `/agent-activity` by calling their service functions. Do not call over HTTP.

- [ ] **Step 1: Write the failing tests:**
  - "an awaiting draft is a warning with slotAt" (agents on).
  - "no draft items while agents are off".
  - "OUTCOME_UNKNOWN exception is critical".
  - "content review aggregated by status list".
  - "a viewer gets no draft items".
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement.** Switch the web `draft-cleanup.ts` and `approval-lists.ts` to the shared constant, and keep their unit tests green.
- [ ] **Step 4: Run** the file and `node ./node_modules/vitest/vitest.mjs run apps/web/src/modules/marketing`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(marketing): attention items`.

### Task 12: Knowledge and platform items, status block

**Files:**
- Create: `apps/api/src/modules/knowledge/attention.ts`
- Create: `packages/knowledge/src/freshness.ts`. It holds `sourceExpiry`, the same rule as the web helper of Task 8. Re-export it, and make the web import it from the package so there is one implementation.
- Create: `apps/api/src/platform/attention/platform-items.ts`
- Modify: the knowledge contributions: `attention: knowledgeAttention`.
- Modify: `apps/api/src/platform/attention/attention.ts`. Call `platformAttention` and fill `status`.
- Test: `apps/api/tests/attention-knowledge-platform.integration.test.ts`

**Interfaces:**
- Produces:
  - `knowledgeAttention`:
    - `knowledge_source_stale`: critical, one per source, params `{ name }`, navKey `knowledge-sources`.
    - `knowledge_source_expiring`: warning, `dueAt` = expiry.
    - `knowledge_conflicts`: aggregated, navKey `knowledge-conflicts`.
    - `knowledge_import_failed`: aggregated, navKey `knowledge-import`.
  - `platformAttention(tx, scope, now): Promise<AttentionItem[]>`:
    - `platform_worker_down`: critical, when `runtimeHealth()` (`apps/api/src/modules/runtime.ts:37`) reports `worker !== "ready"`. navKey `operations`.
    - `platform_cost_unknown`: owner only. Reservations in state `unknown` since the start of the month; params `{ micros }`; navKey `operations`.
    - `platform_action_request`: owner only, aggregated over pending action requests, navKey `approvals`.
  - `status`:
    - `paused` from the project;
    - `mode` from the active marketing policy, only if marketing is enabled and visible;
    - `aiMonth`: `spentMicros` = settled reservations since the month start in the project timezone, `limitMicros` = the policy's monthly limit or `null`.

- [ ] **Step 1: Write the failing tests:**
  - "expiring within 48 h is a warning with dueAt".
  - "a never-synced source is stale".
  - "a viewer gets no cost or action-request items".
  - "worker down without heartbeat": no Redis beat.
  - "status.mode is absent when marketing is off".
  - "aiMonth counts only this month's settled reservations".
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file and all `attention*` tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): knowledge and platform attention, status`.

### Task 13: Web attention hook, renderers and badges

**Files:**
- Create: `apps/web/src/platform/shell/attention.tsx`. It holds `useAttention`, `renderAttention` and `GenericAttentionRow`. The types `AttentionItem` and `AttentionResponse` are hand-written in `apps/web/src/lib/api.ts` next to `Dashboard`, matching spec §4.1.
- Modify: `apps/web/src/platform/shell/types.ts`. Add `WebModule.attention?: Readonly<Record<string, AttentionRenderer>>`.
- Modify: `apps/web/src/platform/shell/shell-context.tsx`. Add `attention: { data?: AttentionResponse; error?: unknown; loading: boolean }`.
- Modify: `apps/web/src/components/orbit.tsx`:
  - Load the attention once per project with `?revision=`.
  - Refetch on a pathname change, at most every 30 s.
  - Pass `badges` (from `counts`, mapped from navKey to route key) to `SidebarNav`.
- Create: renderers in `apps/web/src/modules/{support,marketing,knowledge}/attention.tsx`, and platform renderers in `apps/web/src/modules/registry.ts`, for every kind of Tasks 10–12, in EN and DE.
- Test: `apps/web/src/platform/shell/attention.test.tsx`

**Interfaces:**
- Produces:
  - `type AttentionRenderer = (item: AttentionItem, locale: "en" | "de") => { title: string; detail?: string; action: Label }`.
  - `renderAttention(item, renderers, locale)`: uses the renderer for the item's kind, or the generic one (module display name and `kind`, action "Öffnen"/"Open").
  - `useAttention()`: reads it from the shell context.

- [ ] **Step 1: Write the failing tests:**
  - "an unknown kind uses the generic row".
  - "badges come from counts by navKey".
  - "a failed load gives no badges and does not throw": render `SidebarNav` with a context whose `error` is set.
  - "support renderer: breached ticket title 'SLA verletzt · #1042 <subject>'" for de.
- [ ] **Step 2: Run** `node ./node_modules/vitest/vitest.mjs run apps/web/src/platform/shell/attention.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node ./node_modules/vitest/vitest.mjs run apps/web` and `tsc`. Expected: PASS.
- [ ] **Step 5: Update `docs/API_CONTRACT.md` and `IMPLEMENTATION_STATUS.md` (phase 3), then commit** `feat(web): attention data, renderers and nav badges`. Open PR 3.

## Phase 4 — Home (PR 4)

### Task 14: New home layout

**Files:**
- Modify: `apps/web/src/platform/shell/home.tsx`:
  - Replace the tiles and the textarea prompt.
  - Keep `storeAssistantDraft`.
  - Remove `.module-tiles` usage. Delete the CSS at `globals.css:3896-3944` once unused.
- Create: `apps/web/src/platform/shell/attention-list.tsx`
- Modify: `apps/web/src/lib/i18n.ts`. Add keys for the greetings (`goodMorning` before 11:00, `goodDay` before 18:00, `goodEvening` otherwise), `attentionTitle`, `attentionCount` ("{n} Dinge brauchen dich heute"/"{n} things need you today"), `allClear`, `showAll` and `operationsLink`.
- Test: `apps/web/src/platform/shell/home.test.tsx`

**Interfaces:**
- Consumes: `useAttention()` (Task 13), `shell.homeSections`.
- Produces:
  - `greeting(date: Date, locale): string`.
  - `<AttentionList items max={8} />`. Each row has a module chip, title, detail, a pill and one link styled as a button. The pill shows the due time when `dueAt` is set (relative, "in 45 Min."), otherwise the age from `since`.
  - The status strip reads `status`. It shows "Pausiert" in the warning colours when `paused`; otherwise the mode and "KI-Budget <Monat>: x von y USD", with `—` for an unknown limit.

- [ ] **Step 1: Write the failing tests:**
  - "greeting by hour": 09:00 gives "Guten Morgen", 14:00 "Guten Tag", 20:00 "Guten Abend".
  - "shows at most 8 rows and 'Alle anzeigen' reveals the rest".
  - "empty list shows the all-clear text".
  - "error shows ResourceError, modules still render".
  - "no module tiles".
  - "prompt submit stores the draft and opens chat".
- [ ] **Step 2: Run** `node ./node_modules/vitest/vitest.mjs run apps/web/src/platform/shell/home.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): attention-first home`.

### Task 15: Compact module cards and system status

**Files:**
- Modify: `apps/web/src/modules/support/home.tsx`. Add the three latest open tickets (`/support/tickets?openOnly=true&limit=3`).
- Create: `apps/web/src/modules/marketing/home.tsx` (`MarketingHomeCard`). Change `manifest.tsx` to `home: MarketingHomeCard`. `MarketingOverview` is no longer embedded.
- Modify: `apps/web/src/modules/knowledge/manifest.tsx`. Add `home: KnowledgeHomeCard` (from Task 8) with `homeOrder: 20`.
- Create: `apps/web/src/platform/shell/system-status.tsx`. It is the platform card, rendered last by `home.tsx`.
- Modify: `apps/web/tests/workspace.spec.ts`. Cover the home sections and the module overviews reachable from the cards.
- Test: `apps/web/src/modules/marketing/home.test.tsx`, `apps/web/src/platform/shell/system-status.test.tsx`

**Interfaces:**
- `MarketingHomeCard`:
  - today's agent run from `/agent-activity`: state, finished and total steps, cost; hidden when that endpoint answers 404;
  - the next three posts (`/assignment-posts`, else publications);
  - counts of active missions and open approvals (approvals from `attention.counts.approvals`).
- `SystemStatusCard`:
  - worker state from `/operations` `runtime.worker`;
  - each connector's status from `connectorStates`;
  - the mailbox from the email connection when present;
  - the unknown-cost line from attention items of kind `platform_cost_unknown`.

- [ ] **Step 1: Write the failing tests:**
  - "marketing card hides the run without agents (404)".
  - "marketing card lists three posts by time".
  - "system status shows worker unavailable in the warning colour".
- [ ] **Step 2: Run** these tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node ./node_modules/vitest/vitest.mjs run apps/web` and `./node_modules/.bin/playwright test apps/web/tests/workspace.spec.ts apps/web/tests/navigation.spec.ts`. Expected: PASS.
- [ ] **Step 5: Update `docs/DESIGN_SYSTEM.md` (home composition) and `IMPLEMENTATION_STATUS.md` (phase 4), then commit** `feat(web): compact module cards on the home page`. Open PR 4.

## Phase 5 — Settings (PR 5)

### Task 16: Grouped settings with URL sections

**Files:**
- Modify: `apps/web/src/platform/shell/types.ts`. Add `SettingsSection.tab.group?: string`. A module's sections default to the module id; the shell sets this when it collects `settings`.
- Modify: `apps/web/src/components/management.tsx:439-640`:
  - The tabs become a grouped list.
  - The platform `policy` tab is split. `RetentionControl` becomes the platform section `retention` ("Aufbewahrung", group `project`, order 45). The marketing policy section keeps the key `policy` in group `marketing`.
  - The project tab's `ProjectAdministration` members part becomes the section `members` ("Mitglieder & Rollen", order 10).
- Create: `apps/web/src/platform/shell/settings-nav.tsx`
- Modify: `apps/web/src/platform/shell/shell-context.tsx`. Add `ShellModule.settingsSection?: string`. Modify `orbit.tsx` so that `buildNavGroups` callers set `NavGroup.settingsHref` to `/p/:id/settings?section=<key>`.
- Modify: `apps/web/src/platform/shell/sidebar-nav.tsx`. Render the subdued "Einstellungen" link from `settingsHref`.
- Test: `apps/web/src/platform/shell/settings-nav.test.tsx`

**Interfaces:**
- Produces:
  - `groupSettings(tabs: Array<{key; label; order; group}>, modules): Array<{ id; label: Label; tabs }>`, a pure function: `project` first, then modules in registry order, tabs by order.
  - `sectionFromSearch(search: string, available: string[]): string`: returns `?section=` when it is available, else `"project"`.
  - The page writes `?section=` with `history.replaceState` on change.
  - Below 760 px the list renders as a labelled `<select>`.

- [ ] **Step 1: Write the failing tests:**
  - "groups project first, then modules".
  - "an unknown section falls back to project".
  - "a hidden module's section is not offered": a module with access `none` contributes nothing, because the shell already filters it. Assert through `groupSettings` input.
  - "the sidebar group shows Einstellungen linking to ?section=policy for marketing".
  - "retention is its own project section".
- [ ] **Step 2: Run** `node ./node_modules/vitest/vitest.mjs run apps/web/src/platform/shell/settings-nav.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node ./node_modules/vitest/vitest.mjs run apps/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): settings grouped by module with URL sections`.

### Task 17: Settings e2e and final docs

**Files:**
- Modify: `apps/web/tests/workspace.spec.ts`. Add these tests:
  - "settings open by ?section";
  - "/settings without a section opens Projekt";
  - "legacy /settings still redirects".
- Modify: `docs/IMPLEMENTATION_STATUS.md` (phase 5, done), `docs/REQUIREMENTS_TRACEABILITY.md` (UI rows if listed), `docs/DESIGN_SYSTEM.md` (settings layout).

- [ ] **Step 1: Write the e2e tests.**
- [ ] **Step 2: Run** `./node_modules/.bin/playwright test apps/web/tests/workspace.spec.ts`. Expected: PASS.
- [ ] **Step 3: Run the full suite:**
  - `node ./node_modules/vitest/vitest.mjs run --exclude '**/*.integration.test.ts'`
  - `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run integration`
  - `./node_modules/.bin/tsc --noEmit`
  - `node scripts/source-check.mjs`

  Expected: PASS. Revert `evals/knowledge/last-deterministic-run.json` if a run touched it.
- [ ] **Step 4: Update the docs.**
- [ ] **Step 5: Commit** `docs: UI restructure complete`. Open PR 5.

# Orbit UI restructure — design

Status: approved direction (Mario, 2026-10-18, mockups on the design canvas "Orbit UI Restructure"). This spec turns the mockups into rules for the code. It builds on the modular web shell (WP1.7, WP2.3b, WP2.4, WP3.3, WP5.2) and ADR 0009.

## 1. Goal

The web UI follows the module structure that the platform already has:

- The **sidebar** groups its entries by module, with the project entries (connections, operations, settings) at the bottom. Groups can be collapsed.
- The **home page** shows only what matters now: what needs the member's attention across all modules, plus one compact card per module.
- **Every module has its own overview page** at its root URL.
- The **settings** are sorted into project-wide sections and one group per module.

Success: a member sees on the home page, without scrolling, every SLA-critical ticket, every post waiting for release and every source about to expire. Each module is reachable as one group in the sidebar. No page that exists today becomes unreachable, and every link stored before the change (notifications, Telegram, bookmarks) still opens the right page.

## 2. Decisions

| #   | Question                         | Decision                                                                                                                                                                                                                      |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | Sidebar order                    | Top: Start, Orbit Chat. Then "Module": one collapsible group per enabled module, ordered by `WebModule.groupOrder` (Marketing, Support, Wissen). Then "Projekt": Verbindungen, Betrieb, Einstellungen as a collapsible group. |
| U2  | Where "Freigaben" (approvals) is | In the Marketing group. The route stays a platform route at `/p/:id/approvals`; only its sidebar group changes.                                                                                                               |
| U3  | Group state                      | All groups open by default. The member can collapse any group; the group of the open page is always open. The collapsed groups are remembered per browser in `localStorage` (`orbit.nav.collapsed`).                          |
| U4  | Badges                           | An entry shows the number of its attention items. A collapsed group shows the sum of its entries. Badges come from the attention endpoint (U6), not from separate requests.                                                   |
| U5  | Home contents                    | Greeting, a one-line assistant prompt, a status strip, the attention list, then module cards. The module tiles, the readiness list and the recent jobs leave the home page.                                                   |
| U6  | Attention data                   | A new read-only platform endpoint `GET /api/projects/:id/attention`. Modules contribute items on the server (`ModuleContributions.attention`); the platform filters by module state and module role.                          |
| U7  | Module overviews                 | Marketing gets a root overview (today's `Overview`, extended). Support gets a new root overview; the ticket inbox moves to `/support/tickets`. The Knowledge overview is redesigned; its tab bar goes.                        |
| U8  | Settings                         | One settings page with a grouped section list (Projekt, then one group per module). The open section is in the URL as `?section=<key>`. Each module group in the sidebar ends with an "Einstellungen" link.                   |
| U9  | Mobile                           | The bottom bar shows four entries chosen by priority from the enabled ones (Start, Chat, Tickets, Freigaben, then Content, Wissen) plus "Mehr". The drawer shows the grouped sidebar.                                         |
| U10 | Feature flag                     | None. The change is UI plus one additive read-only endpoint; rollback is a revert and redeploy. Each phase ships as its own PR.                                                                                               |

## 3. Navigation model

### 3.1 Contract changes (`apps/web/src/platform/shell/types.ts`)

- `ViewDef.navGroup?: string`: the sidebar group of a page with a nav entry. Default: the module id for module pages, `"top"` for platform pages. Allowed values: `"top"`, `"project"` or a module id. `routeTable` rejects other values (`WEB_ROUTES_INVALID`) and a module page whose group is not its own module.
- `WebModule.groupOrder?: number` orders the module groups (marketing 10, support 20, knowledge 30).
- `NavEntry.mobile` keeps its meaning; `NavEntry.mobileRank?: number` orders the candidates for the bottom bar (lower first). The shell shows the first four enabled candidates.

### 3.2 Registry changes

| View                                                           | Change                                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `home`, `chat`                                                 | group `top`; mobile ranks 0 and 10                                                           |
| `approvals`                                                    | `navGroup: "marketing"`, order between calendar and assets; mobile rank 30                   |
| `connectors`, `operations`, `settings`                         | `navGroup: "project"`                                                                        |
| marketing `marketing-overview` (new)                           | path `""`, label Übersicht/Overview, order 0 within the group, component `MarketingOverview` |
| marketing `missions` … `memory`                                | unchanged paths; `content` mobile rank 40                                                    |
| support `support` (root)                                       | now `SupportOverview`, label Übersicht/Overview                                              |
| support `support-tickets` (new key)                            | path `tickets`, component `SupportInbox`, label Tickets, mobile rank 20                      |
| support `support-contacts`, `-stats`                           | get nav entries (Kontakte, Statistik) instead of `navKey`                                    |
| knowledge `knowledge` (root)                                   | label Übersicht/Overview; component redesigned (section 5.3)                                 |
| knowledge `sources`, `facts`, `conflicts`, `import`, `library` | get nav entries; mobile rank 50 on `knowledge`                                               |
| knowledge `health`, `impact`, `inspector`                      | stay URL-only with `navKey: "knowledge"`, linked from the overview                           |

Group labels are the module's `displayName`; `top` has no label, `project` is labelled Projekt/Project. Within a group, entries sort by `nav.order`.

### 3.3 Sidebar component

The flat `<nav>` in `components/orbit.tsx` is replaced by `platform/shell/sidebar-nav.tsx`:

- `buildNavGroups(routes, modules, enabled)`: a pure function returning `[{ id, label, entries, settingsHref? }]` in the order of U1, leaving out disabled modules and modules with access `none`. Unit-tested.
- Each group header is a `<button aria-expanded aria-controls>`; the entries are a list below it. Collapsing never hides the active entry's group (U3).
- Badges: `useAttention()` (section 4.4) gives counts per `navKey`; the group header shows the sum while collapsed. Badge text has an accessible label ("3 offen").
- The drawer (≤760 px) renders the same component; the focus trap stays as it is.
- The organisation link and the footer stay; the project `<select>` stays (a custom switcher is out of scope).

### 3.4 Module settings links

`ShellModule` gains `settingsSection?: string`, the key of the module's first settings section. When set, the group ends with a subdued "Einstellungen" entry linking to `/p/:id/settings?section=<key>`. It is not a route and has no badge.

## 4. Attention endpoint

### 4.1 Contract (`apps/api/src/platform/attention/`)

```ts
type AttentionSeverity = "critical" | "warning" | "info";
type AttentionItem = {
  id: string; // stable per object, e.g. "support:sla:<ticketId>"
  moduleId: string; // owning module, or "platform"
  kind: string; // e.g. "support_sla_at_risk"; the web renders the text
  severity: AttentionSeverity;
  count?: number; // for aggregated items ("2 unassigned tickets")
  dueAt?: string; // ISO time the item becomes worse or expires
  since?: string; // ISO time the item started waiting
  params: Record<string, string | number | boolean>; // ids, subjects, channel names
  navKey: string; // web nav entry the item belongs to (for badges)
  link: string; // in-app path below /p/:id, e.g. "/support/tickets?ticket=<id>"
};
type AttentionResponse = {
  items: AttentionItem[]; // sorted, at most 50
  counts: Record<string, number>; // per navKey, over all items before the cap
  status: {
    paused: boolean;
    mode?: string;
    aiMonth?: { spentMicros: number; limitMicros: number | null };
  };
};
```

`ModuleContributions.attention?: (tx, scope) => Promise<AttentionItem[]>`. The platform route:

1. resolves the member scope (`scopeFor`), computes `enabledModules` and `hiddenModules`;
2. calls each enabled, visible module's contribution inside one project transaction, each with `moduleScope(scope, id)` (a contribution may also drop owner-only items for non-owners);
3. adds the platform's own items (4.2), sorts by severity, then `dueAt` ascending, then `since` ascending, and caps at 50.

The route is read-only, writes no audit row and carries no message text beyond what the member may already read (subjects and titles they can open). Nothing is logged except counts. The response is never cached by the proxy (`Cache-Control: no-store`, as the other project reads).

### 4.2 Items per owner (version 1)

| Owner     | Kind                        | Severity                                  | Source                                                                                                                   |
| --------- | --------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| support   | `support_sla_breached`      | critical                                  | open tickets past `firstResponseDueAt`/`resolutionDueAt` (same rules as `ticketSummary`), one item per ticket, at most 5 |
| support   | `support_sla_at_risk`       | warning                                   | due within `SLA_AT_RISK_MINUTES`, one per ticket, at most 5                                                              |
| support   | `support_unassigned`        | warning                                   | open, unassigned, not merged; one aggregated item with `count` and the oldest `since`                                    |
| marketing | `marketing_draft_release`   | warning                                   | assignment drafts awaiting the owner (only while Orbit Agents is on), one per draft                                      |
| marketing | `marketing_content_review`  | warning                                   | content in the approval statuses of `approvalItems`, aggregated                                                          |
| marketing | `marketing_exception`       | warning, critical for `*_OUTCOME_UNKNOWN` | open exceptions, one per code with `count`                                                                               |
| marketing | `marketing_paused_posts`    | warning                                   | future posts held by `PROJECT_PAUSED`, aggregated                                                                        |
| marketing | `marketing_run_problem`     | critical                                  | agent-activity health issues `RUN_FAILED`, `BUDGET_EXHAUSTED`                                                            |
| knowledge | `knowledge_source_stale`    | critical                                  | sources past `lastSuccessfulSyncAt + maxAgeHours`                                                                        |
| knowledge | `knowledge_source_expiring` | warning                                   | sources that pass that time within 48 h; `dueAt` = expiry                                                                |
| knowledge | `knowledge_conflicts`       | warning                                   | facts with status `conflicting`, aggregated                                                                              |
| knowledge | `knowledge_import_failed`   | warning                                   | failed `ingestion` jobs, aggregated                                                                                      |
| platform  | `platform_worker_down`      | critical                                  | no worker heartbeat within 30 s                                                                                          |
| platform  | `platform_cost_unknown`     | warning                                   | AI reservations in state `unknown` this month (owner only)                                                               |

Action requests (owner only) are counted into `approvals` as `platform_action_request`, warning, aggregated.

Shared queries move next to their current users so the summary, the inbox and the attention items cannot drift: `ticketSummary` and the attention items share one SLA predicate; marketing reuses `approvalItems`/`openExceptions` logic on the server (moved from the web to `modules/marketing` where needed).

### 4.3 Web rendering

`WebModule.attention?: Record<kind, (item, locale) => { title: string; detail?: string; action: Label }>` renders an item. Unknown kinds fall back to a generic row (module name, `kind`, link) so a newer API never breaks an older web build. The platform registers its own renderers in `modules/registry.ts`.

### 4.4 `useAttention()`

One `useResource` on `/projects/:id/attention?revision=` in the shell, shared by the sidebar and the home page through `ShellContext`. It refetches on the workspace revision and when the pathname changes, at most every 30 s. A failed load hides badges and shows an error row on the home page; it never blocks navigation.

## 5. Pages

### 5.1 Home (`platform/shell/home.tsx`)

Top to bottom, max width 1180 px:

1. **Head**: "Guten Morgen/Tag/Abend, <first name>" by local time (first word of `identity.user.name`; without a name only the greeting); subtitle with the date and "N Dinge brauchen dich heute" (N = items with severity critical or warning).
2. **Assistant prompt**: a single-line input with a send button; same behaviour as today (`storeAssistantDraft`, then the chat).
3. **Status strip**: paused or active, the marketing mode if marketing is enabled, the AI budget of the month if known, a link to Betrieb. Data: `status` of the attention response.
4. **Braucht deine Aufmerksamkeit**: the attention items, at most 8 with "Alle anzeigen". Each row: module chip, title, detail, a due or age pill, one action button linking to `link`. Empty state: "Nichts offen. Alles erledigt."
5. **Module cards**: the enabled modules' `home` components in a responsive grid (`minmax(360px, 1fr)`), ordered by `homeOrder`, followed by the platform's system status card.

### 5.2 Module home cards

| Card                    | Content                                                                                                                                   | Data                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Support                 | four counts (open, unassigned, at risk, breached), the three most recently updated open tickets, link to overview                         | `/support/summary`, `/support/tickets?openOnly=true&limit=3` |
| Marketing               | the current agent run (state, steps done, cost) if Orbit Agents is on; the next three posts; counts of active missions and open approvals | `/agent-activity`, `/assignment-posts`, attention counts     |
| Wissen (new)            | sources, verified facts, conflicts; the active index generation                                                                           | `/knowledge-health`, `/indexes` (owner only, else left out)  |
| Systemstatus (platform) | worker, connected channels, mailbox, unknown-outcome cost                                                                                 | `/operations`, attention `status`                            |

The full marketing `Overview` is no longer embedded on the home page.

### 5.3 Module overviews

- **Marketing** (`/p/:id/marketing`): today's `Overview` moved to `modules/marketing/overview.tsx` with its head ("Modul" eyebrow, Marketing, actions "Content erstellen" and "Neue Mission"), the mode band, four metrics (active missions, open approvals, published in 7 days, AI budget of the month), the agent run of today, the next seven days of posts, missions and readiness. The recent jobs list moves to Betrieb only.
- **Support** (`/p/:id/support`): five metrics (open, unassigned, at risk, breached from `/support/summary`; median first response of the last 14 days from `/support/stats`), open tickets ordered by due time (`/support/tickets?sort=sla&limit=5`, section 6), the inboxes with their open counts, new tickets per day for 14 days (`volume.byDay`, section 6) and "Meine Tickets" (`view=mine&openOnly=true&limit=5`). A request to `/p/:id/support?ticket=<id>` redirects to `/p/:id/support/tickets?ticket=<id>`, so every notification link, stored or new, keeps working (section 6).
- **Wissen** (`/p/:id/knowledge`): four metrics (sources, verified facts, conflicts, index generation), source freshness sorted by expiry, index quality of the active generation (owners), the open conflicts, and links to Health, Impact and Inspector. The tab bar is removed; the sidebar entries replace it, and the remaining sub-pages show a back link to the overview.

### 5.4 Settings (`components/management.tsx`)

- The tabs become a grouped section list (left column on desktop, a `<select>` above the content below 760 px).
- Groups: **Projekt** (Projekt, Mitglieder & Rollen, Module, Integrationen, Aufbewahrung, Verbundene Apps) and one group per module with sections (Marketing: Richtlinie & Budget, Marke, Aufträge; Support: its sections).
- `SettingsSection.tab` gains `group?: string`; a module's sections default to the module's group. The platform `policy` tab is split: the marketing policy section joins the Marketing group as "Richtlinie & Budget", and `RetentionControl` becomes the platform section "Aufbewahrung".
- The selected section is read from and written to `?section=` (`history.replaceState`); an unknown or hidden section falls back to `project`.

### 5.5 Breadcrumb

`crumbs()` returns `[group label, page label]` for grouped pages ("Marketing / Übersicht", "Support / Tickets"); platform top pages keep a single crumb.

## 6. API changes

All additive; no migration, no new permission, no new dependency.

- `GET /api/projects/:id/attention` (section 4).
- `GET /support/tickets` accepts `sort=updated|sla` (default `updated`) and `openOnly=true|false` (default `false`, restricts to `OPEN_STATUSES`, excludes merged tickets). `sort=sla` implies the SLA-active statuses and orders by the earlier open due time (`firstResponseDueAt` while not responded, else `resolutionDueAt`), nulls last; the cursor then encodes that order.
- `GET /support/stats` adds `volume.byDay`: tickets created per calendar day in the project's timezone, `{ "YYYY-MM-DD": count }`, zero days included.
- Support notification links stay `/p/:id/support?ticket=<id>` (`automations.ts:86`); the web redirect (5.3) forwards them. This keeps old and new links valid and makes a revert safe.
- `docs/API_CONTRACT.md` documents all three.

## 7. Error, empty and loading states

Every new card has the existing loading (`Skeleton`), empty (`Empty`) and error (`ResourceError`) states. A module card whose data endpoint answers 404 (module or flag off) renders nothing. Unknown values show "—", as the design system requires; no number is invented.

## 8. Accessibility

Group headers are buttons with `aria-expanded` and `aria-controls`; badges have text alternatives; the attention list is a list with one link or button per row; the settings section list is a `nav` with `aria-current`. Keyboard: Tab order follows the visual order; Enter/Space toggles a group. `prefers-reduced-motion` disables the chevron rotation.

## 9. Testing

- Unit (Vitest, web): `buildNavGroups` (order, groups, disabled and `none` modules, approvals in marketing, settings link), `routeTable` validation of `navGroup`, mobile selection, `crumbs`, attention sorting and the generic fallback renderer, the support `?ticket` redirect, settings `?section` fallback.
- Integration (API): the attention route per owner with fixtures, module disabled, module role `none`, viewer vs owner (owner-only items), the 50-item cap and `counts`; `/support/tickets` with `sort=sla` and `openOnly`; `/support/stats` `volume.byDay`.
- E2E (Playwright, `apps/web/tests`): `navigation.spec.ts` (groups, collapse persists across reload, active group stays open, drawer on mobile), `workspace.spec.ts` (home sections, module overviews reachable, settings sections by URL).
- Existing pins to update: `routes.test.tsx` nav order, `shell.test.tsx`, the post-deploy check in `IMPLEMENTATION_STATUS.md` (line 739).

## 10. Risk, rollout, rollback

- Risk class **medium**: broad UI change and one new read-only endpoint that must respect module state and module roles. No schema change, no auth change, no external provider.
- Environment: local and worktree test database for development; each PR's merge is a production deploy and needs Mario's approval as usual.
- Rollout in five PRs (the implementation plan's phases): navigation; module overviews and the tickets path; attention endpoint and badges; home; settings.
- Rollback: revert the PR and redeploy. The endpoint and the new query parameters are additive; support notification links do not change (section 6).
- Docs to update: `docs/DESIGN_SYSTEM.md` (navigation, home composition, `localStorage` keys), `docs/IMPLEMENTATION_STATUS.md`, `docs/API_CONTRACT.md`, `docs/SUPPORT.md` (inbox URL).

## 11. Out of scope

A collapsed icon-only rail, a custom project switcher, drag-and-drop ordering of groups, per-member choice of home cards, realtime push of attention items, an organisation-wide home across projects, and new module content (projects or meetings modules).

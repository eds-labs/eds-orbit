# Social S6 — Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Social → Calendar shows the project's posts by month, week (30-minute rows in the project's time zone) and as a list, filtered by account, platform, status and origin, optionally across all projects of the organization; a post can be moved by drag and drop or the keyboard ("Move to…"), with the approval rules of S-D6, and opens in a preview drawer.

**Architecture:** Two read endpoints (`GET /calendar` per project, `GET /api/organizations/:workspaceId/social/calendar` across the member's projects) return the posts timed in a range of at most 62 days with their accounts, approval and publication summary; the list view pages through the existing `GET /posts` with the same filters. All calendar arithmetic (month cells, week slots across DST, placement, drop → reschedule body) is pure code in `apps/web/src/modules/social/calendar/` and tested without a browser; the views render it; moving calls the S4 `reschedule` route. No new dependency: `@dnd-kit` is already approved (ADR 0016 D-10).

**Tech Stack:** TypeScript, Fastify 5, Prisma 7, Next.js 16, `@dnd-kit/core` 6.3.1, Vitest, Playwright 1.63.

**Spec:** [`2026-11-02-social-module.md`](2026-11-02-social-module.md) (§1 R3; §3 S-D6, S-D8; §6.2 `GET /calendar`, org calendar; §10 S6) and [ADR 0020](../../adr/0020-social-module.md). Stacked on S5 (`claude/social-s5`, PR #187).

## Findings this plan relies on (verified 2026-11-03)

| Topic | Fact | Source |
|---|---|---|
| Posts API | `listPosts(tx, scope, {status, from, to, cursor, limit ≤ 50})`, newest change first, range ≤ 62 days on `scheduledAt`; `PostListItem {id, status, title, excerpt, schedule, approvalState, accounts, version, updatedAt}` | `modules/social/posts/posts.ts` |
| Reschedule | `POST /posts/:id/reschedule {version, local\|at, timeZone?, fold?, reapprove?}`; draft → time only; approved/waiting → editor: new request, owner: 409 `SOCIAL_REAPPROVAL_REQUIRED` unless `reapprove`; gap/ambiguous errors carry `error.detail`; `SOCIAL_VERSION_CONFLICT` | `posts/approval.ts`, S4 |
| Web helpers | `socialSend` keeps `error.detail`; `scheduleErrorView(code, detail, local, locale)` gives gap/ambiguous choices; `Preview`, `Publications`, `Modal`, `Tabs` exist | `apps/web/src/modules/social/{api.ts, posts/*}` |
| DnD | `@dnd-kit/core` 6.3.1 with Pointer, Touch and Keyboard sensors and a "Move" menu per card in the work board | `apps/web/src/modules/work/board.tsx:5-254` |
| Views | One path segment per view; query parameters for state; static render tests (`renderToStaticMarkup`) plus pure-function tests; web tests must be `*.test.tsx` | `platform/shell/types.ts`, S4 ruling |
| Organization pages | The shell knows `/o/:id` and `/o/:id/settings` only; module pages exist only under `/p/:projectId/…` | `platform/shell/routes.ts:181-216` |
| Organization routes | API routes under `/api/organizations/:workspaceId` exist (administration); project scopes come from `scopeFor(auth, req, projectId, permission)` | `platform/administration/routes.ts:202`, `platform/tenancy/auth.ts` |
| E2E | Playwright 1.63, specs gated by env (`E2E_WORK=1` …), sign-in helper per spec, seed `scripts/seed-e2e.ts`, `.runtime/e2e-user.json` | `apps/web/tests/work.spec.ts` |
| Accessibility tooling | No `@axe-core/playwright` (or any axe package) in the repository | `package.json`, `apps/web/package.json` |
| Legacy mirror | `origin = legacy_postiz` posts are `readOnly`; none exist before S10 | migration `202611020001_social_core` |

## Global Constraints

- Branch `claude/social-s6` in `.claude/worktrees/social-s6`, stacked on `claude/social-s5`; push only on Mario's request. Install and create the worktree test DB before Task 1.
- No migration, no new dependency (axe stays out unless Mario approves it; see Ruling 2), no new installation switch.
- Read endpoints only; moving a post goes through the S4 `reschedule` route and its rules (S-D6).
- Calendar times are shown in the **project's** time zone; a post scheduled in another zone shows its own zone in the drawer.
- At most 62 days per calendar request; the list view pages 50 at a time.
- Read-only posts (`legacy_postiz`), posts being published or finished, and other projects' posts in the organization scope cannot be moved.
- Code and docs English; UI `en` + `de`; flags stay off.

## Review Focus

1. **A post dropped into a DST gap or the repeated autumn hour, or onto a time less than two minutes ahead.** Expect the server's message with the suggested time or the earlier/later choice, nothing moved until the person chooses.
2. **A stale calendar** (another person moved or edited the post since it loaded). Expect `SOCIAL_VERSION_CONFLICT` → a notice and a reload, never a silent overwrite.
3. **Moving an approved post** as owner (confirmation, then re-approval) and as editor (confirmation that it goes back to approval). Expect no move without the confirmation.
4. **Week view on the DST change days** (2027-03-28 and 2026-10-25 in Europe/Berlin; 2027-03-14 in America/New_York). Expect 46 or 50 half-hour rows, each post in the row of its local time, no post shown twice or lost.
5. **The organization scope:** posts of projects where the member has no social access, the module is off, or another organization. Expect them absent, never an error that names them.

Each line has its test in Tasks 1–5.

---

### Task 1: Project calendar endpoint and list filters

**Files:** Create `apps/api/src/modules/social/calendar/calendar.ts`; modify `posts/posts.ts` (`listPosts` filters), `posts/routes.ts`; test `apps/api/tests/social-calendar.integration.test.ts`; access matrix, OpenAPI.

**Interfaces — produces:**
```ts
export type CalendarItem = {
  id: string; projectId: string; title: string | null; excerpt: string; status: string; origin: string; readOnly: boolean;
  schedule: PostView["schedule"]; approvalState: ApprovalState; version: number;
  accounts: Array<{ accountId: string; platform: SocialPlatform; handle: string }>;
  publications: { total: number; published: number; failed: number; unknown: number; test: boolean };
};
export type CalendarFilter = { from: string; to: string; accountIds?: string[]; platforms?: SocialPlatform[]; statuses?: string[]; origins?: string[] };
export async function calendarItems(tx: DbTx, scope: Scope, raw: unknown): Promise<{ items: CalendarItem[]; truncated: boolean }>;
// query: from, to (ISO with offset, to > from, ≤ 62 days) and csv filters; posts with scheduledAt in [from, to) (mode "at"),
// archived excluded unless statuses names it; ordered by scheduledAt, id; at most 500 (truncated true beyond)
// listPosts gains the same accountIds / platforms / origins filters
```
Route `GET /api/projects/:projectId/social/calendar` (`social.read`). Filters on accounts and platforms match posts with at least one such variant. `publications` counts per post (`test` true when every publication is a test publication).

- [ ] **Step 1: Failing tests:** posts at 3 times across two months; a range of one month returns only its posts in time order with accounts, approval state and a publication summary; `platforms=x` keeps only posts with an X variant; `origins=manual`, `statuses=draft,scheduled`; unplanned drafts (no time) are absent; 63 days → 422 `SOCIAL_RANGE_TOO_LARGE`; `to <= from` → 422 `SOCIAL_RANGE_INVALID`; 501 posts → 500 and `truncated: true`; viewer reads, another project's member gets 404; a project whose Marketing module is off works (R3); `listPosts({platforms: "telegram"})` filters the list the same way.
- [ ] **Step 2: Run** `…/t apps/api/tests/social-calendar.integration.test.ts` — Expected: FAIL. **Step 3: Implement** (update the access matrix and OpenAPI). **Step 4: Run** it and `access-matrix` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): calendar endpoint and post filters`.

### Task 2: Organization calendar endpoint

**Files:** Modify `calendar/calendar.ts`, `apps/api/src/modules/social/routes.ts` (or a module route outside the project prefix); test `apps/api/tests/social-calendar-org.integration.test.ts`; access matrix.

**Interfaces — produces:**
```ts
export async function organizationCalendar(auth: Auth, req: FastifyRequest, workspaceId: string, raw: unknown):
  Promise<{ items: Array<CalendarItem & { projectName: string }>; projects: Array<{ id: string; name: string }>; truncated: boolean }>;
// raw adds projectIds?: csv; projects = those of the workspace where the member's effective role in "social" grants social.read
// AND the module is enabled (ORBIT_SOCIAL + ProjectModule row); each read runs in that project's scoped transaction
```
Route `GET /api/organizations/:workspaceId/social/calendar` (session; 404 `NOT_FOUND` for a workspace the member does not belong to; 404 `SOCIAL_DISABLED` when `ORBIT_SOCIAL` is off). At most 20 projects per request (`projectIds` picks; `projects` lists all eligible); 500 items in total.

- [ ] **Step 1: Failing tests:** a member of two projects with social on sees both projects' posts with `projectName`; a third project of the same workspace where the member is not a member, one with the module off and one where the member's social module role is `none` are absent from `items` and `projects`; another workspace → 404; `projectIds` narrows; the response never contains a project id the member cannot read.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): organization calendar across the member's projects`.

### Task 3: Calendar arithmetic (pure)

**Files:** Create `apps/web/src/modules/social/calendar/{grid.ts, query.ts, move.ts}`; tests `calendar/grid.test.tsx`, `calendar/query.test.tsx`, `calendar/move.test.tsx`.

**Interfaces — produces:**
```ts
// grid.ts — all in the given IANA zone
export type DayCell = { date: string /* YYYY-MM-DD */; inMonth: boolean; isToday: boolean };
export function monthCells(month: string /* YYYY-MM */, timeZone: string, today: Date, weekStartsOn: 1 | 0 = 1): DayCell[]; // whole weeks: 28, 35 or 42 cells
export type Slot = { local: string /* YYYY-MM-DDTHH:MM */; at: string /* ISO */; label: string; repeated: boolean };
export function daySlots(date: string, timeZone: string): Slot[];   // 48 normally, 46 on a spring-forward day, 50 on fall-back
export function weekDays(anchor: string, weekStartsOn: 1 | 0 = 1): string[]; // 7 dates
export function placeByDay(items: CalendarItem[], timeZone: string): Map<string, CalendarItem[]>;   // by local date, time-ordered
export function placeBySlot(items: CalendarItem[], timeZone: string): Map<string, CalendarItem[]>;  // by slot key = ISO instant of the slot start
export function rangeOf(view: "month" | "week", anchor: string, timeZone: string): { from: string; to: string }; // ISO instants
// query.ts
export type CalendarState = { view: "month" | "week" | "list"; anchor: string; scope: "project" | "organization"; accountIds: string[]; platforms: string[]; statuses: string[]; origins: string[]; projectIds: string[] };
export function stateFromSearch(search: URLSearchParams, today: string): CalendarState;
export function searchFromState(state: CalendarState): string;      // stable order, defaults omitted
export function apiQuery(state: CalendarState, range: { from: string; to: string }): string;
// move.ts
export type MoveCheck = { kind: "free" } | { kind: "reapprove" } | { kind: "request" } | { kind: "forbidden"; reason: string };
export function moveCheck(item: CalendarItem, role: "owner" | "editor" | "viewer", scope: "project" | "organization"): MoveCheck;
export function dropLocal(item: CalendarItem, target: { date: string; time?: string }, timeZone: string): string; // month drop keeps the item's local time of day
export function rescheduleBody(item: CalendarItem, local: string, timeZone: string, opts: { reapprove?: boolean; fold?: "earlier" | "later" }): Record<string, unknown>;
```
`daySlots`: step through the day's instants every 30 minutes from local midnight's instant to the next local midnight's instant (`resolveLocalTime`-equivalent logic with `Intl`), label `HH:MM` in the zone; on fall-back the second occurrence has `repeated: true` (label suffix by the UI). `moveCheck`: readOnly, other-project items in the organization scope, statuses other than `draft|needs_approval|scheduled|approved` → `forbidden`; viewer → forbidden; draft → free; owner with `needs_approval|scheduled|approved` → reapprove; editor → request.

- [ ] **Step 1: Failing tests:** `monthCells("2026-11", "Europe/Berlin", …)` → 42 cells from 2026-10-26 to 2026-12-06 (Monday start; November 2026 starts on a Sunday), today marked; February 2027 → 28 cells (2027-02-01 to 2027-02-28); `daySlots("2027-03-28","Europe/Berlin")` → 46 slots, `01:30` followed by `03:00`; `daySlots("2026-10-25","Europe/Berlin")` → 50 slots with two `02:00` and two `02:30`, the second `repeated: true`; New York 2027-03-14 → 46; an ordinary day → 48; `placeBySlot` puts an item at 2026-10-25T00:30Z and one at 01:30Z into the two different `02:30` slots; `rangeOf("week", "2026-11-04", "Europe/Berlin")` → Monday 2026-11-02 00:00 local to the next Monday; `stateFromSearch` ignores unknown values and defaults to month/today/project; `searchFromState(stateFromSearch(x))` is stable; `moveCheck` table (owner/editor/viewer × statuses × scope × readOnly); `dropLocal` of a 10:15 post onto 2026-11-20 → `2026-11-20T10:15`; week drop onto a slot → that slot's `local`; `rescheduleBody` includes `version`, `local`, `timeZone`, and `reapprove` only when asked.
- [ ] **Step 2: Run** `…/t apps/web/src/modules/social/calendar` — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): calendar grid, query and move rules`.

### Task 4: Calendar views, filters and preview drawer

**Files:** Create `apps/web/src/modules/social/calendar/{calendar-view.tsx, month.tsx, week.tsx, list.tsx, filters.tsx, drawer.tsx}`; modify `manifest.tsx` (`social.calendar` → `CalendarView`), `api.ts` (types), `labels.ts` (`calendar` section); test `calendar/calendar.test.tsx`.

Behaviour: header with view tabs (Month, Week, List), previous/today/next, the range label, a scope switch (This project / All projects — only when the member has more than one project in the organization) and filters (accounts, platforms, statuses, origins; projects in the organization scope) as labelled checkbox groups in a disclosure; state in the URL (`searchFromState`). Month: `role="grid"` with column headers (weekday names) and one `gridcell` per day listing up to 3 posts (time, platform badges, title or excerpt, status badge; `outcome_unknown`, legacy and test markers) and "+N more" opening the day in the week view. Week: time column plus 7 day columns of the zone's `daySlots`; posts in their slot; a repeated hour labelled "(2nd)". List: the posts of `GET /posts` with the same filters, 50 per page with "Load more". Every post is a button opening the drawer (`Modal` as side panel): title, local time with zone (and the post's own zone when different), status, approval, per-account `Preview`, the S5 `Publications`, "Open in editor" link (`posts?post=`), "Move to…" (Task 5). Loading skeleton, error with retry, empty text per view. The organization scope shows the project name on each post and opens other projects' posts read-only (link to that project's editor).

- [ ] **Step 1: Failing tests (static render):** month grid for 2026-11 with two posts shows `role="grid"`, 7 `columnheader`s, the posts in their days with time and status, today marked `aria-current="date"`; week of 2026-10-25 in Europe/Berlin shows 50 rows and a post in the second 02:30 row labelled "(2nd)"; list shows "Load more" when `nextCursor`; filters are checkboxes with labels and the selected ones checked from the URL; viewer sees no "Move to…"; organization scope shows project names; empty month shows the empty text; `de` texts present; every button named.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement** (read the relevant Next 16 docs for any API used; reuse `useResource`, `Tabs`, `Modal`, `Badge`). **Step 4: Run** it and the web typecheck — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): calendar month, week and list views with filters and preview`.

### Task 5: Moving posts — drag and drop and "Move to…"

**Files:** Create `apps/web/src/modules/social/calendar/{dnd.tsx, move-dialog.tsx}`; modify `month.tsx`, `week.tsx`, `drawer.tsx`; test `calendar/move-dialog.test.tsx` (static + pure), extend `move.test.tsx`.

Behaviour: `DndContext` with Pointer (distance 6), Touch (delay 200) and Keyboard sensors as in the work board; posts with `moveCheck` ≠ forbidden are draggable, days (month) and slots (week) are droppable; screen-reader announcements in `en`/`de`. A drop or "Move to…" (a dialog with date and time fields labelled with the project zone, the same `ScheduleField` choices for gap/ambiguous) leads to: free → reschedule at once; reapprove → confirmation "Moving an approved post approves the new time" (owner) then `reapprove: true`; request → confirmation "The post goes back to approval" (editor). Errors: gap/ambiguous → the dialog with the server's choices; `SOCIAL_VERSION_CONFLICT` → notice "Someone changed this post" and reload; other codes through `postMessage`. After success the calendar reloads and announces the new time.

- [ ] **Step 1: Failing tests:** `moveFlow(check, role)` (pure, in `move.ts`) returns the confirmation text key or none; static render of the dialog has labelled date and time inputs, the zone, and named buttons; a drag handle has `aria-roledescription` and an instruction; a forbidden post renders without drag attributes; an error view for `SOCIAL_SCHEDULE_TIME_AMBIGUOUS` shows the two choices; conflict code maps to the conflict notice.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** the web module tests and typecheck — Expected: PASS.
- [ ] **Step 5: Commit** `feat(social): move posts in the calendar by drag and drop or keyboard`.

### Task 6: End-to-end calendar flow

**Files:** Modify `scripts/seed-e2e.ts` (with `E2E_SOCIAL=1`: enable the social module in the e2e project and create one synthetic Telegram account row, `capability write_verified`, no secret needed in test mode); create `apps/web/tests/social-calendar.spec.ts`.

Flow (Playwright, `E2E_SOCIAL=1`, stack with `ORBIT_SOCIAL=true`, test mode): owner creates a post in the editor for the seeded account, schedules it two days ahead; the calendar week view shows it; keyboard only: focus the post, open "Move to…", enter a new time, confirm the re-approval → the post shows at the new time; an editor session moves it again → it shows "Waiting for approval"; the owner approves it in Decisions; the calendar shows it scheduled. A second test moves a post into 2027-03-28 02:30 (Europe/Berlin project) and checks the gap message offers 03:00.

- [ ] **Step 1:** Write the spec and the seed change.
- [ ] **Step 2:** Run against a local stack (`ORBIT_SOCIAL=true ORBIT_MODULES=true`, worktree's own `.runtime/local.env`, `seed-e2e`, `pnpm dev`, `E2E_SOCIAL=1 ./node_modules/.bin/playwright test apps/web/tests/social-calendar.spec.ts`) — Expected: PASS. If the local stack cannot be started in this environment, record the reason in the ledger and leave the spec gated; CI does not set `E2E_SOCIAL`.
- [ ] **Step 3: Commit** `test(social): calendar end-to-end flow`.

### Task 7: Docs and whole-branch verification

**Files:** `docs/SOCIAL.md` (calendar, organization scope, moving rules), `docs/API_CONTRACT.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md` (R3 complete).

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** `pnpm lint`, API and web typecheck, framework check, full `vitest run` into the workspace log — Expected: green; counts in the ledger; schema hash unchanged.
- [ ] **Step 3: Commit** `docs(social): S6 calendar`.

## Rulings recorded with this plan

1. **The organization calendar is a scope switch on the project's calendar page**, not a page under `/o/:id`: the shell has no module pages outside projects, and adding that is a platform change of its own. Other projects' posts are read-only there and link to their project. Cost if wrong: an organization-level entry point comes later.
2. **No axe in Playwright** (it would be a new dependency, `@axe-core/playwright`, needing approval): accessibility is checked by the static ARIA/label tests and a keyboard-only end-to-end move. Mario can approve the dependency for a later pass.
3. **The list view pages with "Load more" (50) instead of virtualisation** (no virtualisation library is installed); with 50 rows per page the DOM stays small.
4. **Unplanned drafts are not in the calendar** (they have no time); they stay in Social → Posts. Cost if wrong: a later "unplanned" side panel.

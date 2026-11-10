# Marketing, Social, AI budget and project UX consolidation (2026-11-10)

Source: the owner's task package `EDS-Orbit-Claude-Code-Aufgaben-2026-11-09.md` with eight FamilyPlan screenshots (09.11.2026). Base: `main` at `43bc4fdd`. Branch: `claude/eds-orbit-tasks-13129a`.

Goal: consolidate what exists, fix real defects, simplify the existing interface. No rewrite, no new provider, dependency or paid service, no schema migration. Nothing in this plan changes production: deploys, data corrections, flags and budget values are separate owner approvals (see "Production steps").

## Fixed constraints

- The two FamilyPlan posts of 09.11.2026 (Facebook and Instagram, 18:30 Europe/Berlin) were released by the owner through the Marketing owner release. A native `approvalState: none` is not evidence of unauthorized publishing. Marketing owner release and native Social approval stay separate paths; nothing is blocked retroactively.
- Postiz stays available for other projects; the migration is per project, history and rollback stay.
- `AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA` is an intentional privacy block (`customer_personal`, `financial` → OpenAI only). The allow-list is not widened and providers are never switched automatically (MODEL_ROUTING: an explicit route never falls back).
- Unknown provider usage is never settled automatically; `assistantPerUserMonthlyMicros` is never set automatically.
- Released content rows are never written (their package hash binds the content version); every new state is derived at read time.

## Findings (code, 2026-11-10)

| Package | Finding | Verdict |
| --- | --- | --- |
| WP1 | `readiness.ts` never reads `publishingBackend`; `PUBLISHER_WRITE_VERIFICATION_REQUIRED` is raised in every mode, `social:` channels always fail the channel check | confirmed |
| WP1 | `postiz_*` action readiness ignores the backend; draining is not reflected | confirmed |
| WP1 | Queue watch runs whenever a verified Postiz connector with channels exists; its notice closes only inside a check that ran, so a stopped watch leaves "1354×" open | confirmed (prod cause of the last failure: to verify read-only) |
| WP1 | MCP `marketing_project_status` lists only Postiz channels; strict output schema | confirmed |
| WP2 | Personal assistant: `POLICY_REQUIRED` when the org has no per-member cap; the panel ignores `capMicros: null`; cap 0 shows a project text | confirmed |
| WP2 | Org AI page: no project limits, assistant usage dropped by the web type, "off" banner wrong for the assistant cap, no origin | confirmed |
| WP2 | Operations "Reserved" sums reserved, in-flight and unknown over all months; "settle as charged" settles all unknown rows of the month in bulk without reason or per-row choice; stale in-flight rows look live | confirmed |
| WP2 | `AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA` is checked before reservation (nothing sent); shown as a raw code with "—"; likely Support triage/draft on a Claude route | confirmed / likely |
| WP3 | Approvals badge counts `reviewed` (released, scheduled, published) content; one row and one release item per channel; list and badge diverge | confirmed |
| WP3 | Cleanup exists (preview, undo, audit, server guards) but gives no per-item reasons | confirmed |
| WP3 | Social posts from Marketing carry `origin/originModule/originType/originId`, but the UI shows no origin | confirmed |
| WP3 | Content Studio shows raw `social:<uuid>` / Postiz ids and one row per channel | confirmed |
| WP4 | No cross-project read path found (Entity, SocialMediaAsset, File, SocialAccount all project-scoped under FORCE RLS) | confirmed |
| WP4 | "uLiquid images" in FamilyPlan: FamilyPlan-owned assignment banners generated before `0f61b24d` with the then hard-coded uLiquid style | likely (prove read-only) |
| WP4 | Disabled `@uliquid_test` / "uLiquid Desk": only creatable by a connect flow started in FamilyPlan; disabled accounts are listed inline (UI and MCP) | likely / confirmed |
| WP5 | Policy table reads a non-existent `status` field → `unknown`; the active record is `data.active` | confirmed |
| WP5 | Generic table headers and status badges are not localized | confirmed |
| WP5 | Marketing "Kalender" is a planning list next to the real Social calendar | confirmed |

## Packages, order and boundaries

Wave 1 runs in parallel in isolated worktrees; wave 2 starts after wave 1 is integrated; integration, review and checks happen centrally on this branch.

| Wave | Package | Scope (owner of the files) | Data/API/MCP | Risk |
| --- | --- | --- | --- | --- |
| 1 | WP1 P0 publishing backend | marketing readiness, action readiness, queue watch, social readiness helper, readiness admin, project status tool, `lib/readiness-text.ts` (new codes) | no migration; additive MCP fields; Postiz output unchanged | medium |
| 1 | WP2 P0 AI budget | assistant notices, org AI page, cost diagnosis (new read route), stricter owner settle action, data-class texts and route warning, operations band in `management.tsx` | no migration; one new GET route; settle action contract tightened | high (cost, authorization) |
| 1 | WP4 P1 media and accounts | social accounts (archived section, MCP `archivedAccounts`), brand asset library tiles in `advanced.tsx`, explicit `projectId` on RLS-only reads | no migration; additive fields | medium |
| 1 | WP5 P2 foundations | localized status and field labels, policy version table, policy editor, editorial plan rename, blocked periods, capability/blocker labels | no API change | low |
| 2 | WP3 P1 approvals | approval lanes and badge, per-item cleanup reasons, Social `originRef` and origin display, Content Studio grouping and channel names | additive read-only fields, one channel-list GET route | medium |
| 3 | Integration | merge, OpenAPI regeneration, lint, typecheck, full tests, build, browser checks DE/EN desktop/mobile, security and code review, docs | — | — |

Decisions taken inside the existing architecture:

- WP1: readiness mirrors what preflight does per backend. `social`: native account checks only; `postiz_draining`: drain state with backlog count plus the checks of the target backend; `postiz`: unchanged and pinned by a test. Queue watch only with Postiz backend or Postiz backlog; open queue notices are resolved (never deleted) with an audit event when the watch becomes inactive or the project switches to Social.
- WP2: no automatic provider switch; the block stays and names the required setting. Settling unknown reservations needs explicit ids, a reason and confirmation; still owner-only, at the reserved amount.
- WP4: MCP `social_accounts` lists live accounts in `accounts` and disabled ones in `archivedAccounts`.
- WP5: Marketing calendar keeps key, path and legacy path; only its label and description change ("Redaktionsplan" / "Editorial plan").

## Production steps (each needs its own owner approval)

1. Read-only checks on production: FamilyPlan `publishingBackend`, Postiz backlog, the open queue exception and its versions; the `@uliquid_test` account and its audit trail; legacy-style banner assets; the exception's job topic for `AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA`.
2. Push to `main` (deploys production; no schema hash change expected).
3. Owner actions after deploy: set the assistant per-member cap (a value only the owner decides), mark legacy-style banners outdated, decide unclear reservations with a reason.

## Not in scope (follow-ups)

- Cleanup archiving published content removes it from the novelty check (existing, tested behaviour; needs a product decision).
- Finance extraction has no data-class check although the allow-list covers `financial`.
- Stale in-flight reservations (work-order lease expiry, knowledge analysis) are not swept; the diagnosis shows them as stale.
- Calls that never left (`PAID_CALL_NOT_AUTHORIZED`) are booked as unknown.
- The assets collection view exposes prompt and provider usage to viewers.

## Results (2026-11-10, branch head `4bc7246b`, local only)

Nothing was pushed, deployed or changed in production. No migration, no schema hash change, no new dependency, no flag.

### Per package

| Package | Root cause (code) | Change | Acceptance (local) |
| --- | --- | --- | --- |
| WP1 | `readiness.ts`, `action-readiness.ts`, `postiz-queue-watch.ts` and the project status tool ignored `publishingBackend`; a queue notice closed only inside a check that ran | Readiness mirrors preflight per backend (`social`: native account checks; `postiz_draining`: Postiz checks plus `PUBLISHING_BACKEND_DRAINING` with backlog; `postiz`: unchanged, pinned); additive `publish_*` actions and `publishing`/`publishingBackend` fields; queue watch stops on Social without Postiz backlog and resolves its `POSTIZ_QUEUE_*` notices with an audit event; live autopilot refused on Social (`LIVE_ACTIVATION_BLOCKED:AUTOPILOT_ON_SOCIAL_NOT_APPROVED`) | Readiness card on Social shows no Postiz blocker; a worker pass resolved a seeded `POSTIZ_QUEUE_CHECK_FAILED` (1354×) with `resolution: publishing_backend_social` and an audit event; Postiz projects unchanged |
| WP2 | Personal assistant refused with `POLICY_REQUIRED` when the org has no per-member cap, without a usable message; org page without project limits; Operations "Reserved" mixed states over all months; bulk settle without reason; raw data-class code | Assistant budget notice before sending (owner deep link `/o/{id}/settings#assistant-budget`, member explanation); org page with organisation, assistant and project levels (state, origin), reads moved to `platform/ai/org-budget-levels.ts` (ADR 0013 boundary); `GET …/ai-reservations` diagnosis (derived `stale`); settle needs ids, reason (note for `other`) and confirmation; month split in the Operations band (owners and editors only); exception texts and a Settings → AI warning for disallowed routes | Owner sees the notice and the link; diagnosis shows unclear and stale rows with the next step; settle dialog requires a reason; allow-list unchanged and pinned |
| WP3 | Badge counted `reviewed` (released, scheduled, published) content and every channel copy; raw content table; no per-item cleanup reasons; Social UI showed `approvalState: none` without origin; Content Studio showed raw ids | Read-time lanes (open, reviewed, released & scheduled, history, cleanup); badge = open decisions, FB+IG pair once; cleanup preview names each draft and why; `originRef` on Social posts and "Freigegeben über Marketing" with a link back; Content Studio groups variants and names channels (`GET …/marketing/channels`, Social entries only when Social is visible to the member) | The 09.11-type pair shows "Von dir freigegeben am …" with "In Social öffnen"; the held Social post shows "Freigegeben über Marketing" and links back to the highlighted pair; no released content row is written |
| WP4 | No cross-project read path; disabled accounts listed inline; narrow asset cards with raw Drive ids | "Archivierte Konten" section, MCP `archivedAccounts`; asset tiles (3–4 per desktop row) with technical details collapsed; explicit `projectId` on RLS-only reads | Archived section collapsed; no raw ids in the main tile view |
| WP5 | Policy table read a non-existent `status`; table headers and status badges not localized; marketing calendar duplicated the publishing calendar's role | Policy versions (active, replaced, scheduled, expired, validity, history); localized `Status` and table headers; "Redaktionsplan" with "Sperrzeiten" and a link to the Social calendar (route key, path and legacy path unchanged); capability names and live blockers in words | v3 Aktiv, v2/v1 Ersetzt, no `unknown`; DE/EN switch works |

### Verification

- `pnpm lint` (source guard, import boundaries: 0 known violations, none new), `pnpm typecheck` (API and web), `pnpm build`: pass.
- Whole vitest suite on this worktree's own test database (reset first): 597 files passed, 1 skipped; 6,893 tests passed, 7 skipped, 0 failed (includes `rls-matrix`, `access-matrix`, `queue-dispatch`, `administration-boundary`).
- `scripts/check-secrets.py`: pass. `git diff --check`: clean. OpenAPI document and client regenerated (two additive paths: `ai-reservations`, `marketing/channels`).
- Browser specs touched by this branch (`navigation.spec.ts`, `workspace.spec.ts`) on a fresh CI-like seed: 15 passed, 2 skipped (support gate), 0 failed. The full `pnpm test:e2e` suite was not run.
- Local browser acceptance with synthetic data (no provider keys, `EXECUTION_MODE` test, external writes off): screenshots in DE/EN, desktop 1440 px and mobile 390 px, of the policy list, readiness card, approvals, Content Studio, editorial plan, assets, Social accounts, held Social post, Operations with the settle dialog (opened, never confirmed), the assistant budget notice and the organisation AI page. Page width at 390 px is 390 on all twelve checked pages; focus is visible on the new controls; no console errors.
- Independent security and correctness reviews of the whole diff; every finding is fixed except those listed under "Open points".

### Access and contract changes (review as security changes)

- Access matrix: two new read routes (`ai-reservations` with the permissions of `ai-cost`; `marketing/channels` for members who may read content). The settle probe for owners answers 400 instead of 200 because an empty body is now invalid. Nothing is weakened.
- `settle-unknown-reservations` input changed from `{}` to `{reservationIds, reason, note?, confirm:true}`; the only caller (web) is updated; no MCP caller exists.
- MCP `social_accounts`: `items` no longer contains disconnected accounts; they are in `archivedAccounts`. MCP project status and readiness: additive fields only.
- `/dashboard` `budget`: now the current UTC month; the new split fields only for owners and editors.

### Production steps (each needs its own explicit approval)

1. **Read-only checks** (no writes; run by the operator in one `BEGIN READ ONLY … ROLLBACK` transaction; see the SQL below): FamilyPlan's backend and Postiz backlog, open exceptions, the 09.11 publications and Social posts, `@uliquid_test` and its audit trail, legacy-style banners, cross-project references, reservations by state.
2. **Push to `main`** = production deploy of the web, API, worker and MCP images. Effects: the FamilyPlan Postiz notice is resolved on the first worker pass if the project is on `social` with no Postiz backlog (audited, history kept); readiness no longer shows the Postiz blocker; the approvals badge drops released and reviewed content; the settle button needs a reason per row. No migration, so no schema hash change. Rollback: revert the merge commit on `main` and redeploy; notices resolved meanwhile stay resolved, with history.
3. **Owner settings after deploy:** the assistant per-member cap (a value only the owner sets), marking legacy-style banners outdated, deciding unclear reservations row by row.

### Decisions for Mario

- **Live autopilot on Social:** currently refused by design. Allowing it would let released posts go out without a per-post release. Keep refused (default) or allow, and under which conditions.
- **Cleanup of published content:** it archives content whose post is already published, which removes it from the novelty check (existing behaviour).

### Open points

- Pre-existing: `/dashboard` still gives viewers `reservedMicros`, `spentMicros` and the limits (ruling R26 says hide); finance extraction has no data-class check; stale in-flight reservations are shown, not swept; calls that never left (`PAID_CALL_NOT_AUTHORIZED`) are booked as unknown; the assets collection view sends `prompt` and `providerUsage` to viewers.
- `postizBacklog` can count a Social publication between its claim and its Social hand-off (or after a crash in between) as Postiz backlog; the queue watch then polls Postiz once more. Low impact; fixing it means changing the claim on the publish path.
- The attention read counts at most 1,000 open content rows and checks their hand-offs in one bounded query.
- English labels remain on Operations ("Workspace execution", "Persistent jobs") and in the asset upload and generate dialogs; the nested "Entscheidungen zu Auftragsentwürfen" list in the approvals history still has no inset.
- The editorial plan lists content by its own `scheduledAt`; released assignment drafts appear in the Social calendar, not there.

### Read-only production checks (SQL)

```sql
BEGIN READ ONLY;
-- Q1 FamilyPlan's publishing backend
SELECT pm."moduleId", pm.enabled, pm.settings->>'publishingBackend' AS publishing_backend, pm."updatedAt"
FROM "ProjectModule" pm JOIN "Project" p ON p.id = pm."projectId"
WHERE p.name = 'FamilyPlan' AND pm."moduleId" IN ('marketing', 'social');
-- Q2 Postiz backlog that keeps the queue watch running
SELECT e.kind, e.data->>'status' AS status, e.data->>'publishingBackend' AS backend, (e.data->>'test')::boolean AS test, count(*)
FROM "Entity" e JOIN "Project" p ON p.id = e."projectId"
WHERE p.name = 'FamilyPlan'
  AND ((e.kind = 'publications' AND e.data->>'status' IN ('sending','scheduled_remote','outcome_unknown','reconciliation_required','cancellation_required'))
    OR (e.kind = 'postiz_drafts' AND e.data->>'status' IN ('sending','outcome_unknown')))
GROUP BY 1, 2, 3, 4;
-- Q3 open exceptions (codes and counters only)
SELECT e.id, e.data->>'code' AS code, e.data->>'count' AS count, e.data->>'lastSeenAt' AS last_seen, e.data->'resourceIds' AS resource_ids
FROM "Entity" e JOIN "Project" p ON p.id = e."projectId"
WHERE p.name = 'FamilyPlan' AND e.kind = 'exceptions' AND e.data->>'status' = 'open' ORDER BY e."updatedAt" DESC;
-- Q4 Postiz connector status (no config)
SELECT e.id, e.data->>'provider' AS provider, e.data->>'status' AS status, e."updatedAt"
FROM "Entity" e JOIN "Project" p ON p.id = e."projectId" WHERE p.name = 'FamilyPlan' AND e.kind = 'connectors';
-- Q5 the 09.11 Social posts from Marketing
SELECT s.id, s.status, s."originModule", s."originType", s."originId", s."approvedAt", s."approvedBy", s."scheduledAt"
FROM "SocialPost" s JOIN "Project" p ON p.id = s."projectId"
WHERE p.name = 'FamilyPlan' AND s."originModule" = 'marketing' AND s."scheduledAt" >= '2026-11-09' AND s."scheduledAt" < '2026-11-10';
-- Q6 @uliquid_test and its audit trail
SELECT p.name AS project, a.id, a.platform, a.handle, a."displayName", a.status, a."createdAt", a."disabledAt", a."createdBy"
FROM "SocialAccount" a JOIN "Project" p ON p.id = a."projectId" WHERE a.handle ILIKE '%uliquid%' OR a."displayName" ILIKE '%uliquid%';
SELECT ev."createdAt", ev.action, ev."actorId", ev.metadata FROM "AuditEvent" ev
WHERE ev."resourceId" IN (SELECT id::text FROM "SocialAccount" WHERE handle ILIKE '%uliquid_test%') ORDER BY ev."createdAt";
-- Q7 FamilyPlan banner backgrounds from before 0f61b24d (2026-11-07 17:07 UTC)
SELECT e.id, e."createdAt", e.data->>'name' AS name, e.data->>'assetStatus' AS status,
       e."createdAt" < '2026-11-07T17:07:00Z' AS before_fix,
       (e.data->>'prompt') ~* '(#040B1A|fintech product banner|frosted glass)' AS legacy_style_prompt
FROM "Entity" e JOIN "Project" p ON p.id = e."projectId"
WHERE p.name = 'FamilyPlan' AND e.kind = 'assets'
  AND (e.data->>'bannerBackground' = 'true' OR e.data->>'name' LIKE 'Assignment banner background:%') ORDER BY e."createdAt";
-- Q8 cross-project asset references (expect 0 rows)
SELECT e.id, e."projectId", r.key, x."projectId" AS referenced_project FROM "Entity" e
CROSS JOIN LATERAL (VALUES ('assignmentId', e.data->>'assignmentId'), ('background', e.data->'rightsSource'->>'backgroundAssetId'),
                           ('logo', e.data->'rightsSource'->>'logoAssetId')) r(key, val)
JOIN "Entity" x ON x.id::text = r.val WHERE e.kind = 'assets' AND x."projectId" <> e."projectId";
-- Q9 FamilyPlan reservations by month and state (micros)
SELECT date_trunc('month', r."createdAt") AS month, r.state, count(*), sum(r."amountMicros") AS reserved, sum(r."settledMicros") AS settled
FROM "BudgetReservation" r JOIN "Project" p ON p.id = r."projectId" WHERE p.name = 'FamilyPlan' GROUP BY 1, 2 ORDER BY 1 DESC, 2;
ROLLBACK;
```

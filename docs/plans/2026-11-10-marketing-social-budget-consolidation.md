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

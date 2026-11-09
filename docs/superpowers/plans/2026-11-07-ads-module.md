# Ads Module (paid advertising: Meta first, then ChatGPT Ads and Google Ads) — Architecture and Implementation Plan

> **For agentic workers:** this is a programme-level plan. Each step below gets its own task-level TDD plan (`docs/superpowers/plans/<date>-ads-a<N>-<name>.md`) written at step start against the then-current `main`. Use superpowers:subagent-driven-development or superpowers:executing-plans for those step plans.

**Goal:** A standalone `ads` module that lets a project connect its advertising accounts, import, create, edit, pause and activate campaigns, ad groups and ads, report spend and performance, guard spending with internal budgets and Orbit approvals, and expose all of it through Orbit's existing MCP gateway and assistant. Meta (Facebook and Instagram) first, then OpenAI's ChatGPT ads through its official Advertiser API (after a verification gate, §12.2), then Google Ads. It works without AI and without the Marketing and Social modules. When Marketing is enabled, its existing agents use Ads through a contract.

**Architecture:** A new module `apps/api/src/modules/ads` with its own relational tables (ADR 0009 rule for modules with relational query needs), permissions, gate, routes, jobs, tools and web views. A provider-neutral **Ads Core** owns the domain model, change and approval state machines, internal budget guardrails, sync orchestration and metric normalization. **Provider adapters** behind one interface (`providers/meta` first; `providers/openai` and `providers/google` later) translate to the official APIs with plain HTTPS calls; platform-specific fields live in a typed, versioned `providerSpec` next to normalized columns, so nothing a platform needs is flattened away. Every cost-relevant change is an `AdChange` row that runs through Orbit's ActionRequests and is executed exactly once by the existing worker. Time-based work runs on the existing outbox and `workDueAt` pump.

**Tech stack:** TypeScript, Node 24, Fastify 5, Prisma 7 + PostgreSQL 17 (FORCE RLS), BullMQ via the Orbit pump, zod 4, Next.js 16 + Tailwind 4. **No new dependency:** Meta and Google are called over HTTPS through `packages/connectors` `boundedFetch`; no Meta Business SDK, no Google Ads client library, no third-party ads tool.

**Spec:** Mario's request of 2026-11-07 ("Claude Code – EDS Orbit: Neues Ads-Management-Modul"), requirements R1–R12 in §1.

**Baseline:** `origin/main` at `0f61b24d` (2026-11-07). The Orbit findings in §2 come from static source reading of that revision. The platform facts in §2.6 come from the official documentation of Meta, OpenAI and Google, read on 2026-11-07. Nothing was executed against production, no provider was called, no dependency was installed, no account or app was created.

**Decisions:** A-D1 to A-D19 accepted as recommended by Mario on 2026-11-07 (§3); ADR: [adr/0025-ads-module.md](../../adr/0025-ads-module.md) (proposed).

---

## Global Constraints

- **Planning only.** This document authorizes no code, migration, dependency, flag, developer app, App Review submission, ad account connection, live ad, budget or deployment.
- **Governance.** This planning change is low risk (documentation). The implementation is **high risk**: OAuth and tokens, tenant data, migrations, background jobs with external side effects, a paid external provider and real money. Every live action that can spend money is treated with the care of a critical action: explicit owner approval per step, no implicit smoke tests. Every step plan needs risk analysis, test strategy and rollback before code (`AGENTS.md`, `.agentic/routing/risk-classification.md`). Primary app profile `fullstack-saas` (tenants, roles, money); complementary `backend-api` (adapters, jobs), `data-pipeline` (insights sync, restatement, reconciliation), `ai-agent-app` (MCP, assistant, Marketing agents) and `web-frontend` (dashboard, builder). Stack preset unchanged: `web-next-custom-postgres`. Workflows: `feature.md` per step, `migration.md` for every schema change.
- **Human approval required before:** creating the Meta app or adding the Marketing API product; any App Review or Business Verification submission; applying for a Google Ads developer token; joining any OpenAI ads programme; every production migration (approved schema hash in Coolify, `scripts/check-pve-schema.sh`); enabling any `ORBIT_ADS*` flag in production; connecting the first real ad account; the first live write (even a paused object); **every live activation or budget increase**; enabling Meta Pixel or Conversions API features (personal data, `AGENTS.md` "Tracking oder Analytics mit personenbezogenen Daten"); any push to `main` (it deploys production).
- **Official APIs only.** No n8n, Postiz, managed ads platforms or agency tools in any data or control path. A source-check rule in `scripts/boundaries.json` → `forbiddenImportPrefixes` may pin this once a candidate package is known.
- **No simulated provider as a product.** Test mode exists only as an explicitly labelled mode (`test:` ids, "Test" badge, no provider call) for development and CI. A platform without an official API gets no adapter (§12.2).
- **One scheduler:** no BullMQ repeatable or delayed jobs, no timers; due work is found by the Orbit pump (`docs/SOCIAL.md` "Sending", ADR 0020 §3).
- **Unknown outcome is a stop condition:** a provider write whose result is unknown is never repeated automatically. It is read back or settled by the owner.
- **Absolute values, never deltas.** A change sends target values (status, budget, end time) together with the expected current values it was approved against; a mismatch makes the change stale.
- **Two kinds of limits, never confused.** The Orbit budget guardrail is an internal check on Orbit-initiated changes plus monitoring of actual spend. Only the platform's own limits (budgets, campaign spend caps, the ad account spending limit) bind the platform. UI, API, tools and docs always name which one is meant.
- **Numbers are computed deterministically;** language models explain findings and propose changes but never compute binding totals or spending permissions (`docs/EDS_ORBIT_UNIFIED_CODEX_MASTER_v3.md` §3.7). "Not available" is not zero; estimated is not measured.
- **Existing functions unchanged:** Social keeps `social.app.meta` and its Meta flow; Marketing keeps its CSV ad-statistics import (`import-metrics` in `apps/api/src/modules/marketing/actions.ts:207`) and `metrics` entities; AI spend reservations stay AI-only.
- **No coupling to FamilyPlan, uLiquid or any other project;** everything is per project and per organization, ready for later SaaS use.
- Documentation and code comments in English; user-facing strings `de` + `en`.
- Next.js 16 has breaking changes: read `apps/web/node_modules/next/dist/docs/` before web work (`apps/web/AGENTS.md`).

## Review Focus

1. **Duplicate campaign or double spend after a crash or timeout** (worker killed between the Graph call and the DB write; Meta 5xx after the request left). Expect: the step becomes `outcome_unknown`; Orbit reads back by parent, exact name and creation window; nothing is re-created automatically. Everything is created `PAUSED`, and activation is a separate, idempotent last step, so a duplicate can never spend. Pinned by A7/A8 tests "lease expiry while sending → outcome_unknown, no second create call".
2. **Budget changed elsewhere after approval** (someone edits the budget in Ads Manager between the approval and the execution). Expect: the executor reads the live value first; it differs from the approved `before` value → change `stale`, nothing sent, a new approval needed. Pinned by A7 tests.
3. **Activation that breaks the internal guardrail** (projected month spend above the Orbit limit). Expect: the change shows the projection, approval binds it, execution re-checks it and stops with `ADS_GUARDRAIL_EXCEEDED` unless the owner's approval explicitly covered the excess. Pinned by A6/A7 tests.
4. **Currency and timezone mix-ups** (EUR and USD accounts in one project; account in `America/Los_Angeles`, project in `Europe/Berlin`). Expect: no sums across currencies; dates are ad-account-local and labelled; budgets convert between Meta minor units and micros exactly. Pinned by A2/A5 tests.
5. **Token revoked or permission lost mid-launch.** Expect: no further steps; the change stays resumable; the account becomes `reconnect_required`; the owner is told once. Pinned by A3/A7 tests.
6. **Agent or MCP escalation.** Expect: no agent, mandate, MCP client or Telegram button can activate spend or raise a budget; F1/F2 changes are decided only by an owner in the Orbit web UI. Pinned by A7/A10 tests and the mandate never-list.

---

## 1. Requirements (from the request)

| ID | Requirement | Steps |
| --- | --- | --- |
| R1 | Standalone module, activatable without Marketing or Social; per project its own ad accounts, campaigns, budgets and reports | A1 |
| R2 | Navigation: Dashboard, Kampagnen, Anzeigen, Werbemittel, Zielgruppen, Performance & Analytics, Konten & Verbindungen, Einstellungen; decide MVP vs later; Orbit UI and i18n | A1, A4, A5, A8, A9; §7 |
| R3 | Ads Core with exchangeable provider adapters; shared models for accounts, campaigns, ad groups, ads, creatives, status, spend, metrics; platform specifics preserved; APIs, access and restrictions verified from official docs | A2; §2.6, §4 |
| R4 | Meta connection: OAuth, list and pick ad accounts, assign to projects, several per project, check permissions, store tokens securely, detect broken or expired connections | A3 |
| R5 | Meta campaigns: import, show campaigns/ad sets/ads, create, edit, pause/activate, sync status, budgets and run times, understandable platform validation errors | A4, A7, A8 |
| R6 | Creatives and audiences: images and texts from Creative Studio, existing Meta creatives, variants, audiences and placements, platform rules | A8, A9 |
| R7 | Analytics: spend, impressions, reach, clicks, CTR, CPC, CPM, conversions, CPA, ROAS, comparisons; later Pixel, Conversions API, Matomo | A5; §12.1 |
| R8 | Works without AI; Marketing agents use Ads when Marketing is on; strategy, variants, copy and creatives, evaluation, weak campaigns, optimization and budget proposals, regular reports; decide on a dedicated Ads agent; no duplicate agent logic | A11; §9 |
| R9 | Approvals for activating paid campaigns, raising budgets, changing limits, cost-relevant optimizations; drafts, analysis and reports without extra approval; project budgets, daily and monthly limits, warnings, change log, duplicate protection, reconciliation with real spend; internal limits ≠ platform limits | A6, A7 |
| R10 | Full MCP access through the existing gateway: reads, drafts, ads, activate/pause, budget proposals, optimization proposals; permissions, approvals, idempotency | A10 |
| R11 | Background sync on the existing worker: accounts, status, performance, error detection, budget warnings, reports; rate limits, retries, backoff, pagination, history | A4–A6, A11; §10 |
| R12 | Phase 2 ChatGPT Ads and phase 3 Google Ads: research official docs and plan only; no simulated APIs; core extensible without rebuild | §12.2, §12.3 |

## 2. Current state (IST-Analyse, verified at `0f61b24d`)

### 2.1 Module system, activation, permissions, web shell

- **Manifest and registry.** `ServerModule` in `packages/module-contracts/src/index.ts:73-86` (`id` must match `^[a-z][a-z0-9_]{1,30}$`, `dependsOn`, `defaultEnabled`, `tables`, `permissions`); `validateRegistry` rejects duplicate tables, kinds and permission keys, and every key must start with `<id>.`. Contributions (routes, tools, actionTypes, jobs, periodic, scheduler, hooks, retention, events, attention, userNotifications, connections, files, webhooks, publicRoutes, signals, agentTemplates, `available()`/`unavailableCode`) in `apps/api/src/platform/modules/contributions.ts:68-210`. Registration in `apps/api/src/modules/registry.ts` (manifest list l.31-39, contributions map l.74-82); the worker uses the same registry.
- **Reference module.** Social (`apps/api/src/modules/social/`: `manifest.ts`, `contributions.ts`, `gate.ts`, `http-scope.ts`, `permissions.ts`, `settings.ts`, `attention.ts`, `notifications.ts`, `tools.ts`, `contract.ts`). Social has no web `home` or `settings`; Finance (`modules/finance/home.tsx`) and Work (`modules/work/settings.tsx:225`) are the references for those.
- **Activation.** Installation flag in `packages/config/src/index.ts:215` (`ORBIT_SOCIAL` pattern), also listed in `.env.example`, `docker-compose.yml`, the rendered `docker-compose.pve.yml` (`scripts/render-pve-compose.mjs`, hash in `docker-compose.pve.source.sha256`) and `scripts/check-coolify-compose.mjs`. Per-project `ProjectModule` row (`moduleId` is free text, no enum), opt-in modules count only with an explicit row (`platform/modules/enforcement.ts`). Route preHandler per module owner in `apps/api/src/server.ts:1027-1048`. Rules per surface in `docs/MODULE_ACTIVATION.md`.
- **Permissions.** `permission(key, desc, roles)` in `platform/tenancy/permissions.ts:17`; `sensitive` is declarative (pinned by module tests); module roles `editor|viewer|none` in `platform/tenancy/module-roles.ts` (with `ORBIT_MODULE_ROLES`). Finance marks every key sensitive and sets web `minAccess: "editor"`: the model for spend data.
- **Import boundaries.** `scripts/boundaries.json` + `scripts/boundaries.mjs:75-100`: module → module only to a declared dependency's `contract.ts` (today `module:marketing → module:knowledge, module:social`). **Pitfall:** the zone `module:marketing` contains the catch-all `apps/api/src/modules/` and `web-platform` contains `apps/web/src/`; without its own zones `module:ads` and `web-module:ads` the new code would silently count as Marketing or web platform.
- **Web.** `WebModule` in `apps/web/src/platform/shell/types.ts:177-229` (`optIn`, `minAccess`, `groupOrder`, `views`, `home`, `settings`, `actionRequests`, `attention`); composition root `apps/web/src/modules/registry.ts:345`; grouped sidebar `platform/shell/nav-groups.ts`; URLs `/p/:projectId/<moduleId>[/<view>]`; shared UI in `apps/web/src/platform/ui/` (`metric.tsx`, `collection.tsx`, `form.tsx`, `sheet.tsx`, `record-detail.tsx`, `home-card.tsx`). Charts exist only as Finance's own SVG components (`apps/web/src/modules/finance/charts.tsx`); there is no chart library.
- **i18n.** No library: platform strings in `apps/web/src/lib/i18n.ts`, per-module typed `labels.ts` (`const de: SocialText`, a missing key fails to compile); server texts as inline `{en, de}`.
- **API client.** `pnpm api:generate` writes `packages/schemas/openapi.json` and `packages/api-client/src/generated.ts`; module web code uses `request` from `@orbit/api-client` with hand-typed `api.ts`.

### 2.2 Connections, OAuth and tokens (ADR 0013, ADR 0014)

- `Connection` / `ConnectionSecret` (versioned, sealed, key ring `CREDENTIAL_KEYS`) / `ConnectionGrant` (purposes, modules) in `packages/db/prisma/schema.prisma:1565-1612`. Provider type `ConnectionProvider` (`platform/connections/connections.ts:107-156`: `managedByModule`, `secretFields`, `validateSecret`, `callbackPath`); modules contribute providers (`contributions.ts:453-459`, owner stamped, duplicates refused).
- `platform/connections/project-secrets.ts`: `createProjectConnection`, `withProjectSecret` (advisory lock, rotate secret version, audit `connection.secret_rotated`), `revokeProjectConnection` (wipes ciphertexts), `projectConnectionsByConfig` (cross-project lookup on the auth role). Reads via `central.ts` (`resolveConnection`, `grantedConnections`, `connectionSecret`), only while `ORBIT_CONNECTIONS=true` (on in production).
- The administration UI is data-driven (`administration/connections.ts:71-84`, `apps/web/src/platform/administration/connections-ui.tsx`): a new system provider such as `ads.app.meta` appears there without web changes.
- **All Meta code is private to Social:** `modules/social/accounts/meta.ts` (`META_GRAPH_VERSION = "v26.0"` at l.23, token exchange, `/me/accounts`, `debug_token`, `metaHealth`), `apps.ts` (`social.app.meta`, strict `{appId, appSecret, configId}`), `oauth-state.ts` + table `SocialOAuthState`, `data-deletion.ts` (provider id hard-coded, only social accounts disabled), callback routes in `routes.ts`. Social stores only Page tokens; **no 60-day user-token expiry handling exists anywhere** (`metaHealth` returns `dataAccessExpiresAt`, `health.ts:45` discards it).
- Google OAuth exists only as the legacy Drive pattern (env client, Entity state, `CREDENTIAL_KEY`); the ADR 0014 pattern to copy for Google Ads is `social.app.x` (`social/accounts/providers.ts:79-103`).
- Security rules for third-party tokens: `docs/SECURITY_REVIEW.md:12-19` (sealed secrets only, writes only through `project-secrets.ts`, no token in routes, audit, notifications or errors, hashed single-use state, bounded transport, public callbacks behind `ORBIT_PUBLIC_INGRESS` with constant-time HMAC, independent review before the first deployment).

### 2.3 Approvals, mandates, MCP and audit

- **ActionRequests** (`apps/api/src/platform/governance/action-requests.ts`): risk classes R0, W0, C1, C2, W1, W2, D1, D2, **F1 (paid media creation)**, **F2 (budget change)**, G (`RISK_CLASSES` l.110-123; meanings in ADR 0008 §1). `ActionDefinition` (l.162-210: `riskClass`, `deciderRole`, `mandate?`, `mcpProposable?`, `policyRequired?`, `requires?`, `ttlMs`, `payload`, `costCeilingMicros`, `revalidate`, `onApproved`). The package hash binds payload and type; `decideActionRequest` checks version, hash, expiry, decider role, `revalidate`, then runs `onApproved` in the same transaction (so external effects only change rows and enqueue jobs, as Social's `startDelivery` does). Web renderers per module (`apps/web/src/modules/social/action-requests.tsx`).
- **ADR 0008 §3-4:** budget changes are `ui_only`, ad campaign creation is `approval_required_reauth`, and D1/D2/F1/F2/G are code-constant hard floors. **Neither `ui_only` nor `approval_required_reauth` is implemented** (`approvalMode` accepts only `"approval_required"`, l.164).
- **Mandates** (ADR 0019, `platform/governance/agent-mandates.ts`, `authorization.ts`): only W0/C1/C2 are mandatable (`MANDATABLE_RISK_CLASSES` l.130); the mandate cost limit is AI spend in USD micros; ADR 0019 §10 excludes ad spend. The never-list is pinned in `apps/api/tests/agent-mandates.integration.test.ts:311-357`.
- **Tools.** One `OrbitTool` registry for assistant, MCP, personal assistant and configured agents (`platform/agents/tools/registry.ts:88-155`); `readOperation` / `approvedOperation` in `platform/tasks/operation-tools.ts:229-607` (action type `<module>.mcp.<name>`, 24 h expiry, idempotency key with `IDEMPOTENCY_KEY_CONFLICT`, `approvalContext` + `revalidateContext`). MCP scopes are hard-coded in five places (`platform/mcp/scopes.ts` incl. `MODULE_CONTENT_SCOPES`, `platform/mcp/server.ts:71`, `platform/mcp-auth/plugins.ts:30-50`, web `platform/connect/oauth-flow.ts:134`, `connect-view.tsx:68` + i18n label). Proposals need `ORBIT_MCP_PROPOSALS` / `ORBIT_MCP_TASKS`. `plans/orbit-modularization/09-mcp-gateway.md` §6.1 says F1/F2 are **never** exposed over MCP; the code already has an F2 MCP proposal precedent, `ai_spend_policy_update` (`platform/ai/spend-policy-tools.ts:86-117`, owner decides in Orbit).
- **Chat budget.** `CHAT_MAX_INPUT_BYTES = 128_000` (`platform/assistant/chat-limits.ts:15`); Claude receives every tool schema in full (tool search only for gpt-5.4+ behind `ORBIT_TOOL_SEARCH`); Social's ten tools cost about 9 KB.
- **Audit and events.** `audit(tx, scope, action, resourceId, metadata)` (`platform/shared.ts:157-174`, content-free, `<module>.<object>.<verb>`); `publishEvent` (`platform/events/events.ts:47-98`, declared in `events.publishes`); `notifyMembers` (`platform/notifications/members.ts:150`); attention contributions (`platform/attention/types.ts`); proactive signals (`platform/signals/types.ts`, `ORBIT_PROACTIVE`).
- **Execution gates.** `liveSending()` = `EXECUTION_MODE==="live" && ENABLE_EXTERNAL_WRITES==="true"` lives oddly in `platform/email/connection.ts:53-56`; Social wraps it with a platform list (`ORBIT_SOCIAL_PLATFORMS`, `social/dispatch/gates.ts:17-26`). Social's exactly-once pattern: claim with a new fence, mark `sending` and commit before the call, write the result with the fence, lease expiry → `outcome_unknown`, owner settlement (`social/dispatch/claim.ts`, `control.ts:136-176`, `sweep.ts`).

### 2.4 Budgets, money, worker

- **AI spend reservation is AI-specific** (`platform/ai/budget.ts`, table `BudgetReservation` at `schema.prisma:998-1024`, org counters, threshold signal): **not reusable for ad spend**, which would land on AI budgets. Its pattern is reusable: unique key, in-flight before the call, unknown never resent, once-only threshold crossing under an advisory lock (`platform/signals/budget-threshold.ts:43-90`).
- `actionRequirements` defaults non-marketing types to `["spend_mandate"]` (`action-requests.ts:215-224`): Ads types must set `requires: []`, or ad actions would demand an AI spending authority. `costCeilingMicros` means AI cost and is shown as such in the inbox; ad amounts need their own payload fields with currency. `actionEffect` maps F1/F2 to `"governance"` (l.850-857): the inbox has no "paid media" effect yet.
- **Money conventions:** BigInt micros + ISO currency text, rates `NUMERIC(24,12)`, never JS `number`, never summed across currencies (ADR 0003, ADR 0012 decision 5). Helpers `CURRENCY_DECIMALS`, `parseAmount`, `roundHalfEven`, `formatMicros` are private to Finance (`apps/api/src/modules/finance/money.ts`, five currencies only).
- **Worker:** DB-polled pump over `Project.workDueAt` (`apps/worker/src/main.ts:409-465`, `due-marker.ts`), outbox `availableAt`, durable claim with lease and `maxAttempts` 3, `onLeaseExpired`; error codes matching `/BUDGET|NOT_|REQUIRED|EXPIRED|EVIDENCE|CAPABILITY|POLICY|PAUSED|UNKNOWN|REFUSAL|UNSUPPORTED/` are never retried (main.ts:200): Ads error codes must be named with that in mind. Periodic tasks (`PeriodicTask`, `platform/jobs/types.ts:61-73`) run **inline inside the 60 s project lease** and also while paused, so long work (backfills) belongs in bounded queue jobs. `enqueue()` de-duplicates by scanning all `jobs` entities of the project (`platform/jobs/enqueue.ts:11-23`, `platform/shared.ts:99`), so fan-out must stay small. Lost-job recovery in `apps/worker/src/lost-jobs.ts`. Social's throttle table (`social/dispatch/throttle.ts`) and paced metrics task (`social/analytics/collect.ts`: call caps, 30 s run budget, an attempt row per read) are the patterns to copy.

### 2.5 Agents, Creative Studio, analytics

- **Agent platform** (ADR 0021, `platform/agents/capabilities.ts`): tools reach Orbit Chat, the personal assistant, MCP and configured agents by `feature`; modules can contribute `agentTemplates`, `events.triggers` and `signals`. There is no "two modules enabled" gating.
- **Marketing specialists** (`modules/marketing/agents/specialists/{analytics,research,strategy,copywriter,visual,review}.ts`) have **static tool arrays** (`types.ts:30-37`); there is no registry through which another module could add tools. `docs/plans/marketing-agent-v2.md:27` explicitly left Meta/Google Ads out and foresaw "module contributions and separate permissions".
- **Creative Studio** (`docs/MARKETING_CREATIVE_STUDIO.md`): creatives, renditions and texts are Marketing-owned `Entity` rows (`creatives`, `assets` as base64, `content`); composition in `packages/creative`. Social receives Marketing media by **push** into its own contract (`social/contract.ts` `importOriginMedia`, called from `marketing/publishing/publisher.ts:267`); Social's own media are private platform files (`files.privateToModule`), also importable from Drive (`social/media/from-drive.ts`).
- **Analytics today:** Matomo reads through `packages/connectors/src/matomo.ts` (five-method allowlist) into Marketing `metrics` entities every 12 h; Marketing's CSV ad-statistics import (`packages/connectors/src/csv.ts` `importAdsCsv`: exact minor units, de-duplication keys, no cross-currency sums) also writes `metrics` entities with `costMicros`; Marketing weekly reports (`marketing/analytics/report-schedule.ts`). Social stores technical post figures in `SocialMetricSnapshot`. No generic scheduled per-module report exists.
- **Model routing:** task classes are a closed list in `packages/ai/src/routing.ts:7-31`; `AgentRun_kind_check` is a closed DB list. Paid model calls go through `runStructured`, spend mandate, `reserve`/`settle`.
- **Baseline promises that bind this module:** Master v3 §3.7 (ad clicks, measured visits, app events and verified business results kept apart; deterministic numbers), §7 ("Paid-Ads-Write-Adapter nur auf Basis tatsächlich verfügbarer Provider"), line 60 (no ad booking without its own authorization); `docs/CONNECTOR_CAPABILITIES.md:16` and `docs/AUTONOMY_POLICY.md:9` (no paid-account control adapter asserted today): both must be updated when the adapter ships.

### 2.6 Platform reality (official documentation, read 2026-11-07)

> Read on official domains only (developers.facebook.com, developers.openai.com, openai.com, help.openai.com, developers.google.com, support.google.com); sources in §15. *(snippet)* marks facts taken from official search snippets because the page refused automated reading (openai.com and help.openai.com answered 403). *Unverified* marks what no official page confirmed. Both must be re-checked in the spike of the phase that relies on them (A0, O0, G0).

#### Meta Marketing API

| Topic | Fact | Consequence for Orbit |
| --- | --- | --- |
| Version | Marketing API **v27.0** is current since 2026-11-04; v26.0 (2026-07-29), v25.0 (ends 2027-02-23), v24.0 (ends 2026-11-10). New versions about every four months with a 90-day deprecation schedule; unversioned calls are not supported; calls to a deprecated version are auto-upgraded unless the endpoint changed. The older Graph changelog page still shows v26.0 as latest and is stale. The v27.0 change list could not be retrieved (*unverified*). Re-checked 2026-11-08: changelog lists v27.0 (introduced 2026-11-04) as newest. | Ads pins its own `META_ADS_API_VERSION = "v27.0"`, independent of Social's Graph `v26.0`; one upgrade task per Meta release (checklist plus contract tests). |
| Recent changes | Legacy Advantage+ shopping and app campaign (ASC/AAC) APIs no longer create or update (all versions since 2026-05-19; remaining ones paused in v26.0). Advantage+ is now a state that follows from three settings (campaign budget, `targeting_automation.advantage_audience = 1`, no placement targeting) and is read from `advantage_state_info`. Instagram Explore and Facebook video-feed placements are removed; new detailed-targeting exclusions are refused since 2025-04-21 (use excluded custom audiences); `instagram_actor_id` is replaced by `instagram_user_id`; the `STANDARD_ENHANCEMENTS` bundle is gone. | The builder offers Advantage+ as settings, never legacy ASC/AAC; placement lists come from the adapter manifest per API version; unknown or legacy types import read-only. |
| Permissions and review | `ads_management` (depends on `pages_read_engagement`, `pages_show_list`), `ads_read`, `business_management`, `pages_manage_ads`, `instagram_basic`. Each permission's App Review needs a use-case description and a screencast; Business Verification is required for Advanced Access. Business apps get Standard Access automatically; managing ad accounts of businesses the app does not belong to needs Advanced Access. `instagram_manage_ads`: *unverified*. Review lead times are not published. | A0 fixes the minimal permission set; own businesses first, other businesses after App Review (A-D17). |
| Access tier | Renamed 2026-05-04: **Limited** (default, "for development only", heavily rate-limited, 1 system user + 1 admin system user) and **Full** (10 + 1). Upgrade to Full needs ≥ 500 Marketing API calls in 15 days and an error rate under 15 % over the last 500 calls. | M1 can run on Limited for own accounts; Full is requested once real traffic exists (Mario's approval). |
| Login and tokens | Facebook Login for Business (FLfB) is Meta's preferred solution for tech providers (Business app, `config_id` instead of `scope`); `ads_management` and `ads_read` are available for user tokens and business-integration system-user (BISU) tokens. BISU tokens are for tech providers, never expire by default (60 days optional); system-user tokens do not expire; long-lived user tokens last 60 days; any token can be invalidated (password change, revoked permission). | A-D3. |
| Objects | Campaign: `special_ad_categories` required (NONE, EMPLOYMENT, HOUSING, CREDIT, ISSUES_ELECTIONS_POLITICS, ONLINE_GAMBLING_AND_GAMING, FINANCIAL_PRODUCTS_SERVICES); objectives `OUTCOME_APP_PROMOTION`, `OUTCOME_AWARENESS`, `OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_SALES`, `OUTCOME_TRAFFIC`; only ACTIVE or PAUSED at creation; bid strategies `LOWEST_COST_WITHOUT_CAP`, `LOWEST_COST_WITH_BID_CAP`, `COST_CAP`, `LOWEST_COST_WITH_MIN_ROAS`; budget at campaign **or** ad set level; campaign `spend_cap` minimum 100 USD; up to 200 ad sets per campaign. Ad set: `optimization_goal` and `billing_event` required, `bid_amount` for bid and cost caps, `end_time` with a lifetime budget, `promoted_object` for some objectives, **`dsa_payor` and `dsa_beneficiary` required when targeting the EU**; minimum daily budgets depend on billing event and country. Targeting: at least one country (unless a custom audience is used), `age_min` ≥ 13 (default 18), `age_max` ≤ 65. Creatives: `object_story_spec` (Page with link, photo or video data), `image_hash` from `POST /act_{id}/adimages` (base64 bytes, per ad account), `asset_feed_spec` for dynamic creative. | Spec schemas per objective; A-D15, A-D16; image hashes per account in `AdMediaAsset.providerUploads`. |
| Validation and errors | `execution_options=["validate_only"]` validates campaign and ad set creation without creating anything. Errors carry `code`, `error_subcode`, localized `error_user_title` / `error_user_msg` and `fbtrace_id`; validation errors name the offending field in `error_data.blame_field_specs` *(snippet)*. | Validation before approval; issues mapped to builder fields. |
| Previews | `/act_{id}/generatepreviews` and `/{ad_id}/previews` return iframe snippets; previews from `generatepreviews` are visible to anyone. | Rendered on demand in a sandboxed iframe; never stored, logged or shared. |
| Money | Amounts are in the currency's minor unit (the currency "offset"); the account `spend_cap` reads in minor units but **is written in major units** (decimal). Account fields `amount_spent`, `currency`, `timezone_name`, `account_status`, `disable_reason`, `min_daily_budget`. Without a funding source, ads can be created but do not deliver. | `packages/money` mapping including this asymmetry (implemented in A2: offsets read from https://developers.facebook.com/docs/marketing-api/currencies on 2026-11-08, 66 currencies with offsets 1 and 100 only; Meta's offset differs from ISO 4217 minor units for BHD and JOD (offset 100, ISO 3 decimals) and HUF and TWD (offset 1, ISO 2); the A0 spike Q11 confirms them on real accounts); a test ad account without a funding source is a safe live write target (confirm in A0). |
| Spend semantics and change limits | Since v24.0 a day may spend up to 75 % above the daily budget, capped at 7 × the daily budget per week; ad set budget sharing up to 20 %. The account spending limit can change at most 10 times a day, an ad set budget at most 4 times an hour, and one object accepts one edit per 30 s. | Guardrail upper band; executor serializes edits per object and checks the change budget before approval. |
| Status and review | `status` (= `configured_status`: ACTIVE, PAUSED, DELETED, ARCHIVED) is the field to write; `effective_status` adds delivery states such as IN_PROCESS, WITH_ISSUES, PENDING_REVIEW, DISAPPROVED; `issues_info` carries error code, message, summary and level; per-placement `ad_review_feedback` (older source); an effective-status webhook exists *(snippet)*. | Review status in `Ad.reviewStatus`; the webhook is a later improvement behind `ORBIT_PUBLIC_INGRESS`. |
| Insights | Levels account, campaign, ad set, ad; `time_increment` 1–90; `use_unified_attribution_setting = true` matches Ads Manager; fields spend, impressions, reach (estimated), clicks, ctr, cpc, cpm, actions, cost_per_action_type, purchase_roas, website_purchase_roas, conversions. Async report runs (POST → `report_run_id`, poll `async_status`, up to 1 h, ids expire after 30 days). `maximum` returns up to 37 months; since 2026-01-12 the 7-day and 28-day view windows are no longer returned and unique-field and hourly breakdowns keep 13 months; reach older than 13 months only through async jobs. Data refreshes every 15 minutes and **does not change after 28 days**; reporting uses the ad account's time zone. | Restatement window 28 days; backfill limit 37 months; ad-account-local dates; attribution stored per row. |
| Rate limits | Business-use-case limits per ad account and hour: ads management 300 (Limited) or 100,000 (Full) + 40 × active ads; insights 600 or 190,000 + 400 × active ads; mutations ≤ 100 QPS per app and ad account. Headers `X-Business-Use-Case-Usage` (call count, CPU and total time, `estimated_time_to_regain_access`, access tier), `X-Ad-Account-Usage`, `X-App-Usage`, `X-FB-Ads-Insights-Throttle`. Codes: 80000 (insights) and 80004 (ads management) with subcode 2446079, 17/2446079, 613/1487742 (score), 613/5044001 (QPS), 613/4841018 (concurrent edit), 4 (app), 4/1504022 (insights global). Re-check 2026-11-08 against Meta's error reference (https://developers.facebook.com/docs/marketing-api/error-reference): it lists 4, 17, 190, 102, 10, 200, 294, 100 and 1 as above and does not mention the throttling subcodes or concurrent edits (those stay from the rate-limit docs). New code groups it adds: internal or unknown 5000, negative codes and 3910001 (transient; a write is outcome unknown); temporary blocks 1404078 and 2859015; permission 1713092, 1815694 and 2708008. The page does not always say code or subcode, so the adapter matches either. | `AdProviderThrottle` and the A2 error table. |
| Testing | The current Marketing API use-case page documents **sandbox ad accounts** created from the dashboard Quickstart ("Create Sandbox Ad Account", bound to a Page): no payment method, no charges, ads never run, mock reporting data (added 2026-11-07 while preparing A0; older forum reports of creative problems, so A0 Q17 confirms usability). The same page says ads can run only once the connected business portfolio is verified. `validate_only` works. That paused objects cost nothing is not stated explicitly (*unverified*; charges come from delivery). | Fake Graph server, `validate_only`, the sandbox ad account, a test ad account without a funding source, paused objects. |
| Conversions API and data deletion | Conversions API: `POST /{pixel_id}/events`, ≤ 1,000 events, `event_time` ≤ 7 days, de-duplication by `event_id` + `event_name`, `test_event_code`; platforms offering it to clients need App Review with the Full tier. Apps that access user data must offer a data-deletion callback (`signed_request`, HMAC-SHA256, answer `{url, confirmation_code}`). | Conversions API later (A-D13); deletion callback in A3. |
| Hosted Ads MCP | Meta runs an Ads MCP server (`https://mcp.facebook.com/ads`) with reporting and campaign creation; its authorization model is not documented there (*unverified*). | Not used as an execution path (§4.3). |

#### OpenAI — ads in ChatGPT

| Topic | Fact | Consequence for Orbit |
| --- | --- | --- |
| Availability | Test in the US since 2026-02-09 for logged-in adults on the Free and Go plans; expanded during 2026, including 31 European markets (Germany and Austria) on 2026-08-18 with self-serve there by 2026-08-31; now 89 countries *(snippets)*. Plus, Pro, Business, Enterprise and Edu are ad-free. No ads for accounts identified as under 18 or next to sensitive or regulated topics (health, mental health, politics); advertisers get aggregated metrics only *(snippet)*. | An official channel exists for German and Austrian entities; snippet facts are re-checked in O0. |
| Ads Manager | Self-serve beta with CPC bidding since May 2026; identity verification before ads serve; brand review per account; new accounts may be limited to their home country; minimum daily budget 25 USD or 15 EUR/GBP; Target CPC for new click campaigns from 2026-11-09, Max Bid and Max CPC retire on 2027-01-01 *(snippets)*. | Budget minimums and versioned bidding specs in the adapter. |
| Advertiser API | Base URL `https://api.ads.openai.com/v1`; `Authorization: Bearer` with an API key created in Ads Manager settings, **each key scoped to one ad account, no OAuth documented**; ad account → campaigns → ad groups → ads, `/upload` (→ `file_id`), `/ads/{id}/insights`; objects are created `paused` and enabled through `activate` endpoints; **`Idempotency-Key` header supported**; money in micros; 600 requests per minute per endpoint and 1,200 overall, per account and IP. | The owner enters one key per ad account (sealed secret); step keys become idempotency keys. |
| Formats and review | `chat_card` (title 3–50 characters, body ≤ 100, image ≥ 640 × 640), `product_ad_template`, multi-image ads (4–6 square images) for enabled accounts since 2026-10-26; per-ad `review_status` (in_review, rejected, approved); an account cannot serve before its brand review is approved. Image-generation format tests and Sponsored Agents are limited alphas *(snippets)*. | New `AdCreative.kind` values; review sync. |
| Bidding, budgets, targeting | Billing on click or impression; `fixed_bid` (`max_bid_micros`) or Maximize Results; conversion bidding (`bidding_type: "conversions"`, billed on clicks); exactly one of `daily_spend_limit_micros` or `lifetime_spend_limit_micros`. Targeting by country or location, platform (iOS app, Android app, web), custom audiences (≥ 25,000 matched users) and up to 2,000 "context hints" (not exact-match keywords); no age or demographic targeting documented. | A provider spec very different from Meta's: no placements, no demographics, context hints. |
| Reporting | Impressions, clicks, spend, CTR, CPC, CPM, conversions, CPA, ROAS; one segment per request; daily or total granularity (hourly only for delivery); click windows 7/14/30 days, view window 0 or 1 day; conversions need at least a day; 365 days of daily history, about 30 days hourly. | Restatement ≥ 1 day; backfill limit 365 days. |
| Conversions API | `POST https://bzr.openai.com/v1/events?pid=<pixel>` with a separate key; ≤ 1,000 events, all-or-nothing; ≤ 7 days old; de-duplication by pixel, event name and `id`; `validate_only`. | Later release with its own privacy review. |
| Partners and gaps | "Approved API partners" use the client account's key; some features are enabled per client account through an OpenAI partner representative; no public partner application process. No deprecation policy, sandbox, test accounts or standard error schema documented; the v1 changelog entry is undated (dated entries 2026-06-03 to 2026-10-26); whether every self-serve account can create API keys is *unverified*. | O-D decisions; contract tests from recorded real responses. |
| Not the OpenAI API platform | Separate product, host and keys; unrelated to Orbit's `openai` AI provider and its billing. | Own connection type `ads.account.openai`, never the AI provider's key. |

#### Google Ads API

| Topic | Fact | Consequence for Orbit |
| --- | --- | --- |
| Versions and REST | **v26** is current (2026-10-14, v26.1 on 2026-10-28, sunset November 2027); majors about quarterly with about 12 months of life (v23 sunsets 2027-02, v24 2027-05, v25 2027-08). REST is fully supported: `googleads.googleapis.com/v26/customers/{id}/…:mutate`, `googleAds:searchStream`; headers `Authorization: Bearer`, `login-customer-id` when accessed through a manager account. | Plain HTTPS; an upgrade task about every quarter. |
| Access (changed in 2026) | **Developer tokens were sunset on 2026-09-09.** Access levels belong to the Google Cloud project that issued the OAuth credentials; the `developer-token` header is optional and ignored (to be rejected in a future version); a manager account is no longer required unless several accounts are managed; unused projects lose access after 90 days. Levels: Test (automatic, test accounts only, 15,000 operations/day), Explorer (mostly automated review, 2,880 operations/day on production, no account creation, user management or billing), Basic (15,000/day, needs brand verification of the Cloud project), Standard (unlimited, manual audit of about 10 business days, demo login, Required Minimum Functionality for full-service tools). | One Google Cloud project per Orbit installation; Explorer's quota is tight → `searchStream` (one operation per stream) and sparse syncs; Basic vs Standard decided in G0. |
| OAuth | Scope `https://www.googleapis.com/auth/adwords` with offline access and OAuth app verification; users must authenticate with a passkey to create refresh tokens (a new passkey can take up to 7 days); a consent screen left in "Testing" issues refresh tokens that expire after 7 days (`invalid_grant`) *(snippet)*; whether `adwords` counts as a sensitive scope is *unverified*. | The same failure Orbit's Drive connection hit (`invalid_grant`); a production consent screen is a G0 prerequisite. |
| Objects | `CampaignBudget` (`amount_micros` or `total_amount_micros`, may be shared between campaigns); Campaign (`advertising_channel_type` immutable, created PAUSED because the default is ENABLED, **`contains_eu_political_advertising` required**, a bidding strategy required: manual CPC, maximize conversions, target CPA, target ROAS, target spend …, `start_date_time`/`end_date_time`); AdGroup; keywords as `AdGroupCriterion` (EXACT, PHRASE, BROAD); responsive search ads (3–15 headlines, 2–4 descriptions); Performance Max asset groups with their assets in one request (at least 3 headlines, 1 long headline, 2 descriptions, a 1.91:1 and a 1:1 image). Account budgets change only through an `AccountBudgetProposal` on a billing setup, reviewed offline. | `AdKeyword` and `AdAssetGroup` tables in phase 3; a shared budget change lists every affected campaign; account budgets read-only. |
| Mutations and reporting | `validate_only` on most mutates (some resources refuse it, *snippet*); `partial_failure`; at most 10,000 operations per request; GAQL through `search`/`searchStream`; `change_event` covers 30 days, ≤ 10,000 rows, up to 3 minutes latency; recommendation services (apply and dismiss limited to some tool types). | Atomic bundles without partial failure; drift detection through `change_event`. |
| Testing, quotas, errors | Test accounts under a separate test manager account (no serving, no metrics; at most 50; deleted after a year without activity); Explorer also allows `validate_only` against production accounts; quota errors `RESOURCE_EXHAUSTED` (HTTP 429); retry TRANSIENT and INTERNAL errors with exponential backoff and jitter and log the `request-id`; clicks, impressions and cost are about 1 h fresh, conversions hours later *(snippets)*. | Fake server, test accounts and validate-only before any live call. |

### 2.7 Reuse map

| Need | Reuse as is | Generalize or extract | Build new in `ads` |
| --- | --- | --- | --- |
| Module, flag, gate, roles, settings | manifest/contributions, `ProjectModule`, `platform/modules/settings.ts`, module roles | — | `ads` manifest, gate, permissions |
| Developer apps, tokens | system/project `Connection`, sealed secrets, grants, `project-secrets.ts`, admin UI | optional later: platform OAuth-state service (third use after Drive and Social) | providers `ads.app.meta`, `ads.account.meta`; `AdOAuthState` |
| Meta HTTP | `boundedFetch`, `ConnectorError` | optional: stateless Meta Graph helpers into `packages/connectors` once Social adopts them (A-D2) | `providers/meta/graph.ts` |
| Approvals | ActionRequests, package hash, `revalidate`, renderers, Decisions inbox | step-up re-auth (`approval_required_reauth`), UI-only decisions, a "paid media" inbox effect, ad amounts outside `costCeilingMicros` | ads action types |
| MCP and assistant | `OrbitTool`, `readOperation`/`approvedOperation`, idempotency, proposals switches | scope list (five places), ADR 0008 / gateway §6.1 amendment for F1/F2 proposals | `ads_*` tools |
| Jobs | outbox pump, `JobDef`, `PeriodicTask`, fences, lease hooks, lost-job recovery | — | queue classes, sync state, throttle |
| Money | conventions (BigInt micros, ISO currency) | move Finance money helpers to a shared place (A-D10) | Meta minor-unit ↔ micros mapping |
| Spend control | threshold-once pattern, attention, notifications | — | budget policy, projection, spend watch, reconciliation |
| Creatives | platform files (`privateToModule`), Drive import, `packages/creative` image preparation | — | ads media library; `importOriginCreative` in `ads/contract.ts` |
| Agents | capability layer by feature, agent templates, signals, events | — | Marketing specialist tools via `ads/contract.ts`; deterministic findings |
| Analytics | Matomo connector (later join), CSV import semantics | — | `AdInsightDaily`, normalization, derived metrics |

### 2.8 Conflicts and pitfalls found

1. **Boundary catch-alls** (§2.1): add zones `module:ads` and `web-module:ads` in A1, before any code.
2. **ADR 0008 vs the request:** budget changes `ui_only`, campaign creation `approval_required_reauth`, both unimplemented; `09-mcp-gateway.md` §6.1 forbids F1/F2 over MCP while the request wants budget and optimization proposals over MCP (A-D6, A-D7).
3. **AI-specific defaults on ActionRequests** (`requires: ["spend_mandate"]`, `costCeilingMicros`, `actionEffect`): Ads types must opt out explicitly, and the inbox needs a paid-media presentation (A7).
4. **Meta developer app ownership and the data-deletion callback** (one callback URL per Meta app): sharing Social's app needs a cross-module fan-out that does not exist (A-D2).
5. **No user-token expiry handling** anywhere; ads tokens are not Page tokens (A-D3).
6. **Ad blockers:** common filter lists block request paths and cosmetic classes containing `ads`/`ad-`/`advert`/`banner`. The web root path equals the module id (`/p/:id/ads`), and the API path would be `/api/projects/:id/ads/…` (A-D1, tested in A0). The same risk applies to CSS class names and DOM ids.
7. **Name clash:** Marketing already has a content type `"ad"` (`modules/assets.ts:27`, web `marketing/work.tsx:733`); keep `ads.*` names distinct and explain the difference in docs (a Marketing "ad" is a text draft; an Ads `Ad` is a platform object).
8. **Static Marketing specialist tools:** Ads reaches them only through a declared `module:marketing → module:ads` contract dependency (§9).
9. **`enqueue` linear de-duplication scan** and the 60 s inline periodic budget: sync uses one continuation job per account and stream, never one job per object or day.
10. **Production schema hash and compose hash:** a new flag in `docker-compose.yml` forces regenerating the PVE compose and its hash file; every migration needs a new approved schema hash in Coolify before the push (`docs/deployment/COOLIFY.md`).
11. **Closed lists:** module lists in tests (`module-registry.test.ts`, `module-contributions.test.ts`, `extensibility.integration.test.ts`, web `nav-groups.test.tsx`, `settings-nav.test.tsx`), `rls-matrix` table classification, `access-matrix` flags and public routes, `queue-dispatch` queue list, model task classes.

## 3. Decisions (A-D1 … A-D19, decided by Mario on 2026-11-07)

**Mario accepted every recommendation on 2026-11-07** ("All as recommended"). The decisions are recorded in [ADR 0025](../../adr/0025-ads-module.md) (proposed); A-D6 and A-D7 also in the [ADR 0008 addendum of 2026-11-07](../../adr/0008-action-approvals.md) and `plans/orbit-modularization/09-mcp-gateway.md` §6.1. The table keeps the options and reasons for traceability. The phase 2 and 3 decisions (O-D, G-D in §12.2 and §12.3) are still open.

| ID | Question | Recommendation | Why | Alternative |
| --- | --- | --- | --- | --- |
| A-D1 | Technical module id and URL segment | Keep the working name `ads` unless the A0 ad-blocker test (uBlock Origin and AdGuard default lists, Brave Shields) blocks `/p/:id/ads` or `/api/projects/:id/ads/*`; then use `advertising` as id and path, keeping the display name "Ads"/"Werbung". DOM ids and CSS classes avoid `ad`, `ads`, `advert`, `banner`, `sponsor` either way. **2026-11-09 (Mario):** the test gates enabling `ORBIT_ADS`, not the push to `main`; no valid result yet. | A blocked module page would look broken for many users; the check costs an hour; renaming before A1 is mechanical, after A1 it touches permissions, scopes and tables. | `paid_media` |
| A-D2 | Meta developer app | **Own system connection `ads.app.meta`** with its own Meta app (Business type, Marketing API product, its own Facebook Login for Business configuration, callback `/api/ads/oauth/callback/meta`, data-deletion callback `/api/callbacks/ads/meta-data-deletion`). Extract stateless Graph helpers to `packages/connectors/src/meta-graph.ts` only when Social switches to them. | No change to the live Social flow; independent App Review, access tier and rate-limit budget; one data-deletion callback per app; separate secret rotation and revocation. Costs a second app setup and about 150 lines of Graph helpers. | (B) same Meta app, second Orbit connection with an ads configuration id: duplicated secret plus a data-deletion fan-out; (C) promote the Meta app to a platform provider with several configuration ids and a platform data-deletion route with module fan-out: cleanest long term, largest refactor of Social |
| A-D3 | Meta token model | One code path (Facebook Login for Business with `config_id`) and two token types by configuration: **business-integration system-user (BISU) tokens** (no expiry) once the app qualifies as a tech provider (Advanced Access, Business Verification); until then **long-lived user tokens** (60 days) with the expiry stored, a warning 14 days ahead, and `reconnect_required` at expiry. | Server-side jobs must keep working without someone signing in every 60 days; §2.6 confirms BISU tokens carry `ads_management`/`ads_read` but limits them to tech providers. | Manual system-user token entry per business by an administrator (fallback for own businesses only; tier Limited allows one system user) |
| A-D4 | Where drafts live | **Drafts in Orbit only.** Validation locally, then with Meta's validate-only execution option (no object created). Objects are created at Meta only at launch, all `PAUSED`, then activated as the last, separately guarded step. | No external side effects from draft work; validation errors appear before approval; duplicates from crashes cannot spend. | Push paused drafts to Meta immediately (visible in Ads Manager earlier, but every edit is an external write and a source of drift) |
| A-D5 | Who decides cost-relevant changes | **Owner only** for F1 (activation, launch) and F2 (budget or limit increase, extended run time, cost-increasing optimization). Editors with `ads.manage` may propose them and may directly do cost-neutral or cost-reducing changes (pause, budget decrease, earlier end, rename). Live content or targeting changes of running ads are W2 (public) and need owner approval by default. An owner's own action in the web UI, with the confirm dialog, is its approval. | Mirrors Social (S-D9) and ADR 0008; pausing must stay fast in an incident. | A per-project `editor_each` setting: needs the platform's missing per-project decider hook (ADR 0020 S4 note) |
| A-D6 | Step-up re-authentication (ADR 0008 `approval_required_reauth`) | Implement a small platform hook in A7: an F1/F2 decision needs a session authenticated within the last 15 minutes, else Orbit asks the person to sign in again (Better Auth), and the decision records `reauthAt`. F1/F2 decisions are UI-only: not over Telegram buttons, MCP or chat. | ADR 0008 already demands it; spend is the clearest case. Small, reusable for other hard floors. | Record a documented deviation (`approval_required` only) until 2FA exists |
| A-D7 | F1/F2 proposals over MCP and agents | **Amend ADR 0008 and `09-mcp-gateway.md` §6.1:** F1/F2 may be *proposed* (P) over MCP, chat and agents; the decision stays UI-only by an owner (A-D6); never mandatable, never direct effect. Same shape as the existing `ai_spend_policy_update` F2 proposal. | The request requires budget and optimization proposals over MCP; a proposal changes nothing. | No F1/F2 tools over MCP (agents could only describe proposals in text) |
| A-D8 | Behaviour at the internal limit | Warn at 50/80/100 % (configurable), and at 100 % create a pause proposal for the owner. An owner may opt in per project to **automatic pausing** at 100 % (cost-reducing, so no approval needed, but always announced and audited). | Spend should not silently continue past the owner's own limit, but an automatic stop can hurt a running launch; the owner chooses. | Warnings only |
| A-D9 | Platform spending limits | Read and show the ad account spending limit and campaign spend caps; Orbit never changes the account spending limit automatically. Setting or raising it is an explicit owner action (F2, UI-only); lowering is cost-reducing. | The account limit may be shared with other tools or agencies; it is the only hard stop at Meta. | Read-only |
| A-D10 | Money representation | BigInt **micros** + ISO currency everywhere (like Finance, AI spend and Marketing `costMicros`); Meta minor units are converted with the currency's documented offset; Google `*_micros` map 1:1. Move Finance's money helpers to `packages/money` (internal workspace package, no external dependency) in A2 and extend the currency table. | One exact unit across providers; matches ADR 0003/0012. | Store provider units per provider (error-prone in reports) |
| A-D11 | Agents | **No new Ads specialist in Phase 1.** Ads ships deterministic findings (rules) and tools; Orbit Chat, the personal assistant and configured agents get them through feature `ads`; Marketing specialists get read tools and draft proposals through `ads/contract.ts`. Re-evaluate an `ads.performance_review` agent template (configuration, not new agent code) after the MVP. | Avoids duplicate agent logic; Marketing keeps strategy and copy; numbers stay deterministic. | A dedicated Ads specialist inside Marketing's DAG |
| A-D12 | Creative sources in the MVP | Ads' own private media library (upload, Google Drive) plus Marketing's push into `ads/contract.ts` (`importOriginCreative`, "Use in ad" in Creative Studio), with a rights re-check of the Marketing source; existing Meta page posts as ad creatives (`object_story_id`) if §2.6 confirms it. A read contract to Social's library later. | Same direction as Social (push into the receiving module); no Ads → Marketing import. | Ads reads Marketing creatives (forbidden by the boundaries) |
| A-D13 | Measurement in the MVP | Conversion metrics from Meta Insights for the action types the owner maps; UTM template on ad URLs (no personal data). Pixel and Conversions API management, and Matomo joins, are later releases with their own privacy review and approval. | Delivers CPA/ROAS without new personal-data processing in Orbit. | Pixel/CAPI in the MVP |
| A-D14 | History and retention | Backfill 90 days at connection (owner may extend up to the provider's limit, §2.6), daily insights kept 25 months (setting), change attempts 13 months, intraday spend snapshots 35 days. | Enough for year-over-year comparisons; bounded storage. | Unlimited |
| A-D15 | Special ad categories and political ads | The builder always asks for the declaration Meta requires (default `NONE`, with an explanation of each category). Campaigns in housing, employment, credit, financial products and services, online gambling and gaming, or social issues, elections and politics are **import and report only** in the MVP. | These categories restrict targeting and some need extra authorizations and disclaimers; wrong handling has legal consequences. Some Orbit projects may fall under the financial-products category: the owner decides per campaign, Orbit never guesses. | Full support |
| A-D16 | EU Digital Services Act fields | Per ad account settings `dsaBeneficiary` and `dsaPayor` (default: the organization's legal name, editable by the owner), required before any EU-targeted ad set can be validated; shown in the review step. | Meta refuses EU-targeted ad sets without them (§2.6). | Ask in every builder run |
| A-D17 | Whose ad accounts, and the access path | Phase 1 serves ad accounts of businesses where the app's people have roles (Standard Access, tier Limited) for M1 and the first live checks. Ad accounts of other businesses (customers, later SaaS tenants) need Advanced Access for `ads_management`/`ads_read` (App Review with screencast, Business Verification) and the Full tier; the submission is prepared in A12 and is Mario's decision. | Lets M1 ship without waiting for Meta's review; keeps the multi-tenant path open. | Submit App Review in A0 already (needs a working screencast of the product, so earliest after A8) |
| A-D18 | Meta objectives in the MVP builder | `OUTCOME_TRAFFIC`, `OUTCOME_AWARENESS`, `OUTCOME_ENGAGEMENT`; `OUTCOME_LEADS` and `OUTCOME_SALES` only with a website conversion event of an existing Meta pixel or dataset the owner selects (Orbit manages no pixel); no instant forms (lead data is personal data); `OUTCOME_APP_PROMOTION` later. Advantage+ audience and automatic placements as switches, manual targeting and placements as the alternative. | Covers the common cases with a manageable spec surface and no new personal-data processing. | Traffic only |
| A-D19 | Meta API version policy | Ads pins `META_ADS_API_VERSION` (v27.0 at A2 start, re-checked then) separately from Social's Graph version; an upgrade task per Meta release (about every four months) with the changelog review, spec updates and contract tests; never rely on auto-upgrade. | Marketing API versions live much shorter than Graph versions (§2.6). | Share Social's constant (would force Social upgrades on the Ads cadence) |

## 4. Target architecture

```
                 ┌──────────────────── apps/web ─────────────────────┐
                 │ modules/ads: dashboard, campaigns, ads, builder,   │
                 │ media/creatives, performance, accounts, settings,  │
                 │ Decisions renderer, home card, attention           │
                 └──────────────────────┬─────────────────────────────┘
                                        │ REST /api/projects/:p/ads/*
┌───────────────────────── apps/api ────┴────────────────────────────────────┐
│ platform: tenancy, module gate, connections (ADR 0014), governance          │
│   (ActionRequests + new re-auth hook), files, events, jobs/pump, MCP        │
│   gateway, audit, notifications, attention, signals                         │
│                                                                             │
│ modules/ads ─────────────────────────────────────────────────────────────── │
│  core/        domain types, state machines, cost-impact classifier,         │
│               validation framework, money (packages/money)                  │
│  accounts/    OAuth begin/callback, token vault, discovery, assignment,     │
│               health, data deletion                                         │
│  objects/     campaigns, ad groups, ads, creatives: store, drafts, specs    │
│  changes/     AdChange model, action types, executor (claim/fence/steps),   │
│               reconcile/read-back, sweep, change log                        │
│  budgets/     guardrail policy, projection, spend watch, alerts,            │
│               reconciliation                                                │
│  insights/    sync, normalization, derived metrics, queries, findings       │
│  sync/        planner, structure/status sync, drift detection, throttle     │
│  providers/   types.ts (AdsProvider), registry.ts,                          │
│               meta/ (graph, auth, read, write, insights, errors, specs),    │
│               openai/ (phase 2, only with an official API), google/ (ph. 3) │
│  media/       private library (platform files), Drive import                │
│  tools.ts (assistant + MCP), contract.ts (for Marketing), attention,        │
│  notifications, signals, retention, settings, permissions, gate             │
│                                                                             │
│ modules/marketing ──(ads/contract.ts, declared dependency)──► modules/ads   │
│   specialists read performance, propose drafts, push creatives              │
└─────────────────────────────────────────────────────────────────────────────┘
       apps/worker: registry only; the pump runs ads jobs and periodic tasks
       packages/connectors: boundedFetch (unchanged); packages/money (A-D10)
```

### 4.1 Ads Core vs provider adapters

The core never calls an HTTP API. An adapter implements:

```ts
interface AdsProvider {
  id: "meta" | "openai" | "google";
  manifest: ProviderManifest;            // objectives, bid strategies, budget levels,
                                         // placements, creative formats, targeting
                                         // dimensions, insight levels and metrics,
                                         // currency unit, validate-only, batch support
  specs: ProviderSpecs;                  // zod schemas per object kind and version
  connect: { begin; finish; listAccounts; checkHealth };
  read: { listObjects(level, accountId, cursor, since?); getObjects(ids);
          getInsights(request) /* sync or async report job */;
          getSpend(accountId, range) };
  write: { validate(step); apply(step); readBack(step) };
  errors: { classify(response): ProviderFailure };   // rate_limited | auth | permission |
                                                      // validation | transient | unknown,
                                                      // retryAfterMs, user title/message,
                                                      // field paths
  usage: { parse(headers): ThrottleHint };            // rate-limit headers
}
```

**Normalized core plus typed provider extension.** Every object row has normalized columns used across providers (name, lifecycle status, provider delivery status, budget level and amounts in micros, currency, start/end, normalized `goal` for dashboards) plus `providerSpec` (JSON validated by the adapter's zod schema for `specVersion`) holding everything platform-specific: Meta objective and optimization goal, bid strategy and bid amounts, billing event, targeting spec, placements, promoted object, attribution spec, special ad categories, creative object story spec; later Google channel types, keywords and asset groups. Writes are always built from `providerSpec`; the normalized `goal` is never used to choose a platform objective. Objects the adapter cannot represent faithfully (for example campaign types the builder does not support) are imported **read-only** with `editable = false` and an `unsupportedReason`; status and budget changes stay possible when the adapter declares them safe for that type.

### 4.2 Ownership

| Concern | Owner |
| --- | --- |
| Developer apps (Meta; later Google, OpenAI) | Platform administration (system `Connection`s `ads.app.*`), registered by the ads module |
| Ad accounts, tokens, assignment to projects | Ads (`AdAccount` + project `Connection` `ads.account.<provider>` + sealed `ConnectionSecret`) |
| Campaigns, ad groups, ads, creatives, media, changes, approvals of paid actions, insights, guardrails | Ads |
| Strategy, campaigns as marketing plans, copy and creative generation, marketing review | Marketing (reaches Ads only through `ads/contract.ts`) |
| AI spend | Platform AI budgets (unchanged, never mixed with ad spend) |

### 4.3 Alternatives considered

- **Meta Business SDK / Google Ads client libraries:** large production dependencies for a small set of endpoints; REST over `boundedFetch` is documented and sufficient (§2.6). Rejected by the no-new-dependency rule.
- **Meta's hosted Ads MCP server and Google's read-only Ads MCP server** as the execution path: they would bypass Orbit's tenant scoping, approvals, guardrails, idempotency and change log, and their authorization models are not fully documented. They stay outside Orbit; a user may connect them to their own AI client, which is not an Orbit capability.
- **n8n, Postiz or other ads intermediaries:** ruled out by the request.
- **Ads objects as `Entity` kinds:** no unique keys, no relational queries over metrics, linear idempotency; ADR 0009 gives modules with relational needs their own tables.
- **Extending Marketing instead of a module:** violates R1 (independent activation) and couples paid spend to Marketing's agent runtime.
- **Reusing AI `BudgetReservation` for ad spend:** mixes AI and ad budgets, which the request forbids (§2.4).

## 5. Data model (new tables, prefix `Ad`)

All tables: `id uuid`, `workspaceId`, `projectId`, composite FK to `Project(workspaceId,id)` `ON DELETE CASCADE`, `@@unique([projectId,id])`, composite same-project references between rows, `Timestamptz(3)`, CHECK constraints for enums, FORCE RLS `project_scope` policy written in the migration (copy the loop of `202611020001_social_core/migration.sql`), grants in `scripts/db-deploy.ts`, listed in the ads manifest `tables`. Append-only tables get the restricted grant (SELECT, INSERT, DELETE for retention). Money columns are `BigInt` micros with a `currency` text column.

**Migration plan** (one migration per step that needs it, each with its own approved schema hash):

| Migration | Step | Tables |
| --- | --- | --- |
| `2026MMDD0001_ads_core` | A1 | `AdAccount`, `AdOAuthState`, `AdSyncState`, `AdProviderThrottle` |
| `2026MMDD0002_ads_objects` | A4 | `AdCampaign`, `AdGroup`, `Ad`, `AdCreative`, `AdMediaAsset` |
| `2026MMDD0003_ads_insights` | A5 | `AdInsightDaily`, `AdSpendSnapshot` |
| `2026MMDD0004_ads_budgets` | A6 | `AdBudgetPolicy`, `AdBudgetAlert` |
| `2026MMDD0005_ads_changes` | A7 | `AdChange`, `AdChangeStep`, `AdChangeAttempt` |
| later | 1.x / 3 | `AdAudience`, `AdFinding`, `AdKeyword`, `AdAssetGroup` |

| Model | Purpose | Key fields | Constraints |
| --- | --- | --- | --- |
| `AdAccount` | An ad account assigned to the project | `provider` (`meta\|openai\|google`), `externalId` (`act_…`, customer id), `name`, `currency`, `timezone` (IANA), `connectionId` (project `Connection`), `businessId?`, `status` (`active\|reconnect_required\|disabled\|unlinked`), `capability` (`read_verified\|write_ready\|write_verified`), `writesEnabled bool` (owner toggle, default false), `providerStatus` (raw account status), `spendCapMicros?`, `amountSpentMicros?`, `settings Json` (default identity: Page and Instagram account; conversion mapping; UTM template; backfill days), `lastSyncedAt?`, `version` | unique `(projectId, provider, externalId)`; **one project per ad account and organization**, checked on assignment through an auth-role lookup (like `projectConnectionsByConfig`), so spend is never counted twice |
| `AdCampaign` | Campaign (Meta campaign, Google campaign) | `accountId`, `externalId?`, `origin` (`imported\|orbit`), `name`, `lifecycle` (`draft\|launching\|live\|paused\|completed\|archived\|deleted\|error`), `deliveryStatus` (provider effective status, raw), `configuredStatus?`, `goal` (`awareness\|traffic\|engagement\|leads\|app\|sales\|other`), `budgetLevel` (`campaign\|ad_group\|none`), `dailyBudgetMicros?`, `lifetimeBudgetMicros?`, `spendCapMicros?`, `startAt?`, `endAt?`, `specialAdCategories text[]`, `providerSpec Json`, `specVersion`, `editable bool`, `unsupportedReason?`, `remoteUpdatedAt?`, `syncedAt?`, `remoteHash?`, `version` | unique `(projectId, accountId, externalId)` where not null; index `(projectId, lifecycle)` |
| `AdGroup` | Meta ad set, Google ad group | `campaignId`, `externalId?`, `name`, lifecycle/status fields as above, budget fields, `bidAmountMicros?`, `targeting Json` (normalized summary for display: locations, ages, genders, languages, audience mode), `placements Json`, `startAt?`, `endAt?`, `providerSpec Json`, `specVersion`, `editable`, `version` | unique `(projectId, campaignId, externalId)` where not null |
| `Ad` | One ad | `adGroupId`, `creativeId?`, `externalId?`, `name`, lifecycle/status fields, `reviewStatus` (`pending\|approved\|with_issues\|rejected\|unknown`), `reviewFeedback Json` (sanitized provider reasons), `providerSpec Json`, `version` | unique `(projectId, adGroupId, externalId)` where not null |
| `AdCreative` | Creative (text, media, destination, identity) | `accountId`, `externalId?`, `kind` (`image_link\|existing_post`; later `carousel`, `video`), `headline?`, `primaryText?`, `description?`, `callToAction?`, `destinationUrl?`, `urlTags?`, `identity Json` (Page id, Instagram account id), `mediaAssetId?`, `providerSpec Json`, `contentHash`, `version` | — |
| `AdMediaAsset` | Image in the ads library | `fileId` (platform `File`, private to the module), `sha256`, `mime`, `width`, `height`, `origin` (`upload\|drive\|marketing\|provider_import`), `originRef Json` (Marketing creative id, version, rendition SHA-256 for the rights re-check), `providerUploads Json` (per ad account: Meta image hash), `altText?`, `archivedAt?` | — |
| `AdInsightDaily` | Daily performance per object | `accountId`, `level` (`account\|campaign\|ad_group\|ad`), `objectExternalId`, `date` (ad-account-local), `currency`, `attribution` (provider attribution setting), `spendMicros`, `impressions BigInt`, `reach BigInt?` (daily reach only; not additive), `clicks BigInt?`, `linkClicks BigInt?`, `conversions Decimal(24,6)?`, `conversionValueMicros?`, `actions Json` (raw action-type counts and values), `final bool`, `revision int`, `fetchedAt` | unique `(projectId, accountId, level, objectExternalId, date, attribution)`; upserted (restatement), deleted only by retention |
| `AdSpendSnapshot` (append-only) | Intraday spend for the budget watch | `accountId`, `date`, `spendMicros`, `currency`, `observedAt` | retention 35 days |
| `AdBudgetPolicy` | Internal guardrail per project and currency | `currency`, `monthlyLimitMicros?`, `dailyLimitMicros?`, `perAccount Json?`, `warnAt int[]` (default 50, 80, 100), `onLimit` (`warn\|propose_pause\|auto_pause`), `activatedBy`, `activatedAt`, `version` | unique `(projectId, currency)`; changes go through `AdChange` (kind `budget_policy`), so the change log has before/after |
| `AdBudgetAlert` | A crossed threshold, once | `policyId`, `period` (`day\|month`), `periodKey`, `threshold`, `spendMicros`, `crossedAt`, `notifiedAt?` | unique `(projectId, policyId, period, periodKey, threshold)` |
| `AdChange` | Unit of approval, execution and change log | `kind` (`launch\|status\|budget\|schedule\|creative\|targeting\|spend_cap\|archive\|optimization\|budget_policy\|external_observed`), `costImpact` (`increase\|neutral\|decrease\|unknown`; unknown is treated as increase), `riskClass` (`W1\|W2\|F1\|F2`), `targets Json` (object refs), `before Json` (expected current values), `after Json` (target values), `packageHash`, `guardrail Json` (projection at creation and at approval), `origin` (`manual\|mcp\|assistant\|agent\|marketing\|rule\|external`), `status` (`draft\|needs_approval\|approved\|executing\|applied\|partially_applied\|failed\|outcome_unknown\|stale\|canceled\|rejected\|observed`), `actionRequestId?`, `approvedBy?`, `approvedAt?`, `reauthAt?`, `idempotencyKey`, `fence?`, `attempts`, `nextAttemptAt?`, `lastErrorCode?`, `error Json?` (sanitized provider title/message, field paths), `resolvedBy?`, `resolution?`, `createdBy`, `version` | **unique `idempotencyKey`**; index `(projectId, status, nextAttemptAt)`; at most one `executing` change per target object (partial unique index on a target key) |
| `AdChangeStep` | One provider operation of a change | `changeId`, `position`, `operation` (`upload_image\|create_campaign\|create_ad_group\|create_creative\|create_ad\|update\|activate\|pause`), `stepKey`, `status` (`pending\|sending\|done\|failed\|outcome_unknown\|skipped`), `externalId?`, `requestHash`, `readBack Json?` | unique `(changeId, position)`, unique `stepKey` |
| `AdChangeAttempt` (append-only) | Every provider interaction | `stepId`, `outcome` (`not_sent\|rejected\|unknown\|ok`), `httpStatus?`, `providerCode?`, `providerSubcode?`, `traceId?`, `retryAfterMs?`, `startedAt`, `finishedAt` | no request bodies, no tokens, no creative text |
| `AdSyncState` | Cursor and health per account and stream | `accountId`, `stream` (`structure\|status\|insights_recent\|insights_backfill\|spend_today\|health`), `cursor Json`, `watermark?`, `nextRunAt`, `lastSuccessAt?`, `lastErrorCode?`, `consecutiveFailures`, `leaseToken?`, `leaseExpiresAt?` | PK `(projectId, accountId, stream)` |
| `AdProviderThrottle` | Rate-limit state | `scope` (account id or app connection id), `bucket` (`meta_ads_management\|meta_insights\|…`), `usagePct?`, `windowStart`, `blockedUntil?` | PK `(projectId, scope, bucket)` |
| `AdOAuthState` | OAuth begin/callback | `stateHash`, `provider`, `appConnectionId`, `userId`, `verifierCiphertext?`, `redirectAfter`, `expiresAt` (10 min), `usedAt?` | unique `stateHash` |

**Credentials (no new secret table):** project `Connection` `ads.account.meta` (one per connected business or user grant; it can cover several ad accounts) with sealed secret `{accessToken, tokenType, expiresAt?}` and config `{businessId?, userId?, grantedScopes[], appConnectionId}`; system connection `ads.app.meta` with secret `{appId, appSecret, configId}` declared through `secretFields`. Phase 2: project connection `ads.account.openai` holding the ad account's Ads API key (no system app; OpenAI issues one key per ad account). Phase 3: system connection `ads.app.google` (`clientId`, `clientSecret` of the installation's Google Cloud project; no developer token since 2026-09-09) and project connection `ads.account.google` (refresh token, refreshed under `withProjectSecret`; `loginCustomerId` per account in config when access runs through a manager account).

**Settings** (`ProjectModule.settings` for `ads`, versioned): `{decider: "owner", autoPauseAtLimit: false, conversionDefaults: {}, utmTemplate: null, reportDay: "monday", backfillDays: 90, insightsRetentionMonths: 25}`.

## 6. Backend and API

### 6.1 Server files (`apps/api/src/modules/ads/`)

`manifest.ts`, `permissions.ts`, `gate.ts` (`adsSwitchedOn`, `adsActive`, `requireAds` → 404 `ADS_DISABLED`), `http-scope.ts` (`inAds`), `contributions.ts`, `settings.ts`, `routes/` (accounts, objects, drafts, changes, media, insights, budget), and the folders of §4. Public routes (OAuth callback, Meta data deletion) are declared as `publicRoutes`/`webhooks` and added to `PUBLIC_ROUTES` in the access matrix.

### 6.2 REST contract (`/api/projects/:projectId/ads`)

| Route | Permission |
| --- | --- |
| `GET /status`, `PUT /settings` `{settings, version}` | `ads.read` / `ads.settings` |
| `POST /connections/meta/connect` → Meta dialog URL | `ads.accounts.manage` |
| `GET /api/ads/oauth/callback/meta` | the member who started the flow (session, single-use state) |
| `GET /connections/:connectionId/available-accounts` | `ads.accounts.manage` |
| `POST /accounts` `{connectionId, externalId}` (assign), `PATCH /accounts/:id` `{settings, writesEnabled, version}`, `POST /accounts/:id/check`, `POST /accounts/:id/sync`, `POST /accounts/:id/unlink` `{version}` | `ads.accounts.manage` (owner) |
| `POST /api/callbacks/ads/meta-data-deletion`, `GET /api/public/ads/data-deletion/:code` | Meta's signed request / the confirmation code; need `ORBIT_PUBLIC_INGRESS` |
| `GET /accounts`, `GET /campaigns?accountId&lifecycle&goal&cursor`, `GET /campaigns/:id` (tree), `GET /ad-groups/:id`, `GET /ads?reviewStatus&cursor`, `GET /ads/:id`, `GET /ads/:id/preview?format` | `ads.read` |
| `POST /campaigns` (draft bundle), `PATCH /campaigns/:id`, `/ad-groups/:id`, `/ads/:id`, `/creatives/:id` (drafts directly; live objects → creates an `AdChange`), `POST /campaigns/:id/validate` | `ads.compose` |
| `POST /campaigns/:id/launch`, `POST /{campaigns\|ad-groups\|ads}/:id/{pause\|activate}`, `POST /{campaigns\|ad-groups}/:id/budget` `{daily\|lifetime, amount, currency, expectedVersion}`, `POST /…/schedule` | `ads.manage` (cost-increasing ones become owner decisions) |
| `GET /changes?status&cursor`, `GET /changes/:id`, `POST /changes/:id/cancel` | `ads.read` / `ads.manage` |
| `POST /changes/:id/resolve` `{resolution, externalId?, version}` (unknown outcomes) | `ads.approve` (owner) |
| `POST /media` (raw body), `POST /media/from-drive`, `GET /media`, `PATCH /media/:id`, `DELETE /media/:id` | `ads.compose` / `ads.read` |
| `GET /insights?level&ids&from&to&metrics`, `GET /insights/compare?ids&from&to`, `GET /dashboard?from&to` | `ads.analytics.read` |
| `GET /budget`, `PUT /budget` (lowering applies at once; raising creates an F2 change) | `ads.analytics.read` / `ads.budget.manage` |
| `POST /emergency-pause` (pauses every Orbit-visible active campaign of the project; W1, cost-reducing) | `ads.approve` (owner) |

Every write takes `version` (409 `ADS_VERSION_CONFLICT`). Provider validation errors return 422 `ADS_PROVIDER_VALIDATION` with `{issues: [{path, title, message, providerCode}]}` mapped from the provider's user-facing error fields, in the project language when the provider returns it in that locale, otherwise with Orbit's own `de`/`en` explanation for known codes.

### 6.3 Permissions

| Key | Default roles | Purpose |
| --- | --- | --- |
| `ads.read` | owner, editor (sensitive) | Accounts, campaigns, ads, status, change log |
| `ads.analytics.read` | owner, editor (sensitive) | Spend and performance |
| `ads.compose` | owner, editor | Drafts, creatives, media, validation |
| `ads.manage` | owner, editor | Pause, cost-neutral and cost-reducing changes; propose cost-increasing ones |
| `ads.approve` | owner (sensitive) | Decide F1/F2/W2 changes, settle unknown outcomes, emergency pause |
| `ads.accounts.manage` | owner (sensitive) | Connect, assign, unlink, enable writes |
| `ads.budget.manage` | owner (sensitive) | Internal guardrails |
| `ads.settings` | owner | Module settings |

Web `minAccess: "editor"` like Finance; viewers see nothing of Ads by default (spend is business-sensitive). A viewer reporting role can follow later as a setting.

### 6.4 Action types (ActionRequests)

All set `requires: []` (no AI spending authority), `policyRequired: false`, carry ad amounts in their own payload fields with currency (never in `costCeilingMicros`), and get a "paid media" inbox effect.

| Type | Risk | Decider | Mandatable | MCP proposable | Decision channel |
| --- | --- | --- | --- | --- | --- |
| `ads.change.launch` (create bundle at the platform and activate) | F1 | owner | never | yes, after A-D7 | web only, re-auth (A-D6) |
| `ads.change.activate` (activate or resume a paused object) | F1 | owner | never | yes | web only, re-auth |
| `ads.change.increase` (budget up, lifetime extended, spend cap up, bid up, end later) | F2 | owner | never | yes | web only, re-auth |
| `ads.change.optimization` (bundle with at least one cost-increasing step) | F2 | owner | never | yes | web only, re-auth |
| `ads.budget_policy.raise` (internal limit up or removed) | F2 | owner | never | yes | web only, re-auth |
| `ads.account.spend_cap` (platform account spending limit up or removed) | F2 | owner | never | no | web only, re-auth |
| `ads.change.live_update` (text, media, targeting or placement of a running ad) | W2 | owner | never | yes | web (and Telegram later) |
| `ads.change.reduce` (pause, budget down, end earlier) — only when proposed over MCP/agents | W1 | owner or editor with `ads.manage` | never | yes | web |
| `ads.mcp.ads_draft_save` | W0 | owner | yes, cost 0 | yes | web |

The never-list in `agent-mandates.integration.test.ts` and the proposable list in `mcp-proposals-contract.integration.test.ts` are extended in the same step that adds a type.

### 6.5 Change engine (A7, extended in A8)

1. **Create:** a route, tool or rule builds an `AdChange` with targets, `before` (from the last synced remote state), `after`, `costImpact` (classifier over before/after per field; unknown → increase) and the guardrail projection. Drafts and cost-neutral changes by permitted members go straight to `approved`; others to `needs_approval` with an ActionRequest whose payload is the exact change (package hash).
2. **Approve:** `onApproved` re-checks the package hash, account state and guardrail, records `approvedBy`, `reauthAt`, sets `approved` and enqueues `ads_change_execute` keyed by change id and version. Nothing external happens in the decision transaction.
3. **Execute:** the job claims the change (row lock, new fence, attempts + 1), checks the gates (module on, account `active`, `writesEnabled`, live mode, platform in `ORBIT_ADS_PLATFORMS`, throttle), **reads the live values of every target from the provider** and compares them with `before` (mismatch → `stale`, no write), re-runs the guardrail for cost-increasing changes, then runs the pending steps in order. Each step: mark `sending` and commit, call the adapter outside a transaction, write one attempt and the result with the fence.
4. **Launch bundles** run `upload_image` → `create_campaign` → `create_ad_group` → `create_creative` → `create_ad`, all `PAUSED`, then one `activate` step (absolute status on campaign, ad groups and ads). A stopped launch resumes from the first step that is not `done`; created objects keep their external ids.
5. **Unknown outcome:** a 5xx or network error after the request left, or a lost lease while `sending`, marks the step `outcome_unknown`. Creates are read back once after 60 s (children of the known parent with the exact name created after the step started); 0 found → the step may run again (it would only create a paused object); 1 → adopted; more → the owner decides. Updates are read back by reading the target values. Otherwise the owner settles it (`resolve`). Nothing is retried blindly.
6. **Retries:** rate limits wait for the provider's reset hint (minimum 60 s, at most 3 attempts per step); validation errors fail the change with mapped issues; auth/permission errors block with `ADS_RECONNECT_REQUIRED` and mark the account. Error codes avoid the worker's non-retry regex unless non-retry is intended.
   - **Platform change limits:** the adapter declares them (Meta: ad set budget ≤ 4 changes per hour, account spending limit ≤ 10 per day, one edit per object per 30 s). They are checked when a change is created (the UI says when the next change is possible) and again before execution; a change over the limit waits with `nextAttemptAt` instead of failing. Edits to the same object are serialized.
   - **Provider idempotency:** where the API offers idempotency keys (OpenAI's `Idempotency-Key`), the step key is sent as the key and a repeated step is safe; Meta and Google document none for these creates, so the read-back rule of item 5 applies.
7. **Sweep:** steps still `sending` ten minutes after their claim become `outcome_unknown`; claimed but not sent ones are queued again.
8. **Test mode** (not live, or the platform not enabled): steps finish with `test:<uuid>` ids and a "Test" badge, no provider call.
9. **Change log:** every `AdChange` (Orbit-initiated) plus `external_observed` rows that the sync writes when it sees status, budget or schedule changes made outside Orbit, so the log shows who changed what, where and when.

### 6.6 Budget guardrails (A6)

- **Wording:** "Orbit-Budgetgrenze (intern)" vs "Meta-Ausgabenlimit (verbindlich bei Meta)" everywhere, with a short explanation that the Orbit limit only checks Orbit-initiated changes and watches spend; it cannot stop Meta from spending except by pausing.
- **Projection** per policy currency and period (ad-account-local days, project-level month): actual spend to date + Σ active daily budgets × remaining days + remaining lifetime budgets prorated over their run time, plus the documented daily over-delivery tolerance of the platform as an upper band (§2.6). Shown for every change as "before → after".
- **Checks:** at change creation (shown), at approval (bound in the package), at execution (re-checked; `ADS_GUARDRAIL_EXCEEDED` unless the approved package records an explicit override by the owner).
- **Watch:** `ads-spend-watch` reads today's spend per active account (hourly while anything delivers, otherwise every 6 h), stores `AdSpendSnapshot`, crosses thresholds once (`AdBudgetAlert` under an advisory lock), notifies owners and editors with `ads.analytics.read`, raises the attention item `ads_budget_threshold`, and at 100 % applies `onLimit` (A-D8).
- **Reconciliation:** daily per account: Σ daily insights spend for the month vs the month total from the provider, and Orbit's expected budgets vs the remote budgets; differences become `ads_reconciliation_mismatch` attention items; days older than the restatement window are marked `final`.

### 6.7 Insights (A5)

- Daily rows per level with raw counts; derived metrics (CTR = clicks/impressions, CPC = spend/clicks, CPM = spend/impressions × 1000, CPA = spend/conversions, ROAS = conversion value/spend) are computed at query time from sums, never averaged from daily ratios. Reach is not additive: range reach is fetched from the provider for the exact range on demand and cached, or shown as "not available".
- Conversions use the action types the owner maps per account (with sensible defaults per goal); a missing mapping shows "nicht konfiguriert", never 0.
- The attribution setting is stored per row; rows with different settings are never summed.
- Restatement: recent days are re-fetched daily until the provider's restatement window ends (Meta: 28 days; OpenAI: conversions after at least a day; Google: conversions hours later, §2.6), then `final`.
- Meta reads use `use_unified_attribution_setting = true` so figures match Ads Manager; the account's attribution setting is stored with every row.
- Backfill: at connection, `backfillDays` (default 90) in monthly chunks via asynchronous report jobs; older history on request up to the provider limit (Meta 37 months, OpenAI 365 days); resumable through `AdSyncState`.
- Matomo and the Marketing CSV import stay separate sources; the dashboard can show them side by side with their source labels later (§12.1), never merged into one number.

### 6.8 Contracts and events

- **`apps/api/src/modules/ads/contract.ts`** (the only Ads file Marketing may import; new dependency `module:marketing → module:ads` in `scripts/boundaries.json`): `adsAvailable(scope)`, `accountsSummary(scope)`, `performanceSummary(scope, {from, to, level, ids?})`, `findings(scope, {from, to})`, `importOriginCreative(scope, {bytes, mime, origin: {module, creativeId, version, renditionSha256}})`, `saveOriginDraft(scope, {draft, origin})` (W0 draft, never a launch). Ads imports nothing from Marketing or Social.
- **Events** (content-free, ids and codes): `ads.change.applied`, `ads.change.failed`, `ads.change.outcome_unknown`, `ads.budget.threshold_crossed`, `ads.account.reconnect_required`, `ads.ad.disapproved`. Usable as triggers for configured agents and as signals.

## 7. Frontend (`apps/web/src/modules/ads/`)

### 7.1 Navigation: MVP vs later

| Requested area | MVP | Later |
| --- | --- | --- |
| Dashboard | Overview page: metric strip per currency (spend, impressions, clicks, CTR, CPC, CPM, conversions, CPA, ROAS; "—" when unknown), Orbit limit vs spend with projection, platform limits, attention (disapproved ads, delivery errors, unknown outcomes, reconnects, thresholds), best and weakest campaigns by the chosen goal metric, deterministic findings, recent changes | Org-level overview across projects |
| Kampagnen | List with filters (account, status, goal, delivery); detail with tabs Overview (metrics, chart), Ad groups, Ads, Changes; quick actions pause/activate/budget/end date | Bulk actions, duplication |
| Kampagnen-Builder (part of Kampagnen) | Stepper: account → goal (supported Meta objectives) → budget and run time → audience and placements → creatives and ads (variants) → review (local and provider validation, guardrail projection, previews) → save draft / request approval / launch (owner) | Templates, Advantage+ campaign types if the API allows |
| Anzeigen | List across campaigns with review status and delivery, preview, pause/activate | Bulk edit |
| Werbemittel | Library of images (upload, Drive, from Marketing) and creatives (text + image + destination) with platform hints | Video, carousel, dynamic creative, existing posts browser |
| Zielgruppen | Inline targeting in the builder (locations, age, gender, languages, Advantage+ audience switch) | Saved audiences, custom and lookalike audiences (hashed data needs its own privacy decision) |
| Performance & Analytics | Comparison table (campaigns, ad groups, ads) for a date range with derived metrics, sortable; CSV export | Breakdowns (age, gender, placement, region, device), trends, cohorts, Matomo and CRM sources |
| Konten & Verbindungen | Connect Meta, choose ad accounts, assign, health, write switch, reconnect | Google, OpenAI |
| Einstellungen | Settings sections (`?section=`): budgets and limits, approvals, conversions and attribution, UTM template, sync and history | Report recipients, automation rules |

The change log is reachable from the dashboard and every object ("Änderungen"); pending decisions appear in the platform Decisions inbox.

### 7.2 Components and rules

- `manifest.tsx` (`optIn: true`, `minAccess: "editor"`, `groupOrder` after Social, views, `home`, `settings`, `attention`, `actionRequests`), `api.ts`, `labels.ts` (typed `en`/`de`), `overview.tsx`, `home.tsx` (Finance-style `HomeCard`, nothing on 404), `attention.tsx`, `action-requests.tsx` (exact before/after amounts with currency and account, guardrail projection, platform limits, targeting summary, creative preview, re-auth prompt), `campaigns/`, `ads/`, `builder/`, `media/`, `performance/`, `accounts/`, `settings.tsx`.
- Reuse `platform/ui` (`metric.tsx`, `collection.tsx`, `form.tsx`, `sheet.tsx`, `record-detail.tsx`, `home-card.tsx`). Charts: promote Finance's SVG charts to `platform/ui/charts.tsx` if they fit, otherwise small own SVG charts (no chart library).
- Money is formatted with the account currency and locale; dates show the ad account's time zone when it differs from the project's.
- Ad-blocker hygiene (A-D1): no `ad`/`ads`/`advert`/`banner`/`sponsor` in DOM ids, CSS classes or asset paths.
- Accessibility per `docs/DESIGN_SYSTEM.md`; mobile core path: see spend vs limit, pause a campaign, decide a request.

## 8. MCP and assistant tools (A10)

Feature `ads`, scope `orbit:ads` (added in the five scope places and `MODULE_CONTENT_SCOPES`), assistant instructions explaining internal vs platform limits. Short schemas (short UUID pattern as in Social) and `deferLoading` where supported; the byte cost is measured in A10.

| Tool | Kind | Permission | What it does |
| --- | --- | --- | --- |
| `ads_accounts` | read | `ads.read` | Accounts with provider, currency, time zone, status, write switch; no tokens or connection ids |
| `ads_campaigns` | read | `ads.read` | Campaigns with status, budgets and a metric summary for a range (filters), at most 200 with `truncated` |
| `ads_object_get` | read | `ads.read` | One campaign, ad group or ad with children, spec summary, review status, version |
| `ads_performance` | read | `ads.analytics.read` | Deterministic metrics per level and range, with currency, attribution and "not available" markers |
| `ads_budget_status` | read | `ads.analytics.read` | Orbit limits, spend today and this month, projection, platform limits, crossed thresholds |
| `ads_changes` | read | `ads.read` | Change log and pending decisions |
| `ads_validate` | read | `ads.compose` | Local validation of a draft; provider validation only for a saved draft and rate-limited |
| `ads_draft_save` | proposal W0 | `ads.compose` | Create or update a draft bundle (mandatable, cost 0) |
| `ads_change_reduce` | proposal W1 | `ads.manage` | Pause, budget down, end earlier |
| `ads_change_increase` | proposal F2 | `ads.manage` | Budget up, extend, bid up |
| `ads_activate` | proposal F1 | `ads.manage` | Launch a draft or activate a paused object |
| `ads_optimization_submit` | proposal (max class of its steps) | `ads.manage` | A bundle of changes with a rationale; each step keeps its own before/after |

Every proposal stores the exact change as `approvalContext` and re-validates it (`revalidateContext`); the owner's decision is the change's approval (no second request). Proposals need `ORBIT_MCP_TASKS` and the gateway proposals switch like other modules; idempotency keys behave as everywhere (`IDEMPOTENCY_KEY_CONFLICT`).

## 9. AI agents and approvals

- **Without AI** the module is complete: manual UI, deterministic findings, budget watch, reports.
- **Deterministic findings** (`insights/findings.ts`, computed on read in the MVP): spend without conversions over N days, CPA above the owner's target, CTR far below the account median, ad disapproved or with issues, delivery errors, budget pacing over or under, learning phase limited where the API reports it, frequency high. Each finding names its data, window and source.
- **Orbit Chat, personal assistant, configured agents:** get the `ads_*` tools through feature `ads` when the module is on; F1/F2 only as proposals.
- **Marketing agents** (when both modules are on), through `ads/contract.ts`:
  - analytics specialist: `agentAdsPerformance` (wraps `performanceSummary` and `findings`);
  - strategy specialist: proposes campaign drafts via `saveOriginDraft` (W0; a person launches);
  - copywriter and visual specialists: produce text variants and Creative Studio images; Marketing pushes approved images with `importOriginCreative`.
  The specialists' tool arrays get these tools only when `adsAvailable(scope)` is true; Marketing's DAG and approvals stay unchanged.
- **No new Ads agent** in Phase 1 (A-D11). Weekly reports are deterministic (`ads-weekly-report`: numbers, findings, changes) delivered as a notification and, when `ORBIT_PROACTIVE` is on, into the digest; an optional AI narrative later through an `ads.performance_review` agent template.
- **AI cost** of any narrative or proposal runs under the existing AI spend mandate and `reserve`/`settle`, labelled as AI cost, never as ad spend.

## 10. Scheduler and synchronization

| Work | Kind | Cadence and caps |
| --- | --- | --- |
| `ads-sync-plan` | periodic | Every 5 min: finds due `AdSyncState` streams and enqueues at most one continuation job per account and stream |
| `ads_sync` (structure, status) | queue job | Structure every 6 h and on demand; status of delivering objects every 30 min; pages with cursors, minimal field lists, time budget 60 s per run, then re-enqueues itself with the cursor |
| `ads_insights` (recent, backfill, today) | queue job | Recent days daily (restatement window); backfill in monthly chunks via async report jobs with polling; today's spend for the watch hourly while delivering |
| `ads_change_execute`, `ads_change_reconcile` | queue jobs | On approval; read-backs after 60 s, 120 s, 300 s, then owner |
| `ads-spend-watch` | periodic | Hourly while delivering, otherwise 6 h; at most 20 accounts per project and run |
| `ads-account-health` | periodic | Every 6 h: token validity, granted permissions per account, account status, token expiry warning |
| `ads-change-sweep` | periodic | Every 5 min: stuck steps |
| `ads-reconcile-spend` | periodic | Daily |
| `ads-weekly-report` | periodic | Weekly on `reportDay` |
| `ads-oauth-state-cleanup`, retention | periodic | Daily |

- **Rate limits:** the adapter parses the provider's usage headers into `AdProviderThrottle`; the planner slows down at 75 % usage, stops at 95 % until the provider's regain time, and treats the rate-limit error codes as waits (§2.6). Per-account concurrency is 1 for writes and 1 for reads; per app connection a global budget prevents one project from exhausting another's quota.
- **Retries and backoff:** exponential with jitter, honouring `Retry-After` and provider regain hints; transient errors at most 3 attempts per run; a stream with five consecutive failures raises `ads_sync_failing` and backs off to 6 h.
- **Pagination and history:** cursor-based pagination, stable ordering, watermarks on `updated_time` where the API allows filtering; backfill chunks are resumable and low priority.
- **Pause and module off:** jobs end `blocked_dependency` (`PROJECT_PAUSED`, `MODULE_DISABLED`); a paused project stops change execution but keeps read syncs and the spend watch (spend continues at the platform even when Orbit is paused, and the owner must see it).
- **Tests:** new queue classes enter `apps/worker/tests/queue-dispatch.integration.test.ts` or get dedicated tests, and `apps/api/tests/module-contributions.test.ts`.

## 11. Security and permissions

- **Tenancy:** FORCE RLS on every table, composite keys, one project per ad account and organization, no cross-project reads in the org view without per-project `ads.analytics.read`.
- **Credentials:** sealed `ConnectionSecret`s only; writes through `project-secrets.ts`; `appsecret_proof` on every Graph call (§2.6); tokens in headers where the API allows; never in logs, audit, notifications, errors, tool outputs or URLs built by Orbit; tests scan responses and audit rows for token patterns.
- **OAuth:** hashed single-use state bound to the member and project, 10-minute expiry, redirect only under `/p/:id/ads`; least-privilege permission set in the Meta configuration (read-only configuration option for reporting-only projects).
- **Approvals:** F1/F2 hard floors (code constants), owner decides in the web UI with re-auth, never mandatable, never direct effect over MCP; W2 live updates owner by default; package hash plus live precondition read.
- **Spend safety layers:** (1) installation flag `ORBIT_ADS`, (2) live mode + `ENABLE_EXTERNAL_WRITES` + `ORBIT_ADS_PLATFORMS=meta`, (3) per-account `writesEnabled` (owner), (4) approval, (5) guardrail, (6) platform budgets and spending limit, (7) emergency pause.
- **Privacy:** the MVP processes aggregated statistics and business data only; custom audiences with hashed personal data, Pixel and Conversions API are out of the MVP and need their own privacy assessment, DPA check and approval; Meta data-deletion callback from A3; retention per A-D14.
- **Compliance:** special ad categories gate (A-D15); ad policies remain the advertiser's responsibility, Orbit surfaces review results.
- **Audit names:** `ads.account.connected|assigned|unlinked|reconnect_required|writes_enabled`, `ads.change.created|approved|applied|failed|outcome_unknown|resolved|canceled`, `ads.budget_policy.changed`, `ads.emergency_pause`, `ads.meta.data_deletion`; system audit for connections as today. Metadata: ids, codes, amounts and currency, never creative text or tokens.
- **Independent security review** before the first production deployment (as for Social S2), recorded in `docs/SECURITY_REVIEW.md`.

## 12. Phases, dependencies and acceptance

### 12.1 Phase 1 — Meta Ads

```
A0 ─► A1 ─► A2 ─► A3 ─► A4 ─► A5 ══► M1 read-only reporting (deployable)
                               │
                               ├─► A6 ─► A7 ─► A8 ─► A9 ─► A10 ══► M2 Meta MVP
                               │                        └─► A11 (Marketing agents, MVP+1)
                               └──────────────────────────────────► A12 live acceptance (per milestone)
```

| Step | Scope | Depends on | Acceptance criteria |
| --- | --- | --- | --- |
| **A0** Decisions, ADR, spike (docs + throw-away branch) | **Done 2026-11-07:** answers to A-D1…A-D19 in ADR 0025 (proposed) and the ADR 0008 / gateway amendment. **Open (spike plan [2026-11-07-ads-a0-spike.md](2026-11-07-ads-a0-spike.md)):** Meta app (Business type, Marketing API product) in development mode on Mario's own business, no spend: confirm the minimal permission set, token type (A-D3), tier Limited behaviour, usage headers, `validate_only`, previews, insights fields, whether a sandbox ad account still exists, and that an ad account without a funding source accepts paused objects but cannot deliver; ad-blocker test (A-D1); record sanitized fixtures for the fake Graph server | — | Decisions recorded; §2.6 rows marked *unverified* or *(snippet)* for Meta confirmed or corrected; fixtures reviewed for secrets and personal data |
| **A1** Module skeleton | Step plan [2026-11-08-ads-a1-module-skeleton.md](2026-11-08-ads-a1-module-skeleton.md) (Task 0 settles A-D1). **Implemented 2026-11-08 on branch `claude/eds-orbit-ads-module-plan-3228d2` (commits `ab15d9b8` to `dff02062` inclusive, i.e. the commits after the plan commit `325d6b8a` up to the status commit; on `main` since 2026-11-09; Task 0 open, it gates enabling `ORBIT_ADS`).** Manifest, `ORBIT_ADS` flag (config, compose, PVE render, compose check), permissions, gate, settings, boundaries zones, web module shell with empty states, registry entries, migration `ads_core` | A0 | Flag off → 404 `ADS_DISABLED`; opt-in per project; module, registry, contributions, nav, settings-nav, access-matrix, RLS-matrix tests updated and green; no other module's behaviour changes |
| **A2** Provider seam, Meta transport, fake Graph server | Step plan [2026-11-08-ads-a2-provider-seam.md](2026-11-08-ads-a2-provider-seam.md) (in-memory fake Graph instead of a server; Meta currency offsets in the adapter). **Implemented 2026-11-08 on branch `claude/eds-orbit-ads-module-plan-3228d2` (commits `078ca199` to `2e6864ef` inclusive; stacked on A1; on `main` since 2026-11-09; Task 6, contract tests on sanitized A0 recordings, open).** `providers/types.ts`, registry, Meta Graph client (version pin, `appsecret_proof`, pagination, error classification, usage headers), `packages/money` with currency offsets, fake Graph server with scenarios (5xx after commit, timeouts, rate limits with headers, validation errors, async reports, pagination) | A1 | Contract tests against fixtures; error mapping table complete; exact conversions for 2-decimal and 0-decimal currencies; no network in tests |
| **A3** Meta connection and accounts | `ads.app.meta` provider, OAuth begin/callback, token vault, ad account discovery, assignment (one project per account and org), health task, expiry warning, `reconnect_required`, data-deletion callback, Konten & Verbindungen UI | A2 | E2E connect with the fake provider; negative tests (other project, editor, viewer, reused state, foreign redirect, token leak scan, data-deletion signature); audit rows content-free |
| **A4** Structure and status sync (read-only) | Migration `ads_objects`; import campaigns, ad sets, ads, creatives with pagination; status sync; drift detection; read-only unsupported objects; queue classes, planner, throttle; Kampagnen and Anzeigen views read-only with review status | A3 | Idempotent re-sync; three levels imported from fixtures; rate-limit behaviour test; queue-dispatch test entries; external changes appear as `external_observed` |
| **A5** Insights and dashboard | Migration `ads_insights`; recent, backfill and today jobs; async report runs; conversion mapping; derived metrics; dashboard, performance comparison, home card; read tools `ads_accounts`, `ads_campaigns`, `ads_performance` (MCP read only, no proposals) | A4 | Metric tests (sum-then-divide, currencies separate, reach not additive, not available ≠ 0, attribution not mixed, account-local dates); restatement updates rows; **M1 deployable: read-only reporting** |
| **A6** Budget guardrails | Migration `ads_budgets`; policy, projection, spend watch, alerts once, attention, notifications, reconciliation, settings UI with the two-limits wording | A5 | Threshold-once under concurrency; projection tests; reconciliation mismatch item; wording reviewed in de/en |
| **A7** Change engine and approvals for existing objects | Migration `ads_changes`; cost classifier; action types; re-auth hook and UI-only decisions (A-D6); Decisions renderer; executor with fences and live preconditions; unknown outcome, read-back, owner settlement, sweep; pause/activate/budget/end date; emergency pause; change log UI | A6 | Review Focus 1, 2, 3, 5, 6 pinned; mandate never-list extended; inbox shows "paid media" with currency; test mode labelled |
| **A8** Campaign builder and launch | Orbit drafts, provider specs for the supported objectives (A0 list), local and validate-only validation, image upload, creative, targeting and placements, previews, launch bundle (paused first, then activation), special-category gate | A7 | Launch end-to-end with the fake provider; partial failure resumes; duplicate read-back; validation issues mapped to fields in de/en |
| **A9** Creatives and variants | Media library (upload, Drive), `importOriginCreative` + Creative Studio "Use in ad" (Marketing side), rights re-check, several ads per ad set as variants, existing posts as creatives if confirmed | A8 | Revoked Marketing rights block the creative; platform image rules enforced; Marketing off → library still works |
| **A10** MCP and assistant tools | Tools of §8, scope in five places, proposals contract, chat byte measurement | A7 (reads from A5) | Tool tests per permission and module state; proposals only create requests; F1/F2 decided only in the web UI; chat stays under its limit |
| **A11** Marketing agents and reports (MVP+1) | Contract functions, specialist tools when ads is available, findings in specialist context, weekly deterministic report | A5, A8, A10 | Marketing off → Ads complete; Ads off → Marketing unchanged (tests); specialists can only save drafts and propose |
| **A12** Live acceptance and rollout | Runbook `docs/ADS.md`, `MODULE_ACTIVATION.md` section, security review, production schema hashes, staged live checks L1–L5 (§13.4), each with Mario's go; Full-tier request once the call threshold is met; App Review package for Advanced Access (screencast, use cases) prepared for Mario's decision (A-D17) | per milestone | M1: L1 passed; M2: L2–L5 passed; `CONNECTOR_CAPABILITIES.md` and `AUTONOMY_POLICY.md` updated to the verified capability |

**Meta-MVP (M2, productive):** A0–A10 and A12: connect and assign Meta ad accounts, import and sync, dashboard and comparisons, internal guardrails with warnings and reconciliation, approved pause/activate/budget/end-date changes, campaign builder for the supported objectives with single-image ads and variants, media from upload, Drive and Creative Studio, change log, MCP reads and proposals.

**Later releases (1.x):** saved, custom and lookalike audiences; video and carousel (after the S3-compatible storage of Social S3b exists); dynamic creative; Advantage+ campaign types where the API allows; breakdowns; A/B tests; automation rules (always as proposals unless cost-reducing and opted in); persisted findings; scheduled e-mail reports; organization overview; Pixel and Conversions API (privacy review first); Matomo campaign joins via UTM; FX-converted org reporting using Finance rates.

**Size indication (relative, for sequencing):** A0 S, A1 M, A2 M, A3 L, A4 L, A5 L, A6 M, A7 XL, A8 XL, A9 M, A10 M, A11 M, A12 M.

### 12.2 Phase 2 — ChatGPT Ads (OpenAI)

**Status (§2.6):** OpenAI sells ads in ChatGPT through a self-serve Ads Manager, available to German and Austrian entities, and documents a public Advertiser API (`https://api.ads.openai.com/v1`, bearer key per ad account, no OAuth). Several facts come from search snippets of pages that refused automated reading; the API has no published deprecation policy, no sandbox and no standard error schema; the bidding model changes on 2026-11-09 and 2027-01-01. Phase 2 therefore starts with a gate. No adapter is written before the gate passes, and no simulated adapter is shipped as a product.

**Decisions (O-D):**

| ID | Question | Recommendation |
| --- | --- | --- |
| O-D1 | Access route | Self-serve: each project's owner creates an Ads API key in their own OpenAI Ads Manager and enters it in Orbit (one key per ad account). The API-partner route (no public application process) only if Orbit later serves many advertisers. |
| O-D2 | Key handling | Write-only field, sealed as the project connection's secret, checked with a read call, rotated by entering a new key, removed by revoking the connection (with the hint to revoke the key in Ads Manager too). The key grants the whole ad account, so only owners (`ads.accounts.manage`) can enter it; it is never shown again. |
| O-D3 | First release scope | Read (structure, review status, insights), pause/activate and budgets first; creation of chat-card campaigns second; the conversions API later with its own privacy review. |

**Model mapping (no structural change to the core):**

| Core | Meta | OpenAI |
| --- | --- | --- |
| `AdAccount` | ad account `act_…`, OAuth token | ad account, API key per account |
| `AdCampaign` | campaign (objective, special categories, campaign budget) | campaign |
| `AdGroup` | ad set (optimization goal, billing event, targeting, placements) | ad group (bidding, spend limit, location/platform/audience targeting, context hints) |
| `Ad` + `AdCreative` | ad + ad creative (`object_story_spec`) | ad with `chat_card`, `product_ad_template` or multi-image content |
| Media | `adimages` hash per account | `/upload` → `file_id` |
| Budget | daily or lifetime at campaign or ad set level, minor units | exactly one of daily or lifetime spend limit, micros |
| Bidding | bid strategies, bid and cost caps | fixed bid, Maximize Results, conversion bidding; Target CPC from 2026-11-09 |
| Targeting | locations, age, gender, Advantage+ audience, placements | locations, platform, custom audiences (≥ 25,000), context hints; no demographics, no placements |
| Review | `effective_status`, review feedback | per-ad `review_status` + account brand review |
| Insights | 37 months, stable after 28 days, attribution settings | 365 days daily, conversions after ≥ 1 day, click window 7/14/30, view 0/1 |
| Duplicate protection | none documented → read-back | `Idempotency-Key` = step key |
| Rate limits | per ad account and hour (usage headers) | 600/min per endpoint, 1,200/min overall |

The adapter brings its own `providerSpec` schemas, creative kinds and a manifest without placements and demographics, so the builder hides those steps. Connections differ (API key instead of OAuth); guardrails, changes, approvals, tools and insights are reused unchanged.

| Step | Scope | Depends on | Acceptance |
| --- | --- | --- | --- |
| **O0** Gate and spike | Re-read the official pages (including the snippet-only ones, in a browser), confirm that a self-serve account can create API keys, account verification and brand review for a test entity, record sanitized fixtures from read-only calls; Mario approves the new external provider and storing customer keys | M1 | Gate report; O-D1…O-D3 answered |
| **O1** Connection and reads | `ads.account.openai`, key entry, check, rotation; structure, review and insights sync | O0 | Contract tests against fixtures; key never echoed or logged |
| **O2** Changes | Pause/activate through the activate endpoints, spend limits, versioned bidding specs, idempotency keys | O1, A7 | Review Focus tests against the OpenAI fake server |
| **O3** Creation | Chat-card and multi-image ads, uploads, location/platform/context-hint targeting, minimum budget checks (15 EUR/day) | O2, A8 | Launch end-to-end with the fake server |
| **O4** Live acceptance | L1–L5 with Mario's go; L3 costs at least the minimum daily budget | O3 | Figures match Ads Manager |

### 12.3 Phase 3 — Google Ads

**Status (§2.6):** Google Ads API v26 over REST. Since 2026-09-09 there are no developer tokens: access depends on the access level of the Google Cloud project that issued the OAuth client (Explorer 2,880 operations per day on production accounts; Basic 15,000 after brand verification; Standard after an audit with Required Minimum Functionality for full-service tools). OAuth needs a verified consent screen in production and users who sign in with a passkey.

**Decisions (G-D):**

| ID | Question | Recommendation |
| --- | --- | --- |
| G-D1 | Access level | Explorer for development, **Basic** (brand verification) for the first projects; Standard only if Orbit becomes a full-service tool for third parties (RMF obligations and audit). |
| G-D2 | Google Cloud project | One project per Orbit installation, owned by EDS Labs, consent screen "In production" and verified (avoids the 7-day refresh-token expiry Orbit's Drive connection already hit). |
| G-D3 | Campaign types | Search campaigns with responsive search ads and keywords first; Performance Max and Demand Gen read, report, status and budget only; their creation later. |
| G-D4 | Manager accounts | Support direct access and access through a manager account (`login-customer-id` stored per ad account). |

**Core extensions (additive):** `AdKeyword` (ad group, criterion id, text, match type, status, bid; a Google concept, while OpenAI's context hints stay in the ad group's `providerSpec`); `AdAssetGroup` and its assets for Performance Max later; shared campaign budgets carried in `providerSpec`, with a budget change listing every affected campaign and classified on the total; account budgets read-only; quota accounting per Cloud project and day in `AdProviderThrottle`; drift detection through `change_event` (30 days).

| Step | Scope | Depends on | Acceptance |
| --- | --- | --- | --- |
| **G0** Gate | Cloud project, API enabled, verified production consent screen, Explorer then Basic application, test manager and test accounts, passkey prerequisite documented for users; Mario approves the provider and the applications | M2 | Access level granted; fixtures recorded from test accounts |
| **G1** Connection | `ads.app.google`, OAuth with offline access, accessible customers, manager handling, health, refresh under the connection lock | G0 | Negative tests as A3; refresh-token expiry detected |
| **G2** Reads | GAQL `searchStream` for structure and status; drift from `change_event` | G1 | Operation count per sync measured and within the Explorer/Basic quota |
| **G3** Insights | GAQL daily metrics (`segments.date`, `metrics.cost_micros`, impressions, clicks, conversions, conversion value) with conversion restatement | G2 | Metric tests shared with Meta |
| **G4** Changes | Status, campaign budgets (incl. shared), end dates; `validate_only`; `contains_eu_political_advertising` | G3, A7 | Review Focus tests against the Google fake server |
| **G5** Search creation | Budget, campaign, ad group, responsive search ad and keywords as one atomic mutate request, created PAUSED, activated separately | G4, A8 | Launch end-to-end with the fake server and a test account |
| **G6** Live acceptance | L1–L5 on a Google account with Mario's go | G5 | Figures match the Google Ads UI |

## 13. Test strategy

### 13.1 Unit
Money conversions and currency offsets; cost-impact classifier (every field, unknown → increase); guardrail projection; derived metrics; error classification per provider code; usage-header parsing; spec schemas per objective; local validation rules; cursor handling; package hashing.

### 13.2 Fake providers and contract tests
- An in-process **fake Meta Graph server** (Fastify, test-only) driven by sanitized fixtures recorded in A0, with scenario switches: success, 5xx after the write took effect, timeout, rate limit with usage headers and regain time, validation errors with field blame, permission loss, async report runs, pagination, external edits between read and write. The Graph base URL override is accepted only when `EXECUTION_MODE` is not `live` and `NODE_ENV=test`.
- Adapter contract tests run the same suite against the fake server; the suite is reused for Google and OpenAI adapters later.

### 13.3 Integration and end-to-end
- `rls-matrix` (all `Ad*` tables, restricted grants), `access-matrix` (`ORBIT_ADS`, public routes; reviewed as a security change), `queue-dispatch`, module and contribution lists, mandates never-list, MCP proposals contract, boundaries lint.
- Crash and race tests: lease expiry while sending; double click on approve; two changes on the same object; stale approval after an external edit; guardrail exceeded at execution; token revoked mid-launch; paused project; module switched off with pending changes.
- Playwright: connect (fake), import, dashboard, builder → draft → editor requests → owner decides with re-auth → launch; pause from the campaign page; budget warning display. One manual check with an ad blocker enabled (A0, then before M1 and M2).

### 13.4 Sandbox and live tests
- **Sandbox:** Meta development-mode app with app roles on Mario's own business; the Quickstart sandbox ad account (§2.6; usability confirmed in A0); `validate_only` calls against real accounts (no objects, no cost); a dedicated test ad account **without a funding source**, where paused and even active objects cannot deliver (to be confirmed in A0), for write tests before any account that can spend.
- **Live checks, each needing Mario's explicit go:**
  - L1 connect one real ad account read-only, import, compare figures with Ads Manager for 7 days (tolerance documented);
  - L2 create a paused campaign bundle, confirm in Ads Manager, archive it;
  - L3 activate with the smallest budget the account allows and an end time the same day, then pause; compare spend with Ads Manager;
  - L4 budget increase through an editor's request and the owner's decision with re-auth;
  - L5 spend watch with a tiny internal limit: thresholds, notification, pause proposal or auto-pause.

## 14. Risks and open technical decisions

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Meta App Review, access tier and Business Verification lead times (§2.6; not published) | Productive use for other businesses delayed | Start A0 app setup early; M1 for own business accounts first (A-D17) |
| Meta tier Limited is described as "for development only" | Production use on Limited may be against Meta's intent; low quotas | Request the Full tier as soon as the 500-call threshold is reached; quotas measured in A4/A5 |
| BISU tokens need tech-provider status | 60-day reconnects until then | Expiry tracking and warnings (A-D3) |
| Meta Marketing API version churn (about every four months, 90-day deprecation) | Builder specs break | `META_ADS_API_VERSION` pin, spec versions, contract tests, `editable=false` fallback for unknown types, an upgrade task per release (A-D19) |
| Budget semantics (daily over-delivery, lifetime pacing) | Spend above the Orbit limit on single days | Show the upper band; platform spending limit as the hard stop (A-D9); watch and auto-pause opt-in |
| External edits (Ads Manager, agencies, other tools) | Drift, stale approvals | Live precondition read, `external_observed` log, stale handling |
| Shared ad account across projects | Double counting | One project per account and organization |
| Currency offsets and time zones | Wrong amounts or days | `packages/money` tests, account-local dates, no cross-currency sums |
| Attribution and restatement | Figures change after the fact | Store attribution, restatement window, `final` flag, labels |
| Rate limits with many accounts on one app | Sync stalls, other projects starve | Usage headers, per-app budget, paced continuation jobs |
| Token revocation or expiry | Jobs fail | Health task, expiry warning, `reconnect_required`, resumable changes |
| Ad blockers | Module unusable for some users | A-D1 test and naming rules |
| Legal: special categories, political ads | Rejections, liability | A-D15 gate, import-only |
| Privacy: Pixel, CAPI, custom audiences | Personal data processing | Out of the MVP; separate assessment and approval |
| EU Digital Services Act fields missing | EU ad sets refused by Meta | A-D16 settings, checked in validation |
| OpenAI facts partly from snippets; no deprecation policy; bidding change 2026-11-09 / 2027-01-01; customer keys grant a whole ad account | Phase 2 rework or a leaked key with spending power | Gate O0, versioned bidding specs, owner-only write-only key field, sealed storage, revocation guidance |
| Google access since the developer-token sunset: Cloud project access level, brand verification, passkeys, production consent screen | Phase 3 delayed; refresh tokens dying after 7 days | Gate G0, Basic access early, verified consent screen, quota measurement |
| Chat context budget | Chat breaks with many tools | Short schemas, deferred loading, measurement in A10 |
| `enqueue` scan and inline periodic budget | Worker slowdown | Continuation jobs, small fan-out |
| Production schema and compose hashes | Blocked deploys | Hash approval before every push with a migration or flag |
| Inbox AI-cost defaults | Misleading approval screens | Explicit opt-outs and a paid-media effect in A7 |

**Open technical decisions** (decided in step plans, not blocking the MVP shape): platform OAuth-state service vs `AdOAuthState`; promoting Finance charts to `platform/ui`; whether `ads-spend-watch` reads inline (small, capped) or always through a job; whether `AdFinding` becomes persistent in 1.x; FX for organization reports.

## 15. Sources

All read on 2026-11-07. *(snippet)* = official page known only from its search snippet (automated reading refused).

**Meta**
- Versioning: https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/versioning
- Marketing API changelog (versions, access-tier rename): https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog.md ; v22.0: https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/version22.0 ; v26.0: https://developers.facebook.com/docs/graph-api/changelog/version26.0/
- v24.0 and v25.0 announcements: https://developers.facebook.com/blog/post/2025/10/08/introducing-graph-api-v24-and-marketing-api-v24/ ; https://developers.facebook.com/blog/post/2026/02/18/introducing-graph-api-v25-and-marketing-api-v25/
- Permissions: https://developers.facebook.com/documentation/development/permissions ; authorization and access: https://developers.facebook.com/docs/marketing-api/overview/authorization
- Facebook Login for Business: https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business ; authentication and tokens: https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authentication.md
- Campaign: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/ ; ad set: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/ ; ad account: https://developers.facebook.com/docs/marketing-api/reference/ad-account/ ; ad creative: https://developers.facebook.com/docs/marketing-api/reference/ad-creative/ ; ad images: https://developers.facebook.com/docs/marketing-api/reference/ad-account/adimages/ ; previews: https://developers.facebook.com/docs/marketing-api/generatepreview/
- Advantage+ campaigns: https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-campaigns
- Targeting: https://developers.facebook.com/docs/marketing-api/audiences/reference/basic-targeting ; placements: https://developers.facebook.com/docs/marketing-api/audiences/reference/placement-targeting
- Currencies: https://developers.facebook.com/docs/marketing-api/currencies
- Issues info: https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-issues-info/ ; errors: https://developers.facebook.com/docs/graph-api/guides/error-handling ; https://developers.facebook.com/docs/marketing-api/error-reference/ *(snippet)* ; review statuses: https://developers.facebook.com/ads/blog/post/2018/11/27/with-issues-status-blog/ *(snippet, old)* ; status webhooks: https://developers.facebook.com/blog/post/2026/07/21/the-case-for-webhooks/ *(snippet)*
- Insights: https://developers.facebook.com/docs/marketing-api/insights ; https://developers.facebook.com/docs/marketing-api/reference/ad-account/insights/ ; best practices: https://developers.facebook.com/docs/marketing-api/insights/best-practices ; metric availability: https://developers.facebook.com/blog/post/2025/10/16/ads-insights-api-metric-availability-updates/
- Rate limiting: https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/rate-limiting ; https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
- Sandbox ad accounts: https://developers.facebook.com/documentation/development/create-an-app/marketing-api-use-cases.md (current); https://developers.facebook.com/ads/blog/post/v2/2016/10/19/sandbox-ad-accounts/ (2016)
- Conversions API: https://developers.facebook.com/documentation/ads-commerce/conversions-api/using-the-api.md ; as a platform: https://developers.facebook.com/documentation/ads-commerce/conversions-api/set-up-conversions-api-as-a-platform.md
- Data-deletion callback: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
- Ads MCP server: https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-overview

**OpenAI**
- Testing ads, release notes, expansion: https://openai.com/index/testing-ads-in-chatgpt/ *(snippet)* ; https://help.openai.com/en/articles/6825453-chatgpt-release-notes *(snippet)* ; https://openai.com/index/chatgpt-ads-expands-across-europe/ *(snippet)* ; https://openai.com/index/chatgpt-ads-expands-26-new-countries/ *(snippet)*
- Ads in ChatGPT, policies: https://help.openai.com/en/articles/20001047-ads-in-chatgpt *(snippet)* ; https://openai.com/policies/ad-policies/ (not readable)
- Ads Manager: https://openai.com/index/new-ways-to-buy-chatgpt-ads/ *(snippet)* ; https://help.openai.com/en/articles/20001206-ads-manager-beta-overview *(snippet)* ; https://help.openai.com/en/articles/20001245-ads-manager-availability *(snippet)* ; daily budgets: https://help.openai.com/en/articles/20001413-daily-budgets *(snippet)* ; bidding: https://help.openai.com/en/articles/20001634-bidding-strategies-and-how-pricing-works-in-chatgpt-ads *(snippet)* ; formats and measurement: https://openai.com/index/new-chatgpt-ads-format-and-measurement/ *(snippet)* ; Sponsored Agents: https://help.openai.com/en/articles/20001524-sponsored-agents-in-chatgpt-ads *(snippet)*
- Advertiser API: https://developers.openai.com/ads ; https://developers.openai.com/ads/llms-full.txt ; quickstart: https://developers.openai.com/ads/api-quickstart ; authentication: https://developers.openai.com/ads/api-reference/authentication.md ; overview: https://developers.openai.com/ads/api-overview.md ; bidding and budgets: https://developers.openai.com/ads/bidding-and-budgets.md ; targeting: https://developers.openai.com/ads/campaign-targeting.md ; reporting: https://developers.openai.com/ads/reporting.md ; conversions API: https://developers.openai.com/ads/conversions-api ; partners: https://developers.openai.com/ads/api-partner-setup.md

**Google**
- Sunset dates: https://developers.google.com/google-ads/api/docs/sunset-dates ; v22 sunset: https://ads-developers.googleblog.com/2026/09/google-ads-api-v22-sunset-reminder.html *(snippet)*
- REST: https://developers.google.com/google-ads/api/rest/overview ; https://developers.google.com/google-ads/api/rest/auth
- Developer token sunset: https://developers.google.com/google-ads/api/docs/api-policy/developer-token ; access levels: https://developers.google.com/google-ads/api/docs/api-policy/access-levels ; https://developers.google.com/google-ads/api/docs/access-levels ; RMF: https://developers.google.com/google-ads/api/docs/api-policy/rmf
- OAuth: https://developers.google.com/google-ads/api/docs/oauth/multi-user-authentication ; security requirements (passkeys): https://developers.google.com/google-ads/api/docs/oauth/security-requirements ; common errors: https://developers.google.com/google-ads/api/docs/get-started/common-errors *(snippet)*
- Campaigns: https://developers.google.com/google-ads/api/docs/campaigns/create-campaigns ; Search: https://developers.google.com/google-ads/api/docs/campaigns/search-campaigns/getting-started ; Performance Max asset groups: https://developers.google.com/google-ads/api/performance-max/asset-groups
- API structure (`validate_only`): https://developers.google.com/google-ads/api/docs/concepts/api-structure *(snippet)* ; mutate best practices: https://developers.google.com/google-ads/api/docs/mutating/best-practices ; change events: https://developers.google.com/google-ads/api/docs/change-event ; account budgets: https://developers.google.com/google-ads/api/docs/billing/account-budgets ; recommendations: https://developers.google.com/google-ads/api/docs/recommendations
- Test accounts: https://developers.google.com/google-ads/api/docs/best-practices/test-accounts ; quotas: https://developers.google.com/google-ads/api/docs/best-practices/quotas ; error types: https://developers.google.com/google-ads/api/docs/best-practices/error-types ; data freshness: https://developers.google.com/google-ads/api/docs/productionize/manage-data-efficiently *(snippet)* ; https://support.google.com/google-ads/answer/2544985 *(snippet, old)*
- Google Ads MCP server: https://developers.google.com/google-ads/api/docs/developer-toolkit/mcp-server

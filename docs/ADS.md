# Ads module (`ads`)

The ads module is meant to connect a project's ad accounts and manage paid advertising (campaigns, budgets, reporting) without a managed intermediary. Decision: [ADR 0025](adr/0025-ads-module.md) (proposed). Programme plan: [superpowers/plans/2026-11-07-ads-module.md](superpowers/plans/2026-11-07-ads-module.md) (requirements R1–R12, decisions A-D1–A-D19). Step A1 plan: [superpowers/plans/2026-11-08-ads-a1-module-skeleton.md](superpowers/plans/2026-11-08-ads-a1-module-skeleton.md).

State on 2026-11-08: **step A1 (module skeleton) is implemented on branch `claude/eds-orbit-ads-module-plan-3228d2`; not merged, not deployed.** `ORBIT_ADS` is off. The module has a manifest, permissions, gate, settings, one status route, four empty tables and six placeholder views. It connects no ad account and calls no provider; accounts, campaigns and reports come in later steps (A2 onward).

Open: Task 0 of the A1 plan (the A-D1 ad-blocker test of the module id `ads` in uBlock Origin, AdGuard and Brave) has not been done. A check in Chrome without an active blocker proved nothing. The implementation uses `ads` by a recorded ruling; if the test shows blocking, the plan's rename table switches id and path to `advertising`.

## Switching it on

Three layers, as for Social ([MODULE_ACTIVATION.md](MODULE_ACTIVATION.md)):

1. Installation: `ORBIT_ADS=true` (default `false` in the config, both compose files and `.env.example`). While off, every ads route answers 404 `ADS_DISABLED`.
2. Project: an owner enables the module in Settings → Modules (`enabled = true` row). The module is opt-in (`defaultEnabled: false`).
3. Member: the permissions below; module roles may narrow them. Viewers see nothing of the module.

Switching it off deletes nothing.

## Permissions

| Key | Default roles | Purpose |
|---|---|---|
| `ads.read` | owner, editor (sensitive) | Ad accounts, campaigns, reports |
| `ads.analytics.read` | owner, editor (sensitive) | Performance figures and spend |
| `ads.compose` | owner, editor | Create and edit ad drafts |
| `ads.manage` | owner, editor | Manage campaigns and ads |
| `ads.approve` | owner (sensitive) | Approve launches and spend changes |
| `ads.accounts.manage` | owner (sensitive) | Connect, check, disconnect accounts |
| `ads.budget.manage` | owner (sensitive) | Set and change budgets |
| `ads.settings` | owner | Module settings |

## Settings

Stored in the module's `ProjectModule` row, versioned. A1 only reads them (in the status route); the write route comes later.

| Setting | Default | Meaning |
|---|---|---|
| `decider` | `owner` | Who decides an ad action; always the owner |
| `autoPauseAtLimit` | `false` | Pause campaigns automatically when the Orbit budget limit is reached |
| `utmTemplate` | none | UTM template appended to ad links |
| `reportDay` | `monday` | Day of the weekly report |
| `backfillDays` | `90` (1–1125) | History loaded by the first sync |
| `insightsRetentionMonths` | `25` (13–60) | How long insights are kept |

## Two kinds of limits

The Orbit budget guardrail is an internal check on Orbit-initiated changes plus monitoring of actual spend. Only the platform's own limits (budgets, campaign spend caps, the ad account spending limit) bind the platform. UI, API, tools and docs always name which one is meant. A1 implements neither; the guardrail comes with budgets and approvals (programme plan §1, R9).

## Data model

Migration `202611080001_ads_core`: `AdAccount`, `AdOAuthState`, `AdSyncState`, `AdProviderThrottle`. Every table is project-scoped with forced row-level security (`project_scope`) and a composite same-project foreign key to the project. Ad accounts are unique per project, provider and external id and are never deleted by the business role (`scripts/db-deploy.ts` grants the business role only SELECT, INSERT and UPDATE on `AdAccount`; accounts are unlinked instead). Sync state and throttle rows belong to an account or project and are deleted with it. Tokens are never stored here; they will be sealed connection secrets (ADR 0014). Provider values are limited to `meta`, `openai`, `google`.

## Boundaries

- Only direct HTTP adapters: `scripts/boundaries.json` → `forbiddenImportPrefixes` makes `pnpm lint` fail on imports of `facebook-nodejs-business-sdk`, `google-ads-api`, `google-ads-node`, `n8n-…` and `@n8n/…`. Zones `module:ads` and `web-module:ads` apply the module import rules.
- Ad-blocker hygiene: no `ad`, `ads`, `advert`, `banner` or `sponsor` token in DOM ids, CSS classes or asset paths written by the module; a web test checks it. Module id and URL segment stay `ads` unless the Task 0 test says otherwise.

## Routes

| Route | Permission |
|---|---|
| `GET /api/projects/:projectId/ads/status` | `ads.read` |

It returns module version, settings and settings version.

## Web

`apps/web/src/modules/ads/`: editor-only (`minAccess: "editor"`), opt-in, group order 13 (after Social). Six placeholder views (overview, campaigns, ad units, creatives, performance, accounts) with English and German empty-state texts.

## Rollout and rollback

Nothing is deployed. The migration changes the production schema hash to `6eae72159db3c3703c2adeb7874e0432cef55390d0752f48357492905b537c78` (`sh scripts/check-pve-schema.sh --print-hash`); Mario must approve this hash in Coolify before any push to `main` that contains it (`docs/deployment/COOLIFY.md`). Rollback before deployment: revert the branch. After deployment the tables are empty and inert while the flag is off; dropping them needs a separate approved migration.

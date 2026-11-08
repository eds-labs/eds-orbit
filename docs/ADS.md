# Ads module (`ads`)

The ads module is meant to connect a project's ad accounts and manage paid advertising (campaigns, budgets, reporting) without a managed intermediary. Decision: [ADR 0025](adr/0025-ads-module.md) (proposed). Programme plan: [superpowers/plans/2026-11-07-ads-module.md](superpowers/plans/2026-11-07-ads-module.md) (requirements R1–R12, decisions A-D1–A-D19). Step A1 plan: [superpowers/plans/2026-11-08-ads-a1-module-skeleton.md](superpowers/plans/2026-11-08-ads-a1-module-skeleton.md).

State on 2026-11-08: **step A1 (module skeleton) is implemented on branch `claude/eds-orbit-ads-module-plan-3228d2`; not merged, not deployed.** `ORBIT_ADS` is off. The module has a manifest, permissions, gate, settings, one status route, four empty tables and six placeholder views. It connects no ad account and calls no provider; accounts, campaigns and reports come in later steps (A2 onward).

Open: Task 0 of the A1 plan (the A-D1 ad-blocker test of the module id `ads` in uBlock Origin, AdGuard and Brave) has not been done. A check in Chrome without an active blocker proved nothing. The implementation uses `ads` by a recorded ruling; if the test shows blocking, the plan's rename table switches id and path to `advertising`.

## Switching it on

Three layers, as for Social ([MODULE_ACTIVATION.md](MODULE_ACTIVATION.md)):

1. Installation: `ORBIT_ADS=true` (default `false` in the config, both compose files and `.env.example`). While off, every ads route answers 404 `ADS_DISABLED`.
2. Project: an owner enables the module in Settings → Modules (`enabled = true` row). The module is opt-in (`defaultEnabled: false`).
3. Member: the permissions below; module roles may narrow them. By default viewers see nothing of the module; an owner can grant a viewer the editor module role, which includes spend data.

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

Migration `202611080001_ads_core`: `AdAccount`, `AdOAuthState`, `AdSyncState`, `AdProviderThrottle`. Every table is project-scoped with forced row-level security (`project_scope`) and a composite same-project foreign key to the project. Ad accounts are unique per project, provider and external id and are never deleted by the business role (`scripts/db-deploy.ts` grants the business role only SELECT, INSERT and UPDATE on `AdAccount`; accounts are unlinked instead). The business role may DELETE sync-state, throttle and OAuth-state rows; only `AdAccount` lacks DELETE. Tokens are never stored here; they will be sealed connection secrets (ADR 0014). Provider values are limited to `meta`, `openai`, `google`.

## Boundaries

- Only direct HTTP adapters: `scripts/boundaries.json` → `forbiddenImportPrefixes` makes `pnpm lint` fail on imports of `facebook-nodejs-business-sdk`, `google-ads-api`, `google-ads-node`, `n8n-…` and `@n8n/…`. Zones `module:ads` and `web-module:ads` apply the module import rules.
- Ad-blocker hygiene: no `ad`, `ads`, `advert`, `banner` or `sponsor` token in DOM ids, CSS classes or asset paths written by the module; a web test checks it. Module id and URL segment stay `ads` unless the Task 0 test says otherwise.

## Meta transport (A2)

Code: `apps/api/src/modules/ads/providers/` (`types.ts`, `registry.ts`, `meta/{version,transport,graph,errors,usage,money,provider}.ts`). Every Meta call goes through one client. Nothing is merged, deployed or enabled; A2 has no schema change and no flag.

**Version policy.** `META_ADS_API_VERSION = "v27.0"` (`meta/version.ts`), separate from Social's `META_GRAPH_VERSION`. Calls are never unversioned and never rely on Meta's auto-upgrade. One upgrade task per Meta release (about every four months): (1) read the changelog and the error reference for the new version; (2) update the constant; (3) re-check the error table below, the usage headers and the currency offsets against the documentation; (4) update the plan's section 2.6 rows; (5) re-run the contract tests on fresh sanitized recordings; (6) deploy only after those pass.

**Client rules.** Every call carries `appsecret_proof` (HMAC-SHA256 of the access token with the app secret). The token travels only in the `authorization` header, never in a URL, body, error, `ProviderFailure` or log; `access_token`, `appsecret_proof`, `method`, `batch`, `suppress_http_code` and `callback` are reserved parameter names in `params` and `form` (a plain error before any request). Credentials are validated when the client is created: an empty access token or app secret, or one containing whitespace or a control character, throws an `ADS_META_TOKEN_INVALID` failure (outcome `not_sent`, not retryable) before anything is sent. Paths are checked against a strict pattern. Paging uses the `after` cursor only; `paging.next` is never followed. A response with `paging.next` but no non-empty `paging.cursors.after` is an invalid response (row 10) instead of a silently shortened list. There is no base-URL override. The transport is `boundedFetchWith` (8 MB response limit, 20 s timeout unless the caller passes a signal).

**Error table.** `classifyMetaFailure` (`meta/errors.ts`); the first matching row wins. A "code" below matches the Graph `code`; where noted, it also matches `error_subcode`. Provider user messages are truncated to 300 characters and redacted (token words, bare `Bearer ...`, `EAA...` token shapes).

| # | Condition | kind | code | outcome | retryable, delay |
| --- | --- | --- | --- | --- | --- |
| 1 | transport failure (`ConnectorError`) | transient | `ADS_PROVIDER_UNAVAILABLE` | the transport's outcome | only when `not_sent` and the code is not `RESPONSE_TOO_LARGE` or `REQUEST_TOO_LARGE` |
| 1b | a write answered with HTTP 500 or above (whatever the body says) | transient | `ADS_PROVIDER_UNAVAILABLE` | `unknown` | no |
| 2 | code 190 or 102, or HTTP 401 without a code | auth | `ADS_META_TOKEN_INVALID` | rejected | no |
| 3 | code 10 or 200-299, or code or subcode 1713092, 1815694, 2708008 | permission | `ADS_META_PERMISSION_MISSING` | rejected | no |
| 4 | code 613 with subcode 4841018 | rate_limited | `ADS_META_CONCURRENT_EDIT` | rejected | yes, 30 s |
| 5 | code 368, or code or subcode 1404078, 2859015 | rate_limited | `ADS_META_TEMPORARILY_BLOCKED` | rejected | yes, 1 h |
| 6 | code 4, 17, 32, 341, 613 or 80000-80014, or HTTP 429 | rate_limited | `ADS_META_RATE_LIMITED` | rejected | yes; the largest `regainMs` from the usage headers, else 60 s |
| 7 | code 100, or `blame_field_specs` present | validation | `ADS_PROVIDER_VALIDATION` | rejected | no; `fieldPaths` from the blame specs; user title and message kept |
| 8 | code 1, 2 or 5000, any negative code, code or subcode 3910001, `is_transient: true`, or HTTP 500 and above | transient | `ADS_PROVIDER_UNAVAILABLE` | write: `unknown`; read: `rejected` | write: no; read: yes, 5 s |
| 9 | any other HTTP 4xx with a Graph error | validation | `ADS_PROVIDER_REJECTED` | rejected | no |
| 10 | anything else, or a 2xx body that fails the expected schema | unknown | `ADS_PROVIDER_RESPONSE_INVALID` | write: `unknown`; read: `rejected` | write: no; read: yes, 5 s |

A write with outcome `unknown` is never retried automatically; it needs reconciliation. Row 1b runs before rows 2-7 because a 5xx answer to a write may have committed: it is never reported as `rejected`, even when the body carries a rate-limit or validation code, and `is_transient` is not promoted to a retry. Rows 3, 5 and 8 include codes added after the 2026-11-08 re-check of Meta's error reference.

**Usage buckets.** `parseMetaUsage` (`meta/usage.ts`) reads `X-Business-Use-Case-Usage` into `meta_<type>` buckets (percentage = the largest of call count, CPU time and total time; `estimated_time_to_regain_access` minutes become `regainMs`; `ads_api_access_tier` becomes `limited` or `full`), `X-Ad-Account-Usage` into `meta_ad_account` (`acc_id_util_pct`, `reset_time_duration` seconds), `X-App-Usage` into `meta_app` and `X-FB-Ads-Insights-Throttle` into `meta_insights_throttle`. Malformed headers are skipped; the parser never throws.

**Money rules.** Amounts are BigInt micros (`packages/money`, provider-neutral decimal arithmetic; Finance keeps its behaviour through a thin wrapper in `finance/money.ts`). Meta currency offsets live in the adapter (`meta/money.ts`, 66 currencies, read from Meta's currency page on 2026-11-08; the A0 spike confirms them on real accounts). Offset 1 means no subdivisions (for example JPY, HUF, TWD); offset 100 means two digits. Meta's offset differs from ISO 4217 for some currencies: BHD and JOD have offset 100 (ISO: three decimals), HUF and TWD offset 1 (ISO: two). An unknown currency is refused (`ADS_CURRENCY_UNSUPPORTED`). Budgets, `amount_spent` and the account `spend_cap` are read as integer minor units; insights `spend` is a major-unit decimal text. Writes of budgets use minor units. The account `spend_cap` is **read in minor units but written in major units** (decimal text, `microsToMetaMajor`). A conversion that is not exact throws (`ADS_AMOUNT_NOT_REPRESENTABLE`, 422) and never rounds; a malformed Meta value is `ADS_PROVIDER_RESPONSE_INVALID` (502).

**Test hook.** `setMetaAdsFetchForTests(fetch | null)` replaces the transport and throws `test only` unless `VITEST=true` or `NODE_ENV=test`. Tests use the in-memory fake Graph `apps/api/tests/support/fake-meta-graph.ts` (it records misses so misrouted calls fail a test); no test opens a socket or calls Meta.

**Open.** Task 6 (contract tests on sanitized A0 recordings) waits for the A0 spike's groups G2 and G4.

**Open items for later steps.**

- Numeric-string error codes and empty error objects are not handled by the classifier (A0 Task 6 decides with real recordings).
- `blame_field_specs` parsing is lossy and unbounded, and `error_data` can be a JSON string; fix before A7 persists field paths.
- The write helpers accept negative micros; A7 or the builder must validate.
- Usage headers on failed answers are read only for rate-limit rows; A4 decides whether to record them for every failure.
- An insights page larger than 8 MB fails as `RESPONSE_TOO_LARGE` (not retryable); A4 lowers `limit` for oversized pages.

## Routes

| Route | Permission |
|---|---|
| `GET /api/projects/:projectId/ads/status` | `ads.read` |

It returns module version, settings and settings version.

## Web

`apps/web/src/modules/ads/`: editor-only (`minAccess: "editor"`), opt-in, group order 13 (after Social). Six placeholder views (overview, campaigns, ad units, creatives, performance, accounts) with English and German empty-state texts.

## Rollout and rollback

Nothing is deployed. The migration changes the production schema hash to `e3cb3759169fde49c7aaf6b859b7b9f0fb80e1b0164cb7e3e2eabd32f03f5dd0` (`sh scripts/check-pve-schema.sh --print-hash`); Mario must approve this hash in Coolify before any push to `main` that contains it (`docs/deployment/COOLIFY.md`). Rollback before deployment: revert the branch. After deployment the tables are empty and inert while the flag is off; dropping them needs a separate approved migration.

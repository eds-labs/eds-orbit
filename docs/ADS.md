# Ads module (`ads`)

The ads module is meant to connect a project's ad accounts and manage paid advertising (campaigns, budgets, reporting) without a managed intermediary. Decision: [ADR 0025](adr/0025-ads-module.md) (proposed). Programme plan: [superpowers/plans/2026-11-07-ads-module.md](superpowers/plans/2026-11-07-ads-module.md) (requirements R1–R12, decisions A-D1–A-D19). Step A1 plan: [superpowers/plans/2026-11-08-ads-a1-module-skeleton.md](superpowers/plans/2026-11-08-ads-a1-module-skeleton.md).

State on 2026-11-09: **step A1 (module skeleton) is on `main`.** `ORBIT_ADS` is off. The module has a manifest, permissions, gate, settings, one status route, four empty tables and six placeholder views. It connects no ad account and calls no provider; accounts, campaigns and reports come in later steps (A2 onward).

State on 2026-11-11: **step A3 (Meta connection and ad accounts) is implemented and tested locally on branch `claude/eds-orbit-ads-module-plan-3228d2`; not pushed, not merged, not deployed.** `ORBIT_ADS` stays off. No migration (A3 adds no schema change; the hash equals `origin/main`'s `7003d212…`), no new flag, no new dependency. See "Meta connection and ad accounts (A3)" below. Nothing has been checked against live Meta yet (see the A0 dependencies table below).

Open: Task 0 of the A1 plan (the A-D1 ad-blocker test of the module id `ads` in uBlock Origin, AdGuard and Brave) has no valid result yet. The checks on 2026-11-08 and 2026-11-09 ran without an active blocker (the BAIT probe loaded), so they proved nothing. Mario decided on 2026-11-09 that the test gates enabling `ORBIT_ADS`, not the push to `main`; a browser counts only when its BAIT rows are red. The implementation uses `ads` by a recorded ruling; if the test shows blocking, the plan's rename table switches id and path to `advertising` before the flag goes on.

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

## Meta connection and ad accounts (A3)

Code: `apps/api/src/modules/ads/accounts/` (`app`, `connect`, `oauth-state`, `vault`, `accounts`, `account-settings`, `health`, `cleanup`, `data-deletion`, `providers`); web: `apps/web/src/modules/ads/accounts.tsx` and `account-picker.tsx`. Status: implemented and tested locally, not pushed.

**Admin setup (before the first connect).**

1. Create the Meta app and its Facebook Login for Business configuration as in the A0 spike plan §2.2 (new app in the business portfolio "EDS Labs", not the Social app). The ads configuration carries the `ads_management` and `ads_read` permissions. For reporting-only installations the configuration may grant only `ads_read`: the accounts then stay `read_verified` and no write capability is ever offered (least privilege, plan §11).
2. Register the redirect URI `<APP_ORIGIN>/api/ads/oauth/callback/meta` (the route is `/api/ads/oauth/callback/:provider`).
3. Register the data-deletion callback URL `<APP_ORIGIN>/api/callbacks/ads/meta-data-deletion`. It needs `ORBIT_PUBLIC_INGRESS=true`.
4. In the administration add the system connection `ads.app.meta` (secret fields `appId`, `appSecret`, `configId`) and grant it to the organization or project for purpose `ads_oauth` and module `ads`. Until it is granted, a project owner sees "not granted" and cannot connect.

**Providers.** `ads.app.meta` is the system connection (purpose `ads_oauth`, module `ads`). `ads.account.meta` is the module-managed project connection (purpose `ads_manage`) that holds one user's token and the accounts it granted; members never edit it in the generic connection list.

**OAuth.** Facebook Login for Business with `config_id`; the state is a one-time `AdOAuthState` row. The code is exchanged by a POST with a form body (A0 Q20). Identity and scopes come from `GET /me` and `GET /me/permissions` with the user's own token (Bearer plus `appsecret_proof`); there is no `debug_token` call, so the token never appears in a URL. A token answer with `expires_in` is a user token (60 days; a short-lived token is exchanged for a long-lived one); an answer without it is a system-user token with no expiry. After the callback the owner picks from the granted accounts: the picker lists up to 1000 (10 pages of 100; a longer list is marked truncated) and assigns the chosen ones.

**One connection per (project, Meta user, app).** A reconnect by the same Meta user rotates the sealed secret and re-reads up to 20 of the accounts that wait for a reconnect (20 is the re-read cap; the others are due for a health check at once). The restore applies only to a row that still waits on this connection (an unlink in between wins), takes the provider's status (`active` or `disabled`) and recomputes the capability (`write_verified` stays only while writing is possible). A reconnect onto a connection an administrator disabled is refused with `?error=ADS_CONNECTION_DISABLED`: it neither rotates that secret nor creates a new connection.

**One project per ad account and organization.** The claim lives in the connection config (`assignedAdAccounts`) through the platform helpers `claimExclusiveConfigValue` and `releaseExclusiveConfigValue` (`apps/api/src/platform/connections/project-secrets.ts`, advisory lock per organization and value), because the auth role cannot read `AdAccount` across projects. A disabled connection keeps its claims; only revocation frees them. Unlinking keeps the `AdAccount` row (`status = unlinked`, sync-state deleted, claim released); the connection is revoked when no non-unlinked account uses it and it holds no claim.

- **Every Ads revocation forgets the person.** Owner revoke, unlink of the last account, the unused clean-up, an unrecorded connect and data deletion all pass the optional `forget` input of `revokeProjectConnection`: in the same transaction the revoked row is labelled "Meta (deleted)" and `metaUserId` becomes null. A revoked row is never used again.
- **Unused revocation only without claims.** An "unused" revocation (unlink of the last account, clean-up) passes the platform option `onlyIfConfigEmpty: "assignedAdAccounts"`: under the connection lock a connection that holds any claim (an assignment that claimed but has not yet written its row) is left alone. Owner revoke and data deletion revoke unconditionally.
- **Assignment re-check.** After an assignment commits, the connection is checked again; revoked or disabled meanwhile, the row is unlinked, the claim released and the answer is 409 `ADS_ACCOUNT_RECONNECT_REQUIRED`. The update of an existing row is conditional on the version read (409 `ADS_VERSION_CONFLICT`, claim released).

**Disabled connections.** An administrator can disable an `ads.account.meta` connection (reversible). Orbit then opens no secret of it: the account picker and assignment answer 404, `grantCredentials` refuses with 409 `ADS_CONNECTION_DISABLED`, health records that code on the checked accounts' streams without a token call, flip, failure count or notification, and a reconnect is refused. `GET /connections` reports `disabled: true`; the owner sees "Von der Administration deaktiviert" and no "Konten auswählen" for it, but can still revoke it. The connection keeps its claims, so its accounts stay blocked for other projects until it is revoked.

**Account settings.** DSA fields `dsaBeneficiary` and `dsaPayor` (enforced from A8) and the `writesEnabled` switch. The switch is stored and audited now but has no effect until A7; turning it on needs capability `write_ready` and status `active`. It is cleared whenever the capability drops to `read_verified` or the status leaves `active` (health read, reconnect flip, reconnect restore).

**Health.** Periodic task `ads-account-health` every 6 hours (10 accounts and 30 seconds per project and run): an expired token becomes `reconnect_required` without a call; a warning goes out 14 days before expiry, once per expiry date; a refused token or a lost ads permission flips all accounts of the connection once with one owner notification; outages (transient, rate limit) only record health and never notify; `reconnect_required` accounts are probed too and restored when readable again; a failure of Orbit's own write after a successful read is thrown, not recorded as an outage. An account moved to another connection starts with a fresh health stream. Clean-up task `ads-oauth-state-cleanup`: old OAuth states, connections without accounts and claims (24 hours after creation and 10 minutes after their last change), stale claims (10 minutes). Audit rows and notifications carry codes only: no token, account name or provider message.

**Data deletion.** `POST /api/callbacks/ads/meta-data-deletion` (signed request, HMAC-SHA256) unlinks every account of that Meta user's ads connections in every organization, revokes those connections with `forget`, and answers `{url, confirmation_code}`. An account or connection that somebody removed meanwhile counts as done and every connection is tried; a request that failed somewhere answers 500 `ADS_DATA_DELETION_INCOMPLETE` without a confirmation code. `GET /api/public/ads/data-deletion/:code` shows the status; the web page is `/data-deletion/ads`. The code is self-verifying (key info `orbit-ads-data-deletion-v1`), so no request and no personal data are stored. Both routes need `ORBIT_PUBLIC_INGRESS=true`. **While `ORBIT_ADS` is off both answer 404 `ADS_DISABLED`**, so Meta's deletion requests cannot reach stored ad tokens while the flag is off: switch the flag on (or revoke the connections by hand) before relying on the callback.

**Tokens.** Sealed `ConnectionSecret`s only; no route, audit, notification, event or error returns a token (leak-scan tests cover every OAuth flow).

**Open.**

- The questions in the A0 dependencies table below decide the live behaviour; the fallbacks are one-function changes.
- Mario's legal wording check of the German and English texts of the data-deletion status page is open.
- Follow-up for Social (not changed in A3): Social keeps the person's name and id on revoked Social connections after a deletion request; Ads clears them with `forget` on every revocation.
- Independent security review before the first production use (SECURITY_REVIEW.md, A12).

### A0 dependencies of A3 (answered before live check L1)

| Assumption in A3 | A0 question | Fallback |
|---|---|---|
| `POST /oauth/access_token` with a form body works for the code and the long-lived exchange | Q20 | GET with query |
| User tokens answer with `expires_in`; a system-user token from configuration B answers without it | Q2, Q21 | change `tokenTypeOf` |
| `GET /me/permissions` returns `{data: [{permission, status}]}` with the user token | Q22 | read scopes from `debug_token` with the token in a POST body |
| Ad accounts expose `user_tasks` (`MANAGE`, `ADVERTISE`, `ANALYZE`) | Q23 | drop the field; capability from scopes only |
| `appsecret_proof` is accepted with the app token for the app check | Q13 | check the app with `GET /{appId}` without proof |
| The `user_id` in Meta's `signed_request` equals `GET /me` `id` of a user token | Q24 | also match `businessId` grants |
| Meta accepts a `localhost` redirect for the unpublished app | Q14 | test on a preview host |

## Routes

| Route | Permission |
|---|---|
| `GET /api/projects/:projectId/ads/status` | `ads.read` |
| `GET /api/projects/:projectId/ads/accounts` | `ads.read` |
| `GET /api/projects/:projectId/ads/connections` | `ads.accounts.manage` |
| `POST /api/projects/:projectId/ads/connections/meta/connect` | `ads.accounts.manage` |
| `GET /api/projects/:projectId/ads/connections/:connectionId/available-accounts` | `ads.accounts.manage` |
| `POST /api/projects/:projectId/ads/connections/:connectionId/revoke` | `ads.accounts.manage` |
| `POST /api/projects/:projectId/ads/accounts` (assign an available account) | `ads.accounts.manage` |
| `PATCH /api/projects/:projectId/ads/accounts/:accountId` (DSA fields, write switch) | `ads.accounts.manage` |
| `POST /api/projects/:projectId/ads/accounts/:accountId/unlink` | `ads.accounts.manage` |
| `POST /api/projects/:projectId/ads/accounts/:accountId/check` | `ads.accounts.manage` |
| `GET /api/ads/oauth/callback/:provider` | the signed-in owner who started the flow (`ads.accounts.manage`) and its one-time state; no public ingress needed |
| `POST /api/callbacks/ads/meta-data-deletion` | signed request, `ORBIT_PUBLIC_INGRESS` |
| `GET /api/public/ads/data-deletion/:code` | self-verifying code, `ORBIT_PUBLIC_INGRESS` |

The status route returns module version, settings and settings version.

## Web

`apps/web/src/modules/ads/`: editor-only (`minAccess: "editor"`), opt-in, group order 13 (after Social). Six views (overview, campaigns, ad units, creatives, performance, accounts); since A3 the accounts view is "Konten & Verbindungen" (owners connect, see the connection list with token type, expiry, account count, permissions and the administration's disabled badge, pick accounts and revoke per connection, edit DSA fields, toggle the inert write switch, check, reconnect and unlink; editors see the account list read-only; viewers see nothing); the others stay placeholders with English and German empty-state texts. Public status page `/data-deletion/ads`.

## Rollout and rollback

A1 and A2 are deployed on `main` since 2026-11-09 with `ORBIT_ADS` off (inert tables, no provider call). A3 is local only (branch, not pushed). The production schema hash is set in Coolify per migration and is currently `origin/main`'s (`7003d212a05fb497af8935f4606e21dd6bb8910cd942e710e837837b9e12fee1`, from `sh scripts/check-pve-schema.sh --print-hash`); A3 adds no schema change, so it needs no approval of its own (`docs/deployment/COOLIFY.md`). Rollback before deployment: revert the branch. After deployment the ads tables stay empty and inert while the flag is off; dropping them needs a separate approved migration.

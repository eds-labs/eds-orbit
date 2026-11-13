# Ads A3 — Meta Connection and Ad Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner connects Meta through Facebook Login for Business, picks the ad accounts the grant covers, assigns each to exactly one project of the organization, and Orbit keeps the connection healthy: token stored sealed, expiry warned 14 days ahead, refused tokens and lost permissions turned into `reconnect_required`, Meta's data-deletion request honoured. Nothing reads campaigns or spends money yet.

**Architecture:** The Meta adapter gains a `connect` part (`providers/meta/auth.ts`, `providers/meta/accounts.ts`) that speaks only through the A2 transport. The module's `accounts/` folder owns the OAuth state, the grant vault on top of `platform/connections/project-secrets.ts`, assignment, health, clean-up and data deletion; `routes/accounts.ts` exposes them. One project connection `ads.account.meta` per project, Meta user and developer app holds the sealed token and can cover several `AdAccount` rows. "One project per ad account and organization" is enforced by a small platform helper that claims a value in a connection's config under an advisory lock. The web view "Konten & Verbindungen" replaces the placeholder.

**Tech Stack:** TypeScript, Fastify 5, Prisma 7 / PostgreSQL 17 (FORCE RLS), zod 4, Vitest, Next.js 16 client components. No new dependency, no migration, no new flag.

**Spec:** programme plan [`2026-11-07-ads-module.md`](2026-11-07-ads-module.md) (§2.2, §2.6 rows "Login and tokens", "Permissions and review", "Money", "Conversions API and data deletion"; §4.1 `connect`; §4.2; §5 `AdAccount`, `AdOAuthState`, `AdSyncState`, credentials paragraph; §6.2 account rows; §6.8 event `ads.account.reconnect_required`; §7.1 row "Konten & Verbindungen"; §10 `ads-account-health`, `ads-oauth-state-cleanup`; §11; §12.1 row A3; §13), [ADR 0025](../../adr/0025-ads-module.md) (A-D2, A-D3, A-D17), `docs/SECURITY_REVIEW.md` lines 12-19. Builds on A1 ([`2026-11-08-ads-a1-module-skeleton.md`](2026-11-08-ads-a1-module-skeleton.md)) and A2 ([`2026-11-08-ads-a2-provider-seam.md`](2026-11-08-ads-a2-provider-seam.md)), both on `main` since 2026-11-09.

## Risk analysis, tests, rollback (AGENTS.md, risk `high`)

- **Why high:** OAuth with third-party tokens, a public callback, tenant isolation across projects of one organization, a platform change to connections. **Production effect: none while `ORBIT_ADS` stays off** (every route answers 404 `ADS_DISABLED`, periodic tasks return `null` from `nextDueAt`). No migration, so the approved schema hash stays unchanged (note 2026-11-11: main's hash moved to `7003d212…` through other sessions' migrations; A3 keeps whatever main has); no flag, so the PVE compose stays as is.
- **Threats and the test that pins each:** state replay or theft (Task 4: reused, expired, other member, other project, other app); open redirect (Task 4: `redirectAfter` outside `/p/:id/ads`); token leak into URLs, responses, audit, events, notifications (Tasks 3–7: leak scan with recognizable fake tokens); cross-project use of a connection (Task 5: other project's `connectionId` → 404); double assignment of an ad account (Tasks 1, 5: concurrent claims); forged data-deletion request (Task 7: wrong secret, Social's secret, stale `issued_at`); escalation by editors and viewers (Task 5 and the access matrix).
- **Test strategy:** unit tests against the in-memory fake Graph (`apps/api/tests/support/fake-meta-graph.ts`), integration tests per task in the worktree's own test database, the access matrix regenerated and reviewed as a security change, web tests with Testing Library. No test opens a socket or reaches Meta.
- **Rollback:** revert the A3 commits on `main`. Nothing to clean in production while the flag is off. Locally created connections are revoked by unlinking their accounts (or by the clean-up task after 24 h).

## Global Constraints

- Environment `local`; branch `claude/eds-orbit-ads-module-plan-3228d2` from `origin/main` `9a90b828`. Push to `main` only after Mario's go (`AGENTS.md`, "Main delivery workflow"). Workflow `.agentic/workflows/feature.md`; gates `definition-of-done.md`, `review-checklist.md`, `security-checklist.md`.
- No live Meta call from code or tests. The first real connection is live check L1 in A12 and needs Mario's go and the A0 answers listed under "A0 dependencies".
- Tokens and app secrets live only in sealed `ConnectionSecret`s, the `authorization` header, the `appsecret_proof` input and the POST form body of the code exchange. Never in URLs Orbit builds, logs, audit metadata, events, notifications, error messages, API responses, `AdAccount` rows or test snapshots.
- Connection writes only through `platform/connections/project-secrets.ts`. App secrets are read with `connectionSecret` right before use.
- Every project route runs through `inAds` (`apps/api/src/modules/ads/http-scope.ts`). The OAuth callback checks `ADS_ACCOUNTS_MANAGE` and `requireAds` itself. Public routes use the existing prefixes `/api/callbacks/` and `/api/public/`, which exist only while `ORBIT_PUBLIC_INGRESS=true` (`apps/api/src/server.ts`, `platform/http/webhooks.ts`).
- Paths use the module id `ads` (A-D1 ruling). Every new path is added to the A1 plan's table "Rename if A-D1 says `advertising`".
- Money from Meta goes through `metaMinorToMicros` (`providers/meta/money.ts`); a currency outside `META_CURRENCY_OFFSETS` is refused with `ADS_CURRENCY_UNSUPPORTED`, never guessed.
- Error codes: `ADS_` prefix, `^ADS_[A-Z0-9_]{1,60}$`; DomainError messages are codes only.
- User-facing strings `de` and `en` (typed `labels.ts`); no `ad`, `ads`, `advert`, `banner` or `sponsor` in DOM ids, CSS classes or asset paths. Read `apps/web/node_modules/next/dist/docs/` before web work (`apps/web/AGENTS.md`).
- English in code, comments and docs.

## Rulings made while planning

| # | Ruling | Why | Cost if wrong |
| --- | --- | --- | --- |
| P1 | **No migration.** Health lives in `AdSyncState` (stream `health`); the provider's account status in `AdAccount.providerStatus` as `NAME` or `NAME:<disable_reason>`; token type and expiry are duplicated (non-secret) in the connection's config for display. | All needed columns exist since A1; a migration would need a new approved schema hash. | One migration later if a column is really missing. |
| P2 | **No `debug_token`.** Identity and scopes come from `GET /me` and `GET /me/permissions` with the user's own token (Bearer + `appsecret_proof`, A2 client). The code exchange is a POST with a form body. | `debug_token` puts the token into the URL. | If Meta refuses POST on `/oauth/access_token` (A0 Q20), switch the exchange to GET; the bounded transport logs no URLs. |
| P3 | **Token type by answer:** `expires_in` present → `user` (exchanged for a long-lived token when under 7 days); absent → `system_user` with `expiresAt = null`. | One code path for both FLfB configurations (A-D3) without `debug_token`. | A0 Q2/Q21 may show another signal; the inference is one function. |
| P4 | **One connection per (project, Meta user, app).** A reconnect by the same Meta user rotates the secret and re-checks that connection's accounts. | Mirrors Social's `saveConnectedAccount`; no orphan tokens. | — |
| P5 | **Exclusive claim in connection config** (`assignedAdAccounts: string[]`), via a new platform helper in `project-secrets.ts` with an advisory lock per organization and value. | The auth role cannot read `AdAccount` across projects (FORCE RLS, no grant), so the check must live on `Connection`. | The helper is generic; a dedicated table later would replace it. |
| P6 | **Unlink keeps the `AdAccount` row** (`status = "unlinked"`), deletes its `AdSyncState` rows and releases the claim. The connection is revoked (token wiped) when no non-unlinked account uses it; connections without any account are revoked by the clean-up after 24 h. | `AdAccount` has no DELETE grant (restricted table); later steps reference accounts. | — |
| P7 | **Data-deletion codes** use Social's self-verifying design with their own key info `orbit-ads-data-deletion-v1`; the request unlinks every account of that Meta user's connections in every organization and revokes those connections. | No stored request, no personal data kept. | — |
| P8 | **`writesEnabled` is stored and audited now but has no effect until A7.** Turning it on needs `capability = "write_ready"` and `status = "active"`. | The REST contract (§6.2) puts it on the accounts page. | — |
| P9 | **`AdsProvider.connect`** is provider-neutral (`clientId`, `clientSecret`, `configId?`), so Google (G1) can implement it; OpenAI has no OAuth and leaves it out (`connect?`). | §4.1. | — |
| P10 | **Account settings start with the DSA fields** (`dsaBeneficiary`, `dsaPayor`, A-D16), edited on the accounts page; A8 enforces them. | They belong to the ad account (A-D16). | Two optional fields. |
| P11 | **"E2E connect with the fake provider" (§12.1 A3) is an HTTP-level integration test** (begin → callback → available accounts → assign → list, through `app.inject`) plus the web component tests. No Playwright run. | The fake Graph is in-process; a Playwright run would need a provider override in production code, which A2 ruled out. | A Playwright connect test once a test-mode server hook exists. |
| P12 | **`POST /accounts/:id/sync` is A4's**, not A3's. | Structure sync starts in A4. | — |

## A0 dependencies (answers needed before live check L1, not before implementation)

| Assumption in A3 | A0 question | Fallback |
| --- | --- | --- |
| `POST /oauth/access_token` with a form body works for the code and the long-lived exchange | Q20 (new) | GET with query (P2) |
| User tokens answer with `expires_in`; a system-user token from configuration B answers without it | Q2, Q21 (new) | change `tokenTypeOf` |
| `GET /me/permissions` returns `{data: [{permission, status}]}` with the user token | Q22 (new) | read scopes from `debug_token` with the token in a POST body |
| Ad accounts expose `user_tasks` (`MANAGE`, `ADVERTISE`, `ANALYZE`) | Q23 (new) | drop the field; capability from scopes only |
| `appsecret_proof` is accepted with the app token for the app check | Q13 | check the app with `GET /{appId}` without proof |
| The `user_id` in Meta's `signed_request` equals `GET /me` `id` of a user token | Q24 (new) | also match `businessId` grants |
| Meta accepts a `localhost` redirect for the unpublished app | Q14 | test on a preview host |

Task 9 adds Q20–Q24 to the A0 spike plan §5 and makes its exchange command a POST.

## Review Focus

1. **Callback finished by another person or browser** (owner A starts, owner B or a signed-out browser returns with the code). Expect: redirect with `ADS_OAUTH_STATE_INVALID` (or 401 without a session), no exchange call, no connection. Pinned in Task 4.
2. **Same ad account assigned in two projects of one organization at the same moment.** Expect: exactly one assignment succeeds, the other gets 409 `ADS_ACCOUNT_ASSIGNED_ELSEWHERE`; a project of another organization may assign it. Pinned in Tasks 1 and 5.
3. **Reconnect after expiry with fewer accounts granted.** Expect: the same connection gets the new token; still-granted accounts become `active`; an account no longer granted stays `reconnect_required` with `ADS_META_ACCOUNT_NOT_GRANTED`; no second connection. Pinned in Task 4.
4. **Meta outage during the health check** (5xx, timeout). Expect: no `reconnect_required`, no notification; only `lastErrorCode` and `consecutiveFailures` on the health stream, next try in 6 h. Pinned in Task 6.
5. **Data-deletion request signed with the Social app's secret.** Expect: 400 `ADS_SIGNED_REQUEST_INVALID`, nothing changed; signed with the Ads app's secret, every Ads connection of that Meta user in every organization is revoked and its accounts unlinked. Pinned in Task 7.

---

### Task 1: Exclusive config claims on project connections (platform)

**Files:**
- Modify: `apps/api/src/platform/connections/project-secrets.ts`
- Test: `apps/api/tests/connection-claims.integration.test.ts`

**Interfaces:**
- Produces:
  - `claimExclusiveConfigValue(scope: Scope, input: { moduleId: string; connectionId: string; key: string; value: string }): Promise<void>` — in one `authDb` transaction: `pg_advisory_xact_lock(hashtext('connection-claim:' || <provider> || ':' || <workspaceId> || ':' || key || ':' || value))`, the existing ownership check (`owned`), refuses with `DomainError("CONNECTION_VALUE_CLAIMED", 409)` when another active (not revoked, not disabled) connection of the **same provider and organization but another project** has `value` in `config[key]`; otherwise appends `value` to `config[key]` (deduplicated, at most 500 entries, else `CONNECTION_CLAIMS_FULL` 409) and increments `version`. Connections of the same project do not block (an account may move between the project's connections).
  - `releaseExclusiveConfigValue(scope, input: same shape): Promise<void>` — removes the value; no error when absent.
  - `key` must match `^[a-zA-Z][a-zA-Z0-9]{1,40}$` and `value` `^[A-Za-z0-9_:.-]{1,100}$` (else `CONNECTION_CLAIM_INVALID` 400).

- [ ] **Step 1: Write the failing tests** (two organizations, three projects; the module-managed provider `social.account.facebook` with `moduleId: "social"`, created through `createProjectConnection`, so the test does not depend on Task 2):
  - `claims a value once per organization`: claim `act_1` on project A's connection → ok; claim on project B (same org) → `CONNECTION_VALUE_CLAIMED`; claim on project C of the other org → ok.
  - `the same project may hold the value on two connections`.
  - `a revoked connection does not block`: revoke A's connection → B's claim succeeds.
  - `concurrent claims: exactly one wins` — `Promise.allSettled` of 2 claims from A and B → one fulfilled, one rejected with `CONNECTION_VALUE_CLAIMED`.
  - `release frees the value`; `invalid key or value → CONNECTION_CLAIM_INVALID`; `another module's connection → PROVIDER_NOT_MANAGED`.
- [ ] **Step 2: Run** `pnpm exec vitest run --env-file .runtime/test.env apps/api/tests/connection-claims.integration.test.ts` (after `node scripts/test-db-for-worktree.ts`) → FAIL.
- [ ] **Step 3: Implement** both functions next to `withProjectSecret`; system audit `connection.config_claimed` / `connection.config_released` with `{provider, key}` only (no value).
- [ ] **Step 4: Verify** → PASS; `apps/api/tests/connections.integration.test.ts` and `connection-cutover.integration.test.ts` unchanged and PASS.
- [ ] **Step 5: Commit** `feat(connections): exclusive config claims across projects of an organization`.

### Task 2: Connection providers and the developer app

**Files:**
- Create: `apps/api/src/modules/ads/accounts/app.ts`, `apps/api/src/modules/ads/accounts/providers.ts`, `apps/api/tests/support/ads-fixtures.ts`
- Modify: `apps/api/src/modules/ads/contributions.ts`
- Test: `apps/api/tests/ads-app.test.ts`, `apps/api/tests/ads-app.integration.test.ts`; update lists in `apps/api/tests/module-contributions.test.ts` if it enumerates connection providers

**Interfaces:**
- Produces from `accounts/app.ts`:
  - `metaAdsAppSecret` — zod strict `{ appId: /^\d{5,20}$/, appSecret: min 16 max 200, configId: /^\d{5,20}$/ }`.
  - `adsAppCredentials(tx: DbTx, scope: Scope): Promise<{ connectionId: string; clientId: string; clientSecret: string; configId: string }>` — `resolveConnection(tx, scope, { provider: "ads.app.meta", purpose: "ads_oauth", module: "ads" })`; missing → `ADS_META_APP_NOT_GRANTED` 409; unparsable → `ADS_META_APP_INVALID` 500.
  - `type AdsAppReadiness = "ready" | "project_not_granted" | "not_granted" | "invalid"`; `adsAppReadiness(tx, scope): Promise<AdsAppReadiness>` — same logic as Social's `appReadiness` (`social/accounts/apps.ts:74-109`), boolean-only auth-role lookup.
  - `adsRedirectUri(config: { APP_ORIGIN: string }): string` → `<origin>/api/ads/oauth/callback/meta`.
- Produces from `accounts/providers.ts`: `adsConnectionProviders: Record<string, ConnectionProvider>`:
  - `"ads.app.meta"`: `scopes: ["system"]`, `purposes: ["ads_oauth"]`, label `{ en: "Meta app for ads", de: "Meta-App für Werbung" }`, `callbackPath: "/api/ads/oauth/callback/meta"`, `secretFields` appId / appSecret (secret) / configId with hints naming the **ads** Facebook Login for Business configuration, `validateSecret` (422 `ADS_META_APP_INVALID`, no echo), `check`: `GET /{appId}?fields=id,name` through `createMetaGraphClient({ accessToken: "<appId>|<appSecret>", appSecret })` → `{ status: "read_verified", capabilities: ["ads_oauth"] }`, failure → `ADS_META_APP_CHECK_FAILED` 409.
  - `"ads.account.meta"`: `scopes: ["project"]`, `managedByModule: true`, `purposes: ["ads_manage"]`, label `{ en: "Meta ad access", de: "Meta-Werbezugang" }`, `checkUnsupported: "ADS_CONNECTION_CHECK_IN_MODULE"`.
- `contributions.ts` adds `connections: { providers: adsConnectionProviders }`.
- `apps/api/tests/support/ads-fixtures.ts`: `ADS_META_APP = { appId: "2234567890", appSecret: "ads-app-secret-0123456789", configId: "8876543210" }`, `createAdsProject(opts?)` (owner, editor, viewer, module row enabled; returns ids, cookies, scope helpers), `grantAdsMetaApp(project, secret = ADS_META_APP)`, `fakeToken(label)` returning `EAAB<label><16 random hex>` for leak scans, `expectNoSecret(haystack: unknown, secrets: string[])`.

- [ ] **Step 1: Write the failing tests:** unit — `metaAdsAppSecret` accepts the fixture, refuses extra keys and short secrets; the `check` sends exactly one `GET /2234567890` with `fields=id,name`, an `authorization` header and an `appsecret_proof`, and no secret in the URL (fake Graph); a 400 answer → `ADS_META_APP_CHECK_FAILED`. Integration — readiness is `not_granted` without the system connection, `project_not_granted` with only the organization grant, `ready` with the project grant, `invalid` with a malformed stored secret; the administration provider list contains both providers; the generic `connector` action does not accept `ads.account.meta` (it filters module-managed providers, `platform/http/platform-actions.ts:163-169`), so a request with that provider fails its validation.
- [ ] **Step 2: Run** both files → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `apps/api/tests/ads-module.test.ts` and `module-contributions.test.ts` PASS.
- [ ] **Step 5: Commit** `feat(ads): Meta app and ad access connection providers`.

### Task 3: The Meta adapter's `connect` part

**Files:**
- Create: `apps/api/src/modules/ads/providers/meta/auth.ts`, `apps/api/src/modules/ads/providers/meta/accounts.ts`
- Modify: `apps/api/src/modules/ads/providers/types.ts`, `apps/api/src/modules/ads/providers/meta/provider.ts`
- Test: `apps/api/tests/ads-meta-connect.test.ts`

**Interfaces:**
- Produces in `providers/types.ts`:
  - `ProviderApp = { clientId: string; clientSecret: string; configId?: string }`
  - `ProviderGrant = { accessToken: string; tokenType: "user" | "system_user"; expiresAt: Date | null; userId: string; userName: string | null; grantedScopes: string[] }`
  - `ProviderAccount = { externalId: string; name: string; currency: string; timezone: string; providerStatus: string; status: "active" | "disabled"; businessId: string | null; businessName: string | null; spendCapMicros: bigint | null; amountSpentMicros: bigint | null; canWrite: boolean; currencySupported: boolean }`
  - `AdsProvider.connect?: { authorizeUrl(input: { app: ProviderApp; redirectUri: string; state: string }): string; finish(input: { app: ProviderApp; redirectUri: string; code: string }): Promise<ProviderGrant>; scopes(input: { app: ProviderApp; accessToken: string }): Promise<string[]>; listAccounts(input: { app: ProviderApp; accessToken: string; grantedScopes: string[] }): Promise<{ accounts: ProviderAccount[]; truncated: boolean }>; readAccount(input: { app: ProviderApp; accessToken: string; grantedScopes: string[]; externalId: string }): Promise<ProviderAccount> }`
- Values pinned for Meta:
  - Dialog `https://www.facebook.com/v27.0/dialog/oauth` with `client_id`, `redirect_uri`, `state`, `config_id`, `response_type=code`, `override_default_response_type=true` (from `META_ADS_API_VERSION`, never Social's constant).
  - Exchange `POST /oauth/access_token` form `{client_id, client_secret, redirect_uri, code}`; when `expires_in` < 604800 s, `POST /oauth/access_token` form `{grant_type: "fb_exchange_token", client_id, client_secret, fb_exchange_token}`. Answers parsed with zod `{ access_token: string min 1, token_type?: string, expires_in?: int >= 0 }`. These two calls use `metaAdsFetch` directly (no bearer yet) and classify failures with `classifyMetaFailure({ write: false, … })`.
  - Identity `GET /me` `fields=id,name`; scopes `GET /me/permissions` → granted `permission` values sorted; neither `ads_read` nor `ads_management` granted → `AdsProviderError` code `ADS_META_PERMISSION_MISSING`, kind `permission`.
  - Accounts `GET /me/adaccounts` with `AD_ACCOUNT_FIELDS = "id,account_id,name,currency,timezone_name,account_status,disable_reason,business{id,name},amount_spent,spend_cap,user_tasks"`, `limit=100`, at most 10 pages (then `truncated: true`); one account `GET /act_<digits>` with the same fields; `externalId` must match `^act_\d{1,32}$` else `ADS_ACCOUNT_ID_INVALID`.
  - Status map: `1 ACTIVE`, `2 DISABLED`, `3 UNSETTLED`, `7 PENDING_RISK_REVIEW`, `8 PENDING_SETTLEMENT`, `9 IN_GRACE_PERIOD`, `100 PENDING_CLOSURE`, `101 CLOSED`, `201 ANY_ACTIVE`, `202 ANY_CLOSED`, other → `CODE_<n>`; `status = "disabled"` for 2, 100, 101, else `"active"`; `providerStatus = NAME` or `NAME:<disable_reason>` when `disable_reason` > 0.
  - Money: `spend_cap` `"0"` or missing → `null`; otherwise `metaMinorToMicros(value, currency)` for `spend_cap` and `amount_spent`; unknown currency → `currencySupported: false` and both amounts `null`.
  - `canWrite = grantedScopes.includes("ads_management") && (user_tasks absent || user_tasks includes "MANAGE" || "ADVERTISE")`.

- [ ] **Step 1: Write the failing tests** with `installFakeMetaGraph()`:
  - `authorizeUrl` contains `config_id=8876543210`, `state`, the redirect, version `v27.0`, no `scope` and no secret.
  - `finish` with a short-lived answer (`expires_in: 3600`) makes two POSTs, returns `tokenType: "user"` and `expiresAt` ≈ now + 5183944 s from the long-lived answer; with an answer without `expires_in` it makes one POST and returns `tokenType: "system_user"`, `expiresAt: null`.
  - `for every request: no access token, code or client secret in the URL query` — iterate `fake.requests`, check `request.query.toString()` against all secrets; the code and secret appear only in `request.form`.
  - `finish` refuses when `/me/permissions` grants only `pages_show_list` → `ADS_META_PERMISSION_MISSING`.
  - `listAccounts` maps EUR `spend_cap: "50000"` to `500_000_000n`, `amount_spent: "1234"` to `12_340_000n`, JPY `"1500"` to `1_500_000_000n`, `spend_cap: "0"` to `null`, `account_status: 2, disable_reason: 3` to `status: "disabled"`, `providerStatus: "DISABLED:3"`; a currency `"XYZ"` gives `currencySupported: false`; 11 pages → 10 requested, `truncated: true`.
  - `readAccount("act_12x")` → `ADS_ACCOUNT_ID_INVALID` without a request; a 190 answer → `AdsProviderError` kind `auth`; a 500 answer → kind `transient`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/api/tests/ads-meta-connect.test.ts` → FAIL.
- [ ] **Step 3: Implement** `auth.ts` (authorize, exchange, `tokenTypeOf(expiresIn?: number): "user" | "system_user"`, identity, scopes) and `accounts.ts` (fields, mapping, list, read); wire `connect` into `metaAdsProvider`.
- [ ] **Step 4: Verify** → PASS; `ads-providers.test.ts`, `ads-meta-graph.test.ts` PASS.
- [ ] **Step 5: Commit** `feat(ads): Meta login, permissions and ad account discovery`.

### Task 4: OAuth state, connect and callback

**Files:**
- Create: `apps/api/src/modules/ads/accounts/oauth-state.ts`, `apps/api/src/modules/ads/accounts/connect.ts`, `apps/api/src/modules/ads/accounts/vault.ts`, `apps/api/src/modules/ads/routes/accounts.ts`
- Modify: `apps/api/src/modules/ads/routes.ts` (calls `accountRoutes(context)`), `apps/api/tests/access-matrix.integration.test.ts` (`PUBLIC_ROUTES` gets `"GET /api/ads/oauth/callback/{provider}"` with a comment like Social's)
- Test: `apps/api/tests/ads-oauth.integration.test.ts`

**Interfaces:**
- Produces from `oauth-state.ts`: `projectOfAdsState(state: string): string` (uuid before the first dot, length ≤ 200, else `ADS_OAUTH_STATE_INVALID` 400); `beginAdsOAuthState(tx, scope, { provider: "meta"; appConnectionId: string; redirectAfter: string }, now?): Promise<{ state: string }>` (`<projectId>.<32 random bytes base64url>`, SHA-256 stored, `userId`, 10 min, `redirectAfter` must equal `/p/<projectId>/ads/accounts` or start with it plus `?` or `/`, else `ADS_REDIRECT_INVALID` 400; `verifierCiphertext` null); `consumeAdsOAuthState(tx, scope, { state, provider }, now?)` (same checks and single-use `updateMany` as `social/accounts/oauth-state.ts:68-106`; any mismatch → `ADS_OAUTH_STATE_INVALID` 403).
- Produces from `vault.ts`: `type GrantConfig = { metaUserId: string; appConnectionId: string; grantedScopes: string[]; tokenType: "user" | "system_user"; tokenExpiresAt: string | null; assignedAdAccounts: string[]; expiryWarnedFor?: string | null }`; `saveGrant(scope, grant: ProviderGrant, appConnectionId): Promise<{ connectionId: string; reconnect: boolean }>` (finds the project's active `ads.account.meta` connection with the same `metaUserId` and `appConnectionId`; found → `withProjectSecret` returns the new secret and config; else `createProjectConnection` with label `Meta: <userName or userId>` cut to 80 characters, purposes `["ads_manage"]`, secret JSON `{ accessToken, tokenType, expiresAt }`); `grantCredentials(scope, connectionId): Promise<{ accessToken: string; config: GrantConfig; app: ProviderApp & { connectionId: string } }>` (refuses a revoked connection with `ADS_ACCOUNT_RECONNECT_REQUIRED` 409; the project's granted app connection differs from `config.appConnectionId` → `ADS_META_APP_CHANGED` 409). `markReconnectRequired` joins this file in Task 6.
- Produces from `connect.ts`: `beginMetaConnect(tx, scope): Promise<{ authorizeUrl: string }>`; `finishMetaConnect(scope, { code, attempt }): Promise<{ connectionId: string }>` — re-reads the app (`connectionId` must equal the attempt's, else `ADS_META_APP_CHANGED`), calls `connect.finish`, `saveGrant`; on reconnect re-reads at most 20 of the connection's `reconnect_required` accounts with `readAccount`: readable → `active`, audit `ads.account.restored`; refused with kind `auth`/`permission` → keep, health `lastErrorCode = "ADS_META_ACCOUNT_NOT_GRANTED"`; the rest get `nextRunAt = now`. Audit `ads.account.connected` `{ connectionId, reconnect, tokenType }`.
- Routes (`routes/accounts.ts`): `POST ${ADS_BASE}/connections/meta/connect` (`ADS_ACCOUNTS_MANAGE`) → `{ authorizeUrl }`; `GET /api/ads/oauth/callback/:provider` (`provider` enum `["meta"]`; query `state` 40–200, `code` ≤ 2000 optional, `error` ≤ 200 optional; project from the state; `scopeFor(auth, req, projectId, ADS_ACCOUNTS_MANAGE)`; `requireAds` and `consumeAdsOAuthState` in one scoped transaction **before** any exchange; `error` or no `code` → redirect `?error=ADS_OAUTH_CANCELLED`; success → `/p/<projectId>/ads/accounts?connection=<connectionId>`; failure → `?error=<code matching ^ADS_[A-Z0-9_]{1,60}$ else ADS_CONNECT_FAILED>`).

- [ ] **Step 1: Write the failing tests** (fake Graph for exchange, `/me`, `/me/permissions`, `/act_…`):
  - begin without the app grant → 409 `ADS_META_APP_NOT_GRANTED`; editor → 403; viewer → 403; module off → 404 `ADS_DISABLED`; begin stores one `AdOAuthState` row whose `stateHash` is the SHA-256 of the URL's `state` and whose `userId` is the owner; `beginAdsOAuthState` with `redirectAfter` `/p/<other project>/ads/accounts`, `/p/<projectId>/social` or `https://evil.example/` → `ADS_REDIRECT_INVALID`.
  - callback: no session → 401; the other project's owner → 403 or redirect `ADS_OAUTH_STATE_INVALID` per `scopeFor`; a second owner of the same project (did not start it) → redirect `ADS_OAUTH_STATE_INVALID`, `fake.requests` empty; reused state → `ADS_OAUTH_STATE_INVALID`; expired (now + 11 min) → same; `error=access_denied` → `ADS_OAUTH_CANCELLED`, no exchange.
  - success: one `ads.account.meta` connection, its sealed secret opens to JSON with the token, config has `metaUserId`, `tokenType: "user"`, `tokenExpiresAt`, `assignedAdAccounts: []`; redirect `…/ads/accounts?connection=<id>`.
  - Review Focus 3: connect, create `act_1` and `act_2` on that connection directly (`tx.adAccount.create` with `status: "reconnect_required"`, health rows, and `claimExclusiveConfigValue`), reconnect with a new token where `act_2` answers 403 → same connection id, secret version 2, `act_1` `active`, `act_2` `reconnect_required` with `ADS_META_ACCOUNT_NOT_GRANTED`.
  - Leak scan: every response body, redirect `location`, `AuditEvent.metadata`, `DomainEvent.data`, `Notification` rows and `AdAccount` rows of the test contain none of the fake tokens, the code or the app secret.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; register `ads-oauth-state-cleanup` in Task 6, not here.
- [ ] **Step 4: Verify** → PASS; run `UPDATE_ACCESS_MATRIX=1` for the access matrix, review that the only diffs are the new ads routes (`MODULE_DISABLED` for members, `allowed:400` for the callback without a state), then run it without the variable → PASS.
- [ ] **Step 5: Commit** `feat(ads): connect Meta through Facebook Login for Business`.

### Task 5: Ad accounts: discover, assign, edit, unlink

**Files:**
- Create: `apps/api/src/modules/ads/accounts/accounts.ts`, `apps/api/src/modules/ads/accounts/account-settings.ts`
- Modify: `apps/api/src/modules/ads/routes/accounts.ts`
- Test: `apps/api/tests/ads-accounts.integration.test.ts`

**Interfaces:**
- Produces from `account-settings.ts`: `adAccountSettingsSchema` = zod strict `{ dsaBeneficiary: string 1–200 | null, dsaPayor: string 1–200 | null }`, default both `null`.
- Produces from `accounts.ts` (all owner-only except `listAdAccounts`):
  - `listAdAccounts(tx, scope): Promise<AdAccountView[]>` — non-unlinked accounts; `AdAccountView = { id, provider, externalId, name, currency, timezone, status, capability, writesEnabled, providerStatus, spendCapMicros: string | null, amountSpentMicros: string | null, businessId, settings, health: { lastCheckedAt: string | null; lastErrorCode: string | null; nextCheckAt: string | null }, connection: { id: string; tokenType: string; tokenExpiresAt: string | null } | null, version }`.
  - `listConnections(tx, scope): Promise<{ app: AdsAppReadiness; connections: { id: string; label: string; tokenType: string; tokenExpiresAt: string | null; grantedScopes: string[]; accountCount: number; createdAt: string }[] }>`
  - `type ProviderAccountView` = `ProviderAccount` with `spendCapMicros` and `amountSpentMicros` as `string | null`.
  - `availableAccounts(scope, connectionId): Promise<{ accounts: (ProviderAccountView & { assigned: "here" | "elsewhere" | null })[]; truncated: boolean }>` — `elsewhere` from a boolean-only auth-role lookup of other projects' active `ads.account.meta` connections in the organization whose `assignedAdAccounts` contains the id.
  - `assignAdAccount(scope, { connectionId, externalId }): Promise<AdAccountView>` — order: `readAccount` (live; `currencySupported` false → `ADS_CURRENCY_UNSUPPORTED` 409; Meta refuses → `ADS_ACCOUNT_NOT_GRANTED` 409), `claimExclusiveConfigValue` (`CONNECTION_VALUE_CLAIMED` → `ADS_ACCOUNT_ASSIGNED_ELSEWHERE` 409), then in one scoped transaction: create or reactivate the `AdAccount` (a row on another of the project's connections moves: release the old claim after commit), `capability = canWrite ? "write_ready" : "read_verified"`, `writesEnabled = false` on reactivation, upsert `AdSyncState` `(accountId, "health")` with `nextRunAt = now + 6 h`, audit `ads.account.assigned` `{ provider, connectionId }`. On a failed transaction release the claim.
  - `updateAdAccount(tx, scope, accountId, { settings?, writesEnabled?, version })` — version mismatch → `ADS_VERSION_CONFLICT` 409; `writesEnabled: true` needs `capability` `write_ready` or `write_verified` and `status` `active`, else `ADS_ACCOUNT_NOT_WRITE_READY` 409; audit `ads.account.writes_enabled` `{ enabled }` when it changes.
  - `unlinkAdAccount(scope, accountId, { version })` — status `unlinked`, `writesEnabled = false`, delete its `AdSyncState` rows, audit `ads.account.unlinked`; then release the claim; then revoke the connection (`reason: "no_accounts"`) when no non-unlinked account uses it.
  - `revokeAdsConnection(scope, connectionId)` — unlinks every account on it, then revokes.
- Routes (`ADS_BASE` +): `GET /accounts` (`ADS_READ`), `GET /connections` (`ADS_ACCOUNTS_MANAGE`), `GET /connections/:connectionId/available-accounts`, `POST /connections/:connectionId/revoke`, `POST /accounts` `{ connectionId: uuid, externalId: string }`, `PATCH /accounts/:accountId`, `POST /accounts/:accountId/unlink` `{ version }` (all `ADS_ACCOUNTS_MANAGE`). Provider calls run outside the project transaction (Social's pattern, `social/routes.ts:98-103`). Bodies parsed with strict zod; a `connectionId` that is not an active `ads.account.meta` connection of this project → 404 `NOT_FOUND`.

- [ ] **Step 1: Write the failing tests:**
  - available accounts list the fake's three accounts with `assigned: null`; after assigning `act_1` in this project → `here`; in project B of the same organization → `elsewhere`.
  - assign creates the row (EUR, `Europe/Berlin`, `capability: "write_ready"` with `ads_management` and `user_tasks: ["MANAGE"]`, `read_verified` with only `ads_read`) and one health stream row; JPY account amounts in micros; `XYZ` currency → `ADS_CURRENCY_UNSUPPORTED`, no row, no claim left.
  - Review Focus 2: project B (same organization, own connection) assigns `act_1` → 409 `ADS_ACCOUNT_ASSIGNED_ELSEWHERE`; project C of another organization → 201; two parallel assigns from A and B of a fresh `act_9` → exactly one success.
  - editor: `GET /accounts` 200, every other route 403; viewer: 403 (module hidden for viewers); other project's `connectionId` → 404; module off → 404 `ADS_DISABLED`.
  - PATCH: stale version → `ADS_VERSION_CONFLICT`; `writesEnabled: true` on a `read_verified` account → `ADS_ACCOUNT_NOT_WRITE_READY`; DSA fields saved; unknown key → 400.
  - unlink: row `unlinked`, health rows gone, project B can assign `act_1` now; unlinking the connection's last account revokes the connection (secret ciphertexts wiped); reassigning an unlinked account in the same project reactivates the same row id.
  - leak scan over every response and audit row of the file.
  - end to end over HTTP (P11): begin → callback with the fake code → `GET /connections` → available accounts → `POST /accounts` → `GET /accounts` as owner and as editor.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; refresh and review the access matrix as in Task 4.
- [ ] **Step 5: Commit** `feat(ads): assign Meta ad accounts to one project per organization`.

### Task 6: Health, expiry warning, notifications, clean-up

**Files:**
- Create: `apps/api/src/modules/ads/accounts/health.ts`, `apps/api/src/modules/ads/accounts/cleanup.ts`, `apps/api/src/modules/ads/notifications.ts`
- Modify: `apps/api/src/modules/ads/contributions.ts` (`periodic: [adsAccountHealth, adsOAuthStateCleanup]`, `userNotifications: adsUserNotifications`, `events: { publishes: ["ads.account.reconnect_required"] }`), `apps/api/src/modules/ads/routes/accounts.ts` (`POST /accounts/:accountId/check`, `ADS_ACCOUNTS_MANAGE`), `apps/api/src/modules/ads/accounts/vault.ts` (adds `markReconnectRequired`)
- Test: `apps/api/tests/ads-account-health.integration.test.ts`; lists in `module-contributions.test.ts` (periodic names, notification kinds, event types)

**Interfaces:**
- Produces from `notifications.ts`: kinds `ads_account_reconnect` (label "An ad account needs to be reconnected" / "Ein Werbekonto muss neu verbunden werden", `emailDefault: true`) and `ads_token_expiring` (label "Meta access for ads expires soon" / "Der Meta-Zugang für Werbung läuft bald ab", `emailDefault: true`); `notifyAdsReconnect(tx, scope)` and `notifyAdsTokenExpiring(tx, scope, expiresAt: Date)` — owners (organization owners count, as `social/notifications.ts:18-24`), project language, link `/p/<projectId>/ads/accounts`, generic texts without account names, ids or tokens.
- Produces in `vault.ts`: `markReconnectRequired(tx, scope, accountIds: string[], code: string): Promise<number>` — flips only `active`/`disabled` rows of this project, sets the health stream's `lastErrorCode`, audits `ads.account.reconnect_required` `{ code }` per account, publishes `ads.account.reconnect_required` (subject `{ type: "ads.account", id }`, actor `{ kind: "system", id: null }`, origin `"ads"`, data `{ accountId, code }`) per account, calls `notifyAdsReconnect` once when at least one row flipped; returns the count.
- Produces from `health.ts`:
  - `checkAdAccount(scope, accountId, { manual?: boolean }): Promise<{ ok: true } | { ok: false; code: string }>`
  - `adsAccountHealth: PeriodicTask` named `ads-account-health`: due streams `AdSyncState(stream = "health", nextRunAt <= now)` of accounts with status `active` or `disabled`; at most 10 accounts per run and a 30 s budget; one `connect.scopes` call per connection and run.
  - Order per connection: `tokenExpiresAt <= now` → `markReconnectRequired(…, "ADS_META_TOKEN_EXPIRED")` without a call; within 14 days and `expiryWarnedFor !== tokenExpiresAt` → `notifyAdsTokenExpiring` once and store `expiryWarnedFor` through `withProjectSecret` (config only); scopes refused with kind `auth` → all its accounts `ADS_META_TOKEN_INVALID`; neither ads scope left → `ADS_META_PERMISSION_MISSING`.
  - Per account: `readAccount`; kind `auth`/`permission` → that account `ADS_META_ACCOUNT_NOT_GRANTED`; kind `transient`/`rate_limited`/`unknown` → only `lastErrorCode`, `consecutiveFailures + 1`; ok → update `name`, `providerStatus`, `status` (`active`/`disabled`), `capability` (never downgrade `write_verified` while `canWrite`), amounts, `lastSuccessAt`, `consecutiveFailures = 0`. Always `nextRunAt = now + 6 h`. A manual check also reads a `reconnect_required` account and restores it (`ads.account.restored`) when readable with the current token.
- Produces from `cleanup.ts`: `adsOAuthStateCleanup: PeriodicTask` named `ads-oauth-state-cleanup`; `nextDueAt` is the earliest of (oldest `AdOAuthState.expiresAt` + 1 day) and (oldest account-less `ads.account.meta` connection's `createdAt` + 24 h), else `null`; `run` deletes `AdOAuthState` rows expired more than a day ago; revokes the project's `ads.account.meta` connections older than 24 h without a non-unlinked account (`reason: "unused"`); releases `assignedAdAccounts` values with no non-unlinked `AdAccount` on that connection.

- [ ] **Step 1: Write the failing tests:**
  - Graph 190 on `/me/permissions` → both accounts of the connection `reconnect_required`, two audit rows, two `ads.account.reconnect_required` events, exactly one `ads_account_reconnect` notification per owner; a second run changes nothing and notifies nobody.
  - Review Focus 4: Graph 500 and a transport timeout → status unchanged, no notification, `lastErrorCode` set, `consecutiveFailures` 1 then 2, `nextRunAt` ≈ now + 6 h.
  - `act_2` answers 403 while `act_1` reads → only `act_2` flips.
  - token expiring in 10 days → one `ads_token_expiring` notification; second run → none; expired token → `ADS_META_TOKEN_EXPIRED` and `fake.requests` empty.
  - `account_status: 2` → `status: "disabled"`, `providerStatus: "DISABLED:…"`; back to 1 → `active`.
  - manual check restores a `reconnect_required` account whose read works; module off → `nextDueAt` returns `null`.
  - clean-up: expired states older than a day go, newer stay; an unused connection older than 24 h is revoked, a younger one stays; a stale claim value is released.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; `module-contributions.test.ts`, `extensibility.integration.test.ts` PASS.
- [ ] **Step 5: Commit** `feat(ads): ad account health, expiry warning and clean-up`.

### Task 7: Meta data-deletion callback and status page

**Files:**
- Create: `apps/api/src/modules/ads/accounts/data-deletion.ts`, `apps/web/src/modules/ads/data-deletion.tsx`, `apps/web/src/modules/ads/data-deletion.test.tsx`
- Modify: `apps/api/src/modules/ads/routes/accounts.ts`, `apps/web/src/modules/registry.ts` (standalone route `{ key: "ads-data-deletion", path: "data-deletion/ads", session: "none" }`), `apps/api/tests/access-matrix.integration.test.ts` (`PUBLIC_ROUTES`: `"POST /api/callbacks/ads/meta-data-deletion"`, `"GET /api/public/ads/data-deletion/{code}"`), `apps/web/src/platform/shell/routes.test.tsx` (the new standalone path)
- Test: `apps/api/tests/ads-meta-data-deletion.integration.test.ts`

**Interfaces:**
- Produces: `handleAdsMetaDataDeletion(body: unknown): Promise<{ url: string; confirmation_code: string }>` and `adsDataDeletionStatus(code: string): { status: "completed"; requestedAt: string }` — the algorithm of `social/accounts/data-deletion.ts` (signed request ≤ 8000 characters, HMAC-SHA256 with every active `ads.app.meta` app secret, constant-time compare, `issued_at` within 24 h back and 5 min ahead, code = 9 random bytes + issue time + 8-byte HMAC with `hkdfSync("sha256", AUTH_SECRET, empty, "orbit-ads-data-deletion-v1", 32)`, 42 hex characters). Effect: for each active `ads.account.meta` connection with `config.metaUserId = user_id` (`projectConnectionsByConfig`), `revokeAdsConnection` as system actor `meta-data-deletion` with audit `ads.meta.data_deletion` `{ confirmationCode }` per unlinked account. URL `<APP_ORIGIN origin>/data-deletion/ads?code=<code>`.
- Routes: `POST /api/callbacks/ads/meta-data-deletion` (`bodyLimit: 16_384`, rate limit 30/min) and `GET /api/public/ads/data-deletion/:code` (rate limit 30/min, `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`).
- Web: `AdsDataDeletionView` — Social's `DataDeletionView` structure with its own `de`/`en` texts: Orbit disconnected every ad account connected with this Meta login in every project and deleted the access tokens; campaigns at Meta are not touched; figures Orbit already stored stay with the project.

- [ ] **Step 1: Write the failing tests:** valid request signed with `ADS_META_APP.appSecret` → 200 with `url` and `confirmation_code`, the user's connections in two organizations revoked, their accounts `unlinked`, audit rows carry only the code; Review Focus 5: signed with Social's `META_APP_SECRET` → 400 `ADS_SIGNED_REQUEST_INVALID`, nothing changed; `issued_at` 2 days old → 400; three parts or bad base64 → 400; status: issued code → `completed`, altered code → 404, 41 characters → 404; `ORBIT_PUBLIC_INGRESS=false` → both routes 404. Web: valid code → done state with the date; malformed code → unknown state; fetch failure → error state; texts in both languages.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** → PASS; refresh and review the access matrix (new public routes: `allowed:400` for the POST, `allowed:404` for the GET); `routes.test.tsx` PASS.
- [ ] **Step 5: Commit** `feat(ads): Meta data-deletion request for ad connections`.

### Task 8: Web view "Konten & Verbindungen"

**Files:**
- Create: `apps/web/src/modules/ads/accounts.tsx`, `apps/web/src/modules/ads/account-picker.tsx`, `apps/web/src/modules/ads/accounts.test.tsx`
- Modify: `apps/web/src/modules/ads/manifest.tsx` (view `ads.accounts` → `AdsAccounts`), `apps/web/src/modules/ads/api.ts`, `apps/web/src/modules/ads/labels.ts`, `apps/web/src/modules/ads/ads.test.tsx` (hygiene scan covers the new views)

**Interfaces:**
- Consumes the routes of Tasks 4–6 with the response shapes above (types hand-written in `api.ts`: `AdAccountView`, `AdsConnectionsView`, `AvailableAccount`, `AppReadiness`).
- Behaviour:
  - Owner (`ads.accounts.manage`): readiness hint when the app is not `ready` (`not_granted`: "Eine Administratorin muss die Meta-App für Werbung in der Administration anlegen und freigeben." / en equivalent; `project_not_granted`: organization owner grants it to the project; `invalid`: administration must re-enter it); button "Mit Meta verbinden" → POST connect → `window.location.assign(authorizeUrl)`.
  - `?connection=<id>` or the button "Konten auswählen" on a connection opens the picker: available accounts with name, `act_…`, currency, time zone, business; `assigned: "elsewhere"` disabled with "In einem anderen Projekt zugeordnet"; `currencySupported: false` disabled with "Währung wird noch nicht unterstützt"; `truncated` shows a hint; "Zuordnen" per account.
  - Account list (owner and editor): status badge (aktiv, neu verbinden, von Meta deaktiviert), `providerStatus` in plain words for the mapped names, capability ("Lesen", "Schreiben möglich", "Schreiben geprüft"), token expiry date in the project's time zone and a warning within 14 days, last check and its code in plain words. Owner actions: Prüfen, Neu verbinden (same connect flow), Schreibzugriff (switch with the note "wirkt erst, wenn Orbit Kampagnen ändern kann"; disabled unless write-ready), DSA fields (Begünstigter, Zahler), Trennen with a confirm dialog naming the account.
  - `?error=ADS_…` shows a localized message (`ADS_OAUTH_CANCELLED`, `ADS_OAUTH_STATE_INVALID`, `ADS_META_PERMISSION_MISSING`, `ADS_META_APP_NOT_GRANTED`, `ADS_META_APP_CHANGED`, `ADS_CONNECT_FAILED`, fallback "Verbindung fehlgeschlagen") and removes the query parameter.
  - Editor sees the list without actions; amounts formatted with the account currency and locale; BigInt strings never parsed with `Number`.

- [ ] **Step 1: Write the failing tests** (mock `request` as `ads.test.tsx` does): owner without app → hint, no connect button; owner with app → connect POSTs and assigns the location; `?connection=c1` opens the picker, "elsewhere" and unsupported rows disabled, "Zuordnen" POSTs `{ connectionId: "c1", externalId: "act_1" }`; editor sees accounts and no buttons; each listed error code renders its text in `de` and `en`; unlink asks for confirmation and POSTs the version; `spendCapMicros: "500000000"` EUR shows "500,00 €" in `de`; hygiene: no element id or class matches the `BLOCKED` pattern of `ads.test.tsx` (`/(^|[-_])(ad|ads|advert|banner|sponsor)([-_]|$)/i`).
- [ ] **Step 2: Run** `pnpm --dir apps/web exec vitest run src/modules/ads` → FAIL.
- [ ] **Step 3: Implement** with `platform/ui` (`collection.tsx`, `form.tsx`, `sheet.tsx`) and existing primitives; no new CSS class names with forbidden parts.
- [ ] **Step 4: Verify** → PASS; `pnpm --dir apps/web exec vitest run src/platform/shell` PASS.
- [ ] **Step 5: Commit** `feat(ads): accounts and connections view`.

### Task 9: Contract, docs and full verification

**Files:**
- Modify: `packages/schemas/openapi.json`, `packages/api-client/src/generated.ts` (via `pnpm api:generate`), `docs/ADS.md` (admin setup: create the Meta app per A0 §2.2, the ads FLfB configuration, redirect URI `<APP_ORIGIN>/api/ads/oauth/callback/meta`, data-deletion URL `<APP_ORIGIN>/api/callbacks/ads/meta-data-deletion` which needs `ORBIT_PUBLIC_INGRESS=true`, add `ads.app.meta` in the administration and grant it for purpose `ads_oauth` and module `ads`; token types and the 60-day reconnect; one project per ad account and organization; for reporting-only installations the configuration may grant only `ads_read`, and accounts then stay `read_verified` (§11 least privilege)), `docs/SECURITY_REVIEW.md` (A3 entry: what was built, review pending before the first production use, A12), `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md` (R4), `docs/superpowers/plans/2026-11-07-ads-module.md` (§12.1 row A3: implemented, branch and commits), `docs/superpowers/plans/2026-11-08-ads-a1-module-skeleton.md` (rename table: `/api/ads/oauth/callback/meta`, `/api/callbacks/ads/meta-data-deletion`, `/api/public/ads/data-deletion/:code`, web `/data-deletion/ads`), `docs/superpowers/plans/2026-11-07-ads-a0-spike.md` (§5 rows Q20–Q24 from "A0 dependencies"; §4.1 row R7 `GET /me/permissions`; §4.7 exchange as POST without `-G`)

- [ ] **Step 1:** `pnpm api:generate` in the configured local environment; review that the diff adds only the new ads routes.
- [ ] **Step 2:** Write the docs changes above.
- [ ] **Step 3: Full checks:** `pnpm lint`, `pnpm typecheck`, `node scripts/boundaries.mjs`, `pnpm test` (with the worktree database), `pnpm build`, `git diff --check`; `sh scripts/check-pve-schema.sh --print-hash` prints `e3cb3759169fde49c7aaf6b859b7b9f0fb80e1b0164cb7e3e2eabd32f03f5dd0` (unchanged) [note 2026-11-11: main's hash moved to `7003d212…` through other migrations; A3 changes no schema file and keeps it]; `pnpm test:coolify-compose` PASS (no compose change). `pnpm test:e2e` only if an existing browser flow is affected; otherwise state why it was skipped.
- [ ] **Step 4:** Check the diff against `definition-of-done.md`, `review-checklist.md` and `security-checklist.md`; record the result in the ledger.
- [ ] **Step 5: Commit** `docs(ads): record A3 Meta connection`.

## Done when

- An owner can connect Meta (fake Graph locally), see the granted ad accounts, assign one per project and organization, edit DSA fields, toggle the inert write switch, check, reconnect and unlink; editors see the list read-only; viewers see nothing.
- Health marks refused tokens and lost permissions once, warns 14 days before expiry once, ignores outages; Meta's data-deletion request revokes the user's ads connections everywhere.
- Every test above passes, the access matrix diff is reviewed, the schema hash is unchanged, no token leaves the sealed secret except in the allowed places.
- Nothing is pushed until Mario's go; `ORBIT_ADS` stays off in production.

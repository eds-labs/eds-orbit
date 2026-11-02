# Social S2 — Developer Apps, OAuth, Token Vault, Accounts and Telegram Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project owner connects X accounts, Facebook Pages with their linked Instagram professional accounts, and Telegram channels to the social module; tokens are sealed server-side, refreshed under a lock, health-checked, and an account that needs a reconnect is shown as such. Nothing is published yet.

**Architecture:** Developer apps are system connections (`social.app.meta`, `social.app.x`) created in global administration and granted to organizations and projects with the existing ADR 0014 grant chain. Each connected account owns a project connection (`social.account.<platform>`) whose sealed secret holds its tokens; because `orbit_app` may only read connections, a small platform service writes them through `authDb` under an advisory lock (the pattern of `grantChannelsToProject`) and creates the project grant that makes them readable inside `scoped(...)`. X uses the SDK's `xOAuth` provider and `refreshOAuthToken`; Meta (Facebook Login for Business) is Orbit code because the SDK has no Facebook provider; Telegram uses the extended Orbit connector with a separate publishing bot (S-D3).

**Tech Stack:** TypeScript, Fastify 5, Prisma 7 + PostgreSQL 17 (FORCE RLS), zod 4, `@opencoredev/social-sdk@0.5.0` (exact pin, `/server` entry only in S2), Next.js 16, Vitest.

**Spec:** [`2026-11-02-social-module.md`](2026-11-02-social-module.md) (§3 S-D1/S-D3/S-D4/S-D7/S-D9, §5 credential storage, §6.2 routes, §8 Telegram, §10 S2, §11) and [ADR 0020](../../adr/0020-social-module.md). Builds on S1 (PR #183, branch `claude/social-module-plan`); this plan's branch `claude/social-s2` is stacked on it.

## Findings this plan relies on (verified 2026-11-02)

| Topic | Fact | Source |
|---|---|---|
| Connection writes | `orbit_app` has only `SELECT` on `Connection`, `ConnectionSecret`, `ConnectionGrant`, and RLS lets it see a connection only through an active project grant; no code writes `scope='project'` connections today. Writes go through `authDb` (`orbit_auth`) with `systemAudit`, e.g. `grantChannelsToProject` (`platform/connections/channel-assignment.ts:392-480`). | `202610240002_central_connections/migration.sql:144-188`, `scripts/db-deploy.ts` lines 305-309 |
| Generic connector form | Every registered provider with `project` scope is offered by the generic project `connector` action (`platform/http/platform-actions.ts:135-166`). | code |
| Admin form | The admin create form has only `provider`, `label`, `baseUrl`, `secret`, `budget`; several values travel as JSON in `secret` (existing n8n/customer-context precedent, `connections-ui.tsx:274-278`). | code |
| SDK X OAuth | `xOAuth(options).start({platforms, capabilities, redirectUri, state, codeChallenge})` and `.complete({callbackUrl, attempt})`; tokens are delivered through `options.credentialSink.save`; endpoints `https://x.com/i/oauth2/authorize`, `https://api.x.com/2/oauth2/token`; default scopes `tweet.read tweet.write users.read offline.access media.write`; confidential client via Basic auth; discovery returns `{ref.accountId, displayName}` without the username; `refreshOAuthToken("x", options, current)` keeps the old refresh token if none is returned; `fetch` is injectable. | `dist/server/oauth.js:23-25,265-360,466-500` (0.5.0 tarball) |
| Meta | Graph API v26.0 current. Facebook Login for Business: `https://www.facebook.com/v26.0/dialog/oauth?client_id&redirect_uri&state&config_id&response_type=code`; no PKCE; code → token `GET /v26.0/oauth/access_token` with `client_secret`; long-lived user token via `grant_type=fb_exchange_token` (~60 days); Page tokens from `/me/accounts` with a long-lived user token do not expire; linked IG via `/{page-id}?fields=instagram_business_account`; health via `/debug_token` (`is_valid`, `expires_at`, `data_access_expires_at`, `granular_scopes`); error 190 (subcodes 458/459/460/463/464/467/492) = reconnect. Permissions: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`. Standard Access suffices for role users; **posts of an app in Development mode are visible only to role users**, so public posting needs Live mode (privacy policy URL and a data-deletion callback). | developers.facebook.com (see programme plan research, 2026-11-02) |
| X | Pay-per-use: post $0.015, post **with URL $0.200**; `POST /2/tweets` 100/15 min per user; access token 2 h; auth code must be exchanged within 30 s; refresh tokens rotate (persist atomically). | docs.x.com |
| Telegram | `getChat` accepts `@username` and returns the numeric id; `getChatMember(chat, botId)` → `status == "administrator"` and `can_post_messages`; outgoing calls never disturb another process's webhook as long as `getUpdates`/`setWebhook`/`deleteWebhook`/`logOut`/`close` are never called. | core.telegram.org Bot API 10.3 |

## Global Constraints

- Branch `claude/social-s2` in `.claude/worktrees/social-s2`, stacked on `claude/social-module-plan`; never commit to `main`; push only with Mario's approval.
- **Task 6 adds `@opencoredev/social-sdk` and must not start before Mario approves the dependency** (AGENTS.md: new production dependency); Task 7 (X refresh) and the X part of Task 10 use it too. Tasks 1–5, 8, 9, 11 and 12 do not need it; execute them first.
- No migration in S2 (the S1 tables suffice). If one becomes necessary, stop and ask (new schema hash).
- Graph API version constant `META_GRAPH_VERSION = "v26.0"` in one place (`accounts/meta.ts`).
- All provider HTTP goes through `boundedFetch` (`packages/connectors/src/http.ts`) or the SDK with `fetch` set to the wrapper of Task 4; no other outbound path.
- Tokens, client secrets, codes, verifiers and `signed_request` payloads never appear in responses, logs, audit metadata, errors or test snapshots.
- Social code never calls Telegram `getUpdates`, `setWebhook`, `deleteWebhook`, `logOut` or `close` (pinned by a test).
- Everything stays behind `ORBIT_SOCIAL` (and `ORBIT_CONNECTIONS` for central connections, already on in production). S2 performs only OAuth and reads, never a post; every test uses a fake `fetch` and no test reaches a provider.
- Redirect URIs: `${APP_ORIGIN}/api/social/oauth/callback/x` and `${APP_ORIGIN}/api/social/oauth/callback/meta` (web proxy forwards GET with cookie; verified).
- English in code/docs; UI strings `en` + `de`.

## Review Focus

1. **State replay or cross-user callback** (the same `state` used twice; another member finishing someone else's flow; a state of project A used in project B). Expect: 403 `SOCIAL_OAUTH_STATE_INVALID`, no account, no secret. Pinned in Task 5.
2. **Two refreshes of one X token at the same time** (worker and request). Expect: one provider refresh, one new secret version; the second caller uses the new token. Pinned in Task 3 and Task 7.
3. **Refresh rejected (revoked app access)**. Expect: account `reconnect_required`, attention item, no retry loop, secret unchanged. Pinned in Task 7.
4. **The owner bot token pasted as a publishing bot**. Expect: refused with `SOCIAL_TELEGRAM_OWNER_BOT` (S-D3); owner bot's webhook untouched. Pinned in Task 9.
5. **A member of another project or a non-owner reading accounts or secrets**. Expect: accounts list without secrets for readers, connect/disconnect only for owners, nothing across projects (RLS + grant). Pinned in Task 3 and Task 10.

---

### Task 1: Telegram connector — `getMe`, `getChat`, `getChatMember`

**Files:**
- Modify: `packages/connectors/src/telegram.ts`
- Test: `packages/connectors/src/telegram.test.ts`

**Interfaces:**
- Produces on `TelegramClient`:
  - `getMe(): Promise<{ id: number; username: string; isBot: true }>`
  - `getChat(chat: TelegramChatId | \`@${string}\`): Promise<{ id: number; type: "channel" | "supergroup" | "group" | "private"; title: string | null; username: string | null }>`
  - `getChatMember(chat: TelegramChatId, userId: number): Promise<{ status: string; canPostMessages: boolean }>`
- All three use the existing private `call(method, body, false)` (no side effect), zod-parse `result`, keep the token out of errors. `@username` is accepted only by `getChat` (`/^@[A-Za-z][A-Za-z0-9_]{4,31}$/`).

- [ ] **Step 1: Write the failing tests** (fake `fetch`, style of the existing file):
  - `getMe parses the bot` → `{id: 42, username: "orbit_pub_bot", isBot: true}`; a non-bot result throws `INVALID_PROVIDER_RESPONSE`.
  - `getChat resolves @username to the numeric channel id` → request body `{chat_id: "@orbit_news"}`, result `{id: -1001234567890, type: "channel", title: "Orbit News", username: "orbit_news"}`.
  - `getChat refuses malformed usernames before any request` (`"@a"`, `"orbit"`, `"@bad-name"`) → `INVALID_INPUT`, fetch not called.
  - `getChatMember reports the admin right to post` → `{status: "administrator", canPostMessages: true}`; a `member` result → `canPostMessages: false`.
  - `the new methods never leak the token` (error message and cause of a network failure contain no token).
- [ ] **Step 2: Run, expect FAIL** — `pnpm exec vitest run packages/connectors/src/telegram.test.ts` → `getMe is not a function`.
- [ ] **Step 3: Implement** the three methods.
- [ ] **Step 4: Run, expect PASS** (all existing Telegram tests unchanged).
- [ ] **Step 5: Commit** — `feat(connectors): Telegram getMe, getChat and getChatMember`

### Task 2: Module-managed providers and the project secret service (platform)

**Files:**
- Modify: `apps/api/src/platform/connections/connections.ts` (`ConnectionProvider.managedByModule?: true`), `apps/api/src/platform/http/platform-actions.ts` (exclude managed providers from the `connector` enum), `apps/api/src/platform/administration/connections.ts` (`centralProviders` excludes them; `owned()` keeps refusing project connections)
- Create: `apps/api/src/platform/connections/project-secrets.ts`
- Test: `apps/api/tests/project-secrets.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type JsonConfig = Record<string, string | number | boolean | null | string[]>;
  createProjectConnection(scope: Scope, input: {
    moduleId: string; provider: string; label: string; config: JsonConfig; secret: string; purposes: string[];
  }): Promise<{ connectionId: string; grantId: string }>;
  withProjectSecret<T>(scope: Scope, input: { moduleId: string; connectionId: string },
    work: (current: { secret: string; config: JsonConfig; secretVersion: number }) =>
      Promise<{ result: T; secret?: string; config?: JsonConfig }>): Promise<T>;
  revokeProjectConnection(scope: Scope, input: { moduleId: string; connectionId: string; reason: string }): Promise<void>;
  projectConnectionsByConfig(provider: string, key: string, value: string):
    Promise<Array<{ connectionId: string; workspaceId: string; projectId: string }>>;
  ```
- Rules: the provider must be registered, `managedByModule: true`, and owned by `moduleId` (`PROVIDER_NOT_MANAGED` 400). Everything runs in one `authDb.$transaction` (timeout 45 s). `createProjectConnection` writes `Connection{scope:"project", workspaceId, projectId, createdBy: scope.userId}`, `ConnectionSecret{version:1, state:"active", ...sealSecret(secret)}` and `ConnectionGrant{projectId, userId:null, purposes, modules:[moduleId]}`, audited `connection.created` (systemAudit, targetType `connection`). `withProjectSecret` takes `pg_advisory_xact_lock(hashtext('project-secret:'||connectionId))`, re-reads the active secret, calls `work` **inside** the lock (so concurrent refreshes serialize), and when `work` returns `secret` writes version n+1 and retires n (audit `connection.secret_rotated`); a returned `config` is merged into `Connection.config`. It refuses connections of another project or module (404). `revokeProjectConnection` sets `revokedAt`, retires all secrets, revokes the grant (audit `connection.revoked`).

- [ ] **Step 1: Write the failing tests:**
  - `creates a project connection that the project can read and no other project can` → inside `scoped(A)` `connectionSecret(tx, id)` returns the plaintext; inside `scoped(B)` `tx.connection.findUnique` → null.
  - `refuses providers that are not module-managed or belong to another module` → `PROVIDER_NOT_MANAGED`.
  - `serializes concurrent secret updates` → two parallel `withProjectSecret` calls whose `work` waits 200 ms and appends `"+1"`; final secret `"s+1+1"`, versions 1..3, exactly one `active`.
  - `refuses another project's connection` → 404 `NOT_FOUND`.
  - `revocation hides the connection and its secret from the project` → `connectionSecret` returns null.
  - `the generic connector action does not offer managed providers` → `connector` with `provider: "social.account.x"` fails zod; `centralProviders()` does not list it.
  - `no secret in system audit metadata` → audit rows contain ids only.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**, plus `apps/api/tests/connections*.integration.test.ts` and `channel-assignment` suites unchanged.
- [ ] **Step 5: Commit** — `feat(connections): module-managed project connections with locked secret updates`

### Task 3: Developer apps and account providers (social)

**Files:**
- Create: `apps/api/src/modules/social/accounts/providers.ts`, `apps/api/src/modules/social/accounts/apps.ts`, `apps/api/src/modules/social/accounts/http.ts`
- Modify: `apps/api/src/modules/social/contributions.ts` (`connections: { providers }`)
- Test: `apps/api/tests/social-apps.integration.test.ts`

**Interfaces:**
- Providers (all `label {en,de}`):
  - `social.app.meta`: `scopes: ["system"]`, `purposes: ["social_oauth"]`, `check` = `GET /v26.0/{appId}?fields=id,name` with app token `appId|appSecret` → `{status: "read_verified"}`; secret JSON `{appId, appSecret, configId}`.
  - `social.app.x`: `scopes: ["system"]`, `purposes: ["social_oauth"]`, `checkUnsupported: "SOCIAL_APP_NOT_CHECKABLE"`; secret JSON `{clientId, clientSecret}`.
  - `social.account.x|facebook|instagram|telegram`: `scopes: ["project"]`, `managedByModule: true`, `purposes: ["social_publish"]`, `checkUnsupported: "SOCIAL_ACCOUNT_CHECK_IN_MODULE"`.
- `appCredentials(tx: DbTx, scope: Scope, app: "meta" | "x"): Promise<{ connectionId: string; meta?: { appId: string; appSecret: string; configId: string }; x?: { clientId: string; clientSecret: string } }>` — `resolveConnection(tx, scope, {provider, purpose: "social_oauth", module: "social"})`; none → 409 `SOCIAL_APP_NOT_GRANTED`; unparsable secret → 500 `SOCIAL_APP_INVALID` (message without the secret).
- `socialFetch: typeof fetch` — accepts `string | URL | Request`, converts a `Request` to `(url, init)` and calls `boundedFetch`; timeout 20 s.
- `redirectUri(config, app: "meta" | "x"): string` → `${APP_ORIGIN}/api/social/oauth/callback/${app}`.

- [ ] **Step 1: Write the failing tests:**
  - `resolves a granted developer app` (system connection + org grant + project grant created with the admin functions as admin) → `appCredentials(tx, scope, "x").x.clientId === "client-1"`.
  - `refuses an app that is not granted to the project` → `SOCIAL_APP_NOT_GRANTED`.
  - `refuses a malformed app secret without echoing it` → `SOCIAL_APP_INVALID`, message lacks the secret.
  - `checks a Meta app with an app token and never sends the secret in the URL path` (fake fetch asserts `access_token=appId|appSecret` query and HTTPS host `graph.facebook.com`).
  - `socialFetch accepts a Request` and refuses `http://` and private addresses (`PRIVATE_ENDPOINT`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**; `module-contributions.test.ts` updated if it pins provider ids.
- [ ] **Step 5: Commit** — `feat(social): developer apps and module-managed account providers`

### Task 4: OAuth state (single use, user-bound, PKCE)

**Files:**
- Create: `apps/api/src/modules/social/accounts/oauth-state.ts`
- Modify: `apps/api/src/modules/social/contributions.ts` (periodic `social-oauth-state-cleanup`, hourly: delete states expired > 1 day)
- Test: `apps/api/tests/social-oauth-state.integration.test.ts`

**Interfaces:**
- `beginOAuthState(tx: DbTx, scope: Scope, input: { platform: "x" | "facebook"; appConnectionId: string; redirectAfter: string }): Promise<{ state: string; codeVerifier: string; codeChallenge: string }>` — `state = projectId + "." + base64url(32 random bytes)`; stores `sha256(state)`; verifier = base64url(32) sealed as JSON of `sealSecret`; challenge = base64url(sha256(verifier)); expiry 10 min; `redirectAfter` must start with `/p/<projectId>/social`.
- `projectOfState(state: string): string` — uuid before the first dot, else 400 `SOCIAL_OAUTH_STATE_INVALID`.
- `consumeOAuthState(tx, scope, { state, platform }): Promise<{ codeVerifier: string; appConnectionId: string; redirectAfter: string }>` — hash match, same project, same `userId`, unexpired, unused, same platform; marks `usedAt` (in its own transaction, before any token exchange); any mismatch → 403 `SOCIAL_OAUTH_STATE_INVALID`.

- [ ] **Step 1: Write the failing tests:** valid round trip; second consume → 403; other user → 403; expired (clock 11 min) → 403; state of project A consumed in scope B → 403; tampered state → 403; wrong platform → 403; the DB row holds no plaintext state or verifier; `redirectAfter` outside the project → 400; cleanup deletes only states expired more than a day ago.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(social): single-use OAuth state with sealed PKCE verifier`

### Task 5: Callback route and connect start (shared)

**Files:**
- Modify: `apps/api/src/modules/social/routes.ts`
- Create: `apps/api/src/modules/social/accounts/connect.ts`
- Test: `apps/api/tests/social-oauth-routes.integration.test.ts`

**Interfaces:**
- `POST /api/projects/:projectId/social/accounts/connect/:app` (`app ∈ {meta, x}`, permission `SOCIAL_ACCOUNTS_MANAGE`, owner only by default roles) → `{ authorizeUrl }`.
- `GET /api/social/oauth/callback/:app` — outside the project prefix (module guard checks only `ORBIT_SOCIAL`); takes the project from `projectOfState`, then `scopeFor(auth, req, projectId, SOCIAL_ACCOUNTS_MANAGE)`, `requireSocial`, consumes the state, calls the app's `finish…`, and answers `302` to `${redirectAfter}?connected=<n>` or `?error=<CODE>` (relative, codes only). Provider `error=access_denied` → `?error=SOCIAL_OAUTH_CANCELLED` and the state is consumed.
- `connect.ts` dispatches `beginConnect(scope, app)` / `finishConnect(scope, app, callbackUrl, state)` to `x.ts` and `meta.ts` (Tasks 6/7 implement them; this task tests with a stub registry `connectHandlers` that tests can replace).

- [ ] **Step 1: Write the failing tests** (HTTP via `buildServer().inject`, three signed-in members like `social-routes.integration.test.ts`): editor → 403 on connect; owner → URL containing the state; callback without session → 401; callback by editor → 403; callback with a reused state → redirect `?error=SOCIAL_OAUTH_STATE_INVALID`; `ORBIT_SOCIAL=false` → 404 `SOCIAL_DISABLED`; cancel → `?error=SOCIAL_OAUTH_CANCELLED`; success → `?connected=1` with the stub.
- [ ] **Step 2–4:** fail, implement, pass; access matrix updated with `UPDATE_ACCESS_MATRIX=1` and the diff reviewed (two new routes).
- [ ] **Step 5: Commit** — `feat(social): OAuth connect start and callback routes`

### Task 6: X accounts (needs the approved SDK dependency)

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (`"@opencoredev/social-sdk": "0.5.0"`, exact), `docs/DEPENDENCY_RISKS.md`
- Create: `apps/api/src/modules/social/accounts/x.ts`, `apps/api/tests/social-sdk-surface.test.ts`
- Test: `apps/api/tests/social-x-connect.integration.test.ts`

**Interfaces:**
- `beginX(scope): Promise<{ authorizeUrl: string }>` — `appCredentials(…,"x")`, `beginOAuthState(platform "x")`, `xOAuth({clientId, clientSecret, redirectUri, fetch: socialFetch}).start({platforms: ["x"], capabilities: [], redirectUri, state, codeChallenge})`.
- `finishX(scope, callbackUrl, state): Promise<{ accounts: number }>` — consume state; build the SDK `ConnectionAttempt` (`id` = state row id, `backend: "orbit"`, `tenantId: projectId`, `principalId: userId`, `platforms: ["x"]`, `capabilities: []`, `redirectUri`, `state`, `codeVerifier`, `createdAt`, `expiresAt`); `complete` with a `credentialSink` that captures the token set in memory; then `GET https://api.x.com/2/users/me?user.fields=username,profile_image_url` with the new token; then either `createProjectConnection` (new) or `withProjectSecret` (reconnect of the same `externalId`, account back to `active`) with secret JSON `{accessToken, refreshToken, expiresAt, scopes}`; upsert `SocialAccount{platform:"x", externalId, handle:"@"+username, displayName, capability:"read_verified", status:"active"}`; audit `social.account.connected` `{platform, accountId}`.
- `social-sdk-surface.test.ts` pins what S2 imports: `xOAuth`, `refreshOAuthToken` from `@opencoredev/social-sdk/server`, and asserts the root entry and `/server` export nothing whose name matches `/zernio|postfast|post-?for-?me|postiz|buffer|upload-?post/i`.

- [ ] **Step 0 (gate):** Mario approved the dependency (record date in `docs/DEPENDENCY_RISKS.md`). Without it, skip Tasks 6 and 7 and the X part of Task 10, continue with Task 8, and come back after the approval.
- [ ] **Step 1: Install** `pnpm add @opencoredev/social-sdk@0.5.0 --save-exact`; verify the lockfile integrity hash matches the npm provenance-attested tarball (`npm view @opencoredev/social-sdk@0.5.0 dist.integrity`).
- [ ] **Step 2: Write the failing tests** (fake fetch routing by URL; no real provider): first connect creates one account + one project connection with a sealed secret; reconnect of the same X user rotates the secret (version 2) and does not create a second account; a callback whose token response lacks `refresh_token` stores `refreshToken: null` and marks `settings.refreshable=false`; the token endpoint receives Basic auth and the verifier; the response, logs and audit contain no token; a failing `users/me` leaves no account and no connection.
- [ ] **Step 3–4:** fail, implement, pass; `pnpm lint` (the forbidden-import guard still green).
- [ ] **Step 5: Commit** — `feat(social): connect X accounts through the SDK OAuth provider`

### Task 7: Token access, refresh and reconnect state

**Files:**
- Create: `apps/api/src/modules/social/accounts/vault.ts`
- Modify: `apps/api/src/modules/social/contributions.ts` (`attention`, `userNotifications: { social_account_reconnect: { label, emailDefault: true } }`)
- Test: `apps/api/tests/social-vault.integration.test.ts`

**Interfaces:**
- `accountCredentials(scope: Scope, accountId: string): Promise<{ platform: SocialPlatform; accessToken: string; externalId: string; pageId?: string }>` — reads the account and its secret; X: if `expiresAt < now + 5 min`, refreshes inside `withProjectSecret` (re-checks expiry after taking the lock, so a second caller reuses the fresh token) with `refreshOAuthToken("x", {clientId, clientSecret, fetch: socialFetch}, current)`.
- `markReconnectRequired(tx, scope, accountId, code: string): Promise<void>` — `status = "reconnect_required"`, version+1, audit `social.account.reconnect_required {code}`, `notifyMembers` (owners) once per transition.
- Refresh errors: SDK `reconnect_required`, HTTP 400 `invalid_request`/`invalid_grant`, 401 → `markReconnectRequired` + throw `SOCIAL_ACCOUNT_RECONNECT_REQUIRED` (409); network/5xx → throw `SOCIAL_PROVIDER_UNAVAILABLE` (503), status unchanged.
- Attention: one item per project `{kind: "social.reconnect", severity: "warning", count, navKey: "social.accounts"}` for accounts in `reconnect_required`, for members with `social.read`.

- [ ] **Step 1: Write the failing tests:** valid token returned without a refresh; expiring token refreshed once and stored as version 2; **two parallel calls → one refresh request** (fake fetch counter = 1); revoked refresh (`400 invalid_request`) → account `reconnect_required`, one notification, secret unchanged, second call throws without contacting the provider; 503 → status unchanged; attention lists the account for a viewer, nothing for another project.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit** — `feat(social): locked token refresh and reconnect state`

### Task 8: Meta — Facebook Pages and linked Instagram accounts

**Files:**
- Create: `apps/api/src/modules/social/accounts/meta.ts`
- Test: `apps/api/tests/social-meta-connect.integration.test.ts`

**Interfaces:**
- `META_GRAPH_VERSION = "v26.0"`.
- `beginMeta(scope): Promise<{ authorizeUrl: string }>` — `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth` with `client_id`, `redirect_uri`, `state`, `config_id`, `response_type=code` (no `scope`, no PKCE; the state row still stores a verifier, unused).
- `finishMeta(scope, callbackUrl, state): Promise<{ accounts: number }>` — exchange the code (`client_secret`), exchange for a long-lived user token, `GET /me?fields=id,name`, `GET /me/accounts?fields=id,name,access_token,tasks,instagram_business_account{id,username,name,profile_picture_url}&limit=100` (follow `paging.next` up to 5 pages); for each Page with `CREATE_CONTENT` or `MANAGE` task → account `facebook` (secret `{pageToken}`, config `{metaUserId, pageId}`); for each linked IG account → account `instagram` (secret `{pageToken}`, config `{metaUserId, pageId, igUserId}`); the user selects assets in Meta's dialog, so every returned asset is connected (ruling: no Orbit-side picker); reconnect rotates secrets of existing accounts; assets no longer returned are not deleted but set `reconnect_required` with code `SOCIAL_META_ASSET_NOT_GRANTED`.
- `metaHealth(app, accountSecret): Promise<{ ok: boolean; code?: string; dataAccessExpiresAt?: string }>` — `GET /debug_token?input_token=<pageToken>` with the app token; `is_valid=false` or error 190 → `SOCIAL_META_TOKEN_INVALID`; missing `pages_manage_posts` (facebook) or `instagram_content_publish` (instagram) in `granular_scopes` for the asset → `SOCIAL_META_PERMISSION_MISSING`.

- [ ] **Step 1: Write the failing tests** (fake Graph): authorize URL carries `config_id` and no `scope`; a user with two Pages (one with linked IG) yields three accounts and three connections; a Page without posting task is skipped; pagination followed and capped; code exchange failure leaves nothing behind; reconnect rotates and marks an un-granted Page `reconnect_required`; `metaHealth` maps 190/463 and missing granular scopes; no token in responses, audit or errors.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit** — `feat(social): connect Facebook Pages and linked Instagram accounts`

### Task 9: Telegram publishing channels

**Files:**
- Create: `apps/api/src/modules/social/accounts/telegram.ts`
- Modify: `apps/api/src/modules/social/routes.ts` (`POST …/social/accounts/telegram`)
- Test: `apps/api/tests/social-telegram-account.integration.test.ts`

**Interfaces:**
- `connectTelegramChannel(scope, input: { botToken: string; chat: string }): Promise<{ accountId: string }>` — `getMe`; refuse if the token equals the project's owner bot token (decrypt `telegram_connections` row with `CREDENTIAL_KEY`, constant-time compare) → 409 `SOCIAL_TELEGRAM_OWNER_BOT`; `getChat(chat)` must be `type: "channel"` (`SOCIAL_TELEGRAM_NOT_A_CHANNEL`); `getChatMember(chat.id, bot.id)` must be administrator with `canPostMessages` (`SOCIAL_TELEGRAM_BOT_CANNOT_POST`); create connection (secret `{botToken}`, config `{chatId, botId, botUsername}`) and account `telegram` (`externalId` = chat id, handle `@username` or title, capability `read_verified`).
- Health for Telegram = `getChatMember` again.

- [ ] **Step 1: Write the failing tests:** happy path; owner bot token refused; a group → refused; bot without post right → refused; invalid token format → 400 before any request; **the client never calls `setWebhook`, `deleteWebhook`, `getUpdates`, `logOut` or `close`** (fake fetch records method names); the owner bot's `telegram_connections` row is unchanged.
- [ ] **Step 2–4:** fail, implement, pass; existing owner-bot suites (`telegram*.test.ts`, `/pause`, Stop button) unchanged.
- [ ] **Step 5: Commit** — `feat(social): Telegram publishing channels with a separate bot`

### Task 10: Account routes, health check and disconnect

**Files:**
- Create: `apps/api/src/modules/social/accounts/accounts.ts`, `apps/api/src/modules/social/accounts/health.ts`
- Modify: `apps/api/src/modules/social/routes.ts`, `apps/api/src/modules/social/contributions.ts` (periodic `social-account-health`, every 6 h per project with the module enabled, at most 20 accounts per run)
- Test: `apps/api/tests/social-accounts.integration.test.ts`

**Interfaces:**
- `GET …/social/accounts` (`SOCIAL_READ`) → `{ items: Array<{ id, platform, handle, displayName, status, capability, connectedAt, lastCheckedAt, lastCheckCode }> }` — never tokens or connection config.
- `POST …/social/accounts/:accountId/check` (`SOCIAL_ACCOUNTS_MANAGE`) → health per platform (X `users/me` via `accountCredentials`, Meta `metaHealth`, Telegram `getChatMember`); writes `settings.lastCheckedAt/lastCheckCode`; failure codes as in Tasks 7–9.
- `POST …/social/accounts/:accountId/disconnect` (`SOCIAL_ACCOUNTS_MANAGE`, body `{version}`) → `status = "disabled"`, `disabledAt`, `revokeProjectConnection`; X additionally calls `POST https://api.x.com/2/oauth2/revoke` best effort (failure ignored, audited); history rows stay.

- [ ] **Step 1: Write the failing tests:** viewer lists accounts without any secret field (JSON scan for `token`, `secret`); editor cannot check or disconnect; owner disconnect revokes the connection (`connectionSecret` → null) and keeps the account row; stale `version` → 409 `SOCIAL_VERSION_CONFLICT`; the periodic task checks at most 20 accounts and marks a failing one `reconnect_required`; another project's account id → 404.
- [ ] **Step 2–4:** fail, implement, pass; access matrix updated and reviewed.
- [ ] **Step 5: Commit** — `feat(social): account list, health check and disconnect`

### Task 11: Meta data-deletion callback

**Files:**
- Create: `apps/api/src/modules/social/accounts/data-deletion.ts`
- Modify: `apps/api/src/modules/social/contributions.ts` (`publicRoutes`: `POST /api/public/social/meta/data-deletion`, requires `ORBIT_PUBLIC_INGRESS`)
- Test: `apps/api/tests/social-meta-data-deletion.integration.test.ts`

**Interfaces:**
- Verifies `signed_request` (`base64url(sig).base64url(payload)`, HMAC-SHA256 with each granted Meta app secret, `algorithm: "HMAC-SHA256"`, `issued_at` within 1 day); finds accounts by `projectConnectionsByConfig("social.account.facebook"|"social.account.instagram", "metaUserId", user_id)`; disconnects them as in Task 10 (actor `system`); answers `{ url: "${APP_ORIGIN}/social/data-deletion?code=<code>", confirmation_code: <code> }`; audit `social.meta.data_deletion` with the code and counts only.

- [ ] **Step 1: Write the failing tests:** valid request disconnects the user's accounts in every project and returns the code; bad signature → 400 and nothing changes; expired `issued_at` → 400; flag off → 404; body over 16 KB → 413; nothing of the payload logged.
- [ ] **Step 2–4:** fail, implement, pass.
- [ ] **Step 5: Commit** — `feat(social): Meta data-deletion callback`

### Task 12: Web — accounts view and developer-app hints

**Files:**
- Create: `apps/web/src/modules/social/accounts.tsx`
- Modify: `apps/web/src/modules/social/manifest.tsx` (accounts view uses it), `labels.ts`, `api.ts`, `apps/web/src/modules/social/attention.tsx` (renderer for `social.reconnect`), `apps/web/src/platform/administration/connections-ui.tsx` (secret hint for `social.app.*`: JSON fields and the two callback URLs)
- Test: `apps/web/src/modules/social/accounts.test.tsx`

**Behaviour:** list with platform icon, handle, status badge (`active`, `reconnect_required`, `disabled`), last check; owner-only buttons "Connect X", "Connect Facebook/Instagram", "Add Telegram channel" (form: bot token as password field, channel `@username` or id), "Check", "Disconnect" (confirm dialog naming the account); `?connected=` / `?error=` banner with translated codes; an explanatory note that Meta posts stay visible only to app members until the Meta app is Live.

- [ ] **Step 1: Write the failing tests:** viewer sees no buttons; owner sees all three connect actions; error codes map to texts in en/de; the token field is `type="password"` with `autocomplete="off"`; every button has an accessible name; the Meta note is shown.
- [ ] **Step 2–4:** fail, implement, pass; `pnpm --dir apps/web typecheck`.
- [ ] **Step 5: Commit** — `feat(social): accounts view`

### Task 13: Documentation and full checks

**Files:** `docs/SOCIAL.md` (setup for Mario: Meta Business app, Facebook Login for Business configuration with the five permissions and user-token type, redirect URIs, Live-mode requirements incl. privacy policy and data-deletion URL; X app with OAuth 2.0 confidential client, redirect URI, scopes, pay-per-use prices; grants admin → org → project; Telegram publishing bot setup), `docs/DEPENDENCY_RISKS.md`, `docs/OPERATIONS.md` (health periodic, reconnect handling), `docs/API_CONTRACT.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md` (R2 partial, R6), `docs/SECURITY_REVIEW.md` (OAuth, token storage, public callback).

- [ ] **Step 1:** write the docs.
- [ ] **Step 2:** `pnpm lint && pnpm typecheck && pnpm test && pnpm build` and the framework checks (`python3 scripts/check_framework.py --require-full-validation`) all green; integration tests executed.
- [ ] **Step 3:** review against definition-of-done, review, security and data-safety checklists.
- [ ] **Step 4: Commit** — `docs(social): S2 accounts, OAuth and operations`

## Done when

- With fake providers: an owner connects X, Meta (Page + IG) and Telegram accounts; tokens exist only as sealed secrets of project connections readable through the project grant; X refresh is serialized; a revoked token leads to `reconnect_required` with attention and notification; disconnect revokes; the data-deletion callback works.
- No social code path calls a Telegram update/webhook method; no managed-provider import; no token in any response, log or audit.
- Live acceptance (after merge, separately approved): Mario creates the Meta and X apps, grants them, connects real accounts in a test project; nothing is published until S5.

## Approvals needed from Mario

1. The dependency `@opencoredev/social-sdk@0.5.0` (before Task 6).
2. Creating the Meta app (Business type, Facebook Login for Business configuration) and the X app with pay-per-use credits; note X charges $0.20 per post **with a link**.
3. Making the Meta app Live (privacy policy URL, data-deletion URL = Task 11 endpoint) before public posting in S5; requires `ORBIT_PUBLIC_INGRESS` for that route.

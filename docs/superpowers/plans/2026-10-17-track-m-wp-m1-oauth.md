# Track M, WP-M1: OAuth authorization server, consent and grants — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orbit becomes an OAuth 2.1 authorization server for MCP clients: a user grants a client access to one workspace, selected projects and scopes, and the user or a workspace owner can revoke it.

**Architecture:** Better Auth's `mcp()` plugin (which *is* the OAuth provider), `cimd()` and core `jwt()` are added to the existing Better Auth instance in `apps/api/src/platform/tenancy/auth.ts`, behind `ORBIT_MCP_OAUTH` (default `false`; off means today's auth config, byte for byte). Orbit adds one table pair, `McpGrant` and `McpGrantEvent`, in the auth table set. The workspace a user picks becomes Better Auth's consent reference, so tokens, consent and refresh-token families are scoped per (user, client, workspace), and the access token carries the workspace as a claim for the WP-M2 gateway. No business logic; no MCP endpoint yet (that is WP-M2).

**Tech Stack:** Fastify 5, Better Auth 1.7.10 with `@better-auth/mcp`, `@better-auth/oauth-provider`, `@better-auth/cimd` (all 1.7.10, pending AD-21 approval), Prisma 7 on PostgreSQL, Next.js web shell, Vitest integration tests.

**Spec:** `plans/orbit-modularization/09-mcp-gateway.md` §2.2, §4, §7, §9 and `plans/orbit-modularization/07-roadmap.md` (WP-M1). Better Auth docs at tag `v1.7.10`: `docs/content/docs/plugins/{mcp,cimd,oauth-provider,jwt}.mdx`.

## Risk, environment, profile

- **Risk:** high (new authentication surface). AGENTS.md requires risk analysis, test strategy and rollback before implementation; they are in this plan (§ Risk analysis, the tests in each task, § Rollback).
- **Environment:** local only. Production deployment, the production migration and the flag flip are separate approvals (WP-M5).
- **App profile:** `backend-api` primary; `web-frontend` for the consent and Connected apps views; security rules from `.agentic/security/`.
- **Workflow:** `.agentic/workflows/feature.md` plus `migration.md` for the additive schema.

## Decisions needed before Task 0 (AD-21 approval)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Dependencies (see table below) | Approve all four at exactly 1.7.10. |
| D2 | Issuer | `https://orbit.eds-labs.io/api/auth` (Better Auth's path issuer), not the bare origin from `09` §3.1. Endpoints become `/api/auth/oauth2/*`, metadata `/.well-known/oauth-authorization-server/api/auth` and `/api/auth/.well-known/openid-configuration`. No custom issuer or JWKS wiring. The issuer is bound into tokens and client configs, so it must stay stable. |
| D3 | Ingress in WP-M1 | Through the existing web proxy (plus a small Next route for the root `/.well-known/*` paths); the proxy forwards `Authorization` only for `/api/auth/oauth2/*`. The direct Traefik route is decided with `/mcp` in WP-M2, where it is needed anyway. No infra change in WP-M1. |
| D4 | `orbit:write` (Q-24) | Not offered in the first release. Scopes: `openid email profile offline_access orbit:read orbit:propose`. |
| D5 | CIMD host allowlist | `ORBIT_MCP_CIMD_HOSTS`, default `chatgpt.com`. Other clients are added by config after a check. |
| D6 | DCR | Off (`ORBIT_MCP_DCR=false`). When on: Better Auth's register limit 5/min/IP; cleanup of unused clients is a WP-M5 item. |
| D7 | `email_verified` | Orbit has no e-mail verification, so UserInfo reports `false`. ChatGPT Enterprise domain restrictions would fail. Accept as a known limitation now; no data change. |

### D1: exact package versions

| Package | Today | Proposed | Why | Advisory status (GitHub Advisory DB, checked 2026-10-17) |
|---|---|---|---|---|
| `better-auth` | 1.7.5 | **1.7.10** (patch upgrade) | The plugins peer-require `better-auth ^1.7.10`. Also brings the 1.7.7 Magic Link fix (Orbit does not use Magic Link, so not affected today). | All published advisories fixed at ≤ 1.6.22 / 1.7.0-beta.10. |
| `@better-auth/mcp` | — | **1.7.10** (new) | MCP authorization server profile, RFC 9728 metadata, `requireMcpAuth` for WP-M2. MIT, 24 KB, deps: `jose`, `@better-auth/oauth-provider`. | None published. |
| `@better-auth/oauth-provider` | — | **1.7.10** (new, direct) | Imported directly for `verifyOAuthQueryParams` (consent page, added in 1.7.7) and the consent APIs. MIT, 633 KB, deps: `zod`, `jose`. | GHSA-7w99 (code race), GHSA-392p (refresh fork), GHSA-p2fr (unbound resource), GHSA-xr8f (client-creation bypass): all fixed at ≤ 1.7.0-beta.4 / 1.6.11. |
| `@better-auth/cimd` | — | **1.7.10** (new) | CIMD client discovery with the bundled SSRF-safe Node transport (`@better-auth/cimd/node`: resolve once, reject special-use IPs, pin address, no redirects, 5 s, 5 KB). MIT, 49 KB, no deps. | None published. |
| `jwt` plugin | in core | — | `better-auth/plugins`, no new package. | — |
| Transitive changes | | | `better-call` 1.4.0 → 1.4.2, `@better-auth/utils` 0.4.2 → 0.5.0, `@better-auth/core` and the adapters 1.7.5 → 1.7.10. `jose` 6.x is already transitive. | — |
| *WP-M2, for information* | | `@modelcontextprotocol/server` 2.3.1 | Needed in WP-M2, not now. Can be approved together or later. | — |

Why 1.7.10 and not an older release: 1.7.10 (2026-10-15) fixes *"OAuth consent without a reference overwriting or reusing consent for a different reference"* (#11801), which this design relies on, plus PKCE error codes, `invalid_client` for unknown clients and UserInfo 500s on bad tokens. The fallback 1.7.7 (2026-09-30) has none of these. 1.7.10 passes pnpm's minimum release age (1 day). **At install time** re-run the advisory query; if a new advisory affects 1.7.10, stop and ask.

Not chosen: `1.8.0-beta.*` (beta); an external IdP (rejected by AD-21); a hand-written OAuth server (more attack surface).

## Global Constraints

- No business logic in OAuth/MCP code; grants only narrow what the user may do in the UI (`09` §4.2).
- Grant types: `authorization_code` with PKCE S256 only, plus `refresh_token`. No client credentials, password or implicit grant.
- Access tokens: JWT, `aud` = `MCP_RESOURCE` (default `${APP_ORIGIN}/mcp`; production `https://orbit.eds-labs.io/mcp`), lifetime **600 s**.
- Refresh tokens: opaque, stored hashed (Better Auth default), rotated, `refreshTokenReuseInterval` **30 s** (MCP default); replay after that revokes the family.
- `iss` in every authorization response; discovery advertises `code_challenge_methods_supported: ["S256"]`, `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true`.
- Client authentication: `none` and `private_key_jwt` only for discovered clients.
- `ORBIT_MCP_OAUTH=false` must leave session login, `/api/auth/*` behaviour and responses unchanged.
- The `jwt()` plugin must not add a `set-auth-jwt` header to session responses (`disableSettingJwtHeader: true`), and `/api/auth/token` stays disabled.
- New tables belong to the auth set: owned by `orbit_auth`, listed in `scripts/db-deploy.ts` `authTables`, no access for `orbit_app` in WP-M1.
- Code and docs in English; additive migration only; no new production dependency beyond D1.

## Review Focus

- **Sign-in in the middle of an authorization.** A signed-out user lands on Orbit's login with a signed OAuth query; after sign-in they must reach the select/consent step, and a normal sign-in without that query must behave as today. → Task 5 test `login continues a pending authorization`.
- **Idle consent page.** The signed query expires (10 min) while the user decides; submitting must return a clear `OAUTH_REQUEST_EXPIRED` error, and no grant may become active. → Task 4 test `expired signed query activates nothing`.
- **Re-authorizing the same client for the same workspace with other projects.** Must update the one active grant, never create a second active row. → Task 4 test `re-consent replaces the active grant`.
- **Revocation within the 30 s refresh reuse window.** A replayed refresh token must not resurrect a revoked grant. → Task 4 test `revocation beats the refresh reuse window`.
- **A user with a workspace but no project.** The select step must say so and offer no consent, instead of creating an empty grant. → Task 4 test `workspace without projects cannot be granted`.

---

### Task 0: Install the approved packages and pin Better Auth's hook behaviour

Starts only after Mario approves D1 to D7.

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`
- Create: `apps/api/tests/mcp-oauth-hooks.characterization.integration.test.ts`
- Modify: this plan (append "Task 0 findings")

**Interfaces:**
- Produces: confirmed argument shapes of `postLogin.shouldRedirect`, `postLogin.consentReferenceId`, `customAccessTokenClaims`, and the behaviour for a missing `resource`; later tasks rely on these.

- [ ] **Step 1:** Re-run the advisory check (GitHub Advisory API for the four packages) and stop if anything affects 1.7.10.
- [ ] **Step 2:** `corepack pnpm add better-auth@1.7.10 @better-auth/mcp@1.7.10 @better-auth/oauth-provider@1.7.10 @better-auth/cimd@1.7.10 --save-exact` in the root package. Expected: lockfile updated, no other top-level version changes.
- [ ] **Step 3:** Run the existing auth suite: `node --env-file=<main>/.runtime/local.env ./node_modules/vitest/vitest.mjs run apps/api/tests/auth.integration.test.ts apps/api/tests/client-ip.integration.test.ts`. Expected: PASS (proves the 1.7.5 → 1.7.10 upgrade alone changes nothing, including the RFC 6265bis cookie change in 1.7.8).
- [ ] **Step 4:** Write characterization tests against a throwaway Better Auth instance (memory adapter) with `jwt()`, `mcp()` and a recording `postLogin`/`customAccessTokenClaims`:
  - `shouldRedirect receives session, scopes, headers, isContinuation` (record whether `client_id` is available);
  - `consentReferenceId result reaches customAccessTokenClaims as referenceId, on code and on refresh grants`;
  - `authorization without resource does not yield a token with aud = MCP resource` (record: `invalid_target` or other `aud`);
  - `refresh replay after the reuse interval invalidates the family` (record whether any hook or error is observable for auditing).
- [ ] **Step 5:** Run them, append the observed shapes to this plan as "Task 0 findings". If `consentReferenceId` cannot see the session id, switch Task 4 to the fallback in Task 4 Step 3.
- [ ] **Step 6:** Commit `chore(auth): pin Better Auth 1.7.10 and the OAuth/MCP/CIMD plugins (AD-21)`.

### Task 1: Configuration and the auth wiring behind `ORBIT_MCP_OAUTH`

**Files:**
- Modify: `packages/config/src/index.ts`, `.env.example`
- Create: `apps/api/src/platform/mcp-auth/plugins.ts`
- Modify: `apps/api/src/platform/tenancy/auth.ts`
- Test: `apps/api/tests/mcp-oauth-config.unit.test.ts`

**Interfaces:**
- Produces:
  - config keys `ORBIT_MCP_OAUTH: "false"|"true"` (default `"false"`), `ORBIT_MCP_DCR: "false"|"true"` (default `"false"`), `MCP_RESOURCE: string` (default `${APP_ORIGIN}/mcp`, HTTPS or loopback HTTP), `ORBIT_MCP_CIMD_HOSTS: string` (comma list, default `"chatgpt.com"`);
  - `MCP_SCOPES = ["openid","email","profile","offline_access","orbit:read","orbit:propose"] as const`;
  - `ORBIT_WORKSPACE_CLAIM = "orbit_workspace_id"`;
  - `mcpAuthPlugins(config: Config, deps: { fetchClientMetadataResource: typeof fetch; consentReference: ConsentReferenceFn }): BetterAuthPlugin[]` returning `[jwt(...), mcp(...), cimd(...)]`;
  - `makeAuth(options?: { cimdFetch?: typeof fetch })` keeps its name; the option exists only for tests.

- [ ] **Step 1: Failing tests.** `mcp-oauth-config.unit.test.ts`:
  - `flag off: makeAuth registers no plugins` — `makeAuth().options.plugins ?? []` has length 0;
  - `flag on: jwt, mcp and cimd with the pinned options` — mcp options: `resource === MCP_RESOURCE`, `accessTokenExpiresIn === 600`, `refreshTokenReuseInterval === 30`, `scopes` equals `MCP_SCOPES`, `resources` = `[{ identifier: MCP_RESOURCE, allowedScopes: MCP_SCOPES }]`, `allowDynamicClientRegistration === false`, `loginPage === "/connect/login"`, `consentPage === "/connect"`, `postLogin.page === "/connect"`; jwt options: `disableSettingJwtHeader === true`; cimd: `metadataProfile === "mcp-2026-07-28"`;
  - `MCP_RESOURCE rejects a query, fragment or non-loopback http`;
  - `production config uses fetchClientMetadataResource from @better-auth/cimd/node` (identity check when no test fetch is passed).
- [ ] **Step 2:** Run, expect FAIL (module missing).
- [ ] **Step 3:** Implement. In `auth.ts`: `plugins: config.ORBIT_MCP_OAUTH === "true" ? mcpAuthPlugins(...) : []` and `disabledPaths: ["/token"]`. Keep every existing option unchanged. `isMetadataDocumentUrlAllowed` checks the hostname against `ORBIT_MCP_CIMD_HOSTS` (exact host or subdomain). `ORBIT_MCP_DCR=true` sets `allowDynamicClientRegistration` and `allowUnauthenticatedClientRegistration` to true and `clientRegistrationDefaultApplicationType: "infer"`. Typed plugin APIs are reached through one helper in `plugins.ts` (`oauthApi(auth)`) so the conditional plugin list does not leak casts into callers.
- [ ] **Step 4:** Run, expect PASS; also run `auth.integration.test.ts` (flag off) — PASS.
- [ ] **Step 5:** Commit `feat(mcp-auth): OAuth provider plugins behind ORBIT_MCP_OAUTH (WP-M1)`.

### Task 2: Schema — Better Auth OAuth tables, `McpGrant`, `McpGrantEvent`

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/202610170001_mcp_oauth/migration.sql`
- Modify: `scripts/db-deploy.ts` (`authTables`, lines 131-143)
- Modify: `apps/api/tests/rls-matrix.integration.test.ts` expectations if it lists auth tables
- Test: `apps/api/tests/mcp-oauth-schema.integration.test.ts`

**Interfaces:**
- Produces Prisma models (all in the auth set):
  - Better Auth's models exactly as `getAuthTables(options)` from `better-auth/db` reports them for the Task 1 flag-on options (expected: `jwks`, `oauthClient`, `oauthAccessToken`, `oauthRefreshToken`, `oauthConsent`, `oauthClientAssertion`, `oauthResource`, `oauthClientResource`, plus any DPoP replay table it lists);
  - `McpGrant { id uuid pk; userId String; clientId String; workspaceId uuid; projectIds uuid[]; allCurrentProjects Boolean default false; scopes String[]; modules String[] /* empty = no restriction */; status String /* pending|active|revoked */; sessionId String?; createdAt; activatedAt?; expiresAt?; revokedAt?; revokedBy String?; lastUsedAt? }` with index `(userId, clientId, workspaceId, status)` and a partial unique index `WHERE status = 'active'` on `(userId, clientId, workspaceId)` (SQL only);
  - `McpGrantEvent { id uuid pk; grantId uuid?; userId String; clientId String; workspaceId uuid?; action String; detail Json default '{}'; createdAt }`, index `(workspaceId, createdAt)`.

- [ ] **Step 1: Failing tests:**
  - `Prisma models cover every Better Auth table and field` — compare `getAuthTables(flagOnOptions)` field names and types to Prisma DMMF; the test is the drift guard for future Better Auth upgrades;
  - `orbit_auth can CRUD the new tables, orbit_app cannot select them` (connect as each role);
  - `only one active grant per user, client and workspace` — second active insert fails with a unique violation, a second `revoked` row succeeds.
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Add models and the additive migration (SQL by `prisma migrate diff`, then the partial index by hand); add the table names to `authTables`.
- [ ] **Step 4:** Run the new test plus `rls-matrix` and `access-matrix` — PASS.
- [ ] **Step 5:** Commit `feat(db): OAuth provider tables and MCP grants (WP-M1)`.

### Task 3: HTTP surface — auth route, form bodies, Origin exemption, discovery, proxy

**Files:**
- Modify: `apps/api/src/server.ts` (`/api/auth/*` route at ~407-441, Origin hook at ~248-300)
- Create: `apps/api/src/platform/mcp-auth/http.ts` (allowlist and well-known handlers)
- Modify: `apps/web/src/app/api/[...path]/route.ts`
- Create: `apps/web/src/app/.well-known/[...path]/route.ts`
- Test: `apps/api/tests/mcp-oauth-http.integration.test.ts`, web proxy unit test next to the route

**Interfaces:**
- Produces: `oauthAuthPaths(config): readonly string[]` — empty when the flag is off; otherwise `/api/auth/oauth2/{authorize,token,consent,continue,userinfo,revoke,introspect}`, `/api/auth/jwks`, `/api/auth/.well-known/openid-configuration`, `/api/auth/.well-known/oauth-authorization-server`, plus `/api/auth/oauth2/register` only with DCR on; `ORIGIN_EXEMPT_OAUTH = /^\/api\/auth\/oauth2\/(token|revoke|introspect|register)$/`.

- [ ] **Step 1: Failing tests:**
  - `flag off: oauth2 endpoints answer 403 AUTH_ENDPOINT_DISABLED and well-known answers 404`;
  - `flag on: authorization server metadata validates` — `GET /.well-known/oauth-authorization-server/api/auth` → 200, `issuer === APP_ORIGIN + "/api/auth"`, `code_challenge_methods_supported` deep-equals `["S256"]`, `client_id_metadata_document_supported === true`, `authorization_response_iss_parameter_supported === true`, `scopes_supported` contains `orbit:read`, has no `registration_endpoint`, `grant_types_supported` ⊆ `["authorization_code","refresh_token"]`;
  - `openid configuration exposes userinfo and jwks`;
  - `token endpoint accepts a form-encoded body without Origin` (expects an OAuth error JSON such as `invalid_client`, not 403 ORIGIN or a parse error);
  - `consent endpoint still requires the browser Origin`;
  - `token endpoint is limited per client IP` (21st request within 60 s from one `x-orbit-client-ip` → 429, another IP still 400/401);
  - `sign-in responses carry no set-auth-jwt header (flag on)`;
  - web: `proxy forwards Authorization only under /api/auth/oauth2/` and `well-known route forwards only the allowlisted paths`.
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement: permitted list = today's three paths + `oauthAuthPaths(config)`; forward the raw string body with the original `content-type` for `application/x-www-form-urlencoded`, JSON as today; skip the Origin/CSRF check only for `ORIGIN_EXEMPT_OAUTH` when the flag is on; register `GET /.well-known/oauth-authorization-server/api/auth` with `oauthProviderAuthServerMetadata(auth)` (flag on only). Web: add `authorization` to the forwarded headers only when the path starts with `auth/oauth2/`; the `.well-known` route forwards exactly `oauth-authorization-server/api/auth` (WP-M2 adds the protected-resource paths) to the API and 404s the rest.
- [ ] **Step 4:** Run, expect PASS.
- [ ] **Step 5:** Commit `feat(mcp-auth): OAuth endpoints and discovery through the existing ingress (WP-M1)`.

### Task 4: Grants and the consent flow

**Files:**
- Create: `apps/api/src/platform/mcp-auth/grants.ts`, `apps/api/src/platform/mcp-auth/events.ts`, `apps/api/src/platform/mcp-auth/routes.ts`
- Modify: `apps/api/src/platform/mcp-auth/plugins.ts` (wire `postLogin`, `customAccessTokenClaims`)
- Modify: `apps/api/tests/fixtures/access-matrix.json`
- Test: `apps/api/tests/mcp-oauth-flow.integration.test.ts`

**Interfaces:**
- Consumes: Task 0 findings, `oauthApi(auth)`, `ORBIT_WORKSPACE_CLAIM`, `MCP_SCOPES`.
- Produces:
  - `recordSelection(input: { userId: string; sessionId: string; clientId: string; workspaceId: string; projectIds: string[] | "all_current"; modules?: string[] }): Promise<McpGrant>` — creates a `pending` grant, `expiresAt` = now + 600 s; NOT_FOUND when the user is not a workspace member or a project is outside it; `NO_PROJECTS` (409) when the workspace has no project the user belongs to;
  - `pendingReference(sessionId: string, clientId?: string): Promise<string | undefined>` — workspaceId of the newest unexpired pending grant; used by `postLogin.consentReferenceId`;
  - `activateGrant(input: { userId: string; sessionId: string; clientId: string; scopes: string[] }): Promise<McpGrant>` — in one transaction: revoke the previous active grant for (user, client, workspace) with `revokedBy = "replaced"`, mark the pending one `active`;
  - `recordGrantEvent(e: { action: "grant.selected"|"grant.activated"|"grant.denied"|"grant.revoked"|"client.registered"|"client.refreshed"|"token.refresh_replay"; userId; clientId; grantId?; workspaceId?; detail? }): Promise<void>`;
  - routes (session required, Origin check as usual): `GET /api/mcp-connect/request?<signed query>` → `{ client: { id, name, uri }, scopes, workspaces: [{ id, name, role, projects: [{ id, name }] }] }`; `POST /api/mcp-connect/selection` `{ oauthQuery, workspaceId, projectIds }` → `{ next: string }` (URL from `oauth2.continue({ postLogin: true })`); `POST /api/mcp-connect/consent` `{ oauthQuery, accept: boolean, scopes: string[] }` → `{ redirect: string }`. All 404 while the flag is off.
  - `postLogin.shouldRedirect` returns true unless a pending selection exists for this session (and client, if Task 0 shows it is available); `consentReferenceId` returns `pendingReference(...)` and throws `set_workspace` when none.
  - `customAccessTokenClaims` returns `{ [ORBIT_WORKSPACE_CLAIM]: referenceId }`.

- [ ] **Step 1: Failing tests** (CIMD client served in-process through the `cimdFetch` test seam at `https://client.test/client.json`, `redirect_uris: ["https://client.test/cb"]`, PKCE S256):
  - `full flow issues an audience-bound token` — authorize → `/connect` → selection → consent → redirect has `code` and `iss === APP_ORIGIN + "/api/auth"`; token exchange: JWT `aud === MCP_RESOURCE`, `exp - iat === 600`, `orbit_workspace_id === workspaceId`, `azp === "https://client.test/client.json"`; refresh token present; one `active` McpGrant; events `grant.selected` and `grant.activated`;
  - `UserInfo returns sub, email and email_verified`;
  - `private_key_jwt client authenticates with a signed assertion` (CIMD document with `token_endpoint_auth_method: "private_key_jwt"` and inline `jwks`; a wrong key is `invalid_client`);
  - `wrong code_verifier is invalid_grant`; `unregistered redirect_uri is rejected without redirecting`; `missing resource` (assert the Task 0 finding: no token with `aud === MCP_RESOURCE`);
  - `a new client always reaches the consent step` (no `skip_consent`);
  - `tampered signed query returns 400 OAUTH_REQUEST_INVALID`;
  - Review Focus: `expired signed query activates nothing` (advance time 601 s → `OAUTH_REQUEST_EXPIRED`, grant stays `pending`), `re-consent replaces the active grant` (exactly one active, old one `revokedBy = "replaced"`), `workspace without projects cannot be granted` (409 `NO_PROJECTS`);
  - `refresh rotates; replay after 30 s revokes the family` (fake `Date` + 31 s; the newer refresh token then fails too).
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement. Fallback if Task 0 shows `consentReferenceId` lacks the session id: key pending selections by the signed query's `client_id` + `state` instead, passed through `oauth_query`.
- [ ] **Step 4:** Run, expect PASS; update `access-matrix.json` for the three routes (session users: 200/404 by membership).
- [ ] **Step 5:** Commit `feat(mcp-auth): workspace and project grants with consent (WP-M1)`.

### Task 5: Revocation, listing and the gateway lookup

**Files:**
- Modify: `apps/api/src/platform/mcp-auth/grants.ts`, `apps/api/src/platform/mcp-auth/routes.ts`
- Test: `apps/api/tests/mcp-oauth-revoke.integration.test.ts`

**Interfaces:**
- Produces:
  - `listGrants(viewer: { userId: string }, filter: { mine: true } | { workspaceId: string })` — `mine`: the caller's active grants; `workspaceId`: all active grants in the workspace, owner only (403 for editor/viewer, 404 for non-members). Rows: `{ id, clientId, clientName, userId, userEmail, workspaceId, projectIds, allCurrentProjects, scopes, createdAt, lastUsedAt }`;
  - `revokeGrant(actor: { userId: string }, grantId: string): Promise<void>` — allowed for the grant's user or an owner of its workspace; sets `revoked`, `revokedAt`, `revokedBy = actor.userId`; deletes the `oauthRefreshToken` and `oauthConsent` rows for (userId, clientId, referenceId = workspaceId) in the same transaction; writes `grant.revoked`;
  - `activeGrantForToken(claims: { sub: string; azp: string; [ORBIT_WORKSPACE_CLAIM]: string }): Promise<McpGrant | null>` — the WP-M2 gateway calls this on every request;
  - routes: `GET /api/mcp-grants`, `GET /api/workspaces/:workspaceId/mcp-grants`, `DELETE /api/mcp-grants/:grantId` (404 while the flag is off).

- [ ] **Step 1: Failing tests:**
  - `revoked grant fails on the next call` — after `DELETE`, the refresh grant returns `invalid_grant` and `activeGrantForToken(claims)` returns `null`;
  - Review Focus: `revocation beats the refresh reuse window` (revoke, then replay the just-rotated refresh token within 30 s → `invalid_grant`);
  - `owner revokes another member's grant`; `editor cannot revoke another member's grant (403)`; `non-member gets 404`;
  - `listing never returns token values or other workspaces' grants`.
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, expect PASS; update `access-matrix.json`.
- [ ] **Step 5:** Commit `feat(mcp-auth): revoke and list MCP grants (WP-M1)`.

### Task 6: Web — login continuation, consent view, Connected apps

**Files:**
- Create: `apps/web/src/platform/connect/connect-view.tsx` (select + consent, one view with two steps), `apps/web/src/platform/connect/connected-apps.tsx`
- Modify: the shell's view registration (`apps/web/src/platform/shell/*`, same `ViewDef` pattern as WP1.7) for `/connect` and `/connect/login`; the login form in `apps/web/src/components/orbit.tsx` sends `oauth_query` when the page URL carries a signed OAuth query; Settings → Connected apps (user) and Organization → Connected apps (owner)
- Modify: `apps/web/src/lib/i18n.ts`
- Test: `apps/web/src/platform/connect/connect-view.test.tsx`, `connected-apps.test.tsx`

**Interfaces:**
- Consumes: Task 4 and 5 routes.

- [ ] **Step 1: Failing tests:**
  - Review Focus: `login continues a pending authorization` — with `?client_id=…&sig=…` in the URL the sign-in body contains `oauth_query` equal to the signed part only, and the view follows the returned redirect; without it the body is exactly today's `{ email, password }`;
  - `consent shows client name, its client_id host, the chosen workspace and projects, and every requested scope; orbit:read cannot be unticked`;
  - `deny calls consent with accept false and follows the redirect`;
  - `NO_PROJECTS and OAUTH_REQUEST_EXPIRED render their messages`;
  - `Connected apps lists grants and revokes after confirmation`.
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement with existing UI primitives from `apps/web/src/platform/ui`.
- [ ] **Step 4:** Run, expect PASS; `next build --webpack` in `apps/web` succeeds.
- [ ] **Step 5:** Commit `feat(web): MCP consent and Connected apps (WP-M1)`.

### Task 7: CIMD policy and client events

**Files:**
- Modify: `apps/api/src/platform/mcp-auth/plugins.ts`
- Test: `apps/api/tests/mcp-oauth-cimd.integration.test.ts`

**Interfaces:**
- Consumes: `recordGrantEvent`.

- [ ] **Step 1: Failing tests:**
  - `client_id outside ORBIT_MCP_CIMD_HOSTS is rejected before any fetch` (the test fetch must record zero calls);
  - `loopback, http, credentials, fragment and IP-literal client_ids are rejected` (`https://127.0.0.1/c.json`, `https://localhost/c.json`, `http://client.test/c.json`, `https://u:p@client.test/c.json`, `https://client.test/c.json#x`);
  - `metadata with a secret or symmetric auth method is rejected`;
  - `oversized metadata (> 5 KB) is rejected`;
  - `first use writes client.registered, a changed document writes client.refreshed`;
  - `DCR off: POST /api/auth/oauth2/register is 403`; `DCR on: sixth registration within 60 s is 429`.
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement `onClientCreated` / `onClientRefreshed` → `recordGrantEvent`; on a refresh that changes `redirect_uris` or `jwks_uri`, revoke that client's active grants (`revokedBy = "client_changed"`).
- [ ] **Step 4:** Run, expect PASS.
- [ ] **Step 5:** Commit `feat(mcp-auth): CIMD host policy and client audit (WP-M1)`.

### Task 8: Documentation and the full check

**Files:**
- Modify: `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md`, `.env.example`, `plans/orbit-modularization/09-mcp-gateway.md` (D2/D3 outcome), `docs/adr/0007-tool-registry.md` addendum (status line)

- [ ] **Step 1:** Status entry "Track M WP-M1: OAuth authorization server (2026-10-xx, local)" with flags, routes, tables, decisions D1–D7, Task 0 findings, known limitation D7.
- [ ] **Step 2:** Full suite (`vitest run`), `tsc --noEmit`, `next build --webpack`, `secrets:check`. Revert `evals/knowledge/last-deterministic-run.json` if touched.
- [ ] **Step 3:** Run the `09` §9 checklist items that apply to WP-M1 and record the result; request the security review (risk high).
- [ ] **Step 4:** Commit `docs: WP-M1 status, traceability and security notes`.

## Risk analysis

| Risk | Mitigation |
|---|---|
| A flag-on bug weakens session login | Flag off = identical config; Task 1 and Task 3 tests on both flag states; `auth.integration` in every task. |
| Token accepted for the wrong resource | `aud` pinned to `MCP_RESOURCE`; Task 4 asserts it; WP-M2 verifies `aud` again. |
| SSRF through CIMD | Bundled pinned transport + host allowlist before any fetch (Task 7). |
| Consent or grant mix-up across workspaces | Workspace as consent reference (fixed in 1.7.10 #11801), one-active-grant index, tests in Task 4. |
| Better Auth upgrade drift | Exact pins; Task 2 schema drift test; Task 0 characterization tests. |
| New public endpoints abused | Better Auth per-IP limits on top of the existing `/api/auth/*` route limit (20/min per IP and path), F-02 client IP. |

## Rollback

- Local and preview: set `ORBIT_MCP_OAUTH=false`; nothing else changes.
- Production (only after WP-M5 approvals): flag off immediately disables every OAuth route and the consent UI; issued access tokens expire within 10 minutes and are useless without the WP-M2 gateway. The migration is additive; tables can stay. Full rollback: redeploy the previous `main` commit.

## Task 0 findings

*(appended during Task 0)*

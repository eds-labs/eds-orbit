# Track M, WP-M5: rollout preparation and hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything that can be prepared and verified locally before Mario turns the MCP gateway on: a deploy-safe `mcp` compose service, the hardening items from the WP-M1…M4 checklists, a local conformance smoke test for both protocol revisions, a runbook and a prepared security review — plus one approval checklist listing every production step that needs Mario's explicit OK.

**Architecture:** Stacked on WP-M4 (#172, branch `claude/track-m-wp-m4`). No production step is taken. The `mcp` service is made deploy-safe first: with `ORBIT_MCP_GATEWAY=false` the process starts in a **disabled mode** (answers `/healthz` and 404 for everything else, no auth or DB work), so the compose service and its route can merge without exposing anything. All hardening is local code with tests.

**Tech Stack:** Fastify, MCP SDK 2.3.1, Better Auth 1.7.10, Prisma, Docker Compose / Coolify, Vitest.

**Spec:** `plans/orbit-modularization/07-roadmap.md` (WP-M5), `09-mcp-gateway.md` §3.1, §7, §9; the checklists in `docs/IMPLEMENTATION_STATUS.md` (WP-M1 pre-flip, WP-M2, WP-M3, WP-M4 additions).

## Risk, environment, profile

- **Risk:** high (prepares a public endpoint and auth changes). Mitigation: disabled mode by default, every production step behind an explicit approval, tests for each hardening item.
- **Environment:** local only; draft PR stacked on #172.
- **App profiles:** `backend-api` primary, `ai-agent-app`, security, deployment presets (Coolify).

## Decisions for this plan (controller rulings; report them in the PR)

| # | Decision | Why |
|---|---|---|
| D-M5-1 | **Disabled mode**: with `ORBIT_MCP_GATEWAY !== "true"` or `ORBIT_MCP_OAUTH !== "true"`, `mcp-main.ts` starts a minimal Fastify app: `GET /healthz` → 200 `{status:"disabled"}`, everything else 404, no `makeAuth()`, no DB pool. Replaces the exit-1 guard. | A compose service whose process exits on a disabled flag would crash-loop and fail Coolify health checks. |
| D-M5-2 | Compose service `mcp`: same image, command `node_modules/.bin/tsx apps/api/src/mcp-main.ts`, `environment: *api-environment` plus `MCP_JWKS_URL`, networks `frontend`, `database`, `egress`, healthcheck `fetch http://127.0.0.1:4312/healthz`, `depends_on: api healthy`, `SERVICE_URL_MCP_4312: /mcp`. | Q-22 placement; Coolify routes `https://orbit.eds-labs.io/mcp` to the service (longer rule wins over the web catch-all). |
| D-M5-3 | The gateway accepts the MCP endpoint at both `/mcp` and `/` (in case Coolify strips the path prefix; documented as a runbook verification item). | Coolify docs do not say whether the prefix is stripped. |
| D-M5-4 | Protected Resource Metadata at the root (`/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`) is served through the existing Next `.well-known` route, which forwards those two paths to the `mcp` service internally (`ORBIT_MCP_ORIGIN`, default `http://mcp:4312`); the gateway keeps serving them too. | No second Traefik route outside `/mcp`. |
| D-M5-5 | `MCP_JWKS_URL` (default empty → `${APP_ORIGIN}/api/auth/jwks`; compose sets `http://api:4311/api/auth/jwks`). | No hairpin through the public origin. |
| D-M5-6 | Hardening in scope (each with a test): IPv6 /64 keying + limiter size cap; count unauthenticated requests before token verification; pre-validation honours the SDK element cap and async refinements; forced-exit timeout (10 s) in shutdown; DPoP-bound token test + advertise `dpop_signing_alg_values_supported` if the library supports DPoP; per-project concurrency limit (R-10: 2 concurrent tool calls per project per gateway, queue up to 10 s then `BUSY`); output clipping (canonical URLs > 2 KB fall back to the deep link; `fetch` text clipped by JSON-escaped size); a query-text-absent test; support status/priority list sync test. | Items from the WP-M2/M3 checklists that are code-only. |
| D-M5-7 | WP-M1 pre-flip items in scope: normalize `MCP_RESOURCE`; `CHECK` constraint on `McpGrant.status` and an index on `McpGrant.sessionId` (one additive migration); bind the pending selection to the signed OAuth query; a `/oauth2/token` after-hook that deletes tokens minted for a non-active grant; revoke a client's grants on a `token_endpoint_auth_method` downgrade; tests for deny-after-replacement, `GRANT_CONFLICT` and the sign-in continuation re-run; cleanup of abandoned pending selections (expired pending rows deleted by an existing periodic job or on access). RFC 7009 token revocation keeps the grant (documented). | Code-only pre-flip items. |
| D-M5-8 | WP-M4 items in scope: daily-quota "used up" cache until UTC midnight; quotas keyed on (user, client, workspace); registry/startup assertion that every MCP-exposed `P_proposal` tool reports `deduplicated` and records `mcp.proposal`; requester derived centrally from `context.channel` (helper used by the tool); trim `requestedBy` in the inbox list to `{kind, userId, clientId}`; cancellation-failure test and an explicit system actor for cancellations. | Code-only WP-M4 items. |
| D-M5-9 | **Not** in scope, left as Mario decisions: the `marketing_project_status` field review (recommendation in the approval checklist), CORS for browser clients (recommend: none), URL elicitation / owner notification / per-request deep link (recommend: later), quota numbers, `argsHash` salting (recommend: not needed while audit is owner-only), decoupling ports between action-requests and mcp-auth (refactor, later). | Product or refactor decisions. |
| D-M5-10 | Conformance: a local smoke script/test that drives a running gateway over HTTP with raw JSON-RPC for 2026-07-28 and 2025-11-25 (`server/discover`/`initialize`, `tools/list`, `tools/call` of `orbit_projects`, `search`, error paths). The MCP Inspector run and the ChatGPT connector run are approval items (they download a tool / need the deployed endpoint and Mario's account). | No new dependency; real clients later. |

## Global Constraints

- No production step: no merge, no deploy, no flag flip, no Traefik/Coolify change, no ChatGPT run, no external tool download.
- With `ORBIT_MCP_GATEWAY=false` (default) the `mcp` process does no auth, DB or tool work and exposes only `/healthz`.
- Every new config key is compose-safe (empty = unset) and present in `docker-compose.yml`, `scripts/check-coolify-compose.mjs` (both api/worker and the new `mcp` service) and `.env.example`.
- The one migration is additive (constraint + index) and safe on existing rows (verify no row violates the CHECK).
- English code/docs; new files in `scripts/boundaries.json`; no new dependency.

## Review Focus

- **Disabled-mode container in production** (flags off) answers only `/healthz` and 404, never initialises auth or the DB → Task 1 test `disabled mode exposes nothing`.
- **Coolify strips `/mcp`** → POST `/` works the same as POST `/mcp` → Task 1 test `endpoint works with and without the prefix`.
- **Spoofed `X-Forwarded-For` / IPv6 rotation** → limits still bite → Task 2 tests.
- **Token minted for a revoked grant in the consume window** → deleted by the after-hook → Task 3 test.
- **Quota reset by re-selection** → no reset (keyed on user, client, workspace) → Task 4 test.

---

### Task 1: Deploy-safe gateway service

**Files:** `apps/api/src/mcp-main.ts`, `apps/api/src/platform/mcp/{gateway-guard,server}.ts`, `packages/config/src/index.ts`, `docker-compose.yml`, `scripts/check-coolify-compose.mjs`, `.env.example`, `apps/web/src/app/.well-known/[...path]/route.ts`; tests in `apps/api/tests/mcp-gateway*.test.ts`, the web route test, compose check.
- Disabled mode (D-M5-1); compose service (D-M5-2); `/` and `/mcp` (D-M5-3); web `.well-known` forwarding of the two PRM paths to `ORBIT_MCP_ORIGIN` (D-M5-4; default `http://mcp:4312`, compose-safe); `MCP_JWKS_URL` (D-M5-5) wired into `buildMcpServer`.
- [ ] Tests first: disabled mode (no auth init, `/healthz` 200 disabled, `/mcp` 404); enabled mode unchanged; prefix-less endpoint; web forwards only the two PRM paths; compose check asserts the `mcp` service (command, healthcheck, env, networks, `SERVICE_URL_MCP_4312`), `MCP_JWKS_URL` and `ORBIT_MCP_ORIGIN` defaults; `docker compose config` renders.
- [ ] Commit `feat(mcp): deploy-safe gateway service, internal JWKS and PRM forwarding (WP-M5)`.

### Task 2: Gateway hardening

**Files:** `apps/api/src/platform/mcp/{limits,server,adapter,shutdown,native/knowledge,native/fetch}.ts`, `apps/api/src/platform/knowledge/mcp-read.ts`; tests.
- All D-M5-6 items.
- [ ] Tests first for each item (IPv6 /64 + cap; unauthenticated counted before verification; element cap and async refinement in pre-validation; forced exit after 10 s; DPoP-bound token accepted/refused correctly; R-10 concurrency → `BUSY` after the wait; long URL → deep link; escape-heavy text stays ≤ 64 KB; query text absent from logs/audit/runs; support lists in sync).
- [ ] Commit `feat(mcp): gateway hardening before rollout (WP-M5)`.

### Task 3: OAuth pre-flip items

**Files:** `packages/config/src/index.ts` (resource normalization), `packages/db/prisma/schema.prisma` + migration `2026101900xx_mcp_grant_constraints` (CHECK + index), `apps/api/src/platform/mcp-auth/{plugins,grants,routes}.ts`; tests.
- All D-M5-7 items. Name the migration after the newest one in `main` at implementation time.
- [ ] Tests first for each item; verify the CHECK against existing local rows; `node scripts/test-db-for-worktree.ts` after the migration.
- [ ] Commit `feat(mcp-auth): pre-flip hardening of the OAuth server (WP-M5)`.

### Task 4: Proposal-surface items

**Files:** `apps/api/src/platform/mcp/{proposals,adapter,limits}.ts`, `apps/api/src/modules/action-requests.ts`, `apps/api/src/modules/marketing/tools/assignment-tools.ts`, `apps/api/src/platform/mcp-auth/grants.ts`; tests.
- All D-M5-8 items.
- [ ] Tests first for each item (quota survives re-selection; daily cache stops counting after the limit; assertion fails for a P fixture tool without `deduplicated`; inbox list without grantId/argsHash/agentRunId; cancellation failure logged, sweep continues, guard refuses; system actor).
- [ ] Commit `feat(mcp): proposal controls before rollout (WP-M5)`.

### Task 5: Conformance smoke, runbook, prepared security review

**Files:** scripts/mcp-smoke.ts (new) (drives a gateway URL with a bearer token from env; never prints the token), `apps/api/tests/mcp-conformance.integration.test.ts` (runs the same checks against an in-process gateway for both revisions), docs/deployment/MCP_ROLLOUT.md (new) (runbook), docs/security/ (new) or `docs/SECURITY_REVIEW.md` section "MCP gateway prepared review" (09 §9 checklist with evidence per item and open points).
- Runbook sections: preconditions (merge #172 + this PR), approval steps in order (see Task 6), Coolify setup (service, domain path `/mcp`, verify prefix handling and router priority, verify `X-Forwarded-For` and peer trust), flag flip order (`ORBIT_MCP_OAUTH` → `ORBIT_MCP_GATEWAY` → `ORBIT_MCP_PROPOSALS`), smoke tests after each step (discovery, PRM, 401 challenge, consent flow, `tools/list`, `search`/`fetch`, revoke), ChatGPT developer-mode connector setup, MCP Inspector run, monitoring (Uptime Kuma `/healthz`, logs for 401/429/`MCP_*`), incident steps (revoke a grant or client, stop proposals, flag off, rotate JWKS), rollback.
- [ ] Tests first for the conformance test; commit `docs(mcp): rollout runbook, conformance smoke and prepared security review (WP-M5)`.

### Task 6: Approval checklist and status docs

**Files:** `docs/IMPLEMENTATION_STATUS.md` (WP-M5 entry; tick delivered checklist items across WP-M1…M4 lists), `docs/REQUIREMENTS_TRACEABILITY.md` (WP-M5 acceptance), docs/deployment/MCP_ROLLOUT.md (new) "Approvals needed" table.
- Approval table (each a separate OK from Mario): A1 merge #172 (WP-M4), A2 merge this PR (migration + compose service; nothing exposed), A3 Coolify: domain path `/mcp` on the `mcp` service, A4 `ORBIT_MCP_OAUTH=true`, A5 `ORBIT_MCP_GATEWAY=true`, A6 ChatGPT developer-mode connector with Mario's account (read only), A7 MCP Inspector download/run, A8 `ORBIT_MCP_PROPOSALS=true`, A9 decisions from D-M5-9 (project_status fields, CORS, elicitation/notification, quota numbers).
- [ ] Docs; full check (test DB, full vitest, tsc root + web, compose check incl. `docker compose config`, boundaries/source, secrets, framework, `next build --webpack`); commit `docs: WP-M5 status, approvals and traceability`.

## Rollback

Nothing is deployed by this plan. After the approvals: flags off, or remove the `SERVICE_URL_MCP_4312` route; the migration is additive.

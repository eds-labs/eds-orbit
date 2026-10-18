# Track M, WP-M2: MCP gateway core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A separate, stateless MCP endpoint process (`apps/api/src/mcp-main.ts`) that verifies WP-M1 access tokens and serves the Orbit tool registry under the token's grant, behind `ORBIT_MCP_GATEWAY` (default `false`).

**Architecture:** One more entrypoint in the same image. A small Fastify app bridges `POST /mcp` to the official MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.3.1). Token verification reuses Better Auth's `requireMcpAuth` with an in-process `makeAuth()` instance. A principal resolver turns the verified claims into an `McpPrincipal` (grant, scopes, projects). A registry adapter computes `tools/list` and executes `tools/call` through the same `OrbitTool.execute` the assistant uses, inside the project's `Scope`. No business logic in the gateway. No tool from a module is exposed yet (WP-M3 opts tools in); WP-M2 ships one gateway-native tool, `orbit_projects`.

**Tech Stack:** Fastify 5, `@modelcontextprotocol/server` 2.3.1 (Apache-2.0; deps `@modelcontextprotocol/core` 2.3.1 and zod; no published advisory on 2026-10-18; approved by Mario 2026-10-18), Better Auth 1.7.10 (`@better-auth/mcp` `requireMcpAuth`), Prisma 7, Vitest.

**Spec:** `plans/orbit-modularization/09-mcp-gateway.md` §3.1, §3.2, §4.2, §4.3, §5.1, §5.4, §6.4, §7, §9 and `plans/orbit-modularization/07-roadmap.md` (WP-M2). WP-M1 code: `apps/api/src/platform/mcp-auth/*`.

## Risk, environment, profile

- **Risk:** high (new public endpoint). Risk analysis, tests and rollback below; security review before the flag is ever turned on (WP-M5).
- **Environment:** local only. Merging deploys code that does nothing while `ORBIT_MCP_GATEWAY=false` and while no production service runs `mcp-main.ts` (see D-M2-1).
- **App profile:** `backend-api` primary, `ai-agent-app` (tool exposure to external models), security rules.
- **Workflow:** `.agentic/workflows/feature.md`.

## Decisions taken for this plan (controller rulings; report them in the PR)

| # | Decision | Why |
|---|---|---|
| D-M2-1 | The production `mcp` compose service and its Traefik `/mcp` route are added in **WP-M5**, not here. WP-M2 adds the entrypoint, a local run script and docs. | A merge to `main` deploys; the route and the extra container need their own approval (Q-22 placement stays: own service under `https://orbit.eds-labs.io/mcp`). |
| D-M2-2 | Token verification uses `requireMcpAuth(auth, …)` with the gateway's own `makeAuth()` instance (same DB), `issuer = ${APP_ORIGIN}/api/auth`, `resource = MCP_RESOURCE`. | No network hop to the API for JWKS; the library already checks signature, `iss`, `aud`, `exp`, DPoP. |
| D-M2-3 | Project-less call logging reuses `McpGrantEvent` (action `mcp.call`) instead of a new `McpCallLog` table; project calls write `AuditEvent` `mcp.tool_call`. | Same columns (user, client, grant, workspace, detail); no migration. |
| D-M2-4 | Gateway-native tools (`orbit_projects` now; `orbit_profile`, `search`, `fetch` in WP-M3) live in `platform/mcp/native-tools.ts`; module tools come only through the adapter and `exposure.mcp`. | They are workspace-level and need no project `Scope`. |
| D-M2-5 | Rate limits are in-process per gateway (single container); Redis-backed limits are a WP-M5 item if more than one gateway runs. | YAGNI for one process. |
| D-M2-6 | Requests with an `Origin` header are refused unless the origin is in `ORBIT_MCP_ALLOWED_ORIGINS` (default empty). Cookies are ignored. | DNS-rebinding/browser-CSRF guard; ChatGPT calls server-side without Origin. |
| D-M2-7 | Supported protocol revisions follow Task 0's SDK findings: 2026-07-28 always; 2025-11-25 only if the SDK serves it statelessly without a session store — otherwise rejected with the SDK's unsupported-version error and recorded for WP-M5. | Spec asks for both; the SDK decides what is safe without server sessions. |

## Global Constraints

- The gateway contains no business logic: it adapts the registry, permissions, module activation and grants (`09` guiding rule).
- Effective permission = tool permission ∩ user's current role in the project (incl. module roles) ∩ grant (projects, scopes, modules) ∩ module activation; it never widens UI rights (`09` §4.2).
- Scope mapping: `R0_read` needs `orbit:read`; `P_proposal` needs `orbit:propose`; `W0_internal` needs `orbit:write` (not offered, so never exposed). Granted scopes = token `scope` ∩ `McpGrant.scopes`.
- `aud` must include `MCP_RESOURCE`; `iss` = `${APP_ORIGIN}/api/auth`; grant must be `active`, not expired (`expiresAt`), user still a member (`activeGrantForToken`) and every project re-checked with `projectMembership` on every call.
- Only tools with `exposure.mcp === true` **and** an `outputSchema` can appear; hard floors never appear.
- Tool results: `structuredContent` = validated output, `content` = JSON text copy, size cap 64 KB; cards become Orbit links, never UI.
- Audit rows carry tool, client id, grant id, outcome code, duration and an argument **hash** — never argument values or results.
- 401 answers carry `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`.
- `ORBIT_MCP_GATEWAY=false`: `mcp-main.ts` refuses to start (exit code 1, clear message); the API and web are unchanged.
- New config keys are compose-safe (empty string = unset, `unset()` helper) and added to `docker-compose.yml`'s `x-api-environment` and `scripts/check-coolify-compose.mjs`.
- English code and docs; new files listed in `scripts/boundaries.json` zones; no dependency beyond `@modelcontextprotocol/server` 2.3.1 (and its `@modelcontextprotocol/core`).

## Review Focus

- **Token for another resource or issuer** (e.g. a WP-M1 token whose `aud` lacks `MCP_RESOURCE`, or one signed by a foreign key) → 401 with the PRM challenge, nothing executed. → Task 2 test `foreign aud and issuer are refused`.
- **Grant revoked between list and call** → the call is refused (401/`insufficient` mapping per §6.4) and audited as refused. → Task 3 test `revoked grant refuses a call listed a moment ago`.
- **Project removed from the user (membership gone) while the grant still lists it** → the project's tools vanish from the list and calls are refused. → Task 2 test `lost membership hides the project`.
- **Oversized or malformed tool arguments** (unknown fields, wrong types, 1 MB string) → JSON-RPC invalid params with zod paths only, no values echoed, request body limit enforced. → Task 3 test `invalid arguments name paths, not values`.
- **Browser request with an Origin and a stolen token** → 403 before token use. → Task 3 test `foreign Origin is refused`.

---

### Task 0: Install the SDK and pin its behaviour

**Files:** Modify `package.json`, `pnpm-lock.yaml`; Create `apps/api/tests/mcp-sdk.characterization.test.ts`; Modify this plan ("Task 0 findings").

- [ ] **Step 1:** Re-run the advisory check for `@modelcontextprotocol/server` and `@modelcontextprotocol/core`; stop if one affects 2.3.1.
- [ ] **Step 2:** `corepack pnpm add @modelcontextprotocol/server@2.3.1 --save-exact -w` (hand-edit package.json if pnpm re-sorts it; pnpm's minimum release age must pass — 2.3.1 is from 2026-10-05).
- [ ] **Step 3:** Characterization tests (no Orbit DB) that record:
  - `createMcpHandler(factory, options)` signature; whether the factory receives the request / `authInfo` (needed to build a per-principal tool list); option values of `legacy` and what a 2025-11-25 `initialize` gets with each;
  - how `registerTool` takes `inputSchema` (zod or JSON Schema), `outputSchema`, `annotations`, `_meta`, and how a handler returns `structuredContent` + `content` + `isError`;
  - what the SDK does with a thrown error vs a returned `isError` result, and with invalid params (does it echo values?);
  - response content type (JSON vs request-scoped SSE) for a plain `tools/list`/`tools/call`;
  - how `fetch(request, { authInfo })` passes auth info to handlers.
- [ ] **Step 4:** Run, append "Task 0 findings" to this plan (exact shapes, file:line in node_modules), settle D-M2-7.
- [ ] **Step 5:** Commit `chore(mcp): pin the MCP TypeScript SDK 2.3.1 (WP-M2)`.

### Task 1: Contracts — exposure, output schema, channel, flag

**Files:** Modify `apps/api/src/modules/agents/tools/registry.ts` (OrbitTool, ToolContext, defineTool validation), `apps/api/src/platform/modules/contributions.ts` (registration validation), `apps/api/src/platform/ai/telemetry.ts` (`RunKind` += `"mcp"`), `packages/config/src/index.ts`, `.env.example`, `docker-compose.yml`, `scripts/check-coolify-compose.mjs`; Test `apps/api/src/modules/agents/tools/registry.test.ts`, `apps/api/tests/module-contributions.test.ts`, config tests.

**Interfaces (produces):**
- `OrbitTool.exposure?: { assistant?: boolean; mcp?: boolean }` — absent = `{ assistant: true, mcp: false }`; `exposedToAssistant(tool)`, `exposedToMcp(tool)` helpers.
- `OrbitTool.outputSchema?: z.ZodType` and `OrbitTool.openWorld?: true`.
- `ToolContext.channel?: { kind: "mcp"; clientId: string; grantId: string; requestId: string }` (absent = assistant).
- Registration fails when `exposure.mcp === true` and `outputSchema` is missing (error names the tool).
- The assistant's offer path (`chat-runner.ts`) skips tools with `exposure.assistant === false` (no current tool sets it; test with a fixture tool).
- Config: `ORBIT_MCP_GATEWAY` (`"false"|"true"`, default `"false"`), `MCP_PORT` (default 4312), `ORBIT_MCP_ALLOWED_ORIGINS` (comma list, default empty), all compose-safe; the gateway refuses to start unless `ORBIT_MCP_GATEWAY === "true"` **and** `ORBIT_MCP_OAUTH === "true"`.

- [ ] Tests first: absent exposure defaults; mcp without outputSchema rejected at registration; assistant offer skips `assistant:false`; config defaults/empty strings; compose check passes with the new keys.
- [ ] Implement; run registry, contributions, config, chat-runner and compose checks; commit `feat(mcp): tool exposure, output schemas and the gateway flag (WP-M2)`.

### Task 2: Principal resolution and the permission intersection

**Files:** Create `apps/api/src/platform/mcp/principal.ts`, `apps/api/src/platform/mcp/visibility.ts`; Test `apps/api/tests/mcp-principal.integration.test.ts`.

**Interfaces (produces):**
- `type McpPrincipal = { userId: string; clientId: string; grantId: string; workspaceId: string; scopes: ReadonlySet<string>; projectIds: readonly string[] }`.
- `resolvePrincipal(claims: JWTPayload): Promise<McpPrincipal | null>` — `activeGrantForToken`, `expiresAt` check, token `scope` ∩ grant scopes, `allCurrentProjects` resolved to the user's current projects in the workspace, every project kept only if `projectMembership` succeeds; null when nothing usable remains.
- `projectScope(principal, projectId): Promise<Scope>` — throws `DomainError("NOT_FOUND", 404)` when the project is not in `principal.projectIds` or membership is gone (via `actorScope`).
- `requiredScope(tool): "orbit:read" | "orbit:propose" | "orbit:write"` from `tool.risk`.
- `visibleMcpTools(principal, projectId): Promise<OrbitTool[]>` — registry tools with `exposedToMcp`, owner module enabled for that project (`enabledModules` + `visibleModules`), grant `modules` restriction, `effectiveRole(scope, owner) !== "none"`, `availableTools([tool], role, features)` with the module assistants' features, and `requiredScope(tool) ∈ principal.scopes`; deterministic order by name.
- `authorizeMcpCall(principal, toolName, projectId): Promise<{ tool: OrbitTool; scope: Scope }>` — the same checks for one tool; refusal codes `MCP_TOOL_NOT_ALLOWED` (403) or `NOT_FOUND` (404) for the project.

- [ ] Tests first (fixture module from `tests/fixtures/modules/tasks` with a tool flagged `mcp: true` + outputSchema, plus an unflagged one): a permission-intersection matrix over role (owner/editor/viewer/non-member) × module (enabled/disabled, module role none) × grant (project in/out, modules restriction) × scope (read only / read+propose) × tool risk (R0/P) asserting list membership and call refusal; Review Focus tests `foreign aud and issuer are refused` (via Task 3's verifier if needed — keep here as principal-level: claims without an active grant), `lost membership hides the project`, expired grant, revoked grant.
- [ ] Implement; run; commit `feat(mcp): principal and permission intersection for MCP calls (WP-M2)`.

### Task 3: The gateway process, transport and adapter

**Files:** Create `apps/api/src/mcp-main.ts`, `apps/api/src/platform/mcp/server.ts` (Fastify app `buildMcpServer(options?)`), `apps/api/src/platform/mcp/adapter.ts`, `apps/api/src/platform/mcp/native-tools.ts`, `apps/api/src/platform/mcp/errors.ts`; Modify `scripts/boundaries.json`, `package.json` (script `mcp:start` = `tsx apps/api/src/mcp-main.ts` only if the repo uses such scripts); Test `apps/api/tests/mcp-gateway.integration.test.ts`.

**Interfaces (produces):**
- `buildMcpServer(options?: { cimdFetch?: typeof fetch }): Promise<FastifyInstance>` with routes: `POST /mcp` (bridged to the SDK handler wrapped in `requireMcpAuth`), `GET`/`DELETE /mcp` → 405 (unless D-M2-7 keeps 2025-11-25 needing them), `GET /.well-known/oauth-protected-resource/mcp` and `GET /.well-known/oauth-protected-resource` (both describe `MCP_RESOURCE`, `authorization_servers: [issuer]`, `scopes_supported` = `orbit:read orbit:propose`, `bearer_methods_supported: ["header"]`), `GET /healthz`.
- Adapter: MCP name = `<owner>_<toolName>` unless the tool name already starts with the owner prefix (platform tools keep their name); `inputSchema` = tool parameters + required `projectId` (uuid) — optional when the grant holds exactly one project; annotations per `09` §5.1 table (`openWorldHint` when `tool.openWorld`); `_meta.securitySchemes = [{ type: "oauth2", scopes: [requiredScope] }]`; output validated against `outputSchema`, capped at 64 KB (over cap → `isError` `OUTPUT_TOO_LARGE`); `structuredContent` + `content: [{ type: "text", text: JSON }]`; `cards` dropped (links only in later tasks).
- Execution: `tool.execute({ scope: moduleScope(scope, owner), runId: <mcp request id>, conversationId: \`mcp:${requestId}\`, callIndex: 0, channel }, args)`.
- Native tool `orbit_projects` (R0, `orbit:read`): `{ workspace: { id, name }, projects: [{ id, name, modules: string[] }] }` for the principal's projects.
- Error mapping per `09` §6.4 in `errors.ts`: DomainError → `isError` with `structuredContent { code, message, retryable }`; zod → JSON-RPC invalid params with paths only; unknown → `REQUEST_FAILED` + request id; 401 challenge with `_meta["mcp/www_authenticate"]` on tool results when the grant vanished mid-session.
- Process: `mcp-main.ts` refuses to start unless both flags are true; listens on `BIND_HOST`/`MCP_PORT`; closes app and DB on SIGINT/SIGTERM; body limit 256 KB; Origin policy (D-M2-6); client IP from the right-most `X-Forwarded-For` only when the TCP peer is trusted (reuse `isTrustedPeer`).

- [ ] Tests first (Fastify inject + real WP-M1 tokens from `mcp-oauth-flow-helpers.ts`): unauthenticated → 401 + challenge header; PRM documents; `initialize` (2026-07-28) → server info; `tools/list` lists `orbit_projects` and only allowed fixture tools; `tools/call` success with `structuredContent`; DomainError mapping; Review Focus tests `revoked grant refuses a call listed a moment ago`, `invalid arguments name paths, not values`, `foreign Origin is refused`; flag off → `buildMcpServer` throws / main exits 1; protocol test for 2025-11-25 per D-M2-7.
- [ ] Implement; run; commit `feat(mcp): the MCP gateway process and registry adapter (WP-M2)`.

### Task 4: Audit, telemetry and rate limits

**Files:** Create `apps/api/src/platform/mcp/audit.ts`, `apps/api/src/platform/mcp/limits.ts`; Modify `server.ts`/`adapter.ts` of Task 3; Test `apps/api/tests/mcp-gateway-audit.integration.test.ts`.

**Interfaces (produces):**
- `auditToolCall({ principal, scope?, tool, outcome, durationMs, argsHash })` — project calls: `AuditEvent` action `mcp.tool_call`, metadata `{ tool, clientId, grantId, outcome, durationMs, argsHash }` inside `scoped()`; project-less calls: `recordGrantEvent({ action: "mcp.call", … detail: { tool, outcome, durationMs, argsHash } })` (extend the action union).
- `McpGrant.lastUsedAt` updated at most once per minute per grant.
- An `AgentRun` of kind `mcp` per tool call with one `tool_call` span (best effort, like chat).
- Limits (configurable constants): per grant 120 calls/min, per user 240/min, per client 600/min; unauthenticated requests 30/min per client IP; over limit → HTTP 429 + `Retry-After`, tool-level `isError` `RATE_LIMITED` where the transport already answered 200.

- [ ] Tests first: audit row written for success and refusal without argument values (assert a secret-looking argument string is absent from every column); project-less `orbit_projects` → `McpGrantEvent` `mcp.call`; lastUsedAt throttle; 121st call in a minute → 429; unauthenticated burst → 429.
- [ ] Implement; run; commit `feat(mcp): audit, call log and rate limits for the gateway (WP-M2)`.

### Task 5: Documentation and the full check

**Files:** `docs/IMPLEMENTATION_STATUS.md` (WP-M2 entry: flags, process, routes, decisions D-M2-1…7, Task 0 findings summary, known limitations, WP-M5 items: compose service + Traefik route + PRM paths + Redis limits + MCP Inspector conformance), `docs/REQUIREMENTS_TRACEABILITY.md` (WP-M2 acceptance → tests; Inspector conformance marked WP-M5), `plans/orbit-modularization/09-mcp-gateway.md` (dated notes for D-M2-1/3/4/7), `docs/SECURITY_REVIEW.md` if it has a gateway section (O-6).

- [ ] Write docs; full vitest run (per-worktree test DB: `node scripts/test-db-for-worktree.ts` first), `tsc` root + web, compose check, source-check, secrets check, boundaries lint; commit `docs: WP-M2 status, traceability and security notes`.

## Risk analysis

| Risk | Mitigation |
|---|---|
| Token or grant confusion widens access | Library verification + `resolvePrincipal` + per-call `projectScope`; intersection matrix tests. |
| New public endpoint abused | Flag off by default; no production service until WP-M5; Origin policy; rate limits; body limit. |
| Exposing a module tool by accident | `exposure.mcp` opt-in + mandatory `outputSchema`; WP-M2 exposes no module tool. |
| Data leaving to external models | No module tools yet; WP-M3 adds `modelUse` filtering. |
| SDK behaviour drift | Exact pin; Task 0 characterization tests. |

## Rollback

Flag off (`ORBIT_MCP_GATEWAY=false`) or simply not running `mcp-main.ts`. No migration in WP-M2. Revert the PR to remove the dependency.

## Task 0 findings

*(appended during Task 0)*

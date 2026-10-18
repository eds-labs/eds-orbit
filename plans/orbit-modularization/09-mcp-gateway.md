# 09 — Orbit MCP gateway

**Status:** Accepted design baseline ([ADR 0009](../../docs/adr/0009-modular-platform.md), 2026-10-13); not implemented. Written 2026-10-13. It follows Mario's addendum: a central MCP server for EDS Orbit, securely reachable over the internet, for ChatGPT, personal ChatGPT dots and other compatible MCP clients. **Nothing is implemented.** Work package IDs refer to `07-roadmap.md`.

**Legend:**
- **[Fact]**: observed in Orbit's code, or in external documentation as of 2026-10-13. External sources are listed at the end.
- **[Proposal]**: target.
- **[Open]**: decision or verification needed.

**Guiding rule (from the assignment):** the MCP gateway contains **no business logic**. It is a protocol and authentication adapter. Every call runs through the same permission-checked services, tool registry and approval mechanism as the Orbit UI and the Orbit Assistant.

---

## 1. Existing building blocks in Orbit

| Area | Finding | Reuse |
|---|---|---|
| MCP code | **[Fact]** None. No MCP server, client or SDK dependency exists (`package.json`, `pnpm-lock.yaml`). | — |
| Decision history | **[Fact]** ADR 0007 §5 and `docs/OPENAI_AGENT_PLATFORM_ALIGNMENT_PLAN.md` (lines 275-280) keep the registry "MCP-shaped" (name, description, JSON schema, read/write annotation) so that "a later Orbit MCP server needs no tool rewrite". A read-only MCP server is a P3 option and an explicit non-goal (`docs/ORBIT_ULIQUID_PRODUCTION_GOAL.md` (line 71)). ADR 0007 rejects *hosted* MCP for Orbit's own agent, because OpenAI's servers would call Orbit with stored credentials and bypass the per-transaction scope. | Mario's addendum **lifts the non-goal** for an inbound MCP server (AD-20). The ADR 0007 concern does not apply to the gateway: every MCP call executes inside Orbit under `scoped()`, RLS, permission checks and the budget journal. |
| Tool registry | **[Fact]** `OrbitTool` (`apps/api/src/modules/agents/tools/registry.ts:37-48`): name, namespace, description, zod `parameters`, risk `R0_read \| W0_internal \| P_proposal`, roles, feature, `execute(ctx, args)`. JSON schemas are generated from zod (`responsesTool`, `:54-71`). Strict-keyword validation (`:75-110`) is a subset of JSON Schema and therefore MCP-compatible. | **Direct reuse.** MCP `tools/list` is generated from the registry, and `tools/call` dispatches to `execute`. Gaps to close: `ToolContext.conversationId` is chat-specific, `ToolResult.cards` is chat-specific, and only read tools validate their output (`chat-tools.ts:476`). WP1.6 already opens these. |
| Approvals | **[Fact]** `ActionRequest` (`action-requests.ts`): hash-bound, single-use, decider role, TTL, audit, consumed by deterministic executors. Hard floors in ADR 0008 §4. | **Direct reuse.** MCP proposal tools create ActionRequests. Approval happens in Orbit, never by the MCP client's own confirmation. |
| Authentication | **[Fact]** Better Auth 1.7.5, email/password with DB sessions, cookies only (`apps/api/src/auth.ts`). Allowed paths: sign-in, sign-out, get-session (`server.ts:522-557`). No API tokens, no OAuth server. Installed plugins include `jwt`, `bearer`, `device-authorization` and `organization`, but **no OAuth provider** in the installed package. | User identity, sessions and the login page are reused for the OAuth consent flow. The OAuth authorization server is new (§4). |
| Tenancy and permissions | **[Fact]** `scopeFor` and `projectMembership` (`auth.ts:57-76`, `member-scope.ts:8-43`), `scoped()` with RLS. `actorScope()` re-reads the requester's current role when a job runs. | **Direct reuse.** The MCP gateway builds a `Scope` from the token's user and the requested project through the same membership function, then calls `authorize(permission)` (WP1.5). |
| Knowledge | **[Fact]** `retrieve` and `retrieveHybrid` with `purpose` and `forModel` filters (rights `publicUse` and `modelUse`), evidence packs (`packages/knowledge/src/index.ts:638-848`, `retrieval.ts`). | Basis for the MCP `search` and `fetch` tools and the knowledge resources. |
| Budget and telemetry | **[Fact]** `reserve`, `markTransmitted` and `settle`, run keys, `AgentRun`/`AgentSpan`, `AuditEvent`. | Paid operations triggered through MCP (for example query embeddings) are reserved under `mcp:<grantId>:<requestId>`. Every call is audited. |
| Rate limiting | **[Fact]** `@fastify/rate-limit` keyed by `req.ip`. Behind the Next proxy that is effectively global (F-02). | Replaced for MCP by per-token, per-user and per-client keys (§7). |
| Public ingress | **[Fact]** Only `web` is routed by Traefik (`docker-compose.yml`). The Next proxy forwards only `/api/*` paths and a header allowlist **without `Authorization`** (`apps/web/src/app/api/[...path]/route.ts:41-56`), with a 45 s timeout (`:66`). | The MCP and OAuth endpoints need their **own route**, not the Next proxy (§3). |
| Events | **[Fact]** Notify-in-transaction plus sender jobs (`agents/notifications.ts`), outbox. | The source for the optional MCP event stream (§6.5). |

**[Inference]** About 70 % of what the gateway needs already exists as services: registry, approvals, tenancy, retrieval, budget and audit. What is new is protocol handling, the OAuth authorization server with consent and grants, a dedicated ingress route and per-token rate limiting.

## 2. What the clients actually support

These facts are dated 2026-10-13. Verify them again at implementation time (WP-M5), because both ChatGPT and the MCP specification are moving.

### 2.1 MCP specification

- **[Fact] Current revision is 2026-07-28.**
  - **Stateless:** no `initialize` handshake and no `Mcp-Session-Id`. Version and capabilities travel in `_meta` on every request. There is a new `server/discover`.
  - **Change notifications:** `subscriptions/listen` replaces the GET stream and `resources/subscribe`.
  - **Multi Round-Trip Requests** (`input_required`) replace server-initiated elicitation and sampling.
  - **Tasks** moved to an extension.
  - **SSE resumability was removed.**
  - Roots, Sampling and Logging are deprecated. HTTP+SSE transport is deprecated.
  - **Authorization:** OAuth 2.1, Protected Resource Metadata (RFC 9728) is MUST, Client ID Metadata Documents (CIMD) are SHOULD, Dynamic Client Registration (DCR) is deprecated, and `iss` validation (RFC 9207) applies.
- **[Fact]** Clients in the field still speak **2025-11-25**, which is stateful with `initialize`. **[Proposal]** The gateway therefore supports both revisions. The official TypeScript SDK v2 does, and Better Auth's MCP docs reference it.

### 2.2 ChatGPT (developer mode, plugins)

- **Custom MCP servers:**
  - **[Fact]** Supported through **Developer mode** (beta). Availability depends on plan and workspace policy.
  - **[Open]** Sources disagree on whether Pro accounts are limited to read/fetch while Business and Enterprise get full read/write.
- **Transport:** **[Fact]** Streamable HTTP and SSE.
- **Write confirmation:** **[Fact]** ChatGPT asks the user for manual confirmation before write actions. OpenAI also notes that writes can happen even when a tool is annotated read-only. **Orbit must not rely on client-side confirmation.**
- **Deep research and company knowledge:** **[Fact]** These require two read-only tools named **`search` and `fetch`**. Results go in `structuredContent` with an output schema. Citations require a non-empty `url`.
- **Authentication:** **[Fact]** OAuth 2.1 authorization code with **PKCE S256**:
  - **CIMD is preferred.** The client IDs are `https://chatgpt.com/oauth/client.json` and `https://chatgpt.com/oauth/{callback_id}/client.json`. Accepted token endpoint auth methods are `none` and `private_key_jwt`; the latter needs ChatGPT's JWKS.
  - DCR is still supported. A predefined client is possible.
  - Protected Resource Metadata at `/.well-known/oauth-protected-resource`.
  - Authorization server metadata per RFC 8414 or OIDC.
  - The **`resource` indicator** is sent on the authorization and token requests and must be bound into `aud`.
  - **RFC 9207 `iss`** in every authorization response. Redirect URI: `https://chatgpt.com/connector_platform_oauth_redirect`, or a callback-ID-specific one.
  - Per-tool **`securitySchemes`**. The linking UI is triggered by `_meta["mcp/www_authenticate"]` on an `isError` result.
  - A read-only **profile tool** marked `_meta["openai/profile"]: true` that returns a stable opaque ID (multi-account support).
  - Optional verification of ChatGPT's **mTLS client certificate** (SAN `mtls.prod.connectors.openai.com`) and egress IP allowlisting.
  - ChatGPT does **not** support client credentials, API keys or customer mTLS certificates.

### 2.3 ChatGPT dots

- **[Fact]** Dots were announced at DevDay 2026-09-29: always-on personal agents in ChatGPT.
  - Sources report a **limited beta** (Pro and some markets), and say dots reach apps through **plugins**. Plugins are bundles of skills and MCP servers, shared across ChatGPT, Work, Codex and dots.
  - **[Open]** Whether a dot can use a *custom developer-mode* MCP server, as opposed to a published or installed plugin, is **not documented**.
- **[Proposal]** Design the gateway so it can be packaged as an OpenAI plugin (MCP server plus optional skills or instructions) **without server changes**. That needs:
  - standard OAuth;
  - a profile tool;
  - `search`/`fetch`;
  - good tool descriptions and annotations.

  Treat dots support as a **verification item** in WP-M5, not a design driver.
- **Always-on agents call tools without a human watching each step.** This strengthens the requirement that **every consequential action becomes an Orbit ActionRequest** decided in Orbit, never inside the client.

### 2.4 Other clients

Claude (web and desktop connectors), Codex, Cursor and other MCP clients use the same OAuth and MCP standards. With CIMD, DCR (for backward compatibility) and both protocol revisions, the gateway serves them without client-specific code. The ChatGPT-specific `_meta` keys are ignored by other clients.

## 3. Target architecture

```mermaid
flowchart LR
  subgraph Clients
    CG[ChatGPT developer mode / plugin]
    DOT[ChatGPT dots — via plugin, to verify]
    OC[Other MCP clients: Claude, Codex, …]
  end
  subgraph Edge[Traefik — orbit.eds-labs.io: /mcp → mcp service, OAuth paths → api, rest → web]
  end
  subgraph Orbit[Orbit — one image]
    subgraph AS[OAuth authorization server — Better Auth OAuth provider in apps/api]
      MD[/.well-known/oauth-authorization-server + openid-configuration + jwks/]
      AZ[/authorize → Orbit login + consent: org/project/scope grant/]
      TK[/token · revoke · userinfo/]
    end
    subgraph GW[MCP gateway — service 'mcp' (same code, own process)]
      PRM[/.well-known/oauth-protected-resource/mcp/]
      EP[/mcp — Streamable HTTP, protocol 2025-11-25 + 2026-07-28/]
      V[Token verification: JWKS, iss, aud=resource, exp, scopes]
      G[Grant resolution → Scope via projectMembership + module activation]
      AD[Registry adapter: tools/list, tools/call, resources, search/fetch]
      RL[Rate limits · audit · error mapping]
    end
    subgraph Plat[Orbit Platform services — unchanged business logic]
      REG[Tool registry — module-contributed tools]
      AUTHZ[Permissions catalogue + module roles]
      KS[Knowledge services]
      AR[ActionRequests + deterministic executors]
      BUD[Spend mandate + budget ledger]
      AUD[Audit · telemetry]
      NT[Notifications · events]
    end
    UI[Orbit web: consent screen · Connected apps · approval inbox]
  end
  CG --> Edge
  DOT --> Edge
  OC --> Edge
  Edge --> AS
  Edge --> GW
  GW --> V --> G --> AD
  AD --> REG
  AD --> KS
  REG --> AUTHZ
  REG --> AR
  REG --> BUD
  AD --> AUD
  AS --> UI
  AR --> UI
```

### 3.1 Components and placement

| Component | Placement | Rationale |
|---|---|---|
| **OAuth authorization server** (issuer `https://orbit.eds-labs.io`) | Inside `apps/api`, using Better Auth's OAuth provider, MCP and CIMD packages (AD-21). Endpoints routed by Traefik directly to `api` for `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration`, `/oauth2/*` and the JWKS. | It shares the user store, sessions and login. An external IdP (Keycloak, Auth0) would duplicate identity and add operating cost. |
| **Consent and grant UI** | `apps/web` platform view `/oauth/consent`, plus **Settings → Connected apps** | The user sees the client (name and logo from CIMD metadata), chooses organization, projects and scopes, and can revoke access later. |
| **MCP gateway** (resource and endpoint `https://orbit.eds-labs.io/mcp`) | **Own compose service `mcp`** built from the same image with a separate entrypoint (`tsx apps/api/src/mcp-main.ts`). Traefik routes the path `/mcp` and `/.well-known/oauth-protected-resource/mcp` to it, with higher priority than the `web` catch-all (decided by Mario, Q-22). | It bypasses the Next proxy, which forwards neither `Authorization` nor non-`/api` paths and aborts at 45 s. It also isolates failure, rate limits and scaling from the UI API. It reuses the identical platform code, so there is no duplicated logic. |
| **Platform services** | Unchanged (`apps/api/src/platform/**`) | The gateway calls them in-process. There is no HTTP hop to the API and no second implementation. |

> **Note 2026-10-17 (WP-M1, D2 and D3, approved by Mario).** The issuer is configured as `${APP_ORIGIN}/api/auth` (Better Auth's path issuer), so it will be `https://orbit.eds-labs.io/api/auth` once deployed (nothing is deployed yet), not the bare origin: endpoints are `/api/auth/oauth2/*` and `/api/auth/jwks`, metadata is at `/.well-known/oauth-authorization-server/api/auth` and `/api/auth/.well-known/openid-configuration`. In WP-M1 the endpoints are reached through the existing web proxy plus a small Next route for the root `/.well-known/*` paths, not through a Traefik route; the direct Traefik route is decided with `/mcp` in WP-M2. The issuer is bound into tokens and client configurations and must stay stable. Every configured resource needs `allowedScopes` (a Prisma list column reads back `null` otherwise).

**Rejected alternative:** mount `/mcp` inside the existing `api` process. That means one container fewer, but MCP traffic shares the event loop, the DB pool and the rate limits with the UI.

**Resource identifier (Q-22, decided 2026-10-13):** `https://orbit.eds-labs.io/mcp`. There is no new subdomain and no DNS change. Because the resource has a path, its Protected Resource Metadata is served at `https://orbit.eds-labs.io/.well-known/oauth-protected-resource/mcp` (RFC 9728 path insertion), and the 401 challenge points there explicitly. Some clients probe only the root `/.well-known/oauth-protected-resource`, so that URL is served too and describes the same resource. Verify both in WP-M5. The identifier must be stable forever, because it is bound into tokens and client configurations. Trade-off: the MCP and UI traffic share the hostname, the TLS certificate and Traefik. The service separation still isolates processes and limits.

> **Note 2026-10-18 (WP-M2, D-M2-1).** The gateway process exists (`apps/api/src/mcp-main.ts`, `pnpm mcp:start`), but the production compose service `mcp`, its healthcheck and the Traefik routes for `/mcp` and the Protected Resource Metadata paths are added in WP-M5, not in WP-M2. Merging WP-M2 deploys code and one migration (`202610180010_mcp_run_kind`, which allows `mcp` as an `AgentRun` kind); nothing starts the gateway, and `ORBIT_MCP_GATEWAY` stays `false`. The gateway listens on `MCP_PORT` (default 4312). See `docs/IMPLEMENTATION_STATUS.md` ("Track M WP-M2").

### 3.2 Request flow

1. The client calls `/mcp` without a token. The gateway answers **401** with `WWW-Authenticate: Bearer resource_metadata="https://orbit.eds-labs.io/.well-known/oauth-protected-resource/mcp"`. For tool results it also sets `isError` with `_meta["mcp/www_authenticate"]`, which ChatGPT needs to show its linking UI.
2. The client discovers the authorization server and starts **authorization code + PKCE** with `resource=https://orbit.eds-labs.io/mcp`. It identifies itself by its CIMD URL, or a DCR client ID for older clients.
3. Orbit `/oauth2/authorize`:
   - If there is no session, the Orbit login page is shown.
   - Then the **consent screen**: the client's identity, the requested scopes, and the user's choice of **organization and projects**, preselected and limited to the user's memberships.
   - Orbit stores an `McpGrant` and redirects with `code` and `iss`.
4. The token endpoint issues:
   - a short-lived **JWT access token**, 10 min for example, with `aud=resource`, `sub=userId`, `client_id`, `scope` and `grant_id`;
   - a **rotating refresh token**.
5. Each `/mcp` request goes through these checks:
   1. Verify the token: signature via JWKS, `iss`, `aud`, `exp`, scope.
   2. Load the grant. It must not be revoked or expired.
   3. Resolve the requested project. It must be in the grant **and** a current membership (`projectMembership`).
   4. Build the `Scope`.
   5. Check module activation and `authorize(permission ∩ granted scopes)`.
   6. Run the tool inside `scoped()`.
   7. Audit.
   8. Map the result.
6. **Revocation:**
   - A user revokes a grant in Connected apps.
   - An owner revokes a user.
   - A user leaves the project.

   In all three cases the next call fails, because membership and grant are checked on every request. Access tokens are short-lived, so revocation takes effect at once for grants and within at most the token TTL for anything cached in tokens. The grant check is a DB lookup, so effectively immediately.

> **Note 2026-10-18 (WP-M2, D-M2-7 and JWKS).** The handler is created with the SDK's `legacy: "stateless"` mode, so one factory serves revision 2026-07-28 and the legacy era (2025-11-25 and older revisions the SDK accepts) without sessions: there is no `mcp-session-id`, and `GET`, `DELETE` answer 405. The Task 0 characterization showed that the SDK serves 2025-era traffic statelessly, so ChatGPT's current revision works without a session store. `subscriptions/listen` is refused until WP-M6. Step 5.1 is verified with Better Auth's `requireMcpAuth`, which fetches the JWKS **over HTTP** (default `${APP_ORIGIN}/api/auth/jwks`, cached for 5 minutes); the library has no in-process key path, so the earlier idea of verifying without a network hop does not hold. An internal JWKS URL is a WP-M5 decision. Steps 5.2 to 5.5 are `resolvePrincipal` and `authorizeMcpCall`, run on every request.

## 4. Authentication and authorization model

### 4.1 Authorization server (AD-21)

| Aspect | Proposal |
|---|---|
| Implementation | Better Auth OAuth provider plus the MCP and CIMD packages plus the `jwt` plugin, pinned to versions **with the published fixes**: unbound resource indicators, the client-creation privilege bypass and the authorization-code race (see sources). New dependencies need Mario's approval. |
| Client registration | **CIMD first.** It fetches the client metadata document through Orbit's SSRF-safe fetch (`packages/knowledge/src/safe-fetch.ts` pattern), caches it per HTTP cache headers and allowlists redirect URIs from the document. **DCR enabled only for backward compatibility**, rate-limited, with registered clients auto-expiring when unused. |
| Grant types | `authorization_code` with PKCE S256 only, plus `refresh_token`. **No** client credentials, password or implicit grant. |
| Token format | JWT access tokens (aud-bound, 10 min) and opaque rotating refresh tokens stored hashed, with reuse detection that revokes the whole grant. |
| Discovery | RFC 8414 plus OIDC metadata with `code_challenge_methods_supported: ["S256"]`, `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true` (with `iss` in **every** response), and `scopes_supported`. |
| UserInfo | `sub`, `email`, `email_verified`. ChatGPT Enterprise domain restrictions need these. |
| Client authentication | `none` (public plus PKCE) and `private_key_jwt` (ChatGPT's JWKS). Secrets only for an explicitly predefined client. |
| Optional hardening | Verify ChatGPT's mTLS client certificate at Traefik and pass a verified flag to the gateway. Egress IP allowlist as a defence-in-depth signal, never as authentication. |
| Data | New tables in the **auth** schema: OAuth client, consent, access/refresh tokens and JWKS (Better Auth managed), plus Orbit's `McpGrant`. Owned by `orbit_auth` and added to the grant list in `scripts/db-deploy.ts` (lines 131-143). |

> **Note 2026-10-17 (WP-M1).** Implemented locally behind `ORBIT_MCP_OAUTH` (default off) with the issuer path from §3.1; see `docs/IMPLEMENTATION_STATUS.md` for the endpoints, decisions D1–D7 and the known limitations. In the token, `aud` is an array that includes the resource (and the userinfo endpoint), so the gateway checks inclusion, not equality.

### 4.2 Scopes and grants

**Coarse OAuth scopes** keep consent understandable and avoid exceeding what clients display:

| Scope | Meaning |
|---|---|
| `openid email profile` | identity (profile tool, UserInfo) |
| `orbit:read` | read tools and resources of enabled modules |
| `orbit:propose` | proposal tools: they create ActionRequests, never side effects |
| `orbit:write` | internal writes (`W0`), for example a support internal note or a draft revision. Granted only when the user explicitly ticks it. |

**`McpGrant(id, userId, clientId, workspaceId, projectIds[] | "all_current", scopes[], modules[]?, createdAt, expiresAt, revokedAt, lastUsedAt)`**

The `"all_current"` value means the grant covers the user's current projects and is evaluated at call time. The `modules[]` field is an optional module restriction, for example a dot that may only use Support.

**Effective permission for a tool call** is the intersection of four sets:

- **the tool's** permission key;
- **the user's current role** in that project, including module roles (WP4.5);
- **the grant's** scopes, projects and modules;
- **module activation**.

The intersection never widens what the user could do in the UI.

### 4.3 Organization and project selection in calls

- **Tool `orbit_projects`** (R0) lists the granted organizations and projects with their enabled modules.
- **Every project-bound tool takes a `projectId` argument**, added by the adapter to every module tool's input schema, with an optional default when the grant contains exactly one project.
- The cross-call state needed by the stateless 2026-07-28 protocol is carried as **explicit handles in tool arguments**, as the specification recommends. There is no server session.

## 5. Tool, resource and prompt exposure

### 5.1 Registry adapter

- **Opt-in per tool.** `OrbitTool` gains `exposure: { assistant: boolean; mcp: boolean }` (`03` §6.1), default `mcp: false`. Chat-only tools are not exposed, for example tools that return chat cards or depend on a conversation.
- **Names.** MCP tool names are the registry names with a module prefix, `<module>_<verb>` (for example `marketing_recent_content`), because some clients restrict dots. Descriptions come from the registry.
- **Annotations:**

  | Registry risk | MCP annotations |
  |---|---|
  | `R0_read` | `readOnlyHint: true` |
  | `P_proposal` | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true` (same arguments, same pending ActionRequest) |
  | `W0_internal` | `readOnlyHint: false`, `destructiveHint: false` |

  `openWorldHint` is set for tools that call external providers (for example Postiz analytics). `securitySchemes: [{type:"oauth2", scopes:[…]}]` is set per tool.
- **Schemas.** `inputSchema` is generated from zod, the same as `responsesTool`. **`outputSchema` is required for every MCP-exposed tool.** Output is validated and size-capped (ADR 0007 §2, already planned in WP1.6).
- **Results.** `structuredContent` is the tool output. `content` holds a JSON text copy for compatibility. Chat `cards` are converted to links into Orbit (`https://orbit.eds-labs.io/p/<projectId>/…`) and are never rendered as UI.
- **Dynamic registration.** `tools/list` is computed from:

  ```
  registry ∩ exposure.mcp ∩ enabled modules of granted projects ∩ permissions ∩ granted scopes
  ```

  The order is deterministic, as the 2026-07-28 spec recommends for client caching. The result is cacheable (`ttlMs`, `cacheScope: "private"`). A change in module activation, roles or grants emits `toolsListChanged` on the optional subscription stream (§6.5). Otherwise the next list reflects it.
- **Tool search.** Many clients load all tools. If the exposed set grows large, a `orbit_find_tools` tool uses the existing `searchTools` scorer (`registry.ts:177-193`). [Open] The native tool search in MCP clients evolves independently.

> **Note 2026-10-18 (WP-M2, D-M2-4).** Gateway-native tools that need no project `Scope` live in `apps/api/src/platform/mcp/native-tools.ts`. WP-M2 ships `orbit_projects` only; `orbit_profile`, `search` and `fetch` follow in WP-M3. Module tools reach MCP only through the adapter (`exposure.mcp` plus an `outputSchema`); WP-M2 exposes none. A tool outside the principal's scopes is not listed and is "not found" on call (no 403 step-up challenge, stricter than §6.4).

### 5.2 Initial MCP surface

Only read and proposal tools are exposed at first.

| Tool | Source | Notes |
|---|---|---|
| `search` | knowledge services `retrieve` / `retrieveHybrid` with **`forModel: true`** across granted projects or the given project | Required by ChatGPT deep research. Returns `id`, `title`, `url` (an Orbit deep link or the source's canonical URL) and a snippet. Paid query embedding goes under the spend mandate (`mcp:` key). If the budget is unavailable, it falls back to lexical search and reports `mode`. |
| `fetch` | Document version, fact, ticket (later) or project status by ID | Required by ChatGPT. Returns full text within limits, `url` and metadata. |
| `orbit_profile` | user | Returns a stable opaque ID (`_meta["openai/profile"]: true`). Never an e-mail. |
| `orbit_projects` | tenancy | Granted organizations, projects and modules. |
| `orbit_project_status` | `project_status` tool (platform sections) | |
| `knowledge_search` | existing tool | Facts plus passages with evidence IDs. |
| `marketing_recent_content`, `marketing_assignment_list`, `marketing_run_status`, `marketing_package_status`, … | existing R0 tools | Exposed after review per tool. |
| `marketing_propose_campaign`, `marketing_request_content_package`, `marketing_propose_schedule`, `marketing_assignment_propose` | existing P tools | They create ActionRequests or proposals and return the pending state plus an Orbit link. |
| `orbit_action_status` | ActionRequests | The client can poll a proposal's decision and outcome. |
| `support_*` | Support module (Phase 5), automatically through the registry | For example ticket search, ticket insights and draft reply. |

> **Note 2026-10-18 (WP-M3, D-M3-5, D-M3-6, D-M3-7).** `search` covers at most 5 of the principal's projects per call (projects with a visible knowledge module and a readable role, ordered by name then id), or only the optional `projectId` argument; results are interleaved round-robin and capped at 30. The output is the strict OpenAI shape `{ results: [{ id, title, url }] }`, so no snippet and no `mode` are returned (this amends the table above). Ids are self-describing, `p:<projectId>:chunk:<chunkId>` and `p:<projectId>:fact:<factId>`, and `fetch` re-authorizes the project named in the id on every call; anything it cannot resolve answers the same `NOT_FOUND`. `url` is the source's canonical URL (query string and fragment stripped), otherwise the Orbit deep link `<APP_ORIGIN>/p/<projectId>/knowledge/library` (passages) or `/knowledge/facts` (facts); it is never empty, which ChatGPT needs for citations. `fetch` returns the active version text up to 48 KB (`metadata.truncated`). Only `marketing_project_status` and `support_insights` are exposed from the registry so far, so `orbit_project_status` is the registry tool `marketing_project_status`. See `docs/IMPLEMENTATION_STATUS.md` ("Track M WP-M3").

### 5.3 Resources and prompts

- **Resources** (read-only, cacheable):
  - `orbit://projects/{projectId}` (project summary);
  - `orbit://projects/{projectId}/knowledge/documents/{documentId}`;
  - `orbit://projects/{projectId}/knowledge/facts/{factId}`;
  - `orbit://projects/{projectId}/marketing/profile`;
  - later `orbit://projects/{projectId}/support/tickets/{ticketId}`.

  Modules contribute resource templates through their manifest (`03` §5.2). The same permission and `modelUse` rules apply. **[Open]** ChatGPT's resource support is not documented beyond UI resources, so everything important is also reachable through tools (`fetch`).
- **Prompts:** optional, module-contributed templates such as "weekly marketing review" or "summarize open tickets". Low priority.
- **MCP Apps / UI resources:** not in scope. Orbit links to its own UI instead. This can be revisited for rich cards later.

> **Note 2026-10-18 (WP-M3, D-M3-1).** MCP resources (`orbit://…`) are deferred: ChatGPT's resource support is undocumented, the WP-M3 acceptance needs only `search` and `fetch`, and everything important is reachable through `fetch`. No resource templates are registered.

### 5.4 Data protection in MCP results

Everything returned over MCP leaves Orbit and goes to an external model. Rules:

- Knowledge content is returned **only from sources with `modelUse = true`**, the same as `forModel` retrieval. Verified facts need `modelUse` as well.
- Credentials, encrypted fields, internal audit data and other users' chats are **never** exposed. `publicEntity` projections are the floor.
- **Support customer PII** is exposed only after decision Q-12, and only to grants that explicitly include the support module.
- Tool inputs from clients are **untrusted data**: the existing Orbit rule, for example against prompt injection carried through arguments.

## 6. Writes, confirmation and events

### 6.1 Action classes over MCP

| Risk (ADR 0008) | Exposed via MCP | Behaviour |
|---|---|---|
| R0 read | yes (`orbit:read`) | Executes directly. |
| W0 internal write | selected tools only (`orbit:write`) | Executes directly within permissions, for example a support internal note. |
| P proposal | yes (`orbit:propose`) | Creates an ActionRequest or proposal and returns `{status:"pending_approval", actionRequestId, approveUrl}`. |
| C1/C2 paid, W1/W2 external writes | **only as P** | The deterministic executor runs after an **Orbit-side decision**. |
| D1/D2 deletion, F1/F2 budget, G governance, infrastructure | **never** | Hard floors (ADR 0008 §4). They stay `ui_only` or `forbidden`. |

### 6.2 Confirmation and step-up

**[Proposal] (AD-22)** The MCP client's own confirmation, such as ChatGPT's write-action prompt, is treated as a **UX hint only, never as authorization**. Authorization comes from the ActionRequest decision in Orbit by a user holding the decider permission. Three channels are possible:

1. **Orbit approval inbox:** web, or the existing Telegram owner bot for kinds it supports.
2. **URL-mode elicitation:** the 2026-07-28 MRTR `input_required` interaction, or 2025-11-25 `elicitation/create` with a URL. The tool can return an interaction pointing to `https://orbit.eds-labs.io/approve/<id>`. After the user decides in Orbit, the client retries and gets the result. **[Open]** Elicitation support in ChatGPT and dots is not documented. The fallback is the `approveUrl` plus `orbit_action_status`.
3. **Step-up re-authentication** for `approval_required_reauth` actions. The Orbit approval page asks for the password again or a second factor; there is no 2FA today. It never happens inside the MCP client.

**Agent-initiated stricter default:** requests coming from MCP are marked `requestedBy: {kind:"mcp", clientId, grantId}`. Where the mode is configurable, they default one step stricter than UI-initiated requests (ADR 0008 §4). A **per-grant kill switch** and **per-grant daily proposal quotas** limit always-on agents such as dots.

### 6.3 Budget

MCP tools that trigger paid Orbit work (query embeddings, package generation after approval) reserve under the project's spend mandate. They use category `mcp` or the tool's `costCategory`, and run key `mcp:<grantId>:<date>`, with an optional per-grant daily ceiling. The external client's own model cost is not Orbit's.

> **Note 2026-10-18 (WP-M3, D-M3-2 and D-M3-3).** The run key is per call, not the daily `mcp:<grantId>:<date>`: a daily run would accumulate against `perRunBudgetMicros` and fail with `RUN_BUDGET_EXCEEDED`. A search reserves under `budgetRunKey = mcp:<grantId>:<requestId>:<callId>` and `retrievalJobKey = <budgetRunKey>:<projectId>`, category `query_embedding`, and the reservation is attributed to the call's `mcp` AgentRun (single-project search) or to a `retrieval` run for that project (multi-project search); the project's daily and monthly caps still apply. Lexical fallback happens only before any spend and never once a reservation exists; the client is not told which mode ran.

### 6.4 Errors

| Situation | Response |
|---|---|
| Missing or invalid or expired token, wrong `aud` | HTTP 401 with `WWW-Authenticate` (PRM URL, `error`, `error_description`); for tool results also `isError` plus `_meta["mcp/www_authenticate"]` |
| Insufficient scope | 403 `insufficient_scope` with the required scope; tool result `isError` |
| `DomainError` (for example `FORBIDDEN`, `MODULE_DISABLED`, `PAID_MANDATE_EXPIRED`, `VERSION_CONFLICT`) | Tool result `isError: true`, `structuredContent: {code, message, retryable}`. Same codes as the REST API (AD-14). |
| Validation | JSON-RPC invalid params, with the zod paths (no values) |
| Rate limit | HTTP 429 with `Retry-After`; tool result `isError` with code `RATE_LIMITED` |
| Unsupported protocol version | `UnsupportedProtocolVersionError` (2026-07-28) or a negotiated fallback |
| Internal | Generic `REQUEST_FAILED` with a request ID. Logs carry the code only, as today (`server.ts:372-405`). |

### 6.5 Optional MCP event system

- **Mechanism:** the 2026-07-28 `subscriptions/listen` stream for `toolsListChanged`, `resourcesListChanged` and resource subscriptions, for example "ticket X changed" or "ActionRequest decided". Events come from the platform's durable events and outbox (`03` §7.1), fanned out through the Redis pub/sub of WP4.3. They are filtered by grant and permissions.
- **Client support:** **[Open]** Not documented for ChatGPT or dots. Many clients poll. The feature is therefore **optional and last**. Orbit's own notification channels (in-app, e-mail, Telegram) remain the primary way to inform users.
- **No server-initiated sampling.** It is deprecated, and Orbit runs its own model calls.

## 7. Rate limits, audit, observability

- **Rate limits** at the gateway, keyed by `grantId` and `userId` and `clientId`, with separate buckets for:
  - reads (for example 120/min);
  - searches with paid embedding (for example 30/min);
  - proposals (for example 20/hour and a daily quota per grant).

  Plus global concurrency per project, to protect the advisory lock (R-10). These numbers are configurable.
  - Authorization server: per-IP limits on `/authorize` and `/token`, with Traefik passing the real client IP (this needs the F-02 fix pattern).
  - DCR registration is limited separately.
- **Audit:**
  - Every `tools/call` and `resources/read` writes an `AuditEvent` in the project scope with action `mcp.tool_call`, tool, client ID, grant ID, outcome code, duration and argument **hash** (no argument values, no results).
  - Calls without a project (`orbit_projects`, `search` across projects) go to a small auth-schema table `McpCallLog`.
  - Grant creation, consent, revocation, token reuse detection and client registration are audited too.
- **Telemetry:**
  - Paid work creates `AgentRun` entries of kind `mcp` with spans, so the AI cost views show MCP spend per client.
  - The health endpoint `/healthz` on the gateway is polled by Uptime Kuma.
  - Error-rate and 401/429 counters go to logs (pino, as in the API).
- **Abuse response:** a grant or client can be disabled centrally (owner UI: **Organization → Connected apps**), with immediate effect.

> **Note 2026-10-18 (WP-M2, D-M2-3).** Calls without a project are logged to `McpGrantEvent` with action `mcp.call` (tool, outcome, duration, argument hash) instead of a new `McpCallLog` table, so WP-M2 needs no new table. Calls with a project write `AuditEvent` `mcp.tool_call`, as above, and an `AgentRun` of kind `mcp` (the migration `202610180010_mcp_run_kind` widens the kind check). Rate limits are in process (D-M2-5): per grant 120, per user 240 and per client 600 requests a minute, 30 a minute per IP without a valid token; every authenticated request counts and every refusal is a 429 before the SDK. The separate read, search and proposal buckets above come with the tools that need them (WP-M3).

> **Note 2026-10-18 (WP-M3).** The gateway refuses every JSON-RPC batch (an array body) with HTTP 400 and error -32600 `Batch requests are not supported`, after token verification and the limits and before principal resolution and the SDK. Batching was removed from MCP in revision 2025-06-18, and refusing it keeps one `tools/call` per request, so every call is limited, audited and keyed on its own. `search` has its own bucket of 30 calls a minute per grant, and every tool call has a 25 s timeout (`TIMEOUT`).

## 8. Compatibility with existing APIs and agent tools

- **No new business endpoints.** The gateway calls the same registry tools and platform services as the Orbit Assistant. REST routes are unchanged (AD-14).
- **The tool is the contract.** Adding a tool to a module manifest makes it available to the Assistant and, if `exposure.mcp`, to MCP clients, with the same permission, validation, audit and budget behaviour. Tests run against the registry once and against both adapters.
- **Tool context:** `ToolContext.channel` gains `{kind:"mcp", clientId, grantId, requestId}` (`03` §6.1). Tools that need a conversation are not exposed.
- **OAuth tokens and the REST API (later).** The same authorization server can later issue tokens for the external REST API (Support E6), which replaces the need for a separate API-token mechanism. This is optional.

## 9. Security review checklist (input for WP-M5)

- Token audience binding (`aud` = MCP resource only). Tokens for the MCP resource are **not** accepted by the REST API, and vice versa.
- PKCE required. Exact redirect URI match from CIMD. `iss` in every authorization response. Consent cannot be skipped for new clients.
- CIMD fetch uses an SSRF-safe client (HTTPS only, private IP ranges blocked, size and time limits, caching).
- Refresh token rotation with reuse detection. Grant revocation is immediate.
- Membership and module activation are re-checked on every call. The intersection never exceeds UI rights.
- Results respect `modelUse` and never contain secrets. Customer PII is gated (Q-12).
- Hard floors are not exposed. Writes only through ActionRequests.
- Rate limits, quotas and kill switch.
- Dependency pinning past known advisories.
- An MCP conformance test (MCP Inspector or SDK tests) and a ChatGPT developer-mode end-to-end test.

## 10. Roadmap integration

New work packages (details in `07-roadmap.md`):

| WP | Title | Effort (PT) | Depends on |
|---|---|---|---|
| WP-M1 | OAuth authorization server, consent and grant UI, Connected apps | 5–7 | WP1.5, F-02 fix, AD-21 approval |
| WP-M2 | MCP gateway core: service, transport, both protocol revisions, token verification, grant to scope, registry adapter, errors, audit, rate limits, Traefik route | 5–7 | WP-M1, WP1.6, WP2.4 |
| WP-M3 | Read surface: `search`/`fetch`, profile, projects, status, knowledge resources, the reviewed marketing read tools | 3–5 | WP-M2, WP3.2 |
| WP-M4 | Proposal and write surface: P tools, `orbit_action_status`, approval links and URL elicitation, step-up exclusions, quotas, budget attribution | 3–5 | WP-M3 |
| WP-M5 | Client compatibility, security review and rollout: ChatGPT developer mode, plugin packaging check for dots, a second client, conformance tests, production activation | 3–5 | WP-M4 |
| WP-M6 | Optional events: `subscriptions/listen`, list-change and resource notifications | 2–4 | WP-M2, WP4.3 |

**Total ≈ 21–33 PT.**

**Placement in the roadmap:**
- After Phase 3. It needs the permission catalogue, open registries, module activation and knowledge services.
- **Before or in parallel with Phase 5 (Support).** Support tools then appear in MCP without extra work.
- A minimal read-only gateway (WP-M1 to WP-M3) could ship right after Phase 3 as the first external integration.

## 11. Open points

| ID | Question |
|---|---|
| Q-18 | ~~Lift the ADR 0007 MCP non-goal?~~ **Resolved by Mario's addendum, 2026-10-13:** a central MCP gateway is wanted. ADR 0007 gets an addendum in WP0.1. |
| Q-21 | Is ChatGPT dots support with a custom MCP server or a privately published plugin available on Mario's plan? Verify in WP-M5. Recommendation: build to the standards; do not rely on dots specifics. |
| Q-22 | ~~Placement?~~ **Decided by Mario, 2026-10-13:** own `mcp` service under the path `https://orbit.eds-labs.io/mcp`, without a subdomain. |
| Q-23 | Which ChatGPT plan or workspace will connect? Pro may be limited to read and fetch through custom MCP, which is enough for the read surface (WP-M3). Proposals need full MCP. |
| Q-24 | Should `orbit:write` (W0) be offered at all in the first release, or only read and propose? Recommendation: read and propose first. |
| Q-25 | Should ChatGPT's mTLS client certificate be verified at Traefik as an extra signal? This depends on Traefik and Coolify support for optional client certificates. |

## Sources (external, accessed 2026-10-13)

- MCP specification 2026-07-28, changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- MCP authorization, 2026-07-28: https://modelcontextprotocol.net/specification/2026-07-28/basic/authorization.md
- OpenAI, Building MCP servers for plugins and API integrations: https://developers.openai.com/api/docs/mcp
- OpenAI, Plugins authentication: https://developers.openai.com/plugins/build/auth
- OpenAI Help, Developer mode and MCP apps in ChatGPT: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- Engadget, Dots are OpenAI's new personal agents: https://www.engadget.com/2272230/dots-are-openais-new-personal-agents-and-soon-youll-be-able-to-control-several-of-them/
- Stacktree, What are ChatGPT Dots: https://stacktr.ee/blog/what-are-chatgpt-dots
- Better Auth MCP plugin docs: https://better-auth.com/docs/plugins/mcp
- Better Auth 1.7.0 release notes: https://newreleases.io/project/npm/better-auth/release/1.7.0
- Advisories for `@better-auth/oauth-provider`: https://advisories.gitlab.com/pkg/npm/@better-auth/oauth-provider/

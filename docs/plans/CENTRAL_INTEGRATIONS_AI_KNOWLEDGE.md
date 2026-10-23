# Phase 3: central connections, AI infrastructure and organization knowledge

Status: architecture planned 2026-10-23, not implemented. Decisions: [ADR 0014](../adr/0014-central-connections-ai-knowledge.md), with E1–E4 decided by Mario on 2026-10-23. This plan is phase 3 of the [global administration plan](GLOBAL_ADMINISTRATION.md). The new overall order is:

1. global admin foundation;
2. users and permissions;
3. **central connections and AI infrastructure (this plan)**;
4. project archiving and deletion;
5. extended global settings.

No production connection, key or permission is changed by this plan or by implementing it. Moving or adopting existing credentials is an explicit, approved migration step for each provider.

## 1. Inventory and classification

| Connection | Stored today | Today's scope | Target scope | Notes |
|---|---|---|---|---|
| OpenAI / Anthropic (text, image, embedding) | `openai_configuration` entity + env fallback | project + env | **system or organization** connection `ai_provider`, project override stays | the only existing "default + override" pattern |
| Postiz | `connectors` (`postiz`) | project | **organization** (one Postiz org, channels per project) | lookup copied in ~15 files; channel selection stays project data |
| Matomo | `connectors` (`matomo`) | project | **organization** connection, `siteId` per project grant | |
| Slack | `connectors` (`slack`) | project | **organization** app connection; the channel mandate stays per project | the mandate holds actors and expiry, so it stays a project record |
| Telegram owner bot | `telegram_connections` | project + user | **user** binding on a project connection | linking a chat is personal; the bot token may become an organization connection later |
| Google Drive | env OAuth app + `drive_connection` per project | system app + project token | app **system** (env); account **organization** connection, folder per project | |
| GitHub (knowledge) | `knowledge_github_config` (App) + `knowledge_github_connections` | project | App **system or organization**; installation per organization; repository per project | |
| Mailboxes (SMTP/IMAP) | `connectors` (`email`) | project | **project** (address-specific), optionally organization | `SupportInbox.emailConnectionId` FK must keep working |
| Customer context (n8n gateway) | `connectors` (`customer_context`) | project | **organization** connection of kind `n8n`/`customer_context`, granted to projects; inbox binding unchanged | one gateway serves many projects |
| n8n management | none | – | **system or organization** `n8n` | new |
| External MCP servers (Orbit as client) | none | – | **organization** `mcp_server` (designed, not built, E4) | |
| Orbit MCP server (OAuth clients, grants) | `oauthClient`, `McpGrant` … | user grants per organization | stays; central administration view | not a `Connection` |
| Public client keys | `PublicClientKey` | project + module | stays project | no secret |
| System SMTP, files S3, backup, DB, Redis, secrets | env | system | stays **env**, status only | never editable in the UI |

**User scope:** a personal binding to a connection, such as a Telegram chat link, or later a personal OAuth account. It is a grant with `userId` and is never a credential another user can use.

## 2. Data model (control plane; migration `2026xxxx_connections`)

```prisma
model Connection {
  id          String   @id @default(uuid()) @db.Uuid
  kind        String   // provider id from the registry: ai_provider, postiz, n8n, mcp_server, …
  provider    String   // openai | anthropic | postiz | … (registry-validated)
  scope       String   // system | workspace | project   (CHECK)
  workspaceId String?  @db.Uuid   // set for workspace and project scope
  projectId   String?  @db.Uuid   // set for project scope (composite FK to Project)
  label       String
  config      Json     // non-secret: base URL, account id, siteId defaults, purposes offered
  status      String   // configured | read_verified | write_verified | failed | disabled | revoked
  health      Json     // last check: at, code, latencyMs, never a message from the provider
  version     Int      @default(1)
  createdBy   String
  disabledAt  DateTime? @db.Timestamptz(3)
  revokedAt   DateTime? @db.Timestamptz(3)
  legacyRef   Json?    // { projectId, entityKind, entityId } when adopted from a project
  createdAt   DateTime @default(now()) @db.Timestamptz(3)
}

model ConnectionSecret {               // rotation without downtime
  id           String   @id @default(uuid()) @db.Uuid
  connectionId String   @db.Uuid
  version      Int
  keyId        String   // CREDENTIAL_KEYS key id (master-key rotation)
  ciphertext   String   // AES-256-GCM as today (shared.ts encrypt)
  state        String   // pending | active | retired   (one active per connection)
  createdBy    String
  createdAt    DateTime @default(now()) @db.Timestamptz(3)
  retiredAt    DateTime? @db.Timestamptz(3)
}

model ConnectionGrant {
  id            String   @id @default(uuid()) @db.Uuid
  connectionId  String   @db.Uuid
  workspaceId   String   @db.Uuid          // consumer organization
  projectId     String?  @db.Uuid          // null = organization grant (parent), set = project grant (usable)
  userId        String?                    // personal binding (user scope)
  parentGrantId String?  @db.Uuid          // project grant under an organization grant
  purposes      String[]                   // text | image | embedding | publish | read | deliver | lookup | …
  modules       String[]                   // empty = every module allowed by the purpose
  settings      Json                       // per-grant non-secret settings (siteId, channel ids, model allowlist)
  monthlyBudgetMicros BigInt?              // required on organization grants of system AI connections (E2)
  createdBy     String
  createdAt     DateTime @default(now()) @db.Timestamptz(3)
  lastUsedAt    DateTime? @db.Timestamptz(3)   // updated at most hourly per grant
  revokedAt     DateTime? @db.Timestamptz(3)
  revokedBy     String?
}

model SpendCounter {                    // cross-project totals without cross-project reads
  grantId      String   @db.Uuid          // organization grant, project grant or connection-level row
  connectionId String   @db.Uuid
  workspaceId  String?  @db.Uuid
  periodStart  DateTime @db.Timestamptz(3)
  reservedMicros BigInt @default(0)
  settledMicros  BigInt @default(0)
  @@id([grantId, periodStart])
}

model AiProfile {                       // models, rate cards, routes; layered
  id          String @id @default(uuid()) @db.Uuid
  scope       String // system | workspace (project override stays openai_configuration)
  workspaceId String? @db.Uuid
  version     Int
  data        Json   // verifiedModels, models, rateCard, modelRoutes, taskRoutes, anthropicTierRoutes,
                     // defaultProvider, fallback, embeddingProfiles; schema = packages/ai schemas
  updatedBy   String
  updatedAt   DateTime
}

model KnowledgeShare {                  // organization knowledge (E1)
  id               String @id @default(uuid()) @db.Uuid
  workspaceId      String @db.Uuid
  libraryProjectId String @db.Uuid        // a project with Project.kind = 'library'
  consumerProjectId String @db.Uuid
  sourceIds        String[]               // empty = all sources of the library
  modules          String[]               // consumer modules (audience); empty = all
  generation       Int    @default(1)     // bumped on narrow/revoke/library change
  createdBy        String
  createdAt        DateTime @default(now()) @db.Timestamptz(3)
  revokedAt        DateTime? @db.Timestamptz(3)
}

model WorkflowBinding {                 // n8n (and later other automation layers)
  id           String @id @default(uuid()) @db.Uuid
  connectionId String @db.Uuid           // n8n connection
  contract     String                    // customer_context.v1 | automation.v1
  workflowRef  String                    // n8n workflow id or webhook path, opaque to Orbit
  label        String
  createdAt    DateTime @default(now()) @db.Timestamptz(3)
}
```

**Project additions:** `Project.kind` (`project` | `library`, default `project`). `BudgetReservation` gains `connectionId` and `grantId` (nullable, for attribution). `AgentRun` gains `routeVersionKey` (string; the existing integer stays for legacy rows).

**Workflow runs:** `WorkflowRun` is a project entity kind (business data under row-level security): status, contract, n8n execution id, error code and timestamps, never a payload.

**Grants and row-level security:**
- `orbit_auth`: CRUD on `Connection`, `ConnectionSecret`, `ConnectionGrant`, `AiProfile`, `KnowledgeShare` and `WorkflowBinding`.
- `orbit_app`, SELECT only:
  - **`Connection`**, policy `connection_use`: `disabledAt IS NULL AND revokedAt IS NULL AND EXISTS (active ConnectionGrant g WHERE g.connectionId = id AND g.workspaceId = app.workspace_id AND g.projectId = app.project_id AND g.revokedAt IS NULL)`.
  - **`ConnectionSecret`**: the same check through its connection, `state = 'active'` only.
  - **`ConnectionGrant`**: rows of the current project.
  - **`AiProfile`**: system rows, plus organization rows of `app.workspace_id`.
  - **`KnowledgeShare`**: rows whose `consumerProjectId` equals `app.project_id`, so the consumer can find its shares. Rows whose `libraryProjectId` equals `app.project_id` are visible too, for invalidation fan-out.
  - **`WorkflowBinding`**: via an active grant on its connection.
- `orbit_app` on `SpendCounter`: SELECT/UPDATE/INSERT on rows whose grant is a grant of `app.workspace_id` (project and organization grants), plus the connection-level row for a connection with an active project grant. Only amounts are visible.
- All policies use FORCE row-level security. Every new table is classified in the RLS matrix.

## 3. Resolution and use

- `resolveConnection(tx, scope, { provider, purpose, module })` (platform):
  - returns the connection, the grant and a lazily decrypted secret, inside the project transaction;
  - fails with `CONNECTION_NOT_GRANTED` (404 to callers) when no grant exists;
  - prefers a project-owned grant, then an organization grant, then a system grant;
  - **dual read** during migration: the new tables first, then the legacy project entity while the provider's cutover flag is off.
- Every consumer switches to the resolver: the Postiz lookups, Matomo, Slack, Drive, GitHub, mailboxes, customer context, AI runtime and embeddings. The scattered `list(tx,scope,"connectors").find(...)` lookups disappear.
- **Health checks** run in the API under the administration (control plane). Results are written to `Connection.health/status` through `orbit_auth`; provider error text is never stored.
- **Rotation:**
  1. Add a pending secret.
  2. Run a check with it.
  3. Activate it; the old secret is retired in the same transaction.
  4. Users read the active secret per transaction, so the rotation needs no restart.
  - Master-key rotation goes through `CREDENTIAL_KEYS` (`id:hex` list); `keyId` selects the key, and a re-encryption job moves secrets to the newest key.
- **Revocation and disable** take effect on the next transaction: row-level security hides the row. Running jobs fail closed through the existing dependency errors. Revoking an organization grant revokes its project grants in the same transaction.
- **Usage and dependencies:** `connectionUsage(connectionId)` lists grants, bound inboxes and workflows, and last use per project (from `ConnectionGrant.lastUsedAt`, updated sparsely). Removing a connection is refused while anything binds it, as `mailboxUse.inUse` does today.
- **Audit:** every create, update, rotate, grant, revoke, disable and health result is written to `SystemAuditEvent` (`targetType: "connection" | "grant"`) with ids and codes only. Project-side use stays in the project audit, where it is today.

## 4. AI infrastructure

- **Runtime config:** `runtimeAiConfiguration(tx, scope)` replaces `runtimeOpenAiConfiguration`. Precedence for each field:
  1. the project's `openai_configuration` (override, unchanged);
  2. the organization `AiProfile`;
  3. the system `AiProfile`;
  4. the environment (bootstrap only, as today).
- **Keys:** a key comes from the granted `ai_provider` connection for the purpose (`text`, `image` or `embedding`). A project key in `openai_configuration` stays valid as a project-owned connection until it is migrated.
- **Route version:** `routeVersionKey = hash(system profile v, org profile v, project config v, grant id)`. Any change stops in-flight runs before their next paid call, using the existing `GENERATION_DEPENDENCY_CHANGED` and `CHAT_ROUTE_CHANGED` paths.
- **Budgets:** `reserve` keeps its checks 1–6 unchanged. Afterwards, inside the same transaction, it:
  - locks the `SpendCounter` rows of the project grant, the organization grant and the connection (`SELECT … FOR UPDATE`, in that order);
  - refuses with `GRANT_BUDGET_EXCEEDED`, `ORGANIZATION_BUDGET_EXCEEDED` or `CONNECTION_BUDGET_EXCEEDED` (409);
  - adds the reserved amount.
- **Settlement and unknown outcomes:** `settle` moves the amount from reserved to settled. Unknown outcomes keep counting as reserved, as today. The fallback (`onProviderBudgetStop`) also applies to the new stops when the alternative provider has its own grant.
- **Rate cards and models:** the system profile holds verified prices with `verifiedAt` and sources (the dated Anthropic catalogue is offered there instead of per project). Organizations and projects may override only within the models the system or their own connection verifies.
- **Embeddings:** system embedding profiles mirror the database CHECK (`openai:text-embedding-3-small:1536:chunk-v1`, …). Index generations stay per project; the key comes from the `embedding` purpose grant. Adding a new profile is still a migration plus a baseline checkpoint.
- **Attribution:** usage reports by system, organization, project, grant, provider, model and task class, from `BudgetReservation` joined with grants. The administration sees totals per organization; the organization owner sees totals per project.

## 5. MCP

- **Orbit as a server** (existing): Administration → Integrations → MCP lists:
  - gateway flags and the resource (status only);
  - OAuth clients (`oauthClient`: name, origin, CIMD host, created, disabled);
  - grants of every organization as metadata (user, client, organization, projects, scopes, modules, last use).
- **Server actions:** disable or enable a client (`oauthClient.disabled` plus `revokeClientGrants`), and revoke a grant.
  - Organization owners keep their existing view in the organization settings.
  - Optional per-organization client allowlist (`WorkspaceSetting mcp.allowedClients`), checked at consent and in `resolvePrincipal`.
  - Every existing rule stays:
    - effective permission is the intersection of the grant, the current role and module activation;
    - a project outside the grant answers 404;
    - a client confirmation is never authorization;
    - proposals go through `ActionRequest`.
- **Orbit as a client** (E4, designed only):
  - connection kind `mcp_server` (endpoint; auth: OAuth client credentials or bearer; allowed tools; per-tool risk class);
  - granted to projects and modules;
  - executed only in the worker through the tool registry;
  - read-only tools by default; a write tool is a proposal with an `ActionRequest`;
  - output byte caps, a per-call budget run key and no access to Orbit credentials.
- **Built when a concrete need exists:** a separate WP with its own security review.

## 6. n8n

- **Connection kind `n8n`** (system or organization):
  - base URL;
  - management API key (secret, read executions only);
  - signing secret for callbacks and requests.
- **`WorkflowBinding`** names an n8n workflow for an Orbit contract:
  - **customer context:** v1, existing (ADR 0011);
  - **automation:** v1, new: a signed POST with an idempotency key and a bounded payload schema owned by the calling module.
- **Grants** decide which organization or project may trigger which binding. The existing `customer_context` project connections are adopted as grants of one organization connection (§8).
- **Trigger and status:**
  - Orbit triggers through `boundedFetch`: SSRF guard, HMAC as today, timeout, circuit breaker.
  - Callbacks come in through the signed webhook route (WP4.2a, `SignedWebhookProvider` `n8n`) into `WorkflowRun`.
  - The administration and the project show status and error codes; execution details are fetched on demand from the n8n API, without payloads.
- **Product logic** (FamilyPlan, uLiquid Desk mappings) stays in `integrations/n8n/`.
- **Code hygiene:**
  - the remaining uLiquid/Desk defaults in the core (`LEGACY_BRAND_TERMS`, the default banner style, the creative wordmark) move to profile data in a clean-up WP;
  - FamilyPlan placeholders in the web copy become neutral.

## 7. Knowledge and RAG (E1)

**Layers.**
- **A. Infrastructure (system):** embedding profiles, the provider grant for embeddings, index standards (evaluation thresholds, generation rules) and RAG configuration (topK, fusion and freshness defaults).
- **B. Organization knowledge:** a library project (`Project.kind = 'library'`, created by the organization owner) with normal sources, facts, documents, index and evaluation, plus `KnowledgeShare` rows to consumer projects.
- **C. Project knowledge:** unchanged and isolated by default.

**Retrieval for a consumer project.** `retrieve` and `retrieveHybrid` gain an `origins` step:
1. Read the consumer's active shares (row-level security on `KnowledgeShare`) filtered by the consumer module (audience).
2. For each share, open `scoped(library)` with the actor re-checked: the actor needs the share, not a membership in the library project.
3. Run the existing `retrieve` restricted to `share.sourceIds`, under the library's rights, freshness and index rules.
4. Fuse the results with the consumer's own via RRF and diversity.
5. Write the evidence in the consumer project. Each item carries `originProjectId`, `shareId` and `shareGeneration`.
- **Limits:** at most N shares per query, a per-share timeout, and budget reserved in the consumer project (the query embedding is computed per index profile).

**Validation.** `validateEvidence` validates each item in its origin scope:
- the share must still be active with the same generation;
- the library source's rights, generation, freshness and chunk must still hold.

A failure marks the evidence invalid, as today.

**Invalidation.**
- A library change (`revokeSource`, `setSourceRights`, `withdrawFact`, `revokeDocument`) or a narrowed or revoked share bumps the share generation.
- The change queues `knowledge_share_impact` jobs, one per consumer project. Each job runs `invalidate()` in the consumer scope with the existing impact handlers (marketing content to `needs_review`; support drafts revalidate).
- A purge propagates as a purge.

**Citations.** Source cards show the library name: "Organization knowledge · <library>". The `canonicalUrl` rules stay.

**What cannot bypass the boundaries.**
- **API and MCP:** they go through the same `retrieve`. MCP `search` and `fetch` resolve shares per project in the principal, and fetch validates a chunk through its share.
- **Background jobs:** they carry the consumer scope and re-check the share.
- **Row-level security** is untouched. A project without a share sees nothing, because the library rows are never visible in its scope.

**Index versioning.** The library has its own index generations and evaluation. A consumer fuses ranks, not scores, so profiles may differ; each profile costs one query embedding.

## 8. Migration of existing connections (separate WP; nothing automatic across organizations)

1. **Inventory (read-only script, `scripts/connections-inventory.ts`).** Per project, list provider, status, created, binding (inbox, workflow), the secret fingerprint (sha256 of the ciphertext, never the plaintext) and duplicates across projects of the same organization. The report goes to Mario. It has no write path.
2. **Adopt one-to-one (`ORBIT_CONNECTIONS_ADOPT`, per provider).** For each legacy project connection, create `Connection(scope project)`, a `ConnectionSecret` with the same ciphertext and key, and a project grant. `legacyRef` points to the old entity, which is kept and marked `adoptedTo`.
   - Idempotent.
   - Audited as `system:migration`.
3. **Dual read, then cutover per provider (`ORBIT_CONNECTIONS_<PROVIDER>=new`).** The resolver reads the new tables first. Old write paths are switched to the new tables. A rollback means setting the flag back, so the legacy entity is read again; the adopted rows stay.
4. **Consolidation (explicit, per organization).** An organization owner or administrator chooses "use one connection for these projects".
   - Orbit creates the organization connection from one chosen secret, grants it to the selected projects and retires the project copies only after a check passes.
   - Nothing is merged automatically; never across organizations.
5. **AI.**
   - `openai_configuration` keys stay project overrides.
   - "Promote to organization connection" is an explicit owner action; the system key from the environment is adopted as a system connection only by Mario's decision, then granted to organizations with budgets.
6. **Removal of the legacy path.** Only after one release with the flag on and zero legacy reads (counted). The legacy entities are deleted with Mario's approval.

**Rollback at every stage:** flags back, legacy entities intact, the new tables additive.

## 9. API (all under `/api/admin/...`, `/api/organizations/:id/...` and `/api/projects/:id/...`; zod strict; audited)

- **Connections.**
  - `GET/POST /connections` (system: administrators; organization: owners): never returns secrets.
  - `PATCH /connections/:id` (label, config).
  - `POST …/:id/secret` (new pending secret), `POST …/:id/secret/activate`.
  - `POST …/:id/check`, `POST …/:id/disable`, `POST …/:id/enable`, `DELETE …/:id` (refused while used).
  - `GET …/:id/usage`.
- **Grants.**
  - `GET/POST /connections/:id/grants`: an administrator grants a system connection to an organization with a budget; an organization owner grants to projects.
  - `PATCH …/grants/:id` (purposes, modules, budget, settings), `DELETE …/grants/:id`.
- **Project view.** `GET /api/projects/:id/connections`: the granted connections for selection, name, provider and purposes only.
- **AI.**
  - `GET/PUT /api/admin/ai/profile`; `GET/PUT /api/organizations/:id/ai/profile`.
  - `GET /api/admin/ai/usage?period&workspaceId`; `GET /api/organizations/:id/ai/usage`.
- **MCP.** `GET /api/admin/mcp/clients`, `POST …/clients/:id/disable|enable`, `GET /api/admin/mcp/grants`, `DELETE …/grants/:id`.
- **n8n.** `GET/POST /api/(admin|organizations/:id)/workflows` (bindings), `GET /api/projects/:id/workflow-runs`.
- **Knowledge.**
  - `POST /api/organizations/:id/library` (creates the library project).
  - `GET/POST /api/organizations/:id/knowledge-shares`, `PATCH/DELETE …/:shareId`.
  - `GET /api/projects/:id/knowledge-shares` (consumer view).

## 10. UI (no duplicate configuration surfaces)

- **Administration → Integrations:**
  - **Overview:** all system connections with status and health, usage counts and a warning on any connection without a grant.
  - **AI providers:** accounts and keys (write-only), grants to organizations with budgets.
  - **MCP:** server and clients as in §5.
  - **n8n:** instances, bindings and recent runs.
  - **System e-mail:** status of the environment SMTP.
  - **Infrastructure:** database, Redis, files, backup; status only.
- **Administration → AI & knowledge:** models and routes (system profile), provider budgets and usage, embedding profiles, RAG defaults, and libraries with their shares (metadata).
- **Organization settings:** connections and grants to projects, AI keys and the organization profile, usage, library and shares.
- **Project settings:**
  - `Connectors` shows the granted connections to choose from (channels, siteId, inbox bindings stay project choices).
  - A project-owned connection is created only where the provider is project-scoped (mailbox).
  - AI settings show "inherited from organization/system" and offer overrides.
- **Shared components:** one `ConnectionList`/`ConnectionForm`/`GrantMatrix` set, contributed per provider through the existing web connector contributions (provider form fields), used at all three levels.

## 11. Work packages (dependencies in brackets)

| WP | Content | Depends on |
|---|---|---|
| 3.0 | Phase-1 hooks (§13), ADR 0014 accepted, provider registry contract in `packages/module-contracts` (`ConnectionProviderDef`: scopes, purposes, secret schema, settings schema, check) | phase 2 |
| 3.1 | Tables, row-level security, grants, resolver with dual read, audit, secret rotation and key ring; RLS and access matrices | 3.0 |
| 3.2 | Admin and organization connection APIs and UI (generic list/form/grants/usage) | 3.1 |
| 3.3 | AI: `AiProfile`, `runtimeAiConfiguration`, spend counters, budgets per grant, attribution, route version key; usage UI | 3.1 |
| 3.4 | Provider cutovers one by one: Postiz (+ resolver at all ~15 call sites), Matomo, customer context/n8n, GitHub, Drive, Slack, mailboxes, AI keys | 3.1, 3.2 |
| 3.5 | Migration tooling: inventory, adopt, consolidate, rollback runbook | 3.1 |
| 3.6 | MCP administration (clients, disable, all grants, revoke; optional org allowlist) | 3.2 |
| 3.7 | n8n: connection kind, `WorkflowBinding`, automation contract v1, signed callbacks, `WorkflowRun`, UI | 3.2 |
| 3.8 | Library projects and `KnowledgeShare`; retrieval origins, validation, invalidation fan-out, MCP search and fetch, UI | 3.0 (independent of 3.1) |
| 3.9 | Core clean-up of product-specific defaults (uLiquid/Desk/FamilyPlan) into profile data | – |
| 3.10 | External MCP servers as a client (only on demand, own review) | 3.1, 3.7 |

## 12. Tests and acceptance

- **RLS matrix:**
  - new tables classified;
  - `orbit_app` sees a connection or secret only with an active project grant;
  - a revoked grant or disabled connection becomes invisible in the next transaction;
  - `SpendCounter` limited to its own organization;
  - `KnowledgeShare` visible only to the consumer and the library.
- **Access matrix:** new routes; system administrators never see secrets; organization owners only their organization's connections and grants; project members only the granted list.
- **Negative cross-tenant tests:**
  - a project of organization B cannot resolve a connection of A, through the API, worker jobs, MCP or webhooks;
  - an organization owner cannot grant a system connection;
  - an administrator cannot grant an organization's connection to another organization;
  - a forged `connectionId` in an action answers 404.
- **Budgets:** concurrent reservations from two projects of one organization cannot exceed the organization budget (locking test); unknown outcomes keep counting; existing provider-budget, fallback and rate-card tests stay green; the route version key change stops in-flight runs.
- **Migration:**
  - adopt is idempotent and keeps behaviour identical (same secret, same checks);
  - flag back restores legacy reads;
  - the inventory never prints secrets;
  - consolidation refuses across organizations.
- **Knowledge:**
  - no share → no library results;
  - share limited to sources and modules;
  - revoke or narrow → consumer evidence invalidated and marketing content set to `needs_review`;
  - library source revoke → purge propagates;
  - MCP search and fetch respect shares;
  - citations show the origin;
  - the library index evaluation stays separate.
- **n8n:** a wrong signature or replay is rejected; a binding can be used only by granted projects; run status shows without payloads.
- **Acceptance (phase 3):**
  - one Postiz, n8n and OpenAI connection serves several projects of one organization through explicit grants;
  - no project sees an ungranted connection;
  - organization and project budgets hold under concurrency;
  - the administration shows connections, health, usage and audit without secrets;
  - legacy connections keep working until their cutover, and rolling back a flag restores them;
  - shared knowledge works only through shares, with origin evidence and invalidation.

## 13. What phase 1 and 2 already provide or must keep open

- **Already compatible:**
  - control-plane-only administration services (`authDb`), the metadata-only boundary test, `SystemAuditEvent` with string `targetType`;
  - the `Actor` model (admin, org_owner, project_owner);
  - organization settings and the admin navigation as the place for new sections;
  - module roles in grants.
- **Small hooks for WP3.0, before the release of phases 1–2 if convenient:**
  - extend the `SystemAuditInput.targetType` union (`connection`, `grant`, `knowledge_share`);
  - reserve the admin sections `integrations` and `ai`;
  - document that `orbit_auth` gets no grant on project business tables (the library is reached through shares, not admin reads);
  - keep the admin project list free of a module column (`ProjectModule` stays a business table).
- **Phases 4 and 5 shift by one:** project lifecycle is now phase 4. Global settings is phase 5; its AI and budget items move into this phase 3, and phase 5 keeps branding, locale, registration policy, session policy, maintenance and versions. Archiving a project must also revoke its connection grants and knowledge shares, and stop its workflow bindings.

## Implementation status (2026-10-23, core work packages, local; flags off)

Built on Mario's go-ahead ("Jetzt, Kern zuerst"): WP3.0, 3.1, 3.2 (generic list, form and grant UI), 3.3 and 3.8. Next: 3.4 provider cutovers, 3.5 migration tooling, 3.6 MCP administration, 3.7 n8n, 3.9 clean-up.

- **3.0/3.1:** migration `202610240002_central_connections` with `Connection`, `ConnectionSecret`, `ConnectionGrant`, `SpendCounter`, `AiProfile`, `KnowledgeShare`, `Project.kind`, reservation attribution columns and `AgentRun.routeVersionKey` (reserved; route versions stay integers, see below). Row-level security and grants as in §2. Resolver `platform/connections/central.ts`, key ring `platform/connections/secrets.ts` (`CREDENTIAL_KEYS`), management service `platform/administration/connections.ts`, provider metadata (`scopes`, `purposes`, `label`) on connection providers. OpenAI and Anthropic are registered as central providers. The legacy project `connector` action offers only project-scoped providers.
- **3.2:** routes `/api/admin/connections…`, `/api/organizations/:id/connections…`, `/api/projects/:id/connections`. UI: Administration → Integrations, organization settings → Connections, with one shared panel and grant dialog.
- **3.3:** `platform/ai/central-ai.ts`. Field precedence: project `openai_configuration`, then organization profile, then system profile, then environment. Keys: the project's own key first, then a granted connection, then the existing environment rule. The route version is a hash of the profile versions and granted keys; it stays an integer, so every existing comparison works unchanged. Grant, organization and connection budgets are enforced in `reserve` on locked counters and settled in `settle` and in the "settle unknown" action. UI: Administration → AI & knowledge and the organization AI profile.
- **3.8:** library projects (`Project.kind = 'library'`) and shares. Routes `/api/organizations/:id/knowledge-libraries|knowledge-shares…` and `/api/projects/:id/knowledge-shares`. `knowledgeSearch` adds shared results; `validateSearchResult` re-checks them, and Support drafts use it. UI: the shared knowledge panel in the organization settings.

**Deviations from the plan, by design for this first cut:**
- Embeddings use the text key, as they always have; a separate `embedding` purpose is not offered.
- Library search is lexical; hybrid search over a library would charge the library's own budget and needs a decision.
- Shared results serve the Support and assistant modules only, which validate knowledge when they use it. Marketing and the MCP search keep project knowledge until an invalidation fan-out into consumer projects exists (follow-up to 3.8).
- `ConnectionGrant.lastUsedAt` is not maintained yet: the business role cannot write grants, and sparse updates through the control plane come with 3.4.
- `AgentRun.routeVersionKey` is reserved but unused (see 3.3).

**Evidence:**
- `apps/api/tests/connections.integration.test.ts` (9 scenarios): secrets never returned; budget required for paid organization grants; foreign organizations refused; row-level security per project; the AI runtime uses the granted key; route version changes; concurrent organization budget; rotation only after the provider accepts; disable and revoke cascade; administrators cannot manage an organization's own connection.
- `apps/api/tests/knowledge-shares.integration.test.ts` (5 scenarios): isolation without a share, cross-organization and non-owner refusal, results with origin only for the consumer and module (not marketing, not MCP), invalidation on share change and on library source revocation, immediate end on revoke.
- RLS matrix (new table classes); access matrix (33 new routes, no existing cell changed); the provider/registry and AI regression suites; a browser check of the administration and organization pages.

## Implementation status, part 2 (2026-10-23, WP3.4–3.7, local; flags off)

Built on Mario's go-ahead ("continue with 3.4 … 3.7, everything behind flags, no push").

- **3.4 Provider cutovers:**
  - `connectionAccess(tx, scope, connection)` (`platform/connections/connections.ts`) gives a provider call its key and base URL. A project connection bound to a central one (`centralConnectionId`) reads the central secret in the project transaction, so it works only while the project holds a grant. One with its own key works as before.
  - Switched over: every Postiz site (publisher, reconcile, drafts, write verification, queue watch, channel sync, analytics tools), Matomo imports, customer context lookups (Support) and the generic health check.
  - New owner action `connector-attach` binds a granted connection; the project keeps channels, site and verification state on its own connection.
  - Per provider behind `ORBIT_CONNECTIONS_CUTOVER` (for example `postiz,matomo,customer_context`).
  - Postiz, Matomo and customer context may now be system or organization connections. UI: the "Granted connections" card in the project connectors page.
- **3.5 Migration tooling** (`platform/connections/migration.ts`, `scripts/connections-migrate.ts`):
  - a read-only inventory with keyed fingerprints (HMAC with the master key, no key printed) and shared-key candidates per organization;
  - `plan` and `apply --yes` consolidate projects with the same key into one organization connection, granted and bound per project, never across organizations;
  - `rollback --yes` unbinds every project that kept its own key, revokes the grants and disables the connection.
  - Projects keep their own keys, so a rollback is always possible.
- **3.6 MCP administration:** Administration → MCP shows:
  - the gateway's state;
  - the OAuth clients, with a disable action that sets `disabled` and revokes every grant with its stored tokens;
  - all active grants as metadata, with revocation (`revokeGrantByAdministration`).
- **3.7 n8n:**
  - **Connection and bindings:** provider `n8n` (system or organization), with the secret as JSON `{apiKey, signingSecret}`; the check reads one workflow page. `WorkflowBinding` (migration `202610240003_workflow_bindings`, row-level security through the connection's grant) binds a workflow path to `automation.v1` or `customer_context.v1`.
  - **Triggers:** an owner (or later a module) triggers a run with a signed request (HMAC with timestamp, request id, run id, callback URL), only from a project with an `automation` grant, and only in live mode with external writes; otherwise the run is a test receipt.
  - **Callbacks:** `POST /api/automation/callbacks/:projectId/:runId` checks the signature against the connection's current secret; a revoked grant fails closed, and replays change nothing.
  - **Data kept:** runs store status and codes only, never a payload; the execution status is read from n8n's API on demand.
  - UI: a workflows dialog on automation connections, and recent runs on the project connectors page.

**Not cut over, by decision or for later:**
- Mailboxes stay project connections, because they are tied to an address.
- Slack stays per project because of its channel mandate.
- GitHub and Google Drive use their own entity kinds and OAuth flows; they need their own cutover.
- The customer context support inbox binding is unchanged (it binds a project connection, which can now be a bound central one).

**Evidence:**
- `connection-cutover.integration.test.ts` (3): bind without a stored key, own keys unchanged, fail closed without cutover or after revocation;
- `connection-migration.integration.test.ts` (3): fingerprints without keys, same-key binding only within the organization, rollback;
- `mcp-admin.integration.test.ts` (3);
- `automation-workflows.integration.test.ts` (5): binding only for granted projects, test mode, signed neutral request without secrets or kept payload, signed single-use callbacks, revocation;
- access matrix: 17 new routes, no existing cell changed; the callback is public and signature-authenticated.

## Implementation status, part 3 (2026-10-23, Postiz channel assignment, local; flags off)

Mario decided on 2026-10-23:
- Postiz is connected once per organization (or as a system connection granted to it).
- Each channel goes to exactly one project.
- Organization owners and administrators manage the assignment.

What this part adds:
- **Channel catalog.** Providers with `channelAssignment` (Postiz) keep the channel list of the central check in `Connection.health.channels`: ids, names and identifiers only. A failed check keeps the last list.
- **Assignment API.** `GET`/`PUT /api/organizations/:id/connections/:connectionId/channels`, and `/api/admin/connections/:id/channels` with `workspaceId`.
  - The project grant carries `settings.channels`. A project left without channels loses its grant.
  - Exclusivity holds across organizations of a system connection, under a lock per connection.
  - A plain grant may not carry channels (`USE_CHANNEL_ASSIGNMENT`).
  - The cutover for the provider is required.
- **Order of a change.** The service first narrows the projects' bound connections, then changes the grants, then widens and binds. A failure never leaves a project with more channels than its grant.
  - A project whose module is off gets the grant, but its binding only follows with a later assignment.
  - This is a deliberate exception to "administration is metadata only": the service (in `platform/connections`, not `platform/administration`) writes the binding row (`centralConnectionId`, `allowedChannelIds`, channel names) into the project, without reading content.
- **Project side.**
  - `assignedPostizChannels` uses exactly `allowedChannelIds` for a bound connection, and none without that list. `assertAssignedSocialChannels` additionally requires the current grant.
  - The project health check keeps only the assigned channels.
  - The project UI shows the channels read-only; posting times and X long posts stay project settings.
- **Migration.** `planConsolidation` gives each channel to the first project using it (the source first) and lists `channelConflicts`. `applyConsolidation` copies the source's channel list onto the connection, puts each project's channels on its grant and `allowedChannelIds`. The rollback removes them again.
- **Open.**
  - E2E for the dialog has not run.
  - Channels of two connections to the same Postiz organization are not checked against each other.

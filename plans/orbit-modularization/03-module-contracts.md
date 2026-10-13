# 03 — Module contracts and interfaces

**Status:** Proposal, 2026-10-13. These are type sketches, not implemented code. Names are illustrative. They follow the existing conventions: zod 4 schemas, `Scope`, `DbTx`, `DomainError` codes and English comments.

**Legend:** **[Fact]** = observed in the code today. **[Proposal]** = target contract.

---

## 1. Design principles

1. **Extend existing types instead of inventing new ones.** Several current types become the module-facing contracts with small changes:

   | Existing type | Location |
   |---|---|
   | `OrbitTool` | `agents/tools/registry.ts:37-48` |
   | `ActionDefinition` | `action-requests.ts:49-58` |
   | `Specialist` / `StepHandler` | `agents/specialists/types.ts`, `runner.ts:117-126` |
   | `AgentRuntime` port | `agents/runtime/port.ts` |
   | `ChatCard` | `chat-tools.ts:60-68` |

2. **Closed unions become registries.** The following are closed unions today: `ToolNamespace`, `ToolFeature`, `ChatCard`, `ActionDefinition.riskClass`, `TaskClass`, `RunKind` and the queue classes. In the target they are validated against the registry when the process starts. Any name collision or unknown dependency **fails the start** of the API and worker. It is not detected later at runtime.
3. **Contracts carry no SDK or provider types.** This keeps the current `port.ts` rule.
4. **Every contract callback receives `(tx, scope)`.** It runs inside `scoped()` (RLS plus project lock). Callbacks never open their own unscoped connection.
5. **Modules talk to each other only through `contract.ts` service interfaces or platform events.** They never read each other's entity kinds directly. Existing direct reads are listed as violations in the baseline (WP0.3) and removed step by step.

## 2. Server module manifest

```ts
// packages/module-contracts/src/server.ts
export type ModuleId = string; // lower-case, [a-z][a-z0-9_]{1,30}

export interface ServerModule {
  id: ModuleId;
  version: string;                         // semver of the module contract, for compatibility checks
  displayName: { en: string; de: string };
  dependsOn: ModuleId[];                   // hard: enable requires these enabled
  optionalDependsOn?: ModuleId[];          // soft: features degrade when absent
  defaultEnabled: boolean;                 // backfill value for existing projects

  permissions: PermissionDef[];
  entityKinds?: EntityKindDef[];           // kinds in the shared Entity table owned by this module
  tables?: string[];                       // physical tables owned (grant + RLS matrix tests read this)
  settings?: ModuleSettingsDef;

  routes?(router: ModuleRouter): void;     // mounted by the platform; guard checks activation + permission
  actions?: Record<string, ActionHandlerDef>; // legacy POST /actions/:action handlers

  jobs?: JobDef[];
  scheduler?: SchedulerContribution;
  hooks?: ModuleHooks;

  tools?: OrbitTool[];
  actionTypes?: Record<string, ActionDefinition<any>>;
  taskClasses?: TaskClassDef[];
  stepHandlers?: Record<string, StepHandler>;   // specialist pipelines (marketing assignment DAG)
  assistant?: AssistantContribution;
  cards?: CardTypeDef[];
  notifications?: NotificationKindDef[];
  callbacks?: Record<string, CallbackHandler>;  // inbound Telegram/Slack callback routing
  readiness?: ReadinessContributor;
  events?: { subscribes?: EventSubscription[]; publishes?: EventTypeDef[] };
}
```

**Registry** (`apps/api/src/modules/registry.ts`):

```ts
export const modules: ServerModule[] = [knowledgeModule, marketingModule];
// validateRegistry(modules) checks:
// - unique ids; dependencies resolvable and acyclic
// - unique entity kinds, tables, permission keys, action names, tool names, queue classes,
//   task classes, card types, notification kinds and callback prefixes
```

Both `apps/api/src/main.ts` and `apps/worker/src/main.ts` import this one list. The worker no longer imports individual module files.

## 3. Activation and settings

```ts
// platform/modules/activation.ts — backed by table ProjectModule (FORCE RLS project_scope)
export interface ModuleActivationService {
  list(tx: DbTx, scope: Scope): Promise<ModuleState[]>;      // includes registry modules not yet enabled
  isEnabled(tx: DbTx, scope: Scope, id: ModuleId): Promise<boolean>;
  enable(tx: DbTx, scope: Scope, id: ModuleId): Promise<void>;  // owner; checks dependsOn; audit "module.enabled"
  disable(tx: DbTx, scope: Scope, id: ModuleId): Promise<void>; // owner; refuses when a dependent is enabled
}
export type ModuleState = { id: ModuleId; enabled: boolean; version: string; settingsVersion: number };

export interface ModuleSettingsDef<S = unknown> {
  schema: z.ZodType<S>;          // validated on write; stored in ProjectModule.settings with version
  defaults: S;
  ownerOnly: boolean;
  publicView?(s: S): unknown;    // strip secrets before returning to the client
}
```

**[Proposal]** Marketing's existing setting records keep their current storage while they migrate:

- the publishing policy (`policies` entity);
- the marketing profile (`ProjectMarketingProfile` table);
- the autopilot and assignment settings.

`ModuleSettingsDef` is for *new* lightweight settings only. It does not replace these versioned, hash-bound records, because approvals and assignment confirmations hash them (`docs/IMPLEMENTATION_STATUS.md`, PACKAGE_CHANGED incident on 12.10).

**Enforcement points.** When a module is disabled, the platform guard handles each entry point as follows:

| Entry point | Effect |
|---|---|
| Module route | `404 MODULE_DISABLED` |
| Legacy action | `404 MODULE_DISABLED` |
| Generic collection of an owned kind | `404 MODULE_DISABLED` |
| Tool | hidden from runs |
| Pending job of that module | completes as `skipped_module_disabled` (no retry) |
| Scheduler contribution | not called |
| Navigation | hidden |

## 4. Permissions

**[Fact]** Today there are three roles (`owner`, `editor`, `viewer`), and permission checks are scattered (`01` §6).

**[Proposal] (AD-07)** A catalogue of permission keys:

- Keys are declared by modules and by the platform.
- Each key has a default mapping to the three roles.
- Custom roles are not introduced yet.

```ts
export type PermissionDef = {
  key: `${ModuleId}.${string}`;          // e.g. "marketing.content.write", "knowledge.sources.manage"
  description: string;
  defaultRoles: Array<"owner" | "editor" | "viewer">;
  sensitive?: boolean;                   // listed in security review; never granted to viewer
};

// platform/tenancy/authorize.ts
export function can(scope: Scope, key: PermissionKey): boolean;
export function authorize(scope: Scope, key: PermissionKey): void; // throws DomainError("FORBIDDEN", 403)
```

**Migration rule.** The first catalogue reproduces today's behaviour exactly:

- Each owner-only action becomes a key with `defaultRoles: ["owner"]`.
- Each write route becomes a key with `["owner", "editor"]`.

A generated route × role matrix test (WP0.2) is the regression oracle.

**[Proposal] Module-level roles (WP4.5).** These are required by the own Support module: support agents must not see marketing. The original question Q-10 listed two options:

- a `ProjectMember.moduleRoles Json` column;
- a `ProjectMemberModuleRole` table.

The recommendation is the table, because it is indexable, auditable and managed by `orbit_auth` like `ProjectMember`. `can()` resolves the module role first, then the project role. The role `none` hides the module. The permission keys stay stable either way.

**Customers are not Orbit users.** Public module endpoints (§5.1) authenticate customers by public key plus session token, and never through `scopeFor`.

## 5. HTTP contracts

```ts
export interface ModuleRouter {
  get(path: string, def: RouteDef): void;      // path relative to the mount point chosen by the platform
  post(path: string, def: RouteDef): void;
  put(path: string, def: RouteDef): void;
  patch(path: string, def: RouteDef): void;
  legacy(absolutePath: string, method: HttpMethod, def: RouteDef): void; // keeps today's URLs
}
export type RouteDef = {
  permission: PermissionKey | "session";        // "session" = any member (read views)
  body?: z.ZodType; query?: z.ZodType; response?: z.ZodType; // feeds OpenAPI
  scoped?: boolean;                              // default true: handler gets (tx, scope) inside scoped()
  rateLimit?: { max: number; window: string };
  handler(ctx: { tx?: DbTx; scope: Scope; body: unknown; query: unknown; req: FastifyRequest }): Promise<unknown>;
};
export type ActionHandlerDef = Omit<RouteDef, "response"> & { module?: ModuleId };
```

The platform mounts module routes in one of two places:

- `/api/projects/:projectId/<moduleId>/…` for new routes;
- the legacy absolute path, for migrated routes.

The guard pipeline order is fixed:

1. Session check.
2. `scopeFor` membership check.
3. Module activation check.
4. Permission check.
5. Zod validation.
6. `scoped()` wrapper.
7. Error mapping.

Today each route handles these steps by hand (`server.ts`).

**[Proposal] `scoped` opt-out.** Some routes must run without the project lock:

- SSE polling of a chat run;
- external webhook ingestion that only enqueues.

These routes can declare `scoped: false` and receive a read-only, RLS-scoped helper. That helper is part of the optional lock evaluation in WP4.3 and is not required for the first migration.

### 5.1 Public ingress contracts (WP4.2)

Modules that talk to non-users (Support today; later forms or webhooks) declare public endpoints instead of hand-wiring routes:

```ts
export interface ServerModule {
  // … (§2)
  webhooks?: Record<string, WebhookDef>;      // mounted at /api/hooks/:provider/:connectionId
  publicApi?(router: PublicRouter): void;      // mounted at /api/public/<moduleId>/:publicKey/…
}
export type WebhookDef = {
  verify(req: RawRequest, connection: Connection): Promise<boolean>;   // signature / secret
  idempotencyKey(payload: unknown): string;                            // provider message id
  enqueue: string;                                                     // queue class that processes it; request returns 200 fast
};
export interface PublicRouter {
  // resolvePublicKey maps the key to {workspaceId, projectId, inboxId}; CORS from per-key allowed origins;
  // session = hashed bearer token issued by the module; per-client + per-session rate limits; JSON only; no cookies.
  get(path: string, def: PublicRouteDef): void;
  post(path: string, def: PublicRouteDef): void;
  sse(path: string, def: PublicStreamDef): void;   // Redis pub/sub fan-out + Last-Event-ID resume (WP4.3)
}
```

Public routes run under RLS for the resolved project. Their read paths use the lock-free `scopedRead()` (WP4.3). Their writes use `scoped()`.

### 5.2 Platform services added for Support

| Service | Sketch | WP |
|---|---|---|
| Files | `files.put(tx, scope, {moduleId, stream, mime, maxBytes}) → FileRef`; `files.authorizeDownload(scope, ref)`; `files.delete(ref)` | WP4.6 |
| E-mail connection | `email.send(conn, message) → {outcome, externalId}`; inbound through `webhooks`; delivery events → module handler | WP4.7 |
| Notifications | `notify(tx, scope, {moduleId, kind, recipients: users \| permission, payload})`; per-user preferences; channels in-app, e-mail and Telegram (owner) | WP2.5, WP4.7 |
| Real-time | `realtime.publish(scope, stream, event)` after commit; `realtime.subscribe(scope, stream, lastEventId)` | WP4.3 |
| OAuth tokens / grants | Orbit is the OAuth 2.1 authorization server. `McpGrant(userId, clientId, workspaceId, projectIds, scopes, modules?)`. The same server can later issue REST API tokens (Support E6). | WP-M1 |
| MCP gateway | Adapts registry tools with `exposure.mcp` (R0, P, selected W0) and module resource templates. Effective permission = tool ∩ user role ∩ grant ∩ activation. P tools create ActionRequests. Details in `09`. | WP-M2–WP-M4 |

## 6. Agent capability contracts

### 6.1 Tools

The **[Fact]** existing `OrbitTool` type is extended:

```ts
export type OrbitTool = {
  name: string;                          // registry key; new tools use "<module>.<verb_noun>" — legacy names kept as aliases
  module: ModuleId | "platform";         // replaces closed ToolNamespace for filtering/attribution
  namespace: string;                     // free string for tool-search grouping (≤10 tools per namespace, ADR 0007 §6)
  description: string;
  parameters: z.ZodObject;               // strict JSON schema generated as today (registry.ts:54-117)
  output?: z.ZodType;                    // NEW: validated + size-capped before reaching the model (ADR 0007 §2)
  risk: "R0_read" | "W0_internal" | "P_proposal";   // unchanged: agents never get external side effects
  permission: PermissionKey;             // replaces roles[]
  requires?: { feature?: string; connection?: ConnectionCapability; moduleSetting?: string };
  costCategory?: string;                 // NEW: budget attribution for paid reads (e.g. knowledge query embeddings)
  deferLoading: boolean;
  exposure?: { assistant: boolean; mcp: boolean }; // NEW: MCP is opt-in per tool (09 §5.1); default assistant only
  mcpResources?: ResourceTemplateDef[];             // NEW: read-only resource templates (orbit://projects/{id}/…)
  execute(ctx: ToolContext, args: unknown): Promise<ToolResult>;
};
export type ToolContext = {
  scope: Scope; runId: string; callIndex: number;
  channel:
    | { kind: "assistant"; conversationId: string }
    | { kind: "specialist"; taskId: string; runId: string }
    | { kind: "mcp"; clientId: string; grantId: string; requestId: string };   // NEW (09 §8)
  activeModules: ReadonlySet<ModuleId>;
};
export type ToolResult = { output: unknown; cards: Card[] };    // Card = registered card types, see 6.4
```

**Availability.** A tool is available for a run if **all** of these hold:

- its module is enabled;
- `can(scope, permission)` is true;
- the feature flag is on;
- the connection capability is verified.

All four are checked again at execution time. When more than about 15 tools are available, tool search is enabled and only the platform core is always loaded (`02` §9).

### 6.2 Action types (approvals)

The **[Fact]** existing `ActionDefinition` (`action-requests.ts:49-58`) is opened up:

```ts
export type ActionDefinition<P> = {
  type: `${ModuleId}.${string}`;          // e.g. "marketing.content.schedule"; legacy "content.schedule" aliased
  riskClass: "R0" | "W0" | "C1" | "C2" | "W1" | "W2" | "D1" | "D2" | "F1" | "F2" | "G"; // ADR 0008 taxonomy
  approvalMode: "approval_required" | "auto_within_policy" | "approval_required_reauth" | "ui_only";
  deciderPermission: PermissionKey;
  ttlMs: number;
  payload: z.ZodType<P>;
  costCeilingMicros(payload: P): number;
  revalidate(tx: DbTx, scope: Scope, payload: P): Promise<void>;
  onApproved(tx: DbTx, scope: Scope, request: ActionRequestRow): Promise<void>; // usually: enqueue deterministic executor job
};
```

**Hard floors** stay platform code constants (ADR 0008 §4):

- `D1`, `D2`, `F1`, `F2`, `G` and infrastructure actions can never be relaxed by a module, a policy or the model.
- Agent-initiated actions default to one step stricter.

`requestedBy.agentRunId` is filled reliably. **[Fact]** Today it is `null` for agent requests (`assignments.ts:430`, `content-packages.ts:316`).

### 6.3 Task classes, specialists, runs

```ts
export type TaskClassDef = {
  id: `${ModuleId}.${string}` | LegacyTaskClass;  // legacy: chat_operator, draft_social, … stay valid
  defaultRoute: { tier: "fast" | "standard" | "quality"; maxOutputTokens: number; reasoningEffort?: string };
  label: { en: string; de: string };              // shown in AI configuration UI
};
```

The `routing.ts` `taskRoutesSchema` stops being `.strict()` over a fixed enum. It validates keys against the registry instead. The stored `openai_configuration` route keys stay compatible.

`RunKind` on `AgentRun` becomes a string validated against `"platform.*"` and the registered module kinds. One nullable column `AgentRun.module` (migration) is added for cost attribution. It can be derived for existing rows from `kind`.

The specialist runner core (claim, recovery, budgeted model, limits, output validation) moves to `platform/agents`. `StepRole`, `buildWorkPlan` and the marketing `BASE_INSTRUCTIONS` stay in marketing as `stepHandlers` and work-plan builders.

### 6.4 Assistant contribution and cards

```ts
export type AssistantContribution = {
  instructions(ctx: { scope: Scope; activeModules: ReadonlySet<ModuleId>; features: FeatureSet }): string[]; // prompt fragments
  validationCodes?: string[];      // codes the runner reports as "blocked" instead of "failed"
};
export type CardTypeDef = { type: `${ModuleId}.${string}`; schema: z.ZodType; staleCheck?(tx, scope, card): Promise<boolean> };
```

**[Proposal] Prompt composition order:**

1. A platform base prompt: identity, safety rules, untrusted-data rule, budget wording, readiness wording. This is extracted from `chat-runner.ts:69-80` without the marketing wording.
2. The fragments of the active modules, in registry order.
3. The feature fragments (packages, assignments).

**Regression gate:** for a project with only marketing and knowledge enabled, the composed prompt has to stay **byte-identical** to today's prompt until an intentional change is approved and evaluated (`evals/operator`).

`ChatProposal` (campaign → mission) stays the marketing tool's implementation. Converging it into `ActionRequest` is a separate, later decision (ADR 0008 §7).

## 7. Jobs, scheduler, hooks, events

```ts
export type JobDef = {
  queueClass: string;                     // existing names kept: "publishing", "generation", "ingestion", …
  concurrency?: number;                   // default 1 (today: publishing 2)
  runWhilePaused?: boolean;               // today only telegram_notification (worker main.ts:184)
  outcomeUnknownOnLeaseExpiry?: boolean;  // today: publishing, slack_notification, postiz_draft
  handler(ctx: { scope: Scope; job: JobRow; signal: AbortSignal }): Promise<void>;
};

// platform/jobs/enqueue.ts — moved unchanged from workflow.ts:31-64
export function enqueue(tx: DbTx, scope: Scope, queueClass: string, input: JobInput): Promise<JobRow>;

export type SchedulerContribution = {
  sweep(tx: DbTx, scope: Scope, at: Date): Promise<{ queued: number }>;
  nextDueAt(tx: DbTx, scope: Scope, at: Date): Promise<Date | null>;  // platform takes the min over modules
};

export type ModuleHooks = {
  onProjectPause?(tx: DbTx, scope: Scope, ctx: { generation: number }): Promise<void>;   // marketing: block publications; agents: stop runs
  onProjectResume?(tx: DbTx, scope: Scope): Promise<void>;
  onModuleDisable?(tx: DbTx, scope: Scope): Promise<void>; // cancel pending non-started jobs; never delete data
};
```

**[Fact]** `lifecycle.sweepProject` (`lifecycle.ts:199-283`) becomes three scheduler contributions:

- the marketing sweep: missed slots, assignments or autopilot, missions, content packages, experiments;
- the knowledge sweep: periodic source sync;
- the Matomo and Postiz checks, which `worker/main.ts` currently schedules separately.

The sequence inside one `scoped()` transaction stays identical.

### 7.1 Events

There are two kinds, matching the two existing consistency patterns.

**In-transaction impact handlers (synchronous).** These are for invariants that must hold atomically. The main case is knowledge invalidation:

```ts
// published by the knowledge engine/service
export type KnowledgeImpact = {
  type: "knowledge.dependency_changed";
  sourceId: string; factId?: string; reason: string; purge: boolean;
  affectedEvidenceIds: string[];          // computed by knowledge; consumers never scan evidence themselves
};
export type ImpactHandler = (tx: DbTx, scope: Scope, impact: KnowledgeImpact) => Promise<void>;
```

Handlers are called inside the publishing transaction. A failure in any handler rolls back the whole operation, which matches the semantics `invalidate()` has today. Marketing registers the handler that reproduces today's status changes:

- content → `needs_review`;
- approvals → `invalidated`;
- insights → `retracted`;
- publications → `reconciliation_required`;
- purge fields;
- reconciliation jobs.

**Durable events (asynchronous).** These are for notifications and cross-module follow-ups that can lag behind:

- They reuse the existing `Outbox` table, with topic `event.<type>`.
- They reuse the existing `jobs` and lease semantics, with idempotent consumers keyed by `outbox.id`.
- No new broker.

Example: `support.ticket_escalated` → notification transport.

```ts
export type EventSubscription = { type: string; handler(tx: DbTx, scope: Scope, event: { id: string; payload: unknown }): Promise<void> };
```

## 8. Platform services exposed to modules

| Service | Interface (sketch) | Replaces today |
|---|---|---|
| Spend mandate | `activeSpendMandate(tx, scope): SpendMandate \| null`; `reserve(tx, scope, mandate, {key, amount, category, runKey, module, taskClass, model})` | `activePolicy()` as budget source (`budget.ts:20`, `retrieval.ts:89`) |
| AI calls | `respond`, `streamChat`, `embed`, `generateImage*` (as today). `generate()` loses the marketing prompt: the caller supplies instructions and schema. | `packages/ai/src/index.ts:156-256` |
| Knowledge services | `retrieve(tx, scope, query)`, `retrieveHybrid(scope, query, budgetCtx)`, `validateEvidence(tx, scope, evidenceId)`, `usableFacts(tx, scope, {keys, purpose})`, `getFact`, `onImpact(handler)` | `retrieval.ts`, `content-packages.ts:73-121` `usableFact` |
| Jobs | `enqueue`, `JobDef`, `SchedulerContribution` | `workflow.enqueue`, `lifecycle.ts` |
| Connections | `getConnection(tx, scope, provider)`, `decryptCredential(conn)`, `setCapability(conn, "read_verified" \| "write_verified", evidence)` | `connectors` entity handling spread over ~10 files |
| Notifications | `notify(tx, scope, kind, payload)`; transport chosen by connection (Telegram owner bot today; e-mail later) | `agents/notifications.ts` (generic part) |
| Callback router | `/api/telegram/:projectId/:connectionId` dispatches `callback_data` by prefix to `callbacks[prefix]` of the owning module | `telegram.ts:342, 460` hard-wired to veto/pause |
| Audit / exceptions | `audit()`, `exception()` (unchanged) | `shared.ts:143-186` |
| Pause | `pauseProject()` → `hooks.onProjectPause` | `pause.ts` |
| Readiness | `ReadinessContributor = (tx, scope) => Promise<ReadinessItem[]>` | `readiness.ts`, `action-readiness.ts:7-21` |

### 8.1 Spend mandate versus publishing policy

**[Fact]** The `policy` schema is defined in `packages/schemas/src/index.ts:134-154`.

**[Proposal] (AD-10)** Split it in two steps.

**Step 1 (no data change).** `activeSpendMandate()` is a projection of the active `policies` entity:

```ts
{ window: {startAt, endAt}, daily, monthly, perRun, approvedPaidTests, policyVersion }
```

All paid platform operations consume it: knowledge embedding, retrieval, reindex, evaluation, assistant, images. Marketing keeps reading the full policy.

**Step 2 (optional, later).** Store the mandate separately as project AI settings, edited under Project → AI, and keep the publishing policy in marketing. This changes approval hashes, so it needs its own migration plan and must be coordinated with active assignments. It is only worthwhile once non-marketing modules need AI spend without a marketing policy (Q-05).

## 9. Inter-module contracts (`contract.ts`)

Each module exports a narrow service interface. Consumers depend only on that interface.

```ts
// modules/knowledge/contract.ts  (management-level operations other modules may call)
export interface KnowledgeModuleContract {
  sourceSummary(tx: DbTx, scope: Scope): Promise<{ id: string; name: string; status: string; publicUse: boolean; modelUse: boolean }[]>;
}
// modules/marketing/contract.ts  (what the assistant/other modules may read or propose)
export interface MarketingContract {
  campaignContext(tx: DbTx, scope: Scope): Promise<CampaignContext>;      // CTA, official link, channels
  recentContent(tx: DbTx, scope: Scope, q: { channels?: string[]; days: number }): Promise<ContentSummary[]>;
}
```

Retrieval, evidence and facts are **platform knowledge services**, not part of the knowledge module contract. That way Support never depends on the knowledge module (`05` §2).

## 10. Web module manifest

```ts
// packages/module-contracts/src/web.ts (types only; components are referenced lazily)
export interface WebModule {
  id: ModuleId;
  nav: Array<{ key: string; path: string; icon: LucideIconName; label: { en: string; de: string }; permission?: PermissionKey; mobile?: boolean }>;
  routes: Array<{ path: string; component: () => Promise<{ default: React.ComponentType }> }>; // relative to /p/:projectId/<id>
  homeTile?: { component: () => Promise<...>; order: number };
  settingsPanels?: Array<{ key: string; label: {...}; component: () => Promise<...>; permission: PermissionKey }>;
  cardRenderers?: Record<string, () => Promise<...>>;      // by CardTypeDef.type
  approvalItems?: () => Promise<...>;                     // contribution to the platform approvals inbox
  legacyPaths?: Record<string, string>;                   // "/content" -> "content"
}
```

The shell gets the active modules from `GET /api/projects/:id/modules`. It then builds the navigation, the routes and the settings tabs from it. Permissions in `nav` only hide items. The server remains authoritative.

## 11. Versioning and compatibility

- `ServerModule.version` is semver for the module's *contract*: settings schema, action payloads, card schemas and events. It does not version the code.
- `ProjectModule.version` records the version that was active when settings were last written. A module may ship `migrateSettings(from, to)`.
- **Persisted payloads are never silently reinterpreted.** This covers ActionRequest payloads, approval hashes, assignment confirmations and card payloads. A schema change adds a new version branch, which matches today's practice: assignment fields are "hashed only when set" (`IMPLEMENTATION_STATUS.md`, R76/R77).
- Breaking contract changes between modules need both sides changed in the same PR. That is possible in a monorepo with a static registry.

## 12. Boundary enforcement

**[Proposal] (AD-13).** Extend `scripts/source-check.mjs` with an import-boundary pass. It needs no new dependency:

- Parse `import … from "…"` and dynamic `import("…")` with a regex.
- Resolve relative paths.
- Classify files into `platform`, `modules/<id>`, `packages/<name>`, `apps/worker` and `apps/web/{platform,modules/<id>}`.
- Check the rules from `02` §3.

The first mode is *report*: a baseline JSON of today's violations is committed and only new violations fail. The baseline must shrink to zero by the end of Phase 3.

dependency-cruiser would be a more capable alternative. It is a new dev dependency and needs approval, and it brings no material benefit at this size.

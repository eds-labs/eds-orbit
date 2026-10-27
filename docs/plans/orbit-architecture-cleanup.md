# Orbit architecture and configuration clean-up (audit and plan)

Status: **analysis and plan only** (2026-10-24). Nothing in this document has been implemented. It contains no migrations, deletions, API changes or production actions.
Basis: `main` at `a22032d6`, read-only code audit. Production data was **not** read. Statements about EDS-Labs, FamilyPlan and uLiquid combine the MCP finding of 2026-10-24 with code analysis, and are marked "inferred" where the database was not checked.

Classification under `AGENTS.md`:
- Risk: **high**. The plan changes spending authority, approvals, AI keys and module gates.
- Environment: local planning. Every implementation phase later needs its own approval.
- App profile: `fullstack-saas` (tenants, roles, billing-like budgets), plus `ai-agent-app`.
- Workflow: `refactor`, plus `migration` for phase 2.

Line numbers refer to `a22032d6`.

---

## 1. Summary

| # | Problem reported | Confirmed? | Root cause |
|---|---|---|---|
| P1 | Policies only exist in Marketing | **Yes, and worse than reported** | The AI spend mandate of *every* module is a field set of the Marketing policy (`Entity.kind = "policies"`). Every MCP or approval proposal outside four types also needs that policy. With Marketing off, it cannot be created or changed. |
| P2 | Policy configuration is hard to understand | Yes | One form combines publishing rules (channels, content types, origins, frequency, quiet hours, autonomy mode) with the project-wide AI budget. Marketing fields are required even when only a budget is wanted. |
| P3 | AI configuration is spread across several screens | Yes | Up to 3 entry points to the same "OpenAI" modal, plus a Claude dialog, an admin AI profile, an organization AI profile, a connections UI, and a Marketing image dialog. Three status shapes for the same question. |
| P4 | Some settings are OpenAI-only | Yes | Task routes are edited only in the "OpenAI configuration" modal. The AI profile editor has no Anthropic tiers. Embeddings and images are hard-wired to OpenAI. Readiness texts and codes name OpenAI. |
| P5 | OpenAI "Ready" without a project key | **Yes, two causes** | `providerStatus` counts the environment key even though the runtime ignores it once a project row exists. Also, `imageReady` only checks "row exists + price". |
| P6 | Foreign functions in Marketing | Yes | Spend mandate, project readiness, the approval inbox, Telegram bot activation, the assistant persona, integrations admin, Drive/assets, `knowledge_search` in the tool list, and Marketing branches in `action-requests.ts` and `server.ts`. |

The most important single finding: **AI execution rights depend on the Marketing module.** This is ADR 0009 AD-10 step 1 ("for now"), whose condition for a follow-up step ("as soon as a non-marketing module needs paid AI") has been met since Support, Knowledge, Finance and the assistant.

---

## 2. Current architecture

### 2.1 Layers and modules

- **API kernel** `apps/api/src/platform/**`: tenancy, governance (pause, readiness facade), AI (`budget`, `spend-mandate`, `openai-configuration`, `central-ai`, `provider-budget`, `call-plan`), knowledge services, connections, administration, MCP, assistant, tasks, files, email, notifications.
- **Product modules** `apps/api/src/modules/{marketing,knowledge,support,finance}/`.
  - Registration: `apps/api/src/modules/registry.ts:25-30` (`modules = [knowledgeModule, marketingModule, supportModule, financeModule]`), `registerModules()` `:63-75`.
- **Legacy flat files** `apps/api/src/modules/*.ts`:
  - Mostly re-export shims, either to `marketing/` (`policy.ts`, `publisher.ts`, `planning.ts`, `readiness.ts`, `action-readiness.ts`, `workflow.ts`, `postiz-*.ts`, `chat-tools.ts`, `agents/*.ts`) or to `platform/` (`budget.ts`, `openai-configuration.ts`, `ai-usage.ts`, `telemetry.ts`, `pause.ts`, `member-scope.ts`).
  - **Platform code with real logic that is still flat:** `action-requests.ts` (798 lines), `chat-runner.ts` (797), `chat.ts` (382), `agents/tools/registry.ts` (316), `assets.ts` (115), `runtime.ts` (72).
- **Worker** `apps/worker/src/main.ts`: imports no Marketing code. It blocks module jobs as `blocked_dependency`/`MODULE_DISABLED` (`main.ts:140-153`). Platform queues (`chat`, `ingestion`, `embedding`, `reindex`, `index_evaluation`, `telegram_notification`, email, archive) are never blocked (`platform/modules/platform-contributions.ts:81-138`).
- **Web**: catch-all route `apps/web/src/app/[[...route]]/page.tsx`. Module pages at `/p/:projectId/<module>/<view>`; settings at `/p/:projectId/settings?section=…` (`apps/web/src/platform/shell/settings-nav.tsx:42-54`).

### 2.2 Activation and gates

| Level | Mechanism | Location |
|---|---|---|
| Installation | `ORBIT_SUPPORT`, `ORBIT_FINANCE` (`available`) | `modules/support/contributions.ts:21`, `modules/finance/contributions.ts:16` |
| Installation | **Marketing and Knowledge have no `available` hook**, so they cannot be switched off for the whole installation | `marketing/manifest.ts:14-15` |
| Project | `ProjectModule.enabled`, effective only with `ORBIT_MODULES=true` | `platform/modules/activation.ts:9-11, 59-110`, `enforcement.ts:21-70` |
| Member | `ProjectMemberModuleRole` (`ORBIT_MODULE_ROLES`), `visibleModules()` | `platform/tenancy/module-roles.ts:22, 82` |
| API | `preHandler` per module route, collections, actions | `server.ts:907-923, 1275, 1293, 1366-1373` |
| API (own) | `requireSupport` / Finance gate (`SUPPORT_DISABLED`, `FINANCE_DISABLED`) | `support/gate.ts`, `finance/gate.ts` |
| Dependency | Marketing → Knowledge | `marketing/manifest.ts:15`, `activation.ts` |

**Contribution lookups that ignore activation:**
- `registeredReadiness()` (`platform/modules/contributions.ts:764`): the only provider is Marketing (`marketing/contributions.ts:64`). The dashboard (`server.ts:794` → `platform/governance/readiness.ts:12`) shows Marketing readiness (`OWNER_POLICY_REQUIRED`, Postiz and so on) even when Marketing is off. Without the registration the call throws `READINESS_NOT_REGISTERED`.
- `registeredChannelDirectories()` (`contributions.ts:768`): `listActionRequests` (`action-requests.ts:682`) reads Postiz channels even when Marketing is off.
- `telegramContributorEnabled()` (`contributions.ts:796`): the platform Telegram bot exists only because Marketing contributes `telegram: { enabled: agentsEnabled }` (`marketing/contributions.ts:73`). Platform notifications (Finance, Support) therefore depend on the Marketing flag `ORBIT_AGENTS`.

### 2.3 Import boundaries

- `scripts/boundaries.json` (line 116): `"baseline": []`. There are no exceptions, and `platform/**` imports nothing from `marketing/`.
- Support, Knowledge and Finance import nothing from Marketing. Their only reach outside their own folders is `modules/agents/tools/registry.ts` (platform zone).
- **The zone map has gaps:**
  - There is no `module:support` zone. `apps/api/src/modules/support/**` falls into the catch-all `"apps/api/src/modules/"` → `module:marketing` (`boundaries.json:44`), so Support↔Marketing imports are never flagged.
  - There is no `web-module:support` zone. `apps/web/src/modules/support/**` counts as `web-platform`.
- **Coupling does not run through imports but through data and contributions:** the Marketing-owned `policies` kind, Marketing-only contributions (readiness, telegram, assistant, approval inbox), and Marketing logic in platform files.

---

## 3. Confirmed findings with locations

### F1: The AI spend mandate is the Marketing policy (P1)

**Storage**
- The `Entity` row with `kind = "policies"`, `data.active = true`.
- Declared by Marketing: `apps/api/src/modules/marketing/manifest.ts:72` ("Publishing policy and, for now, the AI spend mandate (AD-10)").

**Read path**
- `activePolicyRecord()` (`apps/api/src/platform/ai/spend-mandate.ts:36-46`) reads the row directly. It checks neither module activation nor `hiddenKinds`.
- `requireSpendMandate()` (`:52-77`) throws `POLICY_REQUIRED` and validates against the **whole** Marketing schema `policy` (`packages/schemas/src/index.ts:160-180`). A malformed Marketing field (for example an invalid channel list) therefore breaks every paid AI call in every module.

**Write path (Marketing only)**
- `POST /api/projects/:id/policies` → `savePolicy` (`server.ts:1326-1328`; guard `assertModuleEnabled(collectionOwner("policies"))` at `server.ts:1293`). Permission `marketing.policies.write` (`marketing/permissions.ts:56-60`).
- `savePolicy` (`marketing/policy/policy-admin.ts:50-74`) also sets `Project.mode` (`:54-57`).
- MCP: `marketing_policy_get/update` (`policy-admin.ts:207-249`).

**Paid AI call sites that read the mandate:**

| Caller | Mandate | `reserve` | Additional cap |
|---|---|---|---|
| Assistant chat | `modules/chat-runner.ts:551` | `:579` | – |
| Support triage and draft | `modules/support/ai.ts:266` | `:291` | `aiDailyBudgetMicros` (`support/settings.ts:74`) |
| Support MCP reply | `support/mcp-tools.ts:386` (`perRunBudgetMicros` as ceiling) | – | – |
| Finance extraction | `finance/extraction/extract.ts:298`; pre-check `processing.ts:87-89, 185` | `extract.ts:323` | `aiDailyCeilingMicros` (`finance/settings.ts:38`) |
| Knowledge retrieval / embedding / reindex / evaluation | `platform/knowledge/retrieval.ts:128`, `ingestion.ts:202`, `reindex.ts:85`, `index-evaluation.ts:136` | `:141`, `:212`, `:94`, `:147` | – |
| Knowledge workspace / evaluation tools | `modules/knowledge/workspace.ts:264, 379`, `evaluation-tools.ts:87` | `workspace.ts:406` | – |
| MCP native search | `platform/mcp/native/search.ts:98-101` (falls back to lexical on `POLICY_REQUIRED`) | – | – |
| Marketing generation, images, specialists | `pipeline/generation.ts:326, 439`; `brand/image-generation.ts:264`; `agents/specialists/runner.ts:592` | `:676`, `:274`, `:623` | Assignment budget |

**Consequences**
- With Marketing off, a project without an existing policy **cannot run any paid AI**: no chat, no Support AI, no Finance extraction, no embeddings.
- A project with an existing policy keeps running on a record that nobody can see or change any more.
- `docs/adr/0009-modular-platform.md` (line 48) deferred separate storage "until a non-marketing module needs paid AI". That condition has been met.
- `apps/web/src/modules/finance/labels.ts:389-390` sends the owner to "Settings, Policy", which does not exist with Marketing off.

### F2: Approval requests need the Marketing policy (P1)

- `createActionRequest` (`apps/api/src/modules/action-requests.ts:131-135`): without `policyRequired: false` it throws `ACTIVE_POLICY_REQUIRED` (409).
- **Only four types** set `policyRequired: false`:
  - `project_configuration_update` (`platform/configuration/configuration.ts:148`)
  - `ai_models_update` (`platform/ai/mcp-tools.ts:387`)
  - `integrations_configure` (`marketing/publishing/integrations-admin.ts:356`)
  - `marketing_policy_update` (`policy-admin.ts:227`)
- Affected (they need a Marketing policy even though they spend nothing or are not Marketing):
  - `support_update_ticket` (`support/mcp-tools.ts:320`)
  - `support_prepare_reply` (`:354`)
  - `knowledge_add_document` and `knowledge_propose_fact` (`knowledge/mcp-tools.ts:145-252`)
  - `knowledge_evaluate`
  - `finance_retry_extraction` (`finance/mcp-tools.ts:518`)
  - `platform.task.start` (`platform/tasks/tasks.ts:88`)
  - all `approvedOperation` types (`platform/tasks/operation-tools.ts:209-245`)
- Documented as intended in `docs/FINANCE.md` (line 228). It still contradicts the semantics of `policyRequired` in `action-requests.ts:88-91` ("spends nothing and needs no Marketing automation").
- `action-requests.ts` also contains Marketing branches: the `content_packages` lookup `:697-705`, the `assignment.confirm` payload with `postiz_draft` `:765-790`, and channel directories `:682`.

### F3: The policy form mixes two responsibilities (P2)

- Editor: `apps/web/src/modules/marketing/policy-editor.tsx` (modal "New operating policy").
  - Fields: mode, channels (CSV), content types (CSV), allowed origins (CSV), mandate window, max per day, minimum spacing, daily, monthly and per-run budget, quiet hours, `approvedPaidTests`, confirmation.
- Section "Policy & budget" exists only in Marketing (`modules/marketing/settings-sections.tsx:22-26, 84`, `manifest.tsx:59`). It is hidden when Marketing is off or the member's role is `none` (`components/orbit.tsx:353-358`, `settings-nav.tsx:120`).
- Saving creates a new active version and deactivates the old ones. Every save changes `Project.mode` as a side effect.
- `approvedPaidTests` is a technical term with no explanation. The difference between "mandate window", "per-run budget" and the module caps (Support and Finance daily caps in their own settings, the Claude budget under AI) is not explained anywhere.
- The approval mode is derived from `mode` (`policyApprovalMode`, `policy-admin.ts:94-99`). There are no separate approval-rule fields.

### F4: AI key resolution is inconsistent (P5, MCP finding of 2026-10-24)

**Runtime** `runtimeOpenAiConfiguration()` (`apps/api/src/platform/ai/openai-configuration.ts:385-432`), with the central layer in `withCentralAi()` (`platform/ai/central-ai.ts:154-214`):

| Key | 1. | 2. | 3. Environment |
|---|---|---|---|
| OpenAI text | project key | granted `openai/text` connection | **only if the project has no `openai_configuration` row** (`central-ai.ts:196`, `openai-configuration.ts:426-431`) |
| OpenAI image | project key | granted `openai/image` | only without a row (`central-ai.ts:202`) |
| Anthropic | project key | granted `anthropic/text` | **always** (`central-ai.ts:208`, `openai-configuration.ts:430`) |

- This contradicts `docs/MODEL_ROUTING.md:7, 70` (both environment keys only "when no Orbit configuration has been saved").
- **How a row without an OpenAI key comes about:**
  - `saveOpenAiConfiguration` (`openai-configuration.ts:554-561`) allows the first save without an OpenAI key as long as `ANTHROPIC_API_KEY` is in the environment.
  - `saveAiProviderConfiguration` (`:642-648`) allows it as soon as any environment key exists.
  - The row then holds OpenAI tiers and routes but no `encryptedApiKey`, and the environment OpenAI key is switched off from then on.
  - MCP `ai_models_update` checks this more strictly (`platform/ai/mcp-tools.ts:303-307`).
- **Cause of the MCP finding** (inferred, database not read): EDS-Labs and FamilyPlan have a row without their own OpenAI key and without an `openai/text` grant.
  - `effectiveAiStatus` (R1, see below) mirrors the runtime: OpenAI `false`, Anthropic `true` (environment or grant).
  - Stored OpenAI routes are not keys, so OpenAI-routed tasks, **embeddings** and **images** fail there with `PAID_CALL_NOT_AUTHORIZED` / `EMBEDDING_NOT_AUTHORIZED`.
  - uLiquid has its own key, a grant, or no row at all (not verified).
- **No save-time check** that a route's provider has a usable key: `superRefine` in `openai-configuration.ts:75-109, 128-133` only checks that models are verified.

### F5: Several readiness and status calculations (P5, duplicates)

| # | Function | Location | Basis | Correct? |
|---|---|---|---|---|
| R1 | `effectiveAiStatus` | `openai-configuration.ts:441-500` | runtime incl. grants | **yes** (mirrors the runtime) |
| R2 | `textModelReady` | `:511-527` | R1 + routes `chat_operator` / `draft_social` | partly: the first branch accepts any OpenAI key even when the routes point to Claude |
| R3 | `providerStatus` | `:268-289` | stored key **or the environment key** (`:276-277`), no grants | **no**: shows OpenAI "Ready" although the runtime ignores the environment key, and "No key" when the key comes through a grant |
| R4 | `publicOpenAiConfiguration` | `:291-356` | `configured: true` as soon as a row exists (`:332`) | **no** |
| R5 | Marketing readiness `model` | `marketing/readiness/readiness.ts:95-101, 123` | any key + any verified model; code `VERIFIED_OPENAI_MODELS_REQUIRED` | **no**: key and route provider are not matched |
| R6 | `actionReadiness` | `readiness.ts:163-168`, `action-readiness.ts:81, 132` | R1/R2; same code, different logic | partly |
| R7 | `aiStatus` fallback | `readiness.ts:31-55` | R3/R4 | no (Anthropic from environment) |
| R8 | MCP `ai_models_get` | `platform/ai/mcp-tools.ts:101-229` | R1/R2; `unverifiedRoutedModels` always lists OpenAI tiers | mostly |
| R9 | MCP `project_readiness_get` | `marketing/readiness/readiness-admin.ts:180-232` (registered by Marketing) | R5/R6 | inherits R5 |
| R10 | Web `imageReady` | `apps/web/src/modules/marketing/advanced.tsx:1025-1030` | R4 `configured` + price | **no**: no key check |
| R11 | Web "Ready" badge | `apps/web/src/components/ai-settings.tsx:594-620` | R3 | **no** (UI symptom P5) |
| R12 | Provider budget `configured` | `platform/ai/provider-budget.ts:93-125` | Anthropic only | – |
| R13 | Connection check (the only reachability probe) | `platform/ai/connection-providers.ts:19-62`, `administration/connection-routes.ts:100` | `GET /v1/models` | central connections only; project keys are never probed |

Not covered by any calculation: provider reachability for project keys, cost configuration per route (price present for the *routed* model), and image and embedding availability separately from text.

### F6: AI configuration surfaces and APIs (P3, P4)

**Web surfaces**
1. Settings → AI: `apps/web/src/components/ai-settings.tsx` (`AiSettings` `:497`).
   - "OpenAI configuration" modal (`:947-1174`): **all task routes, Claude routes included, can only be edited here** (`:986-1018`). The rate card is labeled "Current OpenAI rate card" (`:1076`). The image model only offers GPT Image (`:1033-1055`).
   - Claude dialog `AnthropicConfiguration` (`:144-316`).
   - `ProviderBudgetForm`, Anthropic only (`:319-448`, `:692-767`).
2. The same OpenAI modal again from the overview ("Configure OpenAI", `components/management.tsx:671-674`) and from the Integrations tab (`:701-718`). Three entry points in total.
3. Marketing assets: "Generate with OpenAI", OpenAI consent texts (`modules/marketing/advanced.tsx:999-1060, 1297, 1386, 1411`).
4. Knowledge embeddings, OpenAI only (`modules/knowledge/index-management.tsx:158-233`, `knowledge.tsx:1511-1541`).
5. Admin and organization AI profile (`platform/administration/ai-knowledge-ui.tsx:28+`, used in `admin-area.tsx:144`, `organization-integrations.tsx:39`). Only `defaultProvider`, verified models, **OpenAI** tiers and the rate card; no Anthropic tiers, task routes or images, although the API accepts them (`central-ai.ts:49-54`).
6. Central connections (`platform/administration/connections-ui.tsx:401-530`). The project view hides AI grants (`components/granted-connections.tsx:37-39`), so a project cannot see its granted keys anywhere.
7. Readiness texts "Add an OpenAI key…" (`apps/web/src/lib/readiness-text.ts:58, 66, 91, 100`).

**APIs**
- `GET /api/projects/:id/openai-configuration` (`server.ts:883-896`; R3 + R4).
- Actions `openai-configure` **and** `ai-provider-configure` (`platform/http/platform-actions.ts:50-87`): two save paths to the same entity.
- `GET …/ai-budget` (Anthropic only, `server.ts:~847-881`) and `GET …/ai-cost` (`server.ts:841-845`).
- `GET/PUT /api/admin/ai/profile`, `/api/organizations/:id/ai/profile` (`administration/connection-routes.ts:206-221`).
- MCP `ai_models_get/update` (`platform/ai/mcp-tools.ts:368-416`; writes through **both** save functions, `:403-407`). `project_readiness_get` (Marketing-registered).

**Hard-wired OpenAI**
- `embed()` (`packages/ai/src/index.ts:486-546`); callers in `platform/knowledge/{retrieval:171, reindex:145, index-evaluation:174, ingestion:279}`.
- `generateImage` / `generateImageWithReferences` (`index.ts:568-683`), `marketing/brand/image-generation.ts:148, 224, 365`.
- `packages/ai/src/rejection.ts:1` (OpenAI `APIError`).
- `runner.ts:7` (`zodTextFormat` from `openai/helpers/zod`).
- `purposeOfModel` (`central-ai.ts:75-77`).

**Budgets and prices**
- Provider budget for Anthropic only (`packages/ai/src/index.ts:174-176`). AI profiles cannot hold `providerBudgets` (`openai-configuration.ts:533-541`).
- A price catalogue exists only for Anthropic (`packages/ai/src/provider.ts:80-149`).
- Attribution ignores a profile's `models` registry (only the `claude-` prefix counts).
- Data model: everything lives in one `Entity(kind = "openai_configuration")` per project (`openai-configuration.ts:135-148, 358-366`). The name no longer matches its content.

### F7: Foreign responsibilities in Marketing or in platform files (P6)

| Item | Location | Problem | Target |
|---|---|---|---|
| Spend mandate | `policies` kind, `policy-admin.ts`, `policy-editor.tsx` | see F1 | Platform governance |
| Project readiness | `marketing/readiness/*`; the only `readiness` contributor | AI, knowledge, Drive and Postiz in one; dashboard depends on Marketing | Platform readiness with module contributions |
| `project_readiness_get` | `readiness-admin.ts:222`, registered in `marketing/contributions.ts:48` | platform tool from a module | Platform (AI/administration) |
| Approval inbox | `apps/web/src/modules/marketing/work.tsx` `ApprovalInbox`, `apps/web/src/modules/registry.ts:31, 155` (`requiresModule: "marketing"`) | platform inbox only with Marketing | Platform decisions (`decisions` page already exists, `:168-171`) |
| Telegram bot activation | `marketing/contributions.ts:73`, `server.ts:214-226, 330` (`AGENT_ROUTES` incl. `/telegram*`) | bot and platform notifications depend on `ORBIT_AGENTS` | Platform notifications/connections; Marketing contributes only the Stop callback |
| Assistant persona | the only `assistant` contribution: `marketing/assistant/prompt.ts:24`; fallback `NO_MODULE_INSTRUCTIONS` (`chat-runner.ts:86-91, 515-522`) | every project chats as the "marketing operator"; without Marketing the prompt is wrong when Support/Finance/`knowledge_search` tools are offered | Platform base prompt + module fragments |
| `knowledge_search` in the Marketing tool list | `marketing/tools/read-tools.ts:208` | duplicate listing of a platform tool (`platform/knowledge/search-tool.ts:75` `alwaysOffered`) | Platform only |
| Integrations admin (MCP) | `marketing/publishing/integrations-admin.ts` (`integrations_get/configure/verify`, incl. Drive test) | generic project integrations owned by Marketing | Platform connections; Marketing contributes provider checks |
| Drive/assets | `brand/drive-assets.ts`, `drive-retry.ts`, `render-asset.ts`, `modules/assets.ts`, routes `routes.ts:241-286, 384-417` | storage/import of generic files | Platform files (decision Q-06 open) |
| Image provider/pricing | `brand/image-generation.ts` | provider part is shared AI | `platform/ai/images`; prompts stay in Marketing |
| Slack transport | `publishing/slack.ts`, route `routes.ts:75` | signature/configuration generic | Integrations; digest stays in Marketing |
| Marketing in `server.ts` | `server.ts:1-4, 13, 74-75, 122-127, 1290-1350, 504` (novelty, `activePolicy`, `savePolicy`, `assertMissionAssets`, `postizQueueState`) | platform server knows Marketing details | Collection hooks in the Marketing contribution |
| Marketing in `action-requests.ts` | `:682, 697-705, 765-790` | see F2 | Module hooks (`describeRequest`, `channelDirectory`) |
| Platform logic still flat | `action-requests.ts`, `chat.ts`, `chat-runner.ts`, `agents/tools/registry.ts`, `runtime.ts` (`postizQueueState`) | wrong place, but platform zone | `platform/approvals`, `platform/assistant`, `platform/tools` |
| `Project.mode` | core table, written by `savePolicy` | Marketing autonomy mode on the project | Marketing setting (read-compatible) |

**Correctly placed (keep):** channel rules, posting slots, Postiz drafts/verification/queue watch, veto window, Telegram Stop callback format, assignments, plans, reports, claims/novelty/duplicates, pause and resume semantics, `knowledge-impact` hook (see §5.4).

### F8: Test gaps

- All Support, Finance, chat and knowledge suites use `createPackageProject` (`apps/api/tests/support/package-project.ts:84`), which seeds an **active autopilot policy**. That hides the dependency on Marketing.
- There is no test where **Marketing is off and no policy exists** for: chat, Support AI, Finance extraction, embedding, Support/Finance action requests, or an owner trying to set a budget.
- Existing tests for disabled modules (keep them):
  - `module-enforcement.integration.test.ts:136-247`
  - `module-activation.integration.test.ts:177-251`
  - `apps/worker/tests/module-disabled.integration.test.ts:81`
  - `support-mcp.integration.test.ts:~632`
  - `attention-knowledge-platform.integration.test.ts:452-625`
  - `module-roles-assistant.integration.test.ts:125`

---

## 4. Duplicate implementations

| Area | Duplicates | Consolidation |
|---|---|---|
| AI status | R1–R11 (see F5), three response shapes (REST `openai-configuration`, MCP `ai_models_get`, readiness) | one `aiCapabilityStatus()` service, every surface reads it |
| AI save | `saveOpenAiConfiguration` + `saveAiProviderConfiguration`; actions `openai-configure` + `ai-provider-configure`; MCP writes through both | one `saveAiConfiguration` with section patches |
| AI UI | OpenAI modal ×3 entry points, Claude dialog, admin/org profile editor, Marketing image dialog | one "AI & models" area with three levels (system/org/project) |
| Error codes | `VERIFIED_OPENAI_MODELS_REQUIRED` in R5 and R6 with different logic; `POLICY_REQUIRED` / `ACTIVE_POLICY_REQUIRED` for publishing **and** spending | provider-neutral codes (`AI_TEXT_KEY_MISSING`, `AI_ROUTE_UNPRICED`, `SPEND_MANDATE_REQUIRED`, …) with aliases |
| Budget | policy daily/monthly/run, Support daily cap, Finance daily cap, Anthropic provider budget, grant/org/connection counters, assignment budget, image ceiling | keep the layers, but show them in **one** budget view with their order |
| Readiness | `registeredReadiness` (Marketing only) vs. `actionReadiness` vs. MCP readiness | platform readiness aggregating module contributions |
| Tool lists | `knowledge_search` from the platform (`alwaysOffered`) and from Marketing | platform only |
| Inbox | Marketing `ApprovalInbox` vs. platform `decisions` | platform |

---

## 5. Target architecture

### 5.1 Responsibilities

```
platform/governance   ── spend mandate (AiSpendPolicy), autonomy defaults, pause, approvals (ActionRequest),
                         project readiness (aggregator), audit
platform/ai           ── providers, keys (project → grant → environment, one rule), routes, rate cards,
                         provider budgets (all providers), capability status, images, embeddings
platform/assistant    ── chat store, runner, base prompt; modules contribute fragments/tools
platform/connections  ── all connections incl. integrations admin, Telegram bot, Slack transport, Drive
platform/files        ── assets/raster normalization/Drive import (after Q-06)
modules/marketing     ── publishing policy (channels, frequency, origins, quiet hours, autonomy mode),
                         missions, assignments, agents, Postiz, veto, reports, brand
modules/support       ── tickets, inboxes, triage/draft prompts, daily cap
modules/finance       ── documents, extraction, daily cap, consent
modules/knowledge     ── management UI; services stay in the platform
```

### 5.2 Policy model (target)

Three clearly separated levels, each with its own owner, UI and audit:

1. **AI spending authority (platform, project-wide)**, `kind = "ai_spend_policies"` (or its own table, see E-2):
   - Fields: `startAt`, `endAt`, `approvedPaidUse` (formerly `approvedPaidTests`), `dailyBudgetMicros`, `monthlyBudgetMicros`, `perRunBudgetMicros`, optional `moduleCaps: { support?, finance?, knowledge?, assistant?, marketing? }` (read-compatible with the existing module settings).
   - Versioned with `active`, `activatedBy`, `activatedAt`, owner-only, audit `ai_spend_policy.activated`.
   - `requireSpendMandate` validates **only** this schema.
2. **Module policies (module-owned):**
   - Marketing publishing policy without budget fields: `mode`, `channels`, `contentTypes`, `allowedOrigins`, `maxPerDay`, `minIntervalMinutes`, `quietStart/End`.
   - Support and Finance keep their settings (daily cap, consent).
3. **Global/organization limits (exist already):** `AiProfile`, grant, org and connection budgets, flags.

**Approvals:** `createActionRequest` requires a spend mandate only for types with `spends: true` (new definition field), and a Marketing publishing policy only for Marketing publishing types. Default for unknown types: spend mandate required (fail closed).

### 5.3 AI configuration (target)

- **One key rule (decided E-1b):** project key → granted connection. The environment key is only the bootstrap for a project **without** a saved configuration, for every provider in the same way. After a save, no environment fallback applies, so the Anthropic environment fallback goes away too. That way every project's spend comes only from keys that belong to it or were granted to it.
- **Claude-only projects are fully usable:** text (chat, Support, Finance, Marketing agents) needs only a Claude key. Embeddings and image generation are optional purposes with their own status. Anthropic offers neither an embedding model nor image generation (Claude docs "Embeddings", checked 2026-10-24).
- **One status service** `aiCapabilityStatus(tx, scope)` → per purpose (`text`, `image`, `embedding`) and per routed task class:
  - `keySource` (`project | grant | environment | none`)
  - `modelVerified`, `priced`
  - `providerReachable` (last check, cached, never paid)
  - `budgetState` (mandate, provider, grant)
  - `ready` = all of the above.
- Save-time check: a route whose provider has no usable key is saved only with an explicit warning (no hard break for existing configurations).
- **Data model:** keep `openai_configuration` for compatibility, but read and write it through an `aiConfiguration` facade. Rename it later (`ai_configuration`) with dual read.
- **Provider budgets** generic (`providerBudgets: Record<provider, …>`), OpenAI included; inheritable through `AiProfile`.
- **Knowledge search without embeddings (decided E-8 = full text):**
  - Without a usable embedding key, the lexical search (today the fallback in `retrieval.ts:85-109`) is the official mode with its own status ("full-text search; semantic search needs an embedding provider").
  - Ingestion, sources and invalidation work without embeddings. No embedding job is queued and no reservation is made.
  - OpenAI embeddings stay optional. Voyage AI or a local model are not planned (they would need a new provider, or new embedding profiles because of the DB `CHECK` constraints in `202609170002_index_generations`).
- **Images without an image provider (decided E-9 = off):**
  - Without an OpenAI image key, image generation is off and visibly so (status, disabled action, plain-language reason). There is no new render path.
  - Existing brand banners (R78 composition with an uploaded image) are unaffected.
- Images and embeddings are their own purposes with provider registration. OpenAI stays the only implementation, but the dependency is explicit and readiness reports it separately ("Text via Claude ready; semantic search and image generation need an OpenAI key").

### 5.4 Module boundaries (target)

- Add `module:support` and `web-module:support` to `boundaries.json`; restrict the catch-all to `apps/api/src/modules/marketing/` + the flat shims.
- Move platform files that are still flat into `platform/` (`action-requests`, `chat`, `chat-runner`, `tools/registry`, `runtime`) and leave shims behind.
- Make Marketing contributions that act as platform defaults **platform-owned**:
  - readiness aggregator
  - Telegram enable (a separate flag or platform activation)
  - approval inbox
  - base assistant prompt
  - integrations admin
- New rule (test): a platform service must not read a module-owned entity kind without a contract.

---

## 6. UI concept: policies and AI

### 6.1 Project settings (with grouped navigation, preserve deep links)

**Project → "AI & budget"** (platform, owner only, visible without Marketing):

1. **Status card at the top:** "AI is ready / not ready" with plain-language reasons per purpose (text, images, embeddings). One click leads to the cause.
2. **Spending authority:**
   - Standard profiles as a starting point:
     - *Off* (no paid AI)
     - *Test* (USD 1/day, 10/month, 14 days)
     - *Normal* (USD 5/day, 50/month)
     - *Custom*
   - Every field with a one-sentence explanation: "What happens when the limit is reached?" (stop before the call, nothing is sent).
   - Window shown as "valid until" with a reminder.
   - "Paid AI use allowed" instead of `approvedPaidTests`.
3. **Budget overview (read-only):** the order project → module cap → provider budget → organization/system grant, with current consumption and "unclear" reservations (settle button).
4. **Providers & models:**
   - Per provider: key source (own / from organization / from system / none), status, reachability.
   - Tasks as a table "task → model → provider → price ✓/✗".
   - Claude and OpenAI on equal terms.
   - "Advanced" (collapsed): rate card, verified models, effort/tokens, fallback.
5. **Module caps:** shown read-only with a link to the Support and Finance settings, where they are edited (decided E-3).

**Marketing → Settings → "Publishing rules"** (formerly "Policy & budget"):
- Autonomy mode with explanations: *observe* = only suggest; *assisted* = you approve each post or the veto window applies; *autopilot* = publishes within the rules.
- Channels as a selection from assigned Postiz channels instead of CSV; content types as checkboxes; link origins as a list with validation.
- Frequency and quiet hours.
- Note: "The AI budget is in the project settings" (link).

**Legacy deep link** `?section=policy` → redirects to the AI & budget page when Marketing is off, otherwise to "Publishing rules" with a hint.

### 6.2 Administration and organization

- Use the existing ADR 0014 surfaces. The AI profile editor gets Anthropic tiers, task routes and provider budgets.
- The project view shows granted AI connections (currently hidden in `granted-connections.tsx:37-39`).

---

## 7. Migration concept

Principles:
- Additive first, then dual read, then switching writers, and finally (much later, separately approved) removing old fields.
- No row is deleted; old policy versions stay in place for audit and export.

### M1: Separate the spend mandate (data)

1. New kind `ai_spend_policies` (platform-owned, declared in the platform manifest, exported, covered by retention and RLS like `Entity`).
2. **Backfill (idempotent, per project, in its own transaction):**
   - For every active `policies` row, create an `ai_spend_policies` row with the budget fields, window and `approvedPaidTests`.
   - Store `sourcePolicyId/version`, and `activatedBy/At` taken from the source.
   - Audit `ai_spend_policy.migrated`.
   - Inactive versions are not copied (history stays in `policies`).
3. **Dual read** in `requireSpendMandate`:
   - Prefer the new active record; otherwise fall back to `policies` (budget fields only, without validating the Marketing schema).
   - A metric or log `SPEND_MANDATE_LEGACY_SOURCE` counts fallbacks.
4. **Writers:**
   - The new platform route `PUT /api/projects/:id/ai-spend-policy` + MCP `ai_spend_policy_get/update` (owner, `policyRequired: false`, exact approval as today).
   - `savePolicy` in Marketing for a transition period also writes the budget into the new kind (with an equivalence test), and is later read-only for budget fields.
5. **Version binding:**
   - Everything that stores a policy version today (`ActionRequest.policy {id, version}`, approvals, `content_packages`, `policyVersion` sum in `policy-admin.ts:81-91`, package hashes) must not change during backfill or dual read.
   - **Risk:** a package hash containing the policy (see the 2026-10-12 incident `PACKAGE_CHANGED`) invalidates running packages.
   - So the Marketing policy row stays unchanged. The migration only *adds* rows and changes no `policies` row.
6. Remove the fallback only after a report shows 0 legacy reads in production over N days (separate approval).

### M2: Approval requests

- Add `spends?: boolean` and `requires?: ("spend_mandate" | "publishing_policy")[]` to `ActionDefinition`.
- Default for existing types: the current behaviour (`publishing_policy` for Marketing types, `spend_mandate` for every other policy-requiring type), so nothing becomes more permissive by accident.
- Then deliberately relax individual non-spending types (Support ticket update, Knowledge proposals) with a security review.
- Stored ActionRequests keep `policy {id, version}`. New requests also store `spendPolicy {id, version}`. The staleness check treats a missing field as "unchanged".

### M3: AI configuration

- Keep the entity `openai_configuration`. Add the facade `aiConfiguration` and generalize `providerBudgets`.
- **Changing the key rule (E-1b) is a behaviour change:**
  - Projects with a saved configuration that run Claude today on the environment Anthropic key lose that key.
  - So roll out behind the flag `ORBIT_AI_KEY_RULE_V2`, with a dry-run report per project beforehand ("which key is used today, which one after the switch").
  - Affected projects get a project key or an `anthropic/text` grant **before** the switch (owner action, Mario's approval).
  - Projects without a saved configuration keep the environment bootstrap.
- A route version bump on switching is deliberate: running runs stop before their next paid call (`CHAT_ROUTE_CHANGED`, `GENERATION_DEPENDENCY_CHANGED`).

### M4: Module boundaries

- Move code only with shims (as in WP2.1). No change to tables or entity kinds.
- Telegram bot activation:
  - New platform flag `ORBIT_TELEGRAM` (default = the current `ORBIT_AGENTS` value) so production behaves identically.
  - Keep the Stop callback format `stop:<id>.<version>.<HMAC>` unchanged.

### Compatibility with MCP clients and integrations

- MCP tools `marketing_policy_get/update` stay. `get` additionally returns `spendPolicy` (read-only, marked deprecated). `update` with budget fields is forwarded to the new kind during the transition and documented.
- New tools `ai_spend_policy_*` are scope-gated (`project_administration`, like the other admin tools); the ChatGPT connector needs no new scope.
- Keep error codes; new codes are added only as `details.reason`. `POLICY_REQUIRED` stays the HTTP code, and `details.missing = "spend_mandate" | "publishing_policy"` is new.
- Assignments and running jobs:
  - The migration changes no `policies` row and no assignment hash (assignment hash excludes the profile; check the policy hash, see R-3).
  - Run the backfill outside the slots (10:00/17:00 Berlin) and outside the assignment run (04:00).

---

## 8. Implementation plan (three phases)

Each phase gets its own PR(s), local checks (`pnpm lint`, `typecheck`, `test`, `build`, affected e2e), and its own deploy approval (push to `main` deploys to production).

### Phase 1: Fix errors, make dependencies visible (low to medium, no schema change)

| # | Change | Locations |
|---|---|---|
| 1.1 | `providerStatus` (R3) and `publicOpenAiConfiguration` (R4) take their values from `effectiveAiStatus` (R1); add grants as a source; status per purpose | `openai-configuration.ts:268-356`, `ai-settings.tsx:594-620` |
| 1.2 | `imageReady` checks `imageKeyConfigured`; make R2/R5 provider-correct (key of the routed provider) | `advanced.tsx:1025-1030`, `openai-configuration.ts:511-527`, `readiness.ts:95-123` |
| 1.3 | Provider-neutral readiness codes/texts (old codes stay as aliases) | `readiness.ts`, `action-readiness.ts`, `apps/web/src/lib/readiness-text.ts` |
| 1.4 | Save warning when a route's provider has no key; show the inconsistency "row without OpenAI key + OpenAI routes" in the UI and in MCP `ai_models_get` | `openai-configuration.ts`, `mcp-tools.ts` |
| 1.5 | Correct `MODEL_ROUTING.md` to match the **current** behaviour (environment Anthropic key always applies) until E-1 is decided | docs |
| 1.6 | Remove `knowledge_search` from the Marketing tool list (the platform offers it); keep the prompt snapshot stable or update it deliberately | `marketing/tools/read-tools.ts:208` |
| 1.7 | Platform base prompt instead of `NO_MODULE_INSTRUCTIONS` when Support/Finance/Knowledge tools are offered | `chat-runner.ts:86-91, 515-522` |
| 1.8 | Boundary zones for Support (API + web); fix new violations, do not grow the baseline | `scripts/boundaries.json` |
| 1.9 | Finance/Support error texts: say where the mandate is set, including "Marketing must be on" (interim) | `finance/labels.ts:389-390`, Support labels |
| 1.10 | **Regression tests for the current state** (characterization): Marketing off + no policy → chat/Support/Finance/embedding/approval each give a defined code; Marketing off + existing policy → runs | new suite `modules-without-marketing.integration.test.ts` |

### Phase 2: Spend mandate and approvals into the platform (high, additive migration)

| # | Change |
|---|---|
| 2.1 | ADR "AI spend policy as a platform capability" (completes AD-10 step 2; decisions E-2…E-5) |
| 2.2 | Kind/table `ai_spend_policies`, platform manifest, RLS/export/retention, access matrix |
| 2.3 | Service + route + MCP `ai_spend_policy_get/update`, audit, owner-only |
| 2.4 | Backfill script (`--dry-run` report, `--apply` with approval), dual read in `requireSpendMandate`, legacy metric |
| 2.5 | `ActionDefinition.requires/spends`, defaults equivalent to today; then relax non-spending types after review |
| 2.6 | UI "AI & budget" (§6.1) with standard profiles; Marketing editor without budget fields (shows a link); deep link redirect |
| 2.7 | Platform readiness aggregator (`registeredReadiness` → list of module contributions + platform AI/budget section); move `project_readiness_get` to the platform |
| 2.8 | Telegram activation independent of Marketing (`ORBIT_TELEGRAM`, default = `ORBIT_AGENTS`) |
| 2.9 | Approval inbox as a platform view; Marketing contributes its request types |
| 2.10 | Installation-wide Marketing switch (E-7): `available` hook like Support/Finance, flag `ORBIT_MARKETING` default `true`. Knowledge dependency unchanged. Test: with the flag off, no Marketing route, job, tool or navigation exists. |
| 2.11 | `Project.mode` into the Marketing settings (E-6): Marketing reads its own setting with fallback to `Project.mode`. The project field stays readable and is no longer written by the AI spending authority. |

### Phase 3: Unify AI configuration, clean up Marketing (medium to high)

| # | Change |
|---|---|
| 3.1 | Key rule E-1b behind `ORBIT_AI_KEY_RULE_V2`: dry-run report per project; set up keys or grants for affected projects; then switch |
| 3.2 | One save path `saveAiConfiguration` (sections), one action, MCP on top; old actions as aliases |
| 3.3 | UI consolidation: one "AI & models" area (project/org/admin with inheritance), task-route table independent of provider, AI profile editor with Anthropic tiers |
| 3.4 | Generic `providerBudgets` incl. OpenAI; budgets inheritable through `AiProfile` |
| 3.5 | Images and embeddings as purposes with separate status. Full-text search as the official mode without an embedding key (E-8), with no embedding jobs or reservations. Image generation visibly off without an image key (E-9). No new provider. |
| 3.6 | Move flat platform files to `platform/` (`action-requests`, `chat`, `chat-runner`, `tools/registry`, `runtime`); Marketing branches in `action-requests.ts` and `server.ts` as module hooks |
| 3.7 | Integrations admin + Slack transport into connections; Drive/assets after Q-06 |
| 3.8 | Remove the legacy fallback of the spend mandate (only after evidence, separate approval) |

---

## 9. Tests and acceptance criteria

**Automated (in addition to the safety nets `rls-matrix`, `access-matrix`, `queue-dispatch`):**

1. *Modules without Marketing* (`ORBIT_MODULES=true`, Marketing off, Knowledge optional):
   - Owner sets AI spending authority → chat, Support triage/draft, Finance extraction, embedding, reindex run (with a mock provider).
   - No Marketing tool, prompt fragment, route or job is active.
   - Dashboard/readiness gives no Marketing blockers.
   - Support/Finance approval requests can be created and decided.
2. *Without spending authority:* each paid path fails **before** the reservation with `POLICY_REQUIRED` + `details.missing = "spend_mandate"`; nothing is sent (provider mock counts 0 calls).
3. *Migration:*
   - Backfill is idempotent.
   - Dual read gives identical `SpendLimits` for every seed policy.
   - No `policies` row and no stored `policyVersion`/package hash/assignment hash changes.
   - Rollback (fallback only) restores the old behaviour.
4. *AI status:*
   - Matrix test {project key, grant, environment} × {row exists, does not exist} × {OpenAI, Anthropic} × {text, image, embedding}: every status surface (REST, MCP, readiness, web helper) == runtime decision.
   - The EDS-Labs/FamilyPlan constellation is a named case.
5. *Access:* access matrix for new routes (owner write, member read according to role); a module role `none` for Marketing does not hide the AI budget page.
6. *Web e2e:*
   - Settings deep links (`?section=policy` old → new).
   - AI & budget page at 390 px.
   - Marketing off → no Marketing navigation, AI page reachable.
7. *Worker:* platform jobs run with Marketing off; Marketing jobs `blocked_dependency`/`MODULE_DISABLED` (existing test stays).

**Manual acceptance (Mario):**
- A project with Support + Finance only, Marketing off, can set a budget, extract an invoice and get a ticket draft.
- The UI shows "OpenAI not ready" for a project without a usable key, and the MCP and UI show the same values.
- uLiquid: assignment runs 04:00/10:00/17:00 unchanged after each phase; the policy hash is unchanged.

---

## 10. Risks, dependencies, open decisions

### Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-1 | Spending authority more permissive after migration (e.g. Support without a cap) | Defaults equivalent to today; dual-read equivalence test; security review for every relaxation |
| R-2 | Key rule E-1b removes the environment Anthropic key from projects with a saved configuration, so chat, Support and Finance stop there | flag + dry-run report; set up project keys or grants first; Mario's approval per project |
| R-3 | Policy version/hash changes invalidate running packages and assignments (cf. `PACKAGE_CHANGED` 2026-10-12) | migration changes no `policies` row; test of hash stability |
| R-4 | Telegram bot stops if `ORBIT_TELEGRAM` is set wrongly | default = `ORBIT_AGENTS`; Stop format unchanged |
| R-5 | MCP clients (ChatGPT) break because of changed tool schemas | only additive fields; new tools separate; old ones stay |
| R-6 | Prompt changes (base prompt, `knowledge_search` listing) change model behaviour | prompt snapshot (WP0.4) updated deliberately, separate change |
| R-7 | Unclear reservations (`unknown`) are counted twice during the switch | counters stay in `BudgetReservation`; only the limit source changes |
| R-8 | Boundary zone Support reveals hidden violations | fix them, do not grow the baseline |
| R-9 | Deploy = push to `main` → production | deploy approval per phase; migrations/backfill separately |

### Dependencies

- ADR 0014 connections (live, flags partly off): the key rule and status must take grants into account.
- Q-06 (assets/Drive ownership) for 3.7.
- `ORBIT_MODULES=true` has been in production since 18.10; phase 1.10 tests run against that.

### Decisions (Mario, 2026-10-24)

| ID | Decision | Effect on the plan |
|---|---|---|
| E-1 | **b:** after a save, no environment fallback for any provider; only the project key or a granted connection | §5.3, M3, 3.1, R-2 |
| E-2 | **Entity kind** `ai_spend_policies` (no separate table) | §5.2, M1, 2.2 |
| E-3 | **Module caps stay** in the Support/Finance settings; the "AI & budget" page shows them read-only with a link | §6.1 |
| E-4 | **Standard profiles** Off / Test (USD 1 per day, 10 per month, 14 days) / Normal (USD 5 per day, 50 per month) / Custom | §6.1, 2.6 |
| E-5 | **Non-spending proposals need no spending authority**; each type is relaxed individually after a security review, while spending types keep the requirement | M2, 2.5 |
| E-6 | **`Project.mode` moves into the Marketing settings**; the project field stays readable | 2.11 |
| E-7 | **Installation-wide Marketing switch** `ORBIT_MARKETING` (default `true`) | 2.10 |
| E-8 | **Knowledge search without an embedding key = full text** (official mode with status); OpenAI embeddings optional; no Voyage AI, no local model | §5.3, 3.5 |
| E-9 | **Image generation without an image key = off** (visibly disabled); no own render path; OpenAI stays optional | §5.3, 3.5 |

Background to E-8/E-9: Anthropic has no embedding model of its own (it recommends Voyage AI with a separate key) and no image generation. A project with only a Claude key is therefore fully usable for text. Semantic search and image generation are optional extras.

### Not verified in this audit

- Actual database contents of EDS-Labs, FamilyPlan, uLiquid (`openai_configuration`, grants, active policies).
- Whether `ORBIT_CONNECTIONS` and `OPENAI_API_KEY` are set in production.
- Whether `Entity` and `BudgetReservation` are covered by FORCE RLS.
- How the web shows the dashboard with Marketing blockers when Marketing is off.

---

## Implementation status (2026-10-24, local; not pushed)

### Phase 1: done

Commits `f5569e56` to `6a205a7f`:
- Status from `effectiveAiStatus`.
- Routes without a key.
- Neutral readiness texts.
- Fallback prompt.
- Support boundary zones.
- Mandate location in error texts.
- `MODEL_ROUTING.md`.
- Characterization tests.

Deviations from the plan:
- **1.6 dropped.** `knowledge_search` is registered with owner `platform` (`alwaysOffered`) and stays offered without Marketing, ORBIT_MARKETING=false included. Moving it would only reorder the assistant's tool list (prompt snapshot).
- **No new readiness codes.** The code `VERIFIED_OPENAI_MODELS_REQUIRED` stays stable for API and MCP clients; only its texts are neutral.

### Phase 2: done locally

ADR 0015.

**2.2–2.4 Spending authority**
- `ai_spend_policies` and its services:
  - `platform/ai/spend-policy.ts`: profiles, save, read view;
  - `spend-mandate.ts`: dual read, legacy budget subset only;
  - `reserve` enforces the platform record.
- The route `GET /ai-spend-policy` and the owner action `ai-spend-policy` (access matrix: two new owner-only rows, no existing cell changed; OpenAPI regenerated).
- MCP `ai_spend_policy_get/update`.
- Rollback flag `ORBIT_SPEND_POLICY_SOURCE`.
- Backfill `scripts/ai-spend-policy-backfill.ts` (dry run by default).
- Readiness, attention, dashboard, Finance pre-checks and Knowledge evaluation tools read the mandate.
- `marketing_policy_update` refuses budget fields once a platform record exists (`SPEND_POLICY_ON_PLATFORM`).

**2.5 Approval requirements**
- `ActionDefinition.requires`. Marketing types need the publishing policy; every other type needs the spend mandate, which is the same or a superset of today.
- Requests store `spendPolicy`.
- Relaxed after review (E-5): `support_update_ticket`, `knowledge_propose_fact`, `knowledge_withdraw_fact`. None spends, and each still needs the owner's approval.

**2.6 Settings → AI & budget**
- The tab is renamed and holds the spending authority with profiles, status, spend and validity.
- The Marketing editor shows the budget and saves it unchanged.
- `?section=policy` opens AI & budget when Marketing's policy is not offered.
- The overview's spend link points there.

**2.7 Readiness**
- The provider is used only when its module is enabled.
- Without Marketing, the platform's AI readiness applies.
- Not moved: `project_readiness_get` stays a Marketing tool, because it explains Marketing's readiness.

**2.8 Telegram**
- `ORBIT_TELEGRAM`; empty follows `ORBIT_AGENTS`.
- The bot routes have their own early 404.

**2.9 Approval inbox: no move needed.**
- "Approvals" lists Marketing content.
- ActionRequests of every module are the platform's "App approvals" (`decisions`), which needs no module.
- Only the comment was corrected.

**2.10 `ORBIT_MARKETING` (default `true`)**
- `available` hook.
- Central availability check for routes, actions and collections, with module-specific codes (`unavailableCode`).
- Compose, `.env.example` and the Compose check updated.

**2.11 Project mode**
- Every API reader of `Project.mode` was already Marketing code.
- The platform overview shows the mode only while Marketing is on.
- `savePolicy` still mirrors the mode into the project field; the field stays readable.

**Open (phase 3):**
- E-1b key rule.
- One AI save path.
- UI consolidation.
- Generic provider budgets.
- Image and embedding purposes (E-8, E-9).
- Moving the flat platform files.
- Removing the legacy fallback (3.8, after the backfill and evidence).

### Phase 3: done locally (except 3.7 and 3.8)

**3.1 Key rule v2** behind `ORBIT_AI_KEY_RULE_V2` (default off).
- Runtime, settings view and readiness follow the same rule.
- A first save needs an own or granted key.
- Dry run: `scripts/ai-key-rule-report.ts`, read-only and without keys.

**3.5 Claude-only projects**
- Without an OpenAI key, documents are not embedded and nothing is reserved.
- This fixes a source of "outcome unknown" reservations: before, the embedding job reserved and marked the call as transmitted, and only then failed for the missing key.
- Search falls back to full text. Queueing, reindexing and evaluation refuse with `EMBEDDING_KEY_REQUIRED`.
- `capabilities` (text, search, images) appear in the settings and in `ai_models_get`.

**3.4 Provider budgets** for OpenAI too, inherited from organization or system AI profiles. A budget panel per provider.

**3.2 One save path:** `ai-configure` with the sections `models` and `providers`.
- The web settings and the MCP model update use it.
- Old actions stay as aliases.
- Access matrix: one new owner-only row.

**3.3 One place for AI settings**
- The overview and Integrations link to AI & budget instead of opening their own copy of the OpenAI dialog.
- Neutral labels in the model dialog.
- Marketing's section is "Publishing rules".
- The AI profile editor shows Claude's tiers and provider budgets and no longer drops the fields it does not show.
- E2E specs adjusted, not run.

**3.6 Files moved** to `platform/`, with re-exports at the old paths:
- `action-requests.ts` → `platform/governance/`
- `chat.ts`, `chat-runner.ts` → `platform/assistant/`
- `agents/tools/registry.ts` → `platform/agents/tools/`
- `runtime.ts` → `platform/jobs/runtime-health.ts`

Importers still use the old paths, so existing test mocks keep working.

**Not done, on purpose:**
- **3.7 Integrations admin, Slack transport and Drive: closed, stays in Marketing** (Mario, 2026-10-25). The code contradicts the plan's assumption:
  - `integrations_get/configure/verify` manage Postiz (channels, posting times, write verification) and Matomo (site). Both are Marketing's own providers, which Marketing already contributes to the platform (`marketingConnections`).
  - Moving the tools would make the platform know Postiz details, which the import rules forbid. A clean version would need a generic platform tool collecting module-contributed views and actions, and it would rename the tools for MCP clients.
  - Slack is used only for Marketing's approval digest.
  - Hiding these tools is correct when Marketing is off.
  - Drive stays open until decision Q-06.
- **3.8 Legacy fallback: removed by default** (Mario, 2026-10-25, after the production backfill gave all three projects a platform record).
  - `ORBIT_SPEND_POLICY_SOURCE` has three values: `platform` (default, strict), `fallback` (the transition behaviour, first rollback level) and `marketing`.
  - In strict mode `reserve` also refuses a Marketing caller's own budget without a platform record.
  - The suites run in `fallback` mode, set in `tests/setup.ts`; dedicated tests check the strict default.
- **Marketing branches in `action-requests.ts`** (`content_packages` lookup, `assignment.confirm` payload, channel directories) stay until module hooks for request descriptions exist.

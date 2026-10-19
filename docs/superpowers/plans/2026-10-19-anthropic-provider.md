# Anthropic Claude as a second AI provider — architecture report and implementation plan

**Date:** 2026-10-19. **Branch:** `claude/anthropic-claude-integration-5cfce4` (worktree, from `main` at `10c2b0b`). **Status:** plan written before implementation; implementation follows in the same branch.

**Goal:** EDS Orbit calls the Anthropic Claude API (Messages API, official SDK `@anthropic-ai/sdk`) as a second runtime text provider next to OpenAI, through the existing Orbit Core AI layer, with central model management, task routing, per-call usage and cost accounting, a provider budget for the monthly Claude credit (100 USD, thresholds 75/90/95) and an admin surface. OpenAI keeps working unchanged; images and embeddings stay on OpenAI.

## 1. Architecture report (Phase 1)

### 1.1 What exists

| Area | Where | Finding |
| --- | --- | --- |
| Provider SDK | `packages/ai/src/index.ts` | `openai` 7.25.0 only. Five entry points: `generate` (draft, strict JSON), `streamChat` (Orbit Chat, streaming + tools), `respond` (one non-streaming step with tools, hosted `web_search`, strict JSON), `embed`, `generateImage`/`generateImageWithReferences`. Every client is `maxRetries: 0`, `store: false`, 45–120 s timeouts. |
| Runtime port | `apps/api/src/modules/agents/runtime/port.ts`, `legacy-responses.ts` (ADR 0005) | Provider-neutral `AgentRuntime` loop with `BudgetedModel` (reserve → transmit → settle) and `ToolHost`. The item shapes inside the loop (`function_call`, `function_call_output`, `message`, `tool_search_*`) are OpenAI Responses shapes used as Orbit's internal conversation format. |
| Callers | `modules/chat-runner.ts` (chat), `modules/marketing/agents/specialists/runner.ts` (strategy, research, analytics, review), `modules/support/ai.ts` (triage, draft reply), `modules/marketing/pipeline/generation.ts` (drafts) | All resolve a route per task class, estimate, reserve, mark transmitted, call, settle, record spans. None imports the SDK directly except `chat-runner.ts` (type import) and `specialists/runner.ts` (`zodTextFormat` helper). |
| Routing | `packages/ai/src/routing.ts` | Nine task classes; explicit task route (owner) or legacy tier (`fast`/`standard`/`quality`/`escalation`); the model must be in the verified allowlist (fail closed). |
| Cost | `packages/ai/src/cost.ts` (ADR 0003) | Owner-maintained rate card in USD micros per million tokens with cache read/write rates and web-search fees; `estimateCost` (pre-transmission, conservative) and `computeCost` from normalized usage; unknown cache split settles at the highest rate. |
| Budget | `platform/ai/budget.ts`, `spend-mandate.ts` | Per-project reservations in `BudgetReservation` under the project advisory lock (`scoped`), daily/monthly/per-run limits from the active marketing policy; in-flight and unknown amounts count. |
| Configuration | `platform/ai/openai-configuration.ts` | One `Entity` of kind `openai_configuration` per project: encrypted keys (`CREDENTIAL_KEY`), verified models, rate card, tier and task routes, image settings. Its entity version is the route version; runs stop before their next paid call when it changes. Environment variables are a bootstrap fallback only. |
| Telemetry | `platform/ai/telemetry.ts`, `ai-usage.ts` | `AgentRun`/`AgentSpan` per run and call; `GET /ai-cost` groups reservations by day, category, model, task class or mission. |
| Admin UI | `apps/web/src/components/management.tsx` | "Configure OpenAI" modal (keys, verified models, task routes, tiers, image, rate card) in Settings → Integrations; AI runs in Operations; month spend on the marketing overview and the attention status. |
| Tenancy | `packages/db` | FORCE RLS by workspace and project; every AI read and write runs in `scoped()`. No workspace-level configuration store exists. |

### 1.2 Conclusions

1. The provider abstraction exists in substance (runtime port, budgeted model, task-class routes, rate card, reservations). What binds Orbit to OpenAI is `packages/ai/src/index.ts` and the Responses item shapes. The right extension is a **provider adapter inside `packages/ai`** that keeps the public functions, types and item shapes, so no caller is rewritten.
2. The configuration entity already is a model registry (verified models + rate card + routes). It is extended, not replaced. Renaming the entity kind would be a data migration for no gain.
3. Budgets are per project by design (RLS, advisory lock). The Claude credit is per Anthropic account; Orbit can only enforce it per project. With one production project this is exact; with several, the owner splits the credit across projects (documented).
4. No schema migration is needed: the provider of a reservation is derived from its stored `model` through the model registry (fallback: `claude-*` prefix). Deployment is code-only.

### 1.3 Verified Anthropic facts (official docs, read 2026-10-19)

- Model IDs (Claude API): `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`; 1M context, 128K max output, adaptive thinking (always on for Opus 5.5), default effort `medium` (Haiku 5.5, Opus 5.5) / `high` (Sonnet 5.5). Source: https://platform.claude.com/docs/en/about-claude/models/overview
- Pricing per million tokens (USD): Haiku 5.5 input 0.10 / 5m cache write 0.125 / cache read 0.01 / output 0.50 (prompts up to 100k tokens; 5x above); Sonnet 5.5 2 / 2.50 / 0.10 / 10; Opus 5.5 4 / 5 / 0.20 / 20. Web search 10 USD per 1,000 searches plus the result tokens as input. Source: https://platform.claude.com/docs/en/about-claude/pricing and the web search tool page.
- Usage object: `input_tokens` is the **uncached** remainder; total prompt = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Thinking tokens are inside `output_tokens` (`output_tokens_details.reasoning_output_tokens` is informational).
- Structured outputs: `output_config.format = { type: "json_schema", schema }` on all three models; strict mode rejects `minLength`/`maxLength`/numeric bounds and most `format` values (400). Strict tools: `strict: true` with `additionalProperties: false` and `required`.
- Forced `tool_choice` (`any`/`tool`) returns 400 on Opus 5.5 and Sonnet 5.5; Orbit never forces a tool.
- Assistant prefill is rejected; Orbit never prefills.
- Refusals: HTTP 200 with `stop_reason: "refusal"` and `stop_details`; the request is billed.
- No API returns the remaining prepaid credit. The Usage and Cost Admin API (`/v1/organizations/cost_report`, admin key, organizations only, ~5 min delay) reports historical cost; it is not available to individual accounts. The credit balance therefore stays a manually verified value.

## 2. Decisions for this plan (defaults chosen by the implementer; Mario can overrule)

| # | Decision | Why |
| --- | --- | --- |
| D-A1 | One adapter per provider inside `packages/ai/src/providers/` (`openai.ts`, `anthropic.ts`); the public functions `generate`, `streamChat`, `respond` dispatch on the route's provider and keep their signatures. The Responses item list stays Orbit's internal conversation format; the Anthropic adapter converts items ↔ Messages API blocks and back. | No caller changes, the runtime port keeps working, tests that mock `packages/ai` keep working. |
| D-A2 | `streamChat` returns the Responses stream subset the chat runner reads (`response.output_text.delta`, `response.completed` with the usage in Responses shape, `response.incomplete`, `response.failed`) from both adapters; the Anthropic adapter maps its events and stop reasons onto it. (Amended during implementation: this keeps the chat runner and the seven test suites that mock `streamChat` unchanged.) | The internal conversation format is the Responses shape (D-A1); the stream format follows it. |
| D-A3 | The provider of a model comes from the model registry (`models[id].provider`), else from the `claude-` prefix (Anthropic), else OpenAI. | Explicit where configured, safe default otherwise. |
| D-A4 | The project AI configuration (entity kind `openai_configuration`, unchanged) gains `anthropic.encryptedApiKey`, `models` (display name, provider, enabled, capabilities), `defaultProvider`, `tierRoutes.anthropic` (fast/standard/quality), `providerBudgets.anthropic` and `fallback`. A new owner action `ai-provider-configure` saves these fields; `openai-configure` is unchanged. Both bump the version (= route version), as every save does today. | No migration, no second entity, the existing route-version invalidation covers both. |
| D-A5 | The Anthropic key, verified models and rate card are owner-entered. Orbit ships a **dated suggestion** (`anthropicCatalog`, verified 2026-10-19 with source URLs) that the UI can prefill; nothing is saved without the owner's save. `ANTHROPIC_API_KEY` is an environment bootstrap fallback like `OPENAI_API_KEY`. | Spec: IDs and prices must not be hard-wired unverified; existing pattern. |
| D-A6 | Provider budget per project: `monthlyMicros` (100 USD), `warnMicros` (75), `warn2Micros` (90), `stopMicros` (95), billing period = monthly from an `anchorDay` (1–28, UTC; default 1), optional `credit` note (`amountMicros`, `verifiedAt`) shown as manually verified. Enforced inside `reserve` for every reservation whose model belongs to that provider, counted like the policy budget (settled at settled, open and unknown at reserved). | Covers chat, agents, support, drafts and parallel calls through the existing lock; no caller can bypass it. |
| D-A7 | Fallback to OpenAI only when the Anthropic provider budget refuses a call **before transmission**, only when the owner saved `fallback.onProviderBudgetStop = "openai"` (default `"none"`), and only to the task's OpenAI route. A transmitted call is never retried on another provider. Fallback use is recorded in the span name and the reservation's model. | Spec: no silent paid fallback; the saved setting is the explicit approval. |
| D-A8 | Thresholds surface as attention items (`platform_provider_budget`, warning at 75 %, critical at 90 % and when stopped) and on the AI usage panel; no e-mail. | Reuses the attention system; stateless. |
| D-A9 | Admin UI: a new platform settings tab **AI** (owner) with Providers, Models, Budget and Usage & costs panels, reusing panels, `DataForm`, `Metric` and `Status`. The existing OpenAI modal stays for OpenAI keys, routes, tiers and the rate card. | Spec structure with the smallest new surface. |
| D-A10 | Anthropic request shape: `system` with `cache_control: ephemeral`, `max_tokens = route.maxOutputTokens`, `output_config.effort` from `reasoningEffort` (`none` is refused at save and call time: `ROUTE_EFFORT_UNSUPPORTED`), thinking omitted (adaptive default), no prefill, no forced tool choice, strict tools, `web_search_20260209` with `allowed_callers: ["direct"]` and `max_uses`, `maxRetries: 0`, 45/60 s timeouts. Thinking blocks are passed back unchanged within a turn. | Current API; fail closed on what the provider does not support. |
| D-A11 | Not billed (reservation settles at 0): HTTP 400, 401, 403, 404, 413, 422, 429 and 529 (`overloaded_error`) from Anthropic. Everything else after transmission stays `unknown`. A `refusal` or `max_tokens` stop is billed and fails the call with its usage. | Mirrors the OpenAI rule; 529 is documented as "not processed". |
| D-A12 | Tool search (`tool_search`, client-executed) stays OpenAI-only (`supportsToolSearch` is false for Claude). Images and embeddings stay OpenAI. | Spec: images on OpenAI; Orbit's embedding corpus is pinned to an OpenAI profile. |

## 3. Implementation plan

### Task 1: SDK and provider adapter (packages/ai)

- [x] `@anthropic-ai/sdk` 0.135.0 pinned at the workspace root (done; `pnpm-lock.yaml` updated).
- [x] `packages/ai/src/provider.ts`: `ProviderId`, `providerOfModel`, `providerModels`, catalog of suggested Anthropic models/prices with `verifiedAt` and sources.
- [x] `packages/ai/src/providers/anthropic.ts`: client, item ↔ block conversion (user/assistant/tool results, thinking and server-tool blocks preserved verbatim), tool conversion (strict, schema sanitizer for Anthropic strict mode), hosted web search mapping and synthetic `web_search_call` items with sources, usage normalization, stop-reason handling, `generate`/`respond`/`streamChat` implementations.
- [x] `packages/ai/src/providers/openai.ts`: the existing implementations moved unchanged; `streamChat` maps Responses events to the neutral events.
- [x] `packages/ai/src/index.ts`: dispatch by provider; `isRejectedRequest` covers both SDKs; `rejection.ts` extended.
- [x] Unit tests with a mocked SDK: conversion, usage, cost, rejection, refusal, effort mapping, schema sanitizer, streaming.

### Task 2: Configuration, routing, budget

- [x] `routing.ts`: `resolveRoute` honours `defaultProvider` + `tierRoutes.anthropic` for the tier fallback; `reasoningEffort: "none"` refused for Anthropic models.
- [x] `openai-configuration.ts`: new fields, `saveAiProviderConfiguration`, `runtimeOpenAiConfiguration` returns the Anthropic key and budgets, public view reports provider status and never a key.
- [x] `budget.ts`: provider budget check in `reserve` (period from `anchorDay`), `providerPeriodSpend`, `providerBudgetStatus`.
- [x] Fallback helper `planCall` used by chat, specialists, support and generation.
- [x] `config`: `ANTHROPIC_API_KEY` optional; `.env.example`, `docker-compose.yml`, compose check.
- [x] Integration tests: configuration round trip (owner only, no key echoed), provider budget stop with parallel reservations, fallback on/off, route switch to a Claude model in chat and support with mocked adapters.

### Task 3: Callers and telemetry

- [x] `chat-runner.ts`: neutral stream events, span names per provider, `MODEL_REFUSAL` handling.
- [x] `specialists/runner.ts`, `support/ai.ts`, `pipeline/generation.ts`: `planCall`, provider span names; no behaviour change for OpenAI routes.
- [x] `ai-usage.ts`: `groupBy=provider`; `GET /ai-budget` (provider budget status).
- [x] Attention items for the provider budget.

### Task 4: Admin UI

- [x] Settings tab **AI**: providers (status, Anthropic key form, default provider), models (table + "prefill suggested Claude models" into the OpenAI modal's fields), budget form, usage and costs (today, period, by provider/model/task class, budget gauge, credit note).
- [x] Web tests: the owner tab in the settings navigation (the panels render through existing primitives; no rendering test of their own).

### Task 5: Documentation, smoke script, final checks

- [x] `docs/MODEL_ROUTING.md`, `docs/API_CONTRACT.md`, `docs/OPERATIONS.md`, `docs/CONFIGURATION_PARITY.md`, ADR 0003/0005 addenda, `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md`, `.env.example`.
- [x] `scripts/anthropic-smoke.ts`: opt-in live check (one Haiku call, max 64 output tokens, prints usage and cost; never run in CI). Not run: no key in the local environment.
- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test` (worktree database), `next build --webpack`, compose check, secrets check.

## 4. Risk, environment, profile

- **Risk:** high (external provider with costs and data transfer; budget enforcement; owner-only configuration). Environment: local; no production change, no migration, no key copied. App profile: `ai-agent-app` primary, `backend-api`, `fullstack-saas` for the owner settings, `web-frontend` for the tab.
- **Threat model:** keys are encrypted with `CREDENTIAL_KEY`, never returned; prompts and evidence leave the host to Anthropic after the same mandate, budget and rights checks as for OpenAI (no new data class); tool calls run through the existing registry, role and permission checks; no automatic retry of a transmitted call; strict tool schemas; untrusted content stays data (same instructions).
- **Rollback:** code-only deploy; redeploy the previous image. Saved Anthropic fields in the configuration entity are ignored by the previous code (unknown keys are not read). Routes pointing at Claude models would fail closed with `MODEL_CAPABILITY_NOT_VERIFIED` on the old build only if the owner also removed them from the verified list; otherwise the old build would send them to OpenAI, which refuses them (`MODEL_REQUEST_NOT_ACCEPTED`, unbilled). Before a rollback, point the routes back at OpenAI models.

## 5. Known limitations (to be stated in the final report)

- Credit balance is manual; no live synchronization exists for this account type.
- Provider budget is per project; several projects sharing one key need the credit split by the owner.
- Dynamic web-search filtering, batch API, 1-hour cache TTL, task budgets, fast mode and the Admin cost report are not used.
- Haiku 5.5 long-context pricing (prompts over 100k tokens) is unreachable under Orbit's input limits (≤ 64 KB per request) and not modelled in the rate card.
- Web search combined with structured outputs on Claude is verified only by the smoke test, not by the mocked tests.

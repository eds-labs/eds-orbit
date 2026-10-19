# ADR 0010: Second AI provider (Anthropic Claude) behind the shared AI layer

## Status

Implemented 2026-10-19 on branch `claude/anthropic-claude-integration-5cfce4`, from the request "EDS Orbit – Anthropic Claude Integration & AI Provider Management". Plan and architecture report: `docs/superpowers/plans/2026-10-19-anthropic-provider.md` (decisions D-A1 to D-A12).

## Context

Every Orbit module calls a model through `packages/ai` (`generate`, `streamChat`, `respond`) and the `AgentRuntime` port (ADR 0005) with per-call reservations (ADR 0003) and owner-maintained routes (MODEL_ROUTING.md). All of it was bound to the OpenAI Responses API. EDS Digital Labs receives a monthly Claude API credit that Orbit should use for its agents, with transparent, enforced costs, while OpenAI keeps working and stays the provider for images and embeddings.

## Decision

1. **Adapters inside `packages/ai`, not a new runtime.** The public functions keep their signatures; the route's model decides the provider (`providerOfModel`: owner registry, else the `claude-` prefix). The Responses item list the runtime port already uses stays Orbit's internal conversation format; the Anthropic adapter converts it to Messages API blocks and back (thinking and server-tool blocks verbatim, tool results joined in one user message). Callers, tests that mock `packages/ai`, budget, telemetry and the approval and tool checks are unchanged.
2. **One configuration entity for both providers.** `openai_configuration` keeps its name and gains the provider fields (`ai-provider-configure`); its version stays the route version, so a save still stops runs before their next paid call.
3. **No migration.** The provider of a reservation is derived from its stored model; deployment is code-only.
4. **Prices and model ids stay owner data.** A dated suggestion (`anthropicCatalog`) can be applied with one click but is never a runtime default.
5. **The credit is a provider budget per project** enforced in `reserve` (stop threshold; warnings as attention items; billing period from an anchor day). The credit balance is manual, because no API returns it for this account type.
6. **Fallback to OpenAI only before transmission, only when the owner saved it.** A transmitted call is never retried on another provider; refusals and cut-offs are billed and not retried.
7. **What the adapter refuses instead of imitating:** client-executed tool search, the effort `none`, unsupported items (`PROVIDER_FEATURE_UNSUPPORTED`, `ROUTE_EFFORT_UNSUPPORTED`).

## Alternatives

- A provider-neutral conversation format of its own (new types, every caller rewritten): more churn, same behaviour.
- A workspace-level budget table: exact across projects, but a migration, a new RLS classification and cross-project reads; deferred until a second project shares the key.
- Managed Agents or the Anthropic tool runner: hosted loops conflict with Orbit's reserve → transmit → settle contract and the no-retry rule.

## Consequences

Any module can route a task class to a Claude model by configuration. Costs, budgets and telemetry work the same for both providers; Operations shows `messages.*` spans next to `responses.*`. Haiku's long-context prices (prompts over 100k tokens) are unreachable under Orbit's request limits and not modelled. Dynamic web-search filtering, batch, the 1-hour cache, task budgets and fast mode are not used yet. A third provider adds one adapter and one registry value.

# ADR 0006: Agent state and data retention

## Status

Accepted by Mario, 2026-09-30 (alignment plan decision D2). Revisit when Orbit has users other than Mario, customer data or personal data beyond the owner account.

## Context

OpenAI can hold agent state in several places: stored responses (`store: true`, 30 days), `previous_response_id` chains, the Conversations API (kept until deleted), hosted Agents API sessions and SDK traces exported to OpenAI. Orbit currently sends `store: false`, keeps chat history in PostgreSQL and exports no traces. Orbit is used only by Mario; he decided that EU data residency and zero data retention are not requirements at this stage.

## Decision

1. PostgreSQL remains the only authoritative store for knowledge, work state, approvals, costs, sessions and run state. This is an architectural rule, not a privacy rule: budget and approval records must be joinable with runs, sessions must be rebuildable from business state, and provider changes must not lose history.
2. Four context layers stay separate:
   - persistent project knowledge (facts, sources, marketing profile, brand, memory rules, insights) — authoritative;
   - durable work state (missions, content, approvals, jobs, research notes) — authoritative;
   - agent sessions (messages, run state, versioned summaries) — derived and disposable;
   - task context (evidence pack, tool outputs of one run) — ephemeral, recorded as hashes and references.
3. Anything a later run must rely on is written as a durable entity with evidence references, never left only in a transcript or model context.
4. `store` becomes a configuration value, default `false`; `true` is allowed for debugging in the OpenAI dashboard. Conversations and `previous_response_id` are not used as state.
5. OpenAI trace export is allowed as a secondary sink and is a configuration switch; Orbit's own trace store always receives every span.
6. Background mode is not needed because the worker already runs asynchronously.

## Alternatives

Using the Conversations API or hosted sessions as the state store would reduce local code but split the truth between two systems and tie sessions to one provider.

## Consequences

Orbit keeps full control over retention and rehydration. When the user base changes, only configuration defaults (`store`, trace export) need to change, not the architecture. Approved text still leaves the host for OpenAI, as documented in `MODEL_ROUTING.md`.

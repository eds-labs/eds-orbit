# ADR 0005: Agent runtime

## Status

Accepted by Mario, 2026-09-30, as part of the [OpenAI agent platform alignment plan](../OPENAI_AGENT_PLATFORM_ALIGNMENT_PLAN.md) (decision D1). Adoption of the SDK beyond the spike depends on the go/no-go criteria below.

## Context

Orbit Chat runs a hand-written Responses API tool loop (`apps/api/src/modules/chat-runner.ts`) with six model calls, eight tool calls, per-call budget reservations and crash-safe `outcome_unknown` handling. Orbit will gain more tools, a research capability, approval-resumed runs and tracing. OpenAI now offers three options: the plain Responses API, the TypeScript Agents SDK (`@openai/agents` 0.18.0, pre-1.0, runs in Orbit's process) and the hosted Agents API (public beta since 2026-09-29, sessions hosted by OpenAI, best-effort usage, no scheduling).

## Decision

1. Orbit introduces an internal `AgentRuntime` port. Business modules depend on the port, never on an SDK type.
2. The first adapter candidate is the Agents SDK, pinned to an exact version and executed in the worker. A spike must meet all criteria before it replaces the custom loop:
   - G1: a custom model wrapper (`BudgetedModel`) reserves before and settles after every model request; the underlying client keeps `maxRetries: 0`.
   - G2: a crash after transmission yields `outcome_unknown` and no second paid request.
   - G3: run state is persisted per turn in PostgreSQL; approval decisions are consumed atomically and cannot be replayed across restarts.
   - G4: every span reaches Orbit's PostgreSQL trace processor; OpenAI trace export is a configuration switch.
   - G5: turn, tool-call, input-size and cancellation limits match the current contract.
   - G6: measured code reduction or added capability at equal size.
   - G7: exact pin, clean dependency audit, license recorded.
3. If G1–G4 fail, the custom loop stays and receives the tool-registry, strict-schema and caching changes from ADR 0007.
4. The single-shot draft generation pipeline stays on the plain Responses API. It is a deterministic workflow, not an agent loop.
5. The hosted Agents API is not used as the runtime now. Residency is not a blocker (ADR 0006), but best-effort usage conflicts with exact budget settlement, it has no scheduling and it is one day old. Re-evaluate after the operator migration.
6. Topology: one Orbit Operator agent and at most one specialist (Research) exposed as an agent-as-tool. Publishing, generation, review, analytics import and approvals remain deterministic code. The Responses multi-agent beta is not used.

## Alternatives

- Keep the custom loop permanently: lowest dependency risk, but Orbit would rebuild approval resume, tracing hooks, tool search and MCP clients itself.
- Hosted Agents API: least runtime code, but business state and usage accounting would move to a beta service outside Orbit's journal.
- A multi-agent tree (strategist, writer, creative, publishing, analytics agents): more model calls and context copies with no safety gain; publishing must never be model-owned.

## Consequences

The SDK becomes an exchangeable adapter. SDK upgrades are isolated to one module and covered by the existing chat-runner integration tests. Budget, policy, approval and audit remain Orbit's responsibility, as required by master specification §5.

## Addendum 2026-10-02: spike result

The spike ran the SDK (`@openai/agents-core` 0.18.0) behind the `AgentRuntime` port with Orbit's budgeted model and tool host. G1, G2, G5 and G7 were met (G5 only with adapter fixes), G4 brought no gain, G3 was not demonstrated and G6 was not met. Decided by Mario on 2026-10-02: **no-go**; the custom loop stays behind the port, and the spike branch is not merged. Evidence: [agents-sdk-spike-2026-10-02](../evidence/agents-sdk-spike-2026-10-02.md).

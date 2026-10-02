# OpenAI Agents SDK spike (ADR 0005, S2) — 2026-10-02

**Result: NO-GO for replacing the legacy loop now** (confirmed by Mario on 2026-10-02). The port (S1) stays; the legacy Responses loop stays the only production adapter.

Branch `claude/orbit-core-s2-sdk-spike`, spike code `38296aa`, based on S1 (`cd71c7d`). Local only, Node 24.18.0, isolated PostgreSQL/Redis, mocked provider. No paid call, no provider contact by the SDK.

## Candidate

- `@openai/agents-core` 0.18.0 (current `latest` of `@openai/agents` is 0.18.0), exact pin, MIT. Only the core package: Orbit supplies its own model, so the OpenAI provider and Realtime packages are not needed.
- Lockfile: +6 packages (`@openai/agents-core`, `@standard-schema/spec`, `debug`, `ms`, `supports-color` and the existing `openai` 7.25.0 satisfying `^7.2.0`). `pnpm audit --audit-level high`: no known vulnerabilities.

## Design under test

The SDK runner drives the turn; Orbit keeps everything it must own. The SDK `Model` is a bridge to Orbit's `BudgetedModel` (reservation, transmission, settlement, spans), so the SDK never calls OpenAI. SDK tools only dispatch to Orbit's `ToolHost`. Responses API items travel unchanged in `providerData`, so the host sends exactly what the legacy loop sends, reasoning items included.

Adapter work needed to keep Orbit's behaviour:

1. `toolExecution.maxFunctionToolConcurrency: 1`: the SDK runs all tool calls of a turn concurrently by default.
2. `errorFunction: null` per tool: by default the SDK turns tool errors into model-visible text instead of failing the turn.
3. Unwrapping `ToolCallError`/`AgentsError`: otherwise a retrieval cost error became `failed` instead of `blocked`.
4. Registering every registry tool name and routing invented names through `toolNotFoundBehavior: "return_error_to_model"` plus a formatter that calls the `ToolHost`: the SDK must know tool names in advance, and an unknown call otherwise failed inside the SDK without Orbit's span or `CHAT_TOOL_NOT_ALLOWED` answer.
5. Tool-call and model-call limits enforced in the model bridge in the legacy order; `maxTurns` is only a backstop.
6. Tracing disabled (`tracingDisabled`), retries explicitly 0, `getStreamedResponse` unsupported (the host streams inside the budgeted call).

## Go/no-go criteria

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| G1 | Reserve before / settle after every model request; `maxRetries: 0` | Met (host-owned) | The SDK only calls the bridge; SDK model retries default to 0 and are set to 0. Chat-runner reservation and settlement tests pass under the SDK adapter. |
| G2 | Crash after transmission -> `outcome_unknown`, no second paid request | Met (host-owned) | Crash-recovery and incomplete-response tests pass under the SDK adapter. |
| G3 | Run state persisted per turn; approvals consumed atomically, no replay across restarts | Not demonstrated | SDK `RunState` is not persisted. Orbit's approvals are executor-consumed `ActionRequest`s (PR1) outside the agent run, so no SDK interruption/resume is used or tested. |
| G4 | Every span reaches Orbit's trace store; OpenAI export is a switch | Equal, no gain | Orbit's host spans are unchanged; SDK tracing is off. No SDK trace processor was needed or added. |
| G5 | Turn, tool-call, input-size and cancellation limits match | Met with adapter work | Contract cases 10/10 for both adapters; chat-runner, chat and registry suites 63/63 with `ORBIT_AGENT_RUNTIME=openai_agents_sdk` and with the legacy default. Needed items 1–5 above. |
| G6 | Measured code reduction or added capability at equal size | Not met | SDK adapter 194 lines vs legacy adapter 33 lines, plus 6 packages. Request building, tool schemas, tracing and retries of the SDK are all bypassed, so no SDK capability is used. |
| G7 | Exact pin, clean audit, license recorded | Met | See Candidate. |

ADR 0005 keeps the custom loop if G1–G4 fail; G3 is not demonstrated and G6 is not met. Full suite on the spike branch: `pnpm test` 606/606 in 60 files; `pnpm lint` and `pnpm build` pass.

## Recommendation

- Keep the S1 port and the legacy adapter. Do not merge the spike branch or the dependency.
- Re-evaluate when Orbit needs a capability the SDK provides and Orbit does not: an agent-as-tool research specialist (alignment Phase 5), Realtime voice (J4), or approval interrupts that resume an agent run. Reuse this adapter and its contract cases as the starting point; the item bridge and the four behaviour fixes above are the known costs.

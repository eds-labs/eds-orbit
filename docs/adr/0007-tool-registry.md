# ADR 0007: Agent tool registry, MCP and tool search

## Status

Accepted by Mario, 2026-09-30, as part of the alignment plan.

## Context

Chat tools are hand-written JSON definitions with `strict: false` and separate zod validation (`chat-tools.ts`, `chat-runner.ts`). A mismatch between the model-facing schema and the server contract caused the failed Phase 6 proposal on 2026-09-27. Orbit will add tools for content, brand, calendar, analytics, Drive, research and proposals. OpenAI offers strict function schemas, tool search with deferred loading and namespaces (models from `gpt-5.4`), hosted MCP, built-in tools and Skills.

## Decision

1. Every agent tool is declared once in a registry: name, namespace, description, zod input and output schemas, risk class, required roles, required capability/policy/connector, cost category and `deferLoading`.
2. Model-facing JSON schemas are generated from zod and sent with `strict: true`. Tool outputs are validated and size-capped before they reach the model.
3. Agents only receive read (`R0`), internal-write (`W0`) and proposal (`P`) tools. Side effects run in deterministic executors after an `ActionRequest` decision (ADR 0008).
4. Tool availability is computed per run from role, active policy and verified connector capability, and enforced again at execution.
5. Orbit-owned data uses internal function tools, not hosted MCP, because hosted MCP calls would bypass per-transaction RLS scope, role checks and the budget journal. The registry shape stays MCP-compatible so a later read-only Orbit MCP server needs no tool rewrite. That server remains a non-goal until Mario lifts it.
6. Tool search is enabled only when the operator exposes more than about 15 tools or about 3,000 tokens of tool definitions. It then runs client-executed, returning only tools the run may use. Namespaces stay under 10 tools each.
7. Built-in tools: hosted `web_search` is allowed inside the bounded research tool with its own budget category. `file_search`, the built-in image tool and hosted Drive connectors are not used, because Orbit's retrieval, image confirmation and root-confined Drive access carry rights, evaluation and cost controls those tools lack.
8. OpenAI Skills are not used; channel and content-type instructions become versioned, owner-reviewed Orbit playbooks.

## Alternatives

Keeping hand-written schemas avoids a generator but repeats the failure class seen in Phase 6. Exposing Orbit through hosted MCP would be quicker for external clients but weaker for tenancy and cost control.

## Consequences

One schema source per tool, strict calls, and a clean path to tool search and a future MCP server. Adding a tool requires registry metadata, tests for role/capability filtering and output caps.

## Addendum 2026-10-02: client-executed tool search implemented

- Trigger reached: with the Orbit Core tools the chat exposes 11 tools and about 7 KB of definitions, at the 7,000-byte guard.
- Implementation (`apps/api/src/modules/chat-runner.ts`, `agents/tools/registry.ts`), behind `ORBIT_TOOL_SEARCH` (default `false`) and only when the chat route's model is `gpt-5.4` or later (`supportsToolSearch`). The request carries the always-loaded core (`project_status`, `knowledge_search`, `propose_campaign`, `request_content_package`, `package_status`) plus `{type:"tool_search", execution:"client"}` with a `goal` parameter. Deferred (`deferLoading: true`): `approved_assets`, `analytics_memory`, `revise_package_deliverable`, `recent_content`, `schedule_options`, `propose_schedule`.
- Orbit answers each `tool_search_call` with a `tool_search_output` for the same `call_id`: strict function definitions marked `defer_loading`: every deferred tool the goal names exactly (since 2026-10-30, so one search can load a whole flow), else at most three tools whose name, namespace or description share goal words (at least half the best score), or every candidate when nothing matches. Candidates are only the deferred tools the user's role and features allow; execution still checks the role's full set, so a forged call stays refused. The search is deterministic and costs no model call. It counts toward the eight tool calls per run, and found definitions count toward the 32,000-byte input cap.
- The tool list stays the same for a whole run, so the cached prefix holds; found tools enter at the end of the input as the guide recommends. The core definitions are about 4.7 KB (guarded at 5,000 bytes); the full set with the flag off stays guarded at 7,000 bytes, so new tools still need the flag on in production once that guard is reached.
- With the flag off, or on a model before `gpt-5.4`, every offered tool is loaded as before and no route lookup is added.
- Not yet verified against the live API: enabling it in production needs one small paid check with the configured chat model, approved by Mario.
- Since the S1 runtime port (rebased 2026-10-06, ADR 0005) the turn loop that answers searches is `agents/runtime/legacy-responses.ts`; the search itself and its span stay in `chat-runner.ts` (`ToolHost.search()`).

## Addendum 2026-10-13: central Orbit MCP gateway (non-goal lifted)

Mario lifted the "Orbit MCP server" non-goal of decision 5 on 2026-10-13 and asked for a central MCP gateway for ChatGPT, ChatGPT dots and other MCP clients. The design is accepted with [ADR 0009](0009-modular-platform.md) (decisions AD-20 to AD-23); the details are in [`plans/orbit-modularization/09-mcp-gateway.md`](../../plans/orbit-modularization/09-mcp-gateway.md).

- **Rejected as before.** Decision 5 still holds for *hosted* MCP used by Orbit's own agents, because it would bypass RLS scope, role checks and the budget journal.
- **Why the gateway is consistent with decision 5.** It is the opposite direction: external clients call Orbit. Every call runs inside Orbit under the token's user, the project's RLS scope, the permission catalogue, module activation and the budget journal.
- **Exposure.** The gateway adapts this registry; it never defines its own tools. A tool is exposed only with an explicit `exposure.mcp` flag. Read (`R0`) and proposal (`P`) tools come first. Every consequential action is an `ActionRequest` decided in Orbit (ADR 0008), and hard floors are never exposed.
- **Placement and authentication.** An own `mcp` service built from the same image, served under `https://orbit.eds-labs.io/mcp`. Orbit is the OAuth 2.1 authorization server, with CIMD first, PKCE S256 and resource-bound tokens.
- **Prerequisites.** The gateway is roadmap Track M (WP-M1 to WP-M6), and it starts after the permission catalogue, the open registries, module activation and the knowledge services exist. Status 2026-10-17: WP-M1 (OAuth authorization server, consent and grants) is implemented locally behind `ORBIT_MCP_OAUTH`, default off, not deployed; no MCP endpoint exists yet (WP-M2).

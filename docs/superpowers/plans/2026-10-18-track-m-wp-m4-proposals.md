# Track M, WP-M4: MCP proposal surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP clients can propose an action that only an Orbit-side decision can carry out: the first proposal tool `marketing_assignment_propose`, the status tool `orbit_action_status`, per-grant proposal quotas, a central and a per-grant kill switch, all through ActionRequests marked `requestedBy: { kind: "mcp", … }`.

**Architecture:** Built from `main` (WP-M2 #165 and WP-M3 #169 merged). ActionRequests stay the only write path: an MCP proposal creates a pending ActionRequest of an explicitly MCP-proposable type; the owner decides in Orbit's approval inbox; the existing deterministic executor runs on approval. The gateway adds quotas and kill switches for `P_proposal` tools and a native status tool scoped to the grant's own requests. No business logic moves into the gateway.

**Tech Stack:** Fastify, MCP SDK 2.3.1, Prisma (`Entity` kind `action_requests`, auth-schema `McpGrant`/`McpGrantEvent`), Vitest.

**Spec:** `plans/orbit-modularization/09-mcp-gateway.md` §5.2, §6.1, §6.2, §7 and `07-roadmap.md` (WP-M4); ADR 0008 (action approvals).

## Risk, environment, profile

- **Risk:** high (write path for external agents). Mitigation: Orbit-side decision always required, allowlist of proposable types, quotas, kill switches.
- **Environment:** local; draft PR from `main`; gateway off in production; nothing runs until WP-M5.
- **App profile:** `ai-agent-app` primary, `backend-api`, `fullstack-saas` (owner controls), security rules.

## Decisions for this plan (controller rulings; report them in the PR)

| # | Decision | Why |
|---|---|---|
| D-M4-1 | First and only exposed proposal tool: `assignment_propose` (`marketing_assignment_propose`). `propose_campaign` (ChatProposal bound to a conversation), `request_content_package` (editor decider, not in the owner inbox, decider must be requester) and `propose_schedule` (package resolved by conversation) stay unexposed and are recorded as follow-ups. | Smallest safe set; the only P tool whose coupling to a conversation is a removable existence check and whose decision lands in the owner inbox. |
| D-M4-2 | `ActionDefinition.mcpProposable?: true` (default absent = not proposable); `createActionRequest` refuses `requestedBy.kind === "mcp"` for any type without it (`ACTION_TYPE_NOT_PROPOSABLE`, 403). Only `assignment.confirm` sets it. A test asserts no other registered type is proposable. | Hard floors and unreviewed types can never be created from MCP, independent of tool exposure. |
| D-M4-3 | `requestedBy` gains `{ kind: "mcp", userId, clientId, grantId, agentRunId: string \| null, argsHash }`. | Provenance for audit, status lookup, dedupe, revocation. |
| D-M4-4 | Idempotency: an MCP proposal with the same `grantId`, tool and `argsHash` that is still pending and unexpired returns the existing request instead of creating a new one (honours `idempotentHint: true`). | Retries after TIMEOUT or network errors must not duplicate proposals. |
| D-M4-5 | Proposal tool output: `{ status: "pending_approval", actionRequestId, assignmentId, expiresAt, approveUrl }` with `approveUrl = ${APP_ORIGIN}/p/<projectId>/approvals` (no per-request deep link exists). The assistant keeps its current output shape plus the same new fields only if harmless to its result schema; otherwise the MCP shape is built in the tool when `context.channel?.kind === "mcp"`. | `09` §6.1 shape; the assistant must not change. |
| D-M4-6 | URL-mode elicitation is **deferred** (WP-M5): ChatGPT/dots support is undocumented, legacy clients cannot receive it statelessly, and it needs an HMAC-protected `requestState`. Fallback = `approveUrl` + `orbit_action_status`. | `09` §6.2 fallback. |
| D-M4-7 | Stricter mode for MCP: every action type is already `approval_required` with a human decider (the strictest implemented mode); no `auto*` mode exists. Documented, no code. | ADR 0008 modes beyond `approval_required` are not implemented. |
| D-M4-8 | Quotas per grant: **20 proposals / hour** (in-process limiter with a per-rule window) and **100 / day** (counted from `McpGrantEvent` action `mcp.proposal` since the start of the UTC day); refusal = tool `isError` `PROPOSAL_QUOTA_EXCEEDED`, `retryable: false`. Deduplicated calls (D-M4-4) do not count. | `09` §7; daily count survives restarts. |
| D-M4-9 | Central kill switch: `ORBIT_MCP_PROPOSALS` (default `false`, compose-safe). While off, `P_proposal` tools are neither listed nor callable. Per-grant switch: owner or grant user can stop proposals for a grant (`PATCH /api/mcp-grants/:grantId { proposals: false }`) which removes `orbit:propose` from `McpGrant.scopes` and records `grant.proposals_disabled`; re-consent can grant it again (documented). No migration. | Central and per-grant control without schema change. |
| D-M4-10 | Revoking a grant or disabling its proposals cancels that grant's pending MCP ActionRequests (`cancelActionRequest`, reason recorded). | No orphaned proposals from a revoked client. |
| D-M4-11 | `TIMEOUT` and other transient failures are `retryable: false` for `P_proposal` and `W0_internal` tools. | A timed-out proposal may still complete. |
| D-M4-12 | `orbit_action_status` (native, R0): input `{ projectId, actionRequestId }`; returns `{ actionRequestId, actionType, status: "pending" \| "approved" \| "rejected" \| "consumed" \| "canceled" \| "expired", createdAt, expiresAt, decidedAt: string \| null, approveUrl }`; `NOT_FOUND` unless the request is in a granted project and `requestedBy.kind === "mcp"` and `requestedBy.grantId === principal.grantId`. No payload, hash, policy or user ids. | Clients poll only their own proposals; nothing internal leaves. |

## Global Constraints

- No MCP call causes an external side effect without an Orbit-side decision by a user holding the type's decider role; client-side confirmation never counts (AD-22).
- Only `mcpProposable` action types can be created with `requestedBy.kind === "mcp"`; hard floors (deletion, budget, governance, infrastructure) never.
- Every proposal re-checks grant, membership, module activation, the tool's permission, the `orbit:propose` scope, `ORBIT_MCP_PROPOSALS`, quotas — and the existing domain checks of the action (mandate, ORBIT_AGENTS, editor role).
- Audit: `action_request.proposed` (clientId, grantId, actionType, packageHash) in the project; `mcp.proposal` McpGrantEvent per created proposal; existing `mcp.tool_call` per call; argument values never stored.
- Status responses never contain payloads, hashes, policies or other users' ids.
- Compose-safe config (empty = unset), `docker-compose.yml` + `scripts/check-coolify-compose.mjs` + `.env.example`; English code and docs; new files in `scripts/boundaries.json`; no new dependency; no migration (stop and record if one becomes necessary).

## Review Focus

- **A forged or replayed decision** (stale `version`/`packageHash`, second approval, decision by an editor for an owner type) must not execute twice or at all → Task 2 test `mcp proposal: decide, replay and hash mismatch`.
- **The same proposal sent twice** (retry after TIMEOUT) → one ActionRequest → Task 1 test `mcp proposals are deduplicated per grant and arguments`.
- **A non-proposable type created with requestedBy mcp** (direct service call) → `ACTION_TYPE_NOT_PROPOSABLE` → Task 1 test `only proposable types accept mcp requesters`.
- **Status lookup of a human's or another grant's request by id** → identical `NOT_FOUND` → Task 3 test `action status is scoped to the grant`.
- **Grant revoked with pending proposals** → proposals canceled, decision impossible → Task 4 test `revocation cancels pending mcp proposals`.

---

### Task 1: ActionRequest contract for MCP proposals

**Files:** Modify `apps/api/src/modules/action-requests.ts`, `apps/api/src/modules/marketing/action-types.ts` (`assignment.confirm` gets `mcpProposable: true`), `apps/web/src/components/action-request-inbox.tsx` (requestedBy type; show "via <client host>" when kind is mcp); Create helper in `action-requests.ts` or `apps/api/src/platform/mcp/proposals.ts`; Test `apps/api/tests/mcp-proposals-contract.integration.test.ts`, web test for the inbox label.

**Interfaces (produces):**
- `requestedBy` union + `{ kind: "mcp", userId, clientId, grantId, agentRunId, argsHash }` (strict); `RequestedBy` type updated.
- `ActionDefinition.mcpProposable?: true`; `createActionRequest` throws `DomainError("ACTION_TYPE_NOT_PROPOSABLE", 403)` for mcp requesters on other types.
- `findPendingMcpProposal(tx, scope, { grantId, actionType, argsHash, now }): Promise<ActionRequestRow | null>` and creation audit `action_request.proposed` for mcp requesters.
- [ ] Tests first: union accepts/rejects shapes; non-proposable type refused; `assignment.confirm` accepted; registry-wide assertion that only `assignment.confirm` is proposable; dedupe finds pending unexpired same-grant same-args request and ignores expired/decided/other grant; inbox shows the client label.
- [ ] Implement; run action-request, marketing action-type, assignment and web inbox tests; commit `feat(actions): ActionRequests from MCP clients (WP-M4)`.

### Task 2: `assignment_propose` over MCP

**Files:** Modify `apps/api/src/modules/marketing/tools/assignment-tools.ts`, `apps/api/src/modules/marketing/agents/assignments.ts` (conversation optional for MCP; `requestedBy` from the channel); Test `apps/api/tests/mcp-proposal-flow.integration.test.ts`, existing assignment tests.

**Interfaces (produces):**
- `assignment_propose` gets `exposure: { assistant: true, mcp: true }`, a strict `outputSchema` (D-M4-5), and when `context.channel?.kind === "mcp"`: no conversation lookup, `conversationId` stored as null, `requestedBy = { kind: "mcp", userId: scope.userId, clientId, grantId, agentRunId: context.runId, argsHash }`, dedupe via Task 1 (returns the existing proposal without creating a new assignment), `mcp.proposal` McpGrantEvent on creation.
- Assistant path unchanged (same conversation check, same `requestedBy: agent`, same output for the assistant).
- [ ] Tests first (gateway, real WP-M1 tokens, `ORBIT_AGENTS` + `ORBIT_MCP_PROPOSALS` on, mandate seeded): end-to-end MCP proposal → pending request in the owner inbox list → owner approves via the decide route → assignment confirmed by the existing executor; Review Focus `mcp proposal: decide, replay and hash mismatch` (stale version/hash → `ACTION_REQUEST_STALE`, repeat approval idempotent and executes once, editor cannot decide owner type); assistant output unchanged (existing tests); no side effect before the decision (assignment stays draft, no runs scheduled).
- [ ] Implement; run; commit `feat(mcp): propose assignments from MCP clients (WP-M4)`.

### Task 3: Gateway — central switch, quotas, retryability, `orbit_action_status`

**Files:** Modify `packages/config/src/index.ts`, `.env.example`, `docker-compose.yml`, `scripts/check-coolify-compose.mjs`, `apps/api/src/platform/mcp/{visibility,adapter,errors,limits}.ts`; Create `apps/api/src/platform/mcp/native/action-status.ts`; Test `apps/api/tests/mcp-proposal-controls.integration.test.ts`.

**Interfaces (produces):**
- `ORBIT_MCP_PROPOSALS` (`"false"|"true"`, default `"false"`): P tools hidden from `tools/list` and refused on call (`MCP_TOOL_NOT_ALLOWED`) while off.
- Quotas (D-M4-8) enforced in the adapter for `P_proposal` registry tools before execute; dedupe hits do not count (the tool reports whether it created a request; count only creations).
- `timeoutResult`/transient failures `retryable: false` for P and W0 tools (D-M4-11).
- Native `orbit_action_status` (D-M4-12) with `ctx.setAuditProject(projectId)`.
- [ ] Tests first: flag off hides/refuses `marketing_assignment_propose` while read tools stay; 21st proposal in an hour → `PROPOSAL_QUOTA_EXCEEDED` (inject a small limit through the existing `rateLimits`/options seam); daily quota from seeded `mcp.proposal` events; dedupe does not consume quota; TIMEOUT on a P tool is `retryable: false`; Review Focus `action status is scoped to the grant` (human request, other grant, other project, malformed id → identical NOT_FOUND); status values incl. derived `expired`; no payload fields in the output (schema snapshot).
- [ ] Implement; run; commit `feat(mcp): proposal switch, quotas and action status (WP-M4)`.

### Task 4: Owner controls — stop proposals, cancel on revoke

**Files:** Modify `apps/api/src/platform/mcp-auth/{grants,routes,events}.ts`, `apps/web/src/platform/connect/connected-apps.tsx` (+ i18n); Test `apps/api/tests/mcp-oauth-revoke.integration.test.ts` (extend) or a new file, web test.

**Interfaces (produces):**
- `setGrantProposals(actor, grantId, enabled: false)`: same authorization as `revokeGrant` (grant user or workspace owner); removes `orbit:propose` from scopes; records `grant.proposals_disabled`; cancels the grant's pending MCP ActionRequests (D-M4-10). `PATCH /api/mcp-grants/:grantId` `{ proposals: false }` → 204; 404 with the flag `ORBIT_MCP_OAUTH` off. (Re-enabling only through re-consent.)
- `revokeGrant` also cancels the grant's pending MCP ActionRequests.
- Connected apps: a "Stop proposals" action (confirmation) shown when the grant has `orbit:propose`.
- [ ] Tests first: Review Focus `revocation cancels pending mcp proposals` (decision afterwards → `ACTION_REQUEST_NOT_PENDING`); stop proposals hides P tools for that grant on the next request and cancels pending ones; editor cannot stop another user's grant (403); web toggle calls the route after confirmation.
- [ ] Implement; run; commit `feat(mcp): owners stop proposals per grant, revocation cancels proposals (WP-M4)`.

### Task 5: Documentation and the full check

**Files:** `docs/IMPLEMENTATION_STATUS.md` (WP-M4 entry: tool, status tool, contract, quotas, switches, decisions D-M4-1…12, known limitations: no elicitation, only one P tool, no notification on creation, inbox lists 50, expiry not materialized; WP-M5 checklist additions; follow-ups for the other P tools), `docs/REQUIREMENTS_TRACEABILITY.md` (WP-M4 acceptance → tests), `plans/orbit-modularization/09-mcp-gateway.md` (dated notes D-M4-1/2/6/7/8/9), `docs/adr/0008-action-approvals.md` addendum (mcp requester, mcpProposable allowlist), `docs/SECURITY_REVIEW.md` status line.

- [ ] Docs; full vitest run (`node scripts/test-db-for-worktree.ts` first), `tsc` root + web, compose check, source-check/boundaries, secrets check, framework check, `next build --webpack`; commit `docs: WP-M4 status, traceability and notes`.

## Risk analysis

| Risk | Mitigation |
|---|---|
| External side effect without a decision | ActionRequests only; executor runs on owner approval; e2e test proves no effect before decision. |
| Unreviewed or hard-floor types created from MCP | `mcpProposable` allowlist enforced in `createActionRequest`; registry-wide test. |
| Proposal spam from always-on agents | Hourly + daily per-grant quotas, dedupe, central and per-grant switches, cancel on revoke. |
| Status tool leaks internal content | Strict output schema without payload/hash/ids; grant-scoped lookup. |
| Assistant behaviour change | Assistant path untouched; existing tests. |

## Rollback

Set `ORBIT_MCP_PROPOSALS=false` (default) or remove `exposure.mcp` from `assignment_propose`; the gateway stays off in production. No migration.

## Task findings

*(appended during execution)*

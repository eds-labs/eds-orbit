# Implementation status

## Track M WP-M4: MCP proposal surface (2026-10-18, local; flags off)

Branch `claude/track-m-wp-m4`, built from `main` after WP-M2 (#165) and WP-M3 (#169). Plan: `docs/superpowers/plans/2026-10-18-track-m-wp-m4-proposals.md` (decisions D-M4-1…12 below). Risk: high (a write path for external agents). Environment: local only. **Merging:** WP-M4 adds no migration and no dependency. The code deploys, but the gateway stays off in production (`ORBIT_MCP_GATEWAY` is `false`, no compose service runs it) and `ORBIT_MCP_PROPOSALS` defaults to `false`, so nothing MCP-related runs until WP-M5. Two changes reach running code on deploy: the `requestedBy` union and `createActionRequest` gain the `mcp` variant (every existing requester is unchanged), and `assignment_propose` gains an MCP branch that the assistant path never takes (its output and checks are unchanged).

- **What it adds.** An MCP client can propose an assignment (`marketing_assignment_propose`) and poll its fate (`orbit_action_status`). A proposal is a pending ActionRequest that only an Orbit-side decision can carry out: the project owner decides in the approval inbox, and the existing deterministic executor runs on approval. Client-side confirmation never counts (AD-22). There is no other write path.
- **ActionRequest contract (D-M4-2, D-M4-3).**
  - `requestedBy` gains `{ kind: "mcp", userId, clientId, grantId, agentRunId: string | null, argsHash }` (strict; `argsHash` is 64 hex).
  - `ActionDefinition.mcpProposable?: true` is the allowlist. `createActionRequest` refuses an `mcp` requester for any type without it with `ACTION_TYPE_NOT_PROPOSABLE` (403), checked after the type lookup and before the payload parse. Only `assignment.confirm` sets it, and `apps/api/tests/mcp-proposals-contract.integration.test.ts` asserts through `registeredActionTypes()` that no other registered type is proposable. Deletion, budget, governance and infrastructure types can never be created from MCP, whatever tools exist.
  - Creating an `mcp` request writes the project audit `action_request.proposed` (action type, package hash, client id, grant id; never the payload).
  - `findPendingMcpProposal` returns the newest pending, unexpired request of the same user and client (any grant of theirs in the workspace, the identity rule of the cancellation), action type and `argsHash` (dedupe, D-M4-4). The proposal service accepts a hit of an earlier grant only while the decide guard accepts that grant's line, otherwise it creates a new proposal.
  - The approval inbox (`apps/web/src/components/action-request-inbox.tsx`) shows "via MCP client <host>" (German: "über MCP-Client <host>") above a request that came from MCP.
- **`marketing_assignment_propose`** (`apps/api/src/modules/marketing/tools/assignment-tools.ts`, `P_proposal`, `orbit:propose`; `exposure: { assistant: true, mcp: true }`).
  - MCP path (`context.channel.kind === "mcp"`, service `proposeAssignmentFromMcp` in `apps/api/src/modules/marketing/agents/assignments.ts`): no conversation lookup, the draft is stored with `conversationId` null, and `requestedBy` is the `mcp` variant with `agentRunId` = the call's `mcp` AgentRun (null when the gateway had none). The existing domain checks all run: editor role, `ORBIT_AGENTS`, the argument schema `assignmentInput`, and the spend mandate (`ASSIGNMENT_BUDGET_EXCEEDS_PROJECT`, `SCOPE_NOT_ALLOWED`). They answer as `isError` results with `retryable: false`.
  - Inside the proposal transaction the grant is checked again with the decide guard (`mcpGrantStillProposes`): a grant revoked or stopped after the gateway resolved the principal refuses with `MCP_GRANT_ENDED` (409) and creates nothing. A stop that commits after this check runs its sweep under the same project lock, so it cancels what the transaction commits; no orphan proposal remains.
  - Output (strict `outputSchema`, D-M4-5): `{ status: "pending_approval", actionRequestId, assignmentId, expiresAt, approveUrl, deduplicated }` with `approveUrl = ${APP_ORIGIN}/p/<projectId>/approvals` (no per-request deep link exists). The `deduplicated` field exists so the quota can count creations only.
  - `argsHash` = hash of `{ tool: "marketing_assignment_propose", projectId, args }` with the arguments as `assignmentInput` normalized them, so a retry that spells out a default still matches, and a second tool on the same action type would get its own dedupe key. Only the hash is stored.
  - Each created proposal writes one `McpGrantEvent` `mcp.proposal` (action type and request id; no arguments) as the last step of the proposal transaction. A deduplicated call writes none.
  - No side effect before the decision: the draft assignment has no confirmation and schedules no runs. The decision revalidates the assignment (hash, policy, budget), so a stale or replayed decision does nothing.
  - The assistant path is unchanged: same conversation check, `requestedBy: agent`, same output. The MCP adapter alone validates against `outputSchema`; the chat runner never reads it.
  - MCP visibility now computes module features with `toolSearch: true` (`apps/api/src/platform/mcp/visibility.ts`). Marketing offers its `agents` tools only then, and MCP lists every tool directly. It affects only MCP-exposed tools (`project_status`, `support_insights`, `assignment_propose`); the same role and permission checks apply. With Orbit Agents off, or for a viewer, the tool is unlisted and a call answers JSON-RPC -32602 (the WP-M2 behaviour for unknown tools).
- **`ORBIT_MCP_PROPOSALS`** (D-M4-9; `packages/config/src/index.ts`, `.env.example`, `docker-compose.yml`, `scripts/check-coolify-compose.mjs`). `"false"` (default, compose-safe: empty means unset) or `"true"`. While off, every `P_proposal` tool is dropped from the principal's visible tools: not listed, and a call is refused. The same gate backs listing and `authorizeMcpCall` (which throws `MCP_TOOL_NOT_ALLOWED` 403; the adapter does not register a hidden tool, so a client sees -32602). The flag is read per request, so turning it off acts at once. It gates the WP-M2 fixture tool `tasks_suggest_task` too. `orbit_action_status` does not depend on it.
- **Quotas (D-M4-8)** per grant, enforced in the adapter for every `P_proposal` registry tool before its run starts. Numbers are `proposalsPerHourPerGrant: 20` and `proposalsPerDayPerGrant: 100` in `MCP_RATE_LIMITS`, so the existing `rateLimits` option can override them.
  - Hourly: a fixed one-hour window in the in-process limiter (`RateRule.windowMs`, new `check()` and `charge()`); it resets on restart and is per gateway process.
  - Daily: the count of the grant's `mcp.proposal` events since the start of the UTC day, read from `McpGrantEvent`, so it survives restarts and also counts a creation whose call timed out.
  - Check before, charge after: capacity is checked after the input parse, and the hourly bucket is charged after a successful execute unless the output says `deduplicated === true`. A dedupe hit does not count, and a P tool that does not report `deduplicated` is counted.
  - Refusal: an `isError` result `PROPOSAL_QUOTA_EXCEEDED`, fixed text "the proposal quota of this connection is used up for now", `retryable: false`, audited with that outcome.
  - Concurrency: calls in flight together can all pass the check, so the quota can be overshot by the number of concurrent calls of one grant (bounded by the 120 requests a minute grant rate; the project lock serializes creations in one project). It is never undercounted, except for a late completion after TIMEOUT, which is charged too.
- **Non-retryable failures (D-M4-11).** `TIMEOUT`, 429 and 5xx answers carry `retryable: false` for `P_proposal` and `W0_internal` tools (`transientRetryable` in `apps/api/src/platform/mcp/errors.ts`); read tools keep `retryable: true`. A timed-out proposal may still complete, and the client finds it through the dedupe or `orbit_action_status`.
- **`orbit_action_status`** (D-M4-12; native tool, `R0_read`, `orbit:read`; `apps/api/src/platform/mcp/native/action-status.ts`).
  - Input (strict): `{ projectId: uuid, actionRequestId: uuid }`. Output (strict): `{ actionRequestId, actionType, status, createdAt, expiresAt, decidedAt: string | null, approveUrl }` with `status` in `pending | approved | rejected | consumed | canceled | expired`.
  - Scoped to the calling user and client: the request must be in a granted project, have `requestedBy.kind === "mcp"` and the caller's `userId` and `clientId` (any grant of theirs, so a re-selection that replaced the grant keeps the client's own proposals visible; the same identity rule as the dedupe and the cancellation). A human's request, the same user's other client, another user of the same client, another project, an ungranted project and an unknown id all answer one byte-identical `NOT_FOUND`. A malformed id never reaches the tool: the SDK's input validation answers an `isError` "Invalid UUID" result.
  - `expired` is derived, and only for a `pending` request past `expiresAt`; an approved request stays `approved`. No payload, hash, policy, requester or user id leaves the tool (schema snapshot and scan in `apps/api/tests/mcp-proposal-controls.integration.test.ts`). It is audited in the polled project when that is one of the grant's, otherwise without a project.
- **Owner controls (D-M4-10).**
  - `PATCH /api/mcp-grants/:grantId` with the strict body `{ "proposals": false }` answers 204 (404 while `ORBIT_MCP_OAUTH` is off). `setGrantProposals` in `apps/api/src/platform/mcp-auth/grants.ts` has the authorization of revoking (the grant's user or a workspace owner; 404 for an unknown grant or a non-member, 403 for another member). It removes `orbit:propose` from `McpGrant.scopes` and, in the same auth transaction, from the consent Better Auth stored for (user, client, workspace), and records `grant.proposals_disabled`. The next request resolves the principal with the smaller scopes, so the P tools disappear from that grant at once. It is idempotent: a retry cleans the consent and runs the cancellation again.
  - Re-enabling goes only through a new consent. Because the stored consent no longer covers `orbit:propose`, the next connect that asks for it shows the consent step (instead of skipping it and copying the reduced scopes), and accepting `orbit:propose` there gives the new grant the scope again (`activateGrant`). WP-M1 pre-ticks the default scopes, so `orbit:propose` is preselected on that step.
  - Revoking a grant, stopping its proposals, and `revokeClientGrants` (all grants of a client whose registration changed; actor `system`) cancel the pending `mcp` ActionRequests (`cancelMcpProposals`, reason recorded) in every project of the grant's workspace, matched by user and client so a replaced predecessor grant is covered. The grant change commits first; cancellation follows best effort (batches of 100, at most 20 rounds), a failure per project is logged as `MCP_PROPOSAL_CANCEL_FAILED` (error name only) and the sweep continues. Each project's sweep runs in `scoped()`, which holds the project's advisory lock that a decision holds too, so the pending query and the cancellations are one locked transaction: an approval cannot land between them and be cancelled afterwards (`cancelActionRequest` with `pendingOnly` keeps that defensively).
  - Decide guard (`mcpGrantStillProposes` in `apps/api/src/modules/action-requests.ts`): `decideActionRequest` refuses the approval of an `mcp` request with `MCP_GRANT_ENDED` (409) unless its grant, or the active grant that replaced or superseded it for the same user, client and workspace, is active with `orbit:propose`, covers the request's project (`allCurrentProjects` or the project id), and its user is still a member of the workspace (and of the project, unless an owner). A successor never revives an old proposal: no grant of (user, client, workspace) may have ended for another reason than a replacement (a revocation, a denial, a client change) since the request was created, and no `grant.proposals_disabled` event may exist since then. It is a fixed handful of single-row queries on the auth database. This holds even if the cancellation never ran. Rejecting stays possible.
  - Connected apps (`apps/web/src/platform/connect/connected-apps.tsx`): a "Stop proposals" action with a confirmation, shown when the grant has `orbit:propose`; its hint says the next connect asks for consent again with proposing preselected.
  - The approval inbox shows a short sentence (German and English) for a refused approval with `MCP_GRANT_ENDED` instead of the raw code (`decisionErrorText` in `apps/web/src/components/action-request-inbox.tsx`).
- **Audit summary.** `action_request.proposed` (project), `mcp.proposal` (`McpGrantEvent`, per created proposal), `grant.proposals_disabled` (`McpGrantEvent`) and the existing `mcp.tool_call` per call. Argument values are stored nowhere.
- **Decisions D-M4-1…12** (controller rulings, reported in the PR):
  1. `assignment_propose` is the first and only exposed proposal tool. `propose_campaign` (a ChatProposal bound to a conversation), `request_content_package` (an editor decides, so it is not in the owner inbox) and `propose_schedule` (the package is resolved by conversation) stay unexposed.
  2. `mcpProposable` allowlist; only `assignment.confirm`.
  3. `requestedBy` gains the `mcp` variant.
  4. Dedupe per grant, tool and arguments. Amended: the hash covers the MCP tool name and the project too, a full hourly bucket refuses even a would-be dedupe hit (the check runs before the tool), and the match is per user and client (not grant id), accepted only while the hit's grant line stands.
  5. Proposal output with `approveUrl`. Amended: the MCP shape carries `deduplicated`.
  6. URL-mode elicitation deferred to WP-M5: support in ChatGPT and dots is undocumented, a legacy client cannot receive it statelessly, and it needs an HMAC-protected `requestState`. The fallback is `approveUrl` plus `orbit_action_status`.
  7. Stricter mode: every action type is already `approval_required` with a human decider, the strictest mode implemented; no `auto*` mode exists, so there is no code. If a looser mode is ever added, MCP requests must stay one step stricter (ADR 0008 §4).
  8. Quotas of 20 an hour and 100 a day per grant. Amended: the daily number counts UTC days and creations only.
  9. Central switch `ORBIT_MCP_PROPOSALS` and the per-grant "stop proposals".
  10. Revocation and stopping cancel pending proposals. Amended: best effort after the grant change, plus the decide guard.
  11. `TIMEOUT` and transient failures are not retryable for P and W0 tools.
  12. `orbit_action_status`. Amended: malformed ids are rejected by the SDK's input validation, `expired` is derived for pending requests only, and the lookup matches the caller's user and client (not grant id).

  Rulings beyond the plan: the visibility `toolSearch: true` above; the MCP `agentRunId` falls back to null when the gateway had no AgentRun; the `mcp.proposal` event is the last step inside the proposal transaction (a failed commit after it overcounts the quota by one, never undercounts); the guard accepts the active successor of a replaced grant, so a re-consent does not strand pending proposals, but only while no non-continuing revocation and no stop happened since the request was created; `toolFailure` and `timeoutResult` require the tool's risk (a missing risk must never read as retryable).
- **Tests** (all under `apps/api/tests/` unless noted).
  - `mcp-proposals-contract.integration.test.ts` (17): the `requestedBy` union, the registry-wide allowlist, `ACTION_TYPE_NOT_PROPOSABLE` for non-proposable types, `action_request.proposed` without payload, `findPendingMcpProposal`.
  - `mcp-proposal-flow.integration.test.ts` (8): real WP-M1 tokens end to end. Proposal → owner inbox → owner approves → assignment confirmed by the existing executor; `mcp proposal: decide, replay and hash mismatch`; dedupe; domain refusals; the assistant path; agents off.
  - `mcp-proposal-controls.integration.test.ts` (21): the central switch, hourly and daily quotas, dedupe not counting, non-retryable failures (also `timeoutResult` per risk), `orbit_action_status` (schema snapshot, every status, identical `NOT_FOUND`, the same user and client across grants).
  - `mcp-proposal-owner-controls.integration.test.ts` (10) and `mcp-oauth-revoke.integration.test.ts`: stopping proposals, cancellation on revoke, the decide guard, re-consent (status and dedupe after a re-selection), authorization; stop → reconnect shows the consent step and accepting `orbit:propose` restores proposing while the pre-stop proposal stays refused; a client change revokes the successor grant, cancels its proposals and a later grant never revives them; project coverage and membership in the guard; the in-transaction re-check refusing `MCP_GRANT_ENDED`.
  - Web: `apps/web/src/components/action-request-inbox.test.tsx`, `apps/web/src/platform/connect/connected-apps.test.tsx`; `config-compose-empty.test.ts` for the new key.
  - Mapping to the roadmap acceptance: `docs/REQUIREMENTS_TRACEABILITY.md` ("Track M WP-M4 acceptance").

**Verification (local).** Full suite on a per-worktree test database (`node scripts/test-db-for-worktree.ts`): `vitest run` with the local env file, 231 files, 2396 of 2396 tests passed (after the final fix wave, with `main` #171 merged in). `tsc --noEmit` (root and `apps/web`), `scripts/source-check.mjs` and `scripts/boundaries.mjs` (0 known import violations, none new), `python3 scripts/check-secrets.py`, `scripts/check-coolify-compose.mjs`, `python3 scripts/check_framework.py --require-full-validation` (0 errors, 0 warnings) and `next build --webpack` pass (`next build` not re-run after the final fix wave). Not done: a ChatGPT or dots run, MCP Inspector conformance, a load test and the independent security review (WP-M5).

**Known limitations (accepted for WP-M4).**
- Only one proposal tool is exposed (D-M4-1). `propose_campaign`, `request_content_package` and `propose_schedule` are follow-ups: each needs its own review of how its ActionRequest or ChatProposal couples to a conversation or a different decider, and its own `mcpProposable` decision.
- No URL elicitation (D-M4-6): the client gets `approveUrl` and polls `orbit_action_status`. The link goes to the project's approval inbox, not to the request.
- The owner is not notified when a proposal is created (no Telegram or e-mail); it appears in the inbox. The inbox lists the newest 50 requests.
- Expiry is not materialized: a request past `expiresAt` stays `pending` in storage and is only reported as `expired` by the status tool (and refused by the decision with `ACTION_REQUEST_EXPIRED`). The dedupe ignores it by time.
- A cancelled proposal leaves its draft assignment (`draft`, a dead `actionRequestId`, no runs, no confirmation) in place; the owner UI does not hide it.
- Re-consent pre-ticks `orbit:propose` again (the WP-M1 default scopes), so a user who stopped proposals must untick it on the consent step the next connect shows. Stopping proposals is not remembered across a new grant beyond that consent step.
- The hourly window is fixed, not sliding (up to twice the limit across a boundary), in process, and resets on restart; the daily quota is the durable one. A full hourly bucket also refuses a call that would have been a dedupe hit.
- A dedupe hit does not re-run the mandate check; the decision revalidates the assignment, so the client learns of a changed mandate only at decision time or from the status.
- The owner inbox list returns the raw `requestedBy` (grant id, `argsHash`, agent run id) and the full assignment payload; it reaches owners only (`listActionRequests` authorizes `PROJECT_OWN`).
- The cancellation scope uses a fabricated owner role (no role is checked there; the grant change was authorized before), and the cancellation-failure path (logging, the sweep continuing) has no test of its own; the tests simulate a failed sweep by setting a cancelled request back to pending.
- The daily quota count runs on every `P_proposal` call that passes the hourly check (one indexed count over a day of the grant's events), and both quotas key on the grant id, so a re-selection (a new grant id) starts with fresh hourly and daily buckets.
- The requester of a proposal is derived in the tool from `context.channel` (`kind === "mcp"`), not centrally by the adapter.
- Smaller test gaps: the dedupe tests lack approved-then-same-args, pending-but-expired, an event-write rollback and a null `agentRunId`; `channels` order is not normalized in `argsHash`.

**WP-M5 checklist additions (on top of the WP-M2, WP-M3 and WP-M1 lists).**
- [ ] Cache "daily quota used up" per grant until UTC midnight, so calls stop counting a day of events each time.
- [ ] Add a registry assertion (or a test) that every `P_proposal` tool writes `mcp.proposal`, and reports `deduplicated`; the daily quota relies on both. `tasks_suggest_task` (a fixture) does neither.
- [ ] Trim `requestedBy` (grant id, `argsHash`, agent run id) in the owner inbox list output.
- [ ] Add a test for a failing cancellation (logged, sweep continues, the guard still refuses the approval), and give the cancellation scope an explicit system role instead of a fabricated owner role.
- [ ] Key the proposal quotas on (user, client, workspace) rather than the grant id, so a re-selection does not reset them; cache the daily count (see above).
- [ ] Derive the MCP requester centrally (adapter or `ToolContext`) from `context.channel`, so a future proposal tool cannot forget it.
- [ ] Decouple `apps/api/src/modules/action-requests.ts` from the auth grant table and `apps/api/src/platform/mcp-auth/grants.ts` (about 1,000 lines) from the cancellation: ports between action requests and MCP auth.
- [ ] Decide whether to implement URL-mode elicitation, an owner notification on creation and a per-request deep link.
- [ ] Review the wording and numbers of the quotas with real client behaviour (dots loops) and decide whether the hourly window should be sliding or durable.

**Follow-ups for the other proposal tools.**
- `propose_campaign`: a ChatProposal bound to a conversation; needs either a conversation-less variant or an ActionRequest type.
- `request_content_package`: the editor decides and the request is not in the owner inbox; the decider must be the requester, which an MCP proposal cannot satisfy as is.
- `propose_schedule`: resolves the package by conversation.
- Each needs `mcpProposable` on its action type, an `argsHash` with its own tool name, an `mcp.proposal` event, a `deduplicated` output field and the controls above.
- Stricter mode (D-M4-7): if a looser mode than `approval_required` is ever added to ADR 0008, MCP-originated requests must default one step stricter.

## UI restructure, phase 4: attention-first home (2026-10-19, local; no flag)

Spec §5.1 and §5.2. No schema change, no migration, no new permission, no new dependency, no new endpoint. Rollback is a revert and redeploy.
- **Home** (`platform/shell/home.tsx`): greeting by local time with the member's first name and "N things need you today" (critical and warning items), the assistant prompt (hands the text to Orbit Chat as a draft, sends nothing), the status strip from the attention `status` (the project's mode in the words of the marketing overview's mode band through one map, `modeLabel` in `lib/i18n.ts`, ruling R25; the AI budget of the month only for owners and editors, "—" for the limit while the policies are hidden, ruling R26), and the attention list (due pills keep minutes under two hours, "in 1 Std. 59 Min.", and round hours and days above) (at most 8 rows, "Show all"; a failed load shows an error row and never blocks the cards). The module tiles are gone.
- **Cards** (§5.2): below the list, `homeSections(modules, enabled)` (`platform/shell/routes.ts`) orders the enabled modules' `home` by `homeOrder` — Support 5, Marketing 10, Knowledge 20 — in a responsive grid, followed by the platform's `SystemStatusCard`. All share `HomeCard` (`platform/ui/home-card.tsx`, title plus "Go to overview →"). The full marketing overview is no longer embedded (its `embedded` mode and the old home heading labels are removed).
  - **Support** (`modules/support/home.tsx`): open, unassigned, at-risk and overdue counts from `/support/summary` and the three latest open tickets (`/support/tickets?openOnly=true&limit=3`), each linking to `/support/tickets?ticket=<id>`.
  - **Marketing** (`modules/marketing/home.tsx`, `MarketingHomeCard`): the agents' current or latest run from `/agent-activity` (assignment, today's or last run, steps done of total, cost, state; hidden while the route answers 404 = Orbit Agents off), the next three posts of the coming week (`/assignment-posts`, else the `publications` collection through `nextPosts`, read only when the assignment posts are unavailable), active missions and open approvals (`counts.approvals` of the attention response; "—" while it is unknown; the marketing overview's "Open approvals" metric uses the same number, ruling R27). The card refreshes `/agent-activity` every 15 s only while the newest run is planned or running (`pollsRun`).
  - **Knowledge** (`modules/knowledge/home.tsx`, `KnowledgeHomeCard` from phase 2): now registered as the module's home.
  - **System status** (`platform/shell/system-status.tsx`, ruling R24): never reads `/operations`. Worker "running" unless a `platform_worker_down` attention item exists, "Worker: —" while attention loads or failed; one line per configured connection provider that an enabled, visible module contributes (`shell.connectors.providers`, as the Connections page lists them) from the `connectors` collection that page reads (connected, not verified, failing; revoked ones left out), the owner's mailboxes from the same collection (provider `email`; no extra read), and the unclear-cost line from a `platform_cost_unknown` item (owner only, filtered by the API). The Telegram bot (its own owner-only route) is not shown.
- **Requests**: one home load reads support summary and tickets, missions, agent activity, assignment posts (publications only as fallback), the four knowledge reads and the connectors collection, besides the shell's reads. Under `next dev` (React Strict Mode doubles effect fetches) a whole local e2e suite from one IP can reach the API's 600 GET/min limit; the affected tests pass alone.
- **Tests**: `platform/shell/home.test.tsx` (greeting, prompt, strip, list, `homeSections` order), `modules/marketing/home.test.tsx`, `platform/shell/system-status.test.tsx` (worker states, connectors, mailboxes, cost line, no `/operations` request), `modules/support/overview.test.tsx` (support card). e2e: `workspace.spec.ts` "the home shows the module cards and each leads to its overview" (order, R24, every card link's href rather than a click-through so the home loads once, 390 px single column and 44 px links); `navigation.spec.ts`, `chat.spec.ts` and the workspace helpers wait for the greeting instead of the old marketing heading.
- **Post-deploy smoke** (uLiquid):
  1. The status strip's mode equals the marketing overview's mode band.
  2. The strip's budget line equals the overview's "AI budget, month" card for an owner and an editor, and is absent for a viewer.
  3. The card counts equal the Support, Knowledge and Approvals pages (open, unassigned, at-risk and overdue tickets; sources, verified facts and conflicts; open approvals = the Approvals badge).
  4. The system status card shows the Postiz/X connections and, for the owner, the support mailbox.
  5. At 390 px the cards stack in one column without horizontal scroll and every card link is a 44 px target.

## UI restructure, phase 3: attention (2026-10-18, local; no flag)

Spec §4 and §3.3 (badges). No schema change, no migration, no new permission, no new dependency. Rollback is a revert and redeploy.
- **API** (`apps/api/src/platform/attention/`, contributions in `modules/{support,marketing,knowledge}/attention.ts`): `GET /api/projects/:id/attention` returns `{items, counts, status}` (see `API_CONTRACT.md`): SLA-breached and at-risk tickets (at most 5 named per kind, the rest aggregated) and the other unassigned ones, each ticket counted once (R20); draft releases, content review, open exceptions (one per code, affected resources as a param, R19), paused posts and run problems (health-only reads, R21); stale and expiring sources (at most 3 named per kind, the rest aggregated, ruling R18), conflicts and failed imports; worker down, unclear AI cost and open action requests. Counts sum `count ?? 1` per navKey over all items (R17).
- **Web data** (`platform/shell/attention.tsx`): `useAttentionLoad` in the shell loads it once per project and workspace revision and again on navigation, through a module-level cache with a 30 s TTL that outlives the shell's remount on every navigation (ruling R15); a revision bump or an expired entry fetches again, a request in flight is shared, errors are not cached. `useAttention()` reads it from `ShellContext`, for the sidebar and the home page (phase 4).
- **Texts** (§4.3): `WebModule.attention` and `WebRegistry.attention` (platform, in `modules/registry.ts`) map each kind to `{title, detail?, action}` in EN and DE; `renderAttention` falls back to a generic row (module name, kind, "Open") for kinds this build does not know. Texts carry only what params carry (ticket number and subject, channel, names, codes); due times are left to the home page's pill.
- **Badges**: the sidebar shows `counts` per entry (navKey = route key) and the sum on a collapsed group header; an entry with a critical item uses the warning colour. Screen readers hear "3 to do" / "3 zu erledigen", plus "urgent" / "dringend" for the warning colour (replaces "open", which clashed with the group's "collapsed"). The mobile bottom bar shows the same badge on its entries (Tickets, Approvals). Loading or a failed load shows no badges; navigation is unaffected.
- **Tests**: `platform/shell/attention.test.tsx` (generic row, every kind in EN and DE, badges from counts, failed load, the cache).

## UI restructure, phase 2: module overviews (2026-10-18, local; no flag)

Spec §5.3 and §6. Each module root becomes an overview page; no schema change, no migration, no new permission. Rollback is a revert and redeploy.
- **Marketing** (`/p/:id/marketing`, `modules/marketing/overview.tsx`): head with "Module" eyebrow and actions, mode band, four metrics (active missions, open approvals, published in 7 days, AI budget of the month), agent run, next posts, missions and readiness. The project home shows a compact card instead (phase 4). The budget card counts what the monthly limit enforces: settled plus reserved, in-flight and unclear reservations of `/ai-cost` over the UTC calendar month (ruling R11, as `budgetMonthStart`); without a limit it shows the spend with "No monthly limit set".
- **Support** (`/p/:id/support`, `modules/support/overview.tsx`): five metrics, open tickets by due time, inboxes with open counts, new tickets per day, "My tickets"; the inbox moved to `/support/tickets`, and `/support?ticket=<id>` redirects there (a skeleton until replaced; nothing is requested). On the mobile bar, Tickets is current on every support page (rulings R12/R12b: with no exact match, the module root on the bar counts, else the module's only own bar entry; a platform page in the group, such as Approvals in Marketing, never stands for other pages). API additions: `sort=sla`, `openOnly`, `volume.byDay`, `openByInbox` (see `API_CONTRACT.md`, `SUPPORT.md`).
- **Knowledge** (`/p/:id/knowledge`, `modules/knowledge/overview.tsx`): four metrics (sources, verified facts, conflicts, active index generation for owners), source freshness sorted by expiry (stale first; `sourceExpiry`: stale without a sync or past `lastSuccessfulSyncAt + maxAgeHours`, expiring within 48 h), open conflicts, index quality of the active generation (owners; a 403 or 404 from `/indexes` hides it) and links to Health, Impact and Inspector. Reads only existing endpoints (`/knowledge-health`, the `sources` collection, `/indexes`, and the exact `counts.verifiedFacts` of `/dashboard`, ruling R13). The knowledge tab bar is gone: the sidebar entries replace it, and every sub-page shows a back link to the overview. The index generations (`IndexManagement`) live on the Health page only. `modules/knowledge/home.tsx` (`KnowledgeHomeCard`) is the module's home card since phase 4.
- **Shared:** `platform/ui/metric.tsx` is the one metric tile of the three overviews.
- **Shell fix (found with support on):** a page now waits for the project's module states before it mounts, and a refresh keeps the last known states while it refetches them (`knownModuleStates`); after a failed first load it keeps rendering with the defaults (`waitsForModuleStates`). Before, with the opt-in support module on, every page first rendered with support hidden and remounted once the states loaded: support pages flashed "Module turned off", each page loaded its data twice, and the home prompt's draft was lost on its way to Orbit Chat. A failed states load still falls back to the defaults.
- **Tests:** unit tests per overview and for `Metric`; `workspace.spec.ts` reaches the knowledge pages through the sidebar and the overview links, and its 390 px keyboard check now uses the settings tabs (ruling R8; `components/ui/tab-focus.ts` stays for any tab bar that navigates). `navigation.spec.ts` also runs on a support-enabled stack (`E2E_SUPPORT=1`: support pages in the sidebar list, Tickets on the bar).
- **Post-deploy smoke** (uLiquid, support on):
  1. `/p/:id/support` shows the overview: five metrics, open tickets by due time, inboxes, tickets per day, "My tickets".
  2. `/p/:id/support/tickets` lists the inbox and opens a ticket.
  3. An old notification link `/p/:id/support?ticket=<id>` lands on `/support/tickets?ticket=<id>` with that ticket open, without the overview showing first.
  4. At 390 px the bottom bar shows Home, Orbit Chat, Tickets, Approvals, and Tickets is current on `/support`, `/support/tickets`, `/support/contacts` and `/support/stats`.
  5. The marketing "AI budget, month" card against Operations: its amount is settled plus reserved (incl. in flight and unclear) since the first of the current month, 00:00 UTC, its detail names the active policy's monthly limit and the reserved part. Operations shows Spend and Reserved over all time, so the two agree only when all spend falls into the current month; otherwise the card must be the smaller figure.

## Track M WP-M3: MCP read surface (2026-10-18, local; flag off; stacked on WP-M2)

Branch `claude/track-m-wp-m3`, stacked on `claude/track-m-wp-m2` (draft PR #165). Plan: `docs/superpowers/plans/2026-10-18-track-m-wp-m3-read-surface.md` (decisions D-M3-1…11 below). Risk: high (Orbit knowledge reaches external models). Environment: local only. **Merging:** WP-M3 adds no migration and no dependency; it merges only after #165. It adds no service, the gateway stays off (`ORBIT_MCP_GATEWAY` is `false` and no compose service runs it), and nothing MCP-related runs until WP-M5. It is still a production code change on deploy: (1) the shared passage-retrieval SQL moves into `eligiblePassages()` in `packages/knowledge/src/index.ts`, byte-identical to the previous inline fragment and covered by the existing retrieval tests, and `knowledgeSearch` gains an optional trace parameter; (2) the assistant tools `project_status` and `support_insights` gain strict output schemas and MCP exposure, with their assistant output unchanged (the suite includes the assistant parity test).

- **What it adds.** MCP clients (ChatGPT developer mode first) can search and cite Orbit knowledge and read project state through the WP-M2 gateway: the native tools `search`, `fetch` and `orbit_profile` (`apps/api/src/platform/mcp/native/`) and the first two reviewed registry tools, `marketing_project_status` and `support_insights`. Every call keeps the WP-M2 grant, membership, module and permission checks.
- **`search`** (`R0_read`, `orbit:read`, read-only).
  - Input (strict): `{ query: string (trimmed, 1..2000), projectId?: uuid }`. Output (strict, the OpenAI shape): `{ results: [{ id, title, url }] }`, at most 30 results. The per-project retrieval mode (hybrid or lexical) is **not** returned, because the OpenAI contract is the strict `{ results }` object.
  - Which projects (D-M3-5): without `projectId`, the principal's granted projects where the knowledge module is visible and the role can read it, ordered by name then id, at most 5. With `projectId`, only that project: outside the grant the answer is `NOT_FOUND`, and a granted project whose knowledge the member cannot read (module off, module role `none`, grant restricted to other modules) gives `{ results: [] }`.
  - Ordering: results of the searched projects are interleaved round-robin and capped at 30, so one project cannot fill the list. Projects are searched one after the other, inside the 25 s tool timeout.
  - Ids (D-M3-6): `p:<projectId>:chunk:<chunkId>` and `p:<projectId>:fact:<factId>`; the parse is strict (both ids must be UUIDs).
  - `url` (D-M3-7): the source's safe canonical URL (query string and fragment stripped by `safeCitation`); otherwise the Orbit deep link `<APP_ORIGIN>/p/<projectId>/knowledge/library` (passages) or `/knowledge/facts` (facts). Never empty. Facts never have a canonical URL, so a fact URL is always the facts tab. Titles are the passage's version title or the fact key, clipped to 160 characters.
- **`fetch`** (`R0_read`).
  - Input (strict): `{ id: string (<= 200) }`. Output (strict): `{ id, title, text, url, metadata: { projectId, kind: "chunk" | "fact", sourceId, documentVersionId?, fetchedAt?, truncated? } }`.
  - Re-authorization: every call parses the id, then re-checks the grant, membership, the visible knowledge module and `PROJECT_READ` for the project named in the id, and then re-checks eligibility against the database. Malformed, unknown, ineligible, foreign and kind-swapped ids all answer the identical `NOT_FOUND` body, and the audit row stays in the granted project only.
  - A passage returns the active document version's text, truncated to 48 KB of UTF-8 on a character boundary (`metadata.truncated`); a fact returns `key: value` followed by its unit and currency.
- **`orbit_profile`.** Input `{}`; output `{ id }`, the opaque user id and never an e-mail. Its tool definition carries `_meta["openai/profile"] = true`. A native tool's `_meta` is merged before `securitySchemes`, so it cannot replace them.
- **Eligibility (single source of truth).** Search and fetch return only what `retrieve(… forModel: true, purpose: "public")` could return: source active, not generated, `publicUse` and `modelUse` true, not embargoed, open to all consumers, current generation, valid and fresh; document version active and current. The passage SQL was extracted from the engine as `eligiblePassages()` in `packages/knowledge/src/index.ts`; `retrieve` and `eligiblePassage` (fetch) both use it, so they cannot drift. Facts must be usable under K-1 (`usableFactsByIds` in `apps/api/src/platform/knowledge/facts.ts`) and their source must serve the no-consumer audience; search filters fact hits through the same check, so every hit is fetchable. MCP knowledge calls pass no consumer (D-M3-4): marketing-only and support-only sources stay internal. Services: `searchForModel`, `fetchChunkForModel`, `fetchFactForModel` in `apps/api/src/platform/knowledge/mcp-read.ts`.
- **Budget and fallback (D-M3-2, D-M3-3).**
  - A paid search needs an active spend mandate. Per project and call: `retrievalJobKey = mcp:<grantId>:<requestId>:<callId>:<projectId>` and `budgetRunKey = mcp:<grantId>:<requestId>:<callId>` (the full reservation key is `<projectId>:query:<retrievalJobKey>`); the category stays `query_embedding`. The call id is a fresh UUID per tool call, so no two calls share a key. The project's daily and monthly caps still apply.
  - Attribution: a search over exactly one project (explicit `projectId`, or only one of the granted projects has readable knowledge) is audited in that project, and its paid embedding is attributed to that call's `mcp` AgentRun (`trace.agentRunId`, task class `search`), so it shows in the AI cost views. A multi-project search is project-less (`McpGrantEvent`), and each paid embedding opens its own `retrieval` run for that project.
  - No usable mandate: lexical search, no reservation. The mandate is checked first (active policy that approves paid tests, now inside its window, project not paused), so no retrieval run is opened for an attempt that would fail before any spend.
  - Lexical fallback happens only before any spend, for these codes: `POLICY_REQUIRED`, `PAID_MANDATE_EXPIRED`, `BUDGET_NOT_APPROVED`, `BUDGET_EXCEEDED`, `RUN_BUDGET_EXCEEDED`, `PROJECT_PAUSED`, `NO_ACTIVE_EMBEDDING_INDEX` (see below), `OPENAI_API_KEY_REQUIRED`, plus the two price-configuration codes `VERIFIED_PRICE_CONFIGURATION_REQUIRED` and `CURRENT_PRICE_REQUIRED` (thrown by the cost estimate before a reservation; added by ruling in `d2a358a`). The fallback never happens once a reservation exists for the call's key; every other error fails the call.
  - Per-project unavailability: lexical retrieval needs the same embedding index, so `NO_ACTIVE_EMBEDDING_INDEX` cannot actually fall back. A project whose search raises a `KnowledgeError` (such as `NO_ACTIVE_EMBEDDING_INDEX`) is skipped (zero hits, logged as `MCP_SEARCH_PROJECT_UNAVAILABLE` with the code and request id, never the query), so that error alone never fails a multi-project search; a single-project search returns `{ results: [] }`. Every other error fails the whole call, by design: `QUERY_EMBEDDING_COST_UNKNOWN` and the other failures after possible spend (no fallback after possible spend), a malformed policy, evidence drift. `fetch` can still return eligible content of such a project.
- **Gateway plumbing** (Task 1).
  - Native tools receive `run(principal, args, ctx)`; the context carries the request id, a per-call id, client and grant ids, `agentRunId`, `setAuditProject(projectId)`, `startRun(projectId)` and a logger. Both ignore a project outside the grant. **First attribution wins:** a call has one audit project and at most one run; a later attribution to another project, or after the call was answered, changes nothing.
  - The `mcp` AgentRun is started before a tool executes: registry tools after authorization and argument parsing (no run before authorization), natives lazily through `startRun`. The run id becomes `ToolContext.runId` (the request id is the fallback if the run cannot be created, so telemetry stays best effort); conversation and channel keep the request id.
  - Every tool call has a 25 s timeout (D-M3-11, `MCP_TOOL_TIMEOUT_MS`): the client gets an error result with code `TIMEOUT` (`retryable: true`), the outcome is audited as `TIMEOUT` and the run finishes failed. The work may still finish server-side; a late result is dropped and a late attribution is ignored.
  - `search` has its own bucket, 30 calls a minute per grant (D-M3-10), charged only for `tools/call` of `search`, in addition to the WP-M2 limits.
  - **JSON-RPC batches are refused.** An array body answers HTTP 400 `{"jsonrpc":"2.0","error":{"code":-32600,"message":"Batch requests are not supported"},"id":null}` after token verification and the limits, and before principal resolution and the SDK. Batching was removed from MCP in revision 2025-06-18 and no target client sends batches. A batch without a valid token still gets 401, and one with a revoked grant now gets 400 instead of 401 (the principal is not resolved). Nothing in a refused batch executes, is audited or spends. Earlier, the SDK accepted all-legacy batches and answered each `tools/call` as an unknown tool; a probe showed that no `search` could run, so the shared-key and bucket-bypass risk was latent only.
- **Registry tools** (Task 4; `exposure: { assistant: true, mcp: true }` plus a strict `outputSchema`; the assistant output is unchanged).
  - `marketing_project_status` (`apps/api/src/modules/marketing/tools/read-tools.ts`, the `project_status` tool): strict, nested-strict schema with bounded arrays (approvals and drafts 15, channels 200, links and CTAs 20, blockers 30). Exposed fields: project name, language, timezone, mode and paused flag; profile summary with official links and CTAs; channels (Postiz channel ids, names and provider); policy including `modelBudget` (daily, monthly and per-run spend limits in micros, mandate window); up to 15 draft titles; pending approvals with content ids; and the readiness state with blocker and action codes (so setup state such as "Postiz connected?" is visible). Not exposed: credentials, post bodies, customer data, `readiness.capabilities`. **The spend limits and draft titles are flagged for the WP-M5 review.** The schema pins formats (uuid content ids, `status: "pending"`, a URL for official links): a legacy row that violates it makes the call fail as `REQUEST_FAILED` (logged `MCP_OUTPUT_INVALID`) instead of leaking.
  - `support_insights` (`apps/api/src/modules/support/tools.ts`): counts only (open total, by status, by priority, by category with a key pattern and a 100-key cap), never ticket text, subjects or e-mail addresses. Still gated by `ORBIT_SUPPORT`, the project's module row and `SUPPORT_STATS_READ`. `{ available: false }` is accepted by the schema but practically unreachable through the gateway, because the tool is hidden when support is off. With `ORBIT_SUPPORT` on, tool listing reads module activation rows per project.
  - Both tools carry a double-parse note in the tool file: the SDK and then the adapter parse the arguments, so the parameter schemas must have no transforms or non-idempotent defaults.
- **Decisions D-M3-1…11** (controller rulings, reported in the PR):
  1. MCP `resources` (`orbit://…`) are deferred; everything is reachable through `fetch`.
  2. Budget keys per call (above) instead of the spec's daily `mcp:<grantId>:<date>` run key, which would accumulate against `perRunBudgetMicros`. Amended: the key also carries a per-call UUID, not only the request id.
  3. Lexical fallback before any spend, never after a reservation. Amended: two price-configuration codes added; the mode per project is not reported (strict OpenAI shape).
  4. No consumer: only sources open to all modules.
  5. At most 5 projects per call, or the explicit `projectId`.
  6. Self-describing ids; `fetch` re-authorizes from the id.
  7. Canonical URL or the Orbit deep link, never empty.
  8. Fetch truncates at 48 KB (`metadata.truncated`).
  9. First registry tools: `marketing_project_status` and `support_insights`; nothing else.
  10. Search bucket 30 a minute per grant.
  11. Tool timeout 25 s; per-project concurrency (R-10) stays a WP-M5 item.

  Rulings beyond the plan: batches refused; the passage SQL shared as `eligiblePassages()`; fact hits filtered through K-1 and audiences; registry runs start after authorization; the lexical-fallback guard "never after a reservation"; single-project attribution as defined above.
- **Tests.**
  - `apps/api/tests/mcp-read-surface.integration.test.ts` (22 tests): the pinned schemas of the three native tools, the profile, lexical fallback without spend, paid search attributed to the `mcp` run, `modelUse=false` absent end to end, the 5-project cap, project-less multi-project calls, `projectId` handling, empty and oversized queries, fetch of a passage and a fact, "fetch ids cannot cross projects" (16 cases), module and role hiding, batch refusal.
  - `apps/api/tests/mcp-knowledge-read.integration.test.ts` (51 tests): the ineligibility matrix for search and fetch (14 passage and 15 fact cases), truncation at 48 KB, the search modes and the fallback codes.
  - `apps/api/tests/mcp-registry-tools.integration.test.ts` (16 tests): listing, schemas, parity with the assistant output, counts only for support.
  - Updated: `mcp-gateway.integration.test.ts` (native context, run before execute, first attribution wins, `TIMEOUT`), `mcp-gateway-audit.integration.test.ts` (search bucket, batch refusal), `mcp-principal.integration.test.ts`, `module-contributions.test.ts`.
  - Mapping to the roadmap acceptance: `docs/REQUIREMENTS_TRACEABILITY.md` ("Track M WP-M3 acceptance").

**Verification (local).** Full suite on a per-worktree test database (`node scripts/test-db-for-worktree.ts`): `vitest run` with the local env file, 216 files, 2216 of 2216 tests passed. `tsc --noEmit` (root and `apps/web`), `scripts/source-check.mjs` and `scripts/boundaries.mjs` (0 known import violations, none new), `python3 scripts/check-secrets.py`, `scripts/check-coolify-compose.mjs`, `python3 scripts/check_framework.py --require-full-validation` (0 errors, 0 warnings) and `next build --webpack` pass. Not done: a ChatGPT developer-mode run, MCP Inspector conformance, a load test and the independent security review (WP-M5).

**Known limitations (accepted for WP-M3).**
- No MCP resources (D-M3-1) and no per-entity deep links: `url` is the canonical source URL or the library or facts tab. A fact URL is always the facts tab.
- The retrieval mode per project is not visible to the client.
- A multi-project search that falls back opens one `retrieval` run per project, and a run whose paid path fails before spend is recorded as failed. Single-project calls open none.
- A project without an active embedding index is silent in search (and cannot fall back to lexical), while `fetch` still returns its eligible content.
- `OUTPUT_TOO_LARGE` risk: a very long canonical URL on many hits can push `search` over the 64 KB cap, and a `fetch` text near 48 KB can exceed it after JSON escaping (no clipping yet).
- A tool that is still running after `TIMEOUT` is not cancelled; a run whose start was still in flight is awaited without a bound (only a database hang would delay it).
- `TIMEOUT` is reported as retryable, which is wrong for proposal tools (WP-M4).
- `fetchFactForModel` loads all of the project's facts and sources, like `listUsableFacts`.
- `support_insights` and `project_status` have duplicated local lists and two schemas (see the WP-M5 items); the published JSON schema of `support_insights` is weaker than the zod refinement and key cap.
- Other deferred review findings (tests and hygiene only): the `_meta` merge is covered but a late rejection after a timeout is not; the search-side negative passage assertions are partly vacuous (`topK` and a shared token); the fact cases lack "generated authority" and "not yet valid"; `projectLanguage` raises a Prisma error instead of `NOT_FOUND` for a vanished project; `modelFacts` queries the sources twice; of the readiness states only `not_configured` is exercised end to end for `marketing_project_status`; the registry test's schema walker skips `patternProperties`.

**WP-M4 items (write path).**
- Proposal tools go through ActionRequests with `requestedBy` of kind `mcp`, with quotas per grant, the central kill switch and `orbit_action_status`.
- `TIMEOUT` must be `retryable: false` for proposal tools.

**WP-M5 checklist additions (on top of the WP-M2 and WP-M1 lists).**
- [ ] Review the fields `marketing_project_status` exposes (AI spend limits, draft titles, pending approval content ids, readiness blockers and actions, channel ids, names and providers, official links), and decide whether any should stay internal.
- [ ] Clip long canonical URLs and escape-heavy text so `search` and `fetch` cannot hit `OUTPUT_TOO_LARGE`.
- [ ] Add a test that the query text is absent from logs, audit rows and run data (arguments are stored nowhere today; only the hash and the error code are logged).
- [ ] Add a sync check for the support status and priority lists that `support_insights` duplicates (a new status makes the tool fail its schema until it is updated).
- [ ] Per-project concurrency (R-10) for searches and the other tools; searches run sequentially over at most 5 projects today.
- [ ] Run the ChatGPT connector end to end (search, cite, fetch) against the deployed gateway.

## Track M WP-M2: MCP gateway core (2026-10-18, local; flag off)

Branch `claude/track-m-wp-m2` (from `main` at `89c4694`). Plan: `docs/superpowers/plans/2026-10-18-track-m-wp-m2-gateway.md` (decisions D-M2-1…7 and the Task 0 findings). Risk: high (new public endpoint). Environment: local only. Mario approved the MCP SDK 2.3.1 on 2026-10-18. There is no production service: nothing starts `apps/api/src/mcp-main.ts` yet (compose service and Traefik route are WP-M5). At the end of WP-M2 no module tool was exposed to MCP and the only listable tool was the native `orbit_projects`; WP-M3 (above) adds `search`, `fetch`, `orbit_profile`, `marketing_project_status` and `support_insights`.

- **Merging is a production change.** A merge to `main` auto-deploys, so it applies to production regardless of the flag:
  - the migration `202610180010_mcp_run_kind` widens `AgentRun_kind_check` so `'mcp'` is a valid run kind (drop and re-add of a check constraint on `AgentRun`; the table is locked briefly while the check is validated, and every existing row already satisfies the wider check);
  - the dependency `@modelcontextprotocol/server` 2.3.1 (exact pin, with its `@modelcontextprotocol/core`);
  - three config keys that pass through the compose file to the api and worker (`ORBIT_MCP_GATEWAY`, `MCP_PORT`, `ORBIT_MCP_ALLOWED_ORIGINS`), all inert while no service runs the gateway.

  Nothing else runs: no compose service starts `mcp-main.ts`, there is no Traefik route, and the web proxy and the API server are unchanged. The merge needs Mario's explicit approval (production migration, new dependency).
- **What runs.** `apps/api/src/mcp-main.ts` is a separate process (`pnpm mcp:start`, `tsx apps/api/src/mcp-main.ts`) with its own Fastify app, built by `buildMcpServer` in `apps/api/src/platform/mcp/server.ts`. It is the composition root of that process (registers the modules), binds `BIND_HOST`:`MCP_PORT`, and on SIGINT or SIGTERM closes the app and then the database once and exits 0, or 1 when a close step fails (the failing step is logged by error name; `platform/mcp/shutdown.ts`). It imports only config and the guard before checking the flags, so with a flag off it exits 1 with a clear message and the API and web are untouched. Isolation from the UI API: a separate process and event loop; it shares the database (and the JWKS refresh through the public origin) with the API, so heavy MCP load can still reach the API through those.
- **Flags and config.**
  - `ORBIT_MCP_GATEWAY` (default `false`): the gateway starts only when this and `ORBIT_MCP_OAUTH` are both `true`; `buildMcpServer` throws otherwise. The API and web ignore it.
  - `MCP_PORT` (default 4312) and `ORBIT_MCP_ALLOWED_ORIGINS` (comma list, empty allows none) use the `unset()` helper, so an empty compose value means unset.
  - Decision: `MCP_PORT` stays validated in the shared base config (`packages/config`), like every other key, so the API and worker also reject an invalid value at start. The compose default (`${MCP_PORT:-4312}`) keeps it valid; setting a non-numeric or out-of-range value in Coolify would stop the API and worker, not only the gateway. Moving the check into the gateway guard was not chosen, so a typo fails at deploy instead of silently.
  - All three are in `docker-compose.yml` (`x-api-environment`), `.env.example` and `scripts/check-coolify-compose.mjs`.
  - `MCP_RESOURCE`, the issuer and the OAuth flags are the WP-M1 keys.
- **Routes.**
  - `POST /mcp` (body limit 256 KB; 413 above it).
  - `GET /mcp` and `DELETE /mcp` answer 405 with `Allow: POST`; there is no route for other methods.
  - Protected Resource Metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp` and at the root `/.well-known/oauth-protected-resource`; both describe the same resource, the issuer and the scopes.
  - `/healthz`.
  - A request with an `Origin` header is refused with 403 (before any token use) unless the origin is in `ORBIT_MCP_ALLOWED_ORIGINS`; no CORS headers or `OPTIONS` handling exist. Cookies are ignored.
- **Protocol.** SDK `@modelcontextprotocol/server` 2.3.1 through `createMcpHandler(factory, { legacy: "stateless" })` (D-M2-7): one factory serves revision 2026-07-28 and the legacy era (2025-11-25 and older revisions the SDK accepts), without sessions (no `mcp-session-id`). A fresh `McpServer` is built per request for the resolved principal. `subscriptions/listen` is refused with JSON-RPC -32601 after authentication; every JSON-RPC batch is refused with HTTP 400 and -32600 since WP-M3; `listChanged` is false (events are WP-M6).
- **Authentication.** `requireMcpAuth` from the Better Auth MCP plugin checks signature, `iss` (`${APP_ORIGIN}/api/auth`), `aud` (must include `MCP_RESOURCE`), `exp` and DPoP, with a `jwksUrl` that defaults to `${APP_ORIGIN}/api/auth/jwks` and is fetched over HTTP (5 minute cache). The principal is resolved on every request (`platform/mcp/principal.ts`): effective scopes are the token `scope` ∩ the grant's scopes; the grant must be active, unexpired and its user still a workspace member (`activeGrantForToken`); each granted project is re-checked with `actorScope` (`projectMembership`, so module roles apply: SECURITY_REVIEW O-6). A missing, invalid or foreign token gets 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`. A verified token whose grant was revoked in between gets that challenge on every method except `tools/call`; a `tools/call` is answered with an `isError` `UNAUTHENTICATED` result carrying the challenge in `_meta["mcp/www_authenticate"]`.
- **Permission intersection** (`authorizeMcpCall`, matrix in `mcp-principal.integration.test.ts`). Effective permission = tool permission ∩ the user's current role in the project (including module roles) ∩ the grant (projects, scopes, modules) ∩ module activation. Scope mapping: `R0_read` needs `orbit:read`, `P_proposal` needs `orbit:propose`; `W0_internal` needs `orbit:write`, which is not offered, so such tools never appear. Hard floors never appear. A grant restricted to modules is fail-closed for platform-owned tools (hidden unless `platform` is listed).
- **Registry adapter** (`platform/mcp/adapter.ts`). A tool is exposed only with `exposure.mcp === true` and an `outputSchema` that is a zod object (`defineTool` and `registerContributions` refuse an MCP-exposed tool without one, or with an array, scalar or union output schema, naming the tool; `exposure.assistant === false` also keeps a tool out of the in-app assistant). Names are `<owner>_<name>` unless the name already has the owner prefix or the owner is the platform. The input schema is the tool's parameters as a strict object plus `projectId` (a uuid, optional when the principal has exactly one project); a tool that declares its own `projectId` is left out. Annotations follow `09` §5.1 with `openWorldHint` always explicit; `_meta.securitySchemes` names the scopes. A call runs `authorizeMcpCall`, parses the arguments, and calls `execute` with the module scope and `channel: "mcp"`. The result's `structuredContent` is the output parsed against `outputSchema` (output that does not parse, including extra keys, is `REQUEST_FAILED` and never sent), `content` is a JSON text copy, cards are dropped, and output above 64 KB is `OUTPUT_TOO_LARGE`. Handlers never throw: a `DomainError` or `KnowledgeError` becomes an `isError` result with the code, the REST message and `retryable`; a tool's own `ZodError` becomes `VALIDATION_FAILED: <paths>`; anything else is the fixed text `request failed (request id <uuid>)`. Arguments refused by the SDK's schema check come back as an `isError` "Invalid arguments" result naming paths, not values (HTTP 200, not JSON-RPC -32602). Module activation rows are read only when needed: the read is skipped while `ORBIT_MODULES` is off and no available opt-in module owns an MCP-exposed tool, because the answer is the same.
- **Native tool.** `orbit_projects` (R0, `orbit:read`; `platform/mcp/native-tools.ts`) returns the grant's workspace and projects (name order) with each project's enabled modules, visible to the role and within the grant. Native tools are for workspace-level data that needs no project scope (D-M2-4); WP-M3 adds `orbit_profile`, `search` and `fetch`.
- **Audit and telemetry** (`platform/mcp/audit.ts`, awaited before the response, never failing the call). A call within a project writes `AuditEvent` `mcp.tool_call` (resource id = the gateway's request id; metadata: tool, client id, grant id, outcome code, duration, `argsHash`). A project-less call writes `McpGrantEvent` `mcp.call` (D-M2-3, no new table). `argsHash` is an unsalted SHA-256 of the key-sorted arguments; argument values, results and error messages are stored and logged nowhere. Calls the SDK refuses (unknown or unlisted tool, invalid arguments) are audited as `INVALID_PARAMS`. A client-supplied tool name is stored (audit metadata, call log, run task class, span name) only when it matches the registry name pattern and names a native or registered tool; anything else is stored as `<unknown>`. Each call with a project also records an `AgentRun` of kind `mcp` (agent name `mcp:<clientId>`, task class = tool, one `tool_call` span), except a refused call to an unknown tool, which gets its audit row only; project-less calls get no run (`AgentRun.projectId` is required). `McpGrant.lastUsedAt` is updated at most once a minute per grant.
- **Limits** (`platform/mcp/limits.ts`, in process, fixed one-minute window, D-M2-5). Per grant 120, per user 240, per client 600, and 30 per client IP for requests without a valid token. Every authenticated request counts, not only `tools/call` (a stateless client sends about two or three requests per interaction). The grant, user and client buckets are keyed from the verified claims (`grant:<sub>|<azp>|<orbit_workspace_id>`, the tuple the grant is looked up by, `user:<sub>`, `client:<azp>`) and charged before the principal is resolved, so a refused request runs no grant or membership query. All refusals are HTTP 429 with `Retry-After`, answered before the SDK (no tool-level `RATE_LIMITED`) and logged by bucket label only; they write no database rows. `resolvePrincipal` checks the granted projects' memberships at most four at a time (`MEMBERSHIP_CHECK_CONCURRENCY`), never as an unbounded fan-out. The client IP is the right-most `X-Forwarded-For` entry, honoured only from a trusted peer.
- **Decisions D-M2-1…7** (controller rulings, reported in the PR):
  1. The production `mcp` compose service and the Traefik `/mcp` route are WP-M5 (Q-22 placement unchanged).
  2. Token verification uses the library's `requireMcpAuth`; amended: it verifies against the JWKS over HTTP, not in process (Better Auth 1.7.10 has no in-process key path). An internal JWKS URL is a WP-M5 decision (`buildMcpServer({ jwksUrl })` is the seam).
  3. Project-less call logging reuses `McpGrantEvent` instead of a new `McpCallLog` table.
  4. Gateway-native tools live in `platform/mcp/native-tools.ts`; module tools come only through the adapter.
  5. Rate limits are in process, per gateway.
  6. Origin policy as above; amended: no CORS (browser MCP clients are out of scope for WP-M2).
  7. `legacy: "stateless"`, from the Task 0 findings.

  Amendments: a tool outside the principal's scopes is neither listed nor callable ("Tool not found"), with no 403 step-up challenge (stricter than `09` §6.4; re-consent works); all refusals are 429 before the SDK; every authenticated request counts toward the limits.
- **Task 0 findings** (details at the end of the plan; characterization tests in `mcp-sdk.characterization.test.ts`). `createMcpHandler` takes a factory called once per request; a tool handler's thrown error text reaches the client, so handlers must not throw; invalid tool arguments are an `isError` result, not -32602; the legacy leg of the SDK serves 2025-11-25 and older revisions without sessions; 2026-07-28 has `server/discover` instead of `initialize`.
- **Tests.**
  - `mcp-sdk.characterization.test.ts`: the SDK's behaviour.
  - `mcp-principal.integration.test.ts`: the permission matrix and claims without an active grant.
  - `mcp-gateway.integration.test.ts` (29 tests): transport, discovery, tokens (foreign `aud`/`iss`, revoked grant), `tools/list`, `tools/call`, the legacy revision, the process, the observer.
  - `mcp-gateway-audit.integration.test.ts` (32 tests): audit, call log, telemetry, `lastUsedAt`, argument values stored nowhere, client-supplied tool names (`<unknown>`, no run), rate limits (including: a 429 resolves no principal; the grant bucket is per grant), `subscriptions/listen`, shutdown.
  - `apps/api/src/platform/mcp/gateway-guard.test.ts`, `registry.test.ts`, `module-contributions.test.ts`, `config-compose-empty.test.ts`: flag guard, exposure rules, config.
  - Mapping to the roadmap acceptance: `docs/REQUIREMENTS_TRACEABILITY.md` ("Track M WP-M2 acceptance").

**Known limitations (accepted for WP-M2).**
- No module tool is exposed to MCP yet; the gateway lists `orbit_projects` and nothing else in production code. Only test fixtures expose tools (`task_digest`, `suggest_task`). (WP-M3 adds `search`, `fetch`, `orbit_profile`, `marketing_project_status` and `support_insights`; see "Track M WP-M3" above.)
- Browser MCP clients cannot read responses (no CORS). ChatGPT calls server-side without an `Origin`.
- A stateless client's `tools/list` polling consumes the call budget (every authenticated request counts).
- The `argsHash` is unsalted, so low-entropy arguments could be guessed from the hash by someone with read access to the audit table.
- A SDK-refused call is audited as one code, `INVALID_PARAMS`; other SDK refusals are not audited. A refused batch (WP-M3) is not audited either.
- Project-less calls have no `AgentRun`; they appear in `McpGrantEvent` only.
- JSON-RPC batches: the WP-M2 gateway let the SDK answer a batch containing `tools/call` as an unknown tool. Since WP-M3 the gateway refuses every batch with HTTP 400 and -32600 after the token check and the limits (see "Track M WP-M3" above).
- The DPoP-bound token path has no gateway-level test; the protected resource metadata omits `dpop_signing_alg_values_supported`.
- Per-call tool visibility is computed over all granted projects, and `resolvePrincipal` runs one membership query per granted project on each request (at most four at a time, and only after the request passed the rate limits).
- Other deferred review findings, none of which changes the security properties above:
  - the assistant's static byte estimate ignores `exposure.assistant === false` (inert today);
  - `parseAllowedOrigins` rejects a non-normalised origin with a generic message and accepts `http` origins for any host;
  - `exposure: { assistant: false, mcp: false }` is accepted silently;
  - the Origin policy also covers the metadata and health routes;
  - a `KnowledgeError` is always reported as not retryable;
  - a module role raise is not a case of the permission matrix.

**WP-M5 checklist (before `ORBIT_MCP_GATEWAY=true` and the WP-M1 pre-flip checklist below).**
- [ ] The compose service `mcp` (same image, command `tsx apps/api/src/mcp-main.ts`, healthcheck on `/healthz`) and the Traefik routes for `/mcp` and the two Protected Resource Metadata paths (Q-22, `https://orbit.eds-labs.io/mcp`, no subdomain).
- [ ] Decide an internal JWKS URL config key, so verification does not hairpin through the public origin (`buildMcpServer({ jwksUrl })` is the seam; a JWKS outage answers 503 without detail).
- [ ] Redis-backed limits if more than one gateway runs (limits are per process today).
- [ ] Verify peer trust and the right-most `X-Forwarded-For` behind Traefik, including docker-proxy published ports where the TCP peer looks like a private bridge IP (`isTrustedPeer` would then trust a forwarded header the proxy did not set).
- [ ] Tune the limits for shared client egress IPs (ChatGPT calls from a few addresses): 401 polling by many users fills one IP bucket of 30 per minute, and every authenticated request (also `tools/list`) counts toward the grant, user and client buckets.
- [ ] Keep the compose default for `MCP_PORT` (validated in the shared base config, so an invalid value stops the API and worker too; see "Flags and config").
- [ ] Key the unauthenticated limit by the IPv6 /64 prefix and cap the limiter map size (IPv6 address rotation evades the per-IP limit today; the map only drops expired windows).
- [ ] Verify before the IP limit: a request with a bad token is verified (JWKS work) before it is counted.
- [ ] The adapter's pre-validation skips the SDK's `maxToolInputElements` and would throw on async schema refinements; align it or use the SDK's own check.
- [ ] A test with a DPoP-bound token, and advertise `dpop_signing_alg_values_supported` if DPoP is supported.
- [ ] MCP Inspector conformance for both revisions (2026-07-28 and 2025-11-25), plus the ChatGPT developer-mode run (Q-21, Q-23).
- [ ] Decide CORS for browser clients (today none).
- [ ] A forced-exit timeout in the shutdown path (a hung `app.close()` would block the exit).
- [ ] Salt or key the `argsHash` if audit read access is wider than needed.
- [ ] The independent security review (`09` §9), including the O-6 check that the scope is built through `projectMembership`.

**WP-M3 items (status after WP-M3; details in "Track M WP-M3" above).**
- Expose reviewed read tools with `outputSchema`s; filter results by `modelUse` and hard floors; render cards as Orbit links; add the native `search`, `fetch` and `orbit_profile`; add `orbit:propose` tools through ActionRequests. Delivered: `search`, `fetch`, `orbit_profile`, `marketing_project_status`, `support_insights` with the `modelUse` and eligibility filtering. Not delivered: cards as links (results carry a `url` instead) and the `orbit:propose` tools (WP-M4).
- Start the `mcp` `AgentRun` before `execute` and pass its id as `runId`. Delivered.
- Channel-aware budget keys `mcp:<grantId>:<date>` per `09` §6.3 instead of `chat:${runId}`. Superseded by D-M3-2: paid search uses per-call keys `mcp:<grantId>:<requestId>:<callId>[:<projectId>]`, not a daily key.
- ActionRequests from MCP carry `requestedBy: { kind: "mcp", clientId, grantId }`. Moved to WP-M4.
- Refuse MCP exposure of tools that need a conversation (the package and proposal tools key rows by `conversationId`; the adapter passes a synthetic `mcp:<requestId>`). Open for WP-M4: the two WP-M3 registry tools are read-only and do not key rows by conversation.
- Review per tool that its arguments are parsed twice (the SDK's schema check, then the adapter's `parameters.parse`). Delivered for the two WP-M3 tools (a note in each tool file).
- `09` §7 global concurrency per project (R-10) and tool-execution timeouts. The 25 s timeout is delivered (D-M3-11); concurrency is a WP-M5 item.

**Final review fixes (2026-10-18).** Limits are charged from the verified claims before `resolvePrincipal` (a 429 costs no database read) and membership checks run at most four at a time; refused calls store a client-supplied tool name only when it is a known tool name (`<unknown>` otherwise, and no `AgentRun` for an unknown tool); MCP exposure requires an object output schema. Test counts and the full run are in the verification below.

**Verification (local).** Full suite on a fresh per-worktree test database deployed from this branch (`node scripts/test-db-for-worktree.ts`, which applies `202610180010`): `vitest run` with the local env file, 212 files, 2107 of 2107 tests passed (after the final review fixes, on the database refreshed after merging `main`). `tsc --noEmit` (root and `apps/web`), `next build --webpack`, `scripts/source-check.mjs` (0 known import violations, none new), `python3 scripts/check-secrets.py` and `scripts/check-coolify-compose.mjs` pass. Not done: MCP Inspector conformance, a ChatGPT developer-mode run, a load test and the independent security review (WP-M5).

**Rollback.** Do not run `mcp-main.ts`, or keep `ORBIT_MCP_GATEWAY=false` (the process then refuses to start); nothing in production depends on it. Reverting the PR removes the code and the SDK dependency. The migration only widens a check constraint: leave it in place on a revert (it is unused without `mcp` runs); narrowing it again would fail on any existing `mcp` run row.

## UI restructure, phase 1: grouped sidebar (2026-10-18, local; no flag)

Spec `docs/superpowers/specs/2026-10-18-orbit-ui-restructure-design.md`, plan `docs/superpowers/plans/2026-10-18-orbit-ui-restructure.md`. Phase 1 changes the navigation only; the home page, the module overviews, settings and the attention endpoint follow in later phases, each as its own PR. There is no feature flag; rollback is a revert and redeploy.
- The route contract gets `ViewDef.navGroup` (`top`, `project` or a module id), `WebModule.groupOrder` and `NavEntry.mobileRank`. `routeTable` rejects other groups (`WEB_ROUTES_INVALID`).
- `platform/shell/nav-groups.ts`: `buildNavGroups` (top, enabled modules by `groupOrder`, project; a module counts as enabled when the shell's `moduleShown` says so, so disabled modules and modules with access `none` are left out) and `mobileEntries` (first four by `mobileRank`).
- `platform/shell/sidebar-nav.tsx` replaces the flat list: group headers are buttons with `aria-expanded` and `aria-controls`, a collapsed group shows the sum of its badges. Approvals sit in the Marketing group; the Knowledge tabs (Sources, Facts, Conflicts, Import, Library) have their own entries.
- The collapsed groups are kept per browser in `localStorage` (`orbit.nav.collapsed`, `platform/shell/nav-collapse.ts`). All groups are open by default. Navigating to a page opens its collapsed group (ruling R6); the open page's group is not locked, so its header still collapses it.
- The bottom bar on mobile is capped at four entries plus More. With support off it is Home, Orbit Chat, Approvals and Content; with support on (uLiquid in production) it is Home, Orbit Chat, Tickets and Approvals, and Content leaves the bar. The drawer shows the grouped sidebar.
- **Tests:** unit tests for the navigation model, the collapse helpers and the sidebar; `navigation.spec.ts` covers the grouped order of every page, collapse that survives a reload, a collapsed group opening on navigation, and the 390 px bar and drawer.
- **Run locally:** the e2e suite needs `.runtime/e2e-user.json` (`scripts/seed-e2e.ts`) and the app on the configured base URL.

## Several mailboxes per project (2026-10-18, local; draft PR)

Mario decided on 2026-10-18 that a project connects several real mailboxes (support@, partnerships@, hello@, maybe admin@ of uliquid.vip) and that each support inbox answers from its own address. Branch `claude/multi-mailbox-462e85`, draft PR, not merged; no flag is switched. Guides: `docs/EMAIL_AND_NOTIFICATIONS.md`, `docs/SUPPORT.md`.
- **Risk:** high. A production migration with a backfill, and the routing of customer mail. Tenant isolation is kept by a same-project composite foreign key.
- **Platform (`platform/email`).**
  - One mailbox per address: `email-connect` adds a mailbox for a new address and updates a known address in place (same id, back to `configured` until "Check login").
  - The default mailbox (member notifications, mail that names none) is the verified mailbox connected first. Today's single-mailbox projects keep the row they used (the oldest verified).
  - `queueEmail` takes an optional `connectionId`; the job sends From that mailbox with its Message-ID domain, and `EMAIL_NOT_CONNECTED` when it is not a verified mailbox of the project.
  - `email-inbound` fetches every verified mailbox with its own `email_inbound_state` and its own first sync (the #164 backlog rule); one failing mailbox does not stop the others. A bounce marks only messages the receiving mailbox sent.
  - New owner action `email-disconnect`: removes a mailbox and its state; refused with `EMAIL_MAILBOX_IN_USE` while a module uses it (`emailInbound.mailboxUse`).
  - `GET /api/projects/:id/email` lists `mailboxes` (status, default, in-use count, receiving state); `connection` and `inbound` still show the default mailbox.
- **Support.**
  - Migration `202610180005_support_inbox_mailbox` (additive): `SupportInbox.emailConnectionId`, a composite foreign key to `Entity("projectId", id)`, and a partial unique index (one live inbox per mailbox). Its backfill binds each live e-mail inbox to the mailbox of its own address.
  - An e-mail inbox must be bound to a verified mailbox of the project; its address is the mailbox's (`INBOX_MAILBOX_INVALID`, `INBOX_ADDRESS_NOT_MAILBOX`, `INBOX_MAILBOX_TAKEN`).
  - Routing goes by the receiving mailbox, then by To/Cc among the inboxes bound to it. Unbound inboxes from before keep the old rule, only for the default mailbox and only while no inbox is bound to it.
  - Replies, acknowledgements and ticket mail go through the ticket inbox's mailbox. New route `GET /support/mailboxes` (settings permission) for the inbox form.
- **Web.** The connectors page lists the mailboxes (status, default, in use, last fetch) with add, update, check login and remove (disabled while in use). The inbox form picks its mailbox instead of typing an address. German and English copy.
- **Tests:**
  - `email-mailboxes.integration.test.ts`: add versus update, the default rule, a named mailbox's From/password/Message-ID, a foreign connection refused, two mailboxes fetched separately with their own first sync, bounces per mailbox, removal.
  - `support-mailboxes.integration.test.ts`: routing by the receiving mailbox despite a copied To, replies and acknowledgements from the bound address, refused claims, removal refused while in use, the legacy single-mailbox setup before and after the backfill, and no routing by a typed address on a new mailbox.
  - The RLS matrix covers a cross-project binding (foreign key) and the project delete with a bound inbox. The existing support tests bind their inboxes, and the access matrix and OpenAPI are updated (`openapi.json` was stale on main and is regenerated in full).
- **Rollout (after approval).**
  1. Merge; the deploy runs the migration. The existing inbox "Support" (support@uliquid.vip) is bound to its mailbox by the backfill. Without a backfill match it keeps working on the old rule.
  2. Check: `SELECT name, "emailAddress", "emailConnectionId" FROM "SupportInbox"` shows the binding, and new mail to support@ still opens tickets in "Support".
  3. Mario adds partnerships@ and hello@ under Connectors → E-mail mailboxes → Add mailbox, then runs "Check login" for each. Each new mailbox's first sync takes only its unread mail as backlog, without acknowledgements.
  4. Support settings → New inbox → pick the mailbox (e.g. "Partnerships" on partnerships@uliquid.vip).
- **Rollback.** Redeploy the previous main commit. The column, key and index stay unused. The old code routes by address and sends through the oldest verified mailbox, which is support@ as today. Added mailboxes are then neither fetched nor used, and their inboxes stop receiving. Dropping the column would need its own approved migration.

## Support tags like Chatwoot labels (2026-10-18, local)

Mario asked for this on 2026-10-18.
- **Tag list.** The support settings get `tags`: a key, a label and a colour from a fixed palette (gray, blue, green, yellow, orange, red, purple, pink), at most 50. Settings saved earlier get an empty list from the defaults.
- **On tickets.** Tickets take several tags. A newly added tag must be listed (`TAG_UNKNOWN`). A tag the list later dropped may stay. Renaming a tag keeps its key, so tickets keep it.
- **Filters and statistics.** `GET /tickets` and `GET /stats` filter by `tag`. Volume counts tickets `byTag`.
- **Web.**
  - The settings get a tag editor (label and colour; the key comes from the label when it is saved).
  - The ticket view toggles coloured tags and gets the category select it lacked.
  - The ticket list filters by category and tag and shows tag chips.
- **Release.** No migration, because `SupportTicket.tags` already exists. Rolling back is a redeploy.

## E-mail first sync takes unread mail only (2026-10-18; ORBIT_EMAIL on)

Mario asked for this on 2026-10-18 while connecting support@uliquid.vip, whose INBOX already held old mail.
- Before this change, the first sync fetched every INBOX message from UID 1, read or not. Support would also have acknowledged each one.
- The first sync, and the first after a UIDVALIDITY change, now takes only the unread mail up to the INBOX's highest UID at that moment. It takes it in batches of 25 and marks it `backlog`; afterwards, every new message is fetched.
- Support opens tickets for backlog mail but sends no acknowledgement.
- `MailboxReader` gains `scan()` (UIDVALIDITY, the highest UID, the unread UIDs) and `fetchUids()`.
- **Tests:** in `email.integration.test.ts`, the first sync takes only unread mail over two passes, then new read mail is fetched; a UIDVALIDITY change does the same. In `support-email.integration.test.ts`, backlog mail gets no acknowledgement.
- **Production:** in the uLiquid mailbox, nothing has been fetched yet (`FILES_NOT_CONFIGURED`), so its first sync uses the new rule once `ORBIT_FILES` is on.

## Support module release (2026-10-18; flag off)

Mario approved on 2026-10-18 the merge and deploy of the whole support stack: WP5.1–WP5.8 and the review fixes (#145, #154, #156–#162). It is released as one merge of #162 into main, so production deploys once. The stacked PRs are closed as merged through #162.
- Migrations `202610180001`–`202610180004` are additive. The support tables are new. The `File` table gets a `(projectId, id)` unique key, and the `SupportMessage` and `AgentRun` check constraints are widened.
- `ORBIT_SUPPORT` stays `false`, so the support routes, the public widget API, the jobs and the tools stay unavailable.
- Before the pilot, the open items of `plans/orbit-modularization/10-support-pilot-decisions.md` remain:
  - the legal checks;
  - the Desk-side embed and HMAC PR;
  - the pilot mailbox;
  - a separate approval to switch the flag on.
- **Rollback:** redeploy the previous main commit `fe6594f`. The new tables and constraints stay; they are unused while the flag is off.

## Support review fixes (2026-10-17, local; flags off)

Branch `claude/support-review-fixes`, stacked on WP5.8. A fresh review of WP5.2–WP5.8 found no critical issue and 12 important ones. All 12 are fixed, each with a test that failed first:
1. Claimed addresses are never mailed. Header and token threading need the ticket contact's own address.
2. Tickets of two contacts are not merged. Erasure also removes the contact's messages in other tickets.
3. Placeholders cover every form of the name and the e-mail local parts.
4. Triage screens before calling the model.
5. A job's paid call is keyed to the job and never repeated.
6. A daily support AI cap applies, and anonymous widget visitors get no AI.
7. Raw-mail retention keeps only dedupe fields, drops the history, and does not stall.
8. Erasure covers unlinked inbound mail and contact tombstones; the evidence query is scrubbed after a draft.
9. The delivery sync is ordered and bounded.
10. The widget key's origins follow the inbox, and the key is revoked with the widget.
11. An agent's draft request works after a handoff.
12. Last-seen is throttled and unversioned.

The minor findings are deferred and listed in the PR.

## Support privacy and operations: WP5.8 (2026-10-17, local; flag off)

Branch `claude/wp58-support-privacy`, stacked on WP5.7. Guides: `docs/SUPPORT.md` (Privacy and operations) and `docs/OPERATIONS.md` (Support runbook).

- **Export and erasure per contact** (owners). Erasure covers the rows, the files, the mailbox rows of sent and received mail with their raw files, the identities and the widget sessions.
- **Daily retention by the Q-12b settings** (closed tickets, AI drafts, sessions, orphan contacts, raw mail files).
- **Abuse caps** for widget conversations and messages, and for e-mail tickets per sender.
- **The canary test**: no text in audit, events, telemetry or notifications.
- **A runbook** for mail outage, widget abuse, the AI kill switch and privacy operations.
- **Tests.** `support-privacy.integration.test.ts`, 5 tests: export, erase, retention, canary, sender cap. Plus the widget conversation cap.
- **Blocks the pilot until done; now done.** The pilot (WP5.9) still needs the legal checks in the decision note.

## Support statistics: WP5.7 (2026-10-17, local; flag off)

Branch `claude/wp57-support-stats`, stacked on WP5.6. Guide: `docs/SUPPORT.md` (Statistics).

- **Aggregation.** `modules/support/stats.ts` computes on read over tickets, events, messages and reservations: volume, first-response and resolution medians and means, backlog ages, reopen rate, SLA attainment and breaches, AI use (drafts used, unchanged or edited, withheld, handoffs) and AI cost. It applies the filters for range, inbox, category and agent.
- **Routes.** `GET /stats` and `GET /stats/export` (CSV).
- **Web.** Support > Statistics.
- **Tests.**
  - `support-stats.integration.test.ts` checks a hand-computed fixture with 4 tickets, the filters and the CSV.
  - The web helper tests cover the range, durations and rates.

## Support AI: WP5.6 (2026-10-17, local; flags off)

Branch `claude/wp56-support-ai`, stacked on WP5.5. Guide: `docs/SUPPORT.md` (Support AI). Decisions: Q-12a option B (OpenAI with safeguards) and Q-17 (drafts only).

- **Task classes.** `support_triage` and `support_draft`, in the routing and the routing settings.
- **Run kind.** `support`, from migration `202610180004_support_ai`, which widens a check constraint.
- **`modules/support/ai.ts`.**
  - Personal-data placeholders, and a paid call with reservation, settlement and telemetry that is never retried after a transmit.
  - Triage, and drafts grounded in `support`-audience evidence with citation and evidence checks.
  - The handoff state, the jobs, `queueSupportAi` on new tickets and customer messages, the cost per ticket, and an agent-requested draft.
- **Hard rules.** `modules/support/hard-rules.ts`, with the offline eval `evals/support/hard-rules-v1.json` (20 customer and 7 draft cases).
- **Assistant.** The tool `support_insights` (counts only).
- **Web.** AI draft cards with "Use draft", an "AI draft" button and the AI cost on the ticket.
- **Tests:**
  - `support-ai.integration.test.ts`, 7 tests, with a mocked model and retrieval, mutation-checked for placeholders;
  - the eval (3 tests);
  - the render test.
- **Paid eval.** Approved by Mario on 2026-10-17, capped at 3 USD. `pnpm eval:support` (`evals/support/live.eval.ts`) ran once on commit `15eacc3`, with real model calls only and synthetic evidence. Result: **FAIL** (`docs/evidence/support-ai-eval-2026-10-17.json`), cost **$0.0227**.
  - Triage: category 12/12, language 12/12, sensitive recall 4/4.
  - Drafts: 6/6 answered with citations; 0 forbidden phrases; 0 errors.
  - Handoff on unanswerable questions: 1/2, which missed the pre-registered rule. D04 ("Solana deposits?") produced a draft that cites the supported-networks fact instead of handing off. The case note allows a draft that says Solana is not listed, but the pass rule demanded a handoff. The rule was not changed afterwards.
  - Run 2 on commit `ed6096b`, after the review fixes and a sharpened instruction (never answer from what the evidence does not name; hand off). Result: **FAIL** (`docs/evidence/support-ai-eval-2026-10-17-run2.json`), cost **$0.0221**. The total spent so far is $0.0448.
    - Handoff: 2/2, so D04 is fixed. Drafts: 6/6 with citations; 0 forbidden phrases; 0 errors; sensitive recall 4/4.
    - Triage category and language: 10/12. The misses are T09 (`trading`) and T11 (`billing`). Review fix 4 hands both off before the model is called, so they have no model category or language. This was checked locally with `screenCustomerText`. The eval's scoring predates fix 4. The rule was again not changed afterwards.

## Support notifications and automations: WP5.5 (2026-10-17, local; flags off)

Branch `claude/wp55-support-automations`, stacked on WP5.4. Guide: `docs/SUPPORT.md` (Notifications and automations).

- **Notifications.** Seven member notification kinds (WP4.7). Their titles carry no text; e-mail is on by default only for assigned, breached and handoff.
- **Automations.**
  - Auto-assign (fixed, round robin).
  - A scheduler contribution for SLA at risk and breach (once per clock) and auto-close, with `nextDueAt`.
  - The hooks in ticket creation, customer replies, assignment, mentions and handoff.
- **Per-inbox switches.** `rules` on the inbox, from migration `202610180003_support_inbox_rules` (additive), with checkboxes in the inbox form.
- **Tests.** `support-automations.integration.test.ts`, 7 tests, with the sweep run at given times. They cover recipients, auto-assign, mentions, replies, SLA once each, auto-close with its switch, the inbox rules, a muted kind, and the sweep while support is off.

## Support livechat widget: WP5.4 (2026-10-17, local; flags off)

Branch `claude/wp54-support-widget`, stacked on WP5.3. Guides: `docs/SUPPORT.md` (Livechat widget) and `docs/SUPPORT_WIDGET.md` (app teams, Desk pilot checklist for Q-20).

- **Public API.** Identify (anonymous or HMAC-verified), conversations, messages, handoff and a stream with resume. Visitors see only their own conversations.
- **Widget.** `apps/web/public/widget/v1.js`: framework-free, Shadow DOM, DE/EN, keyboard, stream with a polling fallback, silent on failure. 5.6 KB gzip.
- **Delivery.**
  - A reply is `sent` in the widget while the visitor is online, else mailed through WP5.3.
  - Mail threading now also finds widget messages, and the subject token also accepts the claimed address.
- **Platform.**
  - `PublicRoute.stream`, with `serveEventStream` headers.
  - The web proxy forwards `Authorization` under `/api/public/`. This fixes WP4.2b behind the proxy.
- **Web.** An owner "Widget embed" button with a snippet (`embedSnippet`, JSON-escaped).
- **Tests:**
  - `support-widget.integration.test.ts`, 6 tests: visibility, HMAC, notes never shown, handoff, stream with CORS and resume, identity required, foreign origin, off;
  - widget script tests, 5;
  - the snippet test;
  - the proxy test;
  - the access matrix.
- **Not run:** `apps/web/tests/support-widget.spec.ts`, the cross-origin embed and agent reply plus H05. It needs a support-enabled stack (`E2E_SUPPORT=1`).
- **Not in the MVP:** widget attachments, because the public API takes JSON only.

## Support e-mail channel: WP5.3 (2026-10-17, local; flags off)

Branch `claude/wp53-support-email`, stacked on WP5.2. Guide: `docs/SUPPORT.md` (E-mail channel).

- **Inbound.** A `support_email_inbound` job on the WP4.7 mailbox:
  - routing, threading by headers or by subject token (only from the ticket's contact), and reopening;
  - attachments from the raw MIME;
  - dedupe, loop protection and capped acknowledgements.
- **Outbound.** `deliverMessage` queues replies through `queueEmail`, and the periodic `support-email-delivery` maps the outcome. Migration `202610180002_support_bounced` widens one check constraint.
- **Tests.** `support-email.integration.test.ts`, 9 tests, with IMAP and SMTP stubs and an object store double.
- **Production.** Receiving needs `ORBIT_EMAIL`, `ORBIT_FILES` and the mailbox, plus `ORBIT_SUPPORT` and the module. Each is a separate approval.

## Support agent workspace: WP5.2 (2026-10-17, local; flag off)

Branch `claude/wp52-support-workspace`, stacked on WP5.1. Plan: `docs/superpowers/plans/2026-10-17-phase5-support-mvp.md`. Guide: `docs/SUPPORT.md` (Agent workspace).

- **API.**
  - Ticket lists with views, filters, search and a cursor; the timeline.
  - Replies (pending until the channels deliver them) and internal notes.
  - Field changes with events, and SLA recomputed on a priority change.
  - Ticket and contact merges, agents and the summary.
  - Attachments, inbound ones included, must be live support files of the project.
- **Web.**
  - The `support` module: inbox, ticket view, composer, contacts, settings tab and home tile.
  - New: `WebModule.optIn` and `moduleShown`. A module the loaded states do not list is hidden, and opt-in modules stay hidden until the states load. Before, such a module counted as enabled.
- **Tests:**
  - `support-workspace.integration.test.ts`, 8 tests;
  - the web helper and render tests, 6 tests (mutation-checked);
  - shell visibility and navigation;
  - the access matrix (12 new closed routes).
- **Not run:** the Playwright support flow. It comes with WP5.4, the first public channel that creates tickets.

## Support module skeleton: WP5.1 (2026-10-17, local; flag off)

Branch `claude/phase-5-support-mvp-pilot-201bc2`, the first work package of Phase 5. Plan: `docs/superpowers/plans/2026-10-17-wp51-support-skeleton.md`. The decision note is `plans/orbit-modularization/10-support-pilot-decisions.md`.

Mario decided on 2026-10-17:
- Q-12a option B: OpenAI with mandatory safeguards for support;
- Q-12b: 24-month retention;
- Q-13: the uLiquid project with module roles;
- the pilot starts with the mailbox and the Desk widget.

The operating guide is `docs/SUPPORT.md`.

- **Module.** `modules/support`:
  - the manifest, which is off by default;
  - seven permissions, `support.settings.manage` owner-only;
  - the settings schema with the Q-12b defaults.
- **Opt-in twice.**
  - `ORBIT_SUPPORT` (default `false`) must be on. New: `ModuleContributions.available`. While a module is unavailable, it is left out of the module list, enabling and module roles, and `ownerEnabled` refuses its contributions.
  - Modules that are off by default count only where an owner enabled them, even while `ORBIT_MODULES` is off (`enabledModules`).
  - The project needs an explicit enabled `ProjectModule` row.
- **Data.** Migration `202610180001_support_core` adds eight tables, including a per-project ticket counter:
  - FORCE RLS and `orbit_app` grants;
  - same-project composite foreign keys, plus a new unique key on `File` (`projectId`, `id`);
  - a full-text trigger on messages.

  It is additive.
- **API.** Settings (`platform/modules/settings.ts`, generic, versioned, audited without values) and inbox management. The widget secret is encrypted, shown once and never audited.
- **Domain.** `createTicket`:
  - numbers from the per-project counter, never reused;
  - contacts by identity or e-mail; a verified user id joins a contact by e-mail only when the e-mail is verified too;
  - idempotent per channel message;
  - SLA due times from the settings;
  - attachments only from the same project's files.

  The `SupportChannelAdapter` contract consists of types only.
- **Tests:**
  - `support-inboxes.integration.test.ts`, 8 tests: the gate states, the secret shown once and dropped with the widget channel, validation, versions, settings (older saved settings filled with defaults) and roles;
  - `support-tickets.integration.test.ts`, 10 tests: parallel numbering, no reuse after deletion, contacts, verified-only e-mail binding, idempotency, SLA, the gate, the opt-in enabled set, attachments, and no text in audit or event rows;
  - `settings.test.ts`;
  - the RLS matrix: eight tables seeded, a cross-project insert, a foreign key across projects refused, and a project deleted with its support rows;
  - the access matrix: seven new routes, all closed;
  - the module activation and roles tests, while support is unavailable.
- **Production.**
  - Merging brings the migration, which needs approval. `ORBIT_SUPPORT` stays `false`.
  - Enabling it belongs to the WP5.9 pilot, after WP5.2–WP5.8 and the legal checks in the decision note.

## Platform files in the database: WP4.6 backend B (2026-10-17, local; flag off)

Branch `claude/files-database-backend`. Mario chose on 2026-10-17 to keep files, including raw inbound e-mail, on the server instead of in an R2 bucket for the pilot, inside the database.

- **Data.** Migration `202610170010_file_blob` (additive) adds `FileBlob(key, workspaceId, projectId, data)`:
  - FORCE RLS project policy and `orbit_app` grants;
  - a check constraint ties the key to its project;
  - the content is deleted with the project.
- **Backend.** `platform/files/db-store.ts` implements the same `ObjectStore` interface as the S3 client; it refuses another project's key. `FILES_BACKEND=database` is the default, and `s3` keeps the bucket path.
- **Configuration.** The database backend needs only `FILES_ENCRYPTION_KEY`; Compose fills it from Coolify's generated `SERVICE_HEX_64_FILESKEY`. So switching files on needs no manual secret, only the flag after the review.
- **Tests.**
  - `files.integration.test.ts` runs the S3 path explicitly (`FILES_BACKEND=s3`) and adds the database backend: encrypted at rest, round trip, isolation, deletion, project cascade. A mutation check confirmed it: without the cascade, the test fails.
  - The RLS matrix seeds and isolates `FileBlob`.
  - The compose check pins the generated key.
- **Production.** Merging brings the migration (approval). Coolify generates the key on that deploy. `ORBIT_FILES` stays `false` until the WP4.6 security review is done.
- **Security review (2026-10-17).** Section 7 of `docs/SECURITY_REVIEW.md`:
  - D-1: a project quota, `FILES_PROJECT_QUOTA_BYTES` (default 100 MB), bounds the database and the backup, whose work space is a 512 MB tmpfs;
  - D-2: the restore runbook requires a copy of `FILES_ENCRYPTION_KEY`.
  - Mario must copy the generated key into the password manager after the first deploy.

## Track M WP-M1: OAuth authorization server, consent and grants (2026-10-17, local)

Branch `claude/track-m-mcp-gateway-phase-4-657900`. Plan: `docs/superpowers/plans/2026-10-17-track-m-wp-m1-oauth.md` (decisions D1–D7 approved by Mario on 2026-10-17; Task 0 findings are at its end). Risk: high (new authentication surface). Environment: local only so far. There is no MCP endpoint yet (WP-M2).

- **Merging is a production change.** A merge to `main` auto-deploys, so it applies to production regardless of the flag: the additive migration `202610170009_mcp_oauth` (ten new tables, one partial unique index, `orbit_auth` grants from `db-deploy`) and the Better Auth patch upgrade 1.7.5 → 1.7.10 (with `better-call` 1.4.2 and `@better-auth/utils` 0.5.0). AGENTS.md treats both as needing explicit approval (production migration, dependency change): the merge itself needs Mario's explicit approval. The flag flip, the Traefik and route decisions and the ChatGPT run remain WP-M5.
- **Post-deploy smoke test (after the merge, flag off).** Sign in; `GET /api/auth/get-session` returns the session; a request after the renewal threshold sets a renewed (sliding) session cookie; sign out; Settings loads and the Connected apps tab is hidden; `GET /api/health/ready` is ok.
- **Flags (all default off).**
  - `ORBIT_MCP_OAUTH=false`: no OAuth plugin, route or table access is registered; session login and the `/api/auth/*` responses are unchanged, with these exceptions: the Better Auth dependency upgrade above applies anyway; `disabledPaths: ["/token"]` is set unconditionally (no effect, `/api/auth/token` is only registered by the `jwt()` plugin); the web proxy always sends the proxy-only `x-orbit-sec-fetch-mode` header, which the API strips; the `/connect` web pages exist and render a generic failure; Settings probes `GET /api/mcp-grants` (404) to decide whether to show Connected apps.
  - `ORBIT_MCP_DCR=false`: dynamic client registration stays closed; when on, Better Auth limits registration to 5 per minute per IP.
  - `MCP_RESOURCE` (blank): token audience and resource, default `${APP_ORIGIN}/mcp`; must be https (loopback http only) without query, fragment or credentials. Every configured resource needs `allowedScopes` (Prisma list `null` caveat).
  - `ORBIT_MCP_CIMD_HOSTS=chatgpt.com`: hosts (exact or subdomain) whose client metadata documents Orbit may fetch.
  - All four pass through `docker-compose.yml` (api and worker share the anchor); `scripts/check-coolify-compose.mjs` pins the defaults and the follow-through.
- **Endpoints (flag on).** Issuer `${APP_ORIGIN}/api/auth` (D2); `/api/auth/oauth2/*` (authorize, token, userinfo, consent, continue, revoke, introspect; register only with DCR); `/api/auth/jwks`; metadata at `/.well-known/oauth-authorization-server/api/auth` and `/api/auth/.well-known/openid-configuration`. `/api/auth/token` stays disabled and sign-in responses carry no `set-auth-jwt` header. Machine endpoints (token, revoke, introspect, and register only with DCR on) skip the browser Origin check and accept form bodies; authorize, consent, continue and userinfo are not exempt. Ingress is the existing web proxy plus a Next route for the root `/.well-known/*` paths (D3); the proxy forwards `Authorization` only for `/api/auth/oauth2/*` and sends the browser's `Sec-Fetch-Mode` as `x-orbit-sec-fetch-mode` so authorize answers 302 instead of JSON; the API strips that header with the flag off.
- **Orbit routes (flag on, else 404).** `GET /api/mcp-connect/request`, `POST /api/mcp-connect/selection`, `POST /api/mcp-connect/consent`, `GET /api/mcp-grants`, `GET /api/workspaces/:id/mcp-grants`, `DELETE /api/mcp-grants/:id`.
- **Web.** `/connect` (workspace, project and scope selection with consent), `/connect/login` (login that continues the authorization; plain sign-in is unchanged), `/connect/error`, and Settings → Connected apps (own grants, owner section for the workspace).
- **Data.** Migration `202610170009_mcp_oauth` (additive): the ten auth tables `jwks`, `oauthClient`, `oauthAccessToken`, `oauthRefreshToken`, `oauthConsent`, `oauthClientAssertion`, `oauthResource`, `oauthClientResource`, `McpGrant`, `McpGrantEvent`. They belong to `orbit_auth` (listed in `scripts/db-deploy.ts` `authTables`, owner entries in the module registry); `orbit_app` has no access.
- **Dependencies (D1).** `better-auth` 1.7.5 → 1.7.10; new `@better-auth/mcp`, `@better-auth/oauth-provider`, `@better-auth/cimd`, all exactly 1.7.10. Transitive: `better-call`, `@better-auth/core` and the adapters.
- **Decisions.** D2 issuer path as above; D3 ingress through the web proxy, the Traefik route is decided with `/mcp` in WP-M2; D4 scopes `openid email profile offline_access orbit:read orbit:propose` (no `orbit:write`); D5 CIMD host allowlist; D6 DCR off; D7 `email_verified` is `false` (Orbit has no e-mail verification).
- **Tokens.** Authorization code with PKCE S256 only plus `refresh_token`. Access token: JWT, 600 s, `aud` = `[MCP_RESOURCE, <userinfo endpoint>]` (WP-M2 checks that it includes `MCP_RESOURCE`), claim `orbit_workspace_id` from the consent reference. Refresh token: opaque, hashed, rotated, 30 s reuse window; a replay revokes the user's tokens of that client (stricter than per grant) and is audited as `token.refresh_replay`. Client authentication: `none` and `private_key_jwt`.
- **Security mechanisms.**
  - The workspace is Better Auth's consent reference, so consent, tokens and refresh families are per (user, client, workspace) (fixed upstream in 1.7.10, #11801).
  - One partial unique index allows a single active grant per (user, client, workspace); a selection replaces the active one and copies its scopes.
  - A code is issued only for an active grant (pending selections never yield one; refused redirects withhold the code; consent with claims is refused). This is not fail-closed without exception: consuming a selection is a read-then-update without a row lock (same-user concurrent replace window), and an abandoned selection can be reused once by the same client and session within 600 s (see limitations).
  - `resource` is required on authorize and must equal `MCP_RESOURCE` (400 `invalid_target`); the signed query is checked for expiry (`OAUTH_REQUEST_EXPIRED`) and tampering.
  - A refresh needs an active grant and `refreshAllowed` (no revocation of the same grant lineage at or after the token's creation, except replaced or superseded).
  - Revocation (user, owner, deny, client change) deletes the grant's outstanding authorization codes, consent and refresh tokens in one transaction and writes a `McpGrantEvent`.
  - CIMD: host allowlist and URL policy (https, no credentials, fragment, loopback or IP literal) run before any fetch; the bundled `@better-auth/cimd/node` transport resolves once, rejects special-use addresses, pins the address and allows no redirects, 5 s and 5 KB; secret or symmetric auth methods are refused.
  - A change of redirect URIs or JWKS in a client document revokes that client's grants and pending selections (`client.refreshed`).
  - The gateway lookup `activeGrantForToken` re-checks the current membership on every call.

**Verification (local).**
- Full suite (`vitest run` with the local env file) after merging `main` (WP4.1–WP4.5): 172 files, 1552 of 1553 tests passed. The one failure, `rls-matrix` "classifies every table", came from a `PublicClientKey` table that another worktree's unmerged migration had left in the shared local test database; on a fresh isolated local database deployed from this branch, `rls-matrix` and `access-matrix` pass (2 files, 14 tests). `tsc --noEmit` (root and `apps/web`), `next build --webpack`, `scripts/source-check.mjs`, `python3 scripts/check-secrets.py` and `scripts/check-coolify-compose.mjs` pass.
- The local Docker VM had been reset, so the local databases were recreated with the isolated local setup steps (init-db, then db-deploy on the dev and test databases) before the full run.
- New test files: `mcp-oauth-{config.unit,schema.integration,http.integration,flow.integration,revoke.integration,cimd.integration,browser-redirect.integration,hooks.characterization.integration}`, plus web tests for the proxy, `/.well-known` route, routes table, `connect-view` and `connected-apps`. The access matrix and RLS matrix include the new surface and tables.
- Mapping to the acceptance criteria: `docs/REQUIREMENTS_TRACEABILITY.md` ("Track M WP-M1 acceptance").
- Not done: a live ChatGPT developer-mode run, MCP conformance and the independent security review (WP-M5).

**Security review notes (WP-M1, checklist `09` §9).**

| §9 item | Status | Evidence |
|---|---|---|
| Token audience binding | partly: issuing side met; verification and the REST API refusal come with WP-M2 | `mcp-oauth-flow` (full flow: `aud` includes `MCP_RESOURCE`, missing or other `resource` is `invalid_target`); WP-M2 must verify `aud` inclusion on every call |
| PKCE required, exact redirect, `iss`, no skipped consent | met | `mcp-oauth-http` (S256 only, `iss` parameter advertised), `mcp-oauth-flow` (wrong verifier, unregistered redirect, new client always reaches consent) |
| CIMD fetch is SSRF-safe | partly | `mcp-oauth-cimd` (host and URL policy before fetch, size limit, no secret methods), `mcp-oauth-config` (production uses the bundled pinned transport). The address pinning itself is the library's and has no Orbit-side test |
| Refresh rotation with reuse detection, immediate revocation | met | `mcp-oauth-flow` (rotation, replay after 30 s), `mcp-oauth-revoke` (revoked grant fails on the next call, revocation beats the reuse window), `mcp-oauth-cimd` (refresh needs an active grant, codes die with the grant) |
| Membership and module activation re-checked, intersection never exceeds UI rights | partly: membership met, the rest WP-M2 | `mcp-oauth-revoke` (`activeGrantForToken` accepts only an active grant of a current member); token scopes are not yet intersected with grant scopes |
| Results respect `modelUse`, hard floors, ActionRequests | WP-M2 and later | no tool surface in WP-M1 |
| Rate limits, quotas, kill switch | partly | `mcp-oauth-http` (token endpoint limited per client IP), `mcp-oauth-cimd` (DCR 5 per minute); the flag is the kill switch; per-grant gateway limits come with WP-M2 |
| Dependency pinning past known advisories | met | exact 1.7.10 pins; advisory query on 2026-10-17 (plan D1) |
| MCP conformance and ChatGPT end-to-end test | WP-M5 | not run |

**Known limitations and follow-ups.**
- `email_verified` is `false` (D7): ChatGPT Enterprise domain restrictions would fail.
- A member removed from a workspace keeps an active grant row; `activeGrantForToken` denies them, but grants should be revoked on member removal (WP-M2 or a removal hook).
- Two millisecond windows remain between code or refresh rotation and a concurrent revocation; a global `/oauth2/token` after-hook that deletes tokens minted for a non-active grant closes them.
- Downgrading a client from `private_key_jwt` to `none` does not revoke grants; needs a decision.
- A changed client document is noticed only after the metadata revalidation interval (default 60 min). A failed revocation on a client change is logged at error level and marked `revocationFailed`; there is no persisted retry.
- Discovery metadata is sent with `Cache-Control: no-store` (WP-M2 may want caching).
- Replacing a grant copies the old scopes even when the new request asks for fewer: WP-M2 must intersect token scopes with grant scopes, check that `aud` includes `MCP_RESOURCE`, and call `activeGrantForToken`.
- Smaller review findings, accepted for WP-M1:
  - The selection is not bound to the signed OAuth query; it is looked up only by session and client.
  - An abandoned selection can be reused once by the same client and session within 600 s.
  - With the flag on, form bodies are accepted on every permitted `/api/auth` endpoint, including sign-in (the Origin check still applies).
  - After a re-grant within 1 s of a revocation, older refresh tokens are refused (`createdAt` has second precision); the user may need to re-authorize.
  - `consumeSelection` is a read-then-update without a row lock: there is a same-user concurrent-replace window.
  - A selection can replace an active grant before `/oauth2/continue` has validated the client.
  - Browsers that send no `Sec-Fetch-Mode` still get the JSON answer instead of a 302 on authorize.
  - The owner section in Connected apps is gated on the project role, not the workspace role (the API enforces workspace owner).
- `docs/evidence/source-manifest.json` is stale for `docker-compose.yml` (and has been since the initial commits); regenerate it with `node scripts/source-manifest.mjs` at the next evidence refresh.

**WP-M5 pre-flip checklist (before `ORBIT_MCP_OAUTH=true` in production).**
- [ ] Normalize `MCP_RESOURCE` (trailing slash, host case) at config load and in the `resource` comparison.
- [ ] Add a `CHECK` constraint on `McpGrant.status` (allowed values only).
- [ ] Bind the pending selection to the signed OAuth query, not only to session and client.
- [ ] Characterization test for the provider's sign-in continuation: the after-hook re-run after `/connect/login`.
- [ ] A `/oauth2/token` after-hook that deletes tokens minted for a non-active grant (closes the code-consume and refresh-rotation millisecond windows).
- [ ] Decide on a `token_endpoint_auth_method` downgrade (`private_key_jwt` → `none`); recommended: revoke the client's grants.
- [ ] Tests for deny after a replacement and for `GRANT_CONFLICT`.
- [ ] Review the per-IP limits against hosted clients (ChatGPT egress IPs share addresses).
- [ ] Cleanup of abandoned pending selections.
- [ ] RFC 7009 client revocation vs grant status: decide whether a client's token revocation changes the grant (WP-M2 decision).
- [ ] Index on `McpGrant.sessionId`.

**WP-M2 entry criteria.**
- Split `grants.ts` and `plugins.ts` (selection, revocation, client events, queries, hooks) before adding the gateway.
- Intersect token scopes with the grant's scopes.
- Check that `aud` includes `MCP_RESOURCE` and call `activeGrantForToken` on every MCP call.
- Consider WP4.5 module roles (`ORBIT_MODULE_ROLES`) in the grant intersection, so a module role `none` or `viewer` also narrows what a grant allows.

**Rollback.** Local and preview: `ORBIT_MCP_OAUTH=false`. Production after the merge (flag still off): the flag needs no change; if the smoke test fails, redeploy the previous `main` commit, which reverts the Better Auth upgrade. The migration is additive and its tables stay (unused with the flag off); dropping them is not part of a rollback. Production after the WP-M5 flip: the flag off disables every OAuth route and the consent UI; issued access tokens expire within 10 minutes and are useless without the gateway.
## Fewer avoidable assignment rejects: R84–R87 (2026-10-17, local)

Branch `claude/amazing-hawking-253a3e`. In the uLiquid runs of 2026-10-16 (63f76b22) and 2026-10-17 (f610945b) only one of four drafts was approved; the other three failed for content-consistency gaps, not because of the Phase 3 refactor. Rulings R84–R87 in `docs/superpowers/plans/2026-10-09-orbit-agents-rulings.md`.

- **Facts against guardrails (R84).** `listUsableFacts` leaves out a fact whose value names what a profile ban forbids ("No webhook promotion") or has prohibited wording, so strategy and copywriter never see it (`policy/fact-guardrails.ts`).
- **Fact value mismatch is revised once (R85).** A draft whose only problem is `FACT_VALUE_MISMATCH` gets one deterministic revision naming the failing claims with fact key and value (`factMismatchInstruction`); a second mismatch rejects (R26).
- **Banner button is the mission CTA (R86).** Orbit sets the button to the mission CTA when the draft is saved, or leaves the button out when it does not fit; the creative renderer supports a banner without button.
- **No text addressed to the reviewer (R87).** The draft instructions ask for a finished post; the review adds `DRAFT_INSTRUCTION_TEXT` for notes, bracketed directions and elisions and revises such a draft once.

**Verification (local).**
- Failing tests first, then green: `fact-guardrails`, `draft-text`, `fact-claims` (instruction), `banner`, `creative`, `packages/ai` requests, and the integration suites `specialist-strategy` (no forbidden fact offered, brief dropped), `agent-review` (mismatch revised once, still mismatched rejected, reviewer note revised) and `assignment-banners` (button set to the CTA in draft, composed banner and review input).
- Full vitest suite, `tsc --noEmit` and `node scripts/source-check.mjs` green.

**Operations.** No schema migration or data change. The draft and review behaviour changes with the next run after a deploy; existing drafts keep their stored banner. Production deploy needs Mario's approval.

**Rollback.** Revert the merge commit and redeploy.

## Real-time fan-out: WP4.3 Part B (2026-10-17, local; flag off)

Branch `claude/hungry-neumann-4b8c03`. Mario deferred Part B until Support starts, and decided against `scopedRead()` on 2026-10-17. The operating guide is `docs/REALTIME_FANOUT.md`.

- **Flag.** `ORBIT_REALTIME`, default `false`, in config, Compose (API and worker) and `.env.example`. While it is off, nothing is published and the chat stream polls as before.
- **Fan-out.** `platform/realtime/fanout.ts`:
  - `publishChange` runs after commit, is fire-and-forget and carries the cursor only, no content.
  - `RealtimeHub` keeps one subscriber connection per process, with channels refcounted per project and stream, and its own resubscribe after an outage.
- **SSE.** `platform/realtime/sse.ts`: `serveEventStream`.
  - It subscribes, then replays from the database after `Last-Event-ID`, and replays again on each wake-up.
  - It ends after 39 s with `retry: 1000`, and polls every 5 s while Redis is down.
- **`afterCommit(tx, fn)`** in `packages/db`. `scoped()` runs these hooks after the commit and never after a rollback. The pause stop of a chat run publishes through it.
- **Orbit Chat.**
  - With the flag on, the run stream uses `serveEventStream`.
  - The runner, cancel and the pause stop publish after each committed run write.
  - The worker passes the scope to `onBlockedByPause`.
- **Web proxy.** It forwards `Last-Event-ID`, which it dropped before, so a reconnect resumes instead of starting over.
- **Tests.**
  - `realtime.integration.test.ts`: concurrency, order, repeated cuts with resume, Redis unreachable, Redis cut and recovered, flag off.
  - `chat-realtime.integration.test.ts`: 10 streams on one run, no transaction while idle, resume, pause, another member's run, flag off, `afterCommit`.
  - Proxy header test.
  - Local p95: fan-out 4–7 ms, chat SSE 18–30 ms, each test under 1 s. A mutation check confirmed both suites.
- **Production.** Merging changes nothing while the flag is off. The flag, and its first use for the chat, are separate approvals by Mario. The production-host lock measurement remains as planned in the Part A report.

## Source audiences: WP3.5 (2026-10-17, local)

Branch `claude/dazzling-tesla-875f58`. Mario decided on 2026-10-17 (Q-13) that support runs inside the uLiquid project next to marketing; support AI drafts (WP5.6) may only draw on sources whose audience includes support. Roadmap: `plans/orbit-modularization/07-roadmap.md` §WP3.5. Contract: `docs/KNOWLEDGE_ARCHITECTURE.md` (Retrieval and facts).

- **Attribute.** `SourceData.audiences` is optional. Absent or `["all"]` means every module, so every existing source keeps its results. The API (`schemas.sourceAudiences`) accepts `all`, `marketing` and `support`; `all` cannot be combined.
- **Consumer.** `RetrieveInput.consumer` names the retrieving module. `servesConsumer` decides; the same predicate filters facts, excluded sources (`audience_excluded`) and both SQL branches (`index.ts`, `eligible`). A caller without a consumer gets open sources only (fail closed).
  - Marketing names `marketing` in mission retrieval, generation and the specialists' `knowledge_search`.
  - The platform assistant's `knowledge_search` names no module (open sources only).
  - The knowledge `retrieve` action takes an optional `consumer` for previews.
- **Evidence.** It records `consumer` only when named, so evidence and retrieval-run hashes of shared-only retrieval are unchanged. `validateEvidence` adds `source_audience_changed`.
- **Changing audiences.** `setSourceAudiences`, owner action `source-audiences`.
  - It keeps the source generation, so documents, chunks, index generations and evaluations stay valid.
  - Narrowing invalidates the evidence and dependent records built on the source (reason `source_audience_changed`); widening invalidates nothing.
  - `["all"]` removes the attribute again.
- **Manifest check.** The index manifest (`indexes.ts`, `manifest`) is chunk id, version id, source id, source generation and chunk hash, filtered by status, model use, authority and generation. Audiences are not in it, and the evaluation SQL is unchanged. The live uLiquid index (generation 5, eval set `uliquid-website-2026-10-12.v1`) keeps its manifest hash, and its sources have no audiences.
- **Web.** The source editor has an audience select (`all` sends nothing). The source inspector shows the audience and an owner "Change audience" dialog.
- **Tests:**
  - `algorithms.test.ts`: the `servesConsumer` rule.
  - `knowledge.integration`: lexical and vector filtering per consumer, facts, malformed audiences, consumer recorded only when named, narrowing and widening without a generation change.
  - `index-generations.integration`: after narrowing, both generations activate (the current manifest still matches), and manifest hash and evaluation are unchanged.
  - A mutation check (SQL filter removed) failed both integration tests.
  - `knowledge-search-tool.test.ts`: the specialists search as `marketing`, the assistant without a module.
  - The access matrix and action list contain `source-audiences`.
  - Full suite on an isolated test DB (`orbit_test_wp35`): 171 files, 1473 tests green, including the WP0.4 characterization snapshots (unchanged) and the RLS matrix. Typecheck (api and web), source check and boundaries pass.

**Deploy note.** Marketing's hybrid retrieval now hashes `consumer` into its retrieval-run input. A generation job that retrieved before the deploy and retries after it would get `RETRIEVAL_JOB_CHANGED`. Deploy outside the assignment run windows (04:00 Berlin and the drafting that follows).

**Rollback.** Revert. There is no migration. Sources whose audiences were set keep the attribute in their JSON; after a revert it is ignored, which opens them to every caller again. So unset restrictions before a revert.

## Phase 4 in production, part 2: follow-ups, WP4.6, WP4.7 (2026-10-17)

Merged on Mario's approval, after green CI and outside the 10:00/17:00 slots. Every flag stayed `false`: `ORBIT_PUBLIC_INGRESS`, `ORBIT_FILES`, `ORBIT_EMAIL` and `ORBIT_NOTIFICATIONS`.

| Change | PR | Merge commit | Merged | Live | Check |
|---|---|---|---|---|---|
| Public ingress follow-ups | #141 | `8d42389` | 14:51 | 14:56 | health; hooks route 404 |
| WP4.6 platform files (migration `202610170007`) | #142 | `8c87e78` | 14:56 | 15:25, after the hotfix | `/files/...` answers the flag's 404 |
| Hotfix: empty optional variables | #144 | `247aa45` | 15:20 | 15:25 | health, worker, Postiz, web |
| WP4.7 e-mail and notifications (migration `202610170008`, three dependencies) | #143 | `91aa5a8` | 15:58 | 16:03 | `/notifications` and `/email` answer the flag's 404 |

### Incident: production 503 from 15:00 to 15:25

- **What.** After #142, api and worker did not start; Traefik answered "no available server" for the app and the web.
- **Cause.** Compose renders an unset optional variable as an empty string (`FILES_S3_ENDPOINT: ${FILES_S3_ENDPOINT:-}`). The new `FILES_*` validators (URL, regex, `min(1)`) refused `""`, so `loadConfig` threw at start-up.
  - Tests leave these variables unset, and the compose check rendered the file without parsing it, so nothing caught it.
  - The migration itself was fine; it is additive.
- **Fix.** #144 treats `""` as unset for those optional variables, with a regression test. Mario approved merging it at once. The repository ruleset still required the acceptance check, so it went in by auto-merge as soon as that check passed.
- **Prevention.**
  - The compose check now parses the rendered api and worker environment with the real config schema. It failed on the broken state and passes on the fixed one.
  - Changes to configuration get a start-up test with `tsx` and the production-like environment before merging.
- **Also caught before production.** The first #143 run failed in browser acceptance: the notification bell used the workspace context, but the top bar sits outside its provider, which blanked the app. Fixed (the bell takes props), with a render test without the provider.

## E-mail over SMTP/IMAP and member notifications: WP4.7 (2026-10-17, local; flags off)

Branch `claude/wp47-email-notifications` (on top of WP4.6). Mario decided on 2026-10-17 (Q-16): the project's existing mailbox over SMTP and IMAP, no new provider and no DNS change by Orbit. The operating guide is `docs/EMAIL_AND_NOTIFICATIONS.md`.

- **Flags.** `ORBIT_EMAIL` and `ORBIT_NOTIFICATIONS`, both `false`. Real delivery also needs live mode with external writes.
- **Connection.** `platform/email/connection.ts`: the owner action `email-connect` (public hosts only, password encrypted) and the provider check `email` (SMTP and IMAP login, `read_verified`, sends nothing).
- **Transport.** `platform/email/transport.ts`: nodemailer and imapflow behind small interfaces that tests replace, TLS required, and outcome classification.
- **Sending.** `platform/email/send.ts`: `queueEmail`, the `email_send` job, and `sent` / `rejected` / `retry` → `failed` / `outcome_unknown` / `test_receipt`. Nothing is ever sent twice.
- **Receiving.** `platform/email/inbound.ts`: the periodic task `email-inbound`.
  - Read-only IMAP fetch with UIDVALIDITY handling and limits.
  - The raw MIME becomes an encrypted platform file; `inbound_emails` holds the normalized row.
  - Automatic mail is flagged, and bounces mark the project's own messages.
  - Modules with `emailInbound` get a job per message.
- **Notifications.**
  - Migration `202610170008_member_notification`: `Notification` and `NotificationPreference`, private per member by RLS.
  - Service: `platform/notifications/members.ts` (`notifyMembers`, list, read, preferences); contract: `userNotifications`.
  - Routes: `platform/notifications/routes.ts`; owner mailbox view: `platform/email/routes.ts`.
- **Web.** The bell in the top bar (`notification-bell.tsx`) and the mailbox card on the connectors page (`email-connection.tsx`).
- **Dependencies.** `nodemailer` 10.0.13, `imapflow` 2.2.1, `postal-mime` 4.0.2 and `@types/nodemailer`, exact pins at least two weeks old. The audit adds no finding (`docs/DEPENDENCY_RISKS.md`).
- **Tests:**
  - `email.integration.test.ts`: connection, test receipt, live send headers, the four outcomes, crash recovery, inbound dedupe/UIDVALIDITY/limits/auto-reply, bounces, files required. A mutation check confirmed it.
  - `notifications.integration.test.ts`: members only, privacy, read state, muting, e-mail choice, module role, flag off.
  - Web unit tests; RLS and access matrices; contract tests.
- **Production.**
  - Merging brings the migration and the dependencies (approval).
  - Mario then connects the mailbox in Orbit.
  - Each flag and the first real send are separate approvals after the security review.

## Platform files: WP4.6 (2026-10-17, local; flag off)

Branch `claude/wp46-platform-files` (on top of the public ingress follow-ups). Plan: `docs/superpowers/plans/2026-10-17-phase4-platform-capabilities.md`. Mario approved the bucket and token on 2026-10-17 (Q-19: an own R2 bucket next to the backup bucket). The operating guide is `docs/PLATFORM_FILES.md`.

- **Data.** Migration `202610170007_platform_file` adds the `File` table: FORCE RLS project policy and `orbit_app` grants, declared as a platform table. Additive.
- **Object store.** `platform/files/s3.ts` is a SigV4 client without an SDK (PUT, GET, DELETE), pinned by the AWS test vector.
- **Encryption.** `platform/files/crypto.ts`: AES-256-GCM, with the file id as additional data.
- **Service.** `platform/files/files.ts`: `storeFile`, `readFile`, `deleteFile` and the hourly `file-cleanup` task.
  - Limits: allowlisted types, signature checks for images and PDF, `FILES_MAX_BYTES`.
- **Routes.** `platform/files/routes.ts`: upload, download and delete, with module access and the module switch. They answer 404 while off or not configured.
- **Configuration.** `ORBIT_FILES` and `FILES_*` in config, compose and `.env.example`. The compose check pins that file and backup credentials never mix.
- **Tests:**
  - `files.integration.test.ts`, against a bucket double that checks every signature: round trip, encryption at rest, permissions, limits, the module switch, project isolation, a swapped or missing object, the cleanup retry, and off/unconfigured;
  - unit tests for SigV4 and encryption;
  - the RLS matrix (`File` seeded, cross-project insert refused);
  - the access matrix (three routes).
- **Production.**
  - Merging brings the migration (approval).
  - Mario then creates the bucket and token and sets the variables.
  - The flag waits for the security review (`docs/SECURITY_REVIEW.md`).
- **Security review (2026-10-17, done).** Five findings, fixed with tests in branch `claude/fervent-leavitt-045f77` (draft PR, not merged):
  - F-1: platform files (raw inbound e-mail) are owner-only;
  - F-2: uploads check the session, module and type before reading the body;
  - F-3: download names end in their type's extension, without bidi controls;
  - F-4: `filename*` is RFC 5987 encoded;
  - F-5: the web proxy forwards the upload headers.
  - Residual risks and the filesystem alternative are in `docs/SECURITY_REVIEW.md`. The flag can go on after this fix is deployed and the bucket is set up (Mario's approval).

## Public ingress follow-ups (2026-10-17, local; flag off)

Branch `claude/phase4-followups`. Everything stays behind `ORBIT_PUBLIC_INGRESS` (default `false`). The operating guide is `docs/PUBLIC_INGRESS.md`.

- **Retention.** `platform/http/ingress-retention.ts` deletes rows for good, with their versions:
  - public sessions one hour after they expire;
  - received webhooks after 30 days.
  
  It runs hourly per project as the platform's periodic task `public-ingress-cleanup` and also inside the project's retention action, whose audit entry counts both. It purges regardless of the flag, so rows from an earlier "on" go too.
- **Owner UI for public keys.** Project access has a new "Public keys" dialog (`components/public-keys.tsx`): list, create (module, exact origins) and revoke.
  - `GET …/public-keys` also returns the modules a key can be issued for.
  - Production has none, so the dialog says so.
- **Slack and Telegram through the hooks route.** The webhook contract has a second variant, `DirectWebhookProvider`, for providers that must answer within the request. The platform owns the path, flag, media type, size and rate limit; the provider checks its own secret against its own connection.
  - `telegram` (platform): `/api/hooks/telegram/<workspace>/<project>/<connection>`. Same handler and secret check as the bot's own route, and the path's workspace must be the project's.
  - `slack` (marketing): `/api/hooks/slack/<workspace>/<project>/<connector>`, form-encoded. Same signature, mapping and replay checks, and the connector must be the project's selected Slack connector.
  
  The old routes stay the registered URLs. The cutover is a later production step (`docs/PUBLIC_INGRESS.md`).
- **Tests.**
  - `ingress-retention.integration.test.ts`: cleanup, project isolation, the hourly throttle and the retention action.
  - The Telegram hooks path in `telegram.integration.test.ts`: flag, secret, foreign workspace, media type and linking.
  - The Slack hooks path in `webhooks.integration.test.ts`: media type, missing and forged signature, foreign connector, and a valid signature reaching the actor check.
  - Registry checks in `module-contributions.test.ts`; the origin parser in `public-keys.test.tsx`.
- **Deployment record of Phase 4** (below).

## Phase 4 in production: WP4.1–WP4.2b (2026-10-17)

Each step was merged into `main` on Mario's approval, after green CI and outside the 10:00/17:00 slots. Both flags (`ORBIT_MODULE_ROLES`, `ORBIT_PUBLIC_INGRESS`) stayed `false`. After every deploy, `/api/health/ready` (database ok, worker ready) and `/api/health/postiz` were ok.

| WP | PR | Merge commit | Merged | Live | Check |
|---|---|---|---|---|---|
| WP4.1 fixture module, open contracts | #133 | `cc1b128` | 10:15 | 10:19 | health |
| WP4.4 cross-module operator eval | #134 | `ae12c7c` | 10:50 | 10:51 | health |
| WP4.3 Part A lock measurement | #135 | `f654ab8` | 11:51 | 11:55 | health |
| WP4.5 module roles (migration `202610170005`) | #136 | `b5e07f6` | 12:23 | 12:27 | `/modules` returns `access`; module-roles API 404 |
| WP4.2a signed webhooks | #137 | `3fd782d` | 12:56 | 13:00 | `/api/hooks/...` 404 |
| WP4.2b public API (migration `202610170006`) | #138 | `bff9a83` | 13:30 | about 13:40 | `/api/public/...` answers the flag's 404 instead of `ORIGIN_REQUIRED` |

## Public module API: WP4.2b (2026-10-17, local; flag off)

Branch `claude/wp42b-public-api` (on top of WP4.2a). Plan: `docs/superpowers/plans/2026-10-17-phase4-platform-capabilities.md`. Same flag as WP4.2a (`ORBIT_PUBLIC_INGRESS`, default `false`).

- **Keys.** Migration `202610170006_public_client_key` adds the `PublicClientKey` table: owners only, audited, exact allowed origins.
  - API: `GET/POST /api/projects/:id/public-keys` and `POST …/:keyId/revoke`.
- **Public API.** `platform/http/public-api.ts`, at `/api/public/<module>/:publicKey/...`:
  - the key is resolved without a project scope;
  - the Origin check and CORS run per key (manual, no credentials) and preflight is supported;
  - `POST …/session` issues a bearer token, stored as a hash, valid 12 hours;
  - module routes need that token;
  - JSON only, 64 KB, rate limits per key and address, and per session;
  - the API is off with its module.
- **Contract.** `ModuleContributions.publicRoutes`. The registry checks paths and refuses `/session` and duplicates. The fixture module serves `/requests`: visitors file requests and see only their own.
- **Tests.** `public-api.integration.test.ts` covers:
  - the flag off;
  - key issuing rules;
  - unknown, foreign and revoked keys;
  - a foreign Origin (audited), an allowed Origin without credentials, and preflight;
  - missing, wrong and expired tokens, and that cookies are ignored;
  - the token stored as a hash, and visitors seeing only their own requests;
  - the per-session rate limit and the module switch.
  
  A mutation check confirmed it: with the origin comparison disabled, the test fails. The access matrix adds exactly the three owner-only key routes.
- **Production.** Merging brings the migration (Mario's approval). The flag waits for the security review.

## Signed provider webhooks: WP4.2a (2026-10-17, local; flag off)

Branch `claude/wp42-public-ingress`. Plan: `docs/superpowers/plans/2026-10-17-phase4-platform-capabilities.md`. Risk class high: a new unauthenticated surface, behind `ORBIT_PUBLIC_INGRESS` (default `false`).

- **Route.** `POST /api/hooks/:provider/:workspaceId/:projectId/:connectionId` (`platform/http/webhooks.ts`):
  - the raw JSON body is kept as received for the signature;
  - 415 and 413 limits;
  - 120 requests per minute per connection;
  - exempt from the Origin check by exact path pattern.
- **Contract.** A module contributes `webhooks[provider] = { connectionProvider, verify, messageId, queueClass }`. The registry refuses duplicate names and unknown queue classes.
- **Flow.** Inside the project transaction:
  - the connection must belong to the provider (404 otherwise);
  - the signature is checked (401 otherwise, audited);
  - the message id is required (400 otherwise);
  - a replay gets 409 (audited);
  - the message is stored as `inbound_webhooks` and the module's job is enqueued; the answer is 200 at once.
- **Fixture.** The test module `tasks` signs with HMAC-SHA256, and its job turns the message into a task.
- **Tests.** `webhooks.integration.test.ts` covers the flag off, every rejection path, storing, the job, replay, the per-connection rate limit and the unchanged Origin check. A mutation check confirmed it: with the signature check disabled, 4 tests fail.
- **Production.** Mario's approval for the flag, after the security review (`docs/SECURITY_REVIEW.md`). Merging alone changes nothing (404 while off). Slack and Telegram stay on their own routes for now.

## Module-level roles: WP4.5 (2026-10-17, local; flag off)

Branch `claude/wp45-module-roles`. Plan: `docs/superpowers/plans/2026-10-17-phase4-platform-capabilities.md`. Risk class high: an authorization change, behind `ORBIT_MODULE_ROLES` (default `false`).

- **Data.** Migration `202610170005_project_member_module_role`: an additive table with RLS, `orbit_auth` only, cascading with the membership.
- **Resolution.** `platform/tenancy/module-roles.ts`:
  - The membership carries a non-owner's overrides.
  - `effectiveRole` and `moduleScope` give a module's code the member's role there; `none` answers 404 `MODULE_NOT_AVAILABLE`.
  - `visibleModules` filters tools, prompt fragments and conversation sections like activation does.
- **Gates.**
  - Module routes, actions and collections.
  - Assistant tools, offered and executed per tool owner.
  - Prompt fragments and conversation sections.
  - `GET /modules` with `access`, so the web shell hides `none`.
- **Management.**
  - `GET/PUT /api/projects/:id/members/:userId/module-roles`: owners only, audited, refused for owners and unknown modules, 404 while the flag is off.
  - "Module roles" per member in the web.
- **Tests.**
  - `module-roles.integration.test.ts`: refusals; `none` in routes, collections, actions and the module list; a viewer raised to editor in knowledge only; stored rows ignored with the flag off; removal.
  - `module-roles-assistant.integration.test.ts`: tools and a forged call.
  - Shell and form unit tests; the RLS matrix includes the new table.
- **Production.** Migration and flag need Mario's approval; the flag also needs the security review (`docs/SECURITY_REVIEW.md`). The migration alone changes nothing.
- **Security review (2026-10-17, done).** It found four holes in platform entry points: action request decisions (MR-1, high), the export (MR-2), the dashboard (MR-3) and old notices (MR-4). All four are fixed with tests in the review PR. The flag can go on after that PR is live. Findings and observations are in `docs/SECURITY_REVIEW.md`.

## Project lock measurement: WP4.3 Part A (2026-10-17, local)

Branch `claude/wp43-lock-measurement`. Report: [docs/evidence/lock-measurement-2026-10-17.md](evidence/lock-measurement-2026-10-17.md).

- **Hook.** `lockObserver.observe` in `packages/db` reports `{ waitMs, holdMs }` for every `scoped()` transaction. It is unset in production (one property read) and tested in `packages/db/tests/lock-observer.integration.test.ts`.
- **Measurement.** `scripts/measure/lock-load.measure.ts` with `vitest.measure.config.ts`, outside `pnpm test`. Load: chat runs with a 1.5 s model, searches with a 1 s embedding, writers, the sweep, and 5 or 25 chat-stream pollers.
- **Result.**
  - No transaction holds the lock across a provider call; the longest hold is 66 ms.
  - With 25 open chat streams (about 54 transactions per second on one project), writers keep a call p95 of 28 ms and polls 71 ms.
  - The lock does not limit one project at this load. Polling is the cost that grows with open streams.
- **Recommendation.** Part B needs Mario's decision:
  - no lock-free read path now;
  - Redis pub/sub for streams when Support starts;
  - repeat the measurement on the production host against a staging copy first.

## Cross-module operator eval: WP4.4 (2026-10-17, local)

Branch `claude/wp44-operator-eval` (on top of WP4.1).

- **Dataset.** `evals/operator/cases-v3.json` replays recorded model steps through the real chat runner, with knowledge, marketing and the test-only fixture module registered:
  - JC30: tools of all three modules in one run, with two task proposals as two pending ActionRequests;
  - JC31: a viewer is offered no module write, and a forged `propose_tasks` is refused (`CHAT_TOOL_NOT_ALLOWED`);
  - JC32: with the tasks module off, its tool is neither offered nor callable;
  - JC33: with every module off, the assistant is offered exactly `knowledge_search` and still searches the existing sources.
- **Harness.** New optional `disabledModules` and `actionRequests` fields. `cases-v1.json` and `cases-v2.json` are unchanged, and so are their hashes.
- **Verification.** All 14 operator cases are green offline; no network call and no paid call.

## A third module through the contracts alone: WP4.1 (2026-10-17, local)

Branch `claude/wp41-extensibility`, the first work package of Phase 4. Plan: `docs/superpowers/plans/2026-10-17-phase4-platform-capabilities.md`.

- **Fixture module `tasks`** (`apps/api/tests/fixtures/modules/tasks`, test only). It declares:
  - a kind and two permissions;
  - a route, a readable collection and an action;
  - a proposal tool, an action type and a scheduler.
  
  `registerTestModules()` in `modules/registry.ts` adds it; the API and the worker register only the static list.
- **Three gaps the suite found and closed** (behaviour of knowledge and marketing unchanged):
  - `ToolNamespace` was a closed union. A module may now name its own namespace; it only groups tools for tool search.
  - The generic collection read accepted a fixed list of kinds. A module now declares readable kinds with `EntityKindDef.collection`. The registry refuses it for an unexported kind, so credentials can never become readable.
  - Action permissions were hard-coded for knowledge and marketing in `server.ts`. Modules now contribute `actionPermissions` for their own actions only; the registry refuses another module's action.
- **Tests:**
  - `extensibility.integration.test.ts`: registration; the tool offered by role; the route, collection and action for owner, editor, viewer and a non-member; module off and on again, including the scheduler.
  - `extensibility-assistant.integration.test.ts`: a scripted chat run across knowledge, marketing and the fixture yields two ActionRequests. A viewer cannot decide them; an editor approves one and exactly one task appears.

**Rollback.** Revert; there is no schema or data change.

## Phase 3 follow-ups (2026-10-17, local)

Branch `claude/phase3-followups`.

- **Breadcrumb.** Knowledge sub-pages showed their internal key ("knowledge-facts"). `ViewDef.title` now names a page without a navigation entry, and `crumbs()` shows "Wissen / Fakten". A test checks that no page shows its key.
- **brandTerms in the profile editor.** The marketing profile editor (`modules/marketing/advanced.tsx`) has a field for the product words of the fact checks. Words are lower-cased and de-duplicated; an empty field leaves `brandTerms` out, so the built-in uLiquid words stay. Saving the profile invalidates pending packages, as every profile save does.
- **Deployment record of Phase 3** (below).

## Phase 3 in production: WP3.1–WP3.4 (2026-10-15/16)

Each step was merged into `main` on Mario's approval, after green CI and outside the 10:00/17:00 slots. Coolify deployed each one with about 30–40 seconds of 503 while the containers were replaced. After every deploy, `/api/health/ready` (database ok, worker ready) and `/api/health/postiz` were ok.

| WP | PR | Merge commit | Merged | Live |
|---|---|---|---|---|
| WP3.1 impact handlers | #128 | `918e06c` | 15.10 15:57 | 16:00 |
| WP3.2 knowledge services, K-1 | #129 | `6567951` | 15.10 17:15 | 17:19 |
| WP3.3 knowledge module, URL views | #130 | `c9f8af2` | 15.10 17:46 | 17:49 |
| WP3.4 brand terms from the profile | #131 | `2533a80` | 16.10 15:41 | 15:45 |

Checks after the deploys:
- **K-1, before the switch.** The read-only check in production (`scripts/rollout/k1-usable-facts-diff.sql`, as `orbit_app`, ending in ROLLBACK) showed every uLiquid fact unchanged.
- **Knowledge views.** `/p/<uLiquid>/knowledge/facts` opens the Facts tab with the knowledge entry highlighted.
- **Assignment runs on 16.10 (`63f76b22`) and 17.10 (`f610945b`).** Every step finished; the new `knowledge_search` and the K-1 rule raised no error.
  - Of the four drafts, the 17:00 draft of 17.10 was approved and handed to Postiz for X and Telegram (WP2.6 check 8).
  - The three rejections came from content conflicts, not from the refactor: an extra word in a fact sentence, banner copy competing with the CTA, reviewer directions left in the text, and a topic built on a fact that the guardrails forbid. They are handled separately.
  - The daily report (WP2.6 check 9) has not been checked here.

## Product words of the fact checks from the profile: WP3.4 (2026-10-15; production 2026-10-16)

Branch `claude/wp34-fact-consumers`. Plan: `docs/superpowers/plans/2026-10-15-phase3-knowledge-module.md`. Behaviour for uLiquid is unchanged.

- **Profile field.** `marketingProfile.brandTerms` is new and optional: lower-case words of the product name, 1–20, each 2–40 letters or digits.
- **Fact matcher.** `factClaimMatches(text, fact, brandTerms)` allows the profile's words instead of the built-in `uliquid`, `uliq` and `desk`.
- **Presale check.** `presaleLivePattern(profileTerms)` accepts up to two of the profile's words between "live" and "presale".
- **Without the field (every profile today).** `LEGACY_BRAND_TERMS` applies and the presale regex stays verbatim (pinned by a test), so no check changes and no profile save is needed.
- **Loading.** `checkClaims` reads the terms once, and only when it checks a fact claim.
- **Follow-up.** A field in the profile editor; until then the profile API sets it.

**Verification (local).**
- New tests:
  - the matcher with a profile's own words, which rejects uLiquid's words there;
  - `brandTermsOf`;
  - the legacy presale regex is pinned verbatim; the generated one matches and rejects as expected;
  - the schema keeps an absent field absent and rejects invalid terms.
- `fact-claims`, `claim-repeat`, `safety`, `official-target-link` and `content-packages` are green; the OpenAPI document is unchanged.

**Rollback.** Revert; there is no schema migration or data change (the profile field is optional and unused).

## Knowledge module, server and web: WP3.3 (2026-10-15; production 2026-10-15)

Branch `claude/wp33-knowledge-module`. Plan: `docs/superpowers/plans/2026-10-15-phase3-knowledge-module.md`. With `ORBIT_MODULES=false` the product is unchanged; the knowledge views gain URLs.

- **Server.** `GET …/knowledge-health`, `…/documents` and `…/indexes` move unchanged from `server.ts` into `modules/knowledge/routes.ts`; the bulk import moves to `modules/knowledge/import.ts`. The platform's route guard answers `MODULE_DISABLED` for them while knowledge is off. The OpenAPI document is semantically unchanged (route order only; regenerated with the client types).
- **Assistant search.** `assistantKnowledgeSearch` is a platform tool (`alwaysOffered`). Marketing lists it only to keep its place, so the tool list and prompt are unchanged. With knowledge and marketing off, the assistant still offers `knowledge_search`.
- **Web.**
  - Each knowledge tab is a view at `/p/:id/knowledge/<tab>`; the overview stays the module root.
  - The tab bar keeps its role, labels, order and keyboard handling, and navigates to the tab's URL. (Removed in the UI restructure, phase 2: the sidebar lists the pages.)
  - `ViewDef.navKey` lets a URL-only view highlight its module's sidebar entry.
- **Deviations from plan 05 §8, kept for an unchanged product.** "Conflicts" and "impact" stay tabs. Detail URLs with ids, the knowledge settings panel and the home tile are follow-ups.

**Verification (local).**
- New tests:
  - enforcement: knowledge switched off after marketing blocks its routes, collections and actions; the assistant keeps the search; marketing needs knowledge first; the snapshot is unchanged;
  - routes: every tab resolves to its view and highlights the knowledge entry; `navKey` validation.
- Web typecheck and `next build --webpack` pass; Playwright not run locally.

**Rollback.** Revert; there is no schema or data change.

## Knowledge services and the K-1 fact rule: WP3.2 (2026-10-15; production 2026-10-15)

Branch `claude/wp32-knowledge-services` (stacked on WP3.1). Plan: `docs/superpowers/plans/2026-10-15-phase3-knowledge-module.md`.

- **Orchestration moved.** `retrieval.ts`, `ingestion.ts`, `reindex.ts` and `index-evaluation.ts` move unchanged from the flat api modules to `apps/api/src/platform/knowledge/`; only import paths change. `services.ts` is the facade (retrieve, retrieveHybrid, validateEvidence, getActiveIndex, the six bound changing operations).
- **One `knowledge_search`.** The search moves verbatim from marketing's `runReadTool` to `platform/knowledge/search.ts`. `knowledgeSearchTool()` is the only definition.
  - The chat and the specialists pass their budget keys, which are unchanged: `chat:<runId>:knowledge:<n>` with `chat:<runId>`, and `agent:<taskId>:knowledge:<n>` with `assignment-run:<runId>`.
  - Name, description, schema and position in the tool list are unchanged, so the prompt is the same.
  - The card check is now `checkToolResult` in `platform/assistant/cards.ts`.
- **K-1 (behaviour change, decided by Mario).** `platform/knowledge/facts.ts` applies the engine's full rules to package facts. Marketing's `usableFacts`/`listUsableFacts` delegate to it, with the profile's content language.
  - The production check before the switch (`scripts/rollout/k1-usable-facts-diff.sql`, read-only) showed every uLiquid fact `unchanged`.
  - Two test fixtures created facts without `sourceGeneration`, which `setFact` always records. They now set it.

**Verification (local).**
- New tests:
  - `knowledge-search-tool.test.ts`: same model-facing tool for both variants, both budget-key sets, the specialist variant refused outside a task.
  - The K-1 test now pins the shipped rule to the SQL's K-1 side.
- Typecheck and source check pass; boundaries: 0 known violations.

**Rollback.** Revert; there is no schema or data change.

## Knowledge invalidation through impact handlers: WP3.1 (2026-10-15; production 2026-10-15)

Branch `claude/plattform-umbau-fortschritt-05c734`, the first work package of Phase 3 (plan: `docs/superpowers/plans/2026-10-15-phase3-knowledge-module.md`). Risk class high: a missed invalidation would make revoked evidence publishable. Behaviour is unchanged.

- **Engine (`packages/knowledge`).** `invalidate()` keeps only its own part: it marks dependent evidence `invalidated` (or purges it) and then calls the impact handlers it was given, in the same transaction.
  - The six changing operations (`ingest`, `setFact`, `withdrawFact`, `revokeSource`, `setSourceRights`, `revokeDocument`) take `handlers` after the scope.
  - The result keeps `{ evidenceIds, contentIds }`; `contentIds` is what the handlers report.
  - New types: `KnowledgeImpact`, `ImpactResult`, `ImpactHandler`.
- **Marketing.** `invalidateMarketingForKnowledge` (`modules/marketing/pipeline/knowledge-impact.ts`) is the former marketing part, moved line for line, with the same revision history. It covers content, approvals, insights, publications, jobs, reconciliation jobs and the outbox. Marketing registers it as the new contribution `knowledgeImpact`.
- **Platform.** `registeredImpactHandlers()` returns every module's handler, never filtered by activation. `platform/knowledge/engine.ts` binds them to the six operations.
  - All callers use the platform wrapper: server, knowledge actions, ingestion, the import, tests, evals and `scripts/backup-restore-test.ts`, which now registers the modules first.
  - Without registration the wrapper fails closed.
- **Boundary check.** `forbiddenLiterals` in `scripts/boundaries.json` forbids the strings `content`, `approvals`, `publications`, `insights` and `jobs` in `packages/knowledge`. The old engine has five hits, the new one none.

**Verification (local).**
- The WP0.4 characterization snapshots (nine scenarios) pass without updating.
- New tests:
  - engine: handler order and arguments, reported content ids, handlers without affected evidence, rollback when a handler throws;
  - registry: marketing's handler is bound for every project; fail-closed before registration;
  - boundary script: the literal check.
- Typecheck and source check pass; boundaries: 0 known violations.

**Rollback.** Redeploy the previous image; there is no schema or data change.

## Banner copy no longer a claim: R83 (2026-10-15, local)

Branch `claude/banner-claims`. The uLiquid 17:00 draft of 2026-10-15 was rejected with `CLAIM_NOT_IN_CONTENT`, because the model had recorded the banner copy as a style claim. The generation (`packages/ai`) now drops a style claim with no fact or chunk that is not in the body and consists only of banner fields, and the banner instruction says the banner copy is no claim. Details: ruling R83. Verification: AI package tests (a new test with the production case), and the banner, copywriter and agent-review suites.

## Modular platform in production: WP2.6 Step A (2026-10-15)

On Mario's Approval A, release PR #125 was merged into `main` at 13:05 CEST (merge commit `930511e`). The new version was live at 13:10, and migration `202610130001_platform_project_module` ran. `ORBIT_MODULES` stays `false`. Runbook: `docs/deployment/MODULAR_PLATFORM_ROLLOUT.md`.

Post-deploy checks:
1. `/api/health/ready` ok (database ok, worker ready); `/api/health/postiz` ok.
2. uLiquid home and navigation: 13 entries; Knowledge, Marketing and Platform sections. Since the UI restructure (phase 1), the sidebar is grouped: Home and Orbit Chat, then one group per enabled module (Marketing with Approvals, Support when on, Knowledge), then the Project group (Connectors, Operations, Settings); each group header collapses its entries.
3. Settings → Modules: Knowledge and Marketing on, switching not enabled.
4. Settings tabs as before; the assignment "uLiquid Beta" is active (Postiz drafts, 10:00/17:00).
5. Connectors: Postiz, Matomo, Slack, Telegram (linked), blog, newsletter, in the former order.
6. Operations: worker heartbeat, outbox 0, 14 queue classes, AI runs with costs.
7. Telegram: the bot answered a text message with its help text (13:18).

Checks 8 and 9 (the next run's drafts and the daily report) follow. The 17:00 rejection of that day predates the deploy and is fixed by R83.

## Weekly autopilot removed (2026-10-13, local)

Branch `claude/remove-old-agent-tests-e6b039` (PR #90), merged with the modular platform (#125), not deployed. Production has run on standing assignments since 2026-10-09 (`ORBIT_AGENTS=true`), so the weekly autopilot that the flag-off path kept as a fallback is gone: `marketing/pipeline/autopilot.ts` and its shim (planner, settings, one-click `approve-and-schedule`, migration proposal), the `configure-autopilot` and `approve-and-schedule` actions and permissions, the `…/assignments/autopilot-migration` routes, the `autopilot_settings` collection and its manifest kind (old rows stay in the database and in the project export), the autopilot settings tab (`autopilot-settings.tsx`), the autopilot approvals panel and the migration card, the Phase 0 rollout queries, and their tests (`autopilot.test.ts`, `autopilot-coexistence`, `autopilot-migration`, `rollout-phase0`, planner cases in `paid`, `official-target-link`, `assignment-runs`, `assignment-routes`, `drive-readiness`, `due-marker`, the web migration card). With `ORBIT_AGENTS` off the sweep now plans no posts (sweep characterization case renamed, snapshot unchanged). Kept: the project and policy mode `autopilot` (autonomy mode, unrelated), and the code that reads missions the autopilot planned earlier (slot occupancy, missed-slot archive, draft cleanup, content history, generation context). No schema migration. Rollback: revert the merge commit. Details: [OPERATIONS.md](OPERATIONS.md#orbit-agents).

## Google Drive on the platform, brand assets in marketing, Slack checked: WP2.5d (2026-10-14, local)

Branch `claude/wp25d-drive-slack`, the last part of WP2.5.

- **Google Drive.** `modules/google-drive.ts` moves to `platform/connections/google-drive.ts` (a rename-only commit first; the shim is gone).
  - **Platform:** OAuth connect and callback, the connection status and health, disconnect, the storage root, browsing and `driveContent`.
  - **Marketing (`modules/marketing/brand/drive-assets.ts`):** the six brand-asset functions, moved unchanged. They are `importDriveFile`, `brandAssets`, `saveGeneratedAsset`, `saveDraftDocument`, `uploadUserRaster` and `markSyncFailed` (plan 04: they stay marketing until Q-06).
  - The platform exports the Drive access they build on under descriptive names (`driveStorage`, `driveAccessToken`, `driveContains`, `ensureDriveFolder`, …). The access token never leaves the server.
- **Routes.** The three brand-asset routes move from `server.ts` into marketing's routes at the same paths, so the WP2.4 guard covers them: `GET …/google-drive/brand`, `POST …/google-drive/files/:fileId/import` and `POST …/google-drive/upload` (with its rate limit).
- **Drive retry of generated images.** It moves from the worker's pass into the marketing periodic task `drive-asset-retry`, unchanged; a mechanical diff shows only the return of its wake-up.
  - `PeriodicTask.run` may now return `wakeAt`, which the worker adds to the project's wake-up, so the timing stays the same.
  - The worker no longer imports marketing.
  - Two deliberate differences, both platform rules for periodic tasks:
    - a failing Drive status check no longer fails the whole project pass;
    - with `ORBIT_MODULES` on and marketing off, no retry runs.
- **Slack.** Its inbound route already belonged to marketing (WP2.1f). A signed interaction is now refused with `MODULE_DISABLED` while marketing is off, only after signature and identity mapping. Nothing is consumed, so the same button works once marketing is on again.

**Verification (local).**
- Full suite: 153 files and 1384 tests.
- New tests:
  - the Drive retry: no Drive, due versus later assets, the attempt limit, the 30-second throttle, `markSyncFailed` after a failed save, and the wake-up;
  - the Slack interaction while marketing is off (mutation-checked).
- The Drive mocks of three suites follow the new paths. The periodic task order now includes the retry.
- The OpenAPI document is unchanged. Typecheck and source check pass; boundaries: 0 known violations.

## Connections registry: WP2.5c (2026-10-14, local)

Branch `claude/wp25c-connections`, the third part of WP2.5. The platform owns the credential vault and capability states; marketing contributes the providers.

- **Platform (`platform/connections/connections.ts`).**
  - `CONNECTION_KIND`, `connectionVerified(status)`, `connectionsOf(tx, scope, provider)` and `decryptCredential(connection)`.
  - The types of a connection provider (`normalize`, `check`, `checkUnsupported`).
- **Actions.** `connector` (create) and `connector-health` (check) are platform actions that dispatch to the provider:
  - the provider list of `connector` comes from the registry, in the former order (postiz, matomo, slack);
  - `connector-health` moved from marketing; the provider call still runs outside any transaction, with the version check `CONNECTOR_CHANGED` before writing.
- **Marketing (`publishing/connection-providers.ts`).** Postiz (base URL normalization and the channel and group check), Matomo (the site report check) and Slack (`SLACK_DELIVERY_TEST_REQUIRES_AUTHORIZATION`), moved unchanged.
- **Call sites.** 22 hand-written decryptions and `read_verified`/`write_verified` checks in marketing and `server.ts` now use the helpers.
  - Stored formats are unchanged: `connectors` rows, `encryptedCredential` with AES-256-GCM.
  - The capability transitions (Postiz write verification, assignment health) stay marketing semantics. A generic `setCapability` was not needed.
- **Module activation (WP2.4).** With `ORBIT_MODULES` on, creating or checking a connection of a disabled module's provider answers `404 MODULE_DISABLED`.

**Verification (local).**
- New suite `connections.integration.test.ts`. The two actions had no integration test until now.
  - It covers encrypted storage that never returns the credential, Postiz normalization, unknown provider and non-HTTPS, the Postiz check with a missing groups API, the Matomo check for its site, the refused Slack check and the disabled module.
  - Provider clients are mocked.
  - The first four tests also pass against the code before WP2.5c (characterization).
  - The module check is mutation-checked.
- Registry tests: provider order and owner, duplicate providers.
- `module-registry.test.ts` now also resolves exported kind constants.
- Full suite: 152 files and 1381 tests. The OpenAPI document is unchanged. Typecheck and source check pass; boundaries: 0 known violations.

## Notifications as a platform transport with module kinds: WP2.5b (2026-10-14, local)

Branch `claude/wp25b-notifications`, the second part of WP2.5. The owner's bot notifications are split by owner.

- **Platform (`platform/notifications`).**
  - `notify(tx, scope, kind, ref)` queues the job. It throws for an unregistered kind.
  - `telegramLinked` checks for a bound bot.
  - The sender moves without changes: retries and backoff, `retry_after`, photo fallback, the `TELEGRAM_DELIVERY_FAILED` exception and the recorded outcome.
  - The `telegram_notification` queue class is now platform-owned, still with `runWhilePaused` and a 180-second lease.
- **Marketing.**
  - It registers its 15 kinds (`NOTIFY_KINDS`) with a renderer as `notifications` (`notification-messages.ts`, renamed from `notification-sender.ts`).
  - A preview's image is read by a loader the platform calls outside the transaction, as before.
  - `notify` in `agents/notifications.ts` stays as a typed wrapper, so its callers are unchanged.
  - The daily report planning and `reportBlockedPost` stay in marketing.
- **Registry.** Kinds must match `[a-z_]+` and be unique across owners. Job keys `notify:<kind>:<ref>` and every text are unchanged, so jobs queued before the deploy are sent as before.
- **Module activation.** With `ORBIT_MODULES` on, a notice of a disabled module is skipped as `MODULE_DISABLED`. The job is no longer blocked by the worker, because its queue class belongs to the platform.

**Verification (local).**
- Full suite: 151 files and 1375 tests. It includes every notification suite (`agent-notifications`, `assignment-postiz-drafts`, `assignment-shared-posts`) and the new tests below.
  - Kind registration and owner of the queue class.
  - Duplicate and invalid kinds.
  - The skip of a disabled module's notice, which is mutation-checked.
- The OpenAPI document is unchanged. Typecheck and source check pass; boundaries: 0 known violations.

## Telegram transport on the platform, buttons routed by prefix: WP2.5a (2026-10-14, local)

Branch `claude/wp25a-telegram-callbacks`, the first part of WP2.5. The owner's Telegram bot becomes platform code: `modules/telegram.ts` moves to `platform/connections/telegram.ts`. The known import-boundary violations drop from 2 to **0**.

- **Callback router.** `callback_data` is dispatched by its prefix to the handler that the platform or a module registers as `telegram.callbacks` (`platform/connections/types.ts`).
  - The platform registers `pause:`, the `/pause` confirmation.
  - Marketing registers `stop:`, the veto of an assignment post (`modules/marketing/agents/telegram-stop.ts`).
  - Prefixes must be short lowercase words and unique; the registry refuses anything else.
  - Unknown or unverifiable data is answered and audited as before.
- **Unchanged formats.** Both data formats, the MAC key and every answer text are byte-identical, so buttons that are already sent keep working. A test pins the Stop format against an independent computation.
- **The bot's switch.** Today it is Orbit Agents (`ORBIT_AGENTS`). Marketing now contributes it (`telegram.enabled`), so the platform no longer reads a marketing flag.
- **Module activation (WP2.4).** With `ORBIT_MODULES` on, a button of a disabled module is rejected like an invalid one; `/pause` keeps working.
- **Signing helpers.** The platform exports `callbackMac`, `compactUuid` and `expandUuid`, so modules sign their callback data the same way.

**Verification (local).**
- Full suite: 151 files and 1373 tests.
  - New registry tests: assignment of `pause`/`stop`, prefix rules, the switch.
  - New Telegram integration tests: the Stop format pin, and Stop ignored while marketing is off while `/pause` still works.
  - Both are mutation-checked.
- The OpenAPI document is unchanged. Typecheck and source check pass, and the boundary check reports 0 known violations.

## Module activation enforced behind ORBIT_MODULES: WP2.4 (2026-10-14, local)

Branch `claude/wp24-enforcement`. With `ORBIT_MODULES=true`, a module an owner turns off is hidden and blocked everywhere, and nothing is deleted. With the flag off (the default) nothing changes. Behaviour, risk analysis, rollback and rollout: `docs/MODULE_ACTIVATION.md`.

- **API.**
  - Module routes under `/api/projects/:projectId/…` get a guard per owning module, after the membership check.
  - Actions and generic collections check the owner of the action or kind.
  - A disabled module answers `404 MODULE_DISABLED`.
- **Assistant.** Tools, prompt fragments and conversation sections of a disabled module are left out. When no enabled module gives instructions, a short platform prompt is used.
- **Jobs.**
  - The sweep skips a disabled module's scheduler and periodic tasks.
  - The worker stops such a module's job before claiming it: `blocked_dependency` with `MODULE_DISABLED`, which the existing `retry` action restarts. This deliberately deviates from the planned `skipped_module_disabled`.
- **Contributions registry.** It records the owner of every tool, action, job and periodic task, and the getters take the set of enabled modules.
- **Web.**
  - New tab **Settings → Modules**: state, dependencies, owner toggle with confirmation, and the dependency errors in plain words.
  - The shell takes navigation, home sections, chat parts, inbox views, settings sections and connector providers only from enabled modules.
  - Module pages show a notice. A platform page can name a module it needs (`requiresModule`): approvals needs marketing.
  - The page remounts on a switch, so section hooks keep their order.

**Verification (local).**
- Full suite with the flag off: 151 files and 1370 tests, including the new suites `module-enforcement` (API) and `module-disabled` (worker), and web tests for the Modules tab and the route gate. All of them are mutation-checked.
- Prompt snapshots unchanged. The OpenAPI document is unchanged.
- Typechecks, source and boundary check (2 known violations, both `telegram.ts`, WP2.5), and a web production build.
- Visual check against a synthetic mock API: turning marketing off hides its navigation, home section, settings tabs, connector providers and the approvals page; turning it on restores them.

## Settings, connectors and tools split by owner: WP2.3b (2026-10-14, local)

Branch `claude/wp23b-settings`, the last part of WP2.3. The web platform imports no module component anymore; the known web boundary violations drop from 5 to 0. Pages, order and texts are unchanged.

- **`management.tsx`** shrinks from 2227 to about 900 lines. Moved unchanged:
  - `Analytics` and `Memory` → `modules/marketing/insights.tsx`;
  - `PolicyEditor`, `AutopilotSettings` and `PostizChannelAssignment` → their own marketing files;
  - `RecordDetail` → `platform/ui/record-detail.tsx`. Its kind-specific actions (preferences, experiments, memory, metric correction) become a slot that marketing fills (`record-actions.tsx`).
- **`operator-tools.tsx`** split by owner:
  - Matomo import and schedule, and Postiz verification → marketing;
  - index management and fact withdrawal → knowledge;
  - workspace pause stays in the platform.
- **`advanced.tsx` / `lifecycle.tsx`.** `ProjectAdministration` and `RetentionControl` move to the platform, as planned in `04` §5.
- **Project settings.** Modules contribute settings sections (`settings`): marketing contributes "Assignments"/"Autopilot", "Policy & budget" and "Brand".
  - The platform keeps "Project", "Policy & budget" (retention) and "Integrations".
  - Module sections show above the platform content of a tab, as the policy did above the retention.
  - Section hooks run in fixed registry order, so the assignments list is still loaded once.
  - The overview's "Set budget and routine boundaries" is a contributed setup link that opens the policy editor through a portal, outside the link list's styles.
- **Connectors page.** Modules contribute providers (`connectors.providers`) with details, actions, a check label, extra form fields or their own configuration dialog, plus extra cards. Marketing contributes Postiz, Matomo and Slack, and the blog and newsletter cards. The platform renders the generic frame in the same order: providers, Telegram, extras.

**Verification (local).**
- Web component tests: 19 files, 89 tests, including a test that pins the contributed tabs and providers.
- Web and API typechecks, a typecheck of the Playwright specs, a web production build, and the boundary check (2 known violations, both `telegram.ts`, WP2.5).
- Visual check against a synthetic mock API:
  - the connectors page: order, Postiz details and actions, the Matomo site ID field, the Slack dialog;
  - the settings tabs and their order, the policy editor dialog (styled, in `body`), the policy and brand tabs;
  - the analytics and memory pages.
- `Operations` is unchanged text for text.

## Chat and inbox parts as module contributions: WP2.3c (2026-10-14, local)

Branch `claude/wp23c-cards`. The platform chat and the approvals inbox no longer import marketing components.

- **Decide hook.** `platform/assistant/decide.ts` (`useDecideActionRequest`) replaces the three decide calls: start a package, decide an assignment in the chat, decide in the inbox. The request bodies are unchanged; `imageRightsConsent` is sent only when given, as before. A test pins the four body shapes.
- **Chat extensions.** Web module manifests can contribute chat parts (`platform/assistant/extensions.ts`):
  - message card renderers by kind;
  - a section below the messages;
  - a `busy` check that keeps the conversation refreshing.
- **Inbox renderers.** Manifests can contribute inbox renderers by action type.
- **Marketing's contribution** (`modules/marketing/chat-extension.tsx`) moves the package handlers (start, cancel, image rights, attach image, unschedule) and the assignment card logic out of `chat.tsx` unchanged. It registers the `assignment` card, the package section, the package `busy` check and the `assignment.confirm` inbox view.
- **`chat.tsx`** lends a `ChatHost` (conversation, pending state, `run` with the same pending, error and refresh handling as the former handlers). It is 150 lines shorter.
- **Boundaries.** Known web violations drop from 8 to 5; all 5 left are in `management.tsx` (WP2.3b).

**Verification (local).** Web component tests (18 files, 87 tests, including the new hook and extension tests), web and API typechecks, a typecheck of the Playwright specs, a web production build and the boundary check (7 known violations, none new). The package and assignment cards in the chat are covered by Playwright `chat.spec.ts` in CI.

## Marketing and knowledge web components in their module folders: WP2.3a (2026-10-14, local)

Branch `claude/wp23-web-marketing`, the first part of WP2.3 (marketing web module). Files move unchanged apart from import paths:

- To `apps/web/src/modules/marketing/`: 13 marketing components with their 7 tests: `work`, `advanced`, `assignments`, `assignment-card`, `agent-activity`, `editorial`, `calendar-blocks`, `draft-cleanup(-panel)`, `autopilot-approvals`, `chat-package-card`, `lifecycle`, `slack-connection`.
- To `apps/web/src/modules/knowledge/`: `knowledge.tsx`.

Further notes:
- Importers use the new `@/modules/...` paths; no re-export is left.
- `apps/web/src/components/` now holds only platform UI. The boundary zones say so: the folder is web platform, and the module zones are their folders.
- The 8 known web violations are the same imports under new paths: `chat`, `action-request-inbox` and `management` import marketing. WP2.3b and WP2.3c remove them.

**Verification (local).** Web and API typechecks, web component tests (17 files, 95 tests), a typecheck of the Playwright specs, a web production build (`next build --webpack`) and the boundary check (10 known violations, none new).

## The assistant as platform code with marketing contributions: WP2.2 (2026-10-14, local)

Branch `claude/wp22-assistant`, work package WP2.2. The assistant (conversations, runs, the tool loop, prompt composition) is platform code; marketing contributes to it. The prompt and the tool definitions are byte-identical.

- **Prompt composition.** The chat runner takes tool features, prompt fragments and proposal validation codes from registered `assistant` contributions (`platform/assistant/types.ts`). It adds the tool search line itself.
  - Marketing contributes its prompt unchanged (`modules/marketing/assistant/prompt.ts`): the operator persona and rules, the package fragment, and the assignment fragment or the "not available" fragment.
  - The base prompt interleaves marketing, knowledge and platform rules. Splitting it by owner would change the prompt, so that waits for an evaluated prompt change (plans `03` §6.4).
- **Cards and read tools.** The card shapes move to `platform/assistant/cards.ts`. The read tool implementations (`project_status`, `knowledge_search`, `approved_assets`, `analytics_memory`) move unchanged to `modules/marketing/assistant/chat-tools.ts`. `knowledge_search` goes to the knowledge services in WP3.2; module sections of `project_status` come with the platform home.
- **Proposals.** `validateDraftMission`, `createProposal` and `confirmProposal` move unchanged to `modules/marketing/assistant/proposals.ts`. Marketing registers `POST /chat/proposals/:id/confirm` at the same path. The `ChatProposal` table stays the platform's assistant storage.
- **Conversation read.** The conversation read adds marketing's packages and assignments through a registered `conversationSections` contribution instead of two lazy imports. The response fields keep their order.
- **Imports.** `chat.ts` enqueues chat jobs through the platform's `enqueue`.
- **Boundaries.** The known import-boundary violations drop from 22 to 10. The 2 left on the server are `telegram.ts` (WP2.5); the 8 web ones belong to WP2.3.

**Verification (local, isolated test database).**
- Full suite: 145 files, 1354 tests.
- `assistant-request.characterization` is unchanged: the hashes for every role and flag combination, and the full text of the smallest and the largest owner setup. Mutation check: one extra space in the prompt fails both tests.
- The OpenAPI document (sorted keys) is identical.
- API and web typechecks pass.
- The Playwright `chat.spec.ts` runs in CI.

## Orbit Agents runner in the marketing module: WP2.1f-3c (2026-10-14, local)

Branch `claude/wp21f3c-runner`. The specialist runner (`runner.ts`) and its types move from `modules/agents/specialists/` to `modules/marketing/agents/specialists/`. The boundary checker no longer counts them as platform. The old paths re-export.

- **Why the runner moves whole.** Plan `04` sketched a platform "runner core". Its generic parts are already in the platform: the runtime port, the budgeted model and the Responses runtime, all in `agents/runtime` since WP1.1. What the runner still holds is Orbit Agents logic:
  - claiming and recovering `agent_tasks`;
  - budgets per assignment run;
  - assignment refusal and exhaustion;
  - the veto schedule and notifications.

  Those entity kinds are marketing's (`04` §2.3).
- **When to extract a core.** A generic agent core for a second module (Support AI, WP5.6) is worth extracting when that module needs it. This is a deliberate deviation from the plan's sketch.
- **Unchanged.** No code changed beyond import paths. The review eval's prompt hash (`evals/agents/code-version.ts`) is unchanged; the offline review eval passes.
- **Boundary violations.** Five known platform → marketing imports are resolved, so the baseline drops from 27 to 22. The 14 remaining platform → marketing imports are in `chat`, `chat-runner` and `chat-tools` (WP2.2) and in `telegram` (WP2.5).

**Verification (local, isolated test database).** Full suite: 145 files, 1354 tests, including the offline agent and operator evals. API and web typechecks pass. Boundary check: 22 known violations, none new.

## Readiness, channel names and Drive state without platform imports of marketing: WP2.1f-3b (2026-10-14, local)

Branch `claude/wp21f3b-contributors`. Six known platform → marketing imports are resolved, so the baseline drops from 33 to 27. Behaviour is unchanged.

- **Readiness.**
  - `readiness.ts` and `action-readiness.ts` (with its test) move to `modules/marketing/readiness/`. They are marketing's go-live readiness: policy, publisher, channels and Drive-backed posts.
  - Marketing registers them as the readiness provider (`readiness` contribution, at most one).
  - The dashboard, the assistant's project status and the policy activation read it through `platform/governance/readiness.ts` (`projectReadiness`).
  - Splitting readiness by owner would reorder the blockers. That is left for the platform home.
- **Channel names.** The owner's decision list (`listActionRequests`) gets channel names from registered channel directories. Marketing contributes the Postiz one. Before, the list imported Postiz code.
- **Drive state.** `driveReconnectRequired` moves to the platform's Drive connection (`google-drive.ts`); marketing's `drive-readiness` re-exports it.
- **Assets.** `assets.ts` (bytes, normalization) is classified as platform in the boundary checker, as planned (`04` §2.1, later `platform/files`). It imports nothing from marketing.

**Verification (local, isolated test database).**
- Full suite: 145 files, 1354 tests. API and web typechecks pass.
- Boundary check: 27 known violations, none new.
- Mutation check: without the channel directory, the action request and package schedule tests fail on the channel names.

## Marketing routes as a module contribution: WP2.1f-3a (2026-10-14, local)

Branch `claude/wp21f3-routes`, the third part of WP2.1f. The marketing module now registers its own HTTP routes (`routes` contribution, `platform/http/routes.ts`). There are 21 routes, moved unchanged from `server.ts` and registered at the same paths:

- Slack interactions
- content export and `PATCH content/:id`
- the marketing profile
- the ten Orbit Agents routes
- brand asset upload and content, Drive retry, image generation
- the three content package controls

Further notes:
- The platform hooks apply to these routes as before: origin check, rate limits, error mapping, and the Orbit Agents gate on the matched route pattern.
- Some routes stay in `server.ts` for now: dashboard, operations, Google Drive connection, chat, action requests and the generic collections. Some of them become the platform home and connections work (WP2.5, Phase 4).
- `server.ts` is down to 1165 lines; it was 2340 before WP2.1f.
- The OpenAPI document generated with sorted keys is identical before and after: 68 paths, the same definitions.
- The access matrix is unchanged.
- The import-boundary baseline is unchanged at 33.

**Verification (local, isolated test database).** Full suite: 145 files, 1352 tests. API and web typechecks and the boundary check pass.

## Project actions as module contributions: WP2.1f-2 (2026-10-14, local)

Branch `claude/wp21f2-actions`, the second part of WP2.1f. The if-chain of `POST /api/projects/:projectId/actions/:action` in `server.ts` (65 actions, about 760 lines) is replaced by handlers that the platform and the modules register.

- **`platform/http/actions.ts`:** `ActionHandler` comes in two kinds. `sharedTransaction` runs in the project transaction the route opens. `ownTransaction` covers handlers that open their own transactions or none: provider calls, Drive reads that need the project lock, hybrid retrieval. Twelve actions keep `ownTransaction`, as before.
- **Handler bodies, moved unchanged:**
  - Platform (`platform/http/platform-actions.ts`): `add-member`, `project-settings`, `openai-configure`, `connector`, `pause`, `retention`, `resolve-exception`.
  - Knowledge (`modules/knowledge/actions.ts`): 15 actions. They still call the knowledge services where they live today (WP3.3 moves them).
  - Marketing (`modules/marketing/actions.ts`): the rest. That includes `connector-health`, whose Postiz and Matomo checks stay with marketing until the connections registry (WP2.5), although its permission is a platform one.
- **The route** keeps its order: permission check, body parse, then lookup. An unknown name still gets `400 ACTION_NOT_SUPPORTED`.
- **`server.ts`** shrinks by 864 lines (77 imports fewer).
- **Tests:**
  - The access matrix and the permission catalogue test now take the action names from the registry instead of parsing `server.ts`. The access matrix fixture is unchanged.
  - New registry tests pin the 65 names, one permission per action and the twelve `ownTransaction` actions.
  - Mutation check: switching `postiz-test-prepare` to the shared transaction fails that pin.
- The import-boundary baseline is unchanged at 33.

**Verification (local, isolated test database).** Full suite: 145 files, 1352 tests. API and web typechecks and the boundary check pass.

## Marketing agents and tools in the module folder: WP2.1f-1 (2026-10-14, local)

Branch `claude/wp21f1-agents`, the first of three parts of WP2.1f. Files move unchanged apart from import paths:

- The Orbit Agents files go to `apps/api/src/modules/marketing/agents/`: assignments, runs, veto, notifications, content packages, scheduling, banners and the rest, 20 files with 3 tests.
- The specialists go to `apps/api/src/modules/marketing/agents/specialists/`: analytics, research, strategy, copywriter, visual, review and `index`.
- The marketing assistant tools go to `apps/api/src/modules/marketing/tools/`: read, proposal, package, assignment, channel and agent tools, plus `index`.
- The platform parts stay where they are for now: the runtime shims, the tool registry, and the specialist runner core and types. WP2.1f-3 splits the runner and removes its marketing imports.
- The old paths keep one-line re-exports. They serve the worker and eval tests and the platform importers, including the two lazy `import()` calls in `chat.ts`.
- The `scheduling` mock in `assignment-veto` follows the move.
- The import-boundary baseline is unchanged at 33.

**Verification (local, isolated test database).** Full suite: 145 files, 1350 tests, including the offline agent and operator evals. API and web typechecks and the boundary check pass.

## Marketing brand and analytics in their module folders: WP2.1e (2026-10-14, local)

Branch `claude/wp21e-brand-analytics`, the fifth part of WP2.1. Files move unchanged apart from import paths:

- To `apps/api/src/modules/marketing/brand/`: `marketing-profile`, `image-generation`, `image-requests`, `render-asset`, `asset-tools`, `drive-readiness` (with its test).
- To `apps/api/src/modules/marketing/analytics/`: `matomo` (with its test), `matomo-schedule` and `lifecycle`. `lifecycle` is now only marketing memory, metrics and experiments, plus re-exports of the platform scheduler and retention. It leaves the platform zone of the boundary checker.

Further notes:
- The old paths keep one-line re-exports. They serve `evals/generation/harness.ts`, `evals/operator/offline.test.ts`, the worker's `due-marker` test and the platform importers.
- `asset-tools` reads the built-in EDS logo by a path relative to its own file. That path is adjusted. A new integration test reads the logo, and it fails with the old path.
- The import-boundary baseline is unchanged at 33.

**Verification (local, isolated test database).** Full suite: 145 files, 1350 tests. API and web typechecks and the boundary check pass.

## Marketing publishing in its module folder: WP2.1d (2026-10-14, local)

Branch `claude/wp21d-publishing`, the fourth part of WP2.1. Nine files and their five co-located tests move unchanged to `apps/api/src/modules/marketing/publishing/`:

`publisher`, `postiz-assignment`, `postiz-draft`, `postiz-verification`, `postiz-queue-watch`, `channel-rules`, `posting-slots`, `calendar` and `slack`.

- The old paths keep one-line re-exports. They still serve the platform importers and `evals/generation/harness.ts` (`resolveChannelRules`).
- Files in `modules/marketing/` import moved files by their new path.
- The `content-export` mock in the Postiz verification test follows the move. It still asserts the mocked Drive reads.
- No logic, route or response changes. The import-boundary baseline is unchanged at 33.

**Verification (local, isolated test database).** Full suite: 144 files, 1349 tests. API and web typechecks and the boundary check pass.

## Marketing policy in its module folder: WP2.1c (2026-10-14, local)

Branch `claude/wp21c-policy`, the third part of WP2.1. `policy.ts` (publishing preflight, claims, approvals, modes), `fact-claims.ts` and `fact-placeholders.ts` move unchanged to `apps/api/src/modules/marketing/policy/`, with their two tests.

- The old paths keep one-line re-exports. That covers `evals/generation/harness.ts`, which imports `checkClaims` from the old path.
- Files already in `modules/marketing/` import moved files by their new path, not through the re-exports.
- No logic, route or response changes. The import-boundary baseline is unchanged at 33.

**Verification (local, isolated test database).** Full suite: 144 files, 1349 tests. API and web typechecks and the boundary check pass.

## Marketing pipeline in its module folder: WP2.1b (2026-10-14, local)

Branch `claude/wp21b-pipeline`, the second part of WP2.1. The 15 pipeline files move unchanged to `apps/api/src/modules/marketing/pipeline/`, with their 6 co-located tests:

`workflow`, `generation`, `editorial`, `planning`, `draft-batch`, `draft-cleanup`, `draft-similarity`, `draft-statuses`, `content-export`, `content-invalidation`, `content-provenance`, `mission-archive`, `mission-evidence`, `paused-posts`, `autopilot`.

- Every old path keeps a one-line re-export, so importers are unchanged. Later parts switch the importers and remove the re-exports.
- Two tests mock the moved modules: `assignment-copywriter-visual` mocks `content-invalidation` and `postiz-verification` mocks `content-export`. They now mock the new path. That mock also reaches importers that still use the old path, and both tests assert the mocked behaviour.
- No logic, route or response changes. The import-boundary baseline is unchanged at 33.

**Verification (local, isolated test database).** Full suite: 144 files, 1349 tests. Typecheck and boundary check pass.

## Worker through the module registry: WP2.1a (2026-10-13, local)

Branch `claude/wp21a-marketing-move`, the first part of work package WP2.1 (marketing server move). The worker no longer imports module files; behaviour is unchanged.

- New contribution `periodic` (`PeriodicTask`): per-project work the worker runs after dispatching jobs, outside the sweep transaction, with an optional `nextDueAt` for the project's wake-up and an optional published `health` status. Marketing contributes, in the previous order:
  - `matomo-schedule`: saved Matomo imports.
  - `postiz-queue`: the read-only queue check. It still publishes to `orbit:postiz-queue:<instance>`, so `/api/health/postiz` is unchanged.
- New contribution `onWorkerStart`: marketing registers the agent specialists there. The API and the tests do not register them, as before.
- `runtime.ts` reads a periodic task's health through the registry (`periodicTaskHealth`) instead of importing marketing.
- The worker takes the sweep from `platform/jobs/scheduler.ts`.
- Known import-boundary violations: 33 (after WP1.8: 37). No worker → module import is left.

**Verification (local, isolated test database).** Full suite: 144 files, 1349 tests. That includes the Postiz health route test (`auth.integration`) and new registry tests for task order, the health summary, the start hook and duplicate names. The worker process itself was not started locally; the CI browser run starts it through `pnpm dev`.

## Pause, export and retention hooks: WP1.8 (2026-10-13, local)

Branch `claude/wp18-hooks`, work package WP1.8 of the modularization roadmap (ADR 0009). Project pause, export and retention become platform operations that modules extend. Behaviour is unchanged.

- **Pause** (`platform/governance/pause.ts`; `modules/pause.ts` re-exports it). The platform bumps the generation, ends waiting chat replies and audits. Modules add steps through `ProjectHooks` in the same transaction and at the same points as before. Marketing (`modules/marketing/hooks.ts`):
  - `onProjectPause` blocks publications and raises reconciliation exceptions;
  - `afterProjectPause` notifies the owner's Telegram bot, unless the bot asked for the pause itself;
  - `onProjectResume` puts held-back assignment tasks back on the queue.
- **Export** (`platform/governance/export.ts`). Owners declare entity kinds with `exported: false`: the platform for `connectors`, `telegram_connections`, `drive_connection` and `drive_oauth_state`, Knowledge for `evidence`. These are the same five kinds the hard-coded list held.
- **Retention** (`platform/governance/retention.ts`). The platform validates the period, asks each module's `retention` contribution to purge what expired, and writes one `retention.apply` audit entry. Marketing purges insights and preferences, unchanged (`modules/marketing/retention.ts`).
- Two platform → marketing imports in `pause.ts` are gone. Known import-boundary violations: 37 (after WP1.7: 39).

**Verification (local, isolated test database).**
- Full suite: 144 files, 1347 tests.
- New characterization test `project-operations.characterization.integration.test.ts`: export exclusions, retention result, statuses and audit. It passed before the change and after it.
- The pause suites (`chat-pause`, `paused-posts`, `telegram`, `agent-notifications`) and the access matrix are unchanged.
- Mutation checks:
  - Without the marketing hooks, 5 pause tests fail.
  - Without `exported: false` on evidence, the export test fails.

## Web shell and navigation: WP1.7 (2026-10-13, local)

Branch `claude/wp17-web-shell`, work package WP1.7 of the modularization roadmap (ADR 0009, AD-12). The web app gets one URL per page; the views themselves are unchanged.

**URL scheme.**
- `/` opens the last used project, else the only one, else a picker.
- `/o` lists organizations (server: workspaces), `/o/:orgId` their projects; owners create projects there.
- `/p/:projectId` is the project home; platform pages are `/p/:projectId/{assistant,approvals,connectors,operations,settings}`, module pages `/p/:projectId/knowledge` and `/p/:projectId/marketing/{missions,content,calendar,assets,analytics,memory}`. A module root opens its first page.
- The 13 paths from before (`/missions`, `/chat`, `/settings`, …) redirect into the last used project and keep query and hash, so bookmarks, the Telegram "In Orbit öffnen" link (`/approvals`) and the Google Drive callback (`/settings?googleDrive=…`) keep working. In-app links and the API's chat card links are rewritten to the open project.
- Unknown addresses show "Page not found"; a project the user cannot open shows "Project not available". Before, both silently showed the Overview.
- Switching the project keeps the page and changes the URL.

**Structure.**
- `apps/web/src/platform/ui/`: the shared view helpers and the form kit, formerly in `work.tsx` and `components/form.tsx`. This removes the `advanced.tsx` ⇄ `work.tsx` import cycle.
- `apps/web/src/platform/shell/`: route table (`routes.ts`, checked for conflicts at start), shell context, project home, pickers, not-found view.
- `apps/web/src/modules/{knowledge,marketing}/manifest.tsx`: web manifests (views, navigation entries, legacy paths, home section). They point to today's components; WP2.3 and WP3.3 move the components.
- `apps/web/src/modules/registry.ts`: the web composition root. The shell (`components/orbit.tsx`) imports no module; import-boundary violations drop from 45 to 39.
- Navigation and the project home hide modules that `GET /api/projects/:id/modules` reports as off; until that answer arrives, or if it fails, all modules count as on. A page of a module that is off shows a notice. The server does not enforce activation yet (WP2.4).
- Project home: the assistant prompt (the text opens in Orbit Chat for review; nothing is sent automatically), one tile per module with its pages, then the marketing overview.
- The mobile bottom bar comes from the manifests (`mobile` flag), in the old order.
- The stored language choice is no longer overwritten by the default during the first render.

**Verification (local).** Web typecheck, unit and component tests (16 files, 83 tests), import-boundary check and a production build of the web app (`next build --webpack`; Turbopack refuses the symlinked `node_modules` of this worktree). Manual check against a synthetic mock API: pickers, home, project switch, a project with marketing off, legacy redirect with query and hash, both not-found pages, 375 px without horizontal scroll, German labels. The Playwright suite (new `navigation.spec.ts`, updated `workspace.spec.ts` and `chat.spec.ts`) runs in CI; a local run needs an isolated browser database that was not set up here.

## Safety net for the modularization: WP0.2 (2026-10-13, local)

Branch `claude/wp02-safety-net`. This adds tests and a CI guard only; no product code changed. It is work package WP0.2 of `plans/orbit-modularization/07-roadmap.md` (decision baseline: PR #93, ADR 0009).

**RLS matrix (10 tests).**
- Every public table is classified. A new table fails until it is classified.
- FORCE RLS is required on all scoped and tenancy tables.
- The app role has no grants on auth, membership or system tables. The audit log is append-only.
- Unscoped reads return nothing.
- Each project sees its own seeded rows in all 18 scoped tables, and nothing of another project in the same or another workspace.
- Chat rows are private to their user.
- Cross-project updates and deletes change nothing, and cross-project inserts fail on RLS.
- Verified by temporarily disabling RLS on `Outbox` in `orbit_test`: 4 of the 10 tests fail, and the insert test then fails too.

**Access matrix.**
- 198 route, collection and action requests for 5 roles, pinned in `apps/api/tests/fixtures/access-matrix.json`.
- Invariants: callers without a session get 401 except on 7 public routes; a non-member never reaches a project route; no request is rate-limited, times out or returns a 5xx.
- Verified by removing `pause` from the owner list: the test reports the editor change.

**Worker queue dispatch.** The 7 queue classes without a dedicated test are pinned with their stop codes. Current behaviour, kept: a missing index generation (`INDEX_UNAVAILABLE`) uses all three attempts before it stops.

**CI.**
- `tests/setup.ts` fails under `CI=true` without the test database URLs and Redis, so a broken setup can no longer pass with 69 skipped integration files.
- `pnpm test:migration-profile` now runs in CI.

## Modular Orbit Platform: decision baseline (2026-10-13, docs only)

Mario accepted the modularization plan in `plans/orbit-modularization/` (documents 01–09) as the decision baseline. This was work package WP0.1, recorded in [ADR 0009](adr/0009-modular-platform.md).

The plan covers:

- Orbit Platform plus statically registered modules, with Marketing and Knowledge first;
- an own Support module with no Chatwoot dependency;
- a central MCP gateway under `https://orbit.eds-labs.io/mcp`. ADR 0007 has an addendum lifting the MCP non-goal.

No code, schema or deployment change was made. The next work package is WP0.2, the safety net: RLS and route × role matrices, worker smoke tests and a CI guard against silently skipped integration tests. Pre-existing findings are being fixed separately: F-01 in PR #91 and F-02 in PR #92.

## Assignment banners in the brand style (2026-10-12, local)

Review fix round (R79, commit after `60ebd02`): agent review authority does not cover banner posts with publish delivery (they wait for the owner until the review eval has banner cases; Postiz draft delivery unchanged); revisions keep the banner (`previousBanner`); banners stay tied to approved, unchanged background, logo and profile (key, save re-check under the run lock, `bannerState`); uploaded raster logo with verified bytes only; `BANNER_BRAND_OVERFLOW` at proposal and run time; per-banner render failures (`BANNER_RENDER_FAILED`); banners bound to their post and out of the library and pickers; banner claim words revised once, NFKC and script checks (`BANNER_TEXT_UNSAFE`); copies of media-capable channels keep the slot's banner when only the strictest channel refuses it (`BANNER_MEDIA_REFUSED`). DejaVu stays the font.

Branch `claude/assignment-banners` on top of package 1 (`d22e87e`), ruling R78, not pushed or deployed. Assignments gain the optional confirmed field `banner: {template: "brand_landscape", style?}` (social with `image: true` only, hashed only when set, needs the profile's approved logo). The visual step generates one landscape background per run (art only, banner style prompt), the copywriter writes structured banner copy per draft, and Orbit composes one 1600×900 banner per slot over the background with the new `brand_landscape` template in packages/creative (approved logo, wordmark, white and cyan headline, subline, outlined button, divider, footer domain; `TEXT_OVERFLOW` never cuts). The banner is an approved asset attached to the slot's drafts on every channel (R76) and delivered to Postiz unchanged. The review checks the copy deterministically (overflow revised once; figures, status, promises, links and an unofficial link rejected; a missing banner left for the owner), shows it to the review model as data and binds it in the agent review (`bannerHash`). Assignment tools, the card and the assignments page carry the banner. No route, schema migration or new dependency; the review prompt and the draft prompt of assignments without a banner are unchanged. Fonts: only DejaVu in the runtime image (Inter recommended, not added). Details: [OPERATIONS.md](OPERATIONS.md#orbit-agents).

## One post per slot across channels and assignment format (2026-10-12, local)

Branch `claude/assignment-shared-posts`, rulings R76 and R77, not pushed or deployed. Assignments gain two confirmed fields, both social only and part of the confirmation hash only when set (older confirmations stay valid): `sharedAcrossChannels` (one text and one image per slot for all channels: one brief per slot group on its strictest channel, one copywriter step, one review per text, then per-channel copies checked on their own channel and delivered as Postiz drafts or publications with the same text and image; a channel whose checks fail is dropped with a notice; one slot per channel stays held) and `format` (length, hashtags, paragraphs and an official CTA link; carried into the strategy input and the generation contract; deterministic review checks `FORMAT_LENGTH` and `FORMAT_HASHTAGS` with one deterministic revision, then reject). `assignment_propose`/`assignment_change`, the card and the assignments page carry both. No route, schema migration or new dependency; the review model's prompt (and so the review eval's hash) is unchanged. Budget check in R76: at 10 USD/month the shared mode keeps room for one revision per slot only narrowly, 20 USD/month comfortably. Fix round (same branch as the banners, R76/R77 addenda): a failure on the strictest channel only holds back that channel's post while the text goes to the others; a text left for the owner after a failed revision is copied to every channel; dropped and rejected shared texts are reported and counted per channel; verdicts are bound to the judged text; copies drop the image on channels without media support; the copywriter sees every shared channel's history; formats are checked against the channel limits (`FORMAT_EXCEEDS_CHANNEL_LIMIT`); length in UTF-16 units, digit-only tags are no hashtags; `format` and `banner` can be cleared from chat. Details: [OPERATIONS.md](OPERATIONS.md#orbit-agents).

## Assignment delivery as Postiz drafts (2026-10-10, local)

Branch `claude/assignment-postiz-drafts`, ruling R73, not pushed or deployed. Assignments gain the confirmed field `delivery` (`publish` default, `postiz_draft`). With `postiz_draft` Orbit never publishes: approved drafts (accepted agent review or the owner's release) are booked as `postiz_drafts` handoffs at their slot (the slot stays held) and sent by the new worker queue `postiz_draft` through the shared draft handoff of `postiz-draft.ts` (type `draft`, `outcome_unknown` never resent, existing resolve action); no publication, veto window, preview or publish right; preflight blocks publications of such content. Gated by `ENABLE_POSTIZ_DRAFTS` (`POSTIZ_DRAFTS_DISABLED` at proposal and confirmation, dropped deliverable with a notice at run time). Telegram notice `postiz_draft` per created draft, daily report line "Entwürfe an Postiz", "Anstehende Posts" shows "Entwurf in Postiz" without Stop, the card and the assignments page show the delivery, and `assignment_propose`/`assignment_change` set it. No route, schema migration or new dependency. Approval K now uses draft delivery. Details: [OPERATIONS.md](OPERATIONS.md#orbit-agents), ADR 0008 addendum 2026-10-10, [API contract](API_CONTRACT.md).

## Orbit Agents (2026-10-09, local, flag off)

Built on branch `claude/orbit-agents-spec` from the [Orbit Agents design](superpowers/specs/2026-10-09-orbit-agents-design.md) and its [plan](superpowers/plans/2026-10-09-orbit-agents.md), tasks 1–15; not pushed, merged or deployed. Everything is behind `ORBIT_AGENTS` (default `false`); with the flag off the existing chat, packages and weekly autopilot behave as before. Requirement mapping: [traceability](REQUIREMENTS_TRACEABILITY.md#orbit-agents-acceptance-2026-10-09). Operations: [OPERATIONS.md](OPERATIONS.md#orbit-agents). Rollout and approvals H–K: [rollout plan](plans/ORBIT_CORE_ROLLOUT_PLAN.md), Phase 7.

- Assignments (`Entity(kind="assignments")`): one-off and standing, social, blog or newsletter (report assignments are refused with `REPORT_NOT_AVAILABLE` until a report delivery exists, R70), with channels, times, topic frame, image, style references, veto window and monthly budget; draft until an owner confirms the exact content (`assignment.confirm`, ADR 0008 addendum), with the image-rights consent for image assignments. Orbit Core tools `assignment_propose`, `assignment_change`, `assignment_list`, `run_status` (deferred, need tool search).
- Runs (`assignment_runs`) per assignment and local date with a work plan; slots respect quota, spacing and calendar blocks across all assignments and the autopilot; DST-safe local times.
- Specialists on the `AgentRuntime` port (ADR 0005 addendum): analytics (Postiz and Matomo, honest `noData`), research (hosted web search, findings never become facts), strategy (one brief per slot from verified facts and 14 days of channel history), copywriter and visual as executor steps on the existing generation and image paths, review with deterministic checks first, one revision and the rules for drafts left to the owner. Worker queue `agent`, budget per call, task, run, assignment month and project; `outcome_unknown` never repeated.
- Channel history (`channel_posts`) from the Postiz post list, external and Orbit posts, 60 days, hourly at most; used by strategy, copywriter and the duplicate check.
- Veto window: approved posts get a publication with `vetoDeadline = slot − vetoMinutes`; late runs move to the next free slot; Stop withdraws before the handoff; agent review authority only under the conditions in the ADR 0008 addendum.
- Telegram bot: owner connection with encrypted token and one-time link code, webhook with secret header, previews with Stop, notices (including failed steps, dropped deliverables, blocked posts and drafts waiting for the owner's release, R70/R71), `/pause`, daily report at 20:00 local time; worker queue `telegram_notification`; delivery failures as `TELEGRAM_DELIVERY_FAILED` on the approvals page.
- Owner release (R70): drafts left for the owner (review left them, no bot, or agent review authority off) are listed under "Wartet auf deine Freigabe" on the approvals page; "Freigeben" (owner only) records the owner review, lets the mission publish exactly that post and schedules it at the run slot without a veto window (or the next free slot that day; else `SLOT_UNAVAILABLE`). `run_status` reports posts, drops, drafts waiting for the owner and stops from the run's scheduling and publications.
- Web: settings tab "Aufträge", the confirmation card with consent (chat and inbox), Telegram under Connections, "Anstehende Posts" with Stop and "Wartet auf deine Freigabe" with "Freigeben" on the approvals page.
- Autopilot replacement (task 15): with the flag on the sweep plans assignment runs instead of the weekly autopilot; once the Orbit Agents route answers (an outage keeps the autopilot), the autopilot tab and its approvals panel give way to a migration card that proposes the saved autopilot settings as a draft assignment (`…/assignments/autopilot-migration`), confirmed like any other. The settings stay unchanged, so a flag-off restores the autopilot.
- Migration `202610090001_agent_run_kind` (additive). New config `ORBIT_AGENTS`, `ORBIT_IMAGE_REFERENCES`, `ORBIT_AGENT_REVIEW_AUTHORITY` (all default `false`, passed through `docker-compose.yml`; the last is the gate of the review agent's authority, set only after Approval J).
- Verification on 2026-10-09 (Node 24.18.0, local PostgreSQL and Redis): lint, typecheck, 998 tests in 109 files, production build, Coolify compose check and secret scan pass. Offline only: recorded model outputs and fake Telegram and Postiz; no paid call was made.
- Open before live use: the live run of the review eval set (`evals/agents/review-v2.json`, Approval J, OA10 PASS_LIVE on 2026-10-10 in run 3 at $0.075 after the harness was given a brief the drafts follow — the diagnosis showed runs 1–2 rejected good drafts for a mismatched test brief; `ORBIT_AGENT_REVIEW_AUTHORITY` is turned on by Mario in Coolify; history: run 1 on `review-v1` on 2026-10-09 FAILED at $0.08: no bad case approved, but 7 of 8 good cases rejected after a `revise` for one sentence without a backing fact; per Mario's decision, invitations, questions and calls to action that state nothing about the product, brand or offer need no fact, which the review prompt and `review-v2` now follow; run 2 on `review-v2` on 2026-10-10 FAILED at $0.12: no bad case approved, but only 3 of 8 good cases approved (`good-needs`, `good-reply`, `good-your-team`, `good-tag` rejected after a round-1 `revise`, `good-question-planning` in round 1), diagnosis pending; the runner `pnpm eval:agent-review` exists with dry run, 2 USD ceiling, round 2 after a revision and a confirmation bound to the review prompt, plus a diagnostic mode (`ORBIT_EVAL_DIAGNOSE=good`: good cases only, 0.5 USD ceiling, the model's reasons written only to `.runtime/`, never a gate result) and an optional key from the macOS keychain, see `evals/agents/README.md`, and Mario runs it with his key), the live check of reference images (`ORBIT_IMAGE_REFERENCES`), the web search fee default of 10,000 micros per call and the reserved search content of 8,000 input tokens per search (both to be confirmed by Mario), the joint test round (spec §13). Follow-up for Mario: report assignments need a delivery (findings to the bot and a chat card) before `report` is accepted again (R70, I6). Deferred by rulings: the model-written style description (a deterministic one is used, R40), a daily report while the project is paused (none is sent), a paused and resumed day is not re-planned (R55).

## Orbit Core in production (2026-10-08)

Orbit Core (Jarvis Mode) is released: integration PR #51 merged on 2026-10-03 (`c3a1d07`), followed by fixes and features #52–#68 (latest `e8a0eeb`, deployed by Coolify). The [rollout plan](plans/ORBIT_CORE_ROLLOUT_PLAN.md) records each phase, finding and approval; this section is the summary.

- Flags: `ORBIT_CONTENT_PACKAGES=true` since 2026-10-05 (Approval C), `ORBIT_TOOL_SEARCH=true` since 2026-10-06 (Approval E, chat route `gpt-6.1-sol`). Both are passed to API and worker by `docker-compose.yml` (#52).
- Accepted in production: package card, start, drafts with passing review, revision of one channel, "next week" slots (JC05), package image with owner rights approval and attachment (Approval D), tool search (its steps are visible under Operations since #63), different package texts per channel (#64), the runtime port (#65, Approval G).
- Phase 5: Mario approved the first live package post (Approval F) — the beta post on X for 2026-10-12 17:00 (Europe/Berlin), one publication `intent_created`; a second proposal was canceled from the card before approval. The check after the slot is open.
- Fixed from production findings: compose flags (#52), profile audience length and validation codes (#53), duplicate identical facts (#54), the first policy-allowed official link (#55), package fact keys (#56), single-word fact claims (#57), approved-image badge and the `source-map-js` advisory (#58), "approve all" past missed slots (#59), autopilot drafts that repeated an earlier day (#60), stopped posts after a pause and missed slots (#62), the `sharp` advisory (#66), chat while paused (#67), channel names in decisions and closable exceptions (#68).
- The uLiquid project was paused on 2026-10-06 and resumed on the same day with Mario's approval; the posts stopped by the pause stay blocked until the owner schedules them again on the approvals page.
- Known: the login cookie expires 8 hours after sign-in although the session is meant to slide; a fix needs Mario's approval (auth change).
- Not built: voice (J4, JC18) and an honest "no analytics measurements" answer (JC19).

## Current state and agent platform alignment (2026-10-02)

Orbit is deployed in production via Coolify. The latest documented release is `9979ad3` (2026-10-02, PR #26 Postiz queue watch, on top of `c8cfeec` with PRs #23 and #24 and `434ea4e` with PR #22); later commits on `main` are documentation only, except PR #30 (`669a408`, merged as `9c46b0d`), which keeps saved text and image prices valid until the owner changes them. Whether `9c46b0d` is deployed was not verified in the 2026-10-02 Orbit Core review. A read-only check on 2026-10-02 found `/api/health/ready` ok and the new `/api/health/postiz` answering 200, so the queue watch is running in production. Production runs `EXECUTION_MODE=live` with `ENABLE_EXTERNAL_WRITES=true`. The uLiquid project is in `autopilot` mode: Telegram uLiquid Desk and X uLiquid are write- and media-verified, the active policy allows one post per channel and day until 2026-12-31T23:00Z, and the weekly plan runs Sundays at 12:00 from 2026-10-05 (`docs/ORBIT_ULIQUID_PRODUCTION_GOAL.md`, Progress Log 2026-10-02). Postiz write verification now reads Drive-only PNGs before taking the project lock (PR #24). Statements below such as "no production deployment" or "local uncommitted change set" describe their own earlier checkpoints and are historical.

Mario accepted the [OpenAI agent platform alignment plan](OPENAI_AGENT_PLATFORM_ALIGNMENT_PLAN.md) with decisions D1–D4. Phase 0 (local, no production change):

- ADRs [0005 agent runtime](adr/0005-agent-runtime.md), [0006 agent state and data retention](adr/0006-agent-state-and-data-retention.md), [0007 tool registry](adr/0007-tool-registry.md) and [0008 action approvals](adr/0008-action-approvals.md).
- `openai` npm package 7.17.0 → 7.25.0, no code changes required.
- Cost baseline from settled production receipts: [agent-platform-baseline-2026-09-30](evidence/agent-platform-baseline-2026-09-30.md).
- Known local issue: the real-Redis worker lifecycle test times out in local environments with a large accumulated test database; it fails identically before the upgrade.
- Phase 1 (observability and cost foundation; released to production on 2026-10-01 as `dce2ad4`, see the plan §17): cache-aware cost settlement with rate card v2, additive `AgentRun`/`AgentSpan` telemetry tables and budget attribution (migration `202609300001_agent_telemetry`), editor/owner endpoints `agent-runs` and `ai-cost`, and structured redacted API request logging with `LOG_LEVEL`. 429/430 tests pass; the failure is the known worker lifecycle test above. The migration was applied by the release.
- Phase 2 (model routing v2 and generation evals; released to production on 2026-10-01 as `cb23603` together with PR #14, see the plan §17): configurable task-class routes `chat_operator`, `draft_social`, `draft_blog` with model, optional reasoning effort and output ceiling, owner-editable in the OpenAI configuration dialog, with the legacy tier as default (no behaviour change without a saved route). Route version recorded on every `AgentRun` (migration `202610010001_agent_run_route_version`, additive); a configuration save during a run stops it fail-closed. Known cost of unusable model output is settled (`MODEL_OUTPUT_NOT_VALID`). Offline generation eval harness on the real generation and review path, and a manual live eval runner capped at $5 with a dry run and a confirmation that binds dataset, prices and ceiling. The live eval has not been run. See `MODEL_ROUTING.md`, `OPERATIONS.md` and the plan §17. After merging `main` with PR #14 (worker queue pump), 519/519 tests pass, including the worker lifecycle test.
- Phase 3a (released 2026-10-01 with PR #22 as `434ea4e`): chat tools are declared in a registry and sent with strict schemas generated from zod; viewers are no longer offered `propose_campaign`. See the plan §17.
- Drive reconnect readiness (PR #23, released 2026-10-02 in `c8cfeec`): on 2026-10-01 production `GET /api/projects/:id/google-drive/health` returned `GOOGLE_DRIVE_OAUTH_FAILED` while readiness still reported `drive_save: ready`. A refresh rejected by Google (HTTP 400/401/403) is now recorded on the `drive_connection` record as `lastRefreshFailedAt`/`lastRefreshErrorCode` and cleared by the next successful refresh or a reconnect. Readiness reads only this recorded state, never Google. `drive_save` reports `GOOGLE_DRIVE_RECONNECT_REQUIRED`; `postiz_schedule`, `postiz_live` and the global blockers (which gate live autopilot policy activation) report it when enabled autopilot settings or a running mission reference a Drive-only asset. No schema migration. See `integrations/google-drive.md`.
- Worker queue pump (PR #14, released 2026-10-01): projects are processed only when their `workDueAt` marker is due. Follow-up fix (local): a pass now claims the marker with a 60-second lease first, so work written while a project is being processed is no longer delayed by up to five minutes (lost wakeup seen once in CI as a test publication stuck in `intent_created`). See `OPERATIONS.md`.
- Orbit Core / Jarvis Mode (accepted 2026-10-02, [plan](plans/ORBIT_CORE_JARVIS_PLAN.md); released 2026-10-03, see "Orbit Core in production" above). One chat request becomes a content package: one draft-only mission per channel and an optional owner-approved image, started with one click, reviewed with the existing claim checks, shown as one card, cancelable, and revisable per channel. Slices: PR0 worker chat jobs run with the requesting user's current role (`ACTOR_MEMBERSHIP_REQUIRED` otherwise); PR1 `ActionRequest` core (`Entity(kind="action_requests")`) and a single-attempt worker image executor; PR2 package request, plan and one-click start; PR3 image, review, cancel and partial results; PR4 targeted revision; S1 `AgentRuntime` port with the legacy loop; S2 Agents SDK spike, no-go (ADR 0005 addendum); PR5 operator evals (`evals/operator/`) and acceptance rows JC01–JC20 (17 PASS_TEST, 3 NOT_RUN, fake providers only; JC06 covered by a real-Redis worker crash and restart test); J3.0 slot overview (`schedule_options`); J3.1 scheduling by owner decision (`propose_schedule`, action type `content.schedule`, [J3 plan](plans/ORBIT_CORE_J3_SCHEDULING_PLAN.md)); J3.2 the weekly autopilot skips days that scheduled posts already fill; J3.3 the rights-approved package image can be attached per draft; J3.4 scheduled package posts can be canceled before the handoff and moved with a new owner decision; J3.5 operator evals `cases-v2.json` for scheduling. Client-executed tool search for Orbit Chat behind `ORBIT_TOOL_SEARCH` (ADR 0007 addendum; live check pending). Merge and rollout: [plan](plans/ORBIT_CORE_ROLLOUT_PLAN.md), proposed, awaiting approvals A–G. Everything new is behind `ORBIT_CONTENT_PACKAGES` (default `false`) except PR0 and the J3.2 autopilot skip. No migration. Not yet: merges to `main`, the production flag, and a paid live acceptance run; each needs its own approval.
- Postiz queue watch (released 2026-10-02 with PR #26 as `9979ad3`): after a hung Postiz orchestrator left scheduled posts in `QUEUE` for a day unnoticed, the worker checks the assigned channels every 10 minutes, opens a self-closing `POSTIZ_QUEUE_STALLED` exception for posts more than 15 minutes overdue, and exposes `GET /api/health/postiz` (503 when stalled) for Uptime Kuma. See `OPERATIONS.md`.

## Index activation control (2026-09-25)

Index Management offers activation after an index generation reaches `evaluated`, while a `building` generation offers only build and evaluation actions. The server still checks the current corpus and live evaluation at activation time. A browser regression covers both UI states and opens the confirmation dialog without submitting a production change.

## Orbit Chat v1 local implementation (2026-09-25)

The new private project chat, bounded Responses tool runner, reviewable draft-only proposals, and first-draft job bridge are implemented locally. See `docs/ORBIT_CHAT_V1.md` for API contracts and release boundaries. This checkpoint is not production authorization or proof of a live paid model call.
Local verification on Node 24.18.0: additive migration on a disposable database, API/client generation, lint, typecheck, 298 tests across 24 files, production build, 7 authenticated Chromium workflows, framework check, secret scan and high-severity dependency audit passed. A real Responses stream, remote CI run, production migration and deployment remain outside this checkpoint.

Checkpoint refreshed: 2026-09-22, Europe/Berlin. The integrated application and both isolated Linux hosting variants have local acceptance evidence; this is not production authorization.

## Configuration-parity checkpoint (2026-09-18)

The historical acceptance summary below proves the prior backend and UI scope only. It must not be read as proof that the uLiquid marketing-profile workflow was available end to end.

- Implemented locally: versioned owner-only marketing profiles, immutable profile history, product/presale campaign typing, profile-bound content validation, profile-change invalidation, approved-asset status, and campaign-aware publication preflight.
- Preserved: existing facts, sources, assets, preferences, missions and content are not rewritten by the migration. Legacy human-authored content remains visible but is blocked from publication until an owner explicitly links it to a profile-bound mission.
- Verified in the 2026-09-22 refresh: the authenticated browser flow configures and versions the profile, binds mission/content to it and inspects the draft. `test:migration-profile` applies all forward migrations to a uniquely named disposable local database, preserves seeded legacy rows and verifies forced RLS before dropping only that database.
- Still not claimed: external Telegram/provider capability proof. No provider write was attempted.

See `docs/CONFIGURATION_PARITY.md` for the acceptance matrix and the distinct external gates.

## Brand kit and image-generation checkpoint (2026-09-19)

- Implemented locally: project visual identity (bounded colors, local font presets, design rules and selected approved logo), owner-only PNG/JPEG/WebP asset upload, metadata-stripping PNG normalization, project-scoped protected previews, asset rights/status audit, and deterministic brand-aware creative composition.
- Added the optional OpenAI GPT Image 2.5 path with Flare as default and Sunburst selectable. The Settings UI can retain the shared OpenAI key or save a separate encrypted image key later; neither key is returned after saving.
- Safety boundaries: model allowlist, dated non-zero per-image ceiling, active policy, atomic budget reservation, exact per-request prompt/cost confirmation, rate limit, no generated logo/copy, normalized output, provenance, and separate approval before use.
- Focused local verification covers brand schema bounds, raster normalization/MIME rejection, response byte redaction, image configuration and explicit confirmation, prompt constraints and brand-aware rendering. The prior synthetic PDF failure was traced to an unsupported Node 20 shell; the project requires Node 24 and now includes `.nvmrc` pinned to 24.18.0. On that supported runtime the PDF test and complete 280-test suite pass.
- The authenticated browser flow now uploads and approves a real PNG, binds it to the versioned brand profile, reaches and verifies the exact paid-generation confirmation without dispatch, cancels it, and renders a local approved-asset composition.
- No real provider API key was created or stored. The browser test used only a synthetic local test value, made no paid image request, and performed no production deployment or migration.

## Current verified state

- Framework 1.1.0 missing-only merge; actual archive mismatch documented. Full schema/YAML validation:0 errors/0 warnings;12 framework tests passed. Narrow restore-source/evidence filename exceptions retain duplicate-file checks.
- Pinned Node 24.18/Next 16.3.6/React 19.3/TS 6.0.3/Fastify 5.12.5/Prisma 7.10/PostgreSQL 17/pgvector 0.8.6/BullMQ 6.3.6/Redis 7.4.7 application. Restricted app/auth DB roles and forced RLS verified.
- **280 tests across 20 files passed** on Node 24.18.0, including the synthetic PDF parser case, knowledge/parser/index coverage, mocked-paid/real-journal race tests, actual auth, Matomo normalization/import, signed Slack approvals, Postiz observed proof, community adaptation, source revocation, shared budgets, DST/concurrency and real Redis worker restart.
- **5/5 current authenticated browser workflows passed** against the local development stack in 30.6s on installed Chrome, including the new marketing-profile and brand/image acceptance path. Historical production-build evidence remains 4/4 in 22.7s; the current production build passes separately. No provider write or paid model call occurred.
- Latest production Next build, whole-project/web TypeScript, lint/source checks and generated API/client succeeded. Dependency audit:0 high/moderate/low/critical after two narrow overrides;406 installed dependency/license records. Source and generated-public-artifact secret scans passed.
- Real isolated pg_dump/pg_restore passed with tombstones, source rights, audit and unknown publication state; restored projects are paused/Observe and no publisher starts.
- Both fresh Linux ARM64 container variants passed migrations/grants, real restricted roles, HTTPS auth/Origin checks, non-root/read-only operation, cgroup CPU/RAM/PID enforcement and four branded PNG formats. Shared-host services publish no host ports. Worker outage detection, recovery and graceful exit passed. Evidence: `docs/evidence/container-acceptance.json`.

## Integrated functionality

Authenticated multi-project roles; guided capability setup; public/model rights; manual/file/allowlisted website/GitBook ingestion; structured verified facts/conflicts; exact-filtered hybrid retrieval; evidence inspectors; separate immutable index builds/evals/activation/rollback; bounded mission work packages, reusable content and measured follow-up; Social/Blog/Newsletter/Ads/Script drafts and portable exports; original-brand PNG rendering; reviewed-parent channel adaptations; authorized private community grouping/linkage; calendar blackout rules; exact-package approvals and test/live-gated publishing; Matomo/CSV metrics, experiments and reversible memory rules; signed one-use Slack decisions; persistent exceptions/outbox/jobs, real worker heartbeat and owner lifecycle controls.

Default writes remain off. Live readiness reads current database evaluation provenance/config/corpus/settled receipts, not an environment assertion. Postiz capability is bound to tested account, connector version, publisher instance and separate media proof. Its group-wide delete is not exposed because current remote group membership cannot be proven. Blog/mail/ads/community live providers remain capability-specific gaps; their authorized drafts/imports/exports work.

## Integration corrections completed

Paid cost settlement survives revoked results; reservations cannot transmit twice; query+text share a run ceiling. Restart reuses committed generated content before review without another model call. Saved schedules cannot send early. All safety history remains visible beyond 500 UI rows. Approval binds connector/account/asset/evidence/policy. Source or model-right changes quarantine in-flight work. Parser ZIP/PDF/DNS bounds, terminal retries, source-revocation terminal receipts, and runtime credential generation were regressed.

The earlier 253-test run exposed that malformed follow-up data could abort a global queue sweep. The worker now isolates each project; missing follow-up content produces a visible blocked mission. A real Redis test includes the broken dependency alongside a valid autonomous cycle and passes in the current 280-test suite.

## Acceptance outcome

All 88 controlling-master acceptance IDs remain mapped: **79 PASS_TEST, 3 PASS_LIVE (read-only VPS observations), 6 BLOCKED_EXTERNAL, 0 NOT_RUN**. The two supplemental matrices now total **14 PASS_TEST, 2 BLOCKED_EXTERNAL, 0 NOT_RUN** after closing CP06, CP07 and BI08. The original external criteria remain A05, A14, A17, H07, H08 and K08; supplemental CP08 and BI07 also require external authorization/evidence.

The two dedicated container acceptance stacks were stopped while retaining their volumes. This refresh also stops its local development server after browser verification. No production host changed. The Docker image is ARM64; AMD64 and sustained production capacity/IO guarantees require target-specific verification if selected.

## External gates and authority

No application OpenAI credential or approved paid test budget: genuine structured output/semantic embedding evaluation remains blocked. Actual Postiz/Slack/Matomo account capability tests, identified blog/CMS/mail/ads providers, off-host backup/key escrow, independent alert delivery, production domain/host mandate and code/brand publication rights need explicit configuration/authorization. Provider access inside Codex is not application credentials.

No production host mutation, deployment/migration, DNS/firewall change, real social/mail/ad message, training/backtest or purchase occurred. The local RC source was pushed to the private `EDS-Labs/eds-orbit` repository. Existing VPS inventory was read-only; current measurements, missing contract costs and partial history are separately documented. Missing internal verification is never classified as a provider/permission blocker.

## Handoff

Read `README.md`, `ACCEPTANCE_REPORT.md`, `RELEASE_READINESS.md` and `LIVE_ACTIVATION_CHECKLIST.md`. `docs/evidence/source-manifest.json` identifies the currently tested local source set; `docs/evidence/container-acceptance.json` identifies the previously tested Linux image. The 2026-09-22 acceptance refresh is a local uncommitted change set based on `main` at `28f363e`; it has not been pushed or deployed. Runtime credentials remain local and ignored. Synthetic local login material is kept only in ignored `.runtime/e2e-user.json`; runtime credentials are not embedded in source or public evidence.

# Approval UX v2 and mandate-based agent authorization

Date 2026-10-28. Base `main` at `aaed3d47`. Branch `claude/orbit-approval-ux-v2-7daf3e`. Decision record: [ADR 0019](../adr/0019-agent-mandates.md) (proposed).

Risk: **high**. This change touches authorization, the approval path for MCP clients and paid image generation. Environment: local only. Nothing is deployed, flipped or migrated. App profiles: `fullstack-saas` (primary), `ai-agent-app` and `web-frontend`. Workflow: `feature.md`. No new dependency and no migration: mandates are entities.

## 1. Gap analysis: ADR 0008/0015 against the code

| # | Documented (ADR) | Code at `aaed3d47` | Consequence |
|---|---|---|---|
| G1 | Six approval modes (0008 §2) | `ActionDefinition.approvalMode: "approval_required"` only | No delegated or automatic path exists, by design of the WP-M4 addendum ("strictest mode that exists") |
| G2 | Eleven risk classes (0008 §1) | `riskClass: "C1"\|"C2"\|"W2"\|"W0_internal"`. `approvedOperation` hard-codes `W2` for all 40+ assistant/MCP writes | `riskClass` is stored and listed but **read by nothing** that decides. An internal note, a preview and a public reply look the same to the inbox |
| G3 | Matrix: drafts `auto`, paid model calls `auto_within_policy`, image generation `approval_required` relaxable by project policy (0008 §3) | Every MCP/assistant write is an owner approval | Owners click through internal work |
| G4 | Spending authority = budget authority (0015) | Correct: `reserve` enforces the platform record and the organization budget | A budget is not an action permission. Nothing grants "agents may do X" |
| G5 | Delegated agents need individual approval (AGENTS.md, `docs/SUPPORT_MCP.md`) | `operation-tools.ts` checks `ctx.channel?.kind === "mcp"` for the Support standing rule. Delegated MCP 2.0 runs set exactly that channel (`chat-runner.ts:233-241`) | **Security gap:** an owner's delegated task could send a Support reply without approval when the inbox rule is on. Fixed in phase 1 |
| G6 | Rights decisions per asset (creative spec §8) | QA verdict (layout) and rights (`creative.status = needs_rights`) are separate in data, but the panel hides the pending `ASSET_RIGHTS` ("All checks passed") and the MCP result gives no explanation | Users read "QA pass" as "usable" |
| G7 | One approvals inbox (0008 consequences) | Exists per project. The generic fallback shows the raw action type, raw JSON args and no reason. The attention badge counts only owner types (`openOwnerRequests`), while the list also shows editor types | Hard to decide; editors get no badge |
| G8 | 0015 §6: the Marketing editor no longer edits budget fields | See §6 below (budget cleanup) | Legacy values can look authoritative |

Answers to the six questions of the brief:

1. **Why `approval_required` only?** ADR 0008 WP-M4 chose the strictest mode until a looser one is specified with its own guard. That is ADR 0019.
2. **Why `W2` everywhere?** `approvedOperation` predates per-operation classes. It took the strictest class so that no operation could be under-classified. The value has no effect today (G2).
3. **Which internal actions could run `auto_within_policy`?** The candidates are internal writes and internal paid work with a bounded ceiling: `marketing_creative_preview_create` (C2, pilot); internal drafts and notes (`support_add_note`, `support_prepare_reply`, `knowledge_propose_fact`, the `work_propose_*` and `issues_propose_*` operations, `marketing_create_campaign`) (W0); and bounded paid internal work (`support_generate_reply`, `knowledge_evaluate`, `platform.task.start` in read/draft mode) (C1). They are **not** mandatable: `support_send_reply` (external), `knowledge_import_url` (external fetch), `integrations_configure`, `marketing_schedule_content`, `content.schedule`, `work_pm_propose_coding_run` / `work.coding.dispatch` (external agent), spend policy, model and configuration changes (F2/G).
4. **Where must the decision be made?** In one platform function, called by `approvedOperation` after the request exists and before anything runs, inside the project transaction: `platform/governance/authorization.ts`. The execution then goes through the unchanged `decideActionRequest`.
5. **Owner vs. agent vs. MCP:**
   - A direct owner action in the web UI is a human decision.
   - An assistant proposal acts under the user but is model-driven (prompt injection from documents).
   - An MCP call adds a third-party client and an OAuth grant that can be revoked, narrowed or replaced.
   - A delegated work order adds an approved task that keeps running later.

   Each step adds a party that can be wrong or compromised. ADR 0019 therefore makes MCP a separate opt-in and keeps delegated orders out of mandates entirely.
6. **Can existing mandates be extended?** The spending authority is reused as the cost authority. The new agent mandate holds no budget. The Support inbox rule stays a module rule (unchanged, apart from fixing G5).

## 2. Design summary

See ADR 0019. Core pieces:

- `ActionDefinition`: full `riskClass` set; optional `mandate` descriptor (only for `W0`, `C1`, `C2`).
- `Operation`: optional `riskClass` (default `W2`) and `mandate`.
- Entity kind `agent_mandates`: one active record per action type. Owner only, web only (`ui_only`). Revoke supported.
- `resolveAuthorization()`: deterministic; returns the mode plus reason codes.
- `approvedOperation`: after a **new** request, apply the existing Support rule (unchanged, except that delegated runs are excluded) or `resolveAuthorization`. On `auto_within_policy`, call `decideActionRequest` with the channel `mandate`.
- Revocation is checked again right before payment (the `authorize` hook of `generateProjectImage`).
- `ORBIT_AGENT_MANDATES` (default `false`).

## 3. Phases, tasks and evidence

### Phase 1: authorization core
- P1.1 Risk classes and the `mandate` descriptor on `ActionDefinition`/`Operation`; registry test: only `W0`/`C1`/`C2` may be mandatable, never `mcpDirectEffect`.
- P1.2 `agent_mandates` service: grant, revoke, read, active lookup, audit, platform kind declaration.
- P1.3 `resolveAuthorization` with reason codes, daily count and grantor/requester checks.
- P1.4 `approvedOperation` integration plus the decision channel `mandate` in `decideActionRequest`, `authorization` on the request and the `action_request.auto_approved` audit event.
- P1.5 Fix G5 (delegated runs never use a standing approval) and add a regression test.
- P1.6 Owner routes: `GET/POST …/agent-mandates` and `…/agent-mandates/:id/revoke` (owner, web session only, not MCP).
- Tests: unit (decision table), integration (grant/revoke/expiry/count/requester coverage, the G5 regression).

### Phase 2: Creative pilot
- P2.1 `marketing_creative_preview_create`: `riskClass: "C2"`, a mandate descriptor (art modes, ceiling), the preview record keeps `authorization`.
- P2.2 Mandate check before payment (`AGENT_MANDATE_ENDED`).
- P2.3 Rights: optional mandate rights consent bound to the image model/ceiling; generated art stored approved with `rightsSource`; otherwise `needs_rights` as today. Result gains `rights.explanation`, `qa.scope = "technical"` (additive fields only).
- Tests A, B, E, F, G (MCP end to end with a real principal and grant through `authorizeMcpCall`, a synthetic provider, no publication).

### Phase 3: Approval UX
- P3.1 The API list item gains `presentation` (module, title key, reason, internal/external, `expiresAt`, cost) from the action definition. This is additive.
- P3.2 The inbox fallback uses titles, the reason, an internal/external badge, cost and relative expiry; technical details sit in a collapsed "Diagnostics" area; the module renderers stay.
- P3.3 Fix the attention badge to count `openDecidableRequests` (owners and editors see the same number as the list).
- P3.4 Organization-wide overview: `GET /api/workspaces/:id/action-requests/summary`, counting open decisions per project the member belongs to, each read in its own project transaction under RLS. Decisions stay on the project route.
- P3.5 Settings → Agent permissions (owner): grant, change, revoke.
- P3.6 Creative panel: rights pending is shown separately from QA.

### Phase 4: generalization and rollout
- P4.1 Classify every `approvedOperation` (W0/C1/W1/W2/F2/G) with a test, so no operation stays unclassified. Mark the reviewed internal W0 operations mandatable where the effect is purely internal (proposal-only list in §1.3). `platform.task.start` stays unmandatable in this change (delegated orders, see ADR 0019 §4).
- P4.2 Regression tests H: Support approvals, publishing approvals (`content.schedule`, `human_each`), PM decisions, OAuth grant checks, single use.
- P4.3 Docs: IMPLEMENTATION_STATUS, REQUIREMENTS_TRACEABILITY, API_CONTRACT, SUPPORT_MCP (G5), MCP_2_0, OPERATIONS (flag), a security review entry.
- P4.4 OpenAPI regeneration.

## 4. Test plan (brief §10)

| Case | Test |
|---|---|
| A internal creative with a mandate | `agent-mandates.integration.test.ts`: MCP and assistant proposals complete without a human decision; `decision.channel = mandate`; audit event; one paid image |
| B no mandate | the same file: pending, `requiresApproval: true`; the existing `creative-preview-mcp` stays green |
| C publishing | `content.schedule` is not mandatable (registry test); the existing publishing suites stay green |
| D budget | the mandate cost limit, the daily count, and parallel proposals under the project lock; `reserve` limits (day, month, run, org) stay authoritative: a mandate-approved preview over the daily budget ends `BUDGET_EXCEEDED` without a provider call |
| E revoke and expiry | revoked and expired mandates authorize nothing; a preview approved before revocation stops before payment (`AGENT_MANDATE_ENDED`) |
| F rights | without the consent, `needs_rights` with QA unchanged; with the consent, the art is approved with `rightsSource`; a changed image model voids the consent |
| G MCP end to end | a real `McpPrincipal`/grant through `authorizeMcpCall` and `tool.execute`; the result and image are readable; no publication |
| H regression | the existing suites: support-mcp, mcp-2-workflows, work-mcp, work-pm-mcp, content-packages, access matrix, RLS matrix, plus the G5 regression |

## 5. Rollback

`ORBIT_AGENT_MANDATES=false` makes every mandate inert, so all requests need an approval again. Risk classes and UI changes are display-only or stricter. The G5 fix only removes an unintended automatic path.

## 6. Budget cleanup (brief §6)

Findings and changes are recorded in IMPLEMENTATION_STATUS with the phase 4 docs. Guiding rules:
- a module budget never raises the platform limit;
- no limit changes;
- legacy Marketing budget fields are labelled as not authoritative where they are shown.

## 7. Open decisions for Mario

- D-1: Accept ADR 0019 (mandates; MCP as a separate opt-in; delegated orders excluded). **Decided 2026-10-30: accepted.**
- D-2: Turning on `ORBIT_AGENT_MANDATES` in production, and when. **Decided 2026-10-30: on.**
- D-3: Whether an owner may cover other members (editors) in a creative mandate. The current default is the grantor only; new art is owner-only anyway.
- D-4: Delivery to `main` (it deploys). **Done 2026-10-28 (`fa13f631`).**
- D-5: Whether the first set of internal types may be marked mandatable (pinned in the test): `support_add_note` and `support_prepare_reply` (Support content stays internal; replies never), `knowledge_propose_fact`, the Marketing campaign drafts and the four `work_propose_*` operations. Removing any of them is one line plus the pinned list.
- D-6: The G5 production check. Look for `mcp_setting` decisions on requests with `requestedBy.taskId` in production audit data (read only).

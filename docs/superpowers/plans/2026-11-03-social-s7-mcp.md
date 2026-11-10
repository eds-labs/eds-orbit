# Social S7: MCP and assistant tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Outside clients (ChatGPT, Claude) and Orbit Chat read social accounts, the calendar and posts, check a draft, and propose drafts, schedules, immediate publications and cancellations that the owner approves in Orbit; the approval of a schedule proposal is the schedule approval itself.

**Architecture:** `apps/api/src/modules/social/tools.ts` builds five reads with `readOperation` and five proposals with `approvedOperation` (`platform/tasks/operation-tools.ts`), feature `social`, content scope `orbit:social`, modelled on `modules/work/tools.ts`. Schedule and publish-now proposals carry the exact package (variants, time, package hash) as their `approvalContext`; on approval they apply it through a new posts service function without creating the native S4 request (precedent: `work_pm_propose_coding_run`).

**Tech Stack:** TypeScript, zod, Orbit tool registry and MCP gateway, vitest.

**Spec:** [2026-11-02-social-module.md](2026-11-02-social-module.md) §6.3, §6.5, §10 S7; [ADR 0020](../../adr/0020-social-module.md); S-D9. Stacked on `claude/social-p1`.

## Global Constraints

- No migration, no new dependency; schema hash stays `12cf3d02…`.
- Scope `orbit:social` in every place a content scope lives (scopes.ts + `MODULE_CONTENT_SCOPES`, MCP server resource scopes, MCP auth plugin scopes, visibility discovery set, web `EXPLICIT_SCOPES`, consent `SCOPE_TEXT` + i18n, docs).
- W2 proposals (`social_schedule`, `social_publish_now`) are never mandatable and always owner-decided; W0 proposals (`social_draft_create`, `social_draft_update`, `social_cancel`) carry a mandate with cost 0.
- Proposable only while `ORBIT_MCP_TASKS` is on (factory default); the pinned proposable set with the switch off stays `["assignment.confirm"]`.
- No tokens, no media bytes, no file ids of other modules in any output; arrays bounded (calendar ≤ 200 items, range ≤ 31 days).
- Docs and comments in English.

## Rulings taken while planning

- `social_request_approval` is not built: in S4 a request only exists together with a time (schedule) or "now"; `social_schedule` from a non-owner is that request.
- `social_cancel` is W0 (owner-decided, mandatable): Orbit has no native remote scheduling to cancel at a platform, so the W2 branch of the spec has nothing to act on.
- `mcpOwnerPublishWithoutApproval` stays without effect: the platform's direct-effect hook (`ownerMcpAutoApproval`) is shaped for support inboxes. Saving `true` is refused with `SOCIAL_SETTING_NOT_AVAILABLE` until a generic hook exists (like `editor_each`).
- While an MCP schedule request waits, the post stays a draft; any change to it changes the package hash and the approval fails as stale. The calendar shows the request only under Approvals.
- `Operation.summary` gets the stored `approvalContext` as a second argument (platform change, backward compatible), so the existing `social_post` approval renderer shows the exact package.

## Review Focus

1. An editor's MCP schedule proposal approved by the owner: exactly one schedule, no second (native) request, `approvedBy` = the deciding owner.
2. The post edited after the proposal (text, image, account, time zone change): approval refused as stale, nothing scheduled.
3. A viewer, a module switched off, a grant without `orbit:social`, a foreign project: tools invisible or refused.
4. The same idempotency key with other arguments: `IDEMPOTENCY_KEY_CONFLICT`; the same key and arguments: the same request.
5. Calendar range above 31 days or more than 200 items: refused or truncated with `truncated: true`.

---

### Task 1: Scope, feature and settings guard

**Files:** `platform/mcp/scopes.ts` (`SOCIAL_SCOPE = "orbit:social"`, `MODULE_CONTENT_SCOPES.social`), `platform/mcp/server.ts`, `platform/mcp-auth/plugins.ts`, `platform/mcp/visibility.ts`, `platform/agents/tools/registry.ts` (`ToolFeature` + `"social"`), web `platform/connect/oauth-flow.ts`, `platform/connect/connect-view.tsx`, `lib/i18n.ts`; `modules/social/settings.ts` (refuse `mcpOwnerPublishWithoutApproval: true`). Tests: `mcp-gateway.integration.test.ts` `scopes_supported` pin, web connect tests, `social-settings` test.

- [ ] Failing tests: `scopes_supported` contains `orbit:social`; consent screen lists the social scope with text; saving `mcpOwnerPublishWithoutApproval: true` → 409 `SOCIAL_SETTING_NOT_AVAILABLE`.
- [ ] Implement; run the touched tests — PASS. Commit `feat(social): orbit:social MCP scope and social tool feature`.

### Task 2: Read tools

**Files:** Create `modules/social/tools.ts`; modify `contributions.ts` (`tools`, `assistant: {features: () => ["social"], instructions}`). Test `apps/api/tests/social-mcp.integration.test.ts` (model: `work-mcp.integration.test.ts`).

**Produces:** `social_accounts` (id, platform, handle, displayName, status, capability, lastCheckCode, text limit), `social_calendar` `{from, to (≤ 31 days), accountIds?, platforms?, statuses?, origins?}` → ≤ 200 items + `truncated`, `social_post_get {postId}` (variants with text, media metadata, publications, approval state, version), `social_post_status {postIds ≤ 20}` (publication statuses, permalinks), `social_validate` (the draft input of `social_draft_create`) → per-account issues without saving or network.

- [ ] Failing tests: tool list by scope set (with/without `orbit:social`), viewer sees reads only, module off → none, each read's shape and bounds, a foreign project's post → NOT_FOUND, validate reports a too-long X text and an unknown account.
- [ ] Implement; PASS. Commit `feat(social): MCP and assistant read tools`.

### Task 3: Draft and cancel proposals (W0)

**Files:** `modules/social/tools.ts`, `posts/posts.ts` (`createPost`/`updatePost` accept the origin `mcp` or `assistant`). Test: `social-mcp.integration.test.ts`, `agent-mandates.integration.test.ts` (mandatable list + `social.mcp.social_draft_create`, `social_draft_update`, `social_cancel`).

- [ ] Failing tests: propose a draft → request pending, nothing created; owner approves → one draft with origin `mcp`, executionResult `{postId, version}`; re-decide is a no-op; same key other args → conflict; update with a stale version → refused at approval; cancel of a scheduled post → draft again.
- [ ] Implement; PASS. Commit `feat(social): draft and cancel proposals`.

### Task 4: Schedule and publish-now proposals (W2, the request is the approval)

**Files:** `platform/tasks/operation-tools.ts` (`summary(args, context)`), `posts/approval.ts` (`proposedPackage`, `applyApprovedSchedule`), `modules/social/tools.ts`. Tests: `social-mcp.integration.test.ts`, `mcp-proposals-contract.integration.test.ts` unchanged (switch off), `agent-mandates` "never" list gains both W2 types.

- [ ] Failing tests: editor proposes schedule → one MCP request whose summary is `kind: "social_post"` with variants and time; owner approves → post `scheduled`, `approvedBy` owner, delivery started, no `social.post.schedule` request exists; post text changed before approval → stale, still draft; time too soon at approval → refused; publish-now likewise with mode `now`; neither type is mandatable.
- [ ] Implement; PASS. Commit `feat(social): schedule and publish-now proposals approved in Orbit`.

### Task 5: Docs and verification

**Files:** `docs/SOCIAL.md` (tools), `docs/MCP_2_0.md`, `docs/deployment/MCP_ROLLOUT.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md` (R5), ADR 0020 note.

- [ ] Docs; root + web typecheck, source check, framework and compose checks, chat-runner limits, full vitest; schema hash unchanged. Commit `docs(social): S7 MCP and assistant tools`.

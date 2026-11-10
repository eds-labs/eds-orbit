# Social P3: follow-ups with user impact — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the deferred minors of S4–S10 that a person notices: the calendar after a move, a write verification confirmed only by read-back, wording that names Postiz where Social is meant, a draft update that drops the title, Facebook answers that are not Graph errors, and the analytics view for X without paid reads.

**Architecture:** Small changes in place; no new module, no migration, no dependency.

**Spec:** the S4–S10 plans' deferred-minor lists (ledgers, final reports) and [2026-11-02-social-module.md](2026-11-02-social-module.md). Stacked on `claude/social-s10`.

## Global Constraints

- No migration; schema hash `12cf3d02…` unchanged; no new dependency. Docs and comments in English.

## Rulings taken while planning

- `editor_each` (editors decide publications) is **not** in P3: deciders are fixed per action type in the platform's governance (`decideActionRequest`, the approvals inbox, MCP grant checks), and `social.approve` is owner-only. It needs a governance hook ("decider per request") reviewed on its own; it stays refused (`SOCIAL_SETTING_NOT_AVAILABLE`).
- Larger deferred items stay follow-ups: unique index on origin keys (migration), Instagram insights (new permission), `social:<accountId>` channels for projects without Postiz, analytics specialist on Social, inventory counts of assignments/policies.

## Review Focus

1. Moving a post in the list view refreshes the list; the month/week grid keeps scroll and focus while it reloads.
2. A write-verification post confirmed by read-back or by the owner's "It was published" makes the account write-verified (live only).
3. A Facebook `/feed` answer that is no Graph error (proxy HTML, 408, 3xx) is unknown, never "refused for good".
4. A draft update without `title` keeps the title.

---

### Task 1: Calendar after a move

**Files:** `apps/web/src/modules/social/calendar/calendar-view.tsx` (list keyed by a revision bumped after a move; grid shows the last data while the same range reloads), `calendar/grid.ts` or a small `keep.ts` helper; `apps/api/src/platform/administration/routes.ts` (only the calendar route is exempt from the administration gate); tests.

- [ ] Failing tests: `keptData` returns the previous data while the same path reloads and nothing for a new path; the list key changes with the revision; `isAdministrationRoute("/api/organizations/:workspaceId/social/other")` is true, the calendar route false.
- [ ] Implement; PASS. Commit.

### Task 2: Write verification confirmed later

**Files:** `social/dispatch/reconcile.ts` (read-back found the verification post), `social/dispatch/control.ts` (owner settles it as published); test `social-verify-readback.integration.test.ts`.

- [ ] Failing tests: an unclear verification post found by read-back marks the account `write_verified`; settled as published by the owner marks it; settled as not published does not; test mode never marks.
- [ ] Implement; PASS. Commit.

### Task 3: Wording and small correctness fixes

**Files:** `marketing/agents/notification-messages.ts` (Social drafts: "freigibst", unclear Social draft text, "als Entwurf an Social"), `social/tools.ts` (`social_draft_update` keeps the title when omitted), `social/adapters/facebook.ts` (non-Graph error on `/feed` → unknown; upload file name without the internal file id), `apps/web/src/modules/social/analytics.tsx` (X with paid reads off: "X figures are off"; "as of" time); tests in the existing suites.

- [ ] Failing tests per item; implement; PASS. Commit.

### Task 4: Docs and verification

- [ ] `docs/SOCIAL.md`, `docs/IMPLEMENTATION_STATUS.md`; typechecks, source check, framework/compose checks, full vitest. Commit.

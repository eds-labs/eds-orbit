# Social S10: Postiz migration tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything an owner needs to move one project from Postiz to Social safely: a read-only inventory, the mapping of Postiz channels to Social accounts, a read-only mirror of the Postiz history in Social, a draining mode that lets Postiz finish without starting anything new, a migration panel in Social → Accounts, and the runbook. The cutover itself (per project) and Postiz's shutdown stay operational steps with Mario's approval.

**Architecture:** `apps/api/src/modules/marketing/publishing/legacy-export.ts` (Marketing reads its own Postiz records for the inventory and the mirror and hands plain rows to Social through the contract); `apps/api/src/modules/social/legacy/` (`mapping.ts`, `mirror.ts`); `scripts/postiz-inventory.ts` (read-only, prints JSON without bodies or tokens); Marketing setting `publishingBackend` gains `postiz_draining`. Web: a "Move from Postiz" section on Social → Accounts.

**Tech Stack:** TypeScript, Prisma, React, vitest.

**Spec:** [2026-11-02-social-module.md](2026-11-02-social-module.md) §9, §10 S10; [ADR 0020](../../adr/0020-social-module.md); S9 rulings. Stacked on `claude/social-s9`.

## Global Constraints

- No migration (columns `legacyPostizIntegrationId`, `legacyEntityId`, origin `legacy_postiz` exist since S1); schema hash `12cf3d02…` unchanged; no new dependency.
- Source data is never changed: the mirror only adds Social rows (`origin: "legacy_postiz"`, `readOnly: true`), re-runs update them from the source (source wins), never the reverse.
- Mapping and mirror are owner actions; the inventory prints counts only (no bodies, no tokens, no ids of people).
- Draining (`postiz_draining`): new Postiz intents and drafts are refused (`PUBLISHING_BACKEND_DRAINING`), existing ones finish and reconcile exactly as under `postiz` (same package input, so nothing pending changes its hash).
- Docs and comments in English.

## Rulings taken while planning

- The mirror links by `SocialPublication.legacyEntityId` (and `SocialPost.originType/originId`); no `ObjectLink` rows (the column is the link; fewer moving parts).
- Rollback of the mirror is a reviewed maintenance step in the runbook (migration role deletes `origin = legacy_postiz` rows, publications before posts); no API deletes them.
- Only mapped channels are mirrored; unmapped ones are counted and listed.

## Review Focus

1. Mirror twice: no duplicate rows; a changed source status updates the mirror; a mirror row is read-only in every Social write path (edit, schedule, move, cancel).
2. Draining: a pending Postiz publication still dispatches and reconciles; a new intent or draft booking is refused; the hash of a pending post does not change when draining starts.
3. Mapping: one Postiz channel to one account of the same platform in the same project; a second account cannot take a mapped channel; unmapping refused while Marketing publishes through Social.
4. Inventory: counts per project and status, no bodies, no tokens; runs read-only.
5. A project on Social after the switch: the mirror's posts and the new posts appear together in the Social calendar.

---

### Task 1: Mapping

**Files:** `social/legacy/mapping.ts`, routes `GET/PUT /api/projects/:projectId/social/legacy/mapping`, contract `postizChannels` input from Marketing (`marketing/publishing/legacy-export.ts`: the stored Postiz connector's channels: id, name, identifier); test `social-legacy-mapping.integration.test.ts`.

- [ ] Failing tests: GET lists Postiz channels with a suggested account (same platform, handle match) and the current mapping; PUT (owner) sets/clears `legacyPostizIntegrationId` with version checks; platform mismatch refused; clearing refused while `publishingBackend` is `social`.
- [ ] Implement; PASS. Commit.

### Task 2: History mirror

**Files:** `marketing/publishing/legacy-export.ts` (`legacyPublications`: publications and accepted drafts with body, channel, remote id, release URL, status, dates), `social/legacy/mirror.ts` (`mirrorPostizHistory(tx, scope, rows, {dryRun})`), route `POST /api/projects/:projectId/social/legacy/mirror {dryRun}` (owner; Marketing → Social through the contract); test `social-legacy-mirror.integration.test.ts`.

- [ ] Failing tests: dry run counts per status and unmapped; apply creates read-only posts with one publication each (status mapped: published, failed, canceled, outcome_unknown, scheduled_remote → pending), `legacyEntityId`, permalink; second run creates nothing and updates a changed status; mirrored posts refuse edits (`SOCIAL_POST_READ_ONLY`) and show in the calendar.
- [ ] Implement; PASS. Commit.

### Task 3: Draining mode

**Files:** `marketing/publishing/backend.ts` (`postiz_draining`), `publishIntent`, `bookPostizDraft`, owner draft handoff; test in `marketing-social-backend.integration.test.ts`.

- [ ] Failing tests: draining keeps the package hash; a pending Postiz publication dispatches through Postiz; new intents and draft bookings fail `PUBLISHING_BACKEND_DRAINING`; switching to `social` from draining works.
- [ ] Implement; PASS; run the Marketing suites. Commit.

### Task 4: Inventory script

**Files:** `scripts/postiz-inventory.ts` (read-only; per project counts: publications and drafts by status, open exceptions `POSTIZ_*`, assignments and policies naming integration ids, channel count, mapping state, `publishingBackend`); test `scripts` unit test with a synthetic project.

- [ ] Failing test: JSON shape, no `body`/`text`/token fields, read-only (no writes).
- [ ] Implement; PASS. Commit.

### Task 5: Migration panel, runbook, docs

**Files:** `apps/web/src/modules/social/legacy.tsx` (Accounts page section: Postiz channels with account selects, mirror dry run and apply, Marketing backend state with the owner's switch postiz → draining → social and back), web tests; `docs/SOCIAL_POSTIZ_MIGRATION.md` (runbook §9.6/§9.7 with evidence template, rollback), `docs/SOCIAL.md`, `docs/IMPLEMENTATION_STATUS.md`, traceability R7, OpenAPI.

- [ ] Failing web tests; implement; docs; typechecks, source check, framework/compose checks, full vitest. Commit.

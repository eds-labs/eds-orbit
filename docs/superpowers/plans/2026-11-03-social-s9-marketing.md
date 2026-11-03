# Social S9: Marketing publishes through Social — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project whose owner switches Marketing's publishing backend to `social` sends its approved posts and its assignment drafts through the Social module instead of Postiz; every project that keeps the default `postiz` behaves exactly as before.

**Architecture:** Social offers a contract (`apps/api/src/modules/social/contract.ts`, the only file Marketing may import from Social). Marketing keeps its whole pipeline (missions, reviews, approvals, package hash, veto window, Telegram Stop, preflight, dispatch at the slot) and switches only at the two send seams: `dispatchPublication` (a live post at its slot) hands the post to Social as an origin-authorized post that Social sends at once, and the draft send of assignment deliveries creates a Social draft. Marketing's reconciliation reads the Social post's status through the contract. Channels stay Marketing's Postiz integration ids; Social resolves them through `SocialAccount.legacyPostizIntegrationId` (mapping UI in S10).

**Tech Stack:** TypeScript, Prisma, Orbit module contracts and boundaries, vitest.

**Spec:** [2026-11-02-social-module.md](2026-11-02-social-module.md) §6.4, §9.5, §10 S9; [ADR 0020](../../adr/0020-social-module.md). Map of today's Postiz paths: see the S9 notes in the session (publisher.ts `dispatchPublication`/`reconcilePublication`, policy.ts `packageFor`/`preflight`, postiz-draft.ts `draftSend`/`sendDraftHandoff`, draft-delivery.ts `deliverPostizDraft`). Stacked on `claude/social-s8`.

## Global Constraints

- Default backend `postiz`; for it the package hash input, the dispatch and every existing test stay byte-identical.
- No migration, no new dependency; schema hash `12cf3d02…` unchanged.
- Marketing imports only `modules/social/contract.ts` (new boundary zone `module:social-contract`).
- Switching the backend is the owner's (`PROJECT_OWN`), needs `ORBIT_SOCIAL` and the social module enabled for the project, and is audited. Pending publications computed under the other backend fail their package check (`PACKAGE_CHANGED`) instead of going out by the new path.
- Social's own gates still apply when it sends (live mode, platform switched on, account write-verified).
- Docs and comments in English.

## Rulings taken while planning (deviations from spec §9.5)

- **Handoff at the slot, not at intent.** The spec submits Marketing posts to Social when they are scheduled and re-runs a Marketing origin guard in Social's claim. Marketing already dispatches at the slot and re-runs its full preflight (veto, pause, assignment authority, image rights, package hash) in the same job immediately before the handoff; handing over then, as a post Social sends at once, keeps the MA-00/01 guard matrix unchanged by construction and needs no origin guard and no `sstop:` buttons (veto and Stop stay Marketing's, before the handoff). Cost: Marketing posts appear in the Social calendar only from their slot on.
- **Delivery values unchanged.** `publish` and `postiz_draft` keep their names and the assignment hash; under the `social` backend `publish` goes through Social and `postiz_draft` becomes a Social draft. No new enum values (`social`, `social_draft`), no re-confirmation of assignments.
- **Channels stay Postiz integration ids**, mapped to Social accounts by `legacyPostizIntegrationId`; `social:<accountId>` channel references for projects without Postiz are a follow-up. Marketing still reads channel metadata (posting times, rules) from its stored Postiz connector entity; no live Postiz call is on a social project's send path.
- **Not in S9:** the analytics specialist tool (`postiz_analytics`) and the channel history sync stay on Postiz; the duplicate check additionally reads Social's published texts.

## Review Focus

1. A Postiz project: package hash, dispatch, reconciliation and drafts exactly as before (pinned hash input).
2. Backend switched while posts are pending: they block with `PACKAGE_CHANGED`, none is sent twice or by the wrong backend.
3. A social handoff whose Social submission fails (unmapped channel, account not verified, text too long): the Marketing publication fails with a code, nothing is half-recorded (submission and record in one transaction).
4. The same publication dispatched twice (job redelivery): one Social post (dedupe by origin).
5. Social reports failed or unknown: Marketing's publication becomes failed / outcome_unknown with the exception and the owner's notice as for Postiz.

---

### Task 1: Social contract

**Files:** Create `apps/api/src/modules/social/contract.ts`; modify `scripts/boundaries.json` (zone `module:social-contract`, `module:marketing` → it, it → `module:social`); test `apps/api/tests/social-contract.integration.test.ts`.

**Produces:**
- `socialPublishingAvailable(tx, scope): Promise<boolean>`
- `accountForChannel(tx, scope, channel): Promise<{ accountId, platform, handle, version, capability, status } | null>` (`social:<id>` or `legacyPostizIntegrationId`)
- `publishingBlockers(tx, scope, channel, { text, image }): Promise<string[]>` (`SOCIAL_DISABLED`, `SOCIAL_CHANNEL_NOT_MAPPED`, `SOCIAL_ACCOUNT_NOT_ACTIVE`, `SOCIAL_ACCOUNT_WRITE_UNVERIFIED`, `SOCIAL_PLATFORM_NOT_AVAILABLE`, text issues)
- `importOriginMedia(scope, { bytes, mime }): Promise<string>` (library asset id; outside a transaction)
- `submitOriginPost(tx, scope, { origin: {module, type, id, version}, accountId, text, mediaIds, mode: "now" | "draft", at?, packageHash? }): Promise<{ postId, deduplicated }>` — `now` creates the post approved (origin-authorized, audited) and starts delivery; `draft` creates a timed draft for a human; dedupe by origin.
- `originPostStatus(tx, scope, postIds): Promise<Array<{ postId, status, permalink, publishedAt, errorCode }>>`
- `recentPublishedTexts(tx, scope, accountIds, days): Promise<string[]>`; re-export `postMetrics`.

- [ ] Failing tests per function (mapping both ways, blockers, dedupe, approved-now post with a delivery job, timed draft, status mapping, foreign project invisible), boundary check passes.
- [ ] Implement; PASS. Commit `feat(social): contract for Marketing`.

### Task 2: Marketing publishing backend setting

**Files:** Create `apps/api/src/modules/marketing/publishing/backend.ts` (`marketingSettingsSchema`, `publishingBackend(tx, scope)`, `saveMarketingSettings`); routes `GET/PUT /api/projects/:projectId/marketing/settings`; access matrix; test `apps/api/tests/marketing-publishing-backend.integration.test.ts`.

- [ ] Failing tests: default `postiz`; owner switches to `social` only with the social module on (else 409 `SOCIAL_DISABLED`); editor 403; version conflict 409; audit.
- [ ] Implement; PASS. Commit `feat(marketing): publishing backend setting`.

### Task 3: Live posts through Social

**Files:** `marketing/policy/policy.ts` (`packageFor`, `preflight`), `marketing/publishing/publisher.ts` (`dispatchPublication`, `reconcilePublication`), duplicate check; test `apps/api/tests/marketing-social-backend.integration.test.ts`.

- [ ] Failing tests: Postiz package input pinned (keys and hash for a fixed fixture unchanged); social backend: package binds `publishingBackend`, account id and version; preflight blockers from the contract instead of Postiz write checks; dispatch at the slot creates one Social post (origin marketing, approved, delivery started) and records `scheduled_remote` with the Social post id in one transaction; a second dispatch deduplicates; a failed submission fails the publication; reconciliation maps Social published/failed/unknown; switching the backend blocks a pending publication with `PACKAGE_CHANGED`; the duplicate check sees a text published through Social.
- [ ] Implement; PASS; run the existing Marketing suites listed in the S9 notes. Commit `feat(marketing): live posts through Social`.

### Task 4: Assignment drafts through Social

**Files:** `marketing/publishing/postiz-draft.ts` (`draftSend` returns a social send under the social backend; `sendSocialDraft`), `marketing/agents/draft-delivery.ts` (unchanged call site); test in `marketing-social-backend.integration.test.ts`.

- [ ] Failing tests: an assignment draft delivery under the social backend creates a timed Social draft (origin marketing) with its image and records the handoff `accepted`; human-each approval still binds the image; a Postiz project still calls Postiz.
- [ ] Implement; PASS; run `assignment-postiz-drafts` and `assignment-owner-release` suites. Commit `feat(marketing): assignment drafts through Social`.

### Task 5: Docs and verification

**Files:** `docs/SOCIAL.md` (contract, Marketing on Social), `docs/MARKETING*.md` where publishing is described, `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md` (R7 partial), ADR note; OpenAPI.

- [ ] Docs; typechecks, source check (boundaries), framework/compose checks, full vitest; schema hash unchanged. Commit `docs(social): S9 Marketing through Social`.

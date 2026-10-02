# Orbit Core J3 — Scheduling content packages

**Status:** ACCEPTED by Mario on 2026-10-02 with the decisions in section 3. All slices DONE locally on 2026-10-02 (stacked PRs #42–#47); not merged or released. Part of the [Orbit Core plan](ORBIT_CORE_JARVIS_PLAN.md) (stage J3, acceptance rows JC15 and JC16). No production change, merge, flag activation or live post is implied.

## 1. Goal

A reviewed package draft can be proposed for a concrete slot in the chat. An owner decides that exact post (text, image, channel, time). The existing publisher then publishes it at that time with all live checks immediately before the handoff. The weekly autopilot keeps working and nothing is replaced silently.

Risk: critical once activated in production, where `EXECUTION_MODE=live` and external writes are on, so an approved schedule is a real public post. Work stays local and behind `ORBIT_CONTENT_PACKAGES`.

## 2. Findings (base `344403b`)

1. Package missions carry `allowedActions: ["draft"]`; preflight already blocks test and live publishing (`MISSION_TEST_WRITE_NOT_AUTHORIZED`, `MISSION_LIVE_WRITE_NOT_AUTHORIZED`).
2. `publishIntent` checks the daily channel quota and spacing against existing publications only, not against planned autopilot slots.
3. `planAutopilot` plans one mission per channel and day against its own slots only. A package post scheduled for that day would lead to an unnecessary paid autopilot draft that later fails with `CHANNEL_DAILY_QUOTA`.
4. Assisted mode publishing needs an owner approval of the package hash (24 hours, the older approval flavour).
5. Publishing is local at the scheduled time (`now` handoff to Postiz) with preflight just before; manual calendar blocks and quiet hours are checked.
6. A package image is a `reference` asset without usage approval; preflight blocks content with an unapproved asset.

## 3. Decisions (Mario, 2026-10-02)

- **D-J3-1:** Every conversational schedule is decided by an owner, per exact post, through the approvals inbox (ADR 0008 default `approval_required` for public writes). A policy relaxation for autopilot mode is a separate later decision.
- **D-J3-2:** A slot that collides with an autopilot slot is refused with the next free slot suggested. Explicit replacement of an autopilot slot is not part of J3.
- **D-J3-3:** A package image is attached to a post only after the owner approved its usage rights; the text is reviewed again afterwards.

## 4. Slices

| Slice | Content | Tests |
| --- | --- | --- |
| J3.0 Slot overview (read-only) | `channelSlots()` in `apps/api/src/modules/agents/scheduling.ts`: free and occupied slots per channel for up to 14 days with reasons (active publications, planned autopilot slots, daily quota, spacing, quiet hours, calendar blocks, policy window, approved channels, minimum lead), in the project timezone, plus the next free slot. Operator read tool `schedule_options`. | Autopilot and publication occupancy, next free slot, DST change, quiet hours, calendar block, policy end, unapproved channel |
| J3.1 Scheduling by decision | Action type `content.schedule` (W2, owner, bound to content and asset versions, channel, time, policy and package hash), tool `propose_schedule`. The executor rechecks the slot, extends the mission's publish action for exactly this post (audited), records the assisted-mode approval and calls `publishIntent`. The card shows the schedule state. | JC16; stale content; test mode ends as `published_test` through the real worker; repeated click once |
| J3.2 Autopilot coexistence | `planAutopilot` skips channel-days with an approved package schedule or active publication (no paid draft, reason recorded); package scheduling checks planned autopilot slots. | JC15; the current weekly plan pattern unchanged |
| J3.3 Package image in a post | Owner approves the generated image's usage rights from the inbox and attaches it to chosen drafts; drafts are reviewed again; Telegram uses the caption limit. | No attach without rights; caption length; old approvals invalidated |
| J3.4 Cancel and reschedule | Cancel or move a locally scheduled package post before handoff (moving needs a new decision); posts already handed to Postiz are reported as not retractable. | Cancel before handoff; honest report after handoff; no resend |
| J3.5 Acceptance | `evals/operator/cases-v2.json` (proposal, collision, viewer), JC15 and JC16 rows, docs. | All gates |

Everything stays behind `ORBIT_CONTENT_PACKAGES` except the J3.2 autopilot change, which only acts when package schedules exist. No migration.

## 5. Risks, rollback and production boundaries

- Public writes: the owner decides each exact post; live checks in preflight are unchanged and run immediately before handoff; the agent can never approve.
- Autopilot: J3.2 touches the running uLiquid weekly plan; it may only skip days, never delete missions, with a regression test for one post per channel and day.
- Rollback: flag off stops new proposals; approved schedules are ordinary publications. Correction (J3.4): Orbit had no cancel path for a single publication; J3.4 adds one that also works with the flag off. Reconciliation of handed-over posts uses the existing `reconcile` action.
- Production: merges, the flag and the first real package post each need Mario's approval; the first live post should be a deliberate test post on a verified channel.

## 6. Progress log

| ID | Work item | Status | Evidence |
| --- | --- | --- | --- |
| J3.0 | Slot overview | DONE (local) | `be24721`, see below |
| J3.1 | Scheduling by decision | DONE (local) | `30bd2c7`, see below |
| J3.2 | Autopilot coexistence | DONE (local) | `d9430c7`, see below |
| J3.3 | Package image in a post | DONE (local) | `d620d35`, see below |
| J3.4 | Cancel and reschedule | DONE (local) | `5479565`, see below |
| J3.5 | Acceptance | DONE (local) | `8f08622`, see below |

### 2026-10-02 — J3.0 slot overview (local)

- Base `344403b` (content history branch), code head `be24721` on branch `claude/orbit-core-j3-slots`. Risk: low (read-only). Environment: local; tool behind `ORBIT_CONTENT_PACKAGES`.
- `channelSlots()` in `apps/api/src/modules/agents/scheduling.ts` and the read tool `schedule_options`: per channel and local day the posting-time slot (channel posting time or 09:00), free or taken, with reasons `TOO_SOON`, `CHANNEL_NOT_APPROVED`, `OUTSIDE_POLICY`, `DAILY_QUOTA`, `SPACING`, `QUIET_HOURS`, `CALENDAR_BLOCK`, the occupying publications and planned autopilot slots, and the next free slot.
- Tests: six cases in `scheduling-slots.integration.test.ts` on a fixed clock around the end of daylight saving time (failed before the module existed): DST slot times, autopilot occupancy with next free slot, active versus canceled publication with spacing, quiet hours and calendar block, policy end and unapproved channel, viewer access and the 14-day bound.
- Tool definitions grew past the 7,000-byte guard (7,581 bytes); package tool descriptions were shortened instead of raising the guard, because definitions, instructions, history and tool output share the 32,000-byte input cap.
- Checks on Node 24.18.0: `pnpm test` 652/652 in 65 files; `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm secrets:check`, `pnpm framework:check` and `pnpm api:generate` (no contract change) pass.

### 2026-10-02 — J3.1 scheduling by owner decision (local)

- Base `d36b422` (J3.0 branch), code head `30bd2c7` on branch `claude/orbit-core-j3-schedule`. Risk: critical once activated in production (an approved schedule becomes a real public post with `EXECUTION_MODE=live`); local work only, behind `ORBIT_CONTENT_PACKAGES`, no migration. App profile: fullstack SaaS (primary), AI agent app for the tool.
- `proposeSchedule()` in `apps/api/src/modules/agents/package-schedule.ts` and the proposal tool `propose_schedule` (`P_proposal`, editors and owners): the next free slot from `channelSlots()` or a named day; a taken day returns `slot_taken` with its reasons and `nextFree` and creates nothing. A proposal stores the slot on the draft and creates one `content.schedule` request (`W2`, owner, 24 hours) bound to content id and version, text, asset, channel, slot, execution mode and the publishing package hash. One open proposal or active publication per post (`SCHEDULE_ALREADY_PROPOSED`, `ALREADY_SCHEDULED`).
- Owner decision in the existing approvals inbox, which now shows the exact text, channel, slot and mode. Approval rechecks the post (`SCHEDULE_STALE`) and the slot (`SCHEDULE_SLOT_TAKEN`), then in one transaction: adds `publish_test` or `publish_live` (by execution mode) to the package mission and extends its window to the slot plus two hours within the policy end (audited `mission.publish_authorized`); records the owner's human review of the shown text; in assisted mode records the package approval until the slot (`approve()` takes an optional expiry, default unchanged at 24 hours); calls `publishIntent`; consumes the request. Any blocker, for example missing live capability, rolls the decision back and the draft stays a draft.
- The package card shows the schedule state from the request and then from the publication (`awaiting_approval`, `stale`, `scheduled`, `published_test`, `blocked_dependency` …).
- Tests (written first, failed before the module existed): nine cases in `package-schedule.integration.test.ts` — proposal with inbox summary, owner approval with one publication and a repeated click, `published_test` through `dispatchPublication`, JC16 (no publish without decision, editor cannot decide), rollback when live publishing is blocked, autopilot-taken day with `nextFree`, slot taken after the proposal, stale draft, assisted-mode approval, one open proposal and no viewer proposals; plus `package-schedule-publish.integration.test.ts`, where a real worker process with Redis drafts the package, publishes nothing before the decision and ends the post as `published_test` at its slot. Mutation checks: removing the mission authorization, the slot recheck at decision or proposal, or the assisted approval each fails a test. Registry tests cover the new tool's role and risk. Two Playwright cases (inbox decision, card state) are added; they run in CI, not locally.
- The JC06 worker test now uses the shared `apps/worker/tests/support/worker-process.ts`.
- Tool definitions were 7,489 bytes with the new tool; package tool descriptions were shortened to about 6,990 bytes. Headroom under the 7,000-byte guard is now small: the next operator tool needs tool search (`deferLoading`) or a separate decision on the guard.
- Checks on Node 24.18.0: `pnpm test` 662/662 in 67 files; `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm secrets:check`, `pnpm framework:check` and `pnpm api:generate` (no generated contract change) pass.

### 2026-10-02 — J3.2 autopilot coexistence (local)

- Base `ef66630` (J3.1 branch), code head `d9430c7` on branch `claude/orbit-core-j3-autopilot`. Risk: high, because it changes the weekly autopilot that runs for uLiquid; it only skips days and never deletes or changes missions. Environment: local; not behind the package flag, because it acts on any scheduled publication.
- `planAutopilot` skips a channel and day when its active publications (not canceled, failed or blocked) already use the policy's daily quota or one sits within the policy spacing of the autopilot slot. These are the same rules `publishIntent` applies, so no paid draft is made that would later fail with `CHANNEL_DAILY_QUOTA` or `CHANNEL_SPACING`. Each skip is audited once (`autopilot.slot_skipped` with the publication ids) and kept in the autopilot settings (`skippedSlots`); a canceled publication frees the day, and the next check plans it. Package scheduling already refuses planned autopilot days (J3.0, J3.1).
- Behaviour change beyond packages: a manual or other scheduled post on an unplanned day now also stops the autopilot draft for that day, which previously would have been drafted and then blocked by the quota.
- Tests (failed before the change): three cases in `autopilot-coexistence.integration.test.ts` — an owner-approved package post keeps its day free of autopilot drafts, the skip is audited once and the other days keep one post per channel and day; the canceled post frees the day; with two posts a day allowed, the spacing still skips the slot. The existing weekly plan tests in `paid.integration.test.ts` pass unchanged. Mutation checks: removing the skip, auditing on every check, or counting canceled publications each fails a test.
- Checks on Node 24.18.0: `pnpm test` 665/665 in 68 files; `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm secrets:check`, `pnpm framework:check` and `pnpm api:generate` (no contract change) pass.

### 2026-10-02 — J3.3 package image in a post (local)

- Base `b7a1a32` (J3.2 branch), code head `d620d35` on branch `claude/orbit-core-j3-image`. Risk: medium (draft content and asset rights; no publishing path changes). Environment: local, behind `ORBIT_CONTENT_PACKAGES`, no migration.
- Rights (D-J3-3): the package snapshot reports `image.rightsApproved` and `assetVersion`; owners confirm usage rights from the package card through the existing owner action `asset-status` (`confirmUsageRights: true`), the same decision as on the assets page. No new approval type.
- `attachPackageImage()` in `apps/api/src/modules/agents/package-image.ts` and `POST /api/projects/:projectId/chat/packages/:id/attach-image` (`{deliverableKeys}`, the package's requester only): refuses without approved rights (`ASSET_RIGHTS_REQUIRED`), a Telegram or other text above the channel's media limit (`CAPTION_TOO_LONG`, Telegram 1,024 characters as a caption), a post with an active publication (`ALREADY_SCHEDULED`), a superseded draft or a running revision. It sets the asset, blocks approvals and publications of the previous version (`invalidateContent`), and reviews the draft again with the existing claim checks. All chosen drafts change together or none. Attaching the same image again changes nothing.
- An open `content.schedule` proposal for the draft becomes stale through its post hash; the owner proposes again. The approvals inbox shows the image of a post to schedule; preflight keeps checking asset rights before every handoff, and live posts still need the channel's media verification.
- Tests (written first, failed before the module existed): six cases in `package-image.integration.test.ts` — no attach before rights, attach with a fresh review and no change on repeat, Telegram caption limit with all-or-nothing, stale proposal and blocked approval, scheduling a post with its image and refusing changes once scheduled, requester and viewer limits; plus an HTTP route case in `chat.integration.test.ts` (failed with 404 before the route) and a Playwright case for rights and attach on the card. Mutation checks: removing the rights check, the caption check, the invalidation, the scheduled check or the new review each fails a test.
- Checks on Node 24.18.0: `pnpm test` 672/672 in 69 files; `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm secrets:check`, `pnpm framework:check` pass; `pnpm api:generate` added the new route to `openapi.json` and the generated client.

### 2026-10-02 — J3.4 cancel and reschedule (local)

- Base `10ead04` (J3.3 branch), code head `5479565` on branch `claude/orbit-core-j3-cancel`. Risk: high (stopping and moving scheduled public posts). Environment: local, no migration.
- Finding: Orbit had no way to cancel a single publication (the J3.1 note on "existing cancel paths" was wrong; corrected above and in `OPERATIONS.md`).
- `cancelPackageSchedule()` and `POST /api/projects/:projectId/chat/packages/:id/unschedule` (`{deliverableKey}`, the requester or an owner, deliberately not gated by `ORBIT_CONTENT_PACKAGES`): withdraws open proposals, takes a publication back before the handoff (status `canceled`, reason, user and time; its queued publishing job canceled; audit `publication.withdrawn`) and removes the mission's publish right (`mission.publish_revoked`). Results: `canceled`, `withdrawn`, `handoff_in_progress` (status `sending`), `not_retractable` (`published`, `published_test`, `outcome_unknown`), `nothing_scheduled`. A handed-over post is never retracted or sent again; the existing claim skips canceled publications.
- Moving: `propose_schedule` on a scheduled post that is not handed over creates a new `content.schedule` request with `replacesPublicationId`; the card shows it as `move` next to the current slot. The post keeps its slot until the owner approves; approval cancels the old publication (`RESCHEDULED`) and schedules the new slot in the same transaction; a rejected move changes nothing. A handed-over post cannot be moved (`PUBLICATION_NOT_RETRACTABLE`).
- Design change to J3.1: a proposal no longer writes the slot to the draft. The slot is bound by the request hash and set on the draft only on approval, so a rejected or withdrawn proposal leaves the draft unchanged and a move cannot break the current schedule. The J3.1 test now checks this.
- Tests (written first; they failed because the function did not exist): six cases in `package-reschedule.integration.test.ts` — cancel before the handoff with no later send, honest report after the handoff and no move, handoff in progress untouched, open proposal withdrawn, move only with a new owner decision (reject keeps the slot, approval replaces it once), requester or owner with the flag off and no viewers; plus a route case in `chat.integration.test.ts` (failed with 404 before the route) and a Playwright case (move shown, cancel, not-retractable message). Mutation checks: cancelling during `sending`, cancelling handed-over posts, keeping the old publication on a move, moving after the handoff, keeping the publish right and leaving the job queued each fail a test.
- Tool definitions: 6,990 bytes after the `propose_schedule` description mentions moving.
- Checks on Node 24.18.0: `pnpm test` 679/679 in 70 files; `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm secrets:check`, `pnpm framework:check` pass; `pnpm api:generate` added the route.

### 2026-10-02 — J3.5 acceptance (local)

- Base `5479565` docs head (J3.4 branch), code head `8f08622` on branch `claude/orbit-core-j3-acceptance`. Risk: low (tests and eval harness only). Environment: local.
- `evals/operator/cases-v2.json` (sha256 `cea007abbde595650038b76da79f385c63b664cd4a7ce3eb70b5736630c6e6f3`) replays three operator runs through the real chat runner, tools and services: JC16 an owner's proposal waits for the decision and creates no publication; JC15 a day the autopilot covers is refused with `DAILY_QUOTA` and the next free slot, nothing proposed; JC13 a viewer is offered `schedule_options` but not `propose_schedule`, and a forged call is refused. The harness gained an optional case fixture (a started package in the case's conversation, an autopilot day), named date placeholders, and checks for created schedule requests and tool output. Each case now runs in a fresh project. `cases-v1.json` is unchanged (sha256 `09093f58ac7a33395e61ecbf159f42a7958f8d5a4e2132be031eb83db4c57361`) and still passes. Mutation checks: proposing a taken day, or offering scheduling to viewers, each fails a case.
- Finding: with two identical drafts, generation reuses the earlier draft, and that draft belongs to another package; scheduling it is refused (`SCHEDULE_DRAFT_NOT_IN_PACKAGE`, now `DRAFT_REUSED`, see below).
- Acceptance rows: JC15 and JC16 PASS_TEST (17 PASS_TEST, 3 NOT_RUN overall). No live run: the first real package post needs Mario's approval of the merges, `ORBIT_CONTENT_PACKAGES` in production and a deliberate test post on a verified channel (with media verification if it carries the image).
- Checks on Node 24.18.0: `pnpm test` 682/682 in 70 files; `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm secrets:check`, `pnpm framework:check` and `pnpm api:generate` (no contract change) pass.

## 7. Open after J3

- Production: merges #31–#47 (without #37), `ORBIT_CONTENT_PACKAGES` in production, the first deliberate live package post, and the paid live operator acceptance run; each needs Mario's approval.
- Tool definitions are at about 6,990 of 7,000 bytes; the next operator tool needs tool search (`deferLoading`) or a decision on the guard.
- Done (`d32519a`): a draft reused from another package is refused with `DRAFT_REUSED` for scheduling and image attach, and revising it no longer supersedes the other package's draft.
- Moving checks the new day like a fresh slot; the old publication still counts for its own day until the move is approved, which is correct for different days but cannot move a post within the same day.

### 2026-10-02 — Reused drafts from another package (local)

- Base `702145e` (J3.5 branch), code head `d32519a` on branch `claude/orbit-core-draft-reused`. Risk: medium (fixes cross-package side effects). Environment: local, no migration.
- Generation reuses an identical earlier draft (same text and channel in the project) instead of writing a duplicate; the reused draft belongs to another package. Findings while giving the scheduling refusal a clearer code: image attach had no check and would have changed the other package's draft and blocked its approvals; a revision of a reused draft marked the other package's draft as superseded, which blocked that package's approvals and scheduled publication.
- Fix: `assertPackageDraft()` refuses with `DRAFT_REUSED` in `proposeSchedule` (was `SCHEDULE_DRAFT_NOT_IN_PACKAGE`) and `attachPackageImage`; `advanceContentPackages` supersedes only a package's own draft. Revising a reused draft still works and gives the package its own draft. The card explains a reused draft ("revise it first") and offers no image attach for it.
- Tests (failed before the fix: wrong code, `ALREADY_SCHEDULED` instead of a refusal, other package's draft superseded): five cases in `package-reused-draft.integration.test.ts`, including superseding an own draft with its publication blocked. The content-packages revision test relied on the old behaviour, because its X draft is reused in the shared test project; it now checks that the other package's draft and approval stay untouched. Playwright: the image case covers a reused draft. Mutation checks: removing either refusal, or superseding foreign drafts, fails a test.
- Checks on Node 24.18.0: `pnpm test` 687/687 in 71 files; `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm secrets:check`, `pnpm framework:check` and `pnpm api:generate` (no contract change) pass.

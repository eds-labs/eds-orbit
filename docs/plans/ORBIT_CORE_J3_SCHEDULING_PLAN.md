# Orbit Core J3 — Scheduling content packages

**Status:** ACCEPTED by Mario on 2026-10-02 with the decisions in section 3. Part of the [Orbit Core plan](ORBIT_CORE_JARVIS_PLAN.md) (stage J3, acceptance rows JC15 and JC16). No production change, merge, flag activation or live post is implied.

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
- Rollback: flag off stops new proposals; approved schedules are ordinary publications with the existing cancel and reconciliation paths.
- Production: merges, the flag and the first real package post each need Mario's approval; the first live post should be a deliberate test post on a verified channel.

## 6. Progress log

| ID | Work item | Status | Evidence |
| --- | --- | --- | --- |
| J3.0 | Slot overview | DONE (local) | `be24721`, see below |
| J3.1 | Scheduling by decision | DONE (local) | `30bd2c7`, see below |
| J3.2 | Autopilot coexistence | TODO | |
| J3.3 | Package image in a post | TODO | |
| J3.4 | Cancel and reschedule | TODO | |
| J3.5 | Acceptance | TODO | |

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

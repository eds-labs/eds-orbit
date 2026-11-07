# Daily social automation on assignments (FamilyPlan first)

Date: 2026-11-07. Status: design approved in chat by Mario (decisions D-1 to D-3 below); spec awaiting review.

## Goal

Orbit prepares one German Facebook and Instagram post with an AI image for FamilyPlan every day without a per-post prompt. The owner approves it in the existing Marketing approval flow, the native Social module publishes it at 18:30 Europe/Berlin, and each platform's outcome and permalink stay traceable. The external ChatGPT automation is replaced. The same mechanism serves other projects (uLiquid Desk).

## Decision: extend assignments, build no parallel automation

The existing Orbit Agents assignment already does almost everything. FamilyPlan's production assignment "FamilyPlan Testwoche" (`6766a12d`) is the automation that already produces a draft every day. The agent platform's generic schedule triggers (`ORBIT_AGENT_AUTOMATION`) and Social's native scheduling are **not** used for this: they would duplicate topic planning, approvals, budgets and the slot rules.

| Requirement | Existing component | Configuration or code |
|---|---|---|
| Start 08:00, slot 18:30, DST | `assignmentSchedule` `daily`, `times:["18:30"]`, `leadMinutes:630`; `dueDays` and `zonedTime` with two-pass offset correction; worker due-marker sweep, durable outbox jobs | Configuration |
| Profile, strategy, facts, topics | analytics → research → strategy → copywriter → review; topics come from the assignment's `topicFrame`, the marketing profile, the plan and Verified Facts | Configuration (topic list goes into `topicFrame` and the profile, never into code) |
| German text, CTA, hashtags | `profile.contentLanguage`, assignment `format` (chars, hashtags, CTA, paragraphs) | Configuration |
| 4:5 image, brand style, varies per day | Creative Studio v2: `creative: {artPer: "run"}`, `feed_portrait` 1080×1350 is the default format for `facebook` and `instagram`; art prompt from the strategy's per-post motif, setting and mood plus the brand kit; deterministic QA; optional vision review | Configuration (D-1) |
| Content package for both platforms | One run per day; shared text (`sharedAcrossChannels`) or one caption per channel; one image per run rendered per channel | Configuration |
| Approval | `approvalMode: "human_each"`; owner release in Marketing → Freigaben binds the exact package hash | Existing |
| Native publishing at 18:30 | `delivery: "publish"` with `publishingBackend: "social"`: Marketing keeps the publication until the slot, runs its final preflight and hands it to Social (`submitOriginPost`, mode `now`); one Social post per account; Social's exactly-once delivery (fence, `outcome_unknown`, no automatic resend); status and permalink flow back through `originPostStatus` | Configuration (assignment delivery changes from `postiz_draft` to `publish`) |
| Account resolution and checks | Channel → account via `legacyPostizIntegrationId`; Social's `publishingBlockers` at preflight and claim (active, write-verified, platform enabled, public media) | Existing |
| Image failure | `visual` is a hard dependency of `review`: no image, no review, nothing delivered | Existing (tested) |
| Modes | Manual: no assignment. With approval: `human_each`. Fully automatic: `delegated_review` plus agent review authority (owner confirmation; `ORBIT_AGENT_REVIEW_AUTHORITY`; creatives stay owner-gated per CS-D7) | Existing; documented, no new logic |
| Data isolation, roles | Scoped transactions with FORCE RLS, module activation, owner-only release | Existing |

## Gaps closed by code

### G1. Late release expires instead of moving (D-2: all assignments)

Today `releaseAssignmentDraft` calls `vetoSlot(…, vetoMs = 0, now)`, which skips past candidates and moves the post to the next free half hour of the same day (`agents/veto.ts:138`, `agents/owner-release.ts:210`).

New behaviour for every delivery (`publish` and `postiz_draft`): if `now >= plannedSlotAt`, the release is refused with `SLOT_EXPIRED` (409), nothing moves, and the deliverable is recorded as expired on the run (`outcome: "expired"`). A release before the slot keeps today's behaviour, including moving within the same day when the slot was taken in the meantime, but only to candidates still in the future. The approvals list (`draftsAwaitingOwner`) shows passed drafts as "Abgelaufen" without a release button until the day ends. Agent-approved drafts (`scheduleApproved`, delegated review) follow the same rule: a past slot is never replaced by a later one.

### G2. Marketing claim refuses late publications

`claimPublication` today refuses only early sends (`NOT_DUE`). New: a publication job that runs more than `SLOT_GRACE_MS` (30 minutes, the existing Social resume window) after its `scheduledAt` marks the publication `failed` with `SLOT_EXPIRED` and never hands it to Social. This covers worker or Redis outages between approval and slot.

### G3. Social maximum lateness (D-3: all Social posts)

Social sends whatever is due when the worker gets to it; throttle waits and after-delay retries (Facebook 368 and Instagram quota wait one hour) can push a send hours past its time.

New rule in `claimPublication` (Social), on the first attempt and on every retry: a publication whose reference time is more than 30 minutes in the past is marked `failed` with `SOCIAL_SLOT_EXPIRED`, `retryDisposition: "never"`, and is never sent. Reference time: the post's `scheduledAt` for scheduled posts, `approvedAt` for `now` posts (origin and manual). `dispatchPost` applies the same check before creating publications. A throttle or retry delay that would end beyond the limit fails right away with the same code instead of waiting. Already-sending publications are unaffected (they keep the `outcome_unknown` path). The existing attention item `social_post_missed` lists them. No schema change: `scheduledAt` and `approvedAt` exist.

Marketing's reconciliation maps a Social `failed` with `SOCIAL_SLOT_EXPIRED` to its publication `failed` with the same code; nothing is retried.

### G4. Topic history window and Social-native posts

`STRATEGY_HISTORY_DAYS` and the topic reservation window are fixed at 14 days, and the history sync reads only Postiz.

New:

- Optional assignment field `historyDays` (14–60, default 14). It sets the strategy's channel history window and the topic reservation hold for that assignment. FamilyPlan uses 30.
- New Social contract function `recentPosts(scope, accountIds, since)`: published, scheduled and in-flight Social posts (text, time, status), excluding the read-only Postiz mirror (already covered by Orbit's own content rows). `marketingHistory` merges it, so posts made natively in Social count against repeats.

### G5. One library copy per image

Facebook and Instagram hand-offs each call `importOriginMedia`, creating two library assets per day against the 100 MB project quota. New: `importOriginMedia` reuses a non-archived library asset of the same project with the same original sha256. A daily 4:5 JPEG pair is roughly 1–2 MB; the quota (`FILES_PROJECT_QUOTA_BYTES`) is an operations setting to review after the first month.

### G6. Retry a failed run

New owner action "Lauf wiederholen" (`POST /api/projects/:projectId/assignment-runs/:runId/retry`, assistant tool `assignment_change` action `retry`). Allowed when the run is `failed` or `partial`, the assignment is `active`, and the first open slot is at least 60 minutes ahead. It cancels the run's unfinished steps and deliverables, then plans a new run for the same date through the normal planner (new run id, so new budget reservations under the assignment's monthly cap; the same date idempotency applies). Audited `assignment.run_retried`. No retry once a slot passed.

### G7. Assignment detail view

Marketing → Aufträge gets a detail view per assignment (route below the existing page, deep links kept). Read-only, from existing data plus one aggregated read route:

- settings: platforms (resolved account names), times and time zone, preparation time, delivery, approval mode, image mode, `historyDays`, monthly budget and spend;
- last and next run with status, step errors (error code and message) and the retry button (G6);
- today's and recent deliverables: preview of text and image, release state ("Freigeben" link to Marketing → Freigaben, or "Abgelaufen"), status per platform with permalink, link to the post in the Social calendar.

Pause, resume and end stay as they are. Changing content stays the confirmation card (chat or MCP), because it needs `assignment.confirm`.

### G8. Expiry warnings

Attention items for the owner 7 days before the active marketing policy's `endAt` and before the AI spend authority's `endAt` (`marketing_policy_expiring`, `ai_spend_authority_expiring`, counts and dates only, link to the place to extend). Nothing is extended automatically. Both FamilyPlan dates are 2026-11-19.

## Data flow (target)

1. 08:00 Berlin: the sweep creates the run for today's 18:30 slot (`createAt = slot − 630 min`).
2. Strategy reads profile, plan, facts and 30 days of history (Orbit and Social), reserves topic and angle.
3. Copywriter drafts the German caption(s); visual generates one 4:5 art and renders it per channel; review checks claims and leaves the drafts for the owner (`HUMAN_CONTENT_REVIEW_REQUIRED`).
4. Owner releases each draft before 18:30 in Marketing → Freigaben. After 18:30 the release is refused (`SLOT_EXPIRED`).
5. 18:30: Marketing's publication job claims, runs preflight, imports the image (one library asset), submits one Social post per account in mode `now`.
6. Social delivers each post once, within 30 minutes or not at all; Facebook and Instagram outcomes and permalinks are stored per publication and shown in Marketing, the Social calendar and the assignment detail.

## Error handling

| Case | Result |
|---|---|
| Image generation fails or budget refuses it | Visual task fails, review skipped, run `failed`, `run_problem` notice; owner may retry (G6) while the slot is reachable |
| Account disconnected or not write-verified | Preflight or Social claim blocks (`SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED`, reconnect), attention item; no send |
| Approval after 18:30 | `SLOT_EXPIRED`, deliverable expired, nothing sent |
| Worker down at 18:30 | Marketing claim > 30 min late: `SLOT_EXPIRED`; Social claim > 30 min late: `SOCIAL_SLOT_EXPIRED` |
| Temporary platform error | Social after-delay retry within the 30-minute limit; otherwise `SOCIAL_SLOT_EXPIRED` |
| Unclear platform result | `outcome_unknown`, read back once, owner settles; never resent |
| One platform fails | The other publication is independent; no second post anywhere |
| Policy or spend authority expired | No slots / `PAID_MANDATE_EXPIRED`; warning 7 days ahead (G8) |
| Redelivered jobs, restarts, parallel workers | Existing advisory lock, date idempotency, publication idempotency key and fence |

## Testing

Unit and integration tests (own worktree test DB) for:

1. Run planning at 08:00 for an 18:30 slot in winter and summer time and across both DST switch days.
2. `historyDays` window, topic reservation for 30 days, Social-native posts in the history (no immediate repeat).
3. Creative run produces caption(s) and a 1080×1350 rendition per channel (fake image provider).
4. `human_each` leaves the drafts for the owner; no publication before release.
5. Release before the slot creates publications at 18:30 with the release's package approval.
6. Facebook and Instagram hand-off: one Social post per account, one library asset, status and permalink reconciled.
7. Missing or not-write-verified account blocks at preflight and claim.
8. Image failure: no review, no delivery, run failed, retry allowed before the slot only.
9. Redelivered publication job and worker restart: no second Social post.
10. Duplicate dispatch and lease expiry: still one send per publication.
11. Late release (`SLOT_EXPIRED`, both deliveries), late Marketing claim, Social lateness on first attempt and retry.
12. Expired marketing policy and spend authority: no run, no paid call; warnings 7 days ahead.

Plus the safety nets (`rls-matrix`, `access-matrix`, `queue-dispatch`), web tests for the detail view, `pnpm api:generate` for the retry and detail routes, boundary check (Marketing imports only `social/contract.ts`).

The end-to-end check runs locally with fake providers and `EXECUTION_MODE` test. In production the first runs only prepare: a real post happens only when Mario releases it, which is a separate approval.

## Rollout (each step needs Mario's explicit approval)

1. Push to `main` (deploy). No migration, no schema hash.
2. Profile: Creative brand kit for FamilyPlan (imagery kind, mood, subjects, avoid list; approved raster logo already exists) and `visualIdentity.creative.enabled`.
3. Extend the marketing policy `endAt` and the AI spend authority beyond 2026-11-19.
4. Reconfigure the assignment through the confirmation card: `times:["18:30"]`, `leadMinutes:630`, `delivery:"publish"`, `approvalMode:"human_each"`, `creative:{artPer:"run"}`, `historyDays:30`, FB+IG, topic frame with the primary and secondary themes, budget fitting one image plus text per day. Mario confirms.
5. First day: Mario checks the preview; releasing it is the first real post.

Rollback: pause the assignment, or set its delivery back to `postiz_draft` (Social drafts only); code rollback by reverting the commits (no schema change).

## Decisions

- D-1 (Mario, 2026-11-07): image through Creative Studio (art with short headline and logo, 4:5), not a plain image.
- D-2 (Mario, 2026-11-07): an expired slot is never moved, for all assignments.
- D-3 (Mario, 2026-11-07): 30-minute maximum lateness for all Social posts.

## Out of scope

Native recurring posts in Social, a second calendar, image novelty checks across days, Postiz decommissioning, channel metadata still read from the Postiz connector entity (SOCIAL.md "Not yet").

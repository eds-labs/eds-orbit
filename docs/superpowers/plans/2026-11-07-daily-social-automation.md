# Daily social automation on assignments: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One FamilyPlan assignment prepares a German post with a 4:5 Creative Studio image every day at 08:00 Europe/Berlin, the owner releases it in the existing approval flow, and the native Social module publishes it to Facebook and Instagram at 18:30, never late and never twice.

**Architecture:** Extend the existing Orbit Agents assignment pipeline and the Marketing → Social hand-off; no new scheduler, worker, delivery mode or database model. Code closes nine gaps (G1–G9 in the spec): slot expiry in Marketing and Social, a configurable topic history including Social-native posts, image dedupe, run retry, an assignment detail view, expiry warnings and native `social:<accountId>` channel references.

**Tech Stack:** TypeScript, Fastify API, BullMQ worker via outbox, Prisma/PostgreSQL (generic `Entity` rows for Marketing, Social tables), Next.js web, Vitest (integration tests against the worktree's own test DB).

**Spec:** `docs/superpowers/specs/2026-11-07-daily-social-automation-design.md`

## Global Constraints

- No schema change and no migration (Marketing data is `Entity` JSON; Social uses existing `scheduledAt`/`approvedAt`).
- Marketing imports only `apps/api/src/modules/social/contract.ts` from Social (`scripts/boundaries.json`); no platform-to-module imports.
- Slot grace and Social maximum lateness: exactly 30 minutes (`30 * 60_000`), the existing Social `LATE_WINDOW_MS`.
- Retry is allowed only when the run's first open slot is at least 60 minutes ahead.
- Expiry warnings start 7 days before `endAt`.
- `historyDays`: integer 14–60, default 14.
- New error codes, verbatim: `SLOT_EXPIRED`, `SOCIAL_SLOT_EXPIRED`, `RUN_NOT_RETRYABLE`, `RUN_RETRY_TOO_LATE`, `SOCIAL_CHANNEL_REQUIRES_SOCIAL_BACKEND`.
- New attention kinds, verbatim: `marketing_policy_expiring`, `platform_spend_authority_expiring`.
- New audit action: `assignment.run_retried`; new Social audit action: `social.publication.expired`.
- No account, project or assignment ids in production code.
- Docs and code comments in English; UI copy in German and English (`{ de, en }` like the surrounding components).
- Behaviour of projects on Postiz stays unchanged except D-2 (late release never moves, all assignments).

## Review Focus

1. Release at exactly the slot instant (`now == plannedSlotAt`) must be expired, not released (Task 1 pins `>=`).
2. A Social `now` post whose `approvedAt` is null (legacy rows) must not crash the lateness check; it falls back to `createdAt` (Task 3 test).
3. Facebook and Instagram hand-offs at the same 18:30 instant may both miss the dedupe lookup; that is accepted (two copies), never an error (Task 4 test runs both imports concurrently and accepts 1 or 2 assets).
4. Retrying a run whose old drafts are still listed for release must not leave two release cards for the same slot (Task 7 test).
5. DST switch days (2026-03-29, 2026-10-25) must produce the run at 08:00 local and the slot at 18:30 local (Task 0 test).

---

### Task 0: Worktree setup and pinned baseline for the target configuration

Pins existing behaviour the feature relies on (spec tests 1, 3, 4, 8, 9, 10), so later tasks cannot break it unnoticed.

**Files:**
- Create: `apps/api/tests/daily-social-automation.integration.test.ts`

**Interfaces:**
- Consumes: `planAssignmentRuns(tx, scope, now)` (`modules/marketing/agents/assignment-runs.ts:444`), `releaseAssignmentDraft` (`agents/owner-release.ts:117`), `dispatchPublication` (`publishing/publisher.ts`), helpers in `tests/support/package-project.ts` and `tests/support/assignment-review.ts` (as used in `assignment-owner-release.integration.test.ts` and `marketing-social-backend.integration.test.ts`).
- Produces: a test harness `dailyProject()` in this file (FamilyPlan-like project on Social with a Facebook and an Instagram account mapped to two channels, policy `assisted`, assignment `daily`, `times:["18:30"]`, `leadMinutes:630`, `delivery:"publish"`, `approvalMode:"human_each"`, `creative:{artPer:"run"}`) reused by Tasks 1, 2, 6, 7.

- [ ] **Step 1: Set up the worktree**

Run: `corepack pnpm install --frozen-lockfile && ./node_modules/.bin/prisma generate --config packages/db/prisma.config.ts && node scripts/test-db-for-worktree.ts`
Expected: install completes, `.runtime/test.env` exists.

- [ ] **Step 2: Write the pinning tests**

Tests (all expected to PASS on current code):
- `plans the run at 08:00 Berlin for an 18:30 slot in winter and summer time`: for `now` = 2026-01-15T06:00Z and 2026-07-15T05:00Z, the planned run's `createAt` is 07:00Z / 06:00Z and `slots[0].at` is 17:30Z / 16:30Z.
- `keeps 08:00 and 18:30 local on both DST switch days`: dates 2026-03-29 and 2026-10-25; `slots[0].at` = 16:30Z and 17:30Z; `createAt` = 06:00Z and 07:00Z.
- `a creative run renders a 1080x1350 rendition per channel` (fake image provider as in `assignment-creatives.integration.test.ts`): each draft's `assetId` points to an asset with `width 1080`, `height 1350`.
- `human_each leaves both drafts for the owner and creates no publication`: `draftsAwaitingOwner` returns 2 items, `publications` empty.
- `a failed image skips review and delivers nothing`: visual task fails → run `failed`, review step `skipped`, no `needs_review` draft listed.
- `a redelivered publication job makes one Social post`: after release and dispatch at the slot, a second `dispatchPublication` call leaves `socialPost` count at 2 (one per account).

- [ ] **Step 3: Run**

Run: `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run apps/api/tests/daily-social-automation.integration.test.ts`
Expected: PASS (6 tests). A failure here is a finding to report before continuing, not something to fix silently.

- [ ] **Step 4: Commit**

```bash
git add apps/api/tests/daily-social-automation.integration.test.ts
git commit -m "test: pin assignment behaviour for the daily social automation"
```

---

### Task 1: An expired slot is never moved (G1, D-2)

**Files:**
- Modify: `apps/api/src/modules/marketing/agents/veto.ts` (export `SLOT_EXPIRED`, `slotExpired`; use in `scheduleApproved` ~line 321)
- Modify: `apps/api/src/modules/marketing/agents/owner-release.ts:206-226` and the doc comment at :46-49
- Modify: `apps/api/src/modules/marketing/agents/assignment-overview.ts:372-470` (`draftsAwaitingOwner`)
- Modify: `apps/api/src/modules/marketing/attention.ts` (`draftItems` skips expired)
- Modify: `apps/web/src/modules/marketing/assignments.tsx` (`AwaitingOwnerDraftList`, ~:633-828)
- Test: `apps/api/tests/assignment-owner-release.integration.test.ts` (replace the "slot passed" half of the test at :389), `apps/api/tests/assignment-veto.integration.test.ts`, `apps/api/tests/attention-marketing.integration.test.ts`, `apps/web/src/modules/marketing/assignments.test.tsx`

**Interfaces:**
- Produces: `export const SLOT_EXPIRED = "SLOT_EXPIRED"`; `export function slotExpired(slot: Date, now: Date): boolean` (true when `now.valueOf() >= slot.valueOf()`); `draftsAwaitingOwner` items gain `expired: boolean`.

- [ ] **Step 1: Write the failing tests**
  - Owner release: split the existing test. Keep "moves to the next free slot when the run slot is taken". New `refuses a release at or after the run slot with SLOT_EXPIRED`: system time = `slots[1].at` exactly → `code(release(...)) === "SLOT_EXPIRED"`, no publication, content still `needs_review`, mission `plannedSlotAt` unchanged; same at `+10 min`.
  - Same refusal for a `postiz_draft` assignment (no handoff booked).
  - Veto (delegated review): an agent-approved draft processed after its slot is dropped with code `SLOT_EXPIRED` (in `run.scheduling.dropped`), no publication.
  - `draftsAwaitingOwner` lists a passed draft of today with `expired: true`, a future one with `expired: false`.
  - Attention: an expired draft produces no `marketing_draft_release` item.
  - Web: an expired draft shows "Abgelaufen" / "Expired" and no release button.

- [ ] **Step 2: Run, expect FAIL**

Run: `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run apps/api/tests/assignment-owner-release.integration.test.ts apps/api/tests/assignment-veto.integration.test.ts apps/api/tests/attention-marketing.integration.test.ts apps/web/src/modules/marketing/assignments.test.tsx`
Expected: the new cases fail (late release still answers `released`).

- [ ] **Step 3: Implement**
  - `releaseAssignmentDraft`: after `planned` is computed and before `vetoSlot`, `if (slotExpired(planned, now)) throw new DomainError(SLOT_EXPIRED, 409)`. Update the doc comment: a passed slot is refused, a taken future slot still moves within the day.
  - `scheduleApproved`: before calling `vetoSlot`, `if (slotExpired(planned, now)) failure = SLOT_EXPIRED`.
  - `draftsAwaitingOwner`: `expired: slotExpired(new Date(slotAt), now)` with one `now` per call.
  - `draftItems`: `drafts.filter((d) => !d.expired)`.
  - Web: expired rows render a muted badge and no button.

- [ ] **Step 4: Run, expect PASS** (same command)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/marketing apps/api/tests apps/web/src/modules/marketing
git commit -m "feat(marketing): never move an assignment post past its slot"
```

---

### Task 2: Marketing refuses publications that start too late (G2)

**Files:**
- Modify: `apps/api/src/modules/marketing/pipeline/workflow.ts:521-535` (`claimPublication`)
- Test: `apps/api/tests/daily-social-automation.integration.test.ts`

**Interfaces:**
- Produces: `export const SLOT_GRACE_MS = 30 * 60_000` in `workflow.ts`.

- [ ] **Step 1: Write the failing tests**
  - `a publication job 31 minutes after the slot is blocked with SLOT_EXPIRED`: release before the slot, then system time = slot + 31 min, `dispatchPublication` → publication `status: "blocked_dependency"`, `blockers: ["SLOT_EXPIRED"]`, no Social post, an open exception `PUBLISH_PREFLIGHT_BLOCKED`.
  - `a publication job 29 minutes after the slot still goes out`: one Social post per account.

- [ ] **Step 2: Run, expect FAIL**

Run: `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run apps/api/tests/daily-social-automation.integration.test.ts`

- [ ] **Step 3: Implement** in `claimPublication`, right after the `NOT_DUE` check: when `Date.now() - Date.parse(v.scheduledAt) > SLOT_GRACE_MS`, update to `blocked_dependency` with `blockers: [SLOT_EXPIRED]` (import from `../agents/veto.ts`), call `exception(…, "PUBLISH_PREFLIGHT_BLOCKED", pub.id)` and `reportBlockedPost(…, [SLOT_EXPIRED])`, return `{ send: false, pub }`, exactly like the veto-blocker branch.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/marketing/pipeline/workflow.ts apps/api/tests/daily-social-automation.integration.test.ts
git commit -m "feat(marketing): block a publication that starts more than 30 minutes late"
```

---

### Task 3: Social never sends more than 30 minutes late (G3, D-3)

**Files:**
- Create: `apps/api/src/modules/social/dispatch/lateness.ts`
- Modify: `apps/api/src/modules/social/dispatch/control.ts:22` (import the constant instead of declaring it)
- Modify: `apps/api/src/modules/social/dispatch/claim.ts` (`claimPublication` after `post` is read, ~:62; throttle branch ~:88; `finishPublication` after-delay branch ~:214)
- Test: `apps/api/tests/social-deliver.integration.test.ts`, `apps/api/tests/marketing-social-backend.integration.test.ts`

**Interfaces:**
- Produces (`lateness.ts`): `export const LATE_WINDOW_MS = 30 * 60_000`; `export function sendDeadline(post: { scheduleMode: string; scheduledAt: Date | null; approvedAt: Date | null; createdAt: Date }): Date` (reference = `scheduledAt` when `scheduleMode === "at"`, else `approvedAt ?? createdAt`; plus `LATE_WINDOW_MS`); `export async function expirePublication(tx: DbTx, scope: Scope, id: string): Promise<void>` (sets `status: "failed"`, `retryDisposition: "never"`, `nextAttemptAt: null`, `lastErrorCode: "SOCIAL_SLOT_EXPIRED"`, `fence: null`, increments `version`, audits `social.publication.expired`, refreshes the post status).
- `ClaimResult` gains `{ kind: "expired" }`; `deliverPublication` maps it to `{ status: "succeeded", errorCode: "SOCIAL_SLOT_EXPIRED" }`.

- [ ] **Step 1: Write the failing tests** (`social-deliver.integration.test.ts`)
  - `a scheduled post claimed 31 minutes after its time expires and is never sent`: sender mock not called, publication `failed`/`SOCIAL_SLOT_EXPIRED`/`never`, post `failed`.
  - `a now post claimed 31 minutes after its approval expires` (and the same with `approvedAt: null`, reference `createdAt`).
  - `an after-delay retry whose next attempt lies beyond the deadline fails at once with SOCIAL_SLOT_EXPIRED` and enqueues no deliver job.
  - `a throttle wait beyond the deadline expires instead of re-queuing`.
  - `a claim 29 minutes late still sends`.
  - In `marketing-social-backend.integration.test.ts`: `Marketing reconciles a Social SOCIAL_SLOT_EXPIRED as failed with the same code`.

- [ ] **Step 2: Run, expect FAIL**

Run: `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run apps/api/tests/social-deliver.integration.test.ts apps/api/tests/marketing-social-backend.integration.test.ts`

- [ ] **Step 3: Implement**
  - `claimPublication`: after the `post.status !== "publishing"` check, `if (now > sendDeadline(post)) { await expirePublication(tx, scope, id); return { kind: "expired" }; }`; in the throttle branch, if `throttle.until > sendDeadline(post)` expire instead of returning `later`.
  - `finishPublication` after-delay: if `next > sendDeadline(post)` take the `never` branch with code `SOCIAL_SLOT_EXPIRED` (through `expirePublication`, then the `social.publication.failed` event).
  - `control.ts`: use the imported `LATE_WINDOW_MS`.
  - Marketing reconciliation (`publisher.ts:371-431`): only if the new test fails, map the code through unchanged.

- [ ] **Step 4: Run, expect PASS**, plus `apps/api/tests/social-control.integration.test.ts apps/api/tests/social-dispatch.integration.test.ts apps/api/tests/social-reconcile.integration.test.ts` unchanged green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/social/dispatch apps/api/tests/social-deliver.integration.test.ts apps/api/tests/marketing-social-backend.integration.test.ts
git commit -m "feat(social): never send a post more than 30 minutes late"
```

---

### Task 4: One library asset per image (G5)

**Files:**
- Modify: `apps/api/src/modules/social/media/library.ts:87-156` (`uploadMedia`)
- Modify: `apps/api/src/modules/social/contract.ts:100-102` (`importOriginMedia`)
- Test: `apps/api/tests/social-media-library.integration.test.ts`, `apps/api/tests/social-contract.integration.test.ts`

**Interfaces:**
- `uploadMedia(scope, input: { bytes; mime; name?; reuse?: boolean })`: with `reuse`, after `prepareSocialImage` it computes the sha256 of `prepared.original.bytes` (the value stored in `SocialMediaAsset.sha256`) and returns the existing non-archived asset of the project with that hash, storing nothing.
- `importOriginMedia` passes `reuse: true`. Manual uploads keep `reuse` off.

- [ ] **Step 1: Write the failing tests**
  - `importOriginMedia twice with the same bytes returns the same id and stores one asset`.
  - `an archived asset is not reused`.
  - `assets of another project are never reused` (second project, same bytes → different id).
  - `two concurrent imports of the same bytes both succeed` (1 or 2 assets accepted).
  - `a manual upload of the same bytes still creates a new asset`.

- [ ] **Step 2: Run, expect FAIL**

Run: `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run apps/api/tests/social-media-library.integration.test.ts apps/api/tests/social-contract.integration.test.ts`

- [ ] **Step 3: Implement** the lookup with `scoped(scope.workspaceId, scope.projectId, (tx) => tx.socialMediaAsset.findFirst({ where: { projectId, sha256, archivedAt: null }, orderBy: { createdAt: "asc" } }))`, returning the same `MediaView` shape as a fresh upload.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/social apps/api/tests/social-media-library.integration.test.ts apps/api/tests/social-contract.integration.test.ts
git commit -m "feat(social): reuse the library asset when Marketing hands over the same image"
```

---

### Task 5: Native `social:<accountId>` channels (G9)

**Files:**
- Modify: `apps/api/src/modules/social/contract.ts` (export `isSocialChannel`)
- Modify: `apps/api/src/modules/marketing/publishing/postiz-assignment.ts:131-141` (`assertAssignedSocialChannels`)
- Modify: `apps/api/src/modules/marketing/publishing/channel-rules.ts:33` (`resolveChannelRules`)
- Modify: `apps/api/src/modules/marketing/agents/assignment-overview.ts` (`channelNames`)
- Modify: `apps/api/src/modules/marketing/publishing/postiz-draft.ts:172-185` (`draftTarget`)
- Test: `apps/api/tests/marketing-social-backend.integration.test.ts`, `apps/api/tests/assignments.integration.test.ts`

**Interfaces:**
- Produces: `export function isSocialChannel(channel: string): boolean` (the existing `SOCIAL_CHANNEL` regex) in `contract.ts`.
- `assertAssignedSocialChannels`: a `social:` reference is accepted only when `publishingBackend(tx, scope) === "social"` (otherwise `SOCIAL_CHANNEL_REQUIRES_SOCIAL_BACKEND`, 409) and `accountForChannel` returns a non-disabled account of this project (otherwise `POSTIZ_CHANNEL_NOT_ASSIGNED`); Postiz ids keep today's check. This one function covers policy saves (`policy-admin.ts:218`), plans and proposals.
- `resolveChannelRules`: for a `social:` reference, rules from the account's platform through the same provider table the Postiz branch uses (`facebook`, `instagram`), `connectorId: null`, `connectorVersion: null`, `liveCapabilityKnown: true` (Social decides at send), `postingTime: null`.
- `channelNames`: `social:` references map to the account handle.
- `draftTarget`: on the `social` backend with a `social:` reference, skip the Postiz connector lookup; the policy-channel check stays.

- [ ] **Step 1: Write the failing tests**
  - `a policy and an assignment on social:<accountId> channels are accepted on the Social backend`.
  - `social: references are refused on the Postiz backend with SOCIAL_CHANNEL_REQUIRES_SOCIAL_BACKEND`.
  - `another project's account is refused`.
  - `channel rules for a social: Instagram channel require media`.
  - `an assignment on social: channels is released and handed to Social at the slot` (one Social post per account, permalink reconciled).
  - `an assignment draft on a social: channel becomes a Social draft without a Postiz connector`.

- [ ] **Step 2: Run, expect FAIL**

Run: `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run apps/api/tests/marketing-social-backend.integration.test.ts apps/api/tests/assignments.integration.test.ts`

- [ ] **Step 3: Implement** as in Interfaces. Any further `isAssignedPostizChannel` caller hit by the end-to-end test gets the same `isSocialChannel` branch; readiness and analytics stay Postiz-only (out of scope, SOCIAL.md "Not yet").

- [ ] **Step 4: Run, expect PASS**, plus `node scripts/boundaries.mjs` reports 0 violations.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules apps/api/tests
git commit -m "feat(marketing): accept native social:<accountId> channels on the Social backend"
```

---

### Task 6: 30-day topic history including Social-native posts (G4)

**Files:**
- Modify: `apps/api/src/modules/marketing/agents/assignments.ts:143-175` (`assignmentFields`), plus a helper
- Modify: `apps/api/src/modules/marketing/agents/specialists/strategy.ts:162-239, 312-327`
- Modify: `apps/api/src/modules/marketing/agents/novelty.ts` (`marketingHistory`, `reserveTopic`, new `recentTopicIdentities`)
- Modify: `apps/api/src/modules/marketing/agents/topic-briefs.ts:55`
- Modify: `apps/api/src/modules/social/contract.ts` (new `recentPosts`)
- Modify: `apps/api/src/modules/marketing/tools/assignment-tools.ts` (accept and show `historyDays` in propose/change)
- Test: `apps/api/tests/marketing-novelty-backlog.integration.test.ts`, `apps/api/tests/assignments.integration.test.ts`, `apps/api/tests/social-contract.integration.test.ts`, `apps/api/tests/assignment-tools.integration.test.ts`

**Interfaces:**
- `assignmentFields.historyDays: z.number().int().min(14).max(60).optional()`; `export function historyDaysOf(assignment: Record<string, any>): number` (default 14). It is part of the assignment content, so it changes the hash and needs confirmation like any other field.
- `reserveTopic(tx, scope, input & { holdDays?: number }, now)`: `holdDays` (default `HISTORY_DAYS`) sets `expiresAt` and the content window.
- `export async function recentTopicIdentities(tx, scope, channels: string[], since: Date): Promise<Array<{ channel: string; topic: string; angle: string; pillar: string; at: string }>>` from `marketing_topic_reservations` not `released`, newest first, at most 60.
- Social contract: `export async function recentPosts(tx: DbTx, scope: Scope, accountIds: string[], since: Date): Promise<Array<{ accountId: string; text: string; at: string; status: "published" | "scheduled" }>>`: posts of these accounts with status published, partially_published, scheduled, approved or publishing, excluding `origin = "legacy_postiz"` and origin module `marketing` (already Orbit content), at most 100, text of the account's variant cut to 280.
- `marketingHistory(tx, scope, channels, now, days)`: for channels that `accountForChannel` resolves while Social publishing is available, append `recentPosts` items with `source: "external"`, `recordKind: "social_posts"`, `title: "Social post"`, `origin: "manual"`.
- Strategy input gains `recentTopics` (from `recentTopicIdentities` over `historyDaysOf(assignment)` days); the history window uses `historyDaysOf(input.assignment)`; the prompt names `recentTopics` and states that no topic+angle in it may be reused and that consecutive posts should change pillar where the plan allows.
- `reserveStrategyBriefs` passes `holdDays: historyDaysOf(assignment)`.

- [ ] **Step 1: Write the failing tests**
  - `historyDays outside 14..60 is refused; absent means 14`.
  - `a reservation with holdDays 30 blocks the same topic and angle on day 29 and allows it on day 31`.
  - `recentTopicIdentities lists the last 30 days' topics, newest first`.
  - `recentPosts returns native published and scheduled posts, not Marketing hand-offs or the Postiz mirror, and nothing of another project`.
  - `the strategy input of a 30-day assignment carries 30 days of history, recentTopics and a Social-native post` (inspect the prepared input via `prepareInput` with a recorded reply, as the existing strategy tests do).
  - `assignment_propose accepts historyDays`.

- [ ] **Step 2: Run, expect FAIL**

Run: `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run apps/api/tests/marketing-novelty-backlog.integration.test.ts apps/api/tests/assignments.integration.test.ts apps/api/tests/social-contract.integration.test.ts apps/api/tests/assignment-tools.integration.test.ts`

- [ ] **Step 3: Implement** as in Interfaces; `STRATEGY_HISTORY_DAYS` stays the default (14).

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules apps/api/tests
git commit -m "feat(marketing): per-assignment topic history including native Social posts"
```

---

### Task 7: Retry a failed run (G6)

**Files:**
- Modify: `apps/api/src/modules/marketing/agents/assignment-runs.ts` (new `retryAssignmentRun`; `plannedDates` ignores retired runs)
- Modify: `apps/api/src/modules/marketing/routes.ts` (new route next to `/assignments/:id/status`)
- Modify: `apps/api/src/modules/marketing/tools/assignment-tools.ts` (`assignment_change` action `retry` with `runId`)
- Modify: `apps/web/src/modules/marketing/assignments.tsx` (button; used again in Task 8)
- Generated: `pnpm api:generate` output (OpenAPI and client)
- Test: `apps/api/tests/assignment-runs.integration.test.ts`, `apps/api/tests/assignment-routes.integration.test.ts`, `apps/api/tests/assignment-tools.integration.test.ts`, `apps/web/src/modules/marketing/assignments.test.tsx`

**Interfaces:**
- `export async function retryAssignmentRun(tx: DbTx, scope: Scope, runId: string, now = new Date()): Promise<{ retiredRunId: string; runId: string }>`; owner only (`OWNER_REQUIRED`). Refuses `RUN_NOT_RETRYABLE` (409) unless the run status is `failed` or `partial`, the assignment is `active`, and no slot has `publicationId` or `postizDraftId` and none of its drafts was released. Refuses `RUN_RETRY_TOO_LATE` (409) when `min(open slot at) - now < 60 min`. Effect in one transaction: the old run gets `retiredAt`, `retiredBy` and `retriedByRunId`; its `needs_review` drafts get `supersededBy: <new run id>` (so `draftsAwaitingOwner` drops them); its held topic reservations get `state: "released"`; then `planAssignmentRuns(tx, scope, now)` creates the new run for the date; audit `assignment.run_retried` with both run ids. `plannedDates` skips runs with `retiredAt`.
- Route: `POST /api/projects/:projectId/assignment-runs/:runId/retry` (owner, `agentsEnabled()` else 404), body `{}` strict, answers `{ retiredRunId, runId }`.

- [ ] **Step 1: Write the failing tests**
  - `retries a failed run before its slot: a new run for the same date, the old one retired, its drafts gone from the release list, its topic free again`.
  - `refuses a done run, a run with a released draft, and a paused assignment with RUN_NOT_RETRYABLE`.
  - `refuses 59 minutes before the slot with RUN_RETRY_TOO_LATE`.
  - `editors get 403, other projects 404`.
  - `the new run's reservations count against the assignment month` (spend of both runs in `assignmentsMonthSpend`).
  - Tool: `assignment_change retry` returns both run ids.
  - Web: the retry button shows only for a retryable failed run and posts to the route.

- [ ] **Step 2: Run, expect FAIL**

Run: `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run apps/api/tests/assignment-runs.integration.test.ts apps/api/tests/assignment-routes.integration.test.ts apps/api/tests/assignment-tools.integration.test.ts apps/web/src/modules/marketing/assignments.test.tsx`

- [ ] **Step 3: Implement** as in Interfaces, then `pnpm api:generate` and review the diff (one new route).

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/api apps/web packages
git commit -m "feat(marketing): owner can retry a failed assignment run before its slot"
```

---

### Task 8: Assignment detail view (G7)

**Files:**
- Create: `apps/api/src/modules/marketing/agents/assignment-detail.ts`
- Modify: `apps/api/src/modules/marketing/routes.ts` (GET route)
- Create: `apps/web/src/modules/marketing/assignment-detail.tsx`
- Modify: `apps/web/src/modules/marketing/assignments.tsx` (row opens the detail; query `?assignment=<id>` keeps it deep-linkable)
- Generated: `pnpm api:generate`
- Test: `apps/api/tests/assignment-detail.integration.test.ts` (create), `apps/web/src/modules/marketing/assignment-detail.test.tsx` (create)

**Interfaces:**
- `export async function assignmentDetail(tx: DbTx, scope: Scope, assignmentId: string, now = new Date())` returns:
  `{ assignment: { id, version, name, status, channels: Array<{ id, name, platform }>, schedule: { rhythm, times, leadMinutes, timezone }, delivery, approvalMode, image: "none" | "plain" | "banner" | "creative", historyDays, monthlyBudgetMicros, monthSpentMicros }, nextRunAt: string | null, runs: Array<{ id, date, status, createdAt, errors: Array<{ step, code }>, retryable: boolean, deliverables: Array<{ contentId, channel, channelName, slotAt, excerpt, assetId: string | null, state: "awaiting_release" | "expired" | "released" | "published" | "failed" | "canceled" | "dropped", publication: { id, status, permalink: string | null, socialPostId: string | null, errorCode: string | null } | null }> }> }`. Last 7 runs, newest first. Excerpts as in `draftsAwaitingOwner` (no full bodies). `retryable` uses the same checks as `retryAssignmentRun`. Readable by any project member, like `GET /assignments` (`scopeFor` without a permission).
- Route: `GET /api/projects/:projectId/assignments/:id/detail` (`agentsEnabled()` else 404; another project's id 404).
- Web: sections "Einstellungen", "Läufe", "Beiträge". Each deliverable shows a thumbnail (existing asset thumbnail component), the state badge, "Freigeben" (link to `/approvals`) when awaiting, the permalink per platform, and "Im Social-Kalender" linking `/social/calendar?post=<socialPostId>`; the retry button from Task 7 on retryable runs.

- [ ] **Step 1: Write the failing tests**
  - API: `shows settings, the next run and today's deliverables with state per platform` (fixture from Task 0 after release and dispatch: two deliverables `published` with permalinks and `socialPostId`).
  - API: `an unreleased passed draft is expired; a failed run lists its step error and is retryable before the slot`.
  - API: `viewers may read; another project's assignment is 404`.
  - Web: renders the three sections, the calendar link with the post id, no release button on expired.

- [ ] **Step 2: Run, expect FAIL**

Run: `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run apps/api/tests/assignment-detail.integration.test.ts apps/web/src/modules/marketing/assignment-detail.test.tsx`

- [ ] **Step 3: Implement** from existing reads (`listAssignments`, `runsMatching`, `runProblems`, `channelNames`, `nextAssignmentRunAt`, publications with `remoteId` = Social post id and Social status through `originPostStatus`); `pnpm api:generate`.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/api apps/web packages
git commit -m "feat(marketing): assignment detail with runs, previews and platform status"
```

---

### Task 9: Expiry warnings for policy and spend authority (G8)

**Files:**
- Modify: `apps/api/src/modules/marketing/attention.ts`
- Modify: `apps/api/src/platform/attention/platform-items.ts:94` (`platformAttention`)
- Modify: `apps/web/src/modules/marketing/attention.tsx` (label for `marketing_policy_expiring`)
- Modify: `apps/web/src/modules/registry.ts` (label for `platform_spend_authority_expiring`, next to `platform_action_request`)
- Test: `apps/api/tests/attention-marketing.integration.test.ts`, `apps/api/tests/attention.integration.test.ts`, `apps/web/src/platform/shell/attention.test.tsx`

**Interfaces:**
- Marketing item: `{ id: "marketing:policy-expiring:<policyId>", moduleId: "marketing", kind: "marketing_policy_expiring", severity: "warning", dueAt: endAt, params: { endAt }, navKey: "operations", link: "/settings?section=policy" }`, owner only (`can(scope, PROJECT_OWN)`), when the active policy's `endAt` is within 7 days and not passed.
- Platform item: `{ id: "platform:spend-authority-expiring:<id>", kind: "platform_spend_authority_expiring", severity: "warning", dueAt: endAt, params: { endAt }, navKey: "operations", link: "/settings?section=ai" }` (as the existing `platform_provider_budget` item), owner only, from `activeSpendMandateRef`, same 7-day rule.
- Web copy: de "Marketing-Richtlinie läuft am {date} ab", en "Marketing policy expires on {date}"; de "KI-Ausgabenfreigabe läuft am {date} ab", en "AI spending authority expires on {date}".

- [ ] **Step 1: Write the failing tests**: item present 6 days before, absent 8 days before and after expiry, absent for editors; web renders the German label with the formatted date.

- [ ] **Step 2: Run, expect FAIL**

Run: `node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run apps/api/tests/attention-marketing.integration.test.ts apps/api/tests/attention.integration.test.ts apps/web/src/platform/shell/attention.test.tsx`

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/tests apps/web/src
git commit -m "feat: warn the owner a week before marketing policy or AI spending authority expire"
```

---

### Task 10: Documentation, full verification, local end-to-end check

**Files:**
- Modify: `docs/SOCIAL.md` (header state line, lateness rule, media reuse, `social:` channels in "Marketing on Social", remove the item from "Not yet")
- Modify: `docs/IMPLEMENTATION_STATUS.md` (new top entry: branch, what changed, verification, not deployed)
- Modify: `docs/REQUIREMENTS_TRACEABILITY.md` (rows for G1–G9)
- Create: `docs/deployment/FAMILYPLAN_DAILY_SOCIAL.md` (rollout steps 1–6 of the spec with the exact assignment card values, the modes table, the Meta crossposting check, rollback)

- [ ] **Step 1: Write the docs** (English; no secrets, no ids beyond the project id already in `FAMILYPLAN_MARKETING_SETUP.md`).

- [ ] **Step 2: Full checks**

Run: `corepack pnpm lint && corepack pnpm typecheck && node --env-file=.runtime/test.env ./node_modules/vitest/vitest.mjs run && node scripts/boundaries.mjs && git diff --check`
Expected: all green, including `rls-matrix`, `access-matrix` and `queue-dispatch`; revert `evals/knowledge/last-deterministic-run.json` if touched.

- [ ] **Step 3: Build**

Run: `corepack pnpm build`
Expected: success.

- [ ] **Step 4: Local end-to-end** (`EXECUTION_MODE` test, fake providers): with the worktree's own DB, seed a project as in Task 0, run the worker sweep at a faked 08:00, release both drafts, advance to 18:30, and confirm in the browser: approvals list, assignment detail (preview, state per platform), Social calendar post, then a late-release attempt answering `SLOT_EXPIRED`. Record what was checked in `IMPLEMENTATION_STATUS.md`.

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "docs: daily social automation on assignments"
```

Production steps (push to `main`, profile brand kit, policy and spend authority extension, assignment reconfiguration, first real post) are not part of this plan's execution; each needs Mario's separate approval per the spec's rollout.

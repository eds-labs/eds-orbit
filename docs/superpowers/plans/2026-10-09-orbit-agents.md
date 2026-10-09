# Orbit Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orbit Core runs one-off and standing assignments through background specialist agents (strategy, research, analytics, copywriter, visual, review) and publishes after a Telegram veto window, replacing the autopilot.

**Architecture:** Assignments, runs and agent tasks are project-scoped `Entity` rows. A worker queue `agent` runs each specialist as one bounded `AgentRuntime` turn (legacy Responses adapter) with a budgeted, non-streaming model and a role tool set; copy, image, checks, scheduling and Postiz handoff reuse the existing services. A Telegram bot (plain `fetch`, no SDK) delivers previews, Stop, notices and reports.

**Tech Stack:** TypeScript (Node 24.18.0), Fastify, BullMQ worker, Prisma/PostgreSQL with RLS, zod, `openai` 7.25.0, vitest, Next.js 16.3.8.

**Spec:** `docs/superpowers/specs/2026-10-09-orbit-agents-design.md`

## Global Constraints

- Everything new is behind `ORBIT_AGENTS` (default `false`), passed to api and worker by `docker-compose.yml` like `ORBIT_CONTENT_PACKAGES`.
- No new production dependency; Telegram uses `fetch`. Web search uses the Responses API hosted tool `{ type: "web_search" }`.
- Docs and code comments English; UI strings German and English like the existing components.
- Every paid model or image call: reserve → mark transmitted → settle; `outcome_unknown` on crash; never retried after transmission (existing `budget.ts`).
- Run key for budget attribution: `assignment-run:<runId>` (Ruling R24; it replaced the planned `assignment:<assignmentId>:<YYYY-MM>`, because the policy's per-run ceiling must not cap a whole month). The assignment's month spend is the sum of its runs' reservations in the month, checked against `monthlyBudgetMicros` before each reservation. Reservation key per model call: `agent:<taskId>:<n>`; executor steps use `agent:<taskId>:copy:<briefKey>` and `image:agent:<taskId>:image` (R37).
- Budget defaults: project 50 USD/month for uLiquid (editable on the policy), assignment monthly budget required at confirmation; exhausted assignment → status `budget_exhausted`.
- Specialist limits per task (defaults): 4 model calls, 6 tool calls, 3 web searches, 120 s, cost ceiling from the work plan.
- Veto window default 180 minutes; preparation lead default 360 minutes before the first slot of the day; weekly runs the day before.
- Channel history keeps 60 days; synced before each run, at most hourly.
- Deterministic blockers (facts, claims, forbidden statements, links, channel limits, duplicates, quota, spacing, calendar blocks, policy window) are never cleared by an agent.
- TDD per task; offline tests with recorded model outputs and fake Telegram/Postiz; `pnpm lint`, `pnpm typecheck`, `pnpm test` green before each commit. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Two assignments that want the same channel and day — exactly one post per slot, quota and spacing hold across assignments (Task 4 test `allocates one slot per channel across assignments`).
2. A run that finishes after `slot − vetoWindow` — the slot moves to the next free one so the full window remains (Task 11 test `moves a late deliverable so the veto window stays complete`).
3. Stop pressed after the handoff to Postiz — the bot answers that it can only be removed in Postiz and nothing changes (Task 12 test `answers honestly when the post was already handed over`).
4. Budget exhausted in the middle of a run — no further task starts, the assignment pauses itself, already settled work stays (Task 5 test `stops the run when the assignment budget is exhausted`).
5. Mario changes an assignment while its run is in progress — the run keeps the version it started with; its publications are refused at preflight if the confirmed version changed (Task 10 test `refuses agent-approved content of an outdated assignment version`).
6. Daily times across the DST change on 2026-10-25 (Europe/Berlin) — slots stay at local 10:00/17:00 (Task 4 test `keeps local slot times across the DST change`).

---

### Task 1: Verify image references and Postiz post text (decision task)

**Files:**

- Modify: `docs/superpowers/specs/2026-10-09-orbit-agents-design.md` (sections 7 and 8, "Verified" note)

- [ ] **Step 1:** Read `packages/ai/src/index.ts` (`generateImage`) and the pinned `openai` 7.25.0 types for `images.edit`/reference inputs of the configured image model (`gpt-image-2.5-flare`); decide whether reference images can be sent through Orbit's provider path without a new dependency.
- [ ] **Step 2:** Read `packages/connectors/src/postiz.ts` `remoteSchema` and Postiz's public API docs for `GET /posts`; record the field names for post text and media.
- [ ] **Step 3:** Write the result into spec sections 7/8 (one paragraph each: mechanism chosen, or fallback "derived style description" for section 8). No product code.
- [ ] **Step 4:** Commit `docs: record image reference and Postiz post fields for Orbit agents`.

### Task 2: Flag, collections and assignment model

**Files:**

- Modify: `packages/config/src/index.ts` (add `ORBIT_AGENTS`), `docker-compose.yml` (`x-api-environment`), `scripts/check-coolify-compose.mjs`, `packages/schemas/src/index.ts` (`collections`: `assignments`, `assignment_runs`, `channel_posts`)
- Create: `apps/api/src/modules/agents/assignments.ts`
- Test: `apps/api/tests/assignments.integration.test.ts`

**Interfaces:**

- Produces: `agentsEnabled(): boolean`; `assignmentInput` (zod) with `name`, `kind: "one_off"|"standing"`, `schedule: { rhythm: "daily"|"weekly"|"once", weekdays: number[], times: string[] /* "HH:MM" local */, date?: string, leadMinutes: number (default 360) }`, `contentType: "social"|"blog"|"newsletter"|"report"`, `channels: string[]`, `topicFrame: string`, `tone?: string`, `image: boolean`, `styleAssetIds: string[]`, `vetoMinutes: number (default 180, min 30, max 1440)`, `monthlyBudgetMicros: number`.
- Produces: `proposeAssignment(scope, conversationId, raw) => Promise<{ assignment: Entity; actionRequest: Entity }>` (creates `status: "draft"` and an ActionRequest `assignment.confirm`, owner decides); `confirmAssignment(tx, scope, assignmentId, version)` (executor of that action: `status: "active"`, `confirmation: { userId, at, assignmentHash, imageRightsConsent: boolean }`); `updateAssignment(tx, scope, id, version, patch) => Entity` (content changes return to `draft` and need a new confirmation; pause/resume/time-only changes do not); `setAssignmentStatus(tx, scope, id, status: "active"|"paused"|"ended")`.

- [ ] **Step 1: Failing tests** in `assignments.integration.test.ts` (fixture `createPackageProject`):
  - `creates a draft and an owner confirmation request` → `status "draft"`, action request `actionType "assignment.confirm"`.
  - `activates only on the owner's confirmation and records the consent` → editor decision rejected `FORBIDDEN`; owner → `status "active"`, `confirmation.imageRightsConsent === true` when `image: true`.
  - `refuses channels or content types the active policy does not allow` → `SCOPE_NOT_ALLOWED`.
  - `refuses a monthly budget above the project budget left for assignments` → `ASSIGNMENT_BUDGET_EXCEEDS_PROJECT`.
  - `a content change needs a new confirmation, a pause does not`.
  - `creates nothing while ORBIT_AGENTS is off` → `AGENTS_DISABLED`.
- [ ] **Step 2:** Run `pnpm vitest run apps/api/tests/assignments.integration.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement; register `assignment.confirm` in `apps/api/src/modules/action-requests.ts` `actionTypes` (decider owner, risk `W0_internal`, executor `confirmAssignment`); add the flag to config, compose and the compose check.
- [ ] **Step 4:** Run the test file and `pnpm test:coolify-compose` → PASS.
- [ ] **Step 5:** Commit `feat: add assignments behind ORBIT_AGENTS`.

### Task 3: Orbit Core tools for assignments

**Files:**

- Create: `apps/api/src/modules/agents/tools/assignment-tools.ts`
- Modify: `apps/api/src/modules/agents/tools/registry.ts` (`ToolFeature` += `"agents"`, `ToolNamespace` += `"assignments"`), `apps/api/src/modules/agents/tools/index.ts`, `apps/api/src/modules/chat-runner.ts` (feature list from `agentsEnabled()`, one instruction sentence on assignments)
- Test: `apps/api/src/modules/agents/tools/registry.test.ts`, `apps/api/tests/assignment-tools.integration.test.ts`

**Interfaces:**

- Consumes: Task 2 functions.
- Produces tools (all `feature: "agents"`, `deferLoading: true`): `assignment_propose` (P_proposal, editor/owner; returns an assignment card), `assignment_list` (R0_read; name, status, next run, month cost), `assignment_change` (P_proposal; pause/resume/time change, or content change → confirmation card), `run_status` (R0_read; today's runs, steps, deliverables, vetoes).

- [ ] **Step 1: Failing tests:** registry `offers assignment tools only with the agents feature`; integration (replayed model outputs like `package-tool-errors.integration.test.ts`): `proposes an assignment from chat and shows its card`, `pauses an assignment without a new confirmation`, `viewers get read tools only`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; keep the full tool-definition size check (`7000` bytes guard in registry tests) green by deferring the new tools.
- [ ] **Step 4:** Run tests → PASS.
- [ ] **Step 5:** Commit `feat: let Orbit Core propose and manage assignments`.

### Task 4: Runs, work plans and slot allocation

**Files:**

- Create: `apps/api/src/modules/agents/assignment-runs.ts`
- Modify: `apps/api/src/modules/lifecycle.ts` (`sweepProject`: call `planAssignmentRuns` when `agentsEnabled()`, skip `planAutopilot` then), `apps/api/src/modules/agents/scheduling.ts` (export the per-channel free-slot query used here)
- Test: `apps/api/tests/assignment-runs.integration.test.ts`

**Interfaces:**

- Produces: `planAssignmentRuns(tx, scope, now) => Promise<{ created: number }>`; run data `{ assignmentId, assignmentVersion, date /* local YYYY-MM-DD */, status: "planned"|"running"|"done"|"partial"|"failed"|"canceled", slots: { channel, at }[], steps: WorkStep[], costMicros }`; `WorkStep = { key, role: "analytics"|"research"|"strategy"|"copywriter"|"visual"|"review", dependsOn: string[], taskId: string|null, status, ceilingMicros }`; `buildWorkPlan(assignment) => WorkStep[]` (social: analytics, research, strategy, copywriter per channel, visual if `image`, review; report: analytics only; blog/newsletter: research, strategy, copywriter, review); `startReadySteps(tx, scope, runId)` enqueues `agent` jobs for steps whose dependencies are done.
- Run creation key `assignment:<id>:<date>`; a run is created at `firstSlot − leadMinutes` (weekly: the day before at the same local time).

- [ ] **Step 1: Failing tests:** `creates one run per due day, once`; `allocates one slot per channel across assignments` (two assignments, X at 10:00 → second gets next free slot or no slot and a `SLOT_UNAVAILABLE` note); `keeps local slot times across the DST change` (run dates 2026-10-24/26, Europe/Berlin, 10:00 local both days); `does not plan paused or budget_exhausted assignments`; `starts steps in dependency order`; `uses the assignment version at run start`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with the existing posting-slot helpers (`posting-slots.ts`) and `channelSlots`; slots of other runs and of scheduled publications count as taken.
- [ ] **Step 4:** Run → PASS; run `paid.integration.test.ts` autopilot cases to confirm they still pass with the flag off.
- [ ] **Step 5:** Commit `feat: plan assignment runs with work plans and shared slots`.

### Task 5: Specialist runner

**Files:**

- Modify: `packages/ai/src/index.ts` (add `respond`), `packages/ai/src/routing.ts` (task classes `agent_strategy`, `agent_research`, `agent_analytics`, `agent_review`; default output tokens 1800; legacy tier `standard`, review `quality`), `apps/worker/src/main.ts` (queue class `agent`, dispatch to `runAgentTask`), `apps/web/src/components/management.tsx` (route fields for the new task classes in the OpenAI dialog)
- Create: `apps/api/src/modules/agents/specialists/runner.ts`, `apps/api/src/modules/agents/specialists/types.ts`
- Test: `apps/api/tests/agent-runner.integration.test.ts`, `packages/ai/src/routing.test.ts`

**Interfaces:**

- Produces: `respond(params: { route: ModelRoute; instructions: string; input: unknown[]; tools: unknown[]; outputSchema?: object; reservationId: string; runtime: OpenAiRuntimeConfig; signal?: AbortSignal }) => Promise<{ output: unknown[]; usage: Usage; responseId: string | null }>` (non-streaming `responses.create`, `store: false`, `maxRetries: 0`, `text.format` json_schema when `outputSchema`).
- Produces: `Specialist = { role: WorkStep["role"]; taskClass: TaskClass; instructions: string; tools: OrbitTool[]; hostedTools: unknown[]; outputSchema: z.ZodObject; limits: { maxModelCalls; maxToolCalls; maxWebSearches; timeoutMs } }`; `registerSpecialist(s: Specialist)`; `runAgentTask(scope: Scope, taskId: string) => Promise<void>` — loads the task, starts an `AgentRun` (kind `"agent"`, agentName `orbit_<role>`), runs `legacyResponsesRuntime.runTurn` with a non-streaming `BudgetedModel` built on `respond` and a `ToolHost` over the role tools, parses the final output with `outputSchema`, stores it on the task (`status: "done"`, `output`), then calls `startReadySteps`.
- Produces: `agent_tasks` data `{ runId, stepKey, role, input, output, status: "queued"|"running"|"done"|"failed"|"outcome_unknown", errorCode, costMicros }`.
- `RunKind` in `telemetry.ts` += `"agent"`.

- [ ] **Step 1: Failing tests:** `runs one specialist turn and stores its structured output`; `reserves before and settles after every model call under the assignment run key`; `marks an interrupted paid call outcome_unknown and never repeats it`; `fails a task that exceeds its limits with AGENT_LIMIT and continues the run`; `stops the run when the assignment budget is exhausted` (next steps not enqueued, assignment `budget_exhausted`, exception `ASSIGNMENT_BUDGET_EXHAUSTED`); `refuses an output that does not match the schema with AGENT_OUTPUT_INVALID (cost settled)`; routing `resolves the agent task classes`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; a test specialist `echo` registered only in tests drives the runner.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: run specialist agents as bounded background tasks`.

### Task 6: Channel history from Postiz

**Files:**

- Modify: `packages/connectors/src/postiz.ts` (`remoteSchema`: text and media fields from Task 1)
- Create: `apps/api/src/modules/agents/channel-posts.ts`
- Modify: `apps/api/src/modules/generation.ts` (`recentChannelPosts` also reads `channel_posts`), `apps/api/src/modules/policy.ts` (duplicate check also against `channel_posts` texts of the same channel within 7 days)
- Test: `apps/api/tests/channel-posts.integration.test.ts`, `packages/connectors/src/connectors.test.ts`

**Interfaces:**

- Produces: `syncChannelPosts(scope, client = postizClientFor(scope), now) => Promise<{ stored: number }>` (60 days, upsert by remote ID, `source: "orbit"` when the remote ID matches an Orbit publication else `"external"`, at most hourly unless `force`); tool `channel_history` (R0_read, feature `agents`): last posts per channel with source and date.

- [ ] **Step 1: Failing tests:** `stores external and Orbit posts once per remote ID`; `skips a sync within the hour`; `refuses an Orbit draft identical to an external post of the same channel` (preflight `DUPLICATE_CONTENT`); connector `parses post text and media`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: keep a channel history from Postiz for agents and duplicate checks`.

### Task 7: Analytics and research specialists

**Files:**

- Create: `apps/api/src/modules/agents/specialists/analytics.ts`, `apps/api/src/modules/agents/specialists/research.ts`, `apps/api/src/modules/agents/tools/agent-tools.ts` (`metrics_summary`, `postiz_analytics`, `knowledge_search` reuse)
- Test: `apps/api/tests/specialists-analytics-research.integration.test.ts`

**Interfaces:**

- Analytics output schema: `{ period: { from, to }, findings: { statement: string, metric: string, value: number|null, freshness: string }[], noData: boolean }`. With no measurements: `noData: true`, `findings: []` (JC19).
- Research output schema: `{ findings: { claim: string, sourceUrl: string, sourceTitle: string, observedAt: string }[] }`; hosted tool `{ type: "web_search" }` counted against `maxWebSearches`; findings stored only on the task, never as facts or sources.

- [ ] **Step 1: Failing tests:** `reports noData honestly without measurements`; `summarizes Postiz and Matomo numbers with freshness`; `returns web findings with sources and stores no fact`; `stops at three web searches`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: add analytics and research agents`.

### Task 8: Strategy specialist

**Files:**

- Create: `apps/api/src/modules/agents/specialists/strategy.ts`
- Test: `apps/api/tests/specialist-strategy.integration.test.ts`

**Interfaces:**

- Input: assignment, analytics and research outputs, channel history (14 days), verified facts (keys and values).
- Output schema: `{ briefs: { channel: string, slotAt: string, topic: string, angle: string, factKeys: string[], cta: string, imageIdea: string|null, notARepeatBecause: string }[] }`; one brief per allocated slot; `factKeys` must exist as usable verified facts (validated after output; unknown keys → `AGENT_UNKNOWN_FACT`, brief dropped).

- [ ] **Step 1: Failing tests:** `writes one brief per slot with existing fact keys`; `drops a brief with an unknown fact key`; `passes the last 14 days of channel history to the model`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: add the strategy agent`.

### Task 9: Copywriter and visual in the run

**Files:**

- Create: `apps/api/src/modules/agents/specialists/copywriter.ts`, `apps/api/src/modules/agents/specialists/visual.ts`
- Modify: `apps/api/src/modules/generation.ts` (contract field `brief` for missions with `assignmentRunId`), `apps/api/src/modules/image-generation.ts` (internal entry for assignment images without the owner check; consent from the assignment confirmation; style references per Task 1)
- Test: `apps/api/tests/assignment-copy-visual.integration.test.ts`

**Interfaces:**

- Copywriter step: creates one draft-only mission per brief (`assignmentRunId`, `briefKey`, `factKeys`, `plannedSlotAt`, `budgetRunKey: assignment:<id>:<YYYY-MM>`) and runs `generateMissionLive`; output `{ contentIds: string[] }`. Revision: same mission path with `revisionOf` and the review's instructions.
- Blog and newsletter drafts are saved to Drive with the existing content export (`content-export.ts`, `google-drive.ts`) after review; they are never published.
- Visual step: one image per run from `imageIdea` + style references; asset `usageApproved: true`, `rightsSource: { assignmentId, confirmationHash }`; attached to every draft of the run whose channel allows media.

- [ ] **Step 1: Failing tests:** `saves an approved blog draft to Drive and publishes nothing`; `writes one draft per brief with the brief in the contract`; `generates one image and attaches it to the run's drafts`; `approves the image's rights only through the assignment consent`; `refuses an image without consent with ASSET_RIGHTS_REQUIRED`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: write and illustrate assignment posts`.

### Task 10: Review agent and agent review authority

**Files:**

- Create: `apps/api/src/modules/agents/specialists/review.ts`, `evals/agents/review-v1.json` (≥ 20 cases: 8 good, 12 bad — wrong number, profit promise, investment advice, disallowed link, off-brand tone, repeated post), `evals/agents/review.offline.test.ts`
- Modify: `apps/api/src/modules/policy.ts` (`checkClaims`/`preflight`: accept `agentReview` in place of `humanReviewedBodyHash` under the spec section 6 conditions)
- Test: `apps/api/tests/agent-review.integration.test.ts`

**Interfaces:**

- Review output schema: `{ decisions: { contentId: string, verdict: "approve"|"revise"|"reject", reasons: string[], revisionInstructions: string|null }[] }`.
- Produces on content: `agentReview: { taskId, assignmentId, assignmentVersion, bodyHash, checkedAt, deterministicProblems: string[] }`; `revise` → one copywriter revision step, then a second review; second non-approve → `reject`.
- Preflight accepts `agentReview` only if: assignment `active` and `assignmentVersion` equals the confirmed version; content type and channel inside the confirmation; project has an active Telegram connection; publication `vetoDeadline` passed without `vetoedAt`; `bodyHash` equals `hash(body)`; no deterministic problem.

- [ ] **Step 1: Failing tests:** `approves within a confirmed assignment and records the review`; `cannot clear a deterministic blocker`; `revises once, then rejects`; `refuses agent-approved content of an outdated assignment version`; `requires owner review when no Telegram bot is connected`; offline eval `rejects every bad case of review-v1` (recorded outputs).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: let the review agent approve inside confirmed assignments`.

### Task 11: Scheduling with the veto window

**Files:**

- Create: `apps/api/src/modules/agents/veto.ts`
- Modify: `apps/api/src/modules/workflow.ts` (`publishIntent` accepts `vetoDeadline`; `claimPublication` refuses agent-reviewed content before `vetoDeadline`), `apps/api/src/modules/agents/package-schedule.ts` (export `withdrawPublication`)
- Test: `apps/api/tests/assignment-veto.integration.test.ts`

**Interfaces:**

- Produces: `scheduleApproved(tx, scope, runId) => Promise<Entity[]>` (one publication per approved draft, `vetoDeadline = slot − vetoMinutes`, emits notification `preview` per publication); `vetoPublication(tx, scope, publicationId, version, source: "telegram"|"orbit", reason?) => { result: "vetoed"|"already_handed_over"|"not_found" }` (withdraw with reason `VETOED`; stores `reason` as a preference when given).

- [ ] **Step 1: Failing tests:** `schedules approved drafts with a veto deadline and a preview`; `moves a late deliverable so the veto window stays complete`; `withdraws a vetoed post before handoff`; `reports a post already handed over and changes nothing`; `does not hand over before the veto deadline`; `publishes after the deadline without a veto (test execution)`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: publish assignment posts after a veto window`.

### Task 12: Telegram bot connection and webhook

**Files:**

- Create: `packages/connectors/src/telegram.ts`, `apps/api/src/modules/telegram.ts`
- Modify: `apps/api/src/server.ts` (routes below), `packages/schemas/src/index.ts` (not in `collections`: the token entity stays private)
- Test: `packages/connectors/src/telegram.test.ts`, `apps/api/tests/telegram.integration.test.ts`

**Interfaces:**

- Connector: `createTelegramClient({ token, fetch? })` with `sendMessage(chatId, text, buttons?)`, `sendPhoto(chatId, bytes, caption, buttons?)`, `setWebhook(url, secretToken)`, `answerCallbackQuery(id, text)`; base `https://api.telegram.org/bot<token>/`; 10 s timeout; errors → `ConnectorError`.
- Entity `telegram_connections` (one per project): `{ encryptedToken, webhookSecretHash, chatId|null, linkCodeHash|null, linkCodeExpiresAt|null, linkedUserId|null, status: "pending"|"linked"|"disabled" }`; token encrypted with `CREDENTIAL_KEY`, never returned.
- Routes: `POST /api/projects/:projectId/telegram/connect` (owner; body `{ token }`; sets webhook; returns `{ linkCode, expiresAt }` (10 min)); `POST /api/projects/:projectId/telegram/disconnect` (owner); `GET /api/projects/:projectId/telegram` (owner; `{ status, linkedAt }`); `POST /api/telegram/:connectionId` (public webhook; `X-Telegram-Bot-Api-Secret-Token` must match; handles `/start <code>`, callback `stop:<token>`, `/pause` with confirm callback `pause:<token>`).
- Callback token: HMAC(`AUTH_SECRET`, `publicationId:version` or `pause:projectId:nonce`), base64url, ≤ 64 bytes (Telegram callback_data limit).

- [ ] **Step 1: Failing tests:** connector `sends text and photo with inline buttons`; integration `links the chat with a valid code only once and within 10 minutes`; `ignores updates with a wrong secret` (401, audited); `ignores a foreign chat`; `stops the shown post on Stop, idempotently`; `answers honestly when the post was already handed over`; `pauses the project only after confirmation`; `never returns the token`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: connect a private Orbit Telegram bot with Stop and pause`.

### Task 13: Notifications and daily report

**Files:**

- Create: `apps/api/src/modules/agents/notifications.ts`
- Modify: `apps/worker/src/main.ts` (queue class `telegram_notification`), `apps/api/src/modules/pause.ts` (notice on pause), `apps/api/src/modules/publisher.ts` (notice on Postiz failure)
- Test: `apps/api/tests/agent-notifications.integration.test.ts`

**Interfaces:**

- Produces: `notify(tx, scope, kind: "preview"|"rejected"|"budget_paused"|"postiz_error"|"project_paused"|"daily_report", ref: string)` enqueues `telegram_notification` (idempotency `notify:<kind>:<ref>`); `sendNotification(scope, jobId)` renders and sends; retries 3× with backoff on network errors; a failure opens exception `TELEGRAM_DELIVERY_FAILED` and never changes publishing rights.
- Daily report at the project's report time (default 20:00 local): published, vetoed, rejected, cost today/month, facts expiring within 7 days.

- [ ] **Step 1: Failing tests:** `sends one preview per publication with image and Stop`; `reports rejection, budget pause and project pause`; `retries a failed delivery and records TELEGRAM_DELIVERY_FAILED`; `sends one daily report with today's numbers`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: send previews, notices and a daily report through Telegram`.

### Task 14: Web UI — assignments, assignment card, Telegram, upcoming posts

**Files:**

- Create: `apps/web/src/components/assignments.tsx`, `apps/web/src/components/assignment-card.tsx`, `apps/web/src/components/telegram-connection.tsx`
- Modify: `apps/web/src/components/chat.tsx` (render assignment cards from chat detail), `apps/web/src/components/management.tsx` (settings tab "Aufträge", Telegram under connections), `apps/web/src/components/work.tsx` (approvals: "Anstehende Posts" with Stop via `vetoPublication`), `apps/api/src/modules/chat.ts` (conversation detail includes assignment cards)
- Test: `apps/web/src/components/assignments.test.tsx`, `apps/web/src/components/assignment-card.test.tsx`

**Interfaces:**

- Assignments page lists name, status, next run, month cost vs budget, actions pause/resume/end; edits go through chat or a confirmation card.
- Assignment card shows all confirmation fields and the image-rights consent checkbox; Confirm decides the `assignment.confirm` action request.
- Telegram panel: token field (password input, never prefilled), link code with expiry, status.

- [ ] **Step 1: Failing tests** (render helpers like `chat-package-card.test.tsx`): `shows status, next run and budget use`; `requires the consent checkbox for image assignments`; `never renders a token`.
- [ ] **Step 2–4:** FAIL → implement → PASS (`pnpm --dir apps/web typecheck`).
- [ ] **Step 5:** Commit `feat: manage assignments and the Telegram bot in Orbit`.

### Task 15: Replace the autopilot and document

**Files:**

- Modify: `apps/api/src/modules/autopilot.ts` (new `autopilotAsAssignment(tx, scope) => assignmentInput | null` proposal from saved settings), `apps/web/src/components/work.tsx`/`management.tsx` (hide autopilot UI when `ORBIT_AGENTS` is on; offer the migration card), `docs/adr/0005-agent-runtime.md` (addendum: specialists on the port), `docs/adr/0008-action-approvals.md` (assignment confirmation, agent review authority), `docs/plans/ORBIT_CORE_ROLLOUT_PLAN.md` (new phase "Orbit Agents" with approvals H–K: flag, Telegram bot, review eval spend, first autonomous post), `docs/IMPLEMENTATION_STATUS.md`, `docs/OPERATIONS.md` (Telegram webhook, queues `agent`, `telegram_notification`)
- Test: `apps/api/tests/autopilot-migration.integration.test.ts`

**Interfaces:**

- Consumes: Tasks 2–14.

- [ ] **Step 1: Failing tests:** `proposes the saved autopilot settings as a draft assignment`; `plans no autopilot missions while ORBIT_AGENTS is on`; `keeps the autopilot unchanged while ORBIT_AGENTS is off`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Full verification: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, `pnpm test:coolify-compose`, `pnpm secrets:check`.
- [ ] **Step 6:** Commit `feat: replace the autopilot with standing assignments` and `docs: record Orbit agents operations and rollout`.

---

## Delivery

Push and open one PR per milestone after Mario's go, flag off: Tasks 1–4 (assignments and runs), 5–8 (specialists), 9–11 (copy, visual, review, veto), 12–14 (Telegram, notifications, UI), 15 (replacement and docs). Then the joint test round from spec section 13.

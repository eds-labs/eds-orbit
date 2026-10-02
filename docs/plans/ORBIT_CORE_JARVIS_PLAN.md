# Orbit Core / Jarvis Mode — Repository Review and Migration Plan

**Prepared:** 2026-10-02  
**Repository:** `eds-labs/eds-orbit`  
**Inspected branch / commit:** `main` / `9c46b0d14bc4273afcb17dfb30aba3217a793b75`  
**Implementation handoff:** Claude Code  
**Reconciled:** 2026-10-02 against `9c46b0d` by Claude Code (section 15)  
**Status:** ACCEPTED by Mario on 2026-10-02 with the decisions in section 15.2; implementation in progress (section 16). Sections 1–14 are the original review and remain the design reference; where section 15 is more specific, it applies. No deployment, paid call or production authorization is implied.

## 1. Outcome, not another dashboard

Mario wants one visible assistant, usable through text and later voice. He describes the result he needs. Orbit obtains relevant project context, coordinates specialists, creates actual deliverables, checks them and returns a complete package. Mario should not have to assemble missions, select fact IDs, operate individual agents or move between forms for routine work.

Primary example:

> Prepare an X post and a Telegram post about uLiquid beta access, with one matching image. Use the approved project facts. Prepare everything now; do not publish.

The result must be two persisted, channel-specific drafts, one real persisted image when image generation was authorized, source references, review results and a combined preview in the conversation. A plan, a prompt, an empty campaign or a button linking to the manual editor is not completion.

Follow-up example:

> Make the X version shorter and more professional. Keep the image.

Orbit must revise that existing deliverable, preserve the image and unaffected Telegram version, and invalidate only approvals affected by the change.

**Recommendation:** retain Orbit's product and services. Add a goal-to-deliverable coordinator and an incremental Agents SDK adapter. Do not fork or embed an entire desktop Jarvis application. Do not rebuild working marketing, knowledge, publishing or cost-accounting systems.

## 2. What this review establishes

This is a targeted static architecture review using live GitHub reads pinned to the commit above. It inspected the chat runner, tool registry and implementations, proposal confirmation, generation, image generation, batch drafts, autopilot, workflow entrypoints, worker, chat UI, package manifest and relevant architecture/status documents. Some large files were read in relevant ranges rather than in full. The evidence index in section 14 records those limits.

No application tests, production browser test, paid provider call, database query or deployment was executed in this review. No repository file was modified. Historical test totals and production claims in repository documents are not newly verified results.

The inspected head includes PR #30, concerning saved model/image prices. The status document's statement that changes after `9979ad3` are documentation-only does not describe this newer head correctly. Treat deployment records as historical evidence; independently identify the deployed SHA before any release. Do not reinstall old price-age restrictions merely because an earlier plan mentioned dated rate cards.

### Findings and reuse decisions

| Area | Evidence at inspected commit | Migration decision |
| --- | --- | --- |
| Visible chat | `apps/web/src/components/chat.tsx` already contains conversations, streaming state, cards and proposal UI. Templates ask for missing fields and restrict execution. | Extend this UI; do not introduce a second chat application or replace the design system. |
| Main-agent behavior | `chat-runner.ts` explicitly prohibits creating missions, approving, publishing or calling providers; `propose_campaign` only saves a proposal. | The main gap is execution scope and orchestration, not a better system prompt. Replace these restrictions only through reviewed server capabilities, not by deleting safety text. |
| Agent runtime | The live code path is a custom Responses loop with six model-call and eight tool-call limits. Root dependencies contain `openai` 7.25.0, not `@openai/agents`. | SDK adoption is not already complete. Follow ADR 0005's port and spike rather than assuming a ready SDK manager exists. |
| Agent tools | Four read tools plus `propose_campaign`; strict schemas and role-filtered registration already exist. | Extend the registry. Do not recreate it. Add content history, package status and bounded work-request tools. |
| Proposal bridge | `confirmProposal()` validates a draft-only proposal, creates a mission and queues generation. It uses the mission start date as the earliest job date. | Reuse validation and evidence binding, but do not make every task stop at a manual proposal confirmation. Separate preparation time from publication slots. |
| Copy production | `generation.ts` has evidence retrieval, scoped mission validation, budget integration, persisted content reuse and channel rules. | Make this the copy specialist's executor. Keep single-shot generation instead of building another unconstrained copywriting loop. |
| Images | `generateProjectImage()` has a real provider path, brand constraints, owner and exact cost confirmation, storage and Drive integration. | Add a durable image work step and an authorization adapter. Do not let the model fabricate the existing confirmation booleans. |
| Existing batch helper | `draft-batch.ts` is a special owner-approved path, capped at five drafts and explicitly restricted to test execution, disabled external writes and Observe mode. | Do not remove its checks to make it a production orchestrator. Reuse invariants, not the special test-only entrypoint. |
| Weekly automation | `autopilot.ts` already creates per-channel/day missions, rotates configured facts and stores `plannedSlotAt` separately from a mission that can start now. | Preserve this scheduler. Reuse its timing pattern; add conversational goals and coherent campaign planning, not a second scheduler. |
| Execution infrastructure | `workflow.ts` creates durable jobs and outbox entries. The BullMQ worker handles chat, generation, publishing and other existing queues. | Reuse the worker and outbox. Persist business workflow state independently of an open browser or an SDK session. |
| Approvals | ADR 0008 already defines generic `ActionRequest`, risk classes and deterministic execution. | Implement/reuse that design incrementally. An accepted ADR is not proof all its tables/adapters exist: inspect the current schema first. |
| Safety and cost | The runner journals each model call, handles ambiguous transmitted outcomes and records telemetry. Existing generation and approval paths bind versions and evidence. | Preserve these mechanisms. Include all child tasks in a common package budget without losing per-call accounting. |

### The most important difference from the existing alignment plan

`docs/OPENAI_AGENT_PLATFORM_ALIGNMENT_PLAN.md` and ADRs 0005–0008 already cover runtime, tracing, model routing, tools and approvals. Several foundation phases are documented as implemented. This document adds the **user-facing product workflow**: one instruction must yield an actual, revisable content package.

Do not start the old plan again from phase zero. Reconcile its progress log against code and extend it with this outcome. If a selected architecture changes ADR 0005's topology, write an explicit follow-up ADR; do not silently supersede the accepted decision.

## 3. Architecture: one manager, bounded specialists, trusted executors

```text
Existing Orbit chat / future microphone
                  |
Authenticated API + automatic project-context resolver
                  |
Orbit Operator, the only visible conversational agent
                  |
AgentRuntime port: existing adapter / spike-approved SDK adapter
                  |
Typed tools -> persisted work package + bounded specialist steps
                  |
Existing PostgreSQL journal + outbox + BullMQ worker
                  |
Knowledge / copy generation / images / review / analytics
                  |
Version-bound ActionRequest + deterministic execution/preflight
                  |
Existing Drive / Postiz / publishing / reconciliation services
```

### Distinguish a specialist role from a separate autonomous agent

The requested experience does not require seven independent reasoning loops for every post. Start with these roles:

| Role | Initial implementation |
| --- | --- |
| Orbit Operator | Main reasoning agent; understands intent, resolves context, requests a plan, monitors persisted results and communicates with Mario. |
| Research | Optional bounded agent-as-tool for genuinely new external research. Internal knowledge retrieval remains an existing tool. No external research is needed for every draft. |
| Strategy / planning | Bounded structured planning capability that selects angles and deliverables using facts, history and measurements. A separate loop needs evaluation evidence before adoption. |
| Copy specialist | Existing single-shot generation service with a structured brief, channel constraints and evidence. |
| Visual specialist | Structured visual brief followed by the existing image/creative executors. Artwork and approved logo/text composition remain separate. |
| Analytics specialist | Existing scoped measurements and deterministic calculations; optional bounded explanation. Missing or stale data must be visible. |
| Review specialist | Existing deterministic rights, claim and policy checks, optionally followed by a bounded language/quality critique. A model critique cannot grant publishing authority. |
| Publisher | A deterministic executor, **not** an autonomous agent with account credentials. |

This stays compatible with ADR 0005's one operator plus at most one agent-as-tool specialist. Additional bounded generation jobs can implement specialist roles without an agent swarm.

The SDK supplies agent-loop, delegation and interruption primitives. Orbit must still implement the work package, usable context selection, policy-aware execution, assets, project memory, UI and operational recovery. SDK installation alone will not produce Jarvis behavior.

## 4. Automatic context instead of repeated forms

Before asking Mario a question, resolve current authorized context from Orbit:

- Selected project and authenticated actor; locale, timezone, campaign type and active marketing-profile version.
- Audience, content language, primary CTA, official destination and brand requirements.
- Current public/model-authorized facts and sources, validity dates, approved assets and usage rights.
- Connected channel identities **and separately** the channels/actions authorized by policy.
- Recent drafts, publications, reservations and planned slots; relevant analytics with their actual measurement period and freshness.
- Current route configuration, configured prices, remaining budget and action-specific readiness.
- The conversation's active work package, previous results and explicit user corrections.

Use a typed resolved-context record with provenance and version references. Defaults are project configuration, not fabricated facts or permissions. Derive a requested relative date using the project's timezone and server time. Display the resolved period in the result.

Only ask a blocking question when a missing choice materially affects the result or authority. Examples are conflicting official facts, an unspecified project when more than one is plausible, or missing authorization for paid work. Routine stylistic choices can use reversible defaults and be disclosed in the result. Never invent a budget, assert a roadmap feature is live or promote a generated statement to a Verified Fact.

Internal drafting readiness must remain independent of publishing readiness. Missing Postiz media verification must not prevent a permitted text draft. Any later publication still requires its full capability checks. Where current service contracts require connected/assigned channels even for drafts, document the exact limitation and introduce a narrow draft-target abstraction only with tests; do not fake integration IDs.

## 5. A durable work package, not a long-running chat request

Add the smallest persisted coordinator needed to associate an existing conversation with complete deliverables. Inspect the actual schema before creating tables, and reuse existing `ChatRun`, `AgentRun`, `ChatProposal`, mission, job, asset and content records where they already serve the purpose.

Suggested concepts, not mandated table names:

| Concept | Minimum information |
| --- | --- |
| Work package | Authenticated scope/actor, conversation, goal, revision, requested outputs, constraints, budget ceiling, policy/profile/runtime references and status. |
| Work step | Bounded capability, dependencies, immutable inputs/reference hash, idempotency key, existing job/run IDs, status and failure/reconciliation information. |
| Deliverable | Content/asset/mission IDs and versions, channel variant, review state and intended publication slot. Store references rather than duplicating authoritative content. |
| Decision | Existing/ADR-0008 action reference, exact reviewed payload, actor, expiry, resolved policy and one-use consumption. |

Suggested state vocabulary: `queued`, `running`, `waiting_approval`, `waiting_dependency`, `needs_reconciliation`, `partially_completed`, `completed`, `failed`, `canceled`. Map these deliberately to existing API/UI enums.

Use explicit bounded dependencies: context -> plan -> copy/image -> composition/review -> combined preview. Only independent steps should run concurrently, under an aggregate budget and concurrency limit. Do not hold database locks while waiting on model, image or external network responses.

### Reliability requirements

1. Queue submission, durable state and outbox linkage must be atomic where appropriate. Reuse the existing due-marker wakeup path; new jobs must not depend on waiting for a full project sweep.
2. Text turns may finish while a work package waits on a worker. Browser disconnect must not cancel authorized work. Reopening the conversation reconstructs state and deliverables from PostgreSQL.
3. Stable request/step idempotency prevents duplicate jobs from repeated messages, buttons, resumes and redeliveries. Never create a fresh paid image request to recover from a failed Drive save.
4. An ambiguous transmitted model/provider request is not an ordinary retry. Preserve `outcome_unknown` semantics and retained budget. Reconcile or request an explicit new authorized attempt, never silently replay.
5. Cancellation stops new steps and invalidates pending dispatch authorization. Report already transmitted or published effects honestly; cancellation is not a promise to undo them.
6. Revalidate actor membership/role, project scope, policy, evidence, rights and versions at execution. Do not treat a worker's infrastructure-level owner role as the user's authority.
7. A revision creates changed deliverable versions, reuses unaffected assets/results and invalidates dependent reviews/approvals. Only bounded, justified repair attempts are allowed.
8. Report partial success accurately. If text succeeds but a requested image fails, preserve the text and show the blocked image; do not mark the whole request complete.

### Prepare now, publish later

The current chat confirmation can queue generation no earlier than `mission.startAt`; generation also checks that window. Reusing that field directly for “next week's campaign” can delay draft preparation unnecessarily.

The existing autopilot already demonstrates a suitable pattern: creation can start now while `plannedSlotAt` holds a later publication time. Reuse or generalize that separation, retaining the publisher's no-early-send checks. Add timezone/DST tests and conflict detection against both autopilot slots and conversational packages. Never silently replace an existing scheduled post.

## 6. Approvals: remove friction, not authority

Use ADR 0008's existing risk classes and hard floors. Do not introduce a parallel incompatible permission model or change a project's current mode as a migration shortcut.

| Operation | Target handling |
| --- | --- |
| Authorized project reads and internal plan writes | No extra manual dialog. Any embedding/model cost still requires the existing paid-call mandate and journal. |
| Paid copy/planning/analysis | Execute only within an active applicable mandate, with package and per-call ceilings. No “approval required” loop for each ordinary step when authority already exists. |
| Image generation | Existing explicit confirmation by default; a versioned owner policy may delegate a bounded image allowance as ADR 0008 permits. Agent output is never evidence of consent. |
| Drive save / external non-public draft | Resolve separately from generation. Use approval or a specific applicable policy; do not infer permission merely from connected credentials. |
| Public scheduling/publishing | Bind exact content/asset versions, account, channel, time and policy. Execute through existing deterministic services after a valid decision/mandate. |
| Governance, permissions, budget increases, secrets, external deletion | Keep existing hard floors and UI-only/forbidden boundaries. Not part of conversational MVP. |

A single package preview may collect a user's decision for multiple **known, explicit** actions, but it must not be a vague blanket authorization. Distinguish permission to spend on generation from approval of the finished public content. Before the content exists, a planning approval is not an exact-content publishing approval.

New interactive packages can explicitly request draft-only behavior even when the project already has a working autopilot. Preserve the current `observe`/`assisted`/`autopilot` semantics and existing missions. Do not reset production modes or revoke existing policies by migration.

For the initial release, publishing remains a separate final decision unless an already valid, sufficiently specific mandate covers it. Unsupported providers remain unsupported; no success wording may conceal that.

## 7. SDK adoption without a rewrite

ADR 0005 already specifies the `AgentRuntime` port and go/no-go criteria. Implement or reuse that boundary, then compare the current adapter with an exactly pinned SDK candidate. Verify the candidate version, license, runtime compatibility and dependency audit at implementation time; do not copy old version/model recommendations from chat.

The SDK adapter must demonstrate:

- Reservation before every chargeable call, settlement afterward, no hidden client retries, and aggregate accounting across nested specialists, retrieval and images.
- No second paid request after an ambiguous transmitted outcome.
- Server-owned serialized run state, runtime/agent-graph version pinning, authenticated atomic approval consumption and replay protection.
- Mapping into existing Orbit telemetry with redaction; any provider trace export follows current approved configuration, not a new default.
- Equivalent or deliberately reviewed turn, tool, context-size, output-size, timeout and cancellation bounds.
- Measurable maintainability or capability benefit, and clean licensing/dependency evidence.

Add fake-provider/fault-injection tests. No real key or paid call is required to prove the state machine. If a critical criterion fails, retain the existing runtime adapter and proceed with the end-to-end work-package capability where safe. Do not build an unbounded replacement loop.

Feature flags and runtime selection must be snapshotted per run. Rollback applies to **new** runs. Never reinterpret an in-flight serialized SDK state with a different graph or blindly replay it through the legacy adapter.

Keep existing draft generation on its single-shot Responses path. Keep native Drive, existing knowledge retrieval and Postiz. Neither MCP exposure, ChatKit, an external desktop assistant nor a hosted agent service is a prerequisite for this migration.

## 8. Chat-first experience

Keep the current EDS Labs styling and components. Make the assistant the normal entrypoint after basic project selection/setup, while retaining the current administration views.

The conversation should show an actual package card: short goal, current status, channel previews, real image preview, review/blocker summary and actions such as revise, approve, cancel and inspect details. Cards must reference server-authorized resource IDs and current versions, not invented links from model text.

Show meaningful step progress from persisted execution events: research/context, drafts, image, review, ready. Do not display hidden reasoning, raw prompts, secrets or fabricated progress. Keep technical trace details in the existing observability view.

Reconnection should fetch a snapshot and continue from a sequence/cursor without duplicating messages. Avoid another global full-page polling loop per specialist. Keep the composer responsive and load later voice dependencies only when used.

Memory has three distinct layers: current conversation/work-package state, explicit user preferences, and authoritative project knowledge. A summary or generated marketing observation cannot silently become a verified product fact or broaden a permission. Version and scope preference changes, with a reversal path.

## 9. Voice is an interface to the same operator

Do not postpone the entire useful product until a full always-listening assistant exists.

First voice increment: push-to-talk, bounded transcription, visible transcript and submission into the same authenticated text/work-package path. Preserve text fallback. Audio permission, recording indicator and stop controls must be explicit. Audio calls need configured models, accounting and retention rules.

Second increment: Realtime speech-to-speech using the SDK's voice primitives and server-authorized delegation into Orbit Core. Keep long marketing jobs in the worker, not inside the voice connection. Use short-lived browser credentials where needed; standard provider keys and privileged tools stay server-side. Realtime dialogue history and the authoritative work-package state must be reconciled, not treated as automatically interchangeable.

No wake-word desktop shell, browser control, telephony or unrestricted computer access in this scope. Voice cannot bypass an action approval. The coding assistant is Claude Code; Orbit's runtime provider remains the existing OpenAI integration unless Mario explicitly changes that decision.

## 10. Delivery sequence and smallest useful release

| Stage | Deliverable | Exit gate |
| --- | --- | --- |
| J0 — Reconcile and design | Read current head, existing accepted plan/ADRs and schema. Record implemented vs missing pieces, runtime spike decision, affected files, tests and rollback. | Reviewable small plan; no duplicate framework, no unsupported assumptions about production. |
| J1 — One complete conversational package | Automatic context, persisted coordinator, bounded copy/image/review execution, combined preview, targeted follow-up revisions. Add only the approval adapters needed here. | One prompt produces two channel drafts and one authorized real image, without manual mission/fact/asset setup; test providers prove behavior locally. |
| J2 — Runtime adapter and hardening | Complete SDK spike/adoption when criteria pass; durable approval resume, fault tests, cost/identity boundaries and UI reconnect. The spike can start in J0 in parallel with design. | Existing safety/behavior tests plus all new failure/restart tests pass. Retain legacy adapter when required. |
| J3 — Conversational scheduling | Exact-package approval/mandate -> existing publisher; slot collision detection; existing autopilot preserved. | Mocked full publish/schedule/reconciliation path and separate, explicitly authorized production acceptance. |
| J4 — Voice and recurring goals | Push-to-talk first; Realtime later. Conversational recurring goals feed the existing scheduler after explicit configuration approval. | Same task state, authorization, budget and cancellation behavior through text and voice. |

**First useful release = J1 with the J2 safety prerequisites it actually needs.** Do not expose an unsafe shortcut while waiting for the SDK, and do not delay the user-visible workflow merely to complete optional SDK features. Split J1 into small implementation PRs, but do not declare the product outcome done after only adding a tool or a table.

Suggested code touchpoints:

- Existing `apps/api/src/modules/agents/tools/` for context/history/status and work-request tools.
- Existing `chat.ts` / `chat-runner.ts` for conversation linkage and a runtime adapter entrypoint, not another growing switch block.
- New small modules under `apps/api/src/modules/agents/` for context resolution, runtime port/adapters, work-package coordination and authorization adapters; choose exact names after inspecting current conventions.
- Existing `generation.ts`, `image-generation.ts`, `workflow.ts`, `autopilot.ts`, `policy.ts`, `budget.ts` and `telemetry.ts` through narrow service interfaces.
- Existing `apps/worker/src/main.ts` for bounded dispatch; new queue types only where necessary, with due-marker/outbox integration.
- Actual Prisma schema/migrations after inspection; additive changes and project-scope/RLS coverage, not a parallel database.
- Existing `apps/web/src/components/chat.tsx` with extracted package cards and later voice controls.
- Existing OpenAPI/client generation and test suites; extend current fixtures before creating a duplicate test harness.

## 11. Acceptance matrix

All entries start unchecked. A historical test report is not evidence for a new behavior.

| ID | Scenario | Required result |
| --- | --- | --- |
| JC01 | Known project, applicable budget, one request for X + Telegram + image | Two persisted drafts and one authorized generated asset; combined preview; no manual mission/fact-ID form. |
| JC02 | Missing nonessential stylistic detail | Uses a reversible project default; does not turn the request into a questionnaire. |
| JC03 | Missing/contradictory product fact | Clearly identifies the blocker and does not invent a feature or promote model text to Verified Fact. |
| JC04 | “Shorter X text, keep the image” | Correct existing content revised; unaffected Telegram/image preserved; affected approvals invalidated. |
| JC05 | “Next week” | Drafts prepared now; concrete project-local publication slots remain later; no early publishing. |
| JC06 | Close tab / reopen / worker restart | Same package resumes or reports a precise safe blocker; no duplicate jobs, paid calls or result messages. |
| JC07 | Double click / repeated client request / duplicate outbox delivery | Same idempotent action/result, not another image or post. |
| JC08 | Crash after provider transmission but before durable completion | Ambiguity retained; no blind replay or false success; budget not released as though unused. |
| JC09 | Cancel between steps | No new unauthorized dispatch; completed and in-flight effects reported accurately. |
| JC10 | Image generation fails or Drive save fails | Text preserved; partial status; Drive retry reuses the image and does not regenerate it. |
| JC11 | Malicious source/tool output requests publication or data leakage | Treated as untrusted content; no permission expansion or cross-project access. |
| JC12 | Policy/role/fact/asset/config changes during a run | Revalidation blocks affected work or requires a new applicable decision; no stale approval reuse. |
| JC13 | Mixed project IDs or revoked actor after queueing | No unauthorized read or side effect; worker credentials do not elevate the user's role. |
| JC14 | Package/subagent/embedding cost reaches limit | Aggregate and per-call limits hold; no fallback-model spending outside the mandate. |
| JC15 | Existing autopilot occupies a requested slot | Conflict shown; no silent replacement, duplicate publishing or bypass of combined channel/day quotas. |
| JC16 | Publish without exact decision or required provider capability | Blocked at trusted executor; draft generation remains available when separately authorized. |
| JC17 | SDK approval interrupt and restart | Server snapshot, same pinned graph and atomic one-use decision resume safely; no replay. |
| JC18 | Realtime/transcription permission denied or session lost | Text remains usable; worker state is unchanged; voice grants no additional authority. |
| JC19 | No current analytics measurements | Honest missing/freshness state; no invented success claim or fabricated performance recommendation. |
| JC20 | Legacy chat, existing autopilot and stored price configuration | Existing flows still work; migration does not reset modes, schedules, receipts or saved owner prices. |

Track task outcomes as well as safety: completed deliverables, unnecessary clarification turns, manual navigation, end-to-end failure rate, charged calls and budget consumption. Compare against a fixed small dataset containing the primary examples and adversarial cases. No unsupported percentage-improvement claims.

## 12. Test and release boundaries

Use the repository's pinned Node/pnpm versions and scripts, confirmed against the current checkout. The inspected manifest provides `lint`, `typecheck`, `test`, `test:e2e`, `eval:generation`, `build`, `api:generate`, `test:migration-profile`, `secrets:check`, `dependencies:inventory` and `framework:check`.

Run focused tests first, then the required broader gates in an isolated local/test environment. Database tests require an explicitly isolated database; do not run setup, migrations or seeding against production. Record exact commands, runtime versions, exit results, test counts and evidence paths. If dependencies or services are unavailable, record NOT RUN and the reason rather than copying earlier green totals.

Production deployment, production migrations, real provider writes, real paid model/image tests, secret changes and autopilot changes require separately scoped authorization. Never use a social publishing test to prove a draft-only feature. Do not activate a new provider or model as a side effect of the coding-tool switch.

Release behind a narrowly scoped feature flag, default off for existing deployments until accepted. Preserve the old conversation route and existing jobs. Rollback disables new package creation and routes **new** conversations/runs to the accepted adapter; it does not discard durable state, undo public posts or destructively roll back data. Pending ambiguous runs remain visible for reconciliation.

## 13. Progress ledger for Claude Code

Use this plan as the shared progress record. Keep documentation/comments in English and communicate with Mario in German. Do not automatically create an alternative framework just because repository guidance refers to Codex. Read `AGENTS.md` explicitly; preserve its rules. A minimal `CLAUDE.md` bridge is optional only when needed by the actual installed Claude Code version/configuration, without duplicating or weakening those rules.

| ID | Work item | Status | Evidence / files / commit |
| --- | --- | --- | --- |
| J0.1 | Refresh head and reconcile existing alignment progress | DONE | Section 15; head `9c46b0d` = `origin/main` |
| J0.2 | Inspect actual schema, permissions and deployed-version evidence | PARTIAL | Schema and permissions in section 15.1; deployed version not verified |
| J0.3 | Decide smallest J1 design and SDK spike scope | DONE | Sections 15.2–15.4 |
| J1.0 | Worker chat jobs run with the requesting user's current role (PR0) | DONE (local) | Section 16; `eb9470f` |
| J1.1 | Automatic scoped context and content-history access | DONE (local) | PR2 `60d0358`: server-filled context; content history deferred to PR3 |
| J1.2 | Durable package/step linkage and trusted work submission | DONE (local) | PR2 `60d0358` |
| J1.3 | Reuse copy generation and bounded image executor | DONE (local) | PR1 `e7224bc`, PR2 `60d0358`, PR3 `00e66f3` |
| J1.4 | Review + combined preview + targeted revision | DONE (local) | PR3 `00e66f3`, PR4 `b5bbb70` |
| J2.1 | Runtime port/spike with ADR-0005 evidence | TODO | S1 (port), S2 (spike) |
| J2.2 | Budget, role, restart, cancellation and approval tests | DONE (local) | PR0–PR5; JC06 real-Redis restart test |
| J3.1 | Exact-package conversational scheduling | TODO | |
| J3.2 | Autopilot coexistence and provider reconciliation | TODO | |
| J4.1 | Push-to-talk into the same operator | TODO | |
| J4.2 | Optional Realtime and recurring-goal interface | DEFERRED | |

For each completed slice append: date, base/head SHA, risk/environment, summary, changed files, checks actually run, remaining blockers and deployment/rollback effects. Mark a row DONE only with evidence. Record changes to the plan rather than quietly expanding scope.

## 14. Evidence index

All repository links below are pinned to the inspected commit. These are source-review references, not claims of successful execution.

- **R01 — Entrypoint and read order:** [AGENTS.md](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/AGENTS.md), read lines 1–220.
- **R02 — Current status and historical production claims:** [IMPLEMENTATION_STATUS.md](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/docs/IMPLEMENTATION_STATUS.md), requested lines 1–200.
- **R03 — Existing alignment proposal:** [OPENAI_AGENT_PLATFORM_ALIGNMENT_PLAN.md](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/docs/OPENAI_AGENT_PLATFORM_ALIGNMENT_PLAN.md), opening sections through the returned architecture section; large result was truncated. Claude must read its full current progress/decision sections.
- **R04 — Runtime decision:** [ADR 0005](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/docs/adr/0005-agent-runtime.md), complete.
- **R05 — Approval decision:** [ADR 0008](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/docs/adr/0008-action-approvals.md), complete.
- **R06 — Main runner:** [chat-runner.ts](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/apps/api/src/modules/chat-runner.ts), lines 1–160 and 200–405.
- **R07 — Registry:** [registry.ts](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/apps/api/src/modules/agents/tools/registry.ts), complete.
- **R08 — Read capabilities:** [read-tools.ts](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/apps/api/src/modules/agents/tools/read-tools.ts), complete.
- **R09 — Proposal capability:** [proposal-tools.ts](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/apps/api/src/modules/agents/tools/proposal-tools.ts), complete.
- **R10 — Conversation and confirmation:** [chat.ts](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/apps/api/src/modules/chat.ts), lines 1–180 and 400–640.
- **R11 — Copy executor:** [generation.ts](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/apps/api/src/modules/generation.ts), lines 1–210.
- **R12 — Image executor:** [image-generation.ts](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/apps/api/src/modules/image-generation.ts), lines 1–210.
- **R13 — Restricted batch helper:** [draft-batch.ts](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/apps/api/src/modules/draft-batch.ts), lines 1–215.
- **R14 — Existing autopilot and timing:** [autopilot.ts](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/apps/api/src/modules/autopilot.ts), lines 1–380, including `plannedSlotAt` and `approveAndSchedule`.
- **R15 — Job creation:** [workflow.ts](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/apps/api/src/modules/workflow.ts), lines 1–200.
- **R16 — Worker:** [apps/worker/src/main.ts](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/apps/worker/src/main.ts), lines 1–200.
- **R17 — UI:** [chat.tsx](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/apps/web/src/components/chat.tsx), lines 1–190.
- **R18 — Runtime/dependencies/commands:** [package.json](https://github.com/eds-labs/eds-orbit/blob/9c46b0d14bc4273afcb17dfb30aba3217a793b75/package.json), complete.

Official platform documentation checked on 2026-10-02; verify version-specific behavior during the spike:

- [OpenAI Agents SDK: manager / agents-as-tools](https://openai.github.io/openai-agents-js/guides/agents/).
- [OpenAI Agents SDK: approval interruptions, server-owned state and resume](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/).
- [OpenAI Agents SDK: models](https://openai.github.io/openai-agents-js/guides/models/).
- [OpenAI Agents SDK: voice overview](https://openai.github.io/openai-agents-js/guides/voice-agents/) and [Realtime transport](https://openai.github.io/openai-agents-js/guides/voice-agents/transport/).
- [Claude Code: project instructions, AGENTS.md and CLAUDE.md](https://code.claude.com/docs/en/memory).
- [Claude Code: common workflows](https://code.claude.com/docs/en/common-workflows).

**Bottom line:** preserve Orbit's existing machinery; replace the user's manual orchestration with a persistent, context-aware operator that delivers finished work. Measure success by the completed content package, not the number of agents installed.

## 15. Reconciliation against the current head (J0, 2026-10-02)

Reviewed by Claude Code at `9c46b0d` (= `origin/main`; no remote or local branch had unmerged commits). J0 was read-only: no tests, no dependency installation, no database or production access. `npm view @openai/agents` showed `0.18.0` as `latest` (MIT), which decision D1 of the alignment plan covers.

### 15.1 Findings that change or sharpen this plan

1. Confirmed: four `R0_read` tools plus `propose_campaign`; six model calls and eight tool calls per run; the system prompt forbids missions, approvals, publishing and provider calls.
2. `confirmProposal` queues the first draft at `max(now, mission.startAt)`, and generation refuses a mission whose `startAt` is in the future. The autopilot already separates creation (`startAt` = now) from the publication slot (`plannedSlotAt`).
3. Confirmed restrictions of `draft-batch.ts` (owner, test execution, external writes disabled, Observe, 2–5 drafts). It is not reused as an entrypoint.
4. ADR 0005–0008 are accepted, but `AgentRuntime`, `@openai/agents` and `ActionRequest` exist only in documents. Alignment Phase 3a (tool registry) is done; 3b and 3c are open.
5. PR #30 (`669a408`, merged as `9c46b0d`) changed code (saved prices no longer expire), while `IMPLEMENTATION_STATUS.md` still said later commits were documentation only. Whether `9c46b0d` is deployed was not verified.
6. Security: the worker ran every job with `{ userId: "worker", role: "owner" }` and only swapped the user ID for chat jobs. Role filtering of chat tools and the viewer check in `createProposal` never applied in the worker, and a user who had lost project access after queueing still got a chat run up to the model call. Fixed in J1.0 (PR0). Generation jobs still run with the worker scope; package and image jobs must use the actor scope from the start.
7. Missions, jobs, content, assets, approvals and policies are versioned `Entity` rows (`kind` is free text, FORCE RLS, `EntityVersion` history, due-marker triggers). New business objects can be new kinds without a migration. `work_packages` already records completed mission runs, so the package kind is `content_packages`.
8. The project sweep queues generation for every `ready` mission whose `startAt` has passed, and draft-only missions skip the autopilot review and publishing continuation. One draft-only mission per channel (`maxContents: 1`, as the autopilot does) reuses the guarded generation path unchanged.
9. Image generation runs synchronously inside the HTTP request and is owner only. Its idempotency is the reservation key `image:<requestId>`: a repeat fails with `RESERVATION_ALREADY_USED` instead of returning the asset. The reservation always stays `unknown`. A Drive failure never regenerates the image.
10. No model-backed revision exists. `PATCH /content/:id` versions the entity and invalidates approvals and publications; `adaptContent` needs human-written text.
11. Review applies the Telegram caption limit (1,024 characters) only when `assetId` is set; generation does not know that an image is planned.
12. `ChatRun.transmittedAt` is never cleared after a settled call, so a retried turn after a crash ends as `CHAT_OUTCOME_UNKNOWN` (fail-closed, no resume). This is acceptable for J1 because package work runs in jobs; revisit in J2.

### 15.2 Owner decisions (Mario, 2026-10-02)

- **D-J1:** A package starts with one explicit click on the package card, which shows channels, cost ceilings and the exact image prompt. This keeps the ADR 0008 default (creating missions from an agent proposal is `approval_required`). When an owner clicks, the same decision covers the image; otherwise the image waits for an owner. Zero-click text drafts would need an explicit owner policy relaxation to `auto_within_policy` and are not planned.
- **D-J2:** Alignment Phase 3b starts with an `ActionRequest` core stored as `Entity(kind="action_requests")`, without a migration. Its first consumers are package start and image generation instead of publication approvals; adapters for the existing approval flavours follow one by one. Phase 3c (SDK spike) is unchanged and may run in parallel.

### 15.3 Reversible assumptions

- At most two text revisions per package, inside the confirmed package ceiling. An image is never regenerated without a new decision.
- Package ceiling = sum of first-draft ceilings + image maximum + revision reserve, never above the policy's per-run budget. All paid calls of a package share the run key `package:<id>`.
- The feature flag `ORBIT_CONTENT_PACKAGES` (environment, default `false`) gates new package creation only; existing packages can still be read, advanced and canceled.
- A package snapshot is readable only from its own conversation; the missions and drafts it creates are project-visible like any other.

### 15.4 Smallest PR sequence for J1

| PR | Scope | Ledger | Main files | Key tests |
| --- | --- | --- | --- | --- |
| PR0 | Worker chat jobs run with the requesting user's current project role | J1.0 | `member-scope.ts`, `chat-runner.ts`, `auth.ts`, worker `main.ts` | Member scope; chat-runner worker-job cases; real-Redis worker |
| PR1 | `ActionRequest` core and worker image executor: `image` queue, idempotent per request, single attempt, unknown outcome without replay, Drive retry without regeneration | J1.3 | `action-requests.ts`, `image-generation.ts`, worker `main.ts` | Single use under concurrency; expiry; role per action type; duplicate dispatch; crash after transmission; Drive failure; owner demoted before execution |
| PR2 | Package request, one click, one draft-only mission per channel; server-filled context; tools `request_content_package` and `package_status`; shared run key and ceiling; `mediaPlanned`; optional `plannedSlotAt`; snapshot and confirm routes; minimal card; flag | J1.1–J1.3 | `agents/operator-context.ts`, `agents/content-packages.ts`, `agents/tools/package-tools.ts`, `generation.ts`, `budget.ts`, `lifecycle.ts`, `chat-runner.ts`, `server.ts`, `chat.tsx` | JC01 (text), JC03, JC05, JC07, JC12, JC14, JC20; no publication in an autopilot project; flag off |
| PR3 | Image step through PR1, deterministic review after each draft, partial status, cancel, complete card | J1.3, J1.4 | As PR2, package card component | JC01, JC06, JC09, JC10, JC11, JC13; Playwright card states |
| PR4 | Targeted revision as a draft-only revision mission (`revisionOf`), deliverable versions, invalidation | J1.4 | `content-packages.ts`, `generation.ts`, tools | JC04; ceiling; parent changed during revision |
| PR5 | Offline operator eval set, acceptance rows, documentation | J2.2 | `evals/operator/`, docs | All required gates |
| S1 | `AgentRuntime` port with the current loop as legacy adapter, no behaviour change | J2.1 | `agents/runtime/` | Existing chat-runner suite unchanged |
| S2 | Time-boxed SDK spike: `BudgetedModel` over Orbit's `streamChat`, G1–G7 evidence, merged only on go | J2.1 | Spike branch | Chat-runner suite for both adapters plus fault injection |

No J1 PR needs a database migration. Merging to `main` deploys through the Coolify webhook, so every merge is a production release that needs Mario's approval. The package flag stays off in production until a separate activation decision; one paid live acceptance run is a separate approval as well.

## 16. Progress log

### 2026-10-02 — J0 reconciliation (read-only)

- Base `9c46b0d` (= `origin/main`). Risk: low (read-only). Environment: local.
- Result: section 15. No tests run in J0, no dependency installed, no database or production access.
- Open: the deployed version of `main` was not verified (J0.2 partial).

### 2026-10-02 — J1.0 / PR0: worker chat jobs run with the requesting user's role (local)

- Base `9c46b0d`, code head `eb9470f` on branch `claude/orbit-core-pr0-actor-scope`. Risk: high (authorization in background jobs). Environment: local.
- Threat: a queued chat job ran with the worker's owner role, so a viewer was offered `propose_campaign` and a user who had lost project access still got a model run (up to the paid call when a model is configured). Fix: `runChatJob` re-reads the user's project access with the same rule as `scopeFor` (shared in `apps/api/src/modules/member-scope.ts`) and runs the turn with that role. Without access the run is closed as blocked with `ACTOR_MEMBERSHIP_REQUIRED` before any model call; an earlier transmission is still reported as `CHAT_OUTCOME_UNKNOWN` first. Owners see no change.
- Changed files: `apps/api/src/modules/member-scope.ts` (new), `apps/api/src/auth.ts`, `apps/api/src/modules/chat-runner.ts`, `apps/worker/src/main.ts`, `apps/api/tests/member-scope.integration.test.ts` (new), `apps/api/tests/chat-runner.integration.test.ts`, `apps/worker/tests/workflow.integration.test.ts`; documentation in a separate commit.
- Red before the fix: the new real-Redis worker case ended as `MODEL_CAPABILITY_NOT_VERIFIED` instead of `ACTOR_MEMBERSHIP_REQUIRED`; the API cases failed on the missing module and function.
- Checks on Node 24.18.0 against the local isolated PostgreSQL and Redis: focused suites 44/44 and real-Redis worker suite 2/2; `pnpm test` 586/586 in 59 files; `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm secrets:check` and `pnpm framework:check` pass. Not run: `pnpm test:e2e` (no UI change) and `pnpm api:generate` (no route change).
- Deployment and rollback: no migration and no configuration change. Merging to `main` deploys; rollback is a revert. Not pushed or merged yet.
- Follow-up: generation jobs created from a chat proposal still run with the worker scope (unchanged here).

### 2026-10-02 — J1.3 / PR1: action requests and worker image executor (local)

- Base `86c8d2b` (PR0 branch), code head `e7224bc` on branch `claude/orbit-core-pr1-action-requests`. Risk: high (approvals, paid image path, background job). Environment: local.
- Summary: `ActionRequest` core as `Entity(kind="action_requests")` with the first type `image.generate` (see the ADR 0008 addendum). Approval queues one single-attempt job in the new `image` queue; the worker runs it with the decider's current role and consumes the approval in the reservation transaction. Repeated dispatch returns the existing asset; a reservation without an asset ends as `IMAGE_OUTCOME_UNKNOWN` without a second provider call; a failed Drive save keeps the asset. `generateProjectImage` gains an optional `authorize` hook; the owner image route is unchanged. No HTTP route creates or decides requests yet.
- Changed files: `apps/api/src/modules/action-requests.ts` (new), `apps/api/src/modules/image-requests.ts` (new), `apps/api/src/modules/image-generation.ts`, `apps/worker/src/main.ts`, `apps/api/tests/action-requests.integration.test.ts` (new, 16 cases), `apps/worker/tests/workflow.integration.test.ts` (image queue case); ADR 0008 addendum.
- Red before the code: the API tests failed on the missing modules; the real-Redis worker case timed out because no worker served the `image` queue. Two mutations (no unknown-outcome guard; no existing-asset lookup) each made the matching tests fail.
- Checks on Node 24.18.0 against the local isolated PostgreSQL and Redis: new suite 16/16; real-Redis worker suite 3/3; `pnpm test` 603/603 in 60 files; `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm secrets:check` and Prettier pass. Not run: `pnpm test:e2e` and `pnpm api:generate` (no UI or route change). No provider call and no paid call were made.
- Deployment and rollback: no migration and no configuration change; nothing creates image requests until PR3. Rolling back after image requests exist leaves their outbox rows undispatched (the worker skips unknown topics); cancel pending requests first. Not pushed yet.
- Note: the image executor, like the existing owner image route, does not check `EXECUTION_MODE`; the gate is the owner's decision plus configuration and budget.

### 2026-10-02 — J1.1–J1.3 / PR2: content package from one chat request (local)

- Base `9fb5ed6` (PR1 branch), code head `60d0358` on branch `claude/orbit-core-pr2-content-packages`. Risk: high (agent tool that leads to paid drafts, new decision route). Environment: local; behind `ORBIT_CONTENT_PACKAGES` (default `false`).
- Summary: tools `request_content_package` (proposal, editor/owner) and `package_status` (read), offered only with the flag. `apps/api/src/modules/agents/content-packages.ts` builds a deterministic plan per channel with `validateDraftMission` (extracted unchanged from `createProposal`) and records a `content_package.start` action request. The requesting user's click (`POST /api/projects/:projectId/action-requests/:id/decide`) rebuilds the plan, compares hashes and creates one ready draft-only mission and generation job per channel, starting now; `plannedSlotAt` only records an intended project-local slot. Package calls share run key `package:<id>`; generation applies the per-draft ceiling to package missions. Package state is derived from the action request, jobs and drafts; the chat shows a package card.
- Changed files: `apps/api/src/modules/agents/content-packages.ts` (new), `apps/api/src/modules/agents/tools/package-tools.ts` (new), `apps/api/src/modules/action-requests.ts`, `apps/api/src/modules/agents/tools/{index,registry}.ts`, `apps/api/src/modules/chat.ts`, `apps/api/src/modules/chat-runner.ts`, `apps/api/src/modules/generation.ts`, `apps/api/src/server.ts`, `packages/config/src/index.ts`, `apps/web/src/components/chat-package-card.tsx` (new), `apps/web/src/components/chat.tsx`, `apps/web/src/app/globals.css`, generated OpenAPI/client; tests in `content-packages.integration.test.ts` (new, 11 cases), `paid.integration.test.ts` (2), `chat-runner.integration.test.ts` (1), `chat.integration.test.ts` (1), `registry.test.ts` (1), `chat.spec.ts` (1 Playwright case); docs.
- Acceptance covered locally: JC01 text part (two persisted channel drafts from one request and one click, no mission form), JC02 (profile defaults), JC03 (missing, expired and conflicting facts block), JC05 (prepare now, later project-local slot, draft-only), JC07 (repeated click), JC12 (changed fact makes the start stale), JC14 (shared run key and per-draft ceiling), JC20 (existing chat suites and proposals unchanged).
- Red before the code: the new API cases failed on the missing module, tools, run key and ceiling.
- Checks on Node 24.18.0 against the local isolated PostgreSQL and Redis: `pnpm test` 619/619 in 61 files; `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm secrets:check`, `pnpm framework:check`, `pnpm api:generate` (contract updated) and Prettier pass. Not run locally: `pnpm test:e2e`, because the local development database is already set up and has no synthetic browser account; the new Playwright case runs in CI's browser acceptance.
- Deployment and rollback: no migration. Production stays unchanged until `ORBIT_CONTENT_PACKAGES=true` is set, which is a separate activation decision. Rollback: flag off (started packages finish as ordinary draft-only missions), or revert.
- Open: image step, deterministic review in the package, cancel and partial-failure handling (PR3); targeted revision (PR4).

### 2026-10-02 — J1.3/J1.4 / PR3: package image, review, cancel and partial results (local)

- Base `e47f44a` (PR2 branch), code head `00e66f3` on branch `claude/orbit-core-pr3-package-image-review`. Risk: high (paid image path inside an agent-started package, cancellation of queued work). Environment: local; behind `ORBIT_CONTENT_PACKAGES`.
- Summary: optional `imageBrief` on `request_content_package` (owners only; editors get `IMAGE_OWNER_REQUIRED` because there is no owner approvals inbox for an editor's private package yet; deviation from section 15.2, which let the image wait for an owner). The plan binds the brief to the current image model and ceiling; the image maximum is part of the package ceiling. The owner's start click approves the `image.generate` request, which runs through the PR1 worker executor with run key `package:<id>`. Missions with a planned image use media channel limits (`missionHasMedia`), so Telegram text fits the 1,024-character caption. The project sweep reviews package drafts with `reviewContent` (safe: `publishIntent` is only reached by explicit owner actions or missions that allow publishing). The snapshot derives the image state from request, job, reservation and asset, shows the review per channel, recognises drafts an identical earlier mission reused, and reports partial results. Cancel (`POST …/chat/packages/:id/cancel`, requester only) withdraws decisions, cancels queued jobs and archives undrafted missions. The card shows image, review and a cancel button.
- Changed files: `apps/api/src/modules/agents/content-packages.ts`, `apps/api/src/modules/agents/tools/package-tools.ts`, `apps/api/src/modules/action-requests.ts` (`cancelActionRequest`), `apps/api/src/modules/image-generation.ts` (run key option, `budgetRunKey` in the payload), `apps/api/src/modules/image-requests.ts`, `apps/api/src/modules/generation.ts` (`missionHasMedia`), `apps/api/src/modules/lifecycle.ts`, `apps/api/src/modules/mission-archive.ts` (`markMissionArchived`), `apps/api/src/server.ts`, web card and styles, generated OpenAPI/client; tests: 6 new package cases, 1 route case, 2 Playwright cases.
- Acceptance covered locally: JC01 complete with fake providers (two reviewed drafts and one generated image in one result, one image call, image reservation under the package run key), JC09 (cancel before and after start), JC10 (text kept on image failure; the PR1 Drive case), JC13 (editor cannot add an image; executor revalidates the owner), plus the earlier PR2 rows.
- Red before the code: the new package cases failed on the unknown `imageBrief` field and missing functions. Found while making them pass: a deterministic test draft can reuse an identical earlier draft (`lastContentId`), which the package now reports as reused instead of "queued". The small cancel-route HTTP test was written after the route.
- Checks on Node 24.18.0 against the local isolated PostgreSQL and Redis: `pnpm test` 626/626 in 61 files; `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm secrets:check`, `pnpm framework:check`, `pnpm api:generate` and Prettier pass. Not run locally: `pnpm test:e2e` (same reason as PR2; CI runs the two Playwright cases).
- Deployment and rollback: no migration; flag-gated. Cancel pending packages before reverting code that removes the `image` queue.
- Open: targeted revision (PR4); owner approvals inbox for editors' images; content history in the operator context.
- CI finding on PR2 (#34): browser acceptance failed in the existing Postiz test at sign-in. better-auth allows three sign-ins per 10 seconds; the short new package card test made the Postiz test the fourth sign-in in one window. Fixed in `e47f44a` (PR2 branch) with one shared sign-in helper in `chat.spec.ts` that waits out the window once on HTTP 429; the limit itself is unchanged. PR3 is rebased on it.

### 2026-10-02 — J1.4 / PR4: targeted revision (local)

- Base `fa923d1` (PR3 branch), code head `b5bbb70` on branch `claude/orbit-core-pr4-targeted-revision`. Risk: high (agent tool that queues a paid draft under an existing decision; change to the draft prompt). Environment: local; behind `ORBIT_CONTENT_PACKAGES`.
- Summary: tool `revise_package_deliverable` (`W0_internal`, editor/owner). A revision is a draft-only mission with `revisionOf` (draft id, version, instruction), validated against current facts and profile, under the package run key and per-draft ceiling. Plans reserve two revisions at the largest draft ceiling inside the confirmed ceiling, so no new click is needed; a third revision, a second one on a channel still being revised and one above the remaining ceiling are refused. Generation adds `revision` (instruction, previous body) to the contract only for such missions and refuses to send if the draft changed since the request (contract build and pre-transmission check). The draft prompt gained one sentence that a revision changes only what is asked and never authorizes new claims. The sweep marks the replaced draft `supersededBy`, invalidates its approvals and publications and reviews the new draft. The card shows revising states and the revision count.
- Changed files: `apps/api/src/modules/agents/content-packages.ts`, `apps/api/src/modules/agents/tools/package-tools.ts`, `apps/api/src/modules/generation.ts`, `packages/ai/src/index.ts` (one prompt sentence), `apps/api/src/modules/chat-runner.ts` (one operator sentence), web card; tests: 5 revision cases (text model mocked), updated ceiling, tool-list and Playwright assertions.
- Acceptance covered locally with a mocked text model: JC04 (shorter X: one text call with the previous body and instruction, new X draft, Telegram draft and the image unchanged, no new image request, the old X draft superseded and its approval blocked), plus revision limits, ownership and the changed-draft case.
- Red/green evidence: the new cases failed on the missing function. Removing only the contract-time version check left the changed-draft case green (the pre-transmission check still caught it); removing both made it fail.
- Checks on Node 24.18.0 against the local isolated PostgreSQL and Redis: `pnpm test` 631/631 in 61 files (including the offline generation eval with the extended prompt); `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm secrets:check`, `pnpm framework:check`, `pnpm api:generate` (no contract change) and Prettier pass. Not run locally: `pnpm test:e2e` (CI runs it).
- Deployment and rollback: no migration; flag-gated. The prompt sentence applies to every draft but only acts when a contract contains `revision`.
- With PR0–PR4 the J1 milestone (one request -> two channel drafts + one authorized image -> review -> preview -> targeted revision, without manual mission setup) is covered locally with fake providers. It is not verified against a live provider; that needs the separately approved paid acceptance run.

### 2026-10-02 — J2.2 / PR5: operator evals and acceptance rows (local)

- Base `2e6f50e` (PR4 branch), branch `claude/orbit-core-pr5-acceptance`. Risk: low (tests and documentation; one test fixture moved). Environment: local.
- Summary: `evals/operator/` adds seven fixed cases (JC01, JC02, JC03, JC05, JC11, JC13, JC20) that replay recorded model steps through the real chat runner, tools, package services and database and check only server outcomes; they run in `pnpm test`. The content package fixture moved to `apps/api/tests/support/package-project.ts` and is shared by the package tests and the evals. `REQUIREMENTS_TRACEABILITY.md` gains rows JC01–JC20 (14 PASS_TEST, 6 NOT_RUN); `IMPLEMENTATION_STATUS.md` summarizes the Orbit Core state.
- Evidence: the cases passed on the existing code; two mutations (request tool offered to viewers; no policy channel check) each made the matching case fail (JC13, JC11).
- Open: JC06 (worker restart in the middle of a package), J3 scheduling (JC15, JC16), J4 voice (JC18), analytics freshness (JC19), an owner approvals inbox for editors' images, content history in the operator context, and the paid live acceptance run.

### 2026-10-02 — J2.2 / JC06: package across a worker crash and restart (local)

- Base `644dae1` (PR5 branch), branch `claude/orbit-core-jc06-restart`. Risk: low (test only). Environment: local, real Redis worker in test execution mode.
- Test `apps/worker/tests/content-package-restart.integration.test.ts`: a two-channel package is started; one draft job is left as if its worker had died (running, expired lease, outbox dispatched). A fresh worker finishes the package with reviewed drafts, one draft and one job per channel, the crashed job retried once and no reservation. A hard kill and restart change nothing; reopening the conversation rebuilds the same result from PostgreSQL.
- Evidence: passed on the existing code; mutations "no lease recovery" (timeout) and "re-review on every sweep" (draft versions change after restart) both failed it. `pnpm test` 639/639 in 63 files; lint and typecheck pass.
- Traceability: JC06 now PASS_TEST (15 PASS_TEST, 5 NOT_RUN).

### 2026-10-02 — Owner approvals inbox for package images (local)

- Base `68d6729` (JC06 branch), code head `045ff27` on branch `claude/orbit-core-owner-inbox`. Risk: medium (approval routing; no new paid path). Environment: local; behind `ORBIT_CONTENT_PACKAGES` for packages.
- Summary: resolves the PR3 deviation from section 15.2. Editors may request a package image; their start click starts the drafts and leaves the `image.generate` request pending. `GET /api/projects/:projectId/action-requests` (owners only) lists pending, unexpired owner decisions with prompt, model, ceiling, requester, expiry and package goal; owners decide through the existing decide route. Rejected and expired images report `IMAGE_REJECTED` and `IMAGE_APPROVAL_EXPIRED`; the drafts stay and the package is partly ready. The approvals page shows the inbox.
- Tests: three new package cases (owner approves from the inbox and the package completes; rejection; expiry) that replace the earlier editor refusal case, one route case (viewer 403, owner 200) and one Playwright case (stubbed inbox, approve). The API cases failed before the change (editor refused; no route).
- Checks on Node 24.18.0: `pnpm test` 642/642 in 63 files; `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm secrets:check`, `pnpm framework:check` and `pnpm api:generate` pass. Not run locally: `pnpm test:e2e` (CI runs it).

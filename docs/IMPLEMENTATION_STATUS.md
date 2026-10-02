# Implementation status

## Current state and agent platform alignment (2026-10-02)

Orbit is deployed in production via Coolify. The latest documented release is `9979ad3` (2026-10-02, PR #26 Postiz queue watch, on top of `c8cfeec` with PRs #23 and #24 and `434ea4e` with PR #22); later commits on `main` are documentation only, except PR #30 (`669a408`, merged as `9c46b0d`), which keeps saved text and image prices valid until the owner changes them. Whether `9c46b0d` is deployed was not verified in the 2026-10-02 Orbit Core review. A read-only check on 2026-10-02 found `/api/health/ready` ok and the new `/api/health/postiz` answering 200, so the queue watch is running in production. Production runs `EXECUTION_MODE=live` with `ENABLE_EXTERNAL_WRITES=true`. The uLiquid project is in `autopilot` mode: Telegram uLiquid Desk and X uLiquid are write- and media-verified, the active policy allows one post per channel and day until 2026-12-31T23:00Z, and the weekly plan runs Sundays at 12:00 from 2026-10-05 (`docs/ORBIT_ULIQUID_PRODUCTION_GOAL.md`, Progress Log 2026-10-02). Postiz write verification now reads Drive-only PNGs before taking the project lock (PR #24). Statements below such as "no production deployment" or "local uncommitted change set" describe their own earlier checkpoints and are historical.

Mario accepted the [OpenAI agent platform alignment plan](OPENAI_AGENT_PLATFORM_ALIGNMENT_PLAN.md) with decisions D1–D4. Phase 0 (local, no production change):

- ADRs [0005 agent runtime](adr/0005-agent-runtime.md), [0006 agent state and data retention](adr/0006-agent-state-and-data-retention.md), [0007 tool registry](adr/0007-tool-registry.md) and [0008 action approvals](adr/0008-action-approvals.md).
- `openai` npm package 7.17.0 → 7.25.0, no code changes required.
- Cost baseline from settled production receipts: [agent-platform-baseline-2026-09-30](evidence/agent-platform-baseline-2026-09-30.md).
- Known local issue: the real-Redis worker lifecycle test times out in local environments with a large accumulated test database; it fails identically before the upgrade.
- Phase 1 (observability and cost foundation; released to production on 2026-10-01 as `dce2ad4`, see the plan §17): cache-aware cost settlement with rate card v2, additive `AgentRun`/`AgentSpan` telemetry tables and budget attribution (migration `202609300001_agent_telemetry`), editor/owner endpoints `agent-runs` and `ai-cost`, and structured redacted API request logging with `LOG_LEVEL`. 429/430 tests pass; the failure is the known worker lifecycle test above. The migration was applied by the release.
- Phase 2 (model routing v2 and generation evals; released to production on 2026-10-01 as `cb23603` together with PR #14, see the plan §17): configurable task-class routes `chat_operator`, `draft_social`, `draft_blog` with model, optional reasoning effort and output ceiling, owner-editable in the OpenAI configuration dialog, with the legacy tier as default (no behaviour change without a saved route). Route version recorded on every `AgentRun` (migration `202610010001_agent_run_route_version`, additive); a configuration save during a run stops it fail-closed. Known cost of unusable model output is settled (`MODEL_OUTPUT_NOT_VALID`). Offline generation eval harness on the real generation and review path, and a manual live eval runner capped at $5 with a dry run and a confirmation that binds dataset, prices and ceiling. The live eval has not been run. See `MODEL_ROUTING.md`, `OPERATIONS.md` and the plan §17. After merging `main` with PR #14 (worker queue pump), 519/519 tests pass, including the worker lifecycle test.
- Phase 3a (released 2026-10-01 with PR #22 as `434ea4e`): chat tools are declared in a registry and sent with strict schemas generated from zod; viewers are no longer offered `propose_campaign`. See the plan §17.
- Drive reconnect readiness (PR #23, released 2026-10-02 in `c8cfeec`): on 2026-10-01 production `GET /api/projects/:id/google-drive/health` returned `GOOGLE_DRIVE_OAUTH_FAILED` while readiness still reported `drive_save: ready`. A refresh rejected by Google (HTTP 400/401/403) is now recorded on the `drive_connection` record as `lastRefreshFailedAt`/`lastRefreshErrorCode` and cleared by the next successful refresh or a reconnect. Readiness reads only this recorded state, never Google. `drive_save` reports `GOOGLE_DRIVE_RECONNECT_REQUIRED`; `postiz_schedule`, `postiz_live` and the global blockers (which gate live autopilot policy activation) report it when enabled autopilot settings or a running mission reference a Drive-only asset. No schema migration. See `integrations/google-drive.md`.
- Worker queue pump (PR #14, released 2026-10-01): projects are processed only when their `workDueAt` marker is due. Follow-up fix (local): a pass now claims the marker with a 60-second lease first, so work written while a project is being processed is no longer delayed by up to five minutes (lost wakeup seen once in CI as a test publication stuck in `intent_created`). See `OPERATIONS.md`.
- Orbit Core / Jarvis Mode (accepted 2026-10-02, [plan](plans/ORBIT_CORE_JARVIS_PLAN.md); local, not released). One chat request becomes a content package: one draft-only mission per channel and an optional owner-approved image, started with one click, reviewed with the existing claim checks, shown as one card, cancelable, and revisable per channel. Slices: PR0 worker chat jobs run with the requesting user's current role (`ACTOR_MEMBERSHIP_REQUIRED` otherwise); PR1 `ActionRequest` core (`Entity(kind="action_requests")`) and a single-attempt worker image executor; PR2 package request, plan and one-click start; PR3 image, review, cancel and partial results; PR4 targeted revision; S1 `AgentRuntime` port with the legacy loop; S2 Agents SDK spike, no-go (ADR 0005 addendum); PR5 operator evals (`evals/operator/`) and acceptance rows JC01–JC20 (15 PASS_TEST, 5 NOT_RUN, fake providers only; JC06 covered by a real-Redis worker crash and restart test). Everything new is behind `ORBIT_CONTENT_PACKAGES` (default `false`) except PR0. No migration. Not yet: merges to `main`, the production flag, and a paid live acceptance run; each needs its own approval.
- Postiz queue watch (released 2026-10-02 with PR #26 as `9979ad3`): after a hung Postiz orchestrator left scheduled posts in `QUEUE` for a day unnoticed, the worker checks the assigned channels every 10 minutes, opens a self-closing `POSTIZ_QUEUE_STALLED` exception for posts more than 15 minutes overdue, and exposes `GET /api/health/postiz` (503 when stalled) for Uptime Kuma. See `OPERATIONS.md`.

## Index activation control (2026-09-25)

Index Management offers activation after an index generation reaches `evaluated`, while a `building` generation offers only build and evaluation actions. The server still checks the current corpus and live evaluation at activation time. A browser regression covers both UI states and opens the confirmation dialog without submitting a production change.

## Orbit Chat v1 local implementation (2026-09-25)

The new private project chat, bounded Responses tool runner, reviewable draft-only proposals, and first-draft job bridge are implemented locally. See `docs/ORBIT_CHAT_V1.md` for API contracts and release boundaries. This checkpoint is not production authorization or proof of a live paid model call.
Local verification on Node 24.18.0: additive migration on a disposable database, API/client generation, lint, typecheck, 298 tests across 24 files, production build, 7 authenticated Chromium workflows, framework check, secret scan and high-severity dependency audit passed. A real Responses stream, remote CI run, production migration and deployment remain outside this checkpoint.

Checkpoint refreshed: 2026-09-22, Europe/Berlin. The integrated application and both isolated Linux hosting variants have local acceptance evidence; this is not production authorization.

## Configuration-parity checkpoint (2026-09-18)

The historical acceptance summary below proves the prior backend and UI scope only. It must not be read as proof that the uLiquid marketing-profile workflow was available end to end.

- Implemented locally: versioned owner-only marketing profiles, immutable profile history, product/presale campaign typing, profile-bound content validation, profile-change invalidation, approved-asset status, and campaign-aware publication preflight.
- Preserved: existing facts, sources, assets, preferences, missions and content are not rewritten by the migration. Legacy human-authored content remains visible but is blocked from publication until an owner explicitly links it to a profile-bound mission.
- Verified in the 2026-09-22 refresh: the authenticated browser flow configures and versions the profile, binds mission/content to it and inspects the draft. `test:migration-profile` applies all forward migrations to a uniquely named disposable local database, preserves seeded legacy rows and verifies forced RLS before dropping only that database.
- Still not claimed: external Telegram/provider capability proof. No provider write was attempted.

See `docs/CONFIGURATION_PARITY.md` for the acceptance matrix and the distinct external gates.

## Brand kit and image-generation checkpoint (2026-09-19)

- Implemented locally: project visual identity (bounded colors, local font presets, design rules and selected approved logo), owner-only PNG/JPEG/WebP asset upload, metadata-stripping PNG normalization, project-scoped protected previews, asset rights/status audit, and deterministic brand-aware creative composition.
- Added the optional OpenAI GPT Image 2.5 path with Flare as default and Sunburst selectable. The Settings UI can retain the shared OpenAI key or save a separate encrypted image key later; neither key is returned after saving.
- Safety boundaries: model allowlist, dated non-zero per-image ceiling, active policy, atomic budget reservation, exact per-request prompt/cost confirmation, rate limit, no generated logo/copy, normalized output, provenance, and separate approval before use.
- Focused local verification covers brand schema bounds, raster normalization/MIME rejection, response byte redaction, image configuration and explicit confirmation, prompt constraints and brand-aware rendering. The prior synthetic PDF failure was traced to an unsupported Node 20 shell; the project requires Node 24 and now includes `.nvmrc` pinned to 24.18.0. On that supported runtime the PDF test and complete 280-test suite pass.
- The authenticated browser flow now uploads and approves a real PNG, binds it to the versioned brand profile, reaches and verifies the exact paid-generation confirmation without dispatch, cancels it, and renders a local approved-asset composition.
- No real provider API key was created or stored. The browser test used only a synthetic local test value, made no paid image request, and performed no production deployment or migration.

## Current verified state

- Framework 1.1.0 missing-only merge; actual archive mismatch documented. Full schema/YAML validation:0 errors/0 warnings;12 framework tests passed. Narrow restore-source/evidence filename exceptions retain duplicate-file checks.
- Pinned Node 24.18/Next 16.3.6/React 19.3/TS 6.0.3/Fastify 5.12.5/Prisma 7.10/PostgreSQL 17/pgvector 0.8.6/BullMQ 6.3.6/Redis 7.4.7 application. Restricted app/auth DB roles and forced RLS verified.
- **280 tests across 20 files passed** on Node 24.18.0, including the synthetic PDF parser case, knowledge/parser/index coverage, mocked-paid/real-journal race tests, actual auth, Matomo normalization/import, signed Slack approvals, Postiz observed proof, community adaptation, source revocation, shared budgets, DST/concurrency and real Redis worker restart.
- **5/5 current authenticated browser workflows passed** against the local development stack in 30.6s on installed Chrome, including the new marketing-profile and brand/image acceptance path. Historical production-build evidence remains 4/4 in 22.7s; the current production build passes separately. No provider write or paid model call occurred.
- Latest production Next build, whole-project/web TypeScript, lint/source checks and generated API/client succeeded. Dependency audit:0 high/moderate/low/critical after two narrow overrides;406 installed dependency/license records. Source and generated-public-artifact secret scans passed.
- Real isolated pg_dump/pg_restore passed with tombstones, source rights, audit and unknown publication state; restored projects are paused/Observe and no publisher starts.
- Both fresh Linux ARM64 container variants passed migrations/grants, real restricted roles, HTTPS auth/Origin checks, non-root/read-only operation, cgroup CPU/RAM/PID enforcement and four branded PNG formats. Shared-host services publish no host ports. Worker outage detection, recovery and graceful exit passed. Evidence: `docs/evidence/container-acceptance.json`.

## Integrated functionality

Authenticated multi-project roles; guided capability setup; public/model rights; manual/file/allowlisted website/GitBook ingestion; structured verified facts/conflicts; exact-filtered hybrid retrieval; evidence inspectors; separate immutable index builds/evals/activation/rollback; bounded mission work packages, reusable content and measured follow-up; Social/Blog/Newsletter/Ads/Script drafts and portable exports; original-brand PNG rendering; reviewed-parent channel adaptations; authorized private community grouping/linkage; calendar blackout rules; exact-package approvals and test/live-gated publishing; Matomo/CSV metrics, experiments and reversible memory rules; signed one-use Slack decisions; persistent exceptions/outbox/jobs, real worker heartbeat and owner lifecycle controls.

Default writes remain off. Live readiness reads current database evaluation provenance/config/corpus/settled receipts, not an environment assertion. Postiz capability is bound to tested account, connector version, publisher instance and separate media proof. Its group-wide delete is not exposed because current remote group membership cannot be proven. Blog/mail/ads/community live providers remain capability-specific gaps; their authorized drafts/imports/exports work.

## Integration corrections completed

Paid cost settlement survives revoked results; reservations cannot transmit twice; query+text share a run ceiling. Restart reuses committed generated content before review without another model call. Saved schedules cannot send early. All safety history remains visible beyond 500 UI rows. Approval binds connector/account/asset/evidence/policy. Source or model-right changes quarantine in-flight work. Parser ZIP/PDF/DNS bounds, terminal retries, source-revocation terminal receipts, and runtime credential generation were regressed.

The earlier 253-test run exposed that malformed follow-up data could abort a global queue sweep. The worker now isolates each project; missing follow-up content produces a visible blocked mission. A real Redis test includes the broken dependency alongside a valid autonomous cycle and passes in the current 280-test suite.

## Acceptance outcome

All 88 controlling-master acceptance IDs remain mapped: **79 PASS_TEST, 3 PASS_LIVE (read-only VPS observations), 6 BLOCKED_EXTERNAL, 0 NOT_RUN**. The two supplemental matrices now total **14 PASS_TEST, 2 BLOCKED_EXTERNAL, 0 NOT_RUN** after closing CP06, CP07 and BI08. The original external criteria remain A05, A14, A17, H07, H08 and K08; supplemental CP08 and BI07 also require external authorization/evidence.

The two dedicated container acceptance stacks were stopped while retaining their volumes. This refresh also stops its local development server after browser verification. No production host changed. The Docker image is ARM64; AMD64 and sustained production capacity/IO guarantees require target-specific verification if selected.

## External gates and authority

No application OpenAI credential or approved paid test budget: genuine structured output/semantic embedding evaluation remains blocked. Actual Postiz/Slack/Matomo account capability tests, identified blog/CMS/mail/ads providers, off-host backup/key escrow, independent alert delivery, production domain/host mandate and code/brand publication rights need explicit configuration/authorization. Provider access inside Codex is not application credentials.

No production host mutation, deployment/migration, DNS/firewall change, real social/mail/ad message, training/backtest or purchase occurred. The local RC source was pushed to the private `EDS-Labs/eds-orbit` repository. Existing VPS inventory was read-only; current measurements, missing contract costs and partial history are separately documented. Missing internal verification is never classified as a provider/permission blocker.

## Handoff

Read `README.md`, `ACCEPTANCE_REPORT.md`, `RELEASE_READINESS.md` and `LIVE_ACTIVATION_CHECKLIST.md`. `docs/evidence/source-manifest.json` identifies the currently tested local source set; `docs/evidence/container-acceptance.json` identifies the previously tested Linux image. The 2026-09-22 acceptance refresh is a local uncommitted change set based on `main` at `28f363e`; it has not been pushed or deployed. Runtime credentials remain local and ignored. Synthetic local login material is kept only in ignored `.runtime/e2e-user.json`; runtime credentials are not embedded in source or public evidence.

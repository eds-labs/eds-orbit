# Implementation status

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
- Pinned Node 24.18/Next 16.3.5/React 19.3/TS 6.0.3/Fastify 5.12.5/Prisma 7.10/PostgreSQL 17/pgvector 0.8.6/BullMQ 6.3.6/Redis 7.4.7 application. Restricted app/auth DB roles and forced RLS verified.
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

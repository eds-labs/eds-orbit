# Implementation status

Checkpoint: 2026-09-17, 15:39 Europe/Berlin. Integrated application and both isolated Linux hosting variants passed local acceptance; this is not production authorization.

## Configuration-parity checkpoint (2026-09-18)

The historical acceptance summary below proves the prior backend and UI scope only. It must not be read as proof that the uLiquid marketing-profile workflow was available end to end.

- Implemented locally: versioned owner-only marketing profiles, immutable profile history, product/presale campaign typing, profile-bound content validation, profile-change invalidation, approved-asset status, and campaign-aware publication preflight.
- Preserved: existing facts, sources, assets, preferences, missions and content are not rewritten by the migration. Legacy human-authored content remains visible but is blocked from publication until an owner explicitly links it to a profile-bound mission.
- Verified in this checkpoint: generated Prisma client and whole-project TypeScript checks; focused contract tests cover profile and campaign payload bounds.
- Not yet claimed: a full browser acceptance run for the new configuration flow, an applied local database migration against a disposable database, or external provider capability proof.

See `docs/CONFIGURATION_PARITY.md` for the acceptance matrix and the distinct external gates.

## Current verified state

- Framework 1.1.0 missing-only merge; actual archive mismatch documented. Full schema/YAML validation:0 errors/0 warnings;12 framework tests passed. Narrow restore-source/evidence filename exceptions retain duplicate-file checks.
- Pinned Node 24.18/Next 16.3.5/React 19.3/TS 6.0.3/Fastify 5.12.5/Prisma 7.10/PostgreSQL 17/pgvector 0.8.6/BullMQ 6.3.6/Redis 7.4.7 application. Restricted app/auth DB roles and forced RLS verified.
- **253 tests across 18 files passed** in 18.81s, including 142 knowledge/parser/index tests,14 mocked-paid/real-journal race tests, actual auth, Matomo normalization/import, signed Slack approvals, Postiz observed proof, community adaptation, source revocation, shared budgets, DST/concurrency and real Redis worker restart.
- **4/4 actual browser workflows passed** in 25.4s on development and 22.7s on the final production build, on installed Chrome, desktop and 390px mobile. Seven retained screenshots and visual comparison. No mocked browser API.
- Latest production Next build, whole-project/web TypeScript, lint/source checks and generated API/client succeeded. Dependency audit:0 high/moderate/low/critical after two narrow overrides;406 installed dependency/license records. Source and generated-public-artifact secret scans passed.
- Real isolated pg_dump/pg_restore passed with tombstones, source rights, audit and unknown publication state; restored projects are paused/Observe and no publisher starts.
- Both fresh Linux ARM64 container variants passed migrations/grants, real restricted roles, HTTPS auth/Origin checks, non-root/read-only operation, cgroup CPU/RAM/PID enforcement and four branded PNG formats. Shared-host services publish no host ports. Worker outage detection, recovery and graceful exit passed. Evidence: `docs/evidence/container-acceptance.json`.

## Integrated functionality

Authenticated multi-project roles; guided capability setup; public/model rights; manual/file/allowlisted website/GitBook ingestion; structured verified facts/conflicts; exact-filtered hybrid retrieval; evidence inspectors; separate immutable index builds/evals/activation/rollback; bounded mission work packages, reusable content and measured follow-up; Social/Blog/Newsletter/Ads/Script drafts and portable exports; original-brand PNG rendering; reviewed-parent channel adaptations; authorized private community grouping/linkage; calendar blackout rules; exact-package approvals and test/live-gated publishing; Matomo/CSV metrics, experiments and reversible memory rules; signed one-use Slack decisions; persistent exceptions/outbox/jobs, real worker heartbeat and owner lifecycle controls.

Default writes remain off. Live readiness reads current database evaluation provenance/config/corpus/settled receipts, not an environment assertion. Postiz capability is bound to tested account, connector version, publisher instance and separate media proof. Its group-wide delete is not exposed because current remote group membership cannot be proven. Blog/mail/ads/community live providers remain capability-specific gaps; their authorized drafts/imports/exports work.

## Integration corrections completed

Paid cost settlement survives revoked results; reservations cannot transmit twice; query+text share a run ceiling. Restart reuses committed generated content before review without another model call. Saved schedules cannot send early. All safety history remains visible beyond 500 UI rows. Approval binds connector/account/asset/evidence/policy. Source or model-right changes quarantine in-flight work. Parser ZIP/PDF/DNS bounds, terminal retries, source-revocation terminal receipts, and runtime credential generation were regressed.

The last 253-test run exposed that malformed follow-up data could abort a global queue sweep. The worker now isolates each project; missing follow-up content produces a visible blocked mission. A real Redis test includes the broken dependency alongside a valid autonomous cycle and passed; the full253 suite subsequently passed.

## Acceptance outcome

All 88 acceptance IDs are mapped: **79 PASS_TEST, 3 PASS_LIVE (read-only VPS observations), 6 BLOCKED_EXTERNAL, 0 NOT_RUN**. Application code, generated contracts, tests, container evidence and final reports are integrated. The remaining external criteria are A05, A14, A17, H07, H08 and K08.

The local production preview remains at http://localhost:4310. The two dedicated container acceptance stacks were stopped while retaining their volumes. No production host changed. The Docker image is ARM64; AMD64 and sustained production capacity/IO guarantees require target-specific verification if selected.

## External gates and authority

No application OpenAI credential or approved paid test budget: genuine structured output/semantic embedding evaluation remains blocked. Actual Postiz/Slack/Matomo account capability tests, identified blog/CMS/mail/ads providers, off-host backup/key escrow, independent alert delivery, production domain/host mandate and code/brand publication rights need explicit configuration/authorization. Provider access inside Codex is not application credentials.

No production host mutation, deployment/migration, DNS/firewall change, real social/mail/ad message, training/backtest or purchase occurred. The local RC source was pushed to the private `EDS-Labs/eds-orbit` repository. Existing VPS inventory was read-only; current measurements, missing contract costs and partial history are separately documented. Missing internal verification is never classified as a provider/permission blocker.

## Handoff

Read `README.md`, `ACCEPTANCE_REPORT.md`, `RELEASE_READINESS.md` and `LIVE_ACTIVATION_CHECKLIST.md`. `docs/evidence/source-manifest.json` identifies the local source set; `docs/evidence/container-acceptance.json` identifies the actual tested Linux image. Repository contents are committed on `main` and pushed privately to `EDS-Labs/eds-orbit`; runtime credentials remain local and ignored. Synthetic local login material is kept only in ignored `.runtime/e2e-user.json`; runtime credentials are not embedded in source or public evidence.

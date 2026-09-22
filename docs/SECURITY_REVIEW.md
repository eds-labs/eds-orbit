# Security Review

Checkpoint refreshed: 2026-09-22. **Identified source findings corrected; current local regression and recorded Linux container variants passed. No production security PASS or live-provider acceptance is asserted.**

The review covered authentication/project authorization, approval packages, model egress/accounting, worker replay, connector network boundaries, untrusted document parsing, and deployment behavior. The latest complete suite passed **280/280 tests across 20 files** on Node 24.18.0. Five current authenticated browser scenarios passed locally; the recorded production-build browser run remains 4/4. Both fresh isolated Linux ARM64 installations passed migration, role isolation, authenticated HTTPS, runtime isolation and PNG checks for their recorded image. Current evidence: `docs/evidence/vitest-results.json` and `docs/evidence/playwright-results.json`; historical production/container evidence remains in `docs/evidence/browser-tests.log` and `docs/evidence/container-acceptance.json`.

These are bounded implementation and local acceptance results. External provider HTTP was injected in integration tests; Slack's dedicated approval tests explicitly simulate only the semantic quality-gate dependency. No live Postiz/Slack write, paid model call, production migration, DNS change or existing-service operation was performed.

## Source findings and disposition

All findings below were corrected and inspected. The evidence column identifies the applicable local suites; it does not imply exhaustive attack coverage or real-provider verification.

| ID | Priority | Concrete finding | Corrected behavior and evidence |
| --- | --- | --- | --- |
| SR-01 | P1 | Successful paid calls could lose their charge when subsequent dependency validation rolled back the transaction, permitting reservation reuse. | Transmission claims and usage settlement are durable before attachment; reused/in-flight/unknown reservations cannot authorize another call. Real PostgreSQL paid-race and safety suites passed. |
| SR-02 | P1 | Omitting `scheduledAt` could publish immediately despite a future approved schedule. | Omission inherits the saved schedule; early dispatch is refused. Explicit SR02 safety regression passed. |
| SR-03 | P1 | Internal `list()` silently capped safety/idempotency history at 500 rows. | Internal safety queries no longer truncate. Replay of the oldest key beyond 500 jobs passed. History-scale performance remains unmeasured. |
| SR-04 | P1 | Approval did not bind the selected Postiz connector. | Connector ID/version/base URL and account are bound to approval and rechecked at handoff. Connector changes and current authorization are covered by SQL safety/provider-proof suites. |
| SR-05 | P1 | Embedding attachment used the wrong document/vector contract and lacked fresh handoff checks after a paid call. | Typed source/chunk/vector attachment and fresh source/project/policy/mandate checks; invalidated output is quarantined while cost persists. Paid integration suite passed. |
| SR-06 | P1 | DOCX preflight trusted an underreported ZIP count despite the downstream parser scanning extra entries. | Exact directory/count/end bounds, duplicate/ZIP64/ambiguous-name rejection, local-header consistency and bounded actual inflate precede parsing. Parser regressions passed. |
| SR-07 | P2 | Terminal worker actions threw ordinary errors and could be retried by BullMQ. | Terminal claim states and `UnrecoverableError` prevent resend; transient attempts remain bounded. Worker and unknown-outcome suites passed. |
| SR-08 | P2 | An expired approval could be reused for an unchanged package. | Reuse requires an unexpired approval; consumed/stale approval remains unusable. Source reviewed and complete policy/approval suites passed. |
| SR-09 | P2 | Remote pending status could overwrite a local cancellation requirement; invalidation used an unconsumed queue shape. | Cancellation/reconciliation intent is retained and recognized durable reconciliation jobs are emitted. Knowledge/worker/provider tests passed; no cancellation write is inferred from a read. |
| SR-10 | P2 | DNS was outside fetch deadlines and robots wildcards used potentially expensive regex backtracking. | Bounded cancellable DNS, all-answer validation, pinned isolated HTTPS agents and wildcard step budgets. Hung-DNS/native callback/adversarial robots regressions passed. |
| SR-11 | P2 | PNG output was missing and absent logo approval implicitly succeeded. | Explicit approval is required; fixed escaped templates produce bounded PNGs with the original logo checksum. Host tests and all four Linux formats passed, including visual inspection and dimensions. |
| SR-12 | P2 | Asset/link fields were approved but the publisher sent text only. | Exact PNG upload receipts persist; fresh checks repeat before posting and the approved link is included. Exact-byte and changed-media-during-upload SQL regressions passed. |
| SR-13 | P2 | Article export omitted its portable metadata/assets; CSV analytics could mix currencies/accounts/timezones. | Complete bundle export and explicit analysis dimensions; connector/editorial/analytics suites passed. No CMS publish adapter is asserted. |
| SR-14 | P2 | PDF extraction ran in-process without a hard wall-clock/decompressed-memory boundary. | Fixed credential-free child process, input/page/output/V8 limits and kill deadline. Parser regressions passed; container memory/PID limits were verified. Native memory still relies on those limits. |
| SR-15 | P2 | A broken follow-up in one project could abort the entire global worker pump. | Missing dependencies block that mission visibly; per-project failure isolation/throttling allows other projects to progress. The focused real-worker test and current 280-test suite pass after this correction. |

Live index activation now also requires an evaluated baseline checkpoint, current corpus/rights/model/profile binding and exact project/index/dataset usage receipts. Source review and knowledge/paid suites cover the corrected fencing. Synthetic transport tests do not provide a live semantic-quality certificate.

The missing supported Postiz write-verification transition is implemented as an owner-approved fixed sandbox package, a durable single transmission, and separate observation of the exact remote ID/account in published state. Proof binds the instance/account, with a distinct media allowlist. Eight real-PostgreSQL/injected-HTTP tests passed. Whole-group deletion remains unsupported because the documented status contract cannot establish complete current group membership.

## Deployment findings and actual verification

| ID | Issue | Final local disposition |
| --- | --- | --- |
| DEP-01 | Root Next binary path was not supplied by the workspace dependency layout. | Correct package-local binary; actual production web container boot passed in both variants. |
| DEP-02 | API origin variable/build-time rewrite did not provide the intended container routing. | Runtime proxy uses `ORBIT_API_ORIGIN`; actual HTTPS setup/login/session/logout through web → API passed in both variants. |
| DEP-03 | No known raster font or writable fontconfig cache on read-only root. | Installed DejaVu/fontconfig; `XDG_CACHE_HOME=/tmp/orbit-cache`. All four Linux PNG formats passed with zero renderer stderr; saved images were visually inspected. |
| DEP-04 | No complete production-shaped dedicated-role migration/bootstrap path. | Both fresh local databases ran the maintenance entry point, forward migrations, least-privilege grants and real-role isolation checks. Production execution remains unauthorized/unperformed. |
| DEP-05 | Non-root/read-only/resource settings had only been inspected statically. | UID 1000, actual rejected root write, health, Docker limits and cgroup CPU/memory/PID values verified. API/web: 1 CPU/768 MiB/180 PIDs each; worker: 2 CPUs/1536 MiB/180 PIDs. |
| DEP-06 | Shared proxy/network isolation had not been exercised. | Only web and the separate test proxy joined the external network. API/web/worker/DB/Redis had no shared-variant published ports. Proxy could not resolve API/DB/Redis; database/frontend networks were internal. |
| DEP-07 | Caddy's file capability caused `EPERM` with every capability dropped. | Proxy retains only `NET_BIND_SERVICE` in its capability bounding set; actual TLS boot passed. App containers continue to drop all capabilities. |

The tested image is Linux ARM64 `sha256:e86ed404b50794cf7e4fdbb7471bb20c79f19c07fc516ed24ec4817bcc4e1a2f`. Frozen install, Prisma generation and production Next build passed in Linux. Default runtime gates were observed as test mode, external writes false and no model key.

A bounded run of 40 API liveness reads at concurrency eight returned only HTTP 200 (p95 10 ms, maximum 23 ms). The worker became unhealthy about 71 seconds after its own Redis stopped and recovered in the same container about 30 seconds after Redis restarted; graceful worker termination returned exit code zero. This does not establish sustained workload capacity or an I/O guarantee. Queue policy bounds concurrency, attempts and outbox batches and stops adding when waiting count exceeds 200; actual worker regression evidence is separate from the liveness read measurement.

## Supporting checks and remaining boundaries

- The owned connector/native HTTPS/creative/Slack/Postiz-proof collection passed 50/50 tests across six files. Complete TypeScript and production web builds passed.
- Framework/schema/YAML validation passed with zero errors/warnings; framework self-tests passed 12/12. The bounded repository secret-pattern scan passed; runtime/dependency directories and unrecognized secret formats are outside that scan.
- The refreshed dependency audit reports zero findings in every severity category after narrow deepmerge-ts/mysql2 overrides. Linux Prisma/migration and application boot provide additional compatibility evidence; see `DEPENDENCY_RISKS.md`.
- The isolated backup/restore drill preserved audit events, a source tombstone, an uncertain publication and an active-index configuration, with zero publishers/external writes. See `BACKUP_RESTORE_TEST_RESULT.json`; this is not production disaster-recovery acceptance.
- Real installed Postiz/Slack/Matomo behavior, approved paid-model evaluations, model/embedding quality and actual production permission/credential configuration remain external acceptance gates.
- AMD64 builds, production TLS/DNS/firewall, production load/IO/noisy-neighbor capacity, production restore and remote CI execution were not tested. An egress network name is not a destination firewall.

No cross-project bypass was identified in the reviewed scoped paths; local role/RLS negative tests passed. This does not certify absence of every authorization defect. Existing Desk, Forecast, Postiz, Matomo and Chatwoot infrastructure stayed unchanged. Both temporary container projects were shut down after testing while preserving their test volumes; the primary local development stack remains separate.

## Primary implementation references

[Mammoth ZIP reader](https://raw.githubusercontent.com/mwilliamson/mammoth.js/master/lib/zipfile.js), [JSZip central-directory reader](https://raw.githubusercontent.com/Stuk/jszip/main/lib/zipEntries.js), [Sharp output API](https://sharp.pixelplumbing.com/api-output/), [Sharp installation requirements](https://sharp.pixelplumbing.com/install/), [Postiz group deletion](https://docs.postiz.com/public-api/posts/delete), and [Postiz status listing](https://docs.postiz.com/public-api/posts/list).

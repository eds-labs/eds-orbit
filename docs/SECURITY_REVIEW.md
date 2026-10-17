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
| SR-16 | P2 | Rate limits were global: the web proxy forwarded no client address and the API keyed on the web container's IP, so 100 writes and 20 sign-ins per minute were shared by all users, and Better Auth fell back to one shared bucket (F-02). | The proxy forwards the right-most `X-Forwarded-For` hop as `X-Orbit-Client-IP`; the API believes it only from a loopback/private peer, keys all Fastify limits on it and pins it as Better Auth's only IP header. Sessions still store no address. `apps/api/tests/client-ip.integration.test.ts` and the proxy route test cover separate buckets, direct-call spoofing and Better Auth. See OPERATIONS.md, "Client addresses and rate limits". |
| SR-17 | P3 | Role checks were scattered over route booleans, two hard-coded owner lists in the action and collection routes and about 45 inline comparisons with three different error codes, so a new route or action could silently get the wrong level (modularization WP1.5). | One permission catalogue: `platform/tenancy/permissions.ts` defines project read, write and own levels plus one key per action and owner-only collection, declared by the owning module and checked once for uniqueness by the module registry. `scopeFor`, the action dispatcher, the collection route, the approval deciders, the chat tools and 40 inline checks use `authorize()` with their previous error codes. Behaviour is unchanged: the route-by-role access matrix (`apps/api/tests/access-matrix.integration.test.ts`) is identical; a test requires every dispatched action to declare exactly one permission. Checks that combine the role with other facts stay as they were: Telegram actor checks, the Slack user mapping, Postiz verification and assignment, assignment time changes, package scheduling by requester, workspace-level project creation and pause. |

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

## Module-level roles (WP4.5, prepared 2026-10-17; review done 2026-10-17)

`ORBIT_MODULE_ROLES` stays `false` in production until Mario approves the flag. An independent adversarial review ran on 2026-10-17. It found four holes in platform entry points outside the original list (MR-1 to MR-4). All four are fixed with tests in the review PR. **The flag can go on once that PR is merged and deployed, not before.**

Each item is marked **pass** (held under attack, with a test) or **fix** (a hole was found and fixed).

1. **Every module entry point uses the member's role in that module.**
   - **pass:** routes (`scopeFor`, marked by the route group); every marketing and knowledge project route calls `scopeFor`. The Slack interaction route maps only owners.
   - **pass:** actions and collections (by owner).
   - **pass:** assistant tools (offer and execution per tool owner).
   - **pass:** prompt fragments and conversation sections (`visibleModules`).
   - **pass:** the shell (`GET /modules` access).
   - **pass:** platform files. Upload, download and delete use the role in the file's stored module (new test in `files.integration.test.ts`).
   - **pass:** public module API. A public session is a project viewer, never a member, so module roles do not apply.
   - **fix (MR-1):** action request decisions.
   - **fix (MR-2, MR-3):** the export and the dashboard.
   - **fix (MR-4):** the member's notification list.

   Tests: `module-roles.integration.test.ts`, `module-roles-assistant.integration.test.ts`, `files.integration.test.ts`, `notifications.integration.test.ts`.
2. **No escalation.** **pass** for all of:
   - Only owners set overrides. An editor gets `403`.
   - Owners never get an override. A project owner gets `409 OWNER_HAS_NO_MODULE_ROLES`, and a workspace owner without a membership row gets `404`.
   - Rows stored before a promotion to owner are ignored (new test).
   - An override can raise a viewer to editor in one module (S-R6), never to owner. The input enum and the database check both refuse `owner`.
   - A forged tool call runs with the owner module's role. It is refused when that role is `none`.
   - Nothing is cached across members or requests:
     - membership and module roles are read on every request;
     - Better Auth's cookie cache is off;
     - the registry holds no per-member state.
3. **Data.** **pass.**
   - `ProjectMemberModuleRole` is a tenancy table: RLS project scope, `orbit_auth` only, no grant to `orbit_app` (RLS matrix, `db-deploy` grants).
   - Rows cascade with the membership (new test).
4. **Audit.** **pass.** `member.module_role_changed` records the actor, the member, the change and the resulting roles. It holds no secrets.
5. **Flag changes.** **pass.**
   - Off: stored rows are ignored and the management API answers `404`.
   - On: rows apply from the next request. Rows survive an off and on.
   - A chat run keeps the roles it read when it started, for the run's few minutes (O-3).
6. **Known limits** (unchanged, accepted):
   - Worker jobs re-read only the queuing member's project role and module roles, at run time (`actorScope`).
   - A job a member queued before losing module access still runs once.
   - Telegram callbacks are owner-only.

### Findings

| ID | Severity | Finding and evidence | Fix |
| --- | --- | --- | --- |
| MR-1 | High | `POST /action-requests/:id/decide` checked only the project role. An editor with `marketing: none` or `marketing: viewer` could decide a marketing `content_package.start` request, and approving one starts paid drafts. Test "decides an action request with the role in the request's module": `200` where `404`/`403` was expected. | The registry records each action type's module (`registeredActionTypeOwner`). The decision, `revalidate` and `onApproved` run with the member's scope in that module: `none` is `404 MODULE_NOT_AVAILABLE`, a viewer `403`. The route keeps its writer pre-check on the member's highest module role (`highestRole`), so plain viewers still get `403` before validation, and the access matrix is unchanged. A viewer raised to editor in marketing can decide (S-R6). |
| MR-2 | Medium | `GET /export` (any member) returned every entity, including all marketing records for a member with `marketing: none`. Test "keeps a hidden module's records out of the export". | The export leaves out the entity kinds of modules the member cannot see (`hiddenKinds`). Owners still export everything. |
| MR-3 | Medium | `GET /dashboard` listed the hidden module's publications (post text, schedule), its record counts and the marketing policy's budget limits. Test "keeps a hidden module's records off the dashboard". | Counts, the publication list, the active policy and the verified-fact count only include kinds the member can see. |
| MR-4 | Low | `GET /notifications` still listed and counted notices a module sent before the member lost access to it. Extended test in `notifications.integration.test.ts`. | The list and the unread count leave out the modules the member cannot see. |

### Observations (accepted, no change)

- **O-1 Operational metadata.** These platform kinds stay visible by project role, as before: jobs, exceptions, connectors, agent runs and spans, AI cost and go-live readiness. They show classes, statuses, error codes, ids, durations and costs, not module content. Revisit before support staff join a marketing project, if they must not see this metadata either.
- **O-2 Own chat history.** Messages, cards and proposals in the member's own conversations from before the change stay readable. Nothing new is offered or run.
- **O-3 Running work.** A chat run keeps the module roles read at its start. A queued job follows the known limits above.
- **O-4 Nested module scopes.** `moduleScope` puts the effective role in `role`, so module code that ran another module's check with that scope would see the raised role. No such path exists today: chat tools, actions, collections, decisions and files all start from the member's own scope. Hardening follow-up: carry the project role separately in `Scope`.
- **O-5 Knowledge search.** `knowledge_search` is a platform tool (WP3.3), so a member with `knowledge: none` can still search in the assistant. Source audiences (WP3.5) are the boundary there. Decide whether `knowledge: none` should also remove it.
- **O-6 MCP gateway.** WP-M2 must build its scope through `projectMembership` so module roles apply. Check this in the WP-M2 review.

## Public ingress: signed webhooks (WP4.2a, prepared 2026-10-17; review open)

`ORBIT_PUBLIC_INGRESS` stays `false` in production until this review is done and Mario approves the flag. While off, `POST /api/hooks/...` answers 404 in the first hook, before body parsing. What the review checks:

1. **Authentication.**
   - Only a valid signature from the connection's own secret is accepted; the module's `verify` uses a constant-time comparison.
   - A connection of another provider or another project is a 404, so the response reveals nothing about which ids exist.
2. **Replay.**
   - The provider's message id is unique per connection. The check runs under the project lock, so it is exact; a replay is a 409, audited, with no second job.
3. **Limits.**
   - JSON only (415), 256 KB (413).
   - 120 requests per minute per connection, independent of the sender's address.
   - Processing runs in the worker.
4. **Surface.**
   - The Origin exemption matches only the exact path pattern: a provider name and three lowercase UUIDs.
   - No cookie or session is read, and every other write keeps the Origin check (tested).
5. **Data.**
   - Stored messages are the platform kind `inbound_webhooks`, excluded from the export.
   - Retention: these rows are deleted after 30 days, and expired public sessions one hour after expiry (`platform/http/ingress-retention.ts`, hourly and in the retention action).
6. **Direct providers** (follow-up, same flag). `slack` and `telegram` answer within the request.
   - They reuse their old handlers unchanged: Slack's signature over the form body, actor mapping and replay claim; the bot's constant-time secret check.
   - Two checks are added: the path's connection must be the project's selected Slack connector, and the path's workspace must be the Telegram project's.
   - What the review checks:
     - a forged or missing signature never reaches the module;
     - a foreign connection or workspace answers like an unknown one;
     - the media type is limited per provider;
     - the old routes stay the registered URLs (cutover in `docs/PUBLIC_INGRESS.md`).

## Public ingress: public module API (WP4.2b, prepared 2026-10-17; review open)

This uses the same flag as WP4.2a (`ORBIT_PUBLIC_INGRESS`, off in production). While off, `/api/public/...` answers 404 in the first hook. What the review checks:

1. **Keys.**
   - `PublicClientKey` is readable by `orbit_auth` only (RLS project scope plus `auth_control`; no grant to `orbit_app`).
   - A key identifies a project and module, but it is no secret.
   - Only owners create or revoke keys (audited).
   - Allowed origins are exact HTTPS origins (`http://localhost` for development); no wildcard, no path.
2. **Browsers.**
   - A foreign Origin is a 403 (audited), also for the preflight.
   - An allowed Origin gets `Access-Control-Allow-Origin` with `Vary: Origin`, and never `Allow-Credentials`, so no browser sends or exposes Orbit cookies.
   - No cookie is read on these routes.
3. **Sessions.**
   - A session token is 32 random bytes, shown once and stored as a SHA-256 hash.
   - It lasts 12 hours and is bound to its key.
   - A module's handler sees the session id and a viewer scope of the project, never a member.
4. **Limits.**
   - JSON only, 64 KB.
   - 20 new sessions per minute per key and address; 120 calls per minute per session.
   - A switched-off module answers 404 (`MODULE_DISABLED`).
5. **Open before production.**
   - Retention for `public_sessions`.
   - A total limit per key, beyond the per-session limit.
   - An owner UI to manage keys (the API exists).

## Platform files (WP4.6, prepared 2026-10-17; review open)

`ORBIT_FILES` stays `false` in production until this review is done and Mario approves the flag. The bucket and token are Mario's (`docs/PLATFORM_FILES.md`). What the review checks:

1. **Credentials.**
   - The file bucket has its own token, scoped to that bucket. The backup container never receives `FILES_*`, and api/worker never receive `BACKUP_*` (compose check).
   - No error, log or response carries a key or a signed URL.
2. **Signing.**
   - SigV4 is computed with `node:crypto` and pinned by the AWS test vector.
   - The payload hash is signed, redirects are refused, and plain http is allowed only to localhost.
   - Object keys are generated and validated: no dot segments, no user input.
3. **Encryption.** AES-256-GCM, a fresh IV per file, and the file id as additional data. Tag and SHA-256 are verified before a byte is returned; a failure is a 500, audited `file.integrity_failed`.
4. **Authorization.**
   - Every route needs a session and membership.
   - Upload and delete need write access, download read access, all in the file's module (module roles apply).
   - The module must be on.
   - Rows are under FORCE RLS: another project's file is a 404.
5. **Content.**
   - Allowlisted types, with a signature check for images and PDF.
   - Downloads are attachments with `nosniff` and `default-src 'none'; sandbox`.
   - Names are stripped of paths and control characters.
   - The size limit is enforced while the body streams in.
6. **Deletion.** Unreadable at once; object and row follow, and the hourly cleanup retries. With `s3`, a deleted project leaves its objects behind; with `database` they go by cascade.
7. **Database backend** (`FILES_BACKEND=database`, the default since 2026-10-17). _Reviewed 2026-10-17: fix (D-1, D-2)._
   - `FileBlob` is under FORCE RLS with the project policy. _Pass_ (RLS matrix).
   - The store and a check constraint refuse keys of another project. _Pass_: the constraint is tested by a direct insert from the project's own scope. Project ids are UUIDs, so the `LIKE` pattern holds no wildcards.
   - Content is the same sealed AES-GCM object, so file content in database dumps is ciphertext. _Pass_, with a limit: names, sizes and the SHA-256 of each file (`File`), and the normalized text of inbound mail (`inbound_emails`), are plaintext in the dump. The dump itself is age-encrypted to the owner's key.
   - The key is Coolify-generated (`SERVICE_HEX_64_FILESKEY`, the same pattern as `CREDENTIAL_KEY`), reaches api and worker, and never the backup container (compose check). _Fix (D-2)_: the restore runbook now requires a copy.
   - Size limits against database load. _Fix (D-1)_: a project quota.

   Findings (database backend):

   | ID  | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                      | Evidence                                                                                                                         | Fix                                                                                                                                                                                                                     |
   | --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | D-1 | Medium   | Nothing bounded the total. Every byte lands in Postgres and in every nightly backup. The backup stages the dump and its encrypted copy in a 512 MB tmpfs (RAM), and ciphertext does not compress, so backups fail once the database passes about 250 MB. Any editor (100 uploads of 20 MB per minute) or inbound mail could also fill the database disk. | `files.integration` "keeps a project within its storage quota": a third file over the quota was stored.                         | `FILES_PROJECT_QUOTA_BYTES` (default 100 MB) is checked before the write and again in the row's transaction. `scoped()` holds the project lock there, so concurrent uploads cannot overshoot (mutation-checked). Files marked deleted count until purged. |
   | D-2 | Low      | `docs/BACKUP_RESTORE.md` asked for a copy of `CREDENTIAL_KEY` but not of `FILES_ENCRYPTION_KEY`. A restore after losing the server (and Coolify with it) would leave every file unreadable.                                                                                                                                                                                 | Runbook review.                                                                                                                  | The runbook requires both keys, and a restore checks one file download.                                                                                                                                                 |

   Residual (database backend):
   - A download holds the file several times in memory (bytea travels hex-encoded over the text protocol, plus copies for decryption and the reply): about 5–6× `FILES_MAX_BYTES` per concurrent download.
   - At the quota, inbound mail is not stored. It stays in the mailbox and is fetched again (the UID is not advanced), but the owner's mailbox view shows no `lastError` for it (WP4.7 follow-up).
   - Before raising the quota, the backup must work on disk or streamed (`pg_dump | age`), not in the 512 MB tmpfs. Until then, the sum of all projects' quotas plus the rest of the database must stay below about 250 MB.

## E-mail and member notifications (WP4.7, prepared 2026-10-17; review open)

`ORBIT_EMAIL` and `ORBIT_NOTIFICATIONS` stay `false` in production until this review is done and Mario approves each flag. Real delivery also needs live mode with external writes. What the review checks:

1. **Credentials.** The mailbox password is stored only encrypted (`CREDENTIAL_KEY`), is never returned, and never appears in logs or errors. Errors carry codes only, never server banners.
2. **Outbound abuse.**
   - Only the connection's own address sends.
   - Recipients are validated, at most 20.
   - Subjects are single lines (no header injection).
   - nodemailer file and URL access are off.
   - Sending is owner-configured and module-initiated; no route sends arbitrary mail.
3. **No duplicate sends.** An error after the hand-over, or a crash while sending, is `outcome_unknown` and never resent (tested, mutation-checked).
4. **SSRF.**
   - Mail hosts must be public DNS names resolving to public unicast addresses; checked at connect and before each use.
   - Known gap: the client resolves again (a DNS-rebinding window).
5. **Inbound content.**
   - Fetched read-only, size- and count-limited.
   - Raw MIME is kept encrypted in platform files; the normalized row holds bounded text only.
   - Automatic mail is flagged, and bounces are matched only to the project's own messages.
   - Content is untrusted data for modules.
6. **Notifications.**
   - Private per member by RLS (app.user_id).
   - Only project members with access to the module are notified; muting is respected.
   - Links are Orbit paths only (checked in the database and in the web).
   - The e-mail copy goes only to the member's account address.

## Primary implementation references

[Mammoth ZIP reader](https://raw.githubusercontent.com/mwilliamson/mammoth.js/master/lib/zipfile.js), [JSZip central-directory reader](https://raw.githubusercontent.com/Stuk/jszip/main/lib/zipEntries.js), [Sharp output API](https://sharp.pixelplumbing.com/api-output/), [Sharp installation requirements](https://sharp.pixelplumbing.com/install/), [Postiz group deletion](https://docs.postiz.com/public-api/posts/delete), and [Postiz status listing](https://docs.postiz.com/public-api/posts/list).

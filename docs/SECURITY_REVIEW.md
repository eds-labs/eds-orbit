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

## Module-level roles (WP4.5, prepared 2026-10-17; review open)

`ORBIT_MODULE_ROLES` stays `false` in production until this review is done and Mario approves the flag. What the review checks:

1. **Every module entry point uses the member's role in that module.** Covered:
   - routes (`scopeFor`, marked by the route group);
   - actions and collections (by owner);
   - assistant tools (offer and execution per tool owner);
   - prompt fragments and conversation sections (`visibleModules`);
   - the shell (`GET /modules` access).
   
   Tests: `module-roles.integration.test.ts`, `module-roles-assistant.integration.test.ts`.
2. **No escalation.**
   - Owners never get an override, and only owners set overrides.
   - An override can raise a viewer to editor in one module (S-R6), never to owner.
   - A forged tool call runs with the owner module's role.
3. **Data.**
   - `ProjectMemberModuleRole` is a tenancy table: RLS project scope, `orbit_auth` only, no grant to `orbit_app` (RLS matrix).
   - Rows cascade with the membership.
4. **Audit.** `member.module_role_changed` records the actor, the change and the resulting roles; no secrets.
5. **Known limits.**
   - Worker jobs re-read only the queuing member's project role and module roles, at run time (`actorScope`).
   - A job a member queued before losing module access still runs once.
   - Telegram callbacks are owner-only.

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

## Platform files (WP4.6, prepared 2026-10-17; review done 2026-10-17)

`ORBIT_FILES` stays `false` in production until Mario approves the flag. The bucket and token are Mario's (`docs/PLATFORM_FILES.md`). Independent review on 2026-10-17: every suspected hole got a failing test first; the five confirmed ones are fixed with tests (findings below). Result: **the flag can go on** once the bucket, token and key are set, this fix is deployed and the post-switch check below passes.

1. **Credentials.** _Pass._
   - The file bucket has its own token, scoped to that bucket. The backup container never receives `FILES_*`, and api/worker never receive `BACKUP_*` (compose check).
   - No error, log or response carries a key or a signed URL. `ObjectStoreError` carries a code and status only; its `status` is not `statusCode`, so the error handler answers 500 `REQUEST_FAILED` and logs the error name only. Fetch failures are rethrown without their cause. Responses never contain the object key (`fileView`).
2. **Signing.** _Pass._
   - SigV4 is computed with `node:crypto` and pinned by four AWS documentation vectors: GET with a range, PUT with a body, extra signed headers and a `$` in the key, and two query-string requests (`?lifecycle`, unsorted `prefix`/`max-keys`). A test pins that the sent request matches what was signed (body hash, length, type).
   - The payload hash is signed, redirects are refused (`redirect: "error"`), and plain http is allowed only to localhost. The endpoint is operator configuration, not user input, so there is no SSRF path from a member.
   - Object keys are generated and validated: no dot segments, no user input. Project ids are UUIDs and module ids match `^[a-z][a-z0-9_]{1,30}$`; the key regex refuses anything else before a request is built.
3. **Encryption.** _Pass._ AES-256-GCM, a fresh 96-bit random IV per file, and the file id as additional data. A swapped, changed or truncated object fails the tag. Tag and SHA-256 are verified over the whole content before a byte is returned; a failure is a 500, audited `file.integrity_failed`.
4. **Authorization.** _Fix (F-1, F-2)._
   - Every route needs a session and membership. Uploads now check session, module, write access and content type before the body is read (F-2).
   - Upload and delete need write access, download read access, all in the file's module (module roles apply: `none` is 404 `MODULE_NOT_AVAILABLE`, a module viewer cannot upload or delete; tested).
   - The platform's own files (raw inbound e-mail) are the owner's only, like the mailbox view; no member uploads into them (F-1).
   - The module must be on: uploads, downloads and deletes of a switched-off module's files are 404 `MODULE_DISABLED` (tested).
   - Rows are under FORCE RLS: another project's file is a 404.
5. **Content.** _Fix (F-3, F-4, F-5)._
   - Allowlisted types, with a signature check for images and PDF (magic bytes only, not a content validation).
   - Downloads are attachments with `nosniff` and `default-src 'none'; sandbox`; the web proxy passes these headers through (tested), so nothing renders inline.
   - Names are stripped of paths, control and bidi characters, and end in an extension of their type (F-3). `filename*` is RFC 5987 encoded (F-4).
   - The size limit is enforced while the body streams in, also without a `Content-Length` (tested); no other parser runs under the file limit (F-2).
   - The web proxy now forwards `x-file-type` and `x-file-name` (F-5).
6. **Deletion.** _Pass, with accepted gaps._ Unreadable at once; object and row follow, and the hourly cleanup retries. Concurrent deletes are idempotent; a download that read the row before a delete may still finish. Accepted gaps (R-1).

### Findings (WP4.6 review, 2026-10-17)

| ID  | Severity      | Finding                                                                                                                                                                                                                                                                                                                                  | Evidence (failing test before the fix)                                                                                                    | Fix                                                                                                                                       |
| --- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | Medium        | Raw inbound e-mail is stored as module `platform`, and module checks skip `platform`. Any project viewer could download a mailbox message, any editor delete one, and any editor upload into the platform's space. The mailbox view itself is owner-only. Exploitable once a member learns a file id (for example from a support module). | `files.integration` "keeps the platform's own files (raw e-mail) to the owner": viewer GET was 200.                                       | GET and DELETE of `platform` files need `PROJECT_OWN`; member uploads with `module=platform` are 409 `MODULE_UNKNOWN`.                    |
| F-2 | Medium        | The upload route raised the body limit to `FILES_MAX_BYTES` (20 MB, at most 50 MB) for every content type, and the body was read and parsed before the session check. A stranger with any `Origin` header could make the API buffer 20 MB per request (100 requests per minute per address, no concurrency cap): memory exhaustion.      | "reads no body before the session, the module and the type are checked": the stream was read for an anonymous 401 and for a viewer's 403. | A route `onRequest` hook checks session, module, write access and `application/octet-stream` before parsing; anything else is 415.       |
| F-3 | Low           | A download is saved under the stored name, whose extension was free: an editor could upload plain text as `run.bat` for other members, or hide an extension with U+202E.                                                                                                                                                                | "gives a file a name that matches its type, without bidi controls": `run.bat` stayed `run.bat`.                                           | Names lose C1 and bidi controls and get their type's extension when they lack it (`run.bat.txt`).                                         |
| F-4 | Low           | `filename*` used `encodeURIComponent`, which leaves `'`, `(`, `)` and `*` unescaped (not RFC 5987 `attr-char`).                                                                                                                                                                                                                          | "names downloads with RFC 5987 characters only".                                                                                          | Those characters are percent-encoded.                                                                                                     |
| F-5 | Low (broken)  | The web proxy forwards an allow-list of request headers that lacked `x-file-type` and `x-file-name`: every upload through orbit.eds-labs.io would have failed with 415.                                                                                                                                                                  | `route.test.tsx` "forwards a file upload's type and name headers".                                                                        | Both headers are on the allow-list; the API validates them.                                                                               |

### Accepted residual risks and follow-ups

- **R-1 Orphaned objects (Low).** No product path deletes a project or workspace today; a manual delete cascades the rows and leaves the objects (encrypted, unreadable without `FILES_ENCRYPTION_KEY`). A crash between the object write and the row insert, or a failed compensating delete, also leaves an object without a row. Before any project or workspace deletion ships, it must purge the project's files first (rows marked, objects removed by key, or a `projects/<id>/` prefix purge, which needs ListObjectsV2 in `s3.ts`).
- **R-2 Unbounded read (Low).** `get` reads the whole object into memory. Only a holder of the bucket token can plant a large object.
- **R-3 Endpoint checked at use (Info).** A non-https, non-localhost endpoint fails each request with 500 (`OBJECT_STORE_ENDPOINT_INSECURE`) instead of at startup; this is deliberate after hotfix #144. Incomplete configuration with `ORBIT_FILES=true` keeps files off (404).
- **R-4 Content (Info).** No virus scanning; CSV files may carry spreadsheet formulas. Downloads are always attachments.
- **R-5 Cleanup order (Low).** The hourly cleanup takes 50 marked rows per project in no particular order; objects that keep failing can delay others.
- **R-6 Existence oracle (Info).** For a known file id, `MODULE_NOT_AVAILABLE` or `FORBIDDEN` differs from `NOT_FOUND`. File ids are random UUIDs.

### After switching the flag on (Mario)

Upload a small PNG through the web app, download it, delete it, and check in R2 that the object is gone and that the stored object is not the PNG (encrypted). A 404 on upload means the configuration is incomplete.

### A server-local filesystem instead of R2

The routes, authorization, encryption and integrity checks stay the same behind the `ObjectStore` interface. What changes:

- No SigV4, endpoint or redirect policy; instead the key-to-path mapping must stay under one root (the key regex already refuses dot segments), refuse symlinks (`O_NOFOLLOW` or a `realpath` check), and write atomically (temporary file, `fsync`, `rename`) with mode `0600`.
- The containers run with a read-only root filesystem: api and worker need a shared named volume (inbound mail is written by the worker and read by the api), which ties both to one host.
- Backups: R2 keeps file content outside the server; on a local disk the files need their own backup. The objects are already encrypted, so a backup may copy them without `FILES_ENCRYPTION_KEY`; the backup container then mounts the volume read-only, still without `FILES_*`.
- Capacity: files and Postgres would share the disk. A per-project quota and disk monitoring are needed so uploads cannot fill the database's disk.
- Orphans become easier: a directory listing finds objects without rows, and a project purge is one directory (R-1).

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

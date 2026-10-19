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
  - **WP-M2 status (2026-10-18, local; flag off).** `resolvePrincipal` re-checks every granted project with `actorScope` (`projectMembership`) on each request, and the adapter runs tools with `moduleScope(scope, owner)`, so module roles apply. Evidence: `apps/api/tests/mcp-principal.integration.test.ts` (intersection matrix over role and module state; lost membership hides the project) and `mcp-gateway.integration.test.ts`. The independent review of the gateway is a WP-M5 item and has not been done.
  - **WP-M3 status (2026-10-18, local; flag off).** The native `search` and `fetch` and the registry tools `marketing_project_status` and `support_insights` build their scope through `projectScope` and `moduleScope` on every call (`fetch` re-authorizes the project named in the id), so module roles apply to them as well. Evidence: `apps/api/tests/mcp-read-surface.integration.test.ts` (module role `knowledge = none`, disabled module row, grant restricted to other modules, ids that cross projects) and `apps/api/tests/mcp-registry-tools.integration.test.ts`. The independent review stays a WP-M5 item.
  - **WP-M4 status (2026-10-18, local; flags off).** The proposal tool `marketing_assignment_propose` runs through the adapter with `moduleScope(scope, owner)` and the service's own checks (editor role, `ORBIT_AGENTS`, the spend mandate), and `orbit_action_status` builds its scope through `projectScope`, so module roles and the grant apply. An MCP proposal is a pending ActionRequest of an allowlisted type (`mcpProposable`); approving it needs the owner's decision in Orbit, and an approval is refused once the proposing grant (or the grant that replaced it) no longer holds `orbit:propose`, no longer covers the project, lost its user's membership, or once any grant of that user and client ended for another reason than a replacement or proposals were stopped after the request was made (`MCP_GRANT_ENDED`); the proposal transaction runs the same check before it creates anything. Evidence: `apps/api/tests/mcp-proposals-contract.integration.test.ts`, `apps/api/tests/mcp-proposal-flow.integration.test.ts`, `apps/api/tests/mcp-proposal-controls.integration.test.ts` and `apps/api/tests/mcp-proposal-owner-controls.integration.test.ts`. The independent review of the write path stays a WP-M5 item; the remaining limitations listed in `docs/IMPLEMENTATION_STATUS.md` ("Track M WP-M4") are part of it.

## Public ingress: signed webhooks (WP4.2a, prepared 2026-10-17; review done 2026-10-17)

`ORBIT_PUBLIC_INGRESS` stays `false` in production until Mario approves the flag. While off, `POST /api/hooks/...` answers 404 in the first hook, before body parsing. The review was adversarial: every suspected hole got a failing test first. The regression tests are in `apps/api/tests/public-ingress-review.integration.test.ts` (PI-\*), next to `webhooks`, `ingress-retention`, `telegram` and the proxy route tests. Findings are listed after the WP4.2b section.

1. **Authentication.** Pass.
   - Only a valid signature from the connection's own secret is accepted; the module's `verify` uses a constant-time comparison.
   - A connection of another provider or another project is a 404, so the response reveals nothing about which ids exist. A workspace in the path that does not own the project finds nothing under RLS (404).
2. **Replay.** Fix (PI-7).
   - The provider's message id is unique per connection. The check runs under the project lock, so it is exact; a replay is a 409, audited, with no second job. The job's idempotency key repeats the guard.
   - The guard is only as good as the message id. The fixture took it from an unsigned header, so a captured delivery replayed under a new id. The provider contract now requires the id to be covered by the signature, and the fixture signs `id.body`.
3. **Limits.** Fix (PI-3).
   - JSON only (415), 256 KB (413).
   - 120 requests per minute per connection, independent of the sender's address.
   - The connection's bucket replaced the global per-address limit, and made-up connection ids each got a fresh one. Now 600 hook calls per minute per client address (`HOOKS_PER_ADDRESS`) apply on top.
   - Processing runs in the worker.
4. **Surface.** Pass (tested).
   - The Origin exemption matches only the exact path pattern: a provider name and three lowercase UUIDs.
   - Upper case, a trailing slash, a query string, a percent-encoded character and dot segments all lose the exemption (403 `ORIGIN_REQUIRED`), and nothing is stored.
   - No cookie or session is read, and every other write keeps the Origin check (tested).
5. **Data.** Pass.
   - Stored messages are the platform kind `inbound_webhooks`, excluded from the export.
   - Retention: these rows are deleted after 30 days, and expired public sessions one hour after expiry (`platform/http/ingress-retention.ts`, hourly and in the retention action).
6. **Direct providers** (follow-up, same flag). Pass. `slack` and `telegram` answer within the request.
   - They reuse their old handlers unchanged: Slack's signature over the form body, actor mapping and replay claim; the bot's constant-time secret check.
   - Two checks are added: the path's connection must be the project's selected Slack connector, and the path's workspace must be the Telegram project's.
   - A forged or missing signature never reaches the module (Slack 401/403, Telegram 401, audited).
   - A foreign connection or workspace answers like an unknown one (Slack 404, Telegram 401).
   - The media type is limited per provider (Slack form, Telegram JSON).
   - The old routes stay the registered URLs (cutover in `docs/PUBLIC_INGRESS.md`).
7. **Web proxy.** Fix (PI-8).
   - The proxy forwarded only Slack's and Telegram's headers, so a module provider's signature never reached the API (always 401, fail-closed).
   - Under `/api/hooks/` it now forwards every header except cookies, hop-by-hop headers and proxy-only ones (`x-orbit-*`, `x-forwarded-*`). The client address is still set by the proxy alone.

## Public ingress: public module API (WP4.2b, prepared 2026-10-17; review done 2026-10-17)

This uses the same flag as WP4.2a (`ORBIT_PUBLIC_INGRESS`, off in production). While off, `/api/public/...` answers 404 in the first hook. What the review checked:

1. **Keys.** Pass.
   - `PublicClientKey` is readable by `orbit_auth` only (RLS project scope plus `auth_control`; no grant to `orbit_app`, RLS matrix).
   - A key identifies a project and module, but it is no secret.
   - Only owners create or revoke keys (audited).
   - Allowed origins are exact HTTPS origins (`http://localhost` for development); no wildcard, no path.
2. **Browsers.** Pass.
   - A foreign Origin is a 403 (audited), also for the preflight.
   - An allowed Origin gets `Access-Control-Allow-Origin` with `Vary: Origin`, and never `Allow-Credentials`, so no browser sends or exposes Orbit cookies.
   - No cookie is read on these routes.
3. **Sessions.** Pass.
   - A session token is 32 random bytes, shown once and stored as a SHA-256 hash. Tokens of another key are refused.
   - It lasts 12 hours and is bound to its key.
   - A module's handler sees the session id and a viewer scope of the project, never a member.
   - Logs carry the path only and redact `Authorization`.
4. **Limits.** Fix (PI-1, PI-2, PI-4, PI-5).
   - JSON only, 64 KB. The root's form and text parsers used to hand a handler a string; every other media type is now a 415.
   - Prototype keys (`__proto__`, `constructor.prototype`) are a 400, as on every other route. The own JSON parser had dropped Fastify's protection.
   - 20 new sessions per minute per key and address. The address used to be `req.ip`, which is the web proxy in production; it is now the browser's address (`clientIp`).
   - 120 calls per minute per session. Made-up tokens each got a fresh bucket; 300 calls per minute per key and client address (`CALLS_PER_ADDRESS`) now apply on top. This also bounds the audit rows of a foreign Origin.
   - A switched-off module answers 404 (`MODULE_DISABLED`).
5. **Flag off.** Fix (PI-6).
   - The hook matched the raw URL. `/api/%70ublic/...` reaches the same routes, so its body was parsed before the handler's own 404.
   - It now matches the route pattern, like the other flags.
6. **Web proxy.** Fix (PI-8). The proxy forwarded `Authorization` only under `/api/auth/oauth2/`, so every session call through it was a 401. It now forwards the header under `/api/public/` too.
7. **Still open before a module ships a public API.**
   - A total limit per key across addresses: many addresses can still open sessions.
   - The owner UI exists (Project access → Public keys); there is no key in production because no module has a public API.

### Findings (2026-10-17)

All findings are fixed in the review's PR, each with a test that failed before the fix.

| ID | Severity | Finding and evidence | Fix |
| --- | --- | --- | --- |
| PI-1 | Medium | The session limit was keyed by `req.ip`. Behind the web proxy that is the proxy's address, so one client used up the 20 sessions per minute of every visitor of a key. Test: 25 visitors behind the proxy, the 21st got 429. | Key by `clientIp(req)`. |
| PI-2 | Medium | The per-session bucket was keyed by the caller's token and replaced the global limit. Random tokens got unlimited requests against a public key: two project-locked transactions each, and an audit row each with a foreign Origin. Test: 305 random tokens from one address, no 429; 305 audit rows. | 300 calls per minute per key and client address on top (`ceilingPerKey`). |
| PI-3 | Medium | The webhook bucket was keyed by the path's connection id. Random ids bypassed every limit, and each request took the project lock. The workspace and project ids are in every hook URL. Test: 605 random ids from one address, no 429. | 600 hook calls per minute per client address on top. |
| PI-4 | Low | The public API took `text/plain` and form bodies through the root parsers. A handler got a string, and these CORS-simple requests need no preflight (the Origin check still applied). Test: both answered 401 instead of 415. | Only the JSON parser in the public scope. |
| PI-5 | Low | The public JSON parser was plain `JSON.parse`, without Fastify's prototype-poisoning check. Test: `__proto__` and `constructor.prototype` bodies were accepted. | A reviver refuses both (400). |
| PI-6 | Low | The flag-off check matched the raw URL. `/api/%70ublic/...` was routed to the public API and its body parsed (400) before the handler's 404. No bypass: the handler checks the flag itself. | Match the route pattern. |
| PI-7 | Low | Replay protection trusts the provider's message id. The fixture read it from an unsigned header, so a captured delivery replayed under a new id. Test: the replay was accepted. | The contract requires a signed id; the fixture signs it. |
| PI-8 | Low (functional) | The web proxy dropped `Authorization` under `/api/public/` and provider signature headers under `/api/hooks/`. Through the proxy, public sessions and module webhooks always failed (fail-closed). Test: proxy route tests. | Forward them on those paths only. |

Accepted and noted, not changed:

- Someone who knows a hook URL can use up its connection's 120 calls per minute with forged requests, and cause up to 120 `webhook.rejected` audit rows per minute. Hook URLs are known only to the provider, and one address is limited.
- A 429 carries no `Access-Control-Allow-Origin`, so a browser sees a network error instead of the status.
- Telegram sends all bots' updates from a few addresses. 600 hook calls per minute per address is ample at Orbit's scale; revisit with many bots.
- Rate limits are kept in each API process's memory (no Redis store), as for every other route.
- A session is found by a JSON-path match over the project's `public_sessions`. Retention and the session limits bound that table.

### Verdict

With this PR merged, the flag can go on from the security side. Mario still has to approve that step. What switching it on changes in production today:

- `/api/hooks/slack/...` and `/api/hooks/telegram/...` answer. They are not registered with Slack or Telegram until the cutover.
- `/api/public/...` and the key routes answer. No module in production has a public API, so no key can be issued yet.


### Re-check of the web proxy (2026-10-18)

#157 (WP5.4) made the web proxy forward `Authorization` under `/api/public/`, which the WP4.2b review had not seen. I checked it on main after #162:

- **pass:** `Authorization` reaches only `/api/public/*` and `/api/auth/oauth2/*`. The decision and the upstream path come from the same decoded segments, a segment such as `public/support` does not count, and `.`/`..` and NUL are refused (`oauth-proxy.test.tsx`).
- **pass:** the client address for the public API's rate limits is set by the proxy alone (`x-orbit-client-ip` from the right-most `X-Forwarded-For` entry). The API believes it only from a private peer (`clientIp()`), so visitors cannot pick their bucket and do not share the proxy's.
- **pass:** SSE streams are passed through unbuffered. The 45 s upstream timeout ends a stream, and the widget resumes with `Last-Event-ID`.
- **fix (low):** an Orbit session cookie was still forwarded to `/api/public/`, although the public API never reads one and the widget sends `credentials: "omit"`. It is no longer forwarded there, and a test pins that.

Result: `ORBIT_PUBLIC_INGRESS` may go on, as far as the proxy is concerned, once this fix is deployed.
## Platform files (WP4.6, prepared 2026-10-17; review done 2026-10-17)

`ORBIT_FILES` stays `false` in production until Mario approves the flag. The bucket and token are Mario's (`docs/PLATFORM_FILES.md`). Independent review on 2026-10-17: every suspected hole got a failing test first; the five confirmed ones are fixed with tests (findings below). Result: **the flag can go on** once this fix is deployed (with `FILES_BACKEND=database`, the default, nothing else is needed; with `s3`, the bucket and token are set) and the post-switch check below passes. The database backend is reviewed in item 7.

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
6. **Deletion.** _Pass, with accepted gaps._ Unreadable at once; object and row follow, and the hourly cleanup retries. Concurrent deletes are idempotent; a download that read the row before a delete may still finish. With `database`, a deleted project's content goes by cascade; with `s3` its objects stay (R-1).

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

### Findings (WP4.6 review, 2026-10-17)

| ID  | Severity      | Finding                                                                                                                                                                                                                                                                                                                                  | Evidence (failing test before the fix)                                                                                                    | Fix                                                                                                                                       |
| --- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | Medium        | Raw inbound e-mail is stored as module `platform`, and module checks skip `platform`. Any project viewer could download a mailbox message, any editor delete one, and any editor upload into the platform's space. The mailbox view itself is owner-only. Exploitable once a member learns a file id (for example from a support module). | `files.integration` "keeps the platform's own files (raw e-mail) to the owner": viewer GET was 200.                                       | GET and DELETE of `platform` files need `PROJECT_OWN`; member uploads with `module=platform` are 409 `MODULE_UNKNOWN`.                    |
| F-2 | Medium        | The upload route raised the body limit to `FILES_MAX_BYTES` (20 MB, at most 50 MB) for every content type, and the body was read and parsed before the session check. A stranger with any `Origin` header could make the API buffer 20 MB per request (100 requests per minute per address, no concurrency cap): memory exhaustion.      | "reads no body before the session, the module and the type are checked": the stream was read for an anonymous 401 and for a viewer's 403. | A route `onRequest` hook checks session, module, write access and `application/octet-stream` before parsing; anything else is 415.       |
| F-3 | Low           | A download is saved under the stored name, whose extension was free: an editor could upload plain text as `run.bat` for other members, or hide an extension with U+202E.                                                                                                                                                                | "gives a file a name that matches its type, without bidi controls": `run.bat` stayed `run.bat`.                                           | Names lose C1 and bidi controls and get their type's extension when they lack it (`run.bat.txt`).                                         |
| F-4 | Low           | `filename*` used `encodeURIComponent`, which leaves `'`, `(`, `)` and `*` unescaped (not RFC 5987 `attr-char`).                                                                                                                                                                                                                          | "names downloads with RFC 5987 characters only".                                                                                          | Those characters are percent-encoded.                                                                                                     |
| F-5 | Low (broken)  | The web proxy forwards an allow-list of request headers that lacked `x-file-type` and `x-file-name`: every upload through orbit.eds-labs.io would have failed with 415.                                                                                                                                                                  | `route.test.tsx` "forwards a file upload's type and name headers".                                                                        | Both headers are on the allow-list; the API validates them.                                                                               |

### Accepted residual risks and follow-ups

- **R-1 Orphaned objects (Low, `s3` only).** No product path deletes a project or workspace today; a manual delete cascades the rows and leaves the objects (encrypted, unreadable without `FILES_ENCRYPTION_KEY`). A crash between the object write and the row insert, or a failed compensating delete, also leaves an object without a row. Before any project or workspace deletion ships, it must purge the project's files first (rows marked, objects removed by key, or a `projects/<id>/` prefix purge, which needs ListObjectsV2 in `s3.ts`).
- **R-2 Unbounded read (Low).** `get` reads the whole object into memory. Only a holder of the bucket token can plant a large object.
- **R-3 Endpoint checked at use (Info).** A non-https, non-localhost endpoint fails each request with 500 (`OBJECT_STORE_ENDPOINT_INSECURE`) instead of at startup; this is deliberate after hotfix #144. Incomplete configuration with `ORBIT_FILES=true` keeps files off (404).
- **R-4 Content (Info).** No virus scanning; CSV files may carry spreadsheet formulas. Downloads are always attachments.
- **R-5 Cleanup order (Low).** The hourly cleanup takes 50 marked rows per project in no particular order; objects that keep failing can delay others.
- **R-6 Existence oracle (Info).** For a known file id, `MODULE_NOT_AVAILABLE` or `FORBIDDEN` differs from `NOT_FOUND`. File ids are random UUIDs.

### After switching the flag on (Mario)

Upload a small PNG through the web app, download it and delete it. Check in the store (the `FileBlob` row, or the object in R2) that the content is gone and was not stored as the PNG. A 404 on upload means the configuration is incomplete. Copy the generated `FILES_ENCRYPTION_KEY` into the password manager (D-2).

### A server-local filesystem instead of R2

The routes, authorization, encryption and integrity checks stay the same behind the `ObjectStore` interface. What changes:

- No SigV4, endpoint or redirect policy; instead the key-to-path mapping must stay under one root (the key regex already refuses dot segments), refuse symlinks (`O_NOFOLLOW` or a `realpath` check), and write atomically (temporary file, `fsync`, `rename`) with mode `0600`.
- The containers run with a read-only root filesystem: api and worker need a shared named volume (inbound mail is written by the worker and read by the api), which ties both to one host.
- Backups: R2 keeps file content outside the server; on a local disk the files need their own backup. The objects are already encrypted, so a backup may copy them without `FILES_ENCRYPTION_KEY`; the backup container then mounts the volume read-only, still without `FILES_*`.
- Capacity: files and Postgres would share the disk. A per-project quota and disk monitoring are needed so uploads cannot fill the database's disk.
- Orphans become easier: a directory listing finds objects without rows, and a project purge is one directory (R-1).

## E-mail and member notifications (WP4.7, prepared 2026-10-17; review done 2026-10-17)

`ORBIT_EMAIL` and `ORBIT_NOTIFICATIONS` stay `false` in production until Mario approves each flag. Real delivery also needs live mode with external writes. The independent review was adversarial: it wrote a failing test for every suspected hole before calling it a finding. Nine tests failed on the reviewed code and pass with the fixes; the duplicate-send and NUL fixes were also mutation-checked. Verdict: both flags can go on once the fix PR is merged and deployed, not before (F-1 and F-2 block `ORBIT_EMAIL`; F-3 blocks `ORBIT_NOTIFICATIONS`).

1. **Credentials: pass, plus fix F-8.**
   - The mailbox password is stored only encrypted (`CREDENTIAL_KEY`).
   - It is never returned: `publicEntity` strips it from GET `/email` and from every connector listing.
   - It never appears in logs or errors. nodemailer and imapflow run without a logger, and errors keep fixed codes, never server banners.
   - The health check no longer logs in to the mailbox while `ORBIT_EMAIL` is off (F-8).
2. **Outbound abuse: pass, plus fix F-6.**
   - Only the connection's own address sends.
   - Recipients are validated, at most 20.
   - No route sends mail. Only modules and the member notifications queue it, and the notifications go only to a member's own account address.
   - nodemailer file and URL access are off.
   - Subjects, In-Reply-To and References are single lines. A real MIME build with CR/LF in the threading ids produced no injected header (`email-transport.test.ts`).
   - A notification title with a line break no longer fails the module's transaction (F-6).
3. **No duplicate sends: fix F-1.** The earlier "tested, mutation-checked" claim rested on a stub error (`command: "DATA"`) that nodemailer never produces.
4. **SSRF: fix F-7.**
   - Hosts are public DNS names that resolve to public unicast addresses only. IP literals and local names are refused.
   - The client now connects to the vetted address, so the DNS-rebinding gap is closed.
5. **Inbound content: fix F-2, F-4, F-5, F-9.**
   - Fetching is read-only and size- and count-limited.
   - Raw MIME is kept encrypted, and the row now holds bounded, control-free text only.
   - Bounces are matched only to the project's own messages, and only for a recipient that the report names.
   - Orbit's own mail coming back in is never handed to modules, and replies to automatic mail are refused.
6. **Notifications: pass, plus fix F-3.**
   - Notices are private per member: FORCE RLS on `app.user_id`, and `asMember` sets and restores it inside the caller's transaction.
   - Tests show another member cannot read or mark a notice, and with no user id nothing is visible.
   - Only members with access to the module are notified, and muting is respected.
   - Links are now Orbit paths only in the API, the database and the bell (F-3).
7. **Flags off: pass, plus fix F-8.**
   - The `onRequest` 404 covers GET `/email` and the four notification routes. It checks the matched route pattern, so encoded paths cannot slip past.
   - `email-connect`, `queueEmail`, sending, receiving, the periodic task and `notifyMembers` check their flag themselves.
   - The health check did not check the flag (F-8).

**Findings**

| ID  | Severity | Evidence (failing test on the reviewed code)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Fix                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | High     | **A message could be delivered up to three times.** nodemailer 10.0.13 reports every lost connection and timeout as command `CONN`, even after the whole message was sent (`smtp-connection` `_onClose`, `_onTimeout`). `classifySendError` counted `CONN` as "before DATA", so such a message went to `retry`. `email-transport.test.ts`: against a scripted local SMTP server that takes the message and then drops the connection, or never answers, the outcome was `failed` instead of `outcome_unknown`. | Orbit now runs the SMTP session itself (nodemailer's `SMTPConnection` and `MailComposer`) and tracks the step. An error after the envelope has started, with no SMTP reply, is `outcome_unknown` and is never sent again. Connection failures before that are still retried. A 4xx reply is still `failed` and a 5xx reply `rejected` (tested). Mutation-checked.                                             |
| F-2 | Medium   | **One hostile mail stopped all receiving.** postal-mime throws above 256 MIME nesting levels or 2 MB of headers. A NUL in the subject or text made the insert fail (Postgres `22P05`). `fetchInbound` then threw, `lastUid` never moved, and the same message failed every two minutes for good. In the NUL case, each pass also left another orphaned raw file of up to 10 MB. Any outside sender can cause this. Test: "does not let one hostile message block the mailbox".                                 | A message that cannot be parsed is stored as an `unreadable` row with its raw file. Every field is stripped of control characters and lone surrogates and bounded (998 per line, 320 per address, 20,000 for the text), including In-Reply-To and References, which were unbounded before.                                                                                                                    |
| F-3 | Medium   | **A notification link could leave Orbit.** `/<tab>/evil.example`, `/<LF>/…` and `/<CR>/…` passed the API rule, the database check and the bell's `safeLink`, and a browser opens them as `https://evil.example/` (WHATWG URL parsing drops tabs and line breaks). `/\evil` passed the API and the database; only the bell stopped it. Tests in `notifications.integration` and `notification-bell.test.tsx`.                                                                                                   | One rule (`ORBIT_PATH`) in the API and the bell: a leading `/`, no second `/` or `\` after it, and no backslash, whitespace or control character anywhere. The database check is replaced by migration `202610170010_notification_link_check` (`NOT VALID`; there are no existing rows, since the flag was off).                                                                                              |
| F-4 | Low      | **Read receipts, warnings and plain replies counted as bounces.** Any `multipart/report` (read receipts and "delayed" warnings too), and any mail from a `postmaster@` or `mailer-daemon@` address on any domain, marked every Orbit message it named as `bounced` and was withheld from modules. A human reply from `postmaster@customer` quoting the thread never reached a module. A forged report could name any address. Test: "marks bounced only by a delivery report naming the message's recipient".  | A bounce is now an RFC 3464 report with `report-type=delivery-status` and `Action: failed`, or a classic mailer-daemon bounce without `multipart/report`. It marks a message only when it names one of that message's recipients exactly. Anything else goes to the modules as ordinary mail. Residual risk: a real recipient can still forge a bounce for their own copy, which cannot be checked over IMAP. |
| F-5 | Low      | **Auto-reply loops were prevented only by convention.** Orbit's own message coming back in was handed to modules as new mail. That happens when a member's address is the mailbox itself, or when the provider copies sent mail into the INBOX. `queueEmail` also accepted a reply to automatic mail. Tests: "does not hand Orbit's own messages back to the modules" and "refuses a reply to automatic mail".                                                                                                 | An inbound copy with the project's own Orbit Message-ID is stored with `ownMessage: true` and is not handed over. `queueEmail` refuses an `inReplyTo` that names an automatic inbound message (`EMAIL_REPLY_TO_AUTOMATIC`, RFC 3834).                                                                                                                                                                         |
| F-6 | Low      | **A multi-line title broke the module's action.** Once a member had chosen e-mail, a title with a line break made `queueEmail` throw a ZodError inside `notifyMembers`, which rolled back the calling module's whole transaction. Test: "e-mails a title with a line break as one subject line".                                                                                                                                                                                                               | The title is collapsed to one line for the subject.                                                                                                                                                                                                                                                                                                                                                           |
| F-7 | Low      | **DNS rebinding (the known gap).** The host check and the client each resolved the name, and nodemailer also keeps its own DNS cache.                                                                                                                                                                                                                                                                                                                                                                          | `assertPublicMailHost` returns the vetted address. SMTP and IMAP connect to that address and verify the TLS certificate against the host name (`servername`). Tested on the connection options.                                                                                                                                                                                                               |
| F-8 | Low      | **The mailbox was checked while e-mail was off.** The connector health check logged in to SMTP and IMAP while `ORBIT_EMAIL` was off. Test: "does not log in to the mailbox while e-mail is off".                                                                                                                                                                                                                                                                                                               | `NOT_FOUND` while the flag is off.                                                                                                                                                                                                                                                                                                                                                                            |
| F-9 | Low      | **A hostile mail server could fill memory.** imapflow lets a server announce IMAP literals of up to 1 GB, which a hostile or compromised mailbox server could use to exhaust the worker's memory.                                                                                                                                                                                                                                                                                                              | `maxLiteralSize` is 12 MB and `maxResponseSize` 13 MB (fetched messages are at most 10 MB).                                                                                                                                                                                                                                                                                                                   |

**Accepted or open (not fixed here)**

- **Unverified addresses.** The e-mail copy of a notification goes to the member's account address, which Orbit does not verify (Better Auth e-mail verification is off). Members are added by owners, so this is limited to a member's own notices reaching an address they registered. Once e-mail verification exists, send only to verified addresses.
- **Dependencies, checked 2026-10-17.** No advisory affects the pinned versions (GitHub Advisory Database, OSV, Snyk). nodemailer 10.0.13 is itself the fix for GHSA-4ffr-jq9g-5ffx (high, a pre-authentication regex DoS) and GHSA-g73g-hqqh-jr95 (medium). Newer releases add hardening against hostile servers and messages that has no advisory yet:
  - nodemailer 10.1.x;
  - imapflow up to 2.5.2 (response and STARTTLS hardening);
  - postal-mime 4.0.5–4.0.8 (new `maxPartCount` and `maxForwardedAddresses` limits).

  Each is under two weeks old, so the pinning rule applies; upgrade them as a follow-up once they are two weeks old. postal-mime's new limits must be set explicitly.

- **Generic `connector` action.** It accepts provider `email` and skips the host rules. A row made that way has no hosts and can never be verified, so it cannot send or receive. Information only.

## MCP gateway prepared review (WP-M5, prepared 2026-10-19; independent review pending)

This is the `09` §9 checklist (`plans/orbit-modularization/09-mcp-gateway.md`) worked through by the implementing agent with local evidence. It is the input for the independent review, not that review. In production every MCP flag is still off. Rollout steps and approvals: `docs/deployment/MCP_ROLLOUT.md`. Evidence names a test file under `apps/api/tests/` and the test title; the WP-M1…M4 sections of `docs/IMPLEMENTATION_STATUS.md` hold the full lists.

| §9 item | Status | Evidence |
|---|---|---|
| Token audience binding (`aud` = MCP resource); MCP tokens not accepted by the REST API and vice versa | Met | `mcp-oauth-flow` "full flow issues an audience-bound token", "missing resource is invalid_target without a redirect"; `mcp-gateway` "foreign aud and issuer are refused", "answers an unauthenticated request with 401 and the PRM challenge" (a session cookie is no credential); `mcp-oauth-preflip` "a resource in another spelling is accepted, bound and issued in its canonical form". The REST API authenticates members by session cookie; the web proxy forwards `Authorization` only under `/api/auth/oauth2/`, `/api/public/` (public-session tokens of a public key) and `/api/hooks/` (provider signatures), so only the OAuth endpoints themselves read an MCP access token (userinfo, introspect and revoke, by design; the token's `aud` also names userinfo, WP-M1). `mcp-conformance.integration` "the REST API refuses an MCP access token (09 §9: audience binding)": `GET /api/me`, `/api/projects` and `/api/mcp-grants` with a valid MCP bearer token and no cookie each answer 401 (the same routes answer the member's session) |
| PKCE required; exact redirect URI; `iss` in every response; no skipped consent for new clients | Met | `mcp-oauth-http` "flag on: authorization server metadata validates"; `mcp-oauth-flow` "wrong code_verifier is invalid_grant", "unregistered redirect_uri is rejected without redirecting", "a new client always reaches the consent step", "selection for one client does not carry over to another client"; `mcp-oauth-preflip` "a selection serves only the authorization request it was made for" |
| CIMD fetch is SSRF-safe (HTTPS only, private ranges blocked, size and time limits, caching) | Partly: Orbit-side policy and the size limit met; address pinning, the 5 s fetch timeout and caching are behaviour of the pinned `@better-auth/cimd/node` transport and Better Auth's metadata revalidation (default 60 min) without an Orbit test (open) | `mcp-oauth-cimd` "a client_id outside ORBIT_MCP_CIMD_HOSTS is rejected before any fetch", "loopback, http, credentials, fragment and IP-literal client_ids are rejected", "oversized metadata (> 5 KB) is rejected", "metadata with a secret or symmetric auth method is rejected"; `mcp-oauth-config` "production uses fetchClientMetadataResource from @better-auth/cimd/node"; revalidation picks up a changed document: `mcp-oauth-cimd` "first use writes client.registered, a changed document writes client.refreshed" (with a transport that never caches) |
| Refresh rotation with reuse detection; immediate grant revocation | Met | `mcp-oauth-flow` "refresh rotates; replay after 30 s revokes the family"; `mcp-oauth-revoke` "revoked grant fails on the next call", "revocation beats the refresh reuse window"; `mcp-gateway` "revoked grant refuses a call listed a moment ago"; `mcp-oauth-preflip` "a code exchanged after its grant was revoked mints no usable token", "a refresh rotated while its grant is revoked mints no usable token", "the token check waits for an uncommitted revocation of the grant"; `mcp-oauth-cimd` "a token_endpoint_auth_method downgrade alone revokes (WP-M5)". Decided: an RFC 7009 revocation keeps the grant (`mcp-oauth-preflip` "RFC 7009 revocation of a refresh token keeps the grant active (decided: WP-M5)") |
| Membership and module activation re-checked per call; never more than the UI allows | Met | `mcp-principal` "drops a scope the grant lacks", "drops a scope the token lacks", "refuses a grant whose user left the workspace", "lost membership hides the project", "never reveals whether a project outside the grant exists"; `mcp-read-surface` "a module role knowledge = none hides the project's knowledge", "the knowledge module disabled for the project hides its knowledge", "a grant restricted to other modules searches nothing and fetches nothing", "fetch ids cannot cross projects"; `mcp-registry-tools` "follows the grant's module restriction"; O-6 above |
| Results respect `modelUse`, carry no secrets; customer PII gated (Q-12) | Met for the exposed tools; field review of `marketing_project_status` is a Mario decision | `mcp-read-surface` "modelUse=false content is absent end-to-end", "returns the opaque user id and no e-mail", "query text and argument values are absent from logs, audit rows, grant events and runs"; `mcp-registry-tools` "pins closed, bounded output schemas and read-only annotations", "returns counts only" (`support_insights`); `mcp-gateway` "never sends an internal error's message", "validates the output and returns only the parsed value" |
| Hard floors not exposed; writes only through ActionRequests | Met | `mcp-proposals-contract` "allows exactly assignment.confirm to be proposed from MCP", "refuses an unknown type before the proposable check"; `mcp-gateway` "never lists tools without MCP exposure"; `mcp-registry-tools` "leaves the other marketing read tools unexposed"; `mcp-proposal-owner-controls` "refuses an approval of a proposal whose grant ended even when it was never canceled", "refuses to create a proposal when the grant stopped proposing after the gateway resolved it"; `mcp-proposal-controls.unit` "fails module registration, so the gateway never starts with such a tool", "holds for every proposal tool Orbit registers". No `orbit:write` scope is issued (WP-M1 D4) |
| Rate limits, quotas and kill switch | Partly: limits, quotas and the grant and flag switches met; a central client disable (`09` §7) is open (see the deferred findings); numbers are a Mario decision; the behaviour behind Traefik is checked at A3/A5 | `mcp-gateway-audit` "the 121st call of a grant in a minute is a 429 with Retry-After", "search has its own bucket per grant (30 a minute); other tools still pass", "a burst of bad tokens is refused after the limit without verifying them", "a full address limiter never refuses an authenticated request (separate caps)", "keys IPv6 clients by their /64, so rotating addresses inside it does not evade the limit", "a third call in one project waits, then answers BUSY; retryable for reads only"; `mcp-proposal-controls` "a re-selection (a new grant) does not reset the hourly or the daily quota", "concurrent proposals of one key cannot pass the hourly quota together", "hides and refuses the proposal tool while off; read tools stay"; `mcp-proposal-owner-controls` "stopping proposals hides the proposal tools on the next request and cancels the grant's pending ones"; `mcp-gateway-disabled.unit` "answers /healthz with status disabled and 404 for everything else", "loads the real gateway only when both flags are true"; `mcp-oauth-http` "token endpoint is limited per client IP"; `mcp-oauth-cimd` "DCR on: sixth registration within 60 s is 429" |
| Dependency pinning past known advisories | Partly: exact pins; advisory re-check before A2 open | `better-auth`, `@better-auth/mcp`, `@better-auth/oauth-provider`, `@better-auth/cimd` 1.7.10 (advisories checked 2026-10-17, WP-M1 D1) and `@modelcontextprotocol/server` 2.3.1 (approved 2026-10-18). Re-query the GitHub Advisory Database and OSV for these before A2; not done in WP-M5 (local work without network) |
| MCP conformance test and ChatGPT end-to-end test | Partly: local conformance met; Inspector and ChatGPT pending (A7, A6) | `mcp-conformance.integration`: the checks of `scripts/mcp-smoke.ts` over HTTP with a real WP-M1 token for 2026-07-28 and 2025-11-25 (discovery, `tools/list`, `orbit_projects`, `search`, unknown tool, 401 challenge, PRM, batch, `GET`, disabled mode, token never printed); `mcp-sdk.characterization`; `mcp-gateway` "server/discover (2026-07-28) names the gateway and its tool capability", "initialize, tools/list and tools/call work per principal without a session" |

### Open points and Mario decisions (approval A9, D-M5-9)

- **`marketing_project_status` fields.** Recommendation: keep them as they are for the read-only start. The output equals what the Orbit Assistant gets (`mcp-registry-tools` "equals what the assistant gets, minus the time and the cards"), the same member sees it in Orbit, and it carries no credentials, post bodies or customer data. Channel ids and the spend limits (`modelBudget`) are what `marketing_assignment_propose` needs to make a valid proposal. If less should leave Orbit, drop `modelBudget` and the draft titles from the MCP projection first; the proposal service checks the mandate anyway.
- **CORS for browser clients.** Recommendation: none. ChatGPT calls server-side without `Origin`; `ORBIT_MCP_ALLOWED_ORIGINS` stays empty and a browser request is refused with 403 before its token is read.
- **URL elicitation, owner notification on a new proposal, per-request deep link.** Recommendation: later. Client support is undocumented, a legacy client cannot receive an elicitation statelessly, and the fallback (`approveUrl` to the approval inbox plus `orbit_action_status`) works.
- **Quota numbers.** Today: per grant 120, per user 240, per client 600 requests a minute; 30 a minute per address without a verified token (IPv6 by /64); `search` 30 a minute per grant; proposals 20 an hour and 100 a day per (user, client, workspace); 2 concurrent tool calls per project and process, queue 16, 10 s wait, then `BUSY`. Recommendation: keep them for A6 and review with real client behaviour (polling clients, dots loops) before A8 or a second client.
- **`argsHash` salting.** Recommendation: not needed while access to the audit rows stays as narrow as today; re-check when an audit view or export of `mcp.tool_call` rows is added.
- **Ports between action requests and MCP auth** (decoupling `apps/api/src/modules/action-requests.ts` and `apps/api/src/platform/mcp-auth/grants.ts`): a refactor, not a security item; later.

### Still pending

- The independent security review and a penetration test of the deployed endpoint (this section is their input).
- Real-client runs: MCP Inspector (A7), ChatGPT developer mode (A6), and `scripts/mcp-smoke.ts` against the deployed endpoint after A3 and A5.
- The production checks in the runbook: Coolify render of the `<<:` merge key, a generated domain before A3, prefix stripping, router priority, client address keying behind Traefik, `stop_grace_period`.

### Deferred findings with a security angle (accepted for now, follow-ups)

- **Least privilege of the `mcp` container.** It gets the whole API environment (database URLs, auth secret, credential key) and the `database` and `egress` networks, also in disabled mode. Give it only the keys and networks it needs.
- **No central client disable.** `09` §7 asks for disabling a client centrally; today an owner revokes each grant of the client, or the flags go off. Removing a host from `ORBIT_MCP_CIMD_HOSTS` stops only new registrations from it.
- **Address limiter under a flood.** The per-address limiter refuses new keys when full (50 000; a holder of a /48 could fill it), and then a legitimate client with an expired token from a new address gets 429 instead of the 401 challenge. Alert on `bucket: capacity`.
- **After a restart** the verified-token cache is empty, so clients behind shared addresses (ChatGPT egress) can get 429 until the minute ends.
- **Proposal counting.** The daily quota can be overshot by calls in flight. It undercounts when the event write fails (`MCP_PROPOSAL_RECORD_FAILED`) and when a tool saves and then throws. The hourly bucket still caps 20 an hour per key and process.
- **Slot before authorization.** A registry tool call takes its project's concurrency slot before the project is authorized, so a token holder can briefly occupy a slot of a project outside the grant by naming its id (bounded by the 2-slot, 10 s design; the call fails fast).
- **Startup contract check.** `assertMcpToolContracts` does not see modules that are unavailable at startup; registration still checks every tool.
- **Library coupling.** The element counter copies MCP SDK 2.3.1 internals, and the `/oauth2/token` after-hook relies on the provider's token body shape. Re-run `mcp-hardening.unit` and `mcp-oauth-preflip` on every SDK or Better Auth upgrade.
- **Selection fingerprint.** It hashes the stable authorization parameters. Two identical requests without `state` and PKCE would share it; PKCE is required, so a replay is useless without the verifier.
- **Query text in knowledge evidence.** The knowledge engine's Evidence rows store the search query, by design and as for assistant searches; logs, audit, grant events and runs do not.
- **Account data.** `email_verified` is always `false` (WP-M1 D7), so ChatGPT Enterprise domain restrictions would fail. A member removed from a workspace keeps an active grant row, which the per-call lookup denies.
- **Origin policy details.** `parseAllowedOrigins` accepts `http` origins for any host (configuration only), and the Origin policy also covers the metadata and health routes. Through the web proxy the browser's `Origin` is not forwarded, so the public PRM paths work.
- **Prefix stripping.** If Coolify strips `/mcp`, `<APP_ORIGIN>/mcp/healthz` shows the gateway mode publicly.
- **Key rotation.** Replacing the signing key (auth table `jwks`) is not rehearsed; see the runbook's incident steps.
- **Fixed in WP-M5:** the web forwarding of the PRM paths no longer passes cookies from the gateway back to the browser (`apps/web/src/app/.well-known/[...path]/route.test.tsx` "never passes cookies from the MCP gateway back to the browser").

## Primary implementation references

[Mammoth ZIP reader](https://raw.githubusercontent.com/mwilliamson/mammoth.js/master/lib/zipfile.js), [JSZip central-directory reader](https://raw.githubusercontent.com/Stuk/jszip/main/lib/zipEntries.js), [Sharp output API](https://sharp.pixelplumbing.com/api-output/), [Sharp installation requirements](https://sharp.pixelplumbing.com/install/), [Postiz group deletion](https://docs.postiz.com/public-api/posts/delete), and [Postiz status listing](https://docs.postiz.com/public-api/posts/list).

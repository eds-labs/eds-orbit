# Implementation status

## E-mail over SMTP/IMAP and member notifications: WP4.7 (2026-10-17, local; flags off)

Branch `claude/wp47-email-notifications` (on top of WP4.6). Mario decided on 2026-10-17 (Q-16): the project's existing mailbox over SMTP and IMAP, no new provider and no DNS change by Orbit. The operating guide is `docs/EMAIL_AND_NOTIFICATIONS.md`.

- **Flags.** `ORBIT_EMAIL` and `ORBIT_NOTIFICATIONS`, both `false`. Real delivery also needs live mode with external writes.
- **Connection.** `platform/email/connection.ts`: the owner action `email-connect` (public hosts only, password encrypted) and the provider check `email` (SMTP and IMAP login, `read_verified`, sends nothing).
- **Transport.** `platform/email/transport.ts`: nodemailer and imapflow behind small interfaces that tests replace, TLS required, and outcome classification.
- **Sending.** `platform/email/send.ts`: `queueEmail`, the `email_send` job, and `sent` / `rejected` / `retry` → `failed` / `outcome_unknown` / `test_receipt`. Nothing is ever sent twice.
- **Receiving.** `platform/email/inbound.ts`: the periodic task `email-inbound`.
  - Read-only IMAP fetch with UIDVALIDITY handling and limits.
  - The raw MIME becomes an encrypted platform file; `inbound_emails` holds the normalized row.
  - Automatic mail is flagged, and bounces mark the project's own messages.
  - Modules with `emailInbound` get a job per message.
- **Notifications.**
  - Migration `202610170008_member_notification`: `Notification` and `NotificationPreference`, private per member by RLS.
  - Service: `platform/notifications/members.ts` (`notifyMembers`, list, read, preferences); contract: `userNotifications`.
  - Routes: `platform/notifications/routes.ts`; owner mailbox view: `platform/email/routes.ts`.
- **Web.** The bell in the top bar (`notification-bell.tsx`) and the mailbox card on the connectors page (`email-connection.tsx`).
- **Dependencies.** `nodemailer` 10.0.13, `imapflow` 2.2.1, `postal-mime` 4.0.2 and `@types/nodemailer`, exact pins at least two weeks old. The audit adds no finding (`docs/DEPENDENCY_RISKS.md`).
- **Tests:**
  - `email.integration.test.ts`: connection, test receipt, live send headers, the four outcomes, crash recovery, inbound dedupe/UIDVALIDITY/limits/auto-reply, bounces, files required. A mutation check confirmed it.
  - `notifications.integration.test.ts`: members only, privacy, read state, muting, e-mail choice, module role, flag off.
  - Web unit tests; RLS and access matrices; contract tests.
- **Production.**
  - Merging brings the migration and the dependencies (approval).
  - Mario then connects the mailbox in Orbit.
  - Each flag and the first real send are separate approvals after the security review.

## Platform files: WP4.6 (2026-10-17, local; flag off)

Branch `claude/wp46-platform-files` (on top of the public ingress follow-ups). Plan: `docs/superpowers/plans/2026-10-17-phase4-platform-capabilities.md`. Mario approved the bucket and token on 2026-10-17 (Q-19: an own R2 bucket next to the backup bucket). The operating guide is `docs/PLATFORM_FILES.md`.

- **Data.** Migration `202610170007_platform_file` adds the `File` table: FORCE RLS project policy and `orbit_app` grants, declared as a platform table. Additive.
- **Object store.** `platform/files/s3.ts` is a SigV4 client without an SDK (PUT, GET, DELETE), pinned by the AWS test vector.
- **Encryption.** `platform/files/crypto.ts`: AES-256-GCM, with the file id as additional data.
- **Service.** `platform/files/files.ts`: `storeFile`, `readFile`, `deleteFile` and the hourly `file-cleanup` task.
  - Limits: allowlisted types, signature checks for images and PDF, `FILES_MAX_BYTES`.
- **Routes.** `platform/files/routes.ts`: upload, download and delete, with module access and the module switch. They answer 404 while off or not configured.
- **Configuration.** `ORBIT_FILES` and `FILES_*` in config, compose and `.env.example`. The compose check pins that file and backup credentials never mix.
- **Tests:**
  - `files.integration.test.ts`, against a bucket double that checks every signature: round trip, encryption at rest, permissions, limits, the module switch, project isolation, a swapped or missing object, the cleanup retry, and off/unconfigured;
  - unit tests for SigV4 and encryption;
  - the RLS matrix (`File` seeded, cross-project insert refused);
  - the access matrix (three routes).
- **Production.**
  - Merging brings the migration (approval).
  - Mario then creates the bucket and token and sets the variables.
  - The flag waits for the security review (`docs/SECURITY_REVIEW.md`).

## Public ingress follow-ups (2026-10-17, local; flag off)

Branch `claude/phase4-followups`. Everything stays behind `ORBIT_PUBLIC_INGRESS` (default `false`). The operating guide is `docs/PUBLIC_INGRESS.md`.

- **Retention.** `platform/http/ingress-retention.ts` deletes rows for good, with their versions:
  - public sessions one hour after they expire;
  - received webhooks after 30 days.
  
  It runs hourly per project as the platform's periodic task `public-ingress-cleanup` and also inside the project's retention action, whose audit entry counts both. It purges regardless of the flag, so rows from an earlier "on" go too.
- **Owner UI for public keys.** Project access has a new "Public keys" dialog (`components/public-keys.tsx`): list, create (module, exact origins) and revoke.
  - `GET …/public-keys` also returns the modules a key can be issued for.
  - Production has none, so the dialog says so.
- **Slack and Telegram through the hooks route.** The webhook contract has a second variant, `DirectWebhookProvider`, for providers that must answer within the request. The platform owns the path, flag, media type, size and rate limit; the provider checks its own secret against its own connection.
  - `telegram` (platform): `/api/hooks/telegram/<workspace>/<project>/<connection>`. Same handler and secret check as the bot's own route, and the path's workspace must be the project's.
  - `slack` (marketing): `/api/hooks/slack/<workspace>/<project>/<connector>`, form-encoded. Same signature, mapping and replay checks, and the connector must be the project's selected Slack connector.
  
  The old routes stay the registered URLs. The cutover is a later production step (`docs/PUBLIC_INGRESS.md`).
- **Tests.**
  - `ingress-retention.integration.test.ts`: cleanup, project isolation, the hourly throttle and the retention action.
  - The Telegram hooks path in `telegram.integration.test.ts`: flag, secret, foreign workspace, media type and linking.
  - The Slack hooks path in `webhooks.integration.test.ts`: media type, missing and forged signature, foreign connector, and a valid signature reaching the actor check.
  - Registry checks in `module-contributions.test.ts`; the origin parser in `public-keys.test.tsx`.
- **Deployment record of Phase 4** (below).

## Phase 4 in production: WP4.1–WP4.2b (2026-10-17)

Each step was merged into `main` on Mario's approval, after green CI and outside the 10:00/17:00 slots. Both flags (`ORBIT_MODULE_ROLES`, `ORBIT_PUBLIC_INGRESS`) stayed `false`. After every deploy, `/api/health/ready` (database ok, worker ready) and `/api/health/postiz` were ok.

| WP | PR | Merge commit | Merged | Live | Check |
|---|---|---|---|---|---|
| WP4.1 fixture module, open contracts | #133 | `cc1b128` | 10:15 | 10:19 | health |
| WP4.4 cross-module operator eval | #134 | `ae12c7c` | 10:50 | 10:51 | health |
| WP4.3 Part A lock measurement | #135 | `f654ab8` | 11:51 | 11:55 | health |
| WP4.5 module roles (migration `202610170005`) | #136 | `b5e07f6` | 12:23 | 12:27 | `/modules` returns `access`; module-roles API 404 |
| WP4.2a signed webhooks | #137 | `3fd782d` | 12:56 | 13:00 | `/api/hooks/...` 404 |
| WP4.2b public API (migration `202610170006`) | #138 | `bff9a83` | 13:30 | about 13:40 | `/api/public/...` answers the flag's 404 instead of `ORIGIN_REQUIRED` |

## Public module API: WP4.2b (2026-10-17, local; flag off)

Branch `claude/wp42b-public-api` (on top of WP4.2a). Plan: `docs/superpowers/plans/2026-10-17-phase4-platform-capabilities.md`. Same flag as WP4.2a (`ORBIT_PUBLIC_INGRESS`, default `false`).

- **Keys.** Migration `202610170006_public_client_key` adds the `PublicClientKey` table: owners only, audited, exact allowed origins.
  - API: `GET/POST /api/projects/:id/public-keys` and `POST …/:keyId/revoke`.
- **Public API.** `platform/http/public-api.ts`, at `/api/public/<module>/:publicKey/...`:
  - the key is resolved without a project scope;
  - the Origin check and CORS run per key (manual, no credentials) and preflight is supported;
  - `POST …/session` issues a bearer token, stored as a hash, valid 12 hours;
  - module routes need that token;
  - JSON only, 64 KB, rate limits per key and address, and per session;
  - the API is off with its module.
- **Contract.** `ModuleContributions.publicRoutes`. The registry checks paths and refuses `/session` and duplicates. The fixture module serves `/requests`: visitors file requests and see only their own.
- **Tests.** `public-api.integration.test.ts` covers:
  - the flag off;
  - key issuing rules;
  - unknown, foreign and revoked keys;
  - a foreign Origin (audited), an allowed Origin without credentials, and preflight;
  - missing, wrong and expired tokens, and that cookies are ignored;
  - the token stored as a hash, and visitors seeing only their own requests;
  - the per-session rate limit and the module switch.
  
  A mutation check confirmed it: with the origin comparison disabled, the test fails. The access matrix adds exactly the three owner-only key routes.
- **Production.** Merging brings the migration (Mario's approval). The flag waits for the security review.

## Signed provider webhooks: WP4.2a (2026-10-17, local; flag off)

Branch `claude/wp42-public-ingress`. Plan: `docs/superpowers/plans/2026-10-17-phase4-platform-capabilities.md`. Risk class high: a new unauthenticated surface, behind `ORBIT_PUBLIC_INGRESS` (default `false`).

- **Route.** `POST /api/hooks/:provider/:workspaceId/:projectId/:connectionId` (`platform/http/webhooks.ts`):
  - the raw JSON body is kept as received for the signature;
  - 415 and 413 limits;
  - 120 requests per minute per connection;
  - exempt from the Origin check by exact path pattern.
- **Contract.** A module contributes `webhooks[provider] = { connectionProvider, verify, messageId, queueClass }`. The registry refuses duplicate names and unknown queue classes.
- **Flow.** Inside the project transaction:
  - the connection must belong to the provider (404 otherwise);
  - the signature is checked (401 otherwise, audited);
  - the message id is required (400 otherwise);
  - a replay gets 409 (audited);
  - the message is stored as `inbound_webhooks` and the module's job is enqueued; the answer is 200 at once.
- **Fixture.** The test module `tasks` signs with HMAC-SHA256, and its job turns the message into a task.
- **Tests.** `webhooks.integration.test.ts` covers the flag off, every rejection path, storing, the job, replay, the per-connection rate limit and the unchanged Origin check. A mutation check confirmed it: with the signature check disabled, 4 tests fail.
- **Production.** Mario's approval for the flag, after the security review (`docs/SECURITY_REVIEW.md`). Merging alone changes nothing (404 while off). Slack and Telegram stay on their own routes for now.

## Module-level roles: WP4.5 (2026-10-17, local; flag off)

Branch `claude/wp45-module-roles`. Plan: `docs/superpowers/plans/2026-10-17-phase4-platform-capabilities.md`. Risk class high: an authorization change, behind `ORBIT_MODULE_ROLES` (default `false`).

- **Data.** Migration `202610170005_project_member_module_role`: an additive table with RLS, `orbit_auth` only, cascading with the membership.
- **Resolution.** `platform/tenancy/module-roles.ts`:
  - The membership carries a non-owner's overrides.
  - `effectiveRole` and `moduleScope` give a module's code the member's role there; `none` answers 404 `MODULE_NOT_AVAILABLE`.
  - `visibleModules` filters tools, prompt fragments and conversation sections like activation does.
- **Gates.**
  - Module routes, actions and collections.
  - Assistant tools, offered and executed per tool owner.
  - Prompt fragments and conversation sections.
  - `GET /modules` with `access`, so the web shell hides `none`.
- **Management.**
  - `GET/PUT /api/projects/:id/members/:userId/module-roles`: owners only, audited, refused for owners and unknown modules, 404 while the flag is off.
  - "Module roles" per member in the web.
- **Tests.**
  - `module-roles.integration.test.ts`: refusals; `none` in routes, collections, actions and the module list; a viewer raised to editor in knowledge only; stored rows ignored with the flag off; removal.
  - `module-roles-assistant.integration.test.ts`: tools and a forged call.
  - Shell and form unit tests; the RLS matrix includes the new table.
- **Production.** Migration and flag need Mario's approval; the flag also needs the security review (`docs/SECURITY_REVIEW.md`). The migration alone changes nothing.

## Project lock measurement: WP4.3 Part A (2026-10-17, local)

Branch `claude/wp43-lock-measurement`. Report: [docs/evidence/lock-measurement-2026-10-17.md](evidence/lock-measurement-2026-10-17.md).

- **Hook.** `lockObserver.observe` in `packages/db` reports `{ waitMs, holdMs }` for every `scoped()` transaction. It is unset in production (one property read) and tested in `packages/db/tests/lock-observer.integration.test.ts`.
- **Measurement.** `scripts/measure/lock-load.measure.ts` with `vitest.measure.config.ts`, outside `pnpm test`. Load: chat runs with a 1.5 s model, searches with a 1 s embedding, writers, the sweep, and 5 or 25 chat-stream pollers.
- **Result.**
  - No transaction holds the lock across a provider call; the longest hold is 66 ms.
  - With 25 open chat streams (about 54 transactions per second on one project), writers keep a call p95 of 28 ms and polls 71 ms.
  - The lock does not limit one project at this load. Polling is the cost that grows with open streams.
- **Recommendation.** Part B needs Mario's decision:
  - no lock-free read path now;
  - Redis pub/sub for streams when Support starts;
  - repeat the measurement on the production host against a staging copy first.

## Cross-module operator eval: WP4.4 (2026-10-17, local)

Branch `claude/wp44-operator-eval` (on top of WP4.1).

- **Dataset.** `evals/operator/cases-v3.json` replays recorded model steps through the real chat runner, with knowledge, marketing and the test-only fixture module registered:
  - JC30: tools of all three modules in one run, with two task proposals as two pending ActionRequests;
  - JC31: a viewer is offered no module write, and a forged `propose_tasks` is refused (`CHAT_TOOL_NOT_ALLOWED`);
  - JC32: with the tasks module off, its tool is neither offered nor callable;
  - JC33: with every module off, the assistant is offered exactly `knowledge_search` and still searches the existing sources.
- **Harness.** New optional `disabledModules` and `actionRequests` fields. `cases-v1.json` and `cases-v2.json` are unchanged, and so are their hashes.
- **Verification.** All 14 operator cases are green offline; no network call and no paid call.

## A third module through the contracts alone: WP4.1 (2026-10-17, local)

Branch `claude/wp41-extensibility`, the first work package of Phase 4. Plan: `docs/superpowers/plans/2026-10-17-phase4-platform-capabilities.md`.

- **Fixture module `tasks`** (`apps/api/tests/fixtures/modules/tasks`, test only). It declares:
  - a kind and two permissions;
  - a route, a readable collection and an action;
  - a proposal tool, an action type and a scheduler.
  
  `registerTestModules()` in `modules/registry.ts` adds it; the API and the worker register only the static list.
- **Three gaps the suite found and closed** (behaviour of knowledge and marketing unchanged):
  - `ToolNamespace` was a closed union. A module may now name its own namespace; it only groups tools for tool search.
  - The generic collection read accepted a fixed list of kinds. A module now declares readable kinds with `EntityKindDef.collection`. The registry refuses it for an unexported kind, so credentials can never become readable.
  - Action permissions were hard-coded for knowledge and marketing in `server.ts`. Modules now contribute `actionPermissions` for their own actions only; the registry refuses another module's action.
- **Tests:**
  - `extensibility.integration.test.ts`: registration; the tool offered by role; the route, collection and action for owner, editor, viewer and a non-member; module off and on again, including the scheduler.
  - `extensibility-assistant.integration.test.ts`: a scripted chat run across knowledge, marketing and the fixture yields two ActionRequests. A viewer cannot decide them; an editor approves one and exactly one task appears.

**Rollback.** Revert; there is no schema or data change.

## Phase 3 follow-ups (2026-10-17, local)

Branch `claude/phase3-followups`.

- **Breadcrumb.** Knowledge sub-pages showed their internal key ("knowledge-facts"). `ViewDef.title` now names a page without a navigation entry, and `crumbs()` shows "Wissen / Fakten". A test checks that no page shows its key.
- **brandTerms in the profile editor.** The marketing profile editor (`modules/marketing/advanced.tsx`) has a field for the product words of the fact checks. Words are lower-cased and de-duplicated; an empty field leaves `brandTerms` out, so the built-in uLiquid words stay. Saving the profile invalidates pending packages, as every profile save does.
- **Deployment record of Phase 3** (below).

## Phase 3 in production: WP3.1–WP3.4 (2026-10-15/16)

Each step was merged into `main` on Mario's approval, after green CI and outside the 10:00/17:00 slots. Coolify deployed each one with about 30–40 seconds of 503 while the containers were replaced. After every deploy, `/api/health/ready` (database ok, worker ready) and `/api/health/postiz` were ok.

| WP | PR | Merge commit | Merged | Live |
|---|---|---|---|---|
| WP3.1 impact handlers | #128 | `918e06c` | 15.10 15:57 | 16:00 |
| WP3.2 knowledge services, K-1 | #129 | `6567951` | 15.10 17:15 | 17:19 |
| WP3.3 knowledge module, URL views | #130 | `c9f8af2` | 15.10 17:46 | 17:49 |
| WP3.4 brand terms from the profile | #131 | `2533a80` | 16.10 15:41 | 15:45 |

Checks after the deploys:
- **K-1, before the switch.** The read-only check in production (`scripts/rollout/k1-usable-facts-diff.sql`, as `orbit_app`, ending in ROLLBACK) showed every uLiquid fact unchanged.
- **Knowledge views.** `/p/<uLiquid>/knowledge/facts` opens the Facts tab with the knowledge entry highlighted.
- **Assignment runs on 16.10 (`63f76b22`) and 17.10 (`f610945b`).** Every step finished; the new `knowledge_search` and the K-1 rule raised no error.
  - Of the four drafts, the 17:00 draft of 17.10 was approved and handed to Postiz for X and Telegram (WP2.6 check 8).
  - The three rejections came from content conflicts, not from the refactor: an extra word in a fact sentence, banner copy competing with the CTA, reviewer directions left in the text, and a topic built on a fact that the guardrails forbid. They are handled separately.
  - The daily report (WP2.6 check 9) has not been checked here.

## Product words of the fact checks from the profile: WP3.4 (2026-10-15; production 2026-10-16)

Branch `claude/wp34-fact-consumers`. Plan: `docs/superpowers/plans/2026-10-15-phase3-knowledge-module.md`. Behaviour for uLiquid is unchanged.

- **Profile field.** `marketingProfile.brandTerms` is new and optional: lower-case words of the product name, 1–20, each 2–40 letters or digits.
- **Fact matcher.** `factClaimMatches(text, fact, brandTerms)` allows the profile's words instead of the built-in `uliquid`, `uliq` and `desk`.
- **Presale check.** `presaleLivePattern(profileTerms)` accepts up to two of the profile's words between "live" and "presale".
- **Without the field (every profile today).** `LEGACY_BRAND_TERMS` applies and the presale regex stays verbatim (pinned by a test), so no check changes and no profile save is needed.
- **Loading.** `checkClaims` reads the terms once, and only when it checks a fact claim.
- **Follow-up.** A field in the profile editor; until then the profile API sets it.

**Verification (local).**
- New tests:
  - the matcher with a profile's own words, which rejects uLiquid's words there;
  - `brandTermsOf`;
  - the legacy presale regex is pinned verbatim; the generated one matches and rejects as expected;
  - the schema keeps an absent field absent and rejects invalid terms.
- `fact-claims`, `claim-repeat`, `safety`, `official-target-link` and `content-packages` are green; the OpenAPI document is unchanged.

**Rollback.** Revert; there is no schema migration or data change (the profile field is optional and unused).

## Knowledge module, server and web: WP3.3 (2026-10-15; production 2026-10-15)

Branch `claude/wp33-knowledge-module`. Plan: `docs/superpowers/plans/2026-10-15-phase3-knowledge-module.md`. With `ORBIT_MODULES=false` the product is unchanged; the knowledge views gain URLs.

- **Server.** `GET …/knowledge-health`, `…/documents` and `…/indexes` move unchanged from `server.ts` into `modules/knowledge/routes.ts`; the bulk import moves to `modules/knowledge/import.ts`. The platform's route guard answers `MODULE_DISABLED` for them while knowledge is off. The OpenAPI document is semantically unchanged (route order only; regenerated with the client types).
- **Assistant search.** `assistantKnowledgeSearch` is a platform tool (`alwaysOffered`). Marketing lists it only to keep its place, so the tool list and prompt are unchanged. With knowledge and marketing off, the assistant still offers `knowledge_search`.
- **Web.**
  - Each knowledge tab is a view at `/p/:id/knowledge/<tab>`; the overview stays the module root.
  - The tab bar keeps its role, labels, order and keyboard handling, and navigates to the tab's URL.
  - `ViewDef.navKey` lets a URL-only view highlight its module's sidebar entry.
- **Deviations from plan 05 §8, kept for an unchanged product.** "Conflicts" and "impact" stay tabs. Detail URLs with ids, the knowledge settings panel and the home tile are follow-ups.

**Verification (local).**
- New tests:
  - enforcement: knowledge switched off after marketing blocks its routes, collections and actions; the assistant keeps the search; marketing needs knowledge first; the snapshot is unchanged;
  - routes: every tab resolves to its view and highlights the knowledge entry; `navKey` validation.
- Web typecheck and `next build --webpack` pass; Playwright not run locally.

**Rollback.** Revert; there is no schema or data change.

## Knowledge services and the K-1 fact rule: WP3.2 (2026-10-15; production 2026-10-15)

Branch `claude/wp32-knowledge-services` (stacked on WP3.1). Plan: `docs/superpowers/plans/2026-10-15-phase3-knowledge-module.md`.

- **Orchestration moved.** `retrieval.ts`, `ingestion.ts`, `reindex.ts` and `index-evaluation.ts` move unchanged from the flat api modules to `apps/api/src/platform/knowledge/`; only import paths change. `services.ts` is the facade (retrieve, retrieveHybrid, validateEvidence, getActiveIndex, the six bound changing operations).
- **One `knowledge_search`.** The search moves verbatim from marketing's `runReadTool` to `platform/knowledge/search.ts`. `knowledgeSearchTool()` is the only definition.
  - The chat and the specialists pass their budget keys, which are unchanged: `chat:<runId>:knowledge:<n>` with `chat:<runId>`, and `agent:<taskId>:knowledge:<n>` with `assignment-run:<runId>`.
  - Name, description, schema and position in the tool list are unchanged, so the prompt is the same.
  - The card check is now `checkToolResult` in `platform/assistant/cards.ts`.
- **K-1 (behaviour change, decided by Mario).** `platform/knowledge/facts.ts` applies the engine's full rules to package facts. Marketing's `usableFacts`/`listUsableFacts` delegate to it, with the profile's content language.
  - The production check before the switch (`scripts/rollout/k1-usable-facts-diff.sql`, read-only) showed every uLiquid fact `unchanged`.
  - Two test fixtures created facts without `sourceGeneration`, which `setFact` always records. They now set it.

**Verification (local).**
- New tests:
  - `knowledge-search-tool.test.ts`: same model-facing tool for both variants, both budget-key sets, the specialist variant refused outside a task.
  - The K-1 test now pins the shipped rule to the SQL's K-1 side.
- Typecheck and source check pass; boundaries: 0 known violations.

**Rollback.** Revert; there is no schema or data change.

## Knowledge invalidation through impact handlers: WP3.1 (2026-10-15; production 2026-10-15)

Branch `claude/plattform-umbau-fortschritt-05c734`, the first work package of Phase 3 (plan: `docs/superpowers/plans/2026-10-15-phase3-knowledge-module.md`). Risk class high: a missed invalidation would make revoked evidence publishable. Behaviour is unchanged.

- **Engine (`packages/knowledge`).** `invalidate()` keeps only its own part: it marks dependent evidence `invalidated` (or purges it) and then calls the impact handlers it was given, in the same transaction.
  - The six changing operations (`ingest`, `setFact`, `withdrawFact`, `revokeSource`, `setSourceRights`, `revokeDocument`) take `handlers` after the scope.
  - The result keeps `{ evidenceIds, contentIds }`; `contentIds` is what the handlers report.
  - New types: `KnowledgeImpact`, `ImpactResult`, `ImpactHandler`.
- **Marketing.** `invalidateMarketingForKnowledge` (`modules/marketing/pipeline/knowledge-impact.ts`) is the former marketing part, moved line for line, with the same revision history. It covers content, approvals, insights, publications, jobs, reconciliation jobs and the outbox. Marketing registers it as the new contribution `knowledgeImpact`.
- **Platform.** `registeredImpactHandlers()` returns every module's handler, never filtered by activation. `platform/knowledge/engine.ts` binds them to the six operations.
  - All callers use the platform wrapper: server, knowledge actions, ingestion, the import, tests, evals and `scripts/backup-restore-test.ts`, which now registers the modules first.
  - Without registration the wrapper fails closed.
- **Boundary check.** `forbiddenLiterals` in `scripts/boundaries.json` forbids the strings `content`, `approvals`, `publications`, `insights` and `jobs` in `packages/knowledge`. The old engine has five hits, the new one none.

**Verification (local).**
- The WP0.4 characterization snapshots (nine scenarios) pass without updating.
- New tests:
  - engine: handler order and arguments, reported content ids, handlers without affected evidence, rollback when a handler throws;
  - registry: marketing's handler is bound for every project; fail-closed before registration;
  - boundary script: the literal check.
- Typecheck and source check pass; boundaries: 0 known violations.

**Rollback.** Redeploy the previous image; there is no schema or data change.

## Banner copy no longer a claim: R83 (2026-10-15, local)

Branch `claude/banner-claims`. The uLiquid 17:00 draft of 2026-10-15 was rejected with `CLAIM_NOT_IN_CONTENT`, because the model had recorded the banner copy as a style claim. The generation (`packages/ai`) now drops a style claim with no fact or chunk that is not in the body and consists only of banner fields, and the banner instruction says the banner copy is no claim. Details: ruling R83. Verification: AI package tests (a new test with the production case), and the banner, copywriter and agent-review suites.

## Modular platform in production: WP2.6 Step A (2026-10-15)

On Mario's Approval A, release PR #125 was merged into `main` at 13:05 CEST (merge commit `930511e`). The new version was live at 13:10, and migration `202610130001_platform_project_module` ran. `ORBIT_MODULES` stays `false`. Runbook: `docs/deployment/MODULAR_PLATFORM_ROLLOUT.md`.

Post-deploy checks:
1. `/api/health/ready` ok (database ok, worker ready); `/api/health/postiz` ok.
2. uLiquid home and navigation: 13 entries; Knowledge, Marketing and Platform sections.
3. Settings → Modules: Knowledge and Marketing on, switching not enabled.
4. Settings tabs as before; the assignment "uLiquid Beta" is active (Postiz drafts, 10:00/17:00).
5. Connectors: Postiz, Matomo, Slack, Telegram (linked), blog, newsletter, in the former order.
6. Operations: worker heartbeat, outbox 0, 14 queue classes, AI runs with costs.
7. Telegram: the bot answered a text message with its help text (13:18).

Checks 8 and 9 (the next run's drafts and the daily report) follow. The 17:00 rejection of that day predates the deploy and is fixed by R83.

## Weekly autopilot removed (2026-10-13, local)

Branch `claude/remove-old-agent-tests-e6b039` (PR #90), merged with the modular platform (#125), not deployed. Production has run on standing assignments since 2026-10-09 (`ORBIT_AGENTS=true`), so the weekly autopilot that the flag-off path kept as a fallback is gone: `marketing/pipeline/autopilot.ts` and its shim (planner, settings, one-click `approve-and-schedule`, migration proposal), the `configure-autopilot` and `approve-and-schedule` actions and permissions, the `…/assignments/autopilot-migration` routes, the `autopilot_settings` collection and its manifest kind (old rows stay in the database and in the project export), the autopilot settings tab (`autopilot-settings.tsx`), the autopilot approvals panel and the migration card, the Phase 0 rollout queries, and their tests (`autopilot.test.ts`, `autopilot-coexistence`, `autopilot-migration`, `rollout-phase0`, planner cases in `paid`, `official-target-link`, `assignment-runs`, `assignment-routes`, `drive-readiness`, `due-marker`, the web migration card). With `ORBIT_AGENTS` off the sweep now plans no posts (sweep characterization case renamed, snapshot unchanged). Kept: the project and policy mode `autopilot` (autonomy mode, unrelated), and the code that reads missions the autopilot planned earlier (slot occupancy, missed-slot archive, draft cleanup, content history, generation context). No schema migration. Rollback: revert the merge commit. Details: [OPERATIONS.md](OPERATIONS.md#orbit-agents).

## Google Drive on the platform, brand assets in marketing, Slack checked: WP2.5d (2026-10-14, local)

Branch `claude/wp25d-drive-slack`, the last part of WP2.5.

- **Google Drive.** `modules/google-drive.ts` moves to `platform/connections/google-drive.ts` (a rename-only commit first; the shim is gone).
  - **Platform:** OAuth connect and callback, the connection status and health, disconnect, the storage root, browsing and `driveContent`.
  - **Marketing (`modules/marketing/brand/drive-assets.ts`):** the six brand-asset functions, moved unchanged. They are `importDriveFile`, `brandAssets`, `saveGeneratedAsset`, `saveDraftDocument`, `uploadUserRaster` and `markSyncFailed` (plan 04: they stay marketing until Q-06).
  - The platform exports the Drive access they build on under descriptive names (`driveStorage`, `driveAccessToken`, `driveContains`, `ensureDriveFolder`, …). The access token never leaves the server.
- **Routes.** The three brand-asset routes move from `server.ts` into marketing's routes at the same paths, so the WP2.4 guard covers them: `GET …/google-drive/brand`, `POST …/google-drive/files/:fileId/import` and `POST …/google-drive/upload` (with its rate limit).
- **Drive retry of generated images.** It moves from the worker's pass into the marketing periodic task `drive-asset-retry`, unchanged; a mechanical diff shows only the return of its wake-up.
  - `PeriodicTask.run` may now return `wakeAt`, which the worker adds to the project's wake-up, so the timing stays the same.
  - The worker no longer imports marketing.
  - Two deliberate differences, both platform rules for periodic tasks:
    - a failing Drive status check no longer fails the whole project pass;
    - with `ORBIT_MODULES` on and marketing off, no retry runs.
- **Slack.** Its inbound route already belonged to marketing (WP2.1f). A signed interaction is now refused with `MODULE_DISABLED` while marketing is off, only after signature and identity mapping. Nothing is consumed, so the same button works once marketing is on again.

**Verification (local).**
- Full suite: 153 files and 1384 tests.
- New tests:
  - the Drive retry: no Drive, due versus later assets, the attempt limit, the 30-second throttle, `markSyncFailed` after a failed save, and the wake-up;
  - the Slack interaction while marketing is off (mutation-checked).
- The Drive mocks of three suites follow the new paths. The periodic task order now includes the retry.
- The OpenAPI document is unchanged. Typecheck and source check pass; boundaries: 0 known violations.

## Connections registry: WP2.5c (2026-10-14, local)

Branch `claude/wp25c-connections`, the third part of WP2.5. The platform owns the credential vault and capability states; marketing contributes the providers.

- **Platform (`platform/connections/connections.ts`).**
  - `CONNECTION_KIND`, `connectionVerified(status)`, `connectionsOf(tx, scope, provider)` and `decryptCredential(connection)`.
  - The types of a connection provider (`normalize`, `check`, `checkUnsupported`).
- **Actions.** `connector` (create) and `connector-health` (check) are platform actions that dispatch to the provider:
  - the provider list of `connector` comes from the registry, in the former order (postiz, matomo, slack);
  - `connector-health` moved from marketing; the provider call still runs outside any transaction, with the version check `CONNECTOR_CHANGED` before writing.
- **Marketing (`publishing/connection-providers.ts`).** Postiz (base URL normalization and the channel and group check), Matomo (the site report check) and Slack (`SLACK_DELIVERY_TEST_REQUIRES_AUTHORIZATION`), moved unchanged.
- **Call sites.** 22 hand-written decryptions and `read_verified`/`write_verified` checks in marketing and `server.ts` now use the helpers.
  - Stored formats are unchanged: `connectors` rows, `encryptedCredential` with AES-256-GCM.
  - The capability transitions (Postiz write verification, assignment health) stay marketing semantics. A generic `setCapability` was not needed.
- **Module activation (WP2.4).** With `ORBIT_MODULES` on, creating or checking a connection of a disabled module's provider answers `404 MODULE_DISABLED`.

**Verification (local).**
- New suite `connections.integration.test.ts`. The two actions had no integration test until now.
  - It covers encrypted storage that never returns the credential, Postiz normalization, unknown provider and non-HTTPS, the Postiz check with a missing groups API, the Matomo check for its site, the refused Slack check and the disabled module.
  - Provider clients are mocked.
  - The first four tests also pass against the code before WP2.5c (characterization).
  - The module check is mutation-checked.
- Registry tests: provider order and owner, duplicate providers.
- `module-registry.test.ts` now also resolves exported kind constants.
- Full suite: 152 files and 1381 tests. The OpenAPI document is unchanged. Typecheck and source check pass; boundaries: 0 known violations.

## Notifications as a platform transport with module kinds: WP2.5b (2026-10-14, local)

Branch `claude/wp25b-notifications`, the second part of WP2.5. The owner's bot notifications are split by owner.

- **Platform (`platform/notifications`).**
  - `notify(tx, scope, kind, ref)` queues the job. It throws for an unregistered kind.
  - `telegramLinked` checks for a bound bot.
  - The sender moves without changes: retries and backoff, `retry_after`, photo fallback, the `TELEGRAM_DELIVERY_FAILED` exception and the recorded outcome.
  - The `telegram_notification` queue class is now platform-owned, still with `runWhilePaused` and a 180-second lease.
- **Marketing.**
  - It registers its 15 kinds (`NOTIFY_KINDS`) with a renderer as `notifications` (`notification-messages.ts`, renamed from `notification-sender.ts`).
  - A preview's image is read by a loader the platform calls outside the transaction, as before.
  - `notify` in `agents/notifications.ts` stays as a typed wrapper, so its callers are unchanged.
  - The daily report planning and `reportBlockedPost` stay in marketing.
- **Registry.** Kinds must match `[a-z_]+` and be unique across owners. Job keys `notify:<kind>:<ref>` and every text are unchanged, so jobs queued before the deploy are sent as before.
- **Module activation.** With `ORBIT_MODULES` on, a notice of a disabled module is skipped as `MODULE_DISABLED`. The job is no longer blocked by the worker, because its queue class belongs to the platform.

**Verification (local).**
- Full suite: 151 files and 1375 tests. It includes every notification suite (`agent-notifications`, `assignment-postiz-drafts`, `assignment-shared-posts`) and the new tests below.
  - Kind registration and owner of the queue class.
  - Duplicate and invalid kinds.
  - The skip of a disabled module's notice, which is mutation-checked.
- The OpenAPI document is unchanged. Typecheck and source check pass; boundaries: 0 known violations.

## Telegram transport on the platform, buttons routed by prefix: WP2.5a (2026-10-14, local)

Branch `claude/wp25a-telegram-callbacks`, the first part of WP2.5. The owner's Telegram bot becomes platform code: `modules/telegram.ts` moves to `platform/connections/telegram.ts`. The known import-boundary violations drop from 2 to **0**.

- **Callback router.** `callback_data` is dispatched by its prefix to the handler that the platform or a module registers as `telegram.callbacks` (`platform/connections/types.ts`).
  - The platform registers `pause:`, the `/pause` confirmation.
  - Marketing registers `stop:`, the veto of an assignment post (`modules/marketing/agents/telegram-stop.ts`).
  - Prefixes must be short lowercase words and unique; the registry refuses anything else.
  - Unknown or unverifiable data is answered and audited as before.
- **Unchanged formats.** Both data formats, the MAC key and every answer text are byte-identical, so buttons that are already sent keep working. A test pins the Stop format against an independent computation.
- **The bot's switch.** Today it is Orbit Agents (`ORBIT_AGENTS`). Marketing now contributes it (`telegram.enabled`), so the platform no longer reads a marketing flag.
- **Module activation (WP2.4).** With `ORBIT_MODULES` on, a button of a disabled module is rejected like an invalid one; `/pause` keeps working.
- **Signing helpers.** The platform exports `callbackMac`, `compactUuid` and `expandUuid`, so modules sign their callback data the same way.

**Verification (local).**
- Full suite: 151 files and 1373 tests.
  - New registry tests: assignment of `pause`/`stop`, prefix rules, the switch.
  - New Telegram integration tests: the Stop format pin, and Stop ignored while marketing is off while `/pause` still works.
  - Both are mutation-checked.
- The OpenAPI document is unchanged. Typecheck and source check pass, and the boundary check reports 0 known violations.

## Module activation enforced behind ORBIT_MODULES: WP2.4 (2026-10-14, local)

Branch `claude/wp24-enforcement`. With `ORBIT_MODULES=true`, a module an owner turns off is hidden and blocked everywhere, and nothing is deleted. With the flag off (the default) nothing changes. Behaviour, risk analysis, rollback and rollout: `docs/MODULE_ACTIVATION.md`.

- **API.**
  - Module routes under `/api/projects/:projectId/…` get a guard per owning module, after the membership check.
  - Actions and generic collections check the owner of the action or kind.
  - A disabled module answers `404 MODULE_DISABLED`.
- **Assistant.** Tools, prompt fragments and conversation sections of a disabled module are left out. When no enabled module gives instructions, a short platform prompt is used.
- **Jobs.**
  - The sweep skips a disabled module's scheduler and periodic tasks.
  - The worker stops such a module's job before claiming it: `blocked_dependency` with `MODULE_DISABLED`, which the existing `retry` action restarts. This deliberately deviates from the planned `skipped_module_disabled`.
- **Contributions registry.** It records the owner of every tool, action, job and periodic task, and the getters take the set of enabled modules.
- **Web.**
  - New tab **Settings → Modules**: state, dependencies, owner toggle with confirmation, and the dependency errors in plain words.
  - The shell takes navigation, home sections, chat parts, inbox views, settings sections and connector providers only from enabled modules.
  - Module pages show a notice. A platform page can name a module it needs (`requiresModule`): approvals needs marketing.
  - The page remounts on a switch, so section hooks keep their order.

**Verification (local).**
- Full suite with the flag off: 151 files and 1370 tests, including the new suites `module-enforcement` (API) and `module-disabled` (worker), and web tests for the Modules tab and the route gate. All of them are mutation-checked.
- Prompt snapshots unchanged. The OpenAPI document is unchanged.
- Typechecks, source and boundary check (2 known violations, both `telegram.ts`, WP2.5), and a web production build.
- Visual check against a synthetic mock API: turning marketing off hides its navigation, home section, settings tabs, connector providers and the approvals page; turning it on restores them.

## Settings, connectors and tools split by owner: WP2.3b (2026-10-14, local)

Branch `claude/wp23b-settings`, the last part of WP2.3. The web platform imports no module component anymore; the known web boundary violations drop from 5 to 0. Pages, order and texts are unchanged.

- **`management.tsx`** shrinks from 2227 to about 900 lines. Moved unchanged:
  - `Analytics` and `Memory` → `modules/marketing/insights.tsx`;
  - `PolicyEditor`, `AutopilotSettings` and `PostizChannelAssignment` → their own marketing files;
  - `RecordDetail` → `platform/ui/record-detail.tsx`. Its kind-specific actions (preferences, experiments, memory, metric correction) become a slot that marketing fills (`record-actions.tsx`).
- **`operator-tools.tsx`** split by owner:
  - Matomo import and schedule, and Postiz verification → marketing;
  - index management and fact withdrawal → knowledge;
  - workspace pause stays in the platform.
- **`advanced.tsx` / `lifecycle.tsx`.** `ProjectAdministration` and `RetentionControl` move to the platform, as planned in `04` §5.
- **Project settings.** Modules contribute settings sections (`settings`): marketing contributes "Assignments"/"Autopilot", "Policy & budget" and "Brand".
  - The platform keeps "Project", "Policy & budget" (retention) and "Integrations".
  - Module sections show above the platform content of a tab, as the policy did above the retention.
  - Section hooks run in fixed registry order, so the assignments list is still loaded once.
  - The overview's "Set budget and routine boundaries" is a contributed setup link that opens the policy editor through a portal, outside the link list's styles.
- **Connectors page.** Modules contribute providers (`connectors.providers`) with details, actions, a check label, extra form fields or their own configuration dialog, plus extra cards. Marketing contributes Postiz, Matomo and Slack, and the blog and newsletter cards. The platform renders the generic frame in the same order: providers, Telegram, extras.

**Verification (local).**
- Web component tests: 19 files, 89 tests, including a test that pins the contributed tabs and providers.
- Web and API typechecks, a typecheck of the Playwright specs, a web production build, and the boundary check (2 known violations, both `telegram.ts`, WP2.5).
- Visual check against a synthetic mock API:
  - the connectors page: order, Postiz details and actions, the Matomo site ID field, the Slack dialog;
  - the settings tabs and their order, the policy editor dialog (styled, in `body`), the policy and brand tabs;
  - the analytics and memory pages.
- `Operations` is unchanged text for text.

## Chat and inbox parts as module contributions: WP2.3c (2026-10-14, local)

Branch `claude/wp23c-cards`. The platform chat and the approvals inbox no longer import marketing components.

- **Decide hook.** `platform/assistant/decide.ts` (`useDecideActionRequest`) replaces the three decide calls: start a package, decide an assignment in the chat, decide in the inbox. The request bodies are unchanged; `imageRightsConsent` is sent only when given, as before. A test pins the four body shapes.
- **Chat extensions.** Web module manifests can contribute chat parts (`platform/assistant/extensions.ts`):
  - message card renderers by kind;
  - a section below the messages;
  - a `busy` check that keeps the conversation refreshing.
- **Inbox renderers.** Manifests can contribute inbox renderers by action type.
- **Marketing's contribution** (`modules/marketing/chat-extension.tsx`) moves the package handlers (start, cancel, image rights, attach image, unschedule) and the assignment card logic out of `chat.tsx` unchanged. It registers the `assignment` card, the package section, the package `busy` check and the `assignment.confirm` inbox view.
- **`chat.tsx`** lends a `ChatHost` (conversation, pending state, `run` with the same pending, error and refresh handling as the former handlers). It is 150 lines shorter.
- **Boundaries.** Known web violations drop from 8 to 5; all 5 left are in `management.tsx` (WP2.3b).

**Verification (local).** Web component tests (18 files, 87 tests, including the new hook and extension tests), web and API typechecks, a typecheck of the Playwright specs, a web production build and the boundary check (7 known violations, none new). The package and assignment cards in the chat are covered by Playwright `chat.spec.ts` in CI.

## Marketing and knowledge web components in their module folders: WP2.3a (2026-10-14, local)

Branch `claude/wp23-web-marketing`, the first part of WP2.3 (marketing web module). Files move unchanged apart from import paths:

- To `apps/web/src/modules/marketing/`: 13 marketing components with their 7 tests: `work`, `advanced`, `assignments`, `assignment-card`, `agent-activity`, `editorial`, `calendar-blocks`, `draft-cleanup(-panel)`, `autopilot-approvals`, `chat-package-card`, `lifecycle`, `slack-connection`.
- To `apps/web/src/modules/knowledge/`: `knowledge.tsx`.

Further notes:
- Importers use the new `@/modules/...` paths; no re-export is left.
- `apps/web/src/components/` now holds only platform UI. The boundary zones say so: the folder is web platform, and the module zones are their folders.
- The 8 known web violations are the same imports under new paths: `chat`, `action-request-inbox` and `management` import marketing. WP2.3b and WP2.3c remove them.

**Verification (local).** Web and API typechecks, web component tests (17 files, 95 tests), a typecheck of the Playwright specs, a web production build (`next build --webpack`) and the boundary check (10 known violations, none new).

## The assistant as platform code with marketing contributions: WP2.2 (2026-10-14, local)

Branch `claude/wp22-assistant`, work package WP2.2. The assistant (conversations, runs, the tool loop, prompt composition) is platform code; marketing contributes to it. The prompt and the tool definitions are byte-identical.

- **Prompt composition.** The chat runner takes tool features, prompt fragments and proposal validation codes from registered `assistant` contributions (`platform/assistant/types.ts`). It adds the tool search line itself.
  - Marketing contributes its prompt unchanged (`modules/marketing/assistant/prompt.ts`): the operator persona and rules, the package fragment, and the assignment fragment or the "not available" fragment.
  - The base prompt interleaves marketing, knowledge and platform rules. Splitting it by owner would change the prompt, so that waits for an evaluated prompt change (plans `03` §6.4).
- **Cards and read tools.** The card shapes move to `platform/assistant/cards.ts`. The read tool implementations (`project_status`, `knowledge_search`, `approved_assets`, `analytics_memory`) move unchanged to `modules/marketing/assistant/chat-tools.ts`. `knowledge_search` goes to the knowledge services in WP3.2; module sections of `project_status` come with the platform home.
- **Proposals.** `validateDraftMission`, `createProposal` and `confirmProposal` move unchanged to `modules/marketing/assistant/proposals.ts`. Marketing registers `POST /chat/proposals/:id/confirm` at the same path. The `ChatProposal` table stays the platform's assistant storage.
- **Conversation read.** The conversation read adds marketing's packages and assignments through a registered `conversationSections` contribution instead of two lazy imports. The response fields keep their order.
- **Imports.** `chat.ts` enqueues chat jobs through the platform's `enqueue`.
- **Boundaries.** The known import-boundary violations drop from 22 to 10. The 2 left on the server are `telegram.ts` (WP2.5); the 8 web ones belong to WP2.3.

**Verification (local, isolated test database).**
- Full suite: 145 files, 1354 tests.
- `assistant-request.characterization` is unchanged: the hashes for every role and flag combination, and the full text of the smallest and the largest owner setup. Mutation check: one extra space in the prompt fails both tests.
- The OpenAPI document (sorted keys) is identical.
- API and web typechecks pass.
- The Playwright `chat.spec.ts` runs in CI.

## Orbit Agents runner in the marketing module: WP2.1f-3c (2026-10-14, local)

Branch `claude/wp21f3c-runner`. The specialist runner (`runner.ts`) and its types move from `modules/agents/specialists/` to `modules/marketing/agents/specialists/`. The boundary checker no longer counts them as platform. The old paths re-export.

- **Why the runner moves whole.** Plan `04` sketched a platform "runner core". Its generic parts are already in the platform: the runtime port, the budgeted model and the Responses runtime, all in `agents/runtime` since WP1.1. What the runner still holds is Orbit Agents logic:
  - claiming and recovering `agent_tasks`;
  - budgets per assignment run;
  - assignment refusal and exhaustion;
  - the veto schedule and notifications.

  Those entity kinds are marketing's (`04` §2.3).
- **When to extract a core.** A generic agent core for a second module (Support AI, WP5.6) is worth extracting when that module needs it. This is a deliberate deviation from the plan's sketch.
- **Unchanged.** No code changed beyond import paths. The review eval's prompt hash (`evals/agents/code-version.ts`) is unchanged; the offline review eval passes.
- **Boundary violations.** Five known platform → marketing imports are resolved, so the baseline drops from 27 to 22. The 14 remaining platform → marketing imports are in `chat`, `chat-runner` and `chat-tools` (WP2.2) and in `telegram` (WP2.5).

**Verification (local, isolated test database).** Full suite: 145 files, 1354 tests, including the offline agent and operator evals. API and web typechecks pass. Boundary check: 22 known violations, none new.

## Readiness, channel names and Drive state without platform imports of marketing: WP2.1f-3b (2026-10-14, local)

Branch `claude/wp21f3b-contributors`. Six known platform → marketing imports are resolved, so the baseline drops from 33 to 27. Behaviour is unchanged.

- **Readiness.**
  - `readiness.ts` and `action-readiness.ts` (with its test) move to `modules/marketing/readiness/`. They are marketing's go-live readiness: policy, publisher, channels and Drive-backed posts.
  - Marketing registers them as the readiness provider (`readiness` contribution, at most one).
  - The dashboard, the assistant's project status and the policy activation read it through `platform/governance/readiness.ts` (`projectReadiness`).
  - Splitting readiness by owner would reorder the blockers. That is left for the platform home.
- **Channel names.** The owner's decision list (`listActionRequests`) gets channel names from registered channel directories. Marketing contributes the Postiz one. Before, the list imported Postiz code.
- **Drive state.** `driveReconnectRequired` moves to the platform's Drive connection (`google-drive.ts`); marketing's `drive-readiness` re-exports it.
- **Assets.** `assets.ts` (bytes, normalization) is classified as platform in the boundary checker, as planned (`04` §2.1, later `platform/files`). It imports nothing from marketing.

**Verification (local, isolated test database).**
- Full suite: 145 files, 1354 tests. API and web typechecks pass.
- Boundary check: 27 known violations, none new.
- Mutation check: without the channel directory, the action request and package schedule tests fail on the channel names.

## Marketing routes as a module contribution: WP2.1f-3a (2026-10-14, local)

Branch `claude/wp21f3-routes`, the third part of WP2.1f. The marketing module now registers its own HTTP routes (`routes` contribution, `platform/http/routes.ts`). There are 21 routes, moved unchanged from `server.ts` and registered at the same paths:

- Slack interactions
- content export and `PATCH content/:id`
- the marketing profile
- the ten Orbit Agents routes
- brand asset upload and content, Drive retry, image generation
- the three content package controls

Further notes:
- The platform hooks apply to these routes as before: origin check, rate limits, error mapping, and the Orbit Agents gate on the matched route pattern.
- Some routes stay in `server.ts` for now: dashboard, operations, Google Drive connection, chat, action requests and the generic collections. Some of them become the platform home and connections work (WP2.5, Phase 4).
- `server.ts` is down to 1165 lines; it was 2340 before WP2.1f.
- The OpenAPI document generated with sorted keys is identical before and after: 68 paths, the same definitions.
- The access matrix is unchanged.
- The import-boundary baseline is unchanged at 33.

**Verification (local, isolated test database).** Full suite: 145 files, 1352 tests. API and web typechecks and the boundary check pass.

## Project actions as module contributions: WP2.1f-2 (2026-10-14, local)

Branch `claude/wp21f2-actions`, the second part of WP2.1f. The if-chain of `POST /api/projects/:projectId/actions/:action` in `server.ts` (65 actions, about 760 lines) is replaced by handlers that the platform and the modules register.

- **`platform/http/actions.ts`:** `ActionHandler` comes in two kinds. `sharedTransaction` runs in the project transaction the route opens. `ownTransaction` covers handlers that open their own transactions or none: provider calls, Drive reads that need the project lock, hybrid retrieval. Twelve actions keep `ownTransaction`, as before.
- **Handler bodies, moved unchanged:**
  - Platform (`platform/http/platform-actions.ts`): `add-member`, `project-settings`, `openai-configure`, `connector`, `pause`, `retention`, `resolve-exception`.
  - Knowledge (`modules/knowledge/actions.ts`): 15 actions. They still call the knowledge services where they live today (WP3.3 moves them).
  - Marketing (`modules/marketing/actions.ts`): the rest. That includes `connector-health`, whose Postiz and Matomo checks stay with marketing until the connections registry (WP2.5), although its permission is a platform one.
- **The route** keeps its order: permission check, body parse, then lookup. An unknown name still gets `400 ACTION_NOT_SUPPORTED`.
- **`server.ts`** shrinks by 864 lines (77 imports fewer).
- **Tests:**
  - The access matrix and the permission catalogue test now take the action names from the registry instead of parsing `server.ts`. The access matrix fixture is unchanged.
  - New registry tests pin the 65 names, one permission per action and the twelve `ownTransaction` actions.
  - Mutation check: switching `postiz-test-prepare` to the shared transaction fails that pin.
- The import-boundary baseline is unchanged at 33.

**Verification (local, isolated test database).** Full suite: 145 files, 1352 tests. API and web typechecks and the boundary check pass.

## Marketing agents and tools in the module folder: WP2.1f-1 (2026-10-14, local)

Branch `claude/wp21f1-agents`, the first of three parts of WP2.1f. Files move unchanged apart from import paths:

- The Orbit Agents files go to `apps/api/src/modules/marketing/agents/`: assignments, runs, veto, notifications, content packages, scheduling, banners and the rest, 20 files with 3 tests.
- The specialists go to `apps/api/src/modules/marketing/agents/specialists/`: analytics, research, strategy, copywriter, visual, review and `index`.
- The marketing assistant tools go to `apps/api/src/modules/marketing/tools/`: read, proposal, package, assignment, channel and agent tools, plus `index`.
- The platform parts stay where they are for now: the runtime shims, the tool registry, and the specialist runner core and types. WP2.1f-3 splits the runner and removes its marketing imports.
- The old paths keep one-line re-exports. They serve the worker and eval tests and the platform importers, including the two lazy `import()` calls in `chat.ts`.
- The `scheduling` mock in `assignment-veto` follows the move.
- The import-boundary baseline is unchanged at 33.

**Verification (local, isolated test database).** Full suite: 145 files, 1350 tests, including the offline agent and operator evals. API and web typechecks and the boundary check pass.

## Marketing brand and analytics in their module folders: WP2.1e (2026-10-14, local)

Branch `claude/wp21e-brand-analytics`, the fifth part of WP2.1. Files move unchanged apart from import paths:

- To `apps/api/src/modules/marketing/brand/`: `marketing-profile`, `image-generation`, `image-requests`, `render-asset`, `asset-tools`, `drive-readiness` (with its test).
- To `apps/api/src/modules/marketing/analytics/`: `matomo` (with its test), `matomo-schedule` and `lifecycle`. `lifecycle` is now only marketing memory, metrics and experiments, plus re-exports of the platform scheduler and retention. It leaves the platform zone of the boundary checker.

Further notes:
- The old paths keep one-line re-exports. They serve `evals/generation/harness.ts`, `evals/operator/offline.test.ts`, the worker's `due-marker` test and the platform importers.
- `asset-tools` reads the built-in EDS logo by a path relative to its own file. That path is adjusted. A new integration test reads the logo, and it fails with the old path.
- The import-boundary baseline is unchanged at 33.

**Verification (local, isolated test database).** Full suite: 145 files, 1350 tests. API and web typechecks and the boundary check pass.

## Marketing publishing in its module folder: WP2.1d (2026-10-14, local)

Branch `claude/wp21d-publishing`, the fourth part of WP2.1. Nine files and their five co-located tests move unchanged to `apps/api/src/modules/marketing/publishing/`:

`publisher`, `postiz-assignment`, `postiz-draft`, `postiz-verification`, `postiz-queue-watch`, `channel-rules`, `posting-slots`, `calendar` and `slack`.

- The old paths keep one-line re-exports. They still serve the platform importers and `evals/generation/harness.ts` (`resolveChannelRules`).
- Files in `modules/marketing/` import moved files by their new path.
- The `content-export` mock in the Postiz verification test follows the move. It still asserts the mocked Drive reads.
- No logic, route or response changes. The import-boundary baseline is unchanged at 33.

**Verification (local, isolated test database).** Full suite: 144 files, 1349 tests. API and web typechecks and the boundary check pass.

## Marketing policy in its module folder: WP2.1c (2026-10-14, local)

Branch `claude/wp21c-policy`, the third part of WP2.1. `policy.ts` (publishing preflight, claims, approvals, modes), `fact-claims.ts` and `fact-placeholders.ts` move unchanged to `apps/api/src/modules/marketing/policy/`, with their two tests.

- The old paths keep one-line re-exports. That covers `evals/generation/harness.ts`, which imports `checkClaims` from the old path.
- Files already in `modules/marketing/` import moved files by their new path, not through the re-exports.
- No logic, route or response changes. The import-boundary baseline is unchanged at 33.

**Verification (local, isolated test database).** Full suite: 144 files, 1349 tests. API and web typechecks and the boundary check pass.

## Marketing pipeline in its module folder: WP2.1b (2026-10-14, local)

Branch `claude/wp21b-pipeline`, the second part of WP2.1. The 15 pipeline files move unchanged to `apps/api/src/modules/marketing/pipeline/`, with their 6 co-located tests:

`workflow`, `generation`, `editorial`, `planning`, `draft-batch`, `draft-cleanup`, `draft-similarity`, `draft-statuses`, `content-export`, `content-invalidation`, `content-provenance`, `mission-archive`, `mission-evidence`, `paused-posts`, `autopilot`.

- Every old path keeps a one-line re-export, so importers are unchanged. Later parts switch the importers and remove the re-exports.
- Two tests mock the moved modules: `assignment-copywriter-visual` mocks `content-invalidation` and `postiz-verification` mocks `content-export`. They now mock the new path. That mock also reaches importers that still use the old path, and both tests assert the mocked behaviour.
- No logic, route or response changes. The import-boundary baseline is unchanged at 33.

**Verification (local, isolated test database).** Full suite: 144 files, 1349 tests. Typecheck and boundary check pass.

## Worker through the module registry: WP2.1a (2026-10-13, local)

Branch `claude/wp21a-marketing-move`, the first part of work package WP2.1 (marketing server move). The worker no longer imports module files; behaviour is unchanged.

- New contribution `periodic` (`PeriodicTask`): per-project work the worker runs after dispatching jobs, outside the sweep transaction, with an optional `nextDueAt` for the project's wake-up and an optional published `health` status. Marketing contributes, in the previous order:
  - `matomo-schedule`: saved Matomo imports.
  - `postiz-queue`: the read-only queue check. It still publishes to `orbit:postiz-queue:<instance>`, so `/api/health/postiz` is unchanged.
- New contribution `onWorkerStart`: marketing registers the agent specialists there. The API and the tests do not register them, as before.
- `runtime.ts` reads a periodic task's health through the registry (`periodicTaskHealth`) instead of importing marketing.
- The worker takes the sweep from `platform/jobs/scheduler.ts`.
- Known import-boundary violations: 33 (after WP1.8: 37). No worker → module import is left.

**Verification (local, isolated test database).** Full suite: 144 files, 1349 tests. That includes the Postiz health route test (`auth.integration`) and new registry tests for task order, the health summary, the start hook and duplicate names. The worker process itself was not started locally; the CI browser run starts it through `pnpm dev`.

## Pause, export and retention hooks: WP1.8 (2026-10-13, local)

Branch `claude/wp18-hooks`, work package WP1.8 of the modularization roadmap (ADR 0009). Project pause, export and retention become platform operations that modules extend. Behaviour is unchanged.

- **Pause** (`platform/governance/pause.ts`; `modules/pause.ts` re-exports it). The platform bumps the generation, ends waiting chat replies and audits. Modules add steps through `ProjectHooks` in the same transaction and at the same points as before. Marketing (`modules/marketing/hooks.ts`):
  - `onProjectPause` blocks publications and raises reconciliation exceptions;
  - `afterProjectPause` notifies the owner's Telegram bot, unless the bot asked for the pause itself;
  - `onProjectResume` puts held-back assignment tasks back on the queue.
- **Export** (`platform/governance/export.ts`). Owners declare entity kinds with `exported: false`: the platform for `connectors`, `telegram_connections`, `drive_connection` and `drive_oauth_state`, Knowledge for `evidence`. These are the same five kinds the hard-coded list held.
- **Retention** (`platform/governance/retention.ts`). The platform validates the period, asks each module's `retention` contribution to purge what expired, and writes one `retention.apply` audit entry. Marketing purges insights and preferences, unchanged (`modules/marketing/retention.ts`).
- Two platform → marketing imports in `pause.ts` are gone. Known import-boundary violations: 37 (after WP1.7: 39).

**Verification (local, isolated test database).**
- Full suite: 144 files, 1347 tests.
- New characterization test `project-operations.characterization.integration.test.ts`: export exclusions, retention result, statuses and audit. It passed before the change and after it.
- The pause suites (`chat-pause`, `paused-posts`, `telegram`, `agent-notifications`) and the access matrix are unchanged.
- Mutation checks:
  - Without the marketing hooks, 5 pause tests fail.
  - Without `exported: false` on evidence, the export test fails.

## Web shell and navigation: WP1.7 (2026-10-13, local)

Branch `claude/wp17-web-shell`, work package WP1.7 of the modularization roadmap (ADR 0009, AD-12). The web app gets one URL per page; the views themselves are unchanged.

**URL scheme.**
- `/` opens the last used project, else the only one, else a picker.
- `/o` lists organizations (server: workspaces), `/o/:orgId` their projects; owners create projects there.
- `/p/:projectId` is the project home; platform pages are `/p/:projectId/{assistant,approvals,connectors,operations,settings}`, module pages `/p/:projectId/knowledge` and `/p/:projectId/marketing/{missions,content,calendar,assets,analytics,memory}`. A module root opens its first page.
- The 13 paths from before (`/missions`, `/chat`, `/settings`, …) redirect into the last used project and keep query and hash, so bookmarks, the Telegram "In Orbit öffnen" link (`/approvals`) and the Google Drive callback (`/settings?googleDrive=…`) keep working. In-app links and the API's chat card links are rewritten to the open project.
- Unknown addresses show "Page not found"; a project the user cannot open shows "Project not available". Before, both silently showed the Overview.
- Switching the project keeps the page and changes the URL.

**Structure.**
- `apps/web/src/platform/ui/`: the shared view helpers and the form kit, formerly in `work.tsx` and `components/form.tsx`. This removes the `advanced.tsx` ⇄ `work.tsx` import cycle.
- `apps/web/src/platform/shell/`: route table (`routes.ts`, checked for conflicts at start), shell context, project home, pickers, not-found view.
- `apps/web/src/modules/{knowledge,marketing}/manifest.tsx`: web manifests (views, navigation entries, legacy paths, home section). They point to today's components; WP2.3 and WP3.3 move the components.
- `apps/web/src/modules/registry.ts`: the web composition root. The shell (`components/orbit.tsx`) imports no module; import-boundary violations drop from 45 to 39.
- Navigation and the project home hide modules that `GET /api/projects/:id/modules` reports as off; until that answer arrives, or if it fails, all modules count as on. A page of a module that is off shows a notice. The server does not enforce activation yet (WP2.4).
- Project home: the assistant prompt (the text opens in Orbit Chat for review; nothing is sent automatically), one tile per module with its pages, then the marketing overview.
- The mobile bottom bar comes from the manifests (`mobile` flag), in the old order.
- The stored language choice is no longer overwritten by the default during the first render.

**Verification (local).** Web typecheck, unit and component tests (16 files, 83 tests), import-boundary check and a production build of the web app (`next build --webpack`; Turbopack refuses the symlinked `node_modules` of this worktree). Manual check against a synthetic mock API: pickers, home, project switch, a project with marketing off, legacy redirect with query and hash, both not-found pages, 375 px without horizontal scroll, German labels. The Playwright suite (new `navigation.spec.ts`, updated `workspace.spec.ts` and `chat.spec.ts`) runs in CI; a local run needs an isolated browser database that was not set up here.

## Safety net for the modularization: WP0.2 (2026-10-13, local)

Branch `claude/wp02-safety-net`. This adds tests and a CI guard only; no product code changed. It is work package WP0.2 of `plans/orbit-modularization/07-roadmap.md` (decision baseline: PR #93, ADR 0009).

**RLS matrix (10 tests).**
- Every public table is classified. A new table fails until it is classified.
- FORCE RLS is required on all scoped and tenancy tables.
- The app role has no grants on auth, membership or system tables. The audit log is append-only.
- Unscoped reads return nothing.
- Each project sees its own seeded rows in all 18 scoped tables, and nothing of another project in the same or another workspace.
- Chat rows are private to their user.
- Cross-project updates and deletes change nothing, and cross-project inserts fail on RLS.
- Verified by temporarily disabling RLS on `Outbox` in `orbit_test`: 4 of the 10 tests fail, and the insert test then fails too.

**Access matrix.**
- 198 route, collection and action requests for 5 roles, pinned in `apps/api/tests/fixtures/access-matrix.json`.
- Invariants: callers without a session get 401 except on 7 public routes; a non-member never reaches a project route; no request is rate-limited, times out or returns a 5xx.
- Verified by removing `pause` from the owner list: the test reports the editor change.

**Worker queue dispatch.** The 7 queue classes without a dedicated test are pinned with their stop codes. Current behaviour, kept: a missing index generation (`INDEX_UNAVAILABLE`) uses all three attempts before it stops.

**CI.**
- `tests/setup.ts` fails under `CI=true` without the test database URLs and Redis, so a broken setup can no longer pass with 69 skipped integration files.
- `pnpm test:migration-profile` now runs in CI.

## Modular Orbit Platform: decision baseline (2026-10-13, docs only)

Mario accepted the modularization plan in `plans/orbit-modularization/` (documents 01–09) as the decision baseline. This was work package WP0.1, recorded in [ADR 0009](adr/0009-modular-platform.md).

The plan covers:

- Orbit Platform plus statically registered modules, with Marketing and Knowledge first;
- an own Support module with no Chatwoot dependency;
- a central MCP gateway under `https://orbit.eds-labs.io/mcp`. ADR 0007 has an addendum lifting the MCP non-goal.

No code, schema or deployment change was made. The next work package is WP0.2, the safety net: RLS and route × role matrices, worker smoke tests and a CI guard against silently skipped integration tests. Pre-existing findings are being fixed separately: F-01 in PR #91 and F-02 in PR #92.

## Assignment banners in the brand style (2026-10-12, local)

Review fix round (R79, commit after `60ebd02`): agent review authority does not cover banner posts with publish delivery (they wait for the owner until the review eval has banner cases; Postiz draft delivery unchanged); revisions keep the banner (`previousBanner`); banners stay tied to approved, unchanged background, logo and profile (key, save re-check under the run lock, `bannerState`); uploaded raster logo with verified bytes only; `BANNER_BRAND_OVERFLOW` at proposal and run time; per-banner render failures (`BANNER_RENDER_FAILED`); banners bound to their post and out of the library and pickers; banner claim words revised once, NFKC and script checks (`BANNER_TEXT_UNSAFE`); copies of media-capable channels keep the slot's banner when only the strictest channel refuses it (`BANNER_MEDIA_REFUSED`). DejaVu stays the font.

Branch `claude/assignment-banners` on top of package 1 (`d22e87e`), ruling R78, not pushed or deployed. Assignments gain the optional confirmed field `banner: {template: "brand_landscape", style?}` (social with `image: true` only, hashed only when set, needs the profile's approved logo). The visual step generates one landscape background per run (art only, banner style prompt), the copywriter writes structured banner copy per draft, and Orbit composes one 1600×900 banner per slot over the background with the new `brand_landscape` template in packages/creative (approved logo, wordmark, white and cyan headline, subline, outlined button, divider, footer domain; `TEXT_OVERFLOW` never cuts). The banner is an approved asset attached to the slot's drafts on every channel (R76) and delivered to Postiz unchanged. The review checks the copy deterministically (overflow revised once; figures, status, promises, links and an unofficial link rejected; a missing banner left for the owner), shows it to the review model as data and binds it in the agent review (`bannerHash`). Assignment tools, the card and the assignments page carry the banner. No route, schema migration or new dependency; the review prompt and the draft prompt of assignments without a banner are unchanged. Fonts: only DejaVu in the runtime image (Inter recommended, not added). Details: [OPERATIONS.md](OPERATIONS.md#orbit-agents).

## One post per slot across channels and assignment format (2026-10-12, local)

Branch `claude/assignment-shared-posts`, rulings R76 and R77, not pushed or deployed. Assignments gain two confirmed fields, both social only and part of the confirmation hash only when set (older confirmations stay valid): `sharedAcrossChannels` (one text and one image per slot for all channels: one brief per slot group on its strictest channel, one copywriter step, one review per text, then per-channel copies checked on their own channel and delivered as Postiz drafts or publications with the same text and image; a channel whose checks fail is dropped with a notice; one slot per channel stays held) and `format` (length, hashtags, paragraphs and an official CTA link; carried into the strategy input and the generation contract; deterministic review checks `FORMAT_LENGTH` and `FORMAT_HASHTAGS` with one deterministic revision, then reject). `assignment_propose`/`assignment_change`, the card and the assignments page carry both. No route, schema migration or new dependency; the review model's prompt (and so the review eval's hash) is unchanged. Budget check in R76: at 10 USD/month the shared mode keeps room for one revision per slot only narrowly, 20 USD/month comfortably. Fix round (same branch as the banners, R76/R77 addenda): a failure on the strictest channel only holds back that channel's post while the text goes to the others; a text left for the owner after a failed revision is copied to every channel; dropped and rejected shared texts are reported and counted per channel; verdicts are bound to the judged text; copies drop the image on channels without media support; the copywriter sees every shared channel's history; formats are checked against the channel limits (`FORMAT_EXCEEDS_CHANNEL_LIMIT`); length in UTF-16 units, digit-only tags are no hashtags; `format` and `banner` can be cleared from chat. Details: [OPERATIONS.md](OPERATIONS.md#orbit-agents).

## Assignment delivery as Postiz drafts (2026-10-10, local)

Branch `claude/assignment-postiz-drafts`, ruling R73, not pushed or deployed. Assignments gain the confirmed field `delivery` (`publish` default, `postiz_draft`). With `postiz_draft` Orbit never publishes: approved drafts (accepted agent review or the owner's release) are booked as `postiz_drafts` handoffs at their slot (the slot stays held) and sent by the new worker queue `postiz_draft` through the shared draft handoff of `postiz-draft.ts` (type `draft`, `outcome_unknown` never resent, existing resolve action); no publication, veto window, preview or publish right; preflight blocks publications of such content. Gated by `ENABLE_POSTIZ_DRAFTS` (`POSTIZ_DRAFTS_DISABLED` at proposal and confirmation, dropped deliverable with a notice at run time). Telegram notice `postiz_draft` per created draft, daily report line "Entwürfe an Postiz", "Anstehende Posts" shows "Entwurf in Postiz" without Stop, the card and the assignments page show the delivery, and `assignment_propose`/`assignment_change` set it. No route, schema migration or new dependency. Approval K now uses draft delivery. Details: [OPERATIONS.md](OPERATIONS.md#orbit-agents), ADR 0008 addendum 2026-10-10, [API contract](API_CONTRACT.md).

## Orbit Agents (2026-10-09, local, flag off)

Built on branch `claude/orbit-agents-spec` from the [Orbit Agents design](superpowers/specs/2026-10-09-orbit-agents-design.md) and its [plan](superpowers/plans/2026-10-09-orbit-agents.md), tasks 1–15; not pushed, merged or deployed. Everything is behind `ORBIT_AGENTS` (default `false`); with the flag off the existing chat, packages and weekly autopilot behave as before. Requirement mapping: [traceability](REQUIREMENTS_TRACEABILITY.md#orbit-agents-acceptance-2026-10-09). Operations: [OPERATIONS.md](OPERATIONS.md#orbit-agents). Rollout and approvals H–K: [rollout plan](plans/ORBIT_CORE_ROLLOUT_PLAN.md), Phase 7.

- Assignments (`Entity(kind="assignments")`): one-off and standing, social, blog or newsletter (report assignments are refused with `REPORT_NOT_AVAILABLE` until a report delivery exists, R70), with channels, times, topic frame, image, style references, veto window and monthly budget; draft until an owner confirms the exact content (`assignment.confirm`, ADR 0008 addendum), with the image-rights consent for image assignments. Orbit Core tools `assignment_propose`, `assignment_change`, `assignment_list`, `run_status` (deferred, need tool search).
- Runs (`assignment_runs`) per assignment and local date with a work plan; slots respect quota, spacing and calendar blocks across all assignments and the autopilot; DST-safe local times.
- Specialists on the `AgentRuntime` port (ADR 0005 addendum): analytics (Postiz and Matomo, honest `noData`), research (hosted web search, findings never become facts), strategy (one brief per slot from verified facts and 14 days of channel history), copywriter and visual as executor steps on the existing generation and image paths, review with deterministic checks first, one revision and the rules for drafts left to the owner. Worker queue `agent`, budget per call, task, run, assignment month and project; `outcome_unknown` never repeated.
- Channel history (`channel_posts`) from the Postiz post list, external and Orbit posts, 60 days, hourly at most; used by strategy, copywriter and the duplicate check.
- Veto window: approved posts get a publication with `vetoDeadline = slot − vetoMinutes`; late runs move to the next free slot; Stop withdraws before the handoff; agent review authority only under the conditions in the ADR 0008 addendum.
- Telegram bot: owner connection with encrypted token and one-time link code, webhook with secret header, previews with Stop, notices (including failed steps, dropped deliverables, blocked posts and drafts waiting for the owner's release, R70/R71), `/pause`, daily report at 20:00 local time; worker queue `telegram_notification`; delivery failures as `TELEGRAM_DELIVERY_FAILED` on the approvals page.
- Owner release (R70): drafts left for the owner (review left them, no bot, or agent review authority off) are listed under "Wartet auf deine Freigabe" on the approvals page; "Freigeben" (owner only) records the owner review, lets the mission publish exactly that post and schedules it at the run slot without a veto window (or the next free slot that day; else `SLOT_UNAVAILABLE`). `run_status` reports posts, drops, drafts waiting for the owner and stops from the run's scheduling and publications.
- Web: settings tab "Aufträge", the confirmation card with consent (chat and inbox), Telegram under Connections, "Anstehende Posts" with Stop and "Wartet auf deine Freigabe" with "Freigeben" on the approvals page.
- Autopilot replacement (task 15): with the flag on the sweep plans assignment runs instead of the weekly autopilot; once the Orbit Agents route answers (an outage keeps the autopilot), the autopilot tab and its approvals panel give way to a migration card that proposes the saved autopilot settings as a draft assignment (`…/assignments/autopilot-migration`), confirmed like any other. The settings stay unchanged, so a flag-off restores the autopilot.
- Migration `202610090001_agent_run_kind` (additive). New config `ORBIT_AGENTS`, `ORBIT_IMAGE_REFERENCES`, `ORBIT_AGENT_REVIEW_AUTHORITY` (all default `false`, passed through `docker-compose.yml`; the last is the gate of the review agent's authority, set only after Approval J).
- Verification on 2026-10-09 (Node 24.18.0, local PostgreSQL and Redis): lint, typecheck, 998 tests in 109 files, production build, Coolify compose check and secret scan pass. Offline only: recorded model outputs and fake Telegram and Postiz; no paid call was made.
- Open before live use: the live run of the review eval set (`evals/agents/review-v2.json`, Approval J, OA10 PASS_LIVE on 2026-10-10 in run 3 at $0.075 after the harness was given a brief the drafts follow — the diagnosis showed runs 1–2 rejected good drafts for a mismatched test brief; `ORBIT_AGENT_REVIEW_AUTHORITY` is turned on by Mario in Coolify; history: run 1 on `review-v1` on 2026-10-09 FAILED at $0.08: no bad case approved, but 7 of 8 good cases rejected after a `revise` for one sentence without a backing fact; per Mario's decision, invitations, questions and calls to action that state nothing about the product, brand or offer need no fact, which the review prompt and `review-v2` now follow; run 2 on `review-v2` on 2026-10-10 FAILED at $0.12: no bad case approved, but only 3 of 8 good cases approved (`good-needs`, `good-reply`, `good-your-team`, `good-tag` rejected after a round-1 `revise`, `good-question-planning` in round 1), diagnosis pending; the runner `pnpm eval:agent-review` exists with dry run, 2 USD ceiling, round 2 after a revision and a confirmation bound to the review prompt, plus a diagnostic mode (`ORBIT_EVAL_DIAGNOSE=good`: good cases only, 0.5 USD ceiling, the model's reasons written only to `.runtime/`, never a gate result) and an optional key from the macOS keychain, see `evals/agents/README.md`, and Mario runs it with his key), the live check of reference images (`ORBIT_IMAGE_REFERENCES`), the web search fee default of 10,000 micros per call and the reserved search content of 8,000 input tokens per search (both to be confirmed by Mario), the joint test round (spec §13). Follow-up for Mario: report assignments need a delivery (findings to the bot and a chat card) before `report` is accepted again (R70, I6). Deferred by rulings: the model-written style description (a deterministic one is used, R40), a daily report while the project is paused (none is sent), a paused and resumed day is not re-planned (R55).

## Orbit Core in production (2026-10-08)

Orbit Core (Jarvis Mode) is released: integration PR #51 merged on 2026-10-03 (`c3a1d07`), followed by fixes and features #52–#68 (latest `e8a0eeb`, deployed by Coolify). The [rollout plan](plans/ORBIT_CORE_ROLLOUT_PLAN.md) records each phase, finding and approval; this section is the summary.

- Flags: `ORBIT_CONTENT_PACKAGES=true` since 2026-10-05 (Approval C), `ORBIT_TOOL_SEARCH=true` since 2026-10-06 (Approval E, chat route `gpt-6.1-sol`). Both are passed to API and worker by `docker-compose.yml` (#52).
- Accepted in production: package card, start, drafts with passing review, revision of one channel, "next week" slots (JC05), package image with owner rights approval and attachment (Approval D), tool search (its steps are visible under Operations since #63), different package texts per channel (#64), the runtime port (#65, Approval G).
- Phase 5: Mario approved the first live package post (Approval F) — the beta post on X for 2026-10-12 17:00 (Europe/Berlin), one publication `intent_created`; a second proposal was canceled from the card before approval. The check after the slot is open.
- Fixed from production findings: compose flags (#52), profile audience length and validation codes (#53), duplicate identical facts (#54), the first policy-allowed official link (#55), package fact keys (#56), single-word fact claims (#57), approved-image badge and the `source-map-js` advisory (#58), "approve all" past missed slots (#59), autopilot drafts that repeated an earlier day (#60), stopped posts after a pause and missed slots (#62), the `sharp` advisory (#66), chat while paused (#67), channel names in decisions and closable exceptions (#68).
- The uLiquid project was paused on 2026-10-06 and resumed on the same day with Mario's approval; the posts stopped by the pause stay blocked until the owner schedules them again on the approvals page.
- Known: the login cookie expires 8 hours after sign-in although the session is meant to slide; a fix needs Mario's approval (auth change).
- Not built: voice (J4, JC18) and an honest "no analytics measurements" answer (JC19).

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
- Orbit Core / Jarvis Mode (accepted 2026-10-02, [plan](plans/ORBIT_CORE_JARVIS_PLAN.md); released 2026-10-03, see "Orbit Core in production" above). One chat request becomes a content package: one draft-only mission per channel and an optional owner-approved image, started with one click, reviewed with the existing claim checks, shown as one card, cancelable, and revisable per channel. Slices: PR0 worker chat jobs run with the requesting user's current role (`ACTOR_MEMBERSHIP_REQUIRED` otherwise); PR1 `ActionRequest` core (`Entity(kind="action_requests")`) and a single-attempt worker image executor; PR2 package request, plan and one-click start; PR3 image, review, cancel and partial results; PR4 targeted revision; S1 `AgentRuntime` port with the legacy loop; S2 Agents SDK spike, no-go (ADR 0005 addendum); PR5 operator evals (`evals/operator/`) and acceptance rows JC01–JC20 (17 PASS_TEST, 3 NOT_RUN, fake providers only; JC06 covered by a real-Redis worker crash and restart test); J3.0 slot overview (`schedule_options`); J3.1 scheduling by owner decision (`propose_schedule`, action type `content.schedule`, [J3 plan](plans/ORBIT_CORE_J3_SCHEDULING_PLAN.md)); J3.2 the weekly autopilot skips days that scheduled posts already fill; J3.3 the rights-approved package image can be attached per draft; J3.4 scheduled package posts can be canceled before the handoff and moved with a new owner decision; J3.5 operator evals `cases-v2.json` for scheduling. Client-executed tool search for Orbit Chat behind `ORBIT_TOOL_SEARCH` (ADR 0007 addendum; live check pending). Merge and rollout: [plan](plans/ORBIT_CORE_ROLLOUT_PLAN.md), proposed, awaiting approvals A–G. Everything new is behind `ORBIT_CONTENT_PACKAGES` (default `false`) except PR0 and the J3.2 autopilot skip. No migration. Not yet: merges to `main`, the production flag, and a paid live acceptance run; each needs its own approval.
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

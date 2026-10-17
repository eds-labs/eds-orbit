# Phase 4: Platform Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that a third module plugs in through the contracts alone (WP4.1), then add the platform capabilities the Support module needs: public ingress, real-time, module roles, files, e-mail and notifications (WP4.2–WP4.7).

**Architecture:** Every capability lives in `apps/api/src/platform/*` and is used by modules through registries and contracts (ADR 0009). A test-only fixture module `tasks` exercises the contracts first and serves as the consumer of later capabilities.

**Tech Stack:** TypeScript (Node 24), Fastify, Prisma/Postgres with RLS, Redis, Vitest, Next.js.

**Spec:** `plans/orbit-modularization/07-roadmap.md` §Phase 4, `06-support-readiness.md` (S-R4–S-R8), `03-module-contracts.md`, ADR `docs/adr/0009-modular-platform.md`.

## Global Constraints

- Production stays unchanged in every work package: no customer-facing feature uses the new capabilities until Phase 5.
- Every production deployment and every production migration needs Mario's explicit approval for that step.
- Approval gates before implementation, not only before deploy:
  - **WP4.2 public ingress** and **WP4.5 module roles**: risk class high, with a security review.
  - **WP4.6 files**: a new bucket and new credentials (a secrets change, Q-19).
  - **WP4.7 e-mail**: a new external provider (Q-16) and a DNS change for SPF, DKIM and DMARC.
- The boundary baseline stays 0. The fixture module lives under `apps/api/tests/` and is never registered in production.
- Code comments and docs are in English.

## Review Focus

1. **The fixture module leaks into production registration.** `registerTestModules` must be the only way in, and API and worker startup must never call it. Pinned in Task 1: the default `moduleRegistry()` has exactly knowledge and marketing.
2. **A disabled third module still contributes something.** Its route, collection, tool, scheduler or action type must not reach a project that has the module off. Pinned in Task 2.
3. **A viewer reaches a module write.** Covered for the tool offer, the route permission and the ActionRequest decision. Pinned in Tasks 2 and 3.
4. **Approving one ActionRequest executes the other.** Each request carries its own payload hash. Pinned in Task 3.
5. **Platform types close the door on modules.** `ToolNamespace` was a closed union; a module tool needs an own namespace. Found in Task 1 and opened there.

---

## WP4.1 Extensibility test suite (detailed)

Risk: low (tests plus one test-only hook and one type widening). Rollback: revert.

### Task 1: Fixture module `tasks` and the registry test hook

**Files:**
- Create: `apps/api/tests/fixtures/modules/tasks/manifest.ts`, `apps/api/tests/fixtures/modules/tasks/contributions.ts`
- Modify: `apps/api/src/modules/registry.ts` (`registerTestModules`)
- Modify: `apps/api/src/modules/agents/tools/registry.ts` (`ToolNamespace` is open to module namespaces)
- Test: `apps/api/tests/extensibility.integration.test.ts`

**Interfaces:**
- `registerTestModules(extra: ReadonlyArray<{ module: ServerModule; contributions: ModuleContributions }>)`: test only. It resets the memoized registry, so the next `moduleRegistry()` or `registerModules()` includes the extra modules.
- The fixture `tasks` module:
  - id `tasks`, `dependsOn: []`, kind `fixture_tasks`;
  - permissions `tasks.read` (owner, editor, viewer) and `tasks.manage` (owner, editor);
  - route `GET /api/projects/:projectId/fixture-tasks` (`tasks.read`);
  - tool `propose_tasks` (namespace `tasks`, risk `P_proposal`, permission `tasks.manage`): it creates one ActionRequest `tasks.create` per task;
  - action type `tasks.create` (decider editor, payload `{ title }`, on approval it creates a `fixture_tasks` row);
  - a scheduler contribution that counts its sweeps.

- [ ] Failing test: "registers a third module through the contracts alone". It covers the validated order (knowledge, marketing, tasks), the kind owner, the tool owner, the action type, the scheduler set and the route, and that the default registry, without the hook, has exactly knowledge and marketing.
- [ ] Implement the hook and the fixture; widen `ToolNamespace`.

### Task 2: Activation and permissions over HTTP

- [ ] Failing scenarios in `extensibility.integration.test.ts`, with `ORBIT_MODULES=true`. Owner, editor and viewer sign in (three sign-ins at most per file).
  - Owner, editor and viewer read `/fixture-tasks` (200). A member of another project gets 404.
  - Switching `tasks` off: the route and `GET /fixture_tasks` answer 404 `MODULE_DISABLED`, `registeredTools(enabled)` has no `propose_tasks` and `registeredSchedulers(enabled)` has no tasks scheduler. Switching it on restores everything.
  - `availableTools` offers `propose_tasks` to owner and editor, not to the viewer.

### Task 3: Assistant run across three modules

**Files:** `apps/api/tests/extensibility-assistant.integration.test.ts`, using `apps/api/tests/support/package-project.ts` and a scripted `streamChat` as in `chat-runner.integration.test.ts`.

- [ ] Failing test: the editor's chat run calls `knowledge_search`, then `recent_content`, then `propose_tasks` with two tasks, then answers. The result is two pending `tasks.create` ActionRequests with different payload hashes.
  - The viewer cannot decide them (`EDITOR_REQUIRED`).
  - The editor approves one; exactly one `fixture_tasks` row exists and the other request stays pending.
  - No marketing or knowledge record changes.

### Task 4: Docs and checks

- [ ] `docs/IMPLEMENTATION_STATUS.md`, `docs/MODULE_ACTIVATION.md` (how a module plugs in; the test hook).
- [ ] Full suite, `tsc`, source check (the tests are excluded from the boundary zones), OpenAPI unchanged.

---


## WP4.4 Cross-module operator eval (detailed)

Risk: none (offline eval). It builds on WP4.1's fixture module.

- **Dataset.** `evals/operator/cases-v3.json`, a new dataset, so the v1 and v2 hashes stay comparable:
  - JC30: cross-module tool choice, ending in two ActionRequests.
  - JC31: a viewer gets no module write, and a forged call is refused.
  - JC32: a switched-off module offers nothing.
  - JC33: with every module off, only the platform's `knowledge_search` is offered.
- **Harness.** `disabledModules` (switched off in order, with `ORBIT_MODULES` on) and the check `actionRequests` (by action type). Dataset version 3.
- **Runner.** `evals/operator/cross-module.test.ts` registers the fixture module and replays the steps through the real chat runner. After every case, no fixture task exists, because proposals wait for a decision.
- **Done.** All 14 operator cases (v1, v2, v3) are green offline.

## WP4.3 Lock measurement and real-time fan-out (detailed)

Risk class high: invariants may rely on the per-project advisory lock in `scoped()` (`packages/db/src/index.ts`). This WP therefore runs in two gated parts. Part A changes nothing in behaviour. Part B starts only after Mario has seen the measurement report.

**Part A: measurement (this PR).**
- **Hook.** `lockObserver.observe` in `packages/db` receives `{ waitMs, holdMs }` for every `scoped()` transaction. It is unset in production, where it costs one property read. The measurement labels each sample with its call site from the stack.
- **Load.** `scripts/measure/lock-load.measure.ts` runs with `vitest.measure.config.ts`, outside `pnpm test`, against the local test database, for 30 s on one project:
  - five chat-stream pollers (`getRun` every 700 ms, as the SSE route does);
  - two writers;
  - the scheduler sweep every 2 s;
  - a chat run whose scripted model takes 1.5 s per call;
  - knowledge searches with a 1 s embedding.
- **Report.** `docs/evidence/lock-measurement-2026-10-17.md` gives per call site the count, wait p50/p95/max and hold p50/p95/max. It also names the transactions that hold the lock across a network call and says whether the lock limits concurrent use.

**Part B: after the report (separate PRs, each with its own approval).**
- `scopedRead()` without the advisory lock, RLS still set, for read paths the report proves read-only, starting with the chat-stream poll.
- Redis pub/sub per project and stream:
  - writers publish after commit;
  - SSE subscribes and replays from the DB with `Last-Event-ID`;
  - if Redis is down, it falls back to slow polling.
- Chat SSE onto pub/sub (optional, if the report shows the poll matters).

**Decision (Mario, 2026-10-17).** No `scopedRead()` now. Redis pub/sub for streams waits until Support starts (Phase 5), with the measurement repeated on the production host against a staging copy first.

## WP4.5 Module-level roles (detailed)

Risk class **high**: this is an authorization change. It is built and tested locally behind `ORBIT_MODULE_ROLES` (default `false`). Production gets it only after the security review below and Mario's approval of the flag. With the flag off, or with no override rows, every check behaves exactly as before.

**Model.**
- **Table.** `ProjectMemberModuleRole(workspaceId, projectId, userId, moduleId, role)`, with `role` ∈ `editor | viewer | none` and primary key `(projectId, userId, moduleId)`.
  - It is a tenancy table like `ProjectMember`: RLS project scope, `auth_control` for `orbit_auth`, no grant to `orbit_app`.
  - A foreign key to `ProjectMember`: overrides disappear with the membership.
- **Who it applies to.** Project owners and workspace owners always keep their owner role. An override never raises a member above `editor` and never applies to an owner.
- **Effective role.** In a module, the effective role is the override, else the project role. `none` means the module does not exist for that member.

**Where it applies.** These are the WP2.4 module gates, so a member's module role works like activation per member:
1. **Module routes.** The route group's guard marks the request with its owner module, and `scopeFor` returns the effective role. `none` answers 404 `MODULE_NOT_AVAILABLE`.
2. **Actions.** The dispatch scope takes the action owner's effective role before the permission check.
3. **Collections.** The kind owner's effective role applies to reads and writes.
4. **Assistant.**
   - Tools are offered and executed with the tool owner's effective role.
   - Prompt fragments and conversation sections come only from modules the member can use.
5. **Web.** `GET /modules` returns the member's `access` per module, and the shell hides a module whose access is `none`.
6. **Management.**
   - `GET` and `PUT /api/projects/:id/members/:userId/module-roles`: project owners only, audited (`member.module_role_changed`), refused while the flag is off.
   - A matrix in the members settings.

**Not covered (documented).**
- Worker jobs re-read the queuing user's project role (`member-scope.ts`). Module jobs queued by a member before an override still run.
- Telegram callbacks are owner-only already.

**Security review (before the flag goes on in production).**
- Every module entry point resolves the effective role (route, action, collection, tool offer, tool execution, prompt fragments, conversation sections). This is checked by a matrix test over routes × roles × overrides.
- An override cannot grant more than the project role allows for owners. It can raise a viewer to editor in a module (S-R6: support agents), and only an owner can set it.
- The new table is invisible to `orbit_app` and protected by RLS (RLS matrix test).
- No escalation through the assistant: a forged tool call executes with the owner module's effective role.
- Audit events for every change; no secrets in them.

**Tasks.**
1. Migration, Prisma model, RLS matrix classification, `ORBIT_MODULE_ROLES` config.
2. `platform/tenancy/module-roles.ts`: load overrides with the membership, `effectiveRole(scope, moduleId)`, `moduleScope(scope, moduleId)`; then wire routes, actions and collections. Matrix test.
3. Assistant: tool offer and execution, fragments and sections per effective role. A viewer-to-editor override and `none` tests.
4. Management API and `GET /modules` access; web shell hides `none` modules; members matrix UI.
5. Docs (`MODULE_ACTIVATION.md`, `SECURITY_REVIEW.md`), full checks, PR.

## WP4.2 Public ingress (detailed)

Risk class **high**: this is a new unauthenticated surface. It is built behind `ORBIT_PUBLIC_INGRESS` (default `false`; while off the routes answer 404 before parsing, like the Orbit Agents routes). Production gets the flag only after the security review in `docs/SECURITY_REVIEW.md` and Mario's approval. It ships in two PRs.

**WP4.2a: signed provider webhooks (no new table).**
- **Route.** `POST /api/hooks/:provider/:workspaceId/:projectId/:connectionId`.
  - The path carries the project, as Slack's does, because row-level security makes an unscoped connection lookup impossible.
  - JSON only (415 otherwise), 256 KB maximum (413).
  - Exempt from the Origin check; no cookies are read.
  - Rate-limited per connection: 120 requests per minute.
- **Contract.** `ModuleContributions.webhooks[provider] = { connectionProvider, verify({ rawBody, headers, credential, now }), messageId({ body, headers }), queueClass }`.
  - The platform owns the route.
  - The module owns signature checking and processing.
  - Provider names are unique across modules.
- **Flow.** Inside the project's transaction, in this order:
  1. find the connection; it must belong to that provider (404 otherwise);
  2. verify the signature over the raw body (401, audited `webhook.rejected`);
  3. read the message id (400 without one);
  4. refuse a seen message id (409 `DUPLICATE_MESSAGE`, audited `webhook.duplicate`, no new job);
  5. store the message as the platform kind `inbound_webhooks` (not exported);
  6. enqueue the module's queue class;
  7. answer 200 at once.
  
  The project lock serializes duplicates.
- **Consumer.** The fixture module `tasks` contributes a webhook provider (HMAC-SHA256) and its job, which creates a task. Slack and Telegram stay on their own routes for now; moving them is a follow-up once the pattern is proven.
- **Tests:** flag off; unknown provider, connection or foreign connection; forged signature; wrong content type; oversized body; valid message stored and processed; replay refused; per-connection rate limit; sessions and the Origin check unchanged.

**WP4.2b: public module API (next PR).**
- Platform table `PublicClientKey(projectId, moduleId, publicKey, allowedOrigins, revokedAt)`, readable by `orbit_auth` for the unscoped lookup.
- `/api/public/<module>/:publicKey/...`:
  - CORS from the key's allowed origins (`@fastify/cors`, registered for this prefix only);
  - a per-session bearer token stored hashed, no cookies;
  - rate limits per key and per session.
- A module contributes `publicRoutes`; the fixture module uses them.
- Tests: unknown or revoked key, disallowed origin and CORS preflight, missing or expired token, rate limits.

## WP4.6 Platform files (detailed)

**Decision (Mario, 2026-10-17, Q-19):** approved as recommended: a separate Cloudflare R2 bucket with its own API token, next to the backup bucket, never sharing the backup credentials. Mario creates the bucket and token and enters them in Coolify. No agent enters credentials.

Risk class **high**: new credentials and a new data store for customer files. The feature is built behind `ORBIT_FILES` (default `false`). While the flag is off, or the bucket is not configured, every file route answers 404 and `storeFile` refuses with `FILES_NOT_CONFIGURED`.

- **Configuration** (`packages/config`, `.env.example`, `docker-compose.yml`, `check-coolify-compose.mjs`):
  - `ORBIT_FILES`;
  - `FILES_S3_ENDPOINT`, `FILES_S3_BUCKET`, `FILES_S3_REGION` (default `auto`);
  - `FILES_S3_ACCESS_KEY_ID`, `FILES_S3_SECRET_ACCESS_KEY`;
  - `FILES_ENCRYPTION_KEY` (64 hex characters, separate from `CREDENTIAL_KEY`);
  - `FILES_MAX_BYTES` (default 20 MB, at most 50 MB).
  
  The api and worker services get them; the backup service does not.
- **Table** `File`: `id`, `workspaceId`, `projectId`, `moduleId`, `key`, `size`, `mime`, `sha256`, `encryption`, `name`, `createdBy`, `createdAt`, `deletedAt`.
  - FORCE RLS with the project policy, granted to `orbit_app`.
  - Migration `202610170007_platform_file`, additive.
- **Object store client** `platform/files/s3.ts`: no new dependency.
  - AWS Signature Version 4 with `node:crypto` (PUT, GET, DELETE), path-style URLs, the payload hash signed.
  - Pinned by the documented AWS test vector.
  - Timeouts; errors carry status and code only, never the key.
- **Encryption.** Each file is encrypted before upload: AES-256-GCM with a fresh 96-bit IV.
  - Object layout: version byte, IV, ciphertext, tag. The file id is bound as additional data, so objects cannot be swapped between rows.
  - The object key is `projects/<projectId>/<moduleId>/<fileId>`; nothing about the name or content.
  - `encryption` records `aes-256-gcm/v1`.
- **Service** `platform/files/files.ts`:
  - `storeFile(scope, { moduleId, bytes, mime, name })`: checks size, type and the module, hashes (SHA-256), writes the row and the object, and removes the object again when the row fails.
  - `readFile(scope, id)`: the row in the project, then the object; decrypts and checks the tag and the SHA-256 before returning anything.
  - `deleteFile(scope, id)`: sets `deletedAt` (unreadable at once), then removes the object and the row. If the object store fails, the hourly `file-cleanup` task retries, so no object outlives its row.
  - Types: an allowlist (images, PDF, plain text, CSV, `message/rfc822`) with a magic-number check for images and PDF.
- **Routes** (behind the flag, authenticated):
  - `POST /api/projects/:id/files?module=<id>`: raw body (`application/octet-stream` plus `x-file-type` and `x-file-name`), counted while streaming, 413 above the limit; the caller needs write access in that module.
  - `GET /api/projects/:id/files/:fileId`: read access in the file's module. `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, the stored type.
  - `DELETE /api/projects/:id/files/:fileId`: write access in the module.
- **Retention.** Modules delete their files through `deleteFile`. The hourly cleanup finishes removals that failed. Deleting a project cascades its rows, but not its objects (follow-up: purge the project prefix).
- **Tests:**
  - SigV4 test vector;
  - encryption round trip and tamper detection;
  - an in-process S3 double that checks every request's signature;
  - upload, download and delete over HTTP;
  - limits (size, type, magic number);
  - another project's file is unreachable (404);
  - a viewer cannot upload;
  - flag off and not configured;
  - RLS matrix and grants;
  - marketing assets unchanged.
- **Production:**
  - merge brings the migration (approval);
  - Mario creates the bucket and token and sets the variables;
  - the flag on is a separate approval after the security review.

## WP4.7 E-mail over SMTP/IMAP and notifications (detailed)

**Decision (Mario, 2026-10-17, Q-16):** SMTP and IMAP against an existing mailbox, no new e-mail provider. SPF, DKIM and DMARC are the mailbox provider's (no Orbit DNS change), as long as Orbit sends only as the mailbox's own address.

Risk class **high**: outbound mail on the project's behalf, inbound untrusted content and new dependencies. The work is behind `ORBIT_EMAIL` (default `false`). Sending follows the existing gate: `EXECUTION_MODE=live` and `ENABLE_EXTERNAL_WRITES=true`, otherwise a test receipt.

- **Dependencies** (production, part of the merge approval):
  - `nodemailer` (SMTP);
  - `imapflow` (IMAP);
  - `postal-mime` (MIME parsing, no dependencies).
  
  All MIT and widely used; pinned exactly.
- **Connection** `email` (platform connection provider):
  - fields: SMTP host, port and TLS mode; IMAP host, port and TLS; user name; from address and name;
  - credential: the mailbox password, AES-GCM like every connection;
  - `check` logs in to SMTP and IMAP and records `read_verified`. `write_verified` needs a real test send, which needs approval.
  
  TLS is required (implicit TLS or STARTTLS). Hosts must be public names, checked like other provider URLs.
- **Outbound** `platform/email/send.ts`, the job `email_send`:
  - one `email_messages` row per message (`queued` → `sent` / `failed` / `rejected` / `outcome_unknown` / `test_receipt`);
  - the Message-ID `<orbit.<id>@<from domain>>`;
  - errors before DATA are failures that may be retried; 5xx is `rejected`; anything ambiguous after DATA is `outcome_unknown`, never resent;
  - notifications are sent with `Auto-Submitted: auto-generated`.
- **Inbound** `platform/email/inbound.ts`, the periodic task `email-inbound`:
  - every two minutes per project with a verified e-mail connection;
  - fetches INBOX messages after the last UID (with a UIDVALIDITY check), at most 25 per pass, 10 MB each;
  - stores the raw MIME as a platform file (WP4.6) and a normalized `inbound_emails` row: Message-ID, from, to, subject, date, text (bounded), In-Reply-To, References, auto-reply flags and the file id;
  - deduplicates by Message-ID and UID;
  - enqueues every module that registered `emailInbound: { queueClass }`.
  
  Without platform files the task records `FILES_NOT_CONFIGURED` and fetches nothing.
- **Bounces.** A delivery status notification (`multipart/report; report-type=delivery-status`) whose content names an Orbit Message-ID marks that message `bounced`. Complaints are not available over SMTP; that limit is documented.
- **Notifications:**
  - Tables:
    - `Notification(id, workspaceId, projectId, userId, moduleId, kind, title, body, link, readAt, createdAt)`;
    - `NotificationPreference(workspaceId, projectId, userId, kind, inApp, email)`.
    
    Both use the chat tables' user policy, so a member sees only their own rows.
  - Contract: `ModuleContributions.userNotifications = { kinds: { <kind>: { label, emailDefault } } }`.
  - Service: `notifyMembers(tx, scope, { kind, userIds, title, body, link })` writes in-app rows by preference and queues `email_notification` for those who want e-mail.
  - API:
    - `GET /api/projects/:id/notifications` (mine, with the unread count);
    - `POST …/notifications/:id/read` and `…/read-all`;
    - `GET/PUT …/notification-preferences`.
  - Web: a bell in the shell header with the unread count (polled every 60 s), a list with mark-as-read, and preferences per kind.
- **Tests:**
  - test-mode receipt without delivery;
  - SMTP outcomes against a stub transport (failure before DATA, 5xx, ambiguous after DATA);
  - inbound against a stubbed IMAP client: dedupe, UIDVALIDITY, limits, auto-reply flags and DSN to `bounced`;
  - preference filtering and muting a kind;
  - one member cannot read another's notifications (RLS);
  - flag off.
- **Production:**
  - merge brings the migration and dependencies (approval);
  - Mario creates the connection with the mailbox credentials in Orbit;
  - the flag on and the first real send are separate approvals.

## WP4.2–WP4.7 (outline; each gets a detailed plan before it starts)

| WP | Content | Gate before starting |
|---|---|---|
| 4.6 Files | Detailed above | Approved 2026-10-17 (Q-19: own R2 bucket and token) |
| 4.7 E-mail and notifications | Detailed above | Decided 2026-10-17 (Q-16: SMTP/IMAP against an existing mailbox, no DNS change by Orbit) |

Suggested order: 4.1 → 4.4 (cheap, reuses the fixture) → 4.3 measurement → 4.5 → 4.2 → 4.6 → 4.7. The last three need decisions or credentials from Mario.

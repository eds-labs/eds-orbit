# WP5.1 Support Module Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register the `support` module with its tables, permissions, settings, inbox management, ticket numbering and the channel adapter contract. All of it stays behind a flag, and no customer can reach it yet.

**Architecture:**
- The module is a server module under `apps/api/src/modules/support/`. It plugs in through `ServerModule` and `ModuleContributions` only (ADR 0009).
- Its own project-scoped tables use FORCE RLS, composite same-project foreign keys and grants in `scripts/db-deploy.ts`.
- Support is **opt-in twice**:
  - the flag `ORBIT_SUPPORT` (default `false`) must be on;
  - the project must have an explicit `ProjectModule` row for `support` with `enabled = true`.

  Both are needed because, while `ORBIT_MODULES` is off, the platform treats every module as enabled (`platform/modules/enforcement.ts`).

**Tech Stack:** TypeScript (Node 24), Fastify, Prisma 7 with raw-SQL migrations, PostgreSQL RLS, Vitest, zod.

**Spec:**
- `plans/orbit-modularization/07-roadmap.md` §WP5.1;
- `06-support-readiness.md` §2.1, §3.1, §3.2 and §3.7;
- `10-support-pilot-decisions.md`, with Mario's decisions of 2026-10-17: Q-12a B, 24-month retention, the uLiquid project with module roles, and both channels at the pilot start.

## Global Constraints

- Risk class **high**: a schema change. The migration is additive only, with no change to existing tables.
- Rollback: disable the module or keep `ORBIT_SUPPORT=false`. The tables stay.
- No production effect: `ORBIT_SUPPORT` defaults to `false`. Merging is a production deploy, and with it the migration, so it needs Mario's explicit approval.
- No new dependencies. The boundary baseline stays 0: `modules/support` imports only the platform and packages, never `modules/marketing` or `modules/knowledge`.
- Message text, e-mail addresses and names never appear in `audit` metadata, logs or telemetry. Use IDs and counts only (Q-12a).
- Retention defaults come from Q-12b:
  - closed tickets: 24 months;
  - raw e-mail: 90 days;
  - unsent AI drafts: 90 days;
  - widget sessions: 30 days.

  The owner may shorten each value. The upper limit for closed tickets is 72 months.
- Inbox `aiMode` is `"off" | "draft"`, default `"off"`. `widget_answer` is added only in WP5.6, after Q-17.
- Code comments and docs are in English.
- Tests run as in `worktree-test-setup`: `node --env-file=<main>/.runtime/local.env ./node_modules/vitest/vitest.mjs run <file>`, with this worktree's own test database.

## Review Focus

1. **A cross-project reference through a foreign key.** FK checks bypass RLS, so a ticket in project A must not be able to point to an inbox, contact or file in project B. Every intra-module FK is composite: `("projectId", "<x>Id")` → `("projectId", "id")`. Pinned in Task 2 by an insert that must fail with a foreign-key error.
2. **Support is reachable while it is off.** This covers flag off, flag on without an explicit row, and the row disabled. Every support route must answer 404 `SUPPORT_DISABLED`. Pinned in Task 3.
3. **Ticket numbers collide under concurrent creation.** Five parallel `createTicket` calls in one project must give the numbers 1–5, and another project starts again at 1. Pinned in Task 4.
4. **The widget secret leaks.** It may appear only in the create and rotate responses. List, GET and audit output must never contain it, not even encrypted. Pinned in Task 3.
5. **A support agent changes inboxes or widget secrets.** `support.settings.manage` is owner-only, so no module role can grant it, and module role `none` hides support entirely. Pinned in Task 3 with `ORBIT_MODULE_ROLES=true`.

---

### Task 1: Flag, manifest, permissions and the settings schema

**Files:**
- Modify: `packages/config/src/index.ts`: add `ORBIT_SUPPORT: z.enum(["false","true"]).default("false")`, with a comment.
- Create: `apps/api/src/modules/support/permissions.ts`, `apps/api/src/modules/support/manifest.ts`, `apps/api/src/modules/support/settings.ts`
- Modify: `apps/api/src/modules/registry.ts`: append `supportModule` to `modules`, and `support: supportContributions` to `registerModules`. The contributions start as `{}`.
- Test: `apps/api/tests/module-registry.test.ts` (update) and `apps/api/src/modules/support/settings.test.ts` (new)

**Interfaces:**
- **Produces the permissions** in `permissions.ts`, built with `permission(key, description, roles)` from `platform/tenancy/permissions.ts`:

  | Constant | Key | Roles |
  |---|---|---|
  | `SUPPORT_TICKETS_READ` | `support.tickets.read` | owner, editor, viewer |
  | `SUPPORT_TICKETS_REPLY` | `support.tickets.reply` | owner, editor |
  | `SUPPORT_TICKETS_ASSIGN` | `support.tickets.assign` | owner, editor |
  | `SUPPORT_NOTES_WRITE` | `support.notes.write` | owner, editor |
  | `SUPPORT_CONTACTS_MANAGE` | `support.contacts.manage` | owner, editor |
  | `SUPPORT_STATS_READ` | `support.stats.read` | owner, editor, viewer |
  | `SUPPORT_SETTINGS_MANAGE` | `support.settings.manage` | owner; `sensitive: true`, because inboxes set CORS origins and widget secrets |

  `supportPermissions` is the list of all seven.
- **Produces the manifest** `supportModule: ServerModule`:
  - `id: "support"`, `version: "1.0.0"`, display name "Support" / "Support";
  - `dependsOn: []`, `defaultEnabled: false`, `entityKinds: []`;
  - `tables`: the seven tables of Task 2;
  - `permissions: supportPermissions`.
- **Produces the settings** in `settings.ts`:
  - `supportSettingsSchema`, a strict zod object:
    - `categories`: an array of `{ key: /^[a-z][a-z0-9_]{1,40}$/, label: string 1..60 }`, at most 50, with unique keys;
    - `sla`: a record over `low | normal | high | urgent` of `{ firstResponseMinutes: int 1..43200, resolutionMinutes: int 1..129600 }`;
    - `autoAck: boolean`, `autoCloseDays: int 1..90`, `reopenOnReply: boolean`;
    - `retention: { closedTicketMonths: int 1..72, rawEmailDays: int 1..365, aiDraftDays: int 1..365, widgetSessionDays: int 1..365 }`.
  - `supportSettingsDefaults(): SupportSettings` returns:
    - categories `[]`;
    - SLA first response: urgent 240, high 480, normal 1440, low 4320. Resolution is 3× each.
    - `autoAck: true`, `autoCloseDays: 7`, `reopenOnReply: true`;
    - `retention: { closedTicketMonths: 24, rawEmailDays: 90, aiDraftDays: 90, widgetSessionDays: 30 }`.

- [ ] **Step 1:** Write the failing tests:
  - `module-registry.test.ts`: the order is `["knowledge", "marketing", "support"]`, and the table owner of `SupportTicket` is `"support"`.
  - `settings.test.ts`: the defaults parse; duplicate category keys are rejected; `closedTicketMonths: 73` is rejected; an unknown key is rejected.
- [ ] **Step 2:** Run both and see them fail.
- [ ] **Step 3:** Implement the flag, the permissions, the manifest, the settings and the registry entry.
- [ ] **Step 4:** Run both and see them pass. Also run `permissions.test.ts`, `module-contributions.test.ts` and the boundary checker (`node scripts/boundaries.mjs`), and confirm the baseline is 0.
- [ ] **Step 5:** Commit: `feat(support): module manifest, permissions and settings (WP5.1)`.

### Task 2: Migration `202610180001_support_core`, Prisma models, RLS and grants

**Files:**
- Create: `packages/db/prisma/migrations/202610180001_support_core/migration.sql`
- Modify: `packages/db/prisma/schema.prisma`: seven models with relations to `Project` only, mirroring the SQL. FTS is `Unsupported("tsvector")?`.
- Modify: `scripts/db-deploy.ts`: add the seven tables to `business`, under a `// Support (WP5.1).` comment.
- Test: `apps/api/tests/rls-matrix.integration.test.ts`. Add the tables to `PROJECT_TABLES`, one row each to `seed()`, and a `SupportTicket` row to the cross-project insert list.

**Tables.** Every table has:
- `id UUID PK`, `workspaceId`, `projectId`;
- a FK `("workspaceId","projectId") → Project("workspaceId","id") ON DELETE CASCADE`;
- `UNIQUE ("projectId","id")`, which is the target for the composite FKs;
- `ENABLE` and `FORCE ROW LEVEL SECURITY`, with policy `project_scope` exactly as in the `File` migration.

Timestamps are `TIMESTAMPTZ(3)`.

| Table | Columns beyond the common ones | Constraints and indexes |
|---|---|---|
| `SupportInbox` | `name TEXT`, `channels TEXT[]`, `emailAddress TEXT NULL`, `allowedOrigins TEXT[] DEFAULT '{}'`, `widgetSecretEnc TEXT NULL`, `publicClientKeyId UUID NULL` (linked in WP5.4), `defaultCategory TEXT NULL`, `assignmentPolicy TEXT DEFAULT 'unassigned'`, `defaultAssigneeUserId TEXT NULL`, `language TEXT DEFAULT 'en'`, `aiMode TEXT DEFAULT 'off'`, `version INT DEFAULT 1`, `createdBy TEXT`, `createdAt`, `updatedAt`, `archivedAt NULL` | `channels <@ ARRAY['email','widget']` and not empty; `assignmentPolicy IN ('unassigned','round_robin','fixed')`; `aiMode IN ('off','draft')`; `language IN ('en','de')` |
| `SupportContact` | `name NULL`, `email NULL`, `locale NULL`, `notes NULL`, `createdAt`, `updatedAt`, `deletedAt NULL` | `UNIQUE INDEX ("projectId", lower("email")) WHERE "email" IS NOT NULL` |
| `SupportContactIdentity` | `contactId`, `inboxId`, `channel TEXT`, `externalUserId TEXT`, `createdAt` | Composite FKs to contact (CASCADE) and inbox (RESTRICT); `UNIQUE ("projectId","inboxId","channel","externalUserId")` |
| `SupportTicket` | `number INT`, `inboxId`, `contactId`, `subject TEXT`, `status TEXT DEFAULT 'new'`, `priority TEXT DEFAULT 'normal'`, `category NULL`, `tags TEXT[] DEFAULT '{}'`, `assigneeUserId NULL`, `channel TEXT`, `firstResponseDueAt NULL`, `resolutionDueAt NULL`, `firstRespondedAt NULL`, `resolvedAt NULL`, `closedAt NULL`, `aiState TEXT DEFAULT 'none'`, `lastCustomerMessageAt NULL`, `mergedIntoTicketId UUID NULL`, `createdAt`, `updatedAt` | `UNIQUE ("projectId","number")`; composite FKs to inbox and contact (both RESTRICT) and the self-FK for merges; status, priority and aiState checks with the values of `06` §2.1/§3.1; indexes `(projectId,status,assigneeUserId)`, `(projectId,inboxId,status)`, `(projectId,contactId)`, `(projectId,firstResponseDueAt)`, `(projectId,resolutionDueAt)` |
| `SupportMessage` | `ticketId`, `kind TEXT`, `authorContactId NULL`, `authorUserId NULL`, `agentRunId NULL`, `bodyText TEXT`, `bodyHtml NULL`, `channel TEXT`, `externalId NULL`, `deliveryState NULL`, `visibleToCustomer BOOL`, `searchVector tsvector`, `createdAt` | Composite FK to the ticket (CASCADE); `kind IN ('customer','agent_reply','internal_note','ai_draft','ai_reply','system')`; a check that `internal_note` and `ai_draft` imply `visibleToCustomer = false`; `deliveryState` limited to the `06` §3.1 values; `UNIQUE ("projectId","channel","externalId")`; a GIN index on `searchVector`, filled by a trigger as `to_tsvector('simple', bodyText)` |
| `SupportAttachment` | `messageId`, `fileId`, `name`, `mime`, `size INT`, `scanState TEXT DEFAULT 'not_scanned'`, `createdAt` | Composite FK to the message (CASCADE); composite FK `("projectId","fileId") → File("projectId","id")` (CASCADE). This needs `UNIQUE ("projectId","id")` on `File`, which is added additively in this migration. |
| `SupportTicketEvent` | `ticketId`, `type TEXT`, `actorKind TEXT` (`user`/`contact`/`system`/`ai`), `actorId NULL`, `before JSONB`, `after JSONB`, `createdAt` | Composite FK to the ticket (CASCADE); index `(projectId,ticketId,createdAt)` |

Widget sessions use the platform's public sessions (WP4.2b). No `SupportWidgetSession` table is created; WP5.4 binds sessions to contacts.

- [ ] **Step 1:** Extend `rls-matrix.integration.test.ts`:
  - classify the seven tables;
  - seed one inbox, contact, identity, ticket, message, attachment and event per project;
  - add a cross-project `SupportTicket` insert that must fail on RLS;
  - add a new case, "a ticket cannot reference another project's inbox": inside project A's scope, insert a ticket with A's ids and B's `inboxId`. Expect a foreign-key violation (`/foreign key/`).
- [ ] **Step 2:** Run it and see it fail ("unclassified table" or missing relation).
- [ ] **Step 3:** Write the migration, the Prisma models and the grants. Run `prisma generate --config packages/db/prisma.config.ts` and `node --env-file=... scripts/db-deploy.ts` against the worktree's test database.
- [ ] **Step 4:** Run `rls-matrix.integration.test.ts` and `files.integration.test.ts` and see both pass. Running the migration twice must be impossible: Prisma's journal refuses it.
- [ ] **Step 5:** Commit: `feat(support): core tables with RLS (WP5.1)`.

### Task 3: The support gate, settings and inbox routes

**Files:**
- Create: `apps/api/src/modules/support/gate.ts`, `apps/api/src/modules/support/inboxes.ts`, `apps/api/src/modules/support/routes.ts`, `apps/api/src/modules/support/contributions.ts`
- Create: `apps/api/src/platform/modules/settings.ts`
- Modify: `apps/api/src/platform/http/public-api.ts`: export the existing origin schema as `publicOrigin`, with no change in behaviour.
- Modify: `apps/api/tests/access-matrix.integration.test.ts`: set `ORBIT_SUPPORT: "true"`. Regenerate `fixtures/access-matrix.json` with `UPDATE_ACCESS_MATRIX=1` and review its diff.
- Modify: `packages/schemas/openapi.json` and `packages/api-client/src/generated.ts`, regenerated as in `worktree-test-setup`.
- Test: `apps/api/tests/support-inboxes.integration.test.ts` (new)

**Interfaces:**
- `platform/modules/settings.ts`. Both functions are generic for every module:
  - `readModuleSettings<T>(tx: DbTx, scope: Scope, moduleId: string, schema: z.ZodType<T>, defaults: () => T): Promise<{ settings: T; version: number }>` returns the defaults while the row's `settings` is `{}`.
  - `writeModuleSettings<T>(tx, scope, moduleId, schema, value: unknown, expectedVersion: number): Promise<{ settings: T; version: number }>` parses the value. It throws `DomainError("SETTINGS_VERSION_CONFLICT", 409)` when the stored version differs. It increments `settingsVersion` and audits `module.settings_changed` with `{ moduleId, version }`, without values.
- `gate.ts`: `supportActive(tx: DbTx, scope: Scope): Promise<boolean>`. It is true only when `ORBIT_SUPPORT === "true"` **and** a `ProjectModule` row `support` with `enabled = true` exists. `requireSupport(tx, scope)` throws `DomainError("SUPPORT_DISABLED", 404)`.
- `inboxes.ts`:
  - `inboxInput`: a strict zod object with name 1..80, `channels` (a non-empty subset of `email` and `widget`), `emailAddress` (an e-mail, required when the channels include `email`), `allowedOrigins` (`publicOrigin[]`, at most 10, required non-empty when the channels include `widget`), `defaultCategory`, `assignmentPolicy`, `defaultAssigneeUserId`, `language` and `aiMode`.
  - Functions:
    - `createInbox(tx, scope, raw) → { inbox: InboxView; widgetSecret?: string }`. The secret is 32 random bytes, base64url, stored as `encrypt(secret, credentialKey())`, and returned only here.
    - `updateInbox(tx, scope, id, raw, expectedVersion)`: a partial update with a version check, `INBOX_VERSION_CONFLICT` 409.
    - `rotateWidgetSecret(tx, scope, id) → { widgetSecret }`.
    - `archiveInbox(tx, scope, id)`.
    - `listInboxes(tx, scope) → InboxView[]`.
  - `InboxView` contains every column except `widgetSecretEnc`, plus `hasWidgetSecret: boolean`.
  - Every write audits `support.inbox.<created|updated|secret_rotated|archived>` with `{ inboxId, version, changed: string[] }`.
- `routes.ts`. Every handler first calls `scopeFor(auth, req, projectId, <permission>)`, then, in `scoped`, `requireSupport`:

  | Route | Permission |
  |---|---|
  | `GET /api/projects/:projectId/support/settings` | `SUPPORT_TICKETS_READ` |
  | `PUT /api/projects/:projectId/support/settings` (body `{ settings, version }`) | `SUPPORT_SETTINGS_MANAGE` |
  | `GET /api/projects/:projectId/support/inboxes` | `SUPPORT_TICKETS_READ` |
  | `POST /api/projects/:projectId/support/inboxes` | `SUPPORT_SETTINGS_MANAGE` |
  | `PATCH /api/projects/:projectId/support/inboxes/:inboxId` (body `{ ...partial, version }`) | `SUPPORT_SETTINGS_MANAGE` |
  | `POST /api/projects/:projectId/support/inboxes/:inboxId/rotate-widget-secret` | `SUPPORT_SETTINGS_MANAGE` |
  | `POST /api/projects/:projectId/support/inboxes/:inboxId/archive` | `SUPPORT_SETTINGS_MANAGE` |

- [ ] **Step 1:** Write the failing tests in `support-inboxes.integration.test.ts`. Use synthetic owner, editor and viewer accounts as in `module-roles.integration.test.ts`; sign in at most 3 users.
  - "answers SUPPORT_DISABLED while the flag is off, while no row exists and while the module is disabled": 404 in all three states, for owners too.
  - "creates an e-mail+widget inbox, returns the widget secret once and never again": GET and list contain no `widgetSecret` or `widgetSecretEnc`, and the audit rows' metadata contains neither the secret nor the address.
  - "rejects a widget inbox without origins and an e-mail inbox without an address": 400.
  - "rejects aiMode widget_answer": 400.
  - "updates with a version and refuses a stale version": 409 `INBOX_VERSION_CONFLICT`.
  - "reads default settings and saves a change with a version": a stale version gives 409, and `retention.closedTicketMonths: 73` gives 400.
  - "viewer reads but cannot write; module role none hides support; only the owner manages", with `ORBIT_MODULE_ROLES=true`. A project viewer with module role `editor` may read but gets 403 on create, and with module role `none` gets 404.
- [ ] **Step 2:** Run it and see it fail.
- [ ] **Step 3:** Implement the gate, the settings helpers, the inboxes, the routes and the contributions (`{ routes: supportRoutes }`).
- [ ] **Step 4:** Run the test, `module-enforcement.integration.test.ts`, `module-roles.integration.test.ts` and `access-matrix.integration.test.ts` after the update, and see all pass. In the matrix diff, every new route is `not_found` for outsiders and `unauthenticated` for anonymous callers.
- [ ] **Step 5:** Commit: `feat(support): settings and inbox management behind ORBIT_SUPPORT (WP5.1)`.

### Task 4: Ticket creation with per-project numbering, and the channel adapter contract

**Files:**
- Create: `apps/api/src/modules/support/channels/adapter.ts`, `apps/api/src/modules/support/tickets.ts`
- Test: `apps/api/tests/support-tickets.integration.test.ts` (new)

**Interfaces:**
- `channels/adapter.ts` exports the following. There are no adapters yet; WP5.3 and WP5.4 add them.
  - `SupportChannel = "email" | "widget"`.
  - `NormalizedInbound = { externalId: string | null; contact: { email?: string; name?: string; locale?: string; externalUserId?: string }; subject: string; bodyText: string; bodyHtml?: string; threadRef?: { ticketId?: string; inReplyTo?: string[] }; attachments: { fileId: string; name: string; mime: string; size: number }[] }`
  - `OutboundMessage = { ticketId: string; messageId: string; to: { email?: string; contactId: string }; subject: string; bodyText: string; bodyHtml?: string; inReplyTo?: string }`
  - `SupportChannelAdapter = { channel: SupportChannel; capabilities: { inbound: boolean; outbound: boolean; attachments: boolean; realtime: boolean; threading: "headers" | "session" | "external_id" }; normalizeInbound(payload: unknown, inbox: InboxView): Promise<NormalizedInbound[]>; send(tx: DbTx, scope: Scope, msg: OutboundMessage): Promise<{ outcome: "sent" | "not_sent" | "rejected" | "unknown"; externalId?: string }> }`
- `tickets.ts`: `createTicket(tx: DbTx, scope: Scope, input: { inboxId: string; channel: SupportChannel; inbound: NormalizedInbound; now?: Date }) → Promise<{ ticketId: string; number: number; contactId: string; messageId: string; duplicate: boolean }>`, in this order:
  1. Call `requireSupport`.
  2. Load the inbox. An archived one gives 409 `INBOX_ARCHIVED`.
  3. When `externalId` exists for `(channel, externalId)`, return the existing message's ticket with `duplicate: true`.
  4. Upsert the contact by `lower(email)`, skipping tombstoned contacts and creating a new one. Without an e-mail, use `(inbox, channel, externalUserId)`.
  5. Allocate the number as `coalesce(max(number),0)+1`. This is safe because `scoped()` holds the project advisory lock.
  6. Set the status to `new` and the priority to `normal`. The category is the inbox default. The due times come from the settings' SLA for `normal`.
  7. Insert a message of kind `customer` with `visibleToCustomer: true`.
  8. Insert an event of type `created` with `before: {}` and `after: { status, priority, category }`, and no text.
  9. Audit `support.ticket.created` with `{ ticketId, number, channel }`.

- [ ] **Step 1:** Write the failing tests:
  - "numbers tickets per project without gaps under parallel creation": five parallel `scoped` calls in project A give the numbers [1,2,3,4,5], and the first ticket in project B gets 1.
  - "reuses a contact by case-insensitive e-mail and ignores tombstoned contacts".
  - "is idempotent by channel and external id".
  - "sets SLA due times from the settings": `firstResponseDueAt` is `now` plus 1440 minutes for `normal`.
  - "refuses while support is disabled and for archived inboxes".
  - "writes no message text or address into audit or event rows": search the rows' JSON for the body and address strings.
- [ ] **Step 2:** Run it and see it fail.
- [ ] **Step 3:** Implement `adapter.ts` (types only) and `tickets.ts`.
- [ ] **Step 4:** Run it and see it pass. Then run the full suite (`vitest run`) and the boundary check, and revert `evals/knowledge/last-deterministic-run.json` if the run touched it.
- [ ] **Step 5:** Commit: `feat(support): ticket creation with per-project numbers and channel contract (WP5.1)`.

### Task 5: Documentation and status

**Files:**
- Create: `docs/SUPPORT.md`, covering:
  - the flag and the double opt-in;
  - the tables;
  - the permissions;
  - the settings and their defaults (Q-12b);
  - the inbox API;
  - what WP5.2–WP5.9 add;
  - the rollback.
- Modify: `docs/IMPLEMENTATION_STATUS.md` (WP5.1 local, not deployed), `docs/REQUIREMENTS_TRACEABILITY.md` (rows for `06` §2.1 Inboxes and Roles), `docs/adr/0006-agent-state-and-data-retention.md` (an "Amendment 2026-10-17" with the Q-12a support rule) and `plans/orbit-modularization/10-support-pilot-decisions.md` §3 (a link to this plan).

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** Check the `.agentic/quality-gates` definition of done, the review checklist and the security checklist against the diff, and note the results in the PR description.
- [ ] **Step 3:** Commit: `docs(support): WP5.1 module, decisions and status`.
- [ ] **Step 4:** Push and open a **draft** PR against `main`. The description covers the risk (high), the migration, the flag (off), the rollback and the approval needed for merge and production deploy.

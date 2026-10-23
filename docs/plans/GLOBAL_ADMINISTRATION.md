# Global Administration, User Management and Account Self-Service

Status: approved by Mario on 2026-10-23 for phases 1 and 2 (local implementation). Phases 3 and 4 are prepared, not implemented. Production steps need separate approval.

## Context

Orbit has no administration level above the project. The only bootstrap is `POST /api/setup` (setup token, first workspace owner). Users are created by project owners with an owner-chosen password (`addProjectMember`, `apps/api/src/platform/tenancy/project-members.ts`). Nobody can reset a password, change their own password, see or revoke sessions, deactivate a user or manage memberships across projects. Orbit should work as a self-hosted company installation and later as multi-tenant SaaS, so it needs four separate levels: system administration (`/admin`), organization settings (`/o/:id/settings`), project settings (`/p/:id/settings`, existing) and the personal account (`/account`).

Decisions made by Mario on 2026-10-23:
- **D1 Auth mail:** add an optional system SMTP configuration (`ORBIT_SYSTEM_SMTP_*`) that reuses Orbit's existing nodemailer SMTP transport. This adds no new provider. Without it, an admin can show an invitation or reset link once and pass it on manually. Self-service "forgot password" needs SMTP. This amends Q-16 in `docs/EMAIL_AND_NOTIFICATIONS.md`: system auth mail is separate from project mail.
- **D2 Bootstrap:** existing installations use an audited CLI inside the container (`tsx scripts/system-admin.ts grant --email …`). On a fresh install, the `/api/setup` user becomes the first system admin. Existing owners never get system admin automatically.
- **D3 Old flow:** invitations replace "add local member with initial password". The password path is removed from the API and the UI. An existing user is added directly.
- **D4 Org roles:** owner plus member, with no schema change. `WorkspaceMember.role` `owner` means org admin. `editor` and `viewer` both mean member (new members keep getting `viewer`). Project access comes only from project roles.

Risk: **high** (authentication, authorization, schema migration, outward mail). Environment: local implementation and tests only. A production migration, flag change, SMTP env, CLI bootstrap or push to `main` each needs Mario's explicit approval, because a push to `main` deploys automatically. App profile: `fullstack-saas` (primary) plus `backend-api` and `web-frontend`. Workflow: `.agentic/workflows/feature.md` and `migration.md`. Stack: existing stack, no new production dependency (the Better Auth admin plugin ships with `better-auth` 1.7.10).

## 1. Inventory (main @ 1d6f52f, worktree branch `claude/orbit-global-admin-6a9484`, clean, equal to origin/main)

| Area | State |
|---|---|
| Better Auth 1.7.10 | `makeAuth()` in `apps/api/src/platform/tenancy/auth.ts`. Email and password (12–128 characters), 8 h sessions, cookie cache **off** (each request reads the database), IP blanked. Plugins `jwt/mcp/cimd` load only with `ORBIT_MCP_OAUTH`. No admin or organization plugin, no `sendResetPassword`, no email verification. |
| HTTP auth surface | `server.ts` ~497–530 allows only `sign-in/email`, `sign-out`, `get-session` and the OAuth paths. Everything else returns 403 `AUTH_ENDPOINT_DISABLED`. |
| Identity tables | `user` has no role, banned or locale columns. `Verification` is unused. |
| Tenancy | `Workspace`, `WorkspaceMember(role)`, `Project(paused, generation)`, `ProjectMember(role)` with an FK to `WorkspaceMember`, `ProjectMemberModuleRole`. CHECK `role IN (owner, editor, viewer)` lives in `security.sql`. Workspace owners are implicit owners of every project (`projectMembership`, `member-scope.ts`). |
| Authorization | Checks are imperative: `userFor` / `scopeFor` / `authorize` (`tenancy/auth.ts`, `permissions.ts`). Module roles: `module-roles.ts` (flag `ORBIT_MODULE_ROLES`). Permissions are not cached. **`projectMembership()` is the single choke point** for the API, the worker's `actorScope()` and the MCP `resolvePrincipal()`. |
| DB roles | `orbit_auth` (control plane: identity, membership, OAuth and MCP grant tables) and `orbit_app` (business tables, FORCE RLS via `scoped()`). Neither bypasses RLS. `authDb` is the existing cross-tenant metadata client. |
| Audit | `AuditEvent` is project-scoped (NOT NULL FK to Project). `McpGrantEvent` is project-independent and append-only. Records hold identifiers only. |
| Email | All mail is project-scoped (`platform/email/send.ts`, `transport.ts`). There is no system transport and there are no templates. |
| Pause / fencing | `pauseProject()` (`platform/governance/pause.ts`) bumps `generation`, the worker's claim blocks `PROJECT_PAUSED`, and module hooks `onProjectPause/Resume` exist. These are reused in phase 3. |
| Web | One client catch-all, `components/orbit.tsx`. Routing is in code: `platform/shell/routes.ts`, where `admin` is already in `RESERVED` and `/o/:id/<x>` returns notFound. `standalone` views support `session: required/none`. There is no user menu, only an avatar. `SettingsNav`, `DataForm`, `Modal`, `DataList`, `PageHead`, `Badge`, `Alert`, `Empty` and `system-status.tsx` are reusable. i18n is `lib/i18n.ts` (`labels.en/de`). |
| Tests | `access-matrix` enumerates every swagger route automatically, against a fixture across 5 roles, and new routes fail until they are reviewed. `rls-matrix` requires every table to be classified. There are auth, session-sliding and add-member integration tests. E2E uses Playwright with `scripts/seed-e2e.ts`. |
| Requirements | There are no admin or user-management requirements in `REQUIREMENTS_TRACEABILITY.md` (the closest are A02 and AP11). ADR 0002 lists MFA and account recovery as "not current". |

## 2. Gap analysis

| Function | Exists | Gap |
|---|---|---|
| System admin role | – | Role marker, authorization helper, bootstrap, last-admin guard |
| Admin API and UI | – | Everything |
| Org overview and settings | Workspace owner semantics, `/o/:id` page | Settings route, member management, org-level audit |
| User list and search | – | Everything (metadata from `authDb`) |
| Invitations | Password-based add-member | Token model, mail, accept page, grant application |
| Role changes and removal | Add member, module roles | Change project role, remove from project or org, guards |
| Deactivation | – | Ban plus session deletion plus MCP grant revocation plus membership check |
| Password change / reset | Better Auth primitives (blocked) | Wrapped endpoints, system mail, UI |
| Sessions | DB sessions | List and revoke (own, and admin for others) |
| Profile, locale | Locale in localStorage only | `user.locale`, profile edit, email change |
| System audit | Project audit only | `SystemAuditEvent` table |

## 3. Target architecture and permission model

**Levels and authority (always checked server-side and re-read from the database on every request):**

| Actor | Source | May |
|---|---|---|
| System admin | `user.role = 'admin'` and not banned | Read metadata across installations. Manage users, orgs, memberships, invitations and system roles. **No access to project content.** |
| Org owner | `WorkspaceMember.role = 'owner'` | Manage their org: name, members (owner/member), invitations, project memberships. Implicit project owner (unchanged). |
| Project owner | `ProjectMember.role = 'owner'` | Existing project settings, plus invite to the project, change project role and module roles, remove members. Cannot change org roles. |
| Any user | Session | Their own account: profile, password, email, sessions, locale. |

**Principles**
- Use the **Better Auth admin plugin** for identity state only: the `role`, `banned`, `banReason` and `banExpires` columns. Its built-in sign-in and session-creation hook rejects banned users, and `banUser` deletes their sessions. Its `/api/auth/admin/*` HTTP routes stay blocked by the allowlist. Orbit calls `auth.api.*` server-side from its own `/api/admin/*` routes, which carry zod validation, audit and guards. Impersonation is never exposed. This is not a second auth system.
- **Defense in depth for deactivation:** `projectMembership()` adds `user: { banned: false }`, and `sessionFor()` rejects banned users. Because this one choke point also covers the worker's `actorScope` and the MCP principal, a deactivation is effective immediately everywhere. Deactivation also revokes the user's MCP grants (existing `revokeGrant`).
- **Metadata only:** admin and org services use `authDb` on control tables only (user, session counts, Workspace, WorkspaceMember, Project, ProjectMember, ProjectMemberModuleRole, ProjectModule.enabled, Invitation, SystemAuditEvent). A unit test asserts that `platform/administration/**` never imports `db`/`scoped` or the business modules.
- **One service layer.** `apps/api/src/platform/administration/` serves the admin, org and project routes. Only the authorization wrapper differs (`systemAdmin` / `orgOwner` / `projectOwner`).
- **Guards**, enforced in the service inside one transaction with a `pg_advisory_xact_lock` per workspace or a global admin lock:
  - Each org keeps at least one non-banned owner.
  - The installation keeps at least one non-banned system admin.
  - Nobody can deactivate themselves or remove their own system-admin role.
  - An org owner cannot remove themselves when they are the last owner.
- **Step-up:** granting or revoking the system-admin role and deactivating an admin require re-entering the password (checked with `auth.api.verifyPassword` or the equivalent).
- **Hidden existence:** a non-admin receives 404 from `/api/admin/*`, the same as with the flag off.
- **Flags** (default off): `ORBIT_ADMINISTRATION` covers admin, org settings and invitations. `ORBIT_ACCOUNT` covers account self-service and password reset. The banned check runs regardless of the flags; it is harmless because every user starts with `banned=false`.
- Nothing is specific to EDS Labs or uLiquid. A SaaS installation can later restrict org creation to system admins (as now) or to a registration policy (phase 4).

## 4. Schema changes: migration `202610230001_system_administration` (additive only)

- `user`:
  - `role TEXT NOT NULL DEFAULT 'user'` with CHECK `IN ('user','admin')`
  - `banned BOOLEAN NOT NULL DEFAULT false`, `banReason TEXT`, `banExpires TIMESTAMPTZ(3)`
  - `locale TEXT` with CHECK `IN ('en','de')` or NULL. This is a Better Auth `additionalFields` entry with `input:false`, written only through the Orbit route.
- `session`: `impersonatedBy TEXT` (required by the plugin schema, never written).
- `Invitation`:
  - Columns: id uuid, `tokenHash` (sha256, unique), `email` (lower-cased), `workspaceId` FK cascade, `workspaceRole` ('owner'|'viewer'), `invitedBy`, `expiresAt` (default 7 days), `acceptedAt`, `acceptedUserId`, `revokedAt`, `createdAt`.
  - Index `(workspaceId, email)` with a partial unique index on open invitations.
- `InvitationProjectGrant`: invitationId FK cascade, workspaceId and projectId (composite FK to Project, cascade), `role`, `moduleRoles JSON`.
- `SystemAuditEvent`:
  - Columns: id, actorId (user id, `system:cli` or `system:setup`), action, targetType, targetId, workspaceId NULL, projectId NULL, metadata JSON (ids and codes only, never emails, tokens or reasons in clear text), createdAt.
  - Append-only: an update/delete-blocking trigger as for the audit tables.
- `security.sql` and `scripts/db-deploy.ts`: FORCE RLS plus `auth_control` policy `TO orbit_auth`.
  - `orbit_auth` gets CRUD on Invitation* and INSERT/SELECT on SystemAuditEvent. `orbit_app` gets no access. Update the grant verification.
- Data: none. Nobody is granted admin, and existing rows get `role='user'`, `banned=false`.
- Down path, documented: drop the new tables and columns (only valid before the first admin action).
- `packages/db/prisma/schema.prisma` mirrors all of this. Run `pnpm db:generate`.

## 5. API endpoints (all in swagger, zod `.strict()`, Origin check, rate limits)

**Phase 1: admin read and foundation**
- `GET /api/admin/overview`: counts (users active/deactivated, admins, orgs, projects, paused projects, open invitations, sessions in the last 24 h), reusing the system-status probes.
- `GET /api/admin/users?query&status&role&workspaceId&cursor` and `GET /api/admin/users/:userId` (profile metadata, org/project/module-role matrix, active session count).
- `GET /api/admin/organizations`, `GET /api/admin/organizations/:workspaceId` (members, projects).
- `GET /api/admin/projects?workspaceId&query&cursor`: metadata only (name, org, member count, enabled modules, paused, createdAt).
- `GET /api/admin/audit?action&actorId&targetId&cursor`.
- `GET /api/me` gains `systemAdmin: boolean`, `locale`, and per-workspace `canManage`.
- `/api/setup`: a new install sets the first user's `role='admin'` and writes a system audit `system_admin.bootstrap`.
- CLI `scripts/system-admin.ts grant|revoke|list --email`: uses `authDb`, enforces the last-admin guard, and audits as `system:cli`. It runs with `tsx` in the api image.

**Phase 2: management**
- Organizations:
  - `POST /api/admin/organizations {name, ownerEmail}` (an existing user becomes owner, otherwise an owner invitation is created).
  - `PATCH /api/admin/organizations/:id {name}`.
- Memberships (admin anywhere, org owner within the org; mirrored under `/api/organizations/:workspaceId/...`):
  - `PUT  …/members/:userId {role: owner|member}`.
  - `DELETE …/members/:userId`, which also removes the user's project memberships in that org.
  - `PUT  …/projects/:projectId/members/:userId {role, moduleRoles?}` and `DELETE …` (reuses `setMemberModuleRoles`).
- Project level: `PUT /api/projects/:id/members/:userId {role}` and `DELETE /api/projects/:id/members/:userId` (project owner). `add-member` becomes `{email, name?, role, moduleRoles?}`: an existing user is added directly, otherwise a project-scoped invitation is created. The password field is removed.
- Users (admin):
  - `POST /api/admin/users/:id/deactivate {reason?}`: `auth.api.banUser` plus revocation of MCP grants plus cancellation of the user's open invitations.
  - `POST …/reactivate`.
  - `POST …/sessions/revoke`.
  - `POST …/password-reset`: sends mail, or without SMTP returns a one-time link with `deliveredBy:"link"`.
  - `PUT …/system-role {role, password}`.
- Invitations:
  - `GET/POST /api/admin/invitations` and `/api/organizations/:id/invitations`, plus `POST …/:id/resend` (rotates the token) and `DELETE …/:id`.
  - Public: `GET /api/invitations/:token` returns the minimal view (org name, project names, invited email, expiry). It answers 404 for an expired, used or revoked token.
  - Public: `POST /api/invitations/:token/accept {name, password}` for a new user (calls `auth.api.signUpEmail` server-side, sets `emailVerified=true` because receiving the link proves the address, applies grants, consumes the token, then signs in).
  - Authenticated: `POST /api/invitations/:token/accept` for an existing user. The session email must equal the invitation email.
  - On acceptance, grants are re-validated: the project must still be in the org, the org must exist, and the inviter must still be authorized. Otherwise the request is refused.
- Account (`ORBIT_ACCOUNT`):
  - `GET/PATCH /api/account {name, locale}`.
  - `POST /api/account/password {currentPassword, newPassword, revokeOtherSessions}` (`auth.api.changePassword`).
  - `GET /api/account/sessions` (marks the current session, never returns tokens), `DELETE /api/account/sessions/:id`, `POST /api/account/sessions/revoke-others`.
  - `POST /api/account/email {newEmail, password}`, which needs SMTP and sends a confirmation link to the new address.
  - `POST /api/account/email/confirm {token}`, which changes the email, sets it verified, notifies the old address and audits.
  - Public: `POST /api/account/password-reset/request {email}` always returns 202. It is rate-limited per IP and per email hash, and sends only to existing, non-banned users.
  - Public: `POST /api/account/password-reset/confirm {token, newPassword}` (`auth.api.resetPassword`, token TTL 1 h, single use, `revokeSessionsOnPasswordReset: true`).
- Better Auth config:
  - Add `admin({ defaultRole:"user", adminRoles:["admin"] })` (always on).
  - `sendResetPassword` uses system mail.
  - Set `resetPasswordTokenExpiresIn: 3600` and `revokeSessionsOnPasswordReset: true`.
  - Add `user.additionalFields.locale`.
  - Hash verification identifiers if 1.7.10 supports it (to be verified). Otherwise record it as a residual risk, since the token stays one-time and short-lived.
  - Add no new public `/api/auth/*` paths: every flow goes through the Orbit wrappers.

**System mail** (`apps/api/src/platform/email/system-mail.ts`):
- Configuration (`packages/config`, optional): `ORBIT_SYSTEM_SMTP_HOST`, `_PORT`, `_SECURE`, `_USER`, `_PASSWORD`, `_FROM`.
- Sending reuses the `transport.ts` SMTP session directly, with a short timeout and no queue (there is no project scope).
- It sends only with `EXECUTION_MODE=live` and `ENABLE_EXTERNAL_WRITES=true`. In test mode it writes to an in-process test sink. Tokens and links are never logged.
- Plain-text and HTML templates (en/de, according to the recipient's locale or the inviter's locale) for invitation, password reset, email change and email-changed notice.
- `GET /api/admin/overview` reports `systemMail: configured|missing` and never shows values.

## 6. Frontend structure (reusing the shell and design system)

- `platform/shell/routes.ts`:
  - New places: `admin` (`/admin[/:section[/:id]]`), `organizationSettings` (`/o/:orgId/settings`).
  - Public standalone pages: `/invite/:token` and `/reset-password?token=` (`session:"none"`, rendered before the `/me` gate in `orbit.tsx`).
  - Standalone `/account` with `session:"required"`.
  - Existing deep links stay unchanged.
- `platform/shell/user-menu.tsx` replaces the avatar in the topbar. It shows:
  - name and email, "Account", "Organization settings" (only `canManage`), "Administration" (only `systemAdmin`), the language and sign out.
  - The mobile drawer gets the same entries.
- `platform/admin/`:
  - `admin-shell.tsx` with its own grouped navigation: Overview, Users, Invitations, Organizations, Projects, Audit log, System status.
  - Pages `overview.tsx`, `users.tsx`, `user-detail.tsx` (with the membership/permission matrix), `organizations.tsx`, `organization-detail.tsx`, `projects.tsx`, `invitations.tsx`, `audit.tsx`.
  - Reuses `SettingsNav` (layout), `PageHead`, `DataList`, `DataForm`, `Modal`, `Badge`, `Alert`, `Empty`, `Skeleton` and `system-status.tsx`.
- `platform/organization/settings.tsx`: general, members, projects with a user × project role matrix, invitations.
- `platform/account/`: profile, email, password, sessions, language. The sign-in form gets a "Forgot password?" link.
- `components/project-administration.tsx`: "Invite member" (no password) plus a change-role and remove action per member row. Module roles stay.
- `lib/i18n.ts`: en/de keys for all new texts.
- The UI hides entries but **never** grants anything. Every action handles 403/404/409 errors.
- Phase-1 pages are read-only, phase-2 pages add actions.

## 7. Ordered tasks (dependencies in brackets)

Phase 1
1. Add the docs: copy this plan to `docs/plans/GLOBAL_ADMINISTRATION.md`, write ADR 0012 (system admin model, Better Auth admin plugin, metadata-only rule, system mail amending Q-16), and update the status/traceability entries (A20–A2x).
2. Migration, Prisma schema, `security.sql`, `db-deploy` grants and their verification, plus the `rls-matrix` classification [1].
3. Config: the flags `ORBIT_ADMINISTRATION` and `ORBIT_ACCOUNT`, the optional system SMTP settings, and `system-mail.ts` with its test sink [–].
4. Better Auth config: admin plugin and locale field. Banned checks in `sessionFor` and `projectMembership`. Tests [2].
5. `platform/administration/`: `authz.ts` (`systemAdminFor`, `orgManagerFor`), `system-audit.ts`, the metadata read services, the CLI `scripts/system-admin.ts`, setup bootstrap and the `/api/me` extension [2, 4].
6. Admin read routes and the flag 404 in the global hook. Regenerate `pnpm api:generate`, review the access-matrix fixture [5].
7. Web: routes, user menu, admin shell and the read-only pages (overview, users, user detail, orgs, projects, audit), i18n, web unit tests [6].
   **Checkpoint:** phase 1 acceptance (section 9) plus the full checks.

Phase 2
8. Membership service and guards (org role, removal, project role and removal, module roles) with admin, org and project routes [5].
9. Invitations: model, service, mail, public view and accept, re-validation on acceptance. `add-member` switches to invite/direct-add [3, 8].
10. User lifecycle: deactivate and reactivate (ban, sessions, MCP grants, invitations), admin session revocation, admin password reset, system role with step-up [4, 8].
11. Account API: profile, locale, password change, sessions, password reset request and confirm, email change [3, 4].
12. Web: admin actions, permission matrix, invitations, org settings, account pages, invite and reset pages, project member actions [8–11].
13. Tests and docs: access-matrix regeneration with a security review of the diff, the new integration tests, e2e specs, `SECURITY_REVIEW.md`, `MODULE_ACTIVATION.md`, `EMAIL_AND_NOTIFICATIONS.md`, a rollout runbook `docs/deployment/ADMINISTRATION_ROLLOUT.md` and `IMPLEMENTATION_STATUS.md` [all].
14. Delivery: integrate `origin/main`, run the full checks again, then **ask Mario** before pushing to `main`, because the push deploys production and runs the migration.

Tasks 8–11 are written sequentially in this session, since the shared service files overlap. Subagents are used only for independent review.

## 8. Security risks and test strategy

**Risks and mitigations**
- **Privilege escalation through role fields.** The plugin's `role` and `banned` fields are written only by the Orbit services. `update-user` and the plugin HTTP routes stay blocked, and `additionalFields` use `input:false`.
- **Admin sees content.** The metadata-only rule is enforced by the import test. No admin endpoint uses `scoped()`.
- **Token leakage.** Invitation and reset tokens use 32 bytes of randomness and are stored as sha256 (invitations) or with Better Auth's single-use TTL (reset). They never appear in logs, audit records or API lists, and the link fallback shows them once.
- **User enumeration.** Reset requests always return 202 with uniform timing. The invitation view returns 404 for every invalid state. Rate limits apply per IP and per email hash.
- **Lockout.** The last-admin and last-owner guards take a lock, self-deactivation is blocked, and the CLI provides recovery.
- **Stale access after a change.** No permission is cached. The banned check sits in the choke point, sessions are deleted and MCP grants revoked. Running chat jobs are covered by `actorScope` when they execute.
- **CSRF.** The existing Origin check applies to all new POST/PUT/DELETE routes, and public token routes still require the Origin.
- **Mail injection.** Addresses are validated by zod and header fields are built by MailComposer.

**Tests**
- Integration (API):
  - `admin-authz` (non-admin 404, flag off 404, banned admin denied).
  - `system-admin-bootstrap` (setup sets admin; existing owners are not admins after the migration; CLI grant/revoke with the last-admin guard).
  - `memberships` (role change and removal; last-owner and self-removal guards; cross-workspace refusal: an org owner of A cannot touch B).
  - `invitations` (expiry, single use, revoke, resend rotates the token, email mismatch, re-validation, grants applied including module roles).
  - `user-lifecycle` (deactivate deletes sessions; sign-in refused; worker `actorScope` and MCP `resolvePrincipal` return null; reactivate).
  - `account` (profile and locale, password change with and without revoking other sessions, session list/revoke limited to the user's own, reset request uniform response, reset token single use and expiry, email change confirmation).
  - `admin-metadata-only` (responses contain no business content).
  - `migration` (apply on a database copy with existing users and workspaces; nobody becomes admin; defaults are set; grant verification passes).
- `rls-matrix`: classify the new tables, keep `orbit_app` without access, keep `SystemAuditEvent` append-only.
- `access-matrix`: add the systemAdmin and orgOwner actor columns, add the public token routes to `PUBLIC_ROUTES`, and review the fixture diff as a security change.
- Unit: guards, system-mail rendering and gating, routes.ts places, user-menu visibility, i18n key parity.
- E2E (Playwright): admin dashboard, user detail, deactivate/reactivate, invite → accept (via the test sink link) → sign-in, project member invite, account password change, reset flow, sessions revoke, mobile width.
- Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (with `node scripts/test-db-for-worktree.ts` first), `pnpm build`, `pnpm test:e2e`, `pnpm test:coolify-compose` (new env names in the compose file), `git diff --check`.

## 9. Acceptance criteria

**Phase 1**
- Only users with `role='admin'` reach `/admin` and `/api/admin/*`. Everyone else, including org owners, gets 404, and so does everyone when the flag is off.
- After the migration, no existing user is admin. The CLI grants the first admin and writes a system audit entry. A fresh setup makes the setup user admin.
- The dashboard shows the counts and system status. User, org and project lists support search and filters across all orgs, with metadata only.
- The user menu shows "Administration" only to admins. The admin area has its own navigation, is responsive and is translated (en/de).
- All checks are green, and the access and RLS matrices are extended and reviewed.

**Phase 2**
- An admin or org owner invites by email. The user receives a time-limited link (7 days, single use), sets their own password and gets exactly the pre-assigned roles. No password is ever shown or sent.
- Without SMTP, the admin can copy the link once. Self-service reset is then hidden.
- Admins and org owners change roles, change module roles and remove project or org access in a matrix. The change takes effect on the next API, worker or MCP call.
- Deactivation deletes the user's sessions, blocks sign-in and revokes MCP grants, and the worker and MCP deny the user. Reactivation restores access without restoring sessions.
- The last admin and last org owner cannot be removed or deactivated, and nobody can lock themselves out.
- `/account`: edit name and language; change password (optionally revoking other sessions); list and revoke sessions; reset password by email (1 h, single use, revokes sessions); change email with confirmation.
- The old initial-password path is gone from the API and the UI.
- Every administrative action is audited without content. All tests and checks are green.

## 10. Phase 3 and 4 (prepared, not implemented)

**Phase 3: project lifecycle.**
- Add `Project.archivedAt`, `archivedBy` and `deletionScheduledAt`.
- Archiving reuses `pauseProject()` with a generation bump, the module hooks and the worker claim block (a new code `PROJECT_ARCHIVED`). It also:
  - revokes the project's MCP grant scopes,
  - disables public client keys and the widget,
  - stops the email and IMAP pollers and connector schedules,
  - keeps scheduled assignments paused,
  - hides the project from `/api/me`, while the admin and org owner see it under "Archived".
- Restore clears the archive and stays paused until an owner resumes the project.
- Final deletion is allowed only after a deletion delay (default 30 days, set per installation in phase 4). It requires typing the project name, a password step-up, a recent export or backup check (the `orbit-backup` status plus an optional project export), and an audit entry in `SystemAuditEvent`, because the project's own audit rows are deleted with the project. Deletion runs as a worker job that removes files and blobs, embeddings and outbox entries, then the project row.

**Phase 4: global settings.**
- New `SystemSetting(key, value JSON, version, updatedBy)` table owned by `orbit_auth`. Resolution order: code default, then system setting, then project override, where a project setting exists. Areas:
  - branding and system name, default language and timezone
  - system mail status (env only, read-only in the UI)
  - AI provider defaults and models (references to `docs/MODEL_ROUTING.md`; keys remain env or secret store)
  - budget ceilings
  - module availability
  - registration and invitation policy (invitation TTL, who may create orgs)
  - session policy (lifetime; MFA via the Better Auth `two-factor` plugin)
  - API, worker and DB status, backup and maintenance status, version info
- Secrets are never editable or visible in the UI: the UI shows only "configured / missing".

## Verification (end-to-end)
1. `node scripts/test-db-for-worktree.ts`, then `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
2. `UPDATE_ACCESS_MATRIX=1` only after reviewing the new routes, then a run without it. Run `rls-matrix` green.
3. `pnpm test:e2e`, including the new specs, against the local stack (`pnpm dev`, seed via `scripts/seed-e2e.ts`).
4. Manual check in the built-in browser on localhost: CLI grant of admin, `/admin`, invite → accept through the test-sink link, deactivate, `/account` flows, mobile width.
5. Report in the AGENTS.md closing format. Production steps (migration, flags, SMTP env, CLI grant) go into the rollout runbook and wait for Mario's approval.

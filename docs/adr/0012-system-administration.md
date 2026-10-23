# ADR 0012: System administration, invitations and account self-service

## Status

Accepted by Mario, 2026-10-23 (decisions D1–D4 in [the plan](../plans/GLOBAL_ADMINISTRATION.md)). Extends [ADR 0002](0002-auth-provider.md) and amends decision Q-16 of [email and notifications](../EMAIL_AND_NOTIFICATIONS.md) for authentication mail only. Phases 1 and 2 are implemented behind the flags `ORBIT_ADMINISTRATION` and `ORBIT_ACCOUNT` (default off); production activation needs separate approval.

## Context

Orbit administered users only inside a project: a project owner created a local user with an initial password. Nobody could reset or change a password, list or revoke sessions, deactivate a user or manage memberships across projects. Orbit must run as a self-hosted company installation and later as multi-tenant SaaS, so it needs an administration level above organizations without a second authentication or permission system and without giving administrators access to project content.

## Decision

1. **Four levels.** System administration (`/admin`), organization settings (`/o/:id/settings`), project settings (`/p/:id/settings`, unchanged) and the personal account (`/account`).
2. **System administrator marker.** `user.role = 'admin'`, managed through the Better Auth admin plugin's schema (`role`, `banned`, `banReason`, `banExpires`, `session.impersonatedBy`). The plugin's HTTP routes stay blocked by the `/api/auth/*` allowlist; Orbit's own `/api/admin/*` routes validate input, enforce guards and audit, then call the plugin server-side. Impersonation is not offered. A workspace owner is not a system administrator.
3. **Bootstrap.** A fresh installation makes the `/api/setup` user the first administrator. Existing installations grant the first administrator with the audited CLI `scripts/system-admin.ts` inside the container. No role is granted by migration.
4. **Metadata, not content.** Administration services read and write only control-plane tables through the `orbit_auth` role (identity, workspace, project and membership metadata, invitations, system audit). They never open a project-scoped business transaction. A test enforces the import boundary.
5. **Organization roles.** `WorkspaceMember.role = 'owner'` is the organization administrator; `editor` and `viewer` both mean member. Project access still comes only from project roles and module roles.
6. **Invitations replace owner-set passwords.** An invitation stores a sha256 hash of a 32-byte token, expires after 7 days, is single use and carries the workspace role plus project and module grants. Grants are re-validated when the invitation is accepted. Invited users set their own password; existing users are added directly.
7. **Deactivation is immediate.** Deactivation bans the user (Better Auth refuses sign-in and new sessions), deletes their sessions, revokes their MCP grants and cancels their open invitations. `projectMembership()` and `sessionFor()` additionally refuse banned users, which covers API requests, worker actor checks and the MCP principal.
8. **Guards.** The installation keeps at least one active administrator and every organization at least one active owner. Nobody can deactivate themselves or drop their own administrator role. Changing the administrator role requires the actor's password.
9. **System authentication mail.** An optional system SMTP account (`ORBIT_SYSTEM_SMTP_*`) sends invitation, password-reset and email-change messages through Orbit's existing SMTP transport. It is independent of any project mailbox and obeys `EXECUTION_MODE=live` plus `ENABLE_EXTERNAL_WRITES=true`. Without it, administrators can copy an invitation or reset link once; self-service password reset is then unavailable.
10. **System audit.** `SystemAuditEvent` is an append-only, project-independent table holding identifiers and codes only.

## Alternatives and consequences

- The Better Auth organization plugin would duplicate Orbit's workspace and project membership tables; rejected.
- A separate identity service or admin application would add a second availability and governance dependency; rejected.
- An Orbit-owned `SystemAdmin` table would reimplement the ban and session handling the admin plugin already provides.

Consequences: the identity tables gain columns, and the access and RLS matrices cover the new routes and tables. MFA can later use the Better Auth `two-factor` plugin. Central connections and AI infrastructure are phase 3 (ADR 0013); project archiving and global settings are phases 4 and 5.

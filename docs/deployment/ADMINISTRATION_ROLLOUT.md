# Rollout: system administration, invitations and account self-service

ADR 0012, plan `docs/plans/GLOBAL_ADMINISTRATION.md`. Every step that touches production needs Mario's explicit approval for that step. A push to `main` deploys production automatically (Coolify webhook) and runs the migration.

## What the release changes

- Migration `202610230001_system_administration` (additive): `user.role` (default `user`), `user.banned` (default `false`), `banReason`, `banExpires`, `user.locale`, `session.impersonatedBy`; new tables `Invitation`, `InvitationProjectGrant`, `SystemAuditEvent` (append-only trigger). Nobody becomes administrator. `scripts/db-deploy.ts` grants the new tables to `orbit_auth` only and verifies that `orbit_auth` cannot update the system audit.
- Better Auth now loads its admin plugin. Behaviour change with the flags off: a user with `banned=true` cannot sign in (nobody is banned after the migration).
- Project members: "Add local member" with an initial password is gone. With `ORBIT_ADMINISTRATION=false`, owners can only add people who are already members of the organization (`INVITATIONS_DISABLED` otherwise). Turn the flag on in the same release window if owners need to add new people.
- `/api/setup` on a fresh installation makes the first user a system administrator.

## Steps

1. **Pre-check (read-only).** Confirm the backup of the last night exists (`orbit-backup`) and the migration list of production ends at `202610190001_mcp_grant_constraints` or a later main migration.
2. **Deploy (approval).** Push to `main`; watch the `migrate` container (`Migration, least-privilege grants and real-role isolation checks completed.`) and the API health.
3. **Smoke with flags off.** Sign-in works; `/api/me` answers without `systemAdmin: true`; `/api/admin/overview` answers 404.
4. **First administrator (approval).** In the api container: `node_modules/.bin/tsx scripts/system-admin.ts grant --email <Mario's address>`, then `… list`. The system audit records `system_admin.granted` by `system:cli`.
5. **System mail (optional, approval).** Set `ORBIT_SYSTEM_SMTP_HOST`, `_PORT`, `_TLS`, `_USER`, `_PASSWORD`, `_FROM` (and `_FROM_NAME`) in Coolify for the api service. Sending also needs `EXECUTION_MODE=live` and `ENABLE_EXTERNAL_WRITES=true`. Without it, administrators copy invitation and reset links by hand and "forgot password" is hidden.
6. **Flags (approval).** `ORBIT_ADMINISTRATION=true` and `ORBIT_ACCOUNT=true`, redeploy. Check: `/admin` opens for the administrator only; the account menu shows Account, Organization settings (owners) and Administration (administrators); an invitation to a test address can be accepted; `/account` lists sessions.

## Rollback

- Flags off: every administration, invitation and account route answers 404 and the menu entries disappear; data stays.
- Code: revert the release commits. The migration is additive; the old code ignores the new columns and tables. Dropping them is only safe before the first administrative action (see the migration header).
- Lockout: `scripts/system-admin.ts grant` restores an administrator; `UPDATE "user" SET banned=false …` reactivates a user (both by an operator with database access, audited by hand).

## Phase 3 core: central connections, AI profiles, shared knowledge (ADR 0013)

- **Migration** `202610230002_central_connections` is additive: new control-plane tables with row-level security, `Project.kind` (default `project`), and nullable attribution columns on `BudgetReservation` and `AgentRun`. With `ORBIT_CONNECTIONS=false` and `ORBIT_KNOWLEDGE_SHARES=false`, runtime behaviour is unchanged. The only visible difference is that the legacy project "connector" action no longer offers the AI providers, which it never configured anyway.
- **Order (each step needs approval):**
  1. Deploy.
  2. `ORBIT_CONNECTIONS=true` (with administration on).
  3. Create a system OpenAI/Anthropic connection: a new key Mario provides, or the current environment key only by his explicit decision.
  4. Grant it to one organization with a budget, then to one project without its own key.
  5. Check a paid run's attribution and counters.
  6. Separately, `ORBIT_KNOWLEDGE_SHARES=true`, a library and one share for Support.
- **Key ring:** optional `CREDENTIAL_KEYS` for rotating the master key; `CREDENTIAL_KEY` stays readable as `default`.
- **Rollback:** set the flags off. Projects then use only their own settings and the environment again, and shares are ignored; the new tables stay. Reverting the code is safe because the migration is additive.

### Phase 3 part 2: cutover, migration, MCP administration, n8n

- Migration `202610230003_workflow_bindings` is additive.
- **Cutover (each provider separately, approval):**
  1. Set `ORBIT_CONNECTIONS_CUTOVER=postiz`.
  2. Run the inventory: `node_modules/.bin/tsx scripts/connections-migrate.ts inventory --workspace <id>`. It is read-only.
  3. Show the plan to Mario.
  4. Run `apply --yes`.
  5. Check one draft and one queue check per bound project.
  - Rollback: `connections-migrate.ts rollback --connection <id> --yes`, or remove the provider from `ORBIT_CONNECTIONS_CUTOVER`; adopted projects then use their kept keys again.
- **MCP:** Administration → MCP is available to administrators with `ORBIT_ADMINISTRATION=true`. Disabling a client revokes its grants at once.
- **n8n:**
  1. Create the connection with the JSON secret.
  2. Add a binding.
  3. Grant `automation` to one project.
  4. Run one test trigger in test mode.
  - Live triggers need `EXECUTION_MODE=live` and `ENABLE_EXTERNAL_WRITES=true`.
  - The n8n workflow must verify `X-Orbit-Signature`, and signs its callback with the same secret.

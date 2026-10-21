# n8n for the customer context gateway: operations runbook

Scope: the n8n instance that runs the customer context workflows
(`integrations/n8n/customer-context/`, ADR 0011). n8n already runs in Coolify
(Mario, 2026-10-21); this runbook checks and hardens that instance instead of
installing a second one. **Every production step below needs Mario's explicit
approval**: changing env or secrets, importing or publishing workflows,
updates, restores, proxy or firewall changes. Nothing here has been applied to
production; the end-to-end evidence is local (see "Evidence").

## 1. Check the existing instance (read-only)

| Check | Target | Why |
|---|---|---|
| n8n version | 2.44.5 tested; a different version only after the local E2E passes with it | Code node sandbox and publication behaviour change between versions |
| Database | PostgreSQL **17 or newer**, own database and role | n8n 2.44 warns that 16 is unsupported; SQLite is not for production |
| Persistence | named volume for `/home/node/.n8n` and for Postgres | survive redeploys |
| `N8N_ENCRYPTION_KEY` | set explicitly and stored in the password manager | without it no stored n8n credential decrypts after a restore |
| HTTPS | Coolify/Traefik domain with a valid certificate, `WEBHOOK_URL` and `N8N_PROXY_HOPS=1` set | Orbit only calls public HTTPS (SSRF guard) |
| Accounts | only the owner (Mario) can edit workflows; 2FA on; no shared logins | env access is on (section 4) |
| Separation from Orbit | own Coolify resource, own database and volume, no Orbit secrets, no network path to Orbit's database | n8n is a separate failure and trust domain |
| Other workflows | none that need `$env`, or reviewed | every workflow on the instance can read the env |
| Execution data | settings from `deploy/n8n.env.example` | no customer data at rest |

If the instance uses SQLite or Postgres 16, plan the move to Postgres 17 as a
separate approved change (export workflows and credentials, new database,
import, verify) before activation.

## 2. Configuration

Apply the instance settings of
`integrations/n8n/customer-context/deploy/n8n.env.example`;
`deploy/docker-compose.reference.yml` shows the target shape on Coolify
(n8n, external task runner, Postgres 17, health checks, volumes).

Data minimization: execution data is off for success, error, manual runs and
progress, both per workflow (generated settings) and per instance; a
remaining execution record is pruned after 24 h. The gateway logs nothing.

## 3. Secrets

| Secret | Created by | Lives in | Rotation |
|---|---|---|---|
| Orbit integration token and signing secret (per integration) | owner, when creating the integration in Orbit | Orbit vault (encrypted); n8n `CC_GATEWAY_INTEGRATIONS` holds the token's SHA-256 and the signing secret | new Orbit integration, add it to `CC_GATEWAY_INTEGRATIONS`, check, rebind the inbox, remove the old entry |
| Desk client token `dctx_…` | Mario (Desk runbook `docs/runbooks/customer-context-api-n8n.md`) | n8n `CC_DESK_TOKEN`; Desk stores its hash | Desk accepts two hashes during a rotation |
| FamilyPlan service token `fpctx_…` | Mario (familyplan `docs/SUPPORT_ORBIT_ROLLOUT.md`) | n8n `CC_FAMILYPLAN_TOKEN`; FamilyPlan stores its hash | FamilyPlan accepts two hashes during a rotation |
| `N8N_ENCRYPTION_KEY`, DB password, runner token | Coolify generators | Coolify, password manager | with a planned maintenance |

Generate random values on a trusted workstation, for example
`node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`
and the SHA-256 with
`node -e 'console.log(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' <token>`.
Enter them only as locked Coolify variables; never in a workflow, a ticket,
the repository or a chat.

## 4. Accepted risk: environment access in Code nodes

The gateway verifies HMAC signatures in a Code node, so it needs
`NODE_FUNCTION_ALLOW_BUILTIN=crypto` and reads its secrets through `$env`
(`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`). Any workflow editor on the instance
can then read every environment variable, including `N8N_ENCRYPTION_KEY`.
Mitigation: only the owner edits workflows, no community packages, no other
workflow with untrusted input on this instance. If other people need to edit
workflows, run the gateway on a dedicated n8n instance instead (same files,
same env).

## 5. Task runners

n8n 2.x deprecates the internal task runner. With external runners
(`N8N_RUNNERS_MODE=external`, `n8nio/runners` of the **same** version), the
JavaScript runner must also allow `crypto`. The local evidence used the
internal runner; after switching to external runners, run the Orbit
connection check for both integrations: if the Code nodes cannot read `$env`
or load `crypto`, the check fails (`CUSTOMER_CONTEXT_CHECK_MISCONFIGURED` or
`…_PROVIDER_ERROR`) instead of answering wrongly.

## 6. Network

- Public: only the n8n domain over HTTPS; Orbit calls
  `POST https://<n8n>/webhook/orbit-cc/v1/customer-context/lookup`.
- Recommended (separate approval, proxy change): restrict the editor UI
  (`/`, `/rest/`) to trusted addresses in Traefik; leave `/webhook/` public.
- Outbound: Desk API and the Supabase function URL over HTTPS.

## 7. Health checks and monitoring

- Container: `GET /healthz` (process) and `/healthz/readiness` (database),
  as in the Compose reference.
- Functional: Orbit's connection check (*Check connection*,
  `connector-health`) sends the reserved subject through the gateway to the
  product. Desk answers 404 and FamilyPlan 400 after their token checks, so a
  passing check proves Orbit → n8n → product including both credentials.
- Orbit records every read as a content-free audit event
  (`support.customer_context.read`, outcome and duration only). Repeated
  `unavailable` outcomes or an open circuit indicate an n8n or product outage.

## 8. Backups

What needs a backup: the n8n database (users, n8n credentials, workflow
versions) and `N8N_ENCRYPTION_KEY`. The workflow definitions live in Git and
the gateway secrets in Coolify, so a lost instance can be rebuilt by
importing. Customer data is not stored (execution data off).

Follow the Orbit backup pattern (`docs/BACKUP_RESTORE.md`): a daily
`pg_dump --format=custom` of the n8n database with the same Postgres major
version, `pg_restore --list` check, `age` encryption to the owner's public
key, upload to the R2 bucket under a separate prefix `n8n/` with its own
API token (write only for that prefix) and its own lifecycle rule (for
example 30 days), and a Coolify scheduled task with failure notification.
Restore drills run only into an isolated database.

## 9. Updates

1. Read the n8n release notes from the current to the target version
   (breaking changes, Code node sandbox, task runners, publication).
2. Locally: run the end-to-end test with the target version
   (`N8N_BIN` of that version, `integrations/n8n/customer-context/README.md`).
3. Backup (section 8) and note the current image tag.
4. Update n8n and the runner image together to the same pinned tag.
5. Verify: `/healthz/readiness`, then the Orbit connection check for every
   integration, then one read-only lookup with a synthetic test account.
6. Rollback: the previous image tag. If the update ran database migrations,
   restore the backup into a new database and point n8n at it (n8n migrations
   are forward-only).

Workflow changes follow the same order: build and test in Git, import,
publish, restart, wait for the connection check (n8n activates a published
version asynchronously).

## 10. Recovery

| Situation | Effect | Action |
|---|---|---|
| n8n down or slow | Orbit shows "cannot be checked right now", the Support AI hands off; tickets and Desk/FamilyPlan keep working | restore n8n; nothing to reconcile (read-only) |
| Product API down | same, per product | product's own runbook |
| n8n database lost | gateway unavailable | new database, import the three workflows from Git, set env, publish, restart, connection checks |
| Secret leaked | | rotate per section 3; for `CC_GATEWAY_INTEGRATIONS` create a new Orbit integration and rebind |
| Wrong answers suspected | | unbind the inbox in Orbit (immediate), then investigate |

## 11. Activation order (each step separately approved)

1. Section 1 check of the existing instance; fix gaps.
2. Instance env (section 2) and the three workflows imported and published,
   `CC_GATEWAY_INTEGRATIONS=[]` (gateway refuses everything).
3. Desk: Mario creates and activates the `dctx_` token (Desk is already
   deployed with the API); set `CC_DESK_TOKEN`.
4. FamilyPlan: merge and deploy `support-customer-context`, set its token
   hash; set `CC_FAMILYPLAN_TOKEN` and the function URL.
5. Orbit: `ORBIT_CUSTOMER_CONTEXT=true`; create one integration per product
   (`https://<n8n>/webhook/orbit-cc`); add each to `CC_GATEWAY_INTEGRATIONS`;
   restart n8n; connection checks pass.
6. Bind one inbox; read-only acceptance with a synthetic test account per
   product (ticket card, then one AI draft); then further inboxes.

Rollback at any point: unbind the inbox, remove the integration from
`CC_GATEWAY_INTEGRATIONS`, or `ORBIT_CUSTOMER_CONTEXT=false`. Nothing is
stored, so nothing needs cleaning up.

## Evidence

Local, 2026-10-21: `apps/api/tests/customer-context-n8n.integration.test.ts`
(7/7) against n8n 2.44.5 with the generated workflows, Desk answers from
Desk's own context builder (uliquid-desk `f92364b`) and FamilyPlan's real
handler (familyplan `2f9765b`). Not production evidence: no Coolify instance,
no real product credentials and no real customer were involved.

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
| Desk client token `dctx_…` | Mario (uliquid-desk runbook `uliquid-desk/docs/runbooks/customer-context-api-n8n.md`) | n8n `CC_DESK_TOKEN`; Desk stores its hash | Desk accepts two hashes during a rotation |
| FamilyPlan service token `fpctx_…` | Mario (`familyplan/docs/SUPPORT_ORBIT_ROLLOUT.md`) | n8n `CC_FAMILYPLAN_TOKEN`; FamilyPlan stores its hash | FamilyPlan accepts two hashes during a rotation |
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
(`N8N_RUNNERS_MODE=external`, `n8nio/runners` of the **same** version) the
Code nodes run in the runner container. The image's launcher configuration
(`/etc/n8n-task-runners.json`, checked in 2.44.5) already allows `crypto`
for the JavaScript runner and does not pass `NODE_FUNCTION_ALLOW_BUILTIN`
from the container environment, so the runner needs no extra variable; a
different allowlist would need a mounted launcher configuration. `$env` and
`this.helpers.httpRequest` are served by the main n8n process, so
`N8N_BLOCK_ENV_ACCESS_IN_NODE` and the product variables belong on the n8n
container. The local end-to-end test covers this mode
(`N8N_E2E_RUNNERS=external`, see "Evidence"). After any runner change, run
the Orbit connection check for both integrations: if the Code nodes cannot
read `$env` or load `crypto`, the check fails
(`CUSTOMER_CONTEXT_CHECK_MISCONFIGURED` or `…_PROVIDER_ERROR`) instead of
answering wrongly; without a connected runner the gateway answers 500.

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

Decision (Mario, 2026-10-21): use Coolify's built-in backup of the stack's
Postgres component to Cloudflare R2, **without** the `age` encryption of the
Orbit pattern (`docs/BACKUP_RESTORE.md`). Reason: the n8n stack is a Coolify
service template that can only pull published images, and the Orbit backup
image is built from the Orbit repository and not published. The deviation is
acceptable because the dump holds little that is readable: no execution data
(customer data) once the section 2 settings apply, n8n credentials are
encrypted with `N8N_ENCRYPTION_KEY` (not in the dump), the gateway secrets
live in the Coolify environment, and the workflow definitions are in Git.
Readable after a bucket leak: workflow definitions and the owner's password
hash. Revisit the decision if the instance starts to store other data.

Setup (owner, in this order):

1. R2: a private EU bucket used only for n8n (an R2 API token can be limited
   to a bucket, not to a prefix), a lifecycle rule that deletes objects
   after 30 days, and an API token with Object Read & Write for that bucket
   only.
2. Coolify, S3 Storages: a new storage with the R2 endpoint, bucket and
   token, validated.
3. n8n service, Backups: a schedule for the Postgres component (for example
   `30 3 * * *` in the server time zone, apart from the Orbit backup), S3
   upload to that storage, local retention 2 dumps, S3 retention 30 days.
4. Coolify notifications: failed backups alert the owner (Telegram).
5. Run the backup once by hand and check the execution and the object in
   the bucket.

Restore drill: download one dump and restore it only into a fresh, isolated
PostgreSQL 17 database (never over production); `pg_restore --list` must
succeed and the restored database must contain the n8n tables. A real
restore also needs `N8N_ENCRYPTION_KEY` from the password manager, otherwise
no stored n8n credential decrypts.

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

### Section 1 check of the Coolify instance (read-only, 2026-10-21)

Read through the Coolify MCP (environment variable names only), the Coolify
compose view (secret values filtered out), the n8n UI and external HTTPS
requests. Nothing was changed, saved, deployed or restarted. The instance is
a Coolify "n8n with PostgreSQL" service created on 2026-10-21, on its
temporary Coolify domain.

| Check | Result | Finding |
|---|---|---|
| n8n version | ✅ | `n8nio/n8n:2.44.5`, runners `n8nio/runners:2.44.5` |
| Database | ✅ | `DB_TYPE=postgresdb`, `postgres:17-alpine` in the same stack |
| Persistence | ✅ | named volumes for `/home/node/.n8n` and `/var/lib/postgresql/data` |
| `N8N_ENCRYPTION_KEY` | ⚠️ | not set explicitly; n8n generated a key in the data volume, not in the password manager |
| HTTPS | ⚠️ | valid Let's Encrypt certificate, HTTP redirects to HTTPS, `/healthz` and `/healthz/readiness` 200; `WEBHOOK_URL`, `N8N_HOST`, `N8N_EDITOR_BASE_URL` follow `SERVICE_URL_N8N`, `N8N_PROXY_HOPS` set (template default 1); still the temporary domain |
| Accounts | ⚠️ | one user (Mario, owner), no pending invitations; 2FA disabled |
| Separation from Orbit | ✅ | own Coolify project and Postgres, stack network only, no published ports, no Orbit variables |
| Other workflows | ✅ | none; no credentials, no executions |
| Execution data and hardening | ❌ | none of `EXECUTIONS_*`, `N8N_DIAGNOSTICS_ENABLED`, `N8N_PERSONALIZATION_ENABLED`, `N8N_VERSION_NOTIFICATIONS_ENABLED`, `N8N_TEMPLATES_ENABLED`, `N8N_PUBLIC_API_DISABLED`, `N8N_COMMUNITY_PACKAGES_ENABLED`, `N8N_SECURE_COOKIE`, `NODE_FUNCTION_ALLOW_BUILTIN`, `N8N_RUNNERS_TASK_TIMEOUT` is set; community nodes are enabled; `N8N_BLOCK_ENV_ACCESS_IN_NODE` is set with template default `true` (the gateway needs `false`) |
| Task runners | ⚠️ | `N8N_RUNNERS_MODE=external` with a separate runner container; the local evidence then used the internal runner (section 5; external runners passed locally later the same day, see below); the Python runner is enabled (`N8N_NATIVE_PYTHON_RUNNER`, template default `true`) |
| Backups | ❌ | no Coolify backup schedule and no scheduled task |

Final domain (Mario, 2026-10-21): `n8n.eds-labs.io`, so the Orbit
integrations will use `https://n8n.eds-labs.io/webhook/orbit-cc`. No DNS
record exists for it yet.

Gaps, in the order of section 11 steps 1 and 2 (each a separate approval):

1. Turn on 2FA for the owner account (Mario). **Done 2026-10-21.**
2. Store the generated encryption key in the password manager and set it as
   a locked Coolify variable `N8N_ENCRYPTION_KEY` with the **same** value;
   n8n refuses to start when the variable differs from the key in its
   settings file. **Done 2026-10-21** (see below; the first reference sat in
   the wrong service and was moved).
3. Daily backup of the n8n database as in section 8, then a restore drill
   into an isolated database. **Open** (2026-10-21): an R2 storage is
   connected in Coolify, but the n8n service has no backup schedule or
   execution yet.
4. Domain: DNS A record for `n8n.eds-labs.io`, change the n8n service domain
   in Coolify, redeploy, check the certificate and `/healthz`. **Done
   2026-10-21** (see below).
5. Run the local end-to-end test with external task runners (section 5)
   before changing the env access setting. **Done 2026-10-21** (see below).
6. Instance env from `deploy/n8n.env.example` (execution data, hardening,
   `NODE_FUNCTION_ALLOW_BUILTIN=crypto` on n8n (the runner image allows
   `crypto` already, section 5), and
   `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` last); optionally disable the
   Python runner. Execution data and hardening **done 2026-10-21**; gateway
   settings, workflow import and `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` done
   the same day (see below). Section 11 steps 1 and 2 are complete apart from
   the backup.
7. Optional (section 6): restrict the editor UI in Traefik.

### Encryption key made explicit (2026-10-21)

Mario read the key that n8n had generated, stored it in the password manager,
referenced `N8N_ENCRYPTION_KEY` in the compose file, set it as a locked
Coolify variable with the same value and redeployed. Correction (found while
applying section 2): the reference sits in the `task-runners` service, not in
`n8n`, so the main process does not receive the variable and keeps using the
key from its settings file; the runner launcher does not pass it on either.
On Mario's approval Claude then moved the reference from `task-runners` to
`n8n`, saved the compose file and restarted the service (17:01 server time).
Verified read-only: the saved and the generated compose file reference
`N8N_ENCRYPTION_KEY` only in `n8n`; one fresh start with version 2.44.5, both
runners registered, all containers `running:healthy`, readiness 200, and no
encryption key mismatch or other error in the n8n log, so the Coolify value
matches the key in the settings file. Verified
read-only afterwards: the variable exists (name only, locked), n8n and the
runner are `running:healthy`, `/healthz` and `/healthz/readiness` answer 200,
and the n8n log shows no encryption key mismatch. Observation: right after the
restart n8n logged one `EAI_AGAIN` DNS failure for `api.n8n.io`; check
outbound DNS from the container before the adapters call Desk and FamilyPlan.

### External task runners (local, 2026-10-21)

`apps/api/tests/customer-context-n8n.integration.test.ts` with
`N8N_E2E_RUNNERS=external`: n8n 2.44.5 on the host (SQLite, loopback) and the
`n8nio/runners:2.44.5` image in Docker, connected to the task broker with a
per-run token and without any product or Code node variable in the runner
container. 7/7 with the FamilyPlan fixtures and 7/7 with FamilyPlan's real
handler (familyplan `2f9765b`); the internal-runner run stayed 7/7 and the
integration unit tests 55/55. This shows that the runner image allows
`crypto`, and that `$env` and the product calls are served by the main
process (the runner container had neither the variables nor a route to the
loopback stubs). Negative check: with the runner container stopped, the
gateway answered 500 after 10 s instead of its 401, so the Code nodes ran
only in the external runner. Not covered: the Coolify network between the
two containers and the production values.

### Final domain (2026-10-21)

Mario created the DNS record and set the n8n service domain in Coolify to
`https://n8n.eds-labs.io:5678` (the port names the container port for the
proxy; the public URL has none), then redeployed. Verified read-only: Let's
Encrypt certificate for `n8n.eds-labs.io` (valid until 2027-01-19), HTTP
redirects to HTTPS, `/healthz` and `/healthz/readiness` 200, port 5678 is
not reachable from outside, the temporary domain no longer routes (503),
and Coolify reports the n8n URL as `https://n8n.eds-labs.io` with all
containers `running:healthy`. `WEBHOOK_URL`, `N8N_HOST` and
`N8N_EDITOR_BASE_URL` reference `SERVICE_URL_N8N`, which Coolify derives
from that domain; their runtime values were not read. The webhook base is
confirmed directly once the gateway is imported (the lookup path answers 404
until then).

### Execution data and hardening applied (2026-10-21)

On Mario's approval Claude added the section 2 settings as literal values to
the compose file in Coolify: in `n8n` all `EXECUTIONS_*` settings,
`N8N_RUNNERS_TASK_TIMEOUT`, `N8N_DIAGNOSTICS_ENABLED`,
`N8N_PERSONALIZATION_ENABLED`, `N8N_VERSION_NOTIFICATIONS_ENABLED`,
`N8N_TEMPLATES_ENABLED`, `N8N_PUBLIC_API_DISABLED`,
`N8N_COMMUNITY_PACKAGES_ENABLED` and `N8N_SECURE_COOKIE` with the values of
`deploy/n8n.env.example`, and `N8N_RUNNERS_TASK_TIMEOUT=60` in
`task-runners`; then saved and restarted the service. Not changed:
`N8N_BLOCK_ENV_ACCESS_IN_NODE`, `NODE_FUNCTION_ALLOW_BUILTIN`, the `CC_*`
variables, the Python runner and the encryption key reference.

Verified read-only afterwards: the saved and the generated compose file
contain the settings; all containers `running:healthy`; `/healthz` and
`/healthz/readiness` 200; n8n reports community nodes disabled; the log
shows version 2.44.5, both runners registered, "Editor is now accessible via
https://n8n.eds-labs.io" (so the editor base URL follows the domain) and no
DNS error. In 2.44.5 the `/api/v1` routes stay mounted and answer 401;
`N8N_PUBLIC_API_DISABLED=true` disables API key authentication (creating,
listing and using keys), so a 401 does not mean the API is enabled. n8n
warns that `WEBHOOK_URL` (set by the Coolify template) is deprecated in
favour of `N8N_WEBHOOK_URL`; it still works, revisit with the next update.

### Gateway settings and workflow import (2026-10-21)

Mario added `NODE_FUNCTION_ALLOW_BUILTIN=crypto` and the `CC_*` references
to the `n8n` service of the compose file (`CC_GATEWAY_INTEGRATIONS` defaults
to `[]`, `CC_DESK_BASE_URL` to `https://api.desk.uliquid.vip`; tokens and the
FamilyPlan URL still empty), saved and restarted. Verified read-only: the
references sit in `n8n`, the five `CC_*` variables exist in Coolify, all
containers are healthy. `N8N_BLOCK_ENV_ACCESS_IN_NODE` is still `true` (to be
changed only after 2FA, section 4).

Import without a shell in the container: n8n 2.44.5 accepts the workflow id
when a workflow is created through its REST API, so Claude imported the
generated files (commit `f1a8286`, SHA-256 checked in the browser) through
Mario's signed-in editor session, adapters first, and published each version
(`POST /rest/workflows/:id/activate` with its `versionId`). The same
procedure was rehearsed first against a throwaway local n8n 2.44.5.
Verified: exactly the three workflows `CcAdapterUliquidDesk01`,
`CcAdapterFamilyPlan001` and `CcGatewayOrbit0001` exist and are active;
their stored nodes, connections and settings equal the files. An unsigned
call to `https://n8n.eds-labs.io/webhook/orbit-cc/v1/customer-context/lookup`
answers 500 "Error in workflow", as expected while the Code nodes cannot read
`$env`; failed executions are not stored. After the env access change the
same call must answer 401.

### Env access on, gateway refusing (2026-10-21)

After turning on 2FA, Mario set `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` and
restarted the service. Verified read-only: one owner account, no pending
invitations, 2FA enabled; one fresh start (17:22 server time) with version
2.44.5, both runners registered, no error; all containers healthy,
readiness 200; the three workflows active. An unsigned call and a call with
a wrong bearer token to the lookup webhook both answer 401 with the
gateway's own `unauthenticated` problem details, so the Code nodes run in
the external runner with `crypto` and `$env` on Coolify, and with
`CC_GATEWAY_INTEGRATIONS=[]` every request is refused. The gateway logged
nothing for these calls. Next: section 11 step 3 (Desk token).

### Desk token (section 11 step 3, 2026-10-21)

Mario generated a new `dctx_` token on the Desk server shell (Coolify
terminal), wrote its SHA-256 as `CUSTOMER_CONTEXT_API_CLIENTS=n8n:<sha256>`
(no `:grant`, the adapter sends no customer grants) into
`/opt/uliquid-desk/.env.prod` and `.runtime-env/api.env` (backups
`*.bak-20261021`), and restarted only the Desk `api` container. Desk check
with the reserved subject `orbit-connection-check`: 404 with the token, 401
without. Mario then set `CC_DESK_TOKEN` in Coolify and restarted n8n.
Verified read-only: the variable exists; one clean n8n start (18:08 server
time) with both runners; all containers healthy; the gateway still answers
401 (`CC_GATEWAY_INTEGRATIONS=[]`). Mario then locked the variable (verified
read-only: locked like `N8N_ENCRYPTION_KEY`). The token is not yet proven through n8n; the Orbit connection check
in step 5 does that (expected: Desk answers 404 for the reserved subject).
Deviation from the Desk runbook: the token lives in the n8n environment, not
in an n8n credential (section 3), and the Desk files were edited directly
instead of re-rendered, with the same result for this single key.

### FamilyPlan function deployed (section 11 step 4, 2026-10-21)

Mario merged familyplan PR #1 (`06e47a2`; function, contract and
`config.toml` identical to the tested `2f9765b`, whose 12 function tests
passed locally), and Codex deployed only `support-customer-context` to the
FamilyPlan Supabase project (version 1, `verify_jwt=false`). The local
Supabase CLI had an invalid code signature after an update and was killed by
macOS; `brew reinstall supabase` fixed it. Verified read-only without a
token: `POST` 503 `NOT_CONFIGURED` (no token hash set yet, fail closed, and
no Supabase gateway 401, so JWT verification is off), `POST` with an
`Origin` header 403, `GET` 405, `Cache-Control: no-store, private`. Next: the
token hash as function secret `SUPPORT_CUSTOMER_CONTEXT_TOKEN_SHA256`, then
`CC_FAMILYPLAN_TOKEN` and `CC_FAMILYPLAN_FUNCTION_URL` in n8n.

FamilyPlan token (same day): Mario generated a `fpctx_` token in a server
shell, set its SHA-256 as the function secret
`SUPPORT_CUSTOMER_CONTEXT_TOKEN_SHA256` in the Supabase dashboard and checked
the function directly: 401 without the token, 400 with the token for the
reserved subject `orbit-connection-check` (authenticated, then refused as
not a FamilyPlan id, as Orbit's connection check expects). Mario then set
`CC_FAMILYPLAN_TOKEN` (locked) and `CC_FAMILYPLAN_FUNCTION_URL` in Coolify
and restarted n8n. Verified read-only: both variables exist, the token is
locked; one clean start (18:38 server time) with both runners; all
containers healthy; the gateway still answers 401; the function answers
401 without a token. Section 11 steps 3 and 4 are done; the end-to-end path
through n8n is proven by the Orbit connection checks in step 5.

### Orbit side deployed, flag off (2026-10-22)

On Mario's approval Claude pushed PR #182 (`e5d039c`, including the review
fixes for e-mail drafts, the lookup URL and umlaut topic words; all local
checks green, 3147 tests) to `main` as a fast-forward; Coolify deployed it
automatically (05:06–05:11 UTC, status finished). No migration. Verified
read-only: `https://orbit.eds-labs.io/` 200, `/healthz` 200, the new route
answers 401 without a session, and with Mario's session
`GET /api/projects/:id/modules` reports `features.customerContext: false`.
`ORBIT_CUSTOMER_CONTEXT` stays off. Next: section 11 step 5 (switch the
flag on, create the two integrations, add them to `CC_GATEWAY_INTEGRATIONS`,
connection checks), each with its own approval.

### Section 11 step 5: flag on, integrations verified (2026-10-22)

- Mario set `ORBIT_CUSTOMER_CONTEXT=true` (production row) in Coolify and
  redeployed Orbit (07:44–07:49 UTC); Orbit reports
  `features.customerContext: true` in both projects. A first attempt was not
  saved; check the value before deploying.
- Mario generated the bearer tokens and signing secrets in a server shell
  and created one integration per project with base URL
  `https://n8n.eds-labs.io/webhook/orbit-cc`: "uLiquid Desk"
  (`uliquid-desk`, project uLiquid) and "FamilyPlan" (`familyplan`, project
  FamilyPlan). From the same shell he built `CC_GATEWAY_INTEGRATIONS`
  (integration ids, token SHA-256, signing secrets), set it in Coolify and
  restarted n8n.
- Connection checks (Claude, through Mario's session): FamilyPlan
  `read_verified` at the first attempt. Desk first timed out (cold task
  runner), then failed with a provider error; the Desk log showed
  `customer_context_auth_rejected`, so `CC_DESK_TOKEN` did not match Desk's
  hash (most likely a partial copy: a double click in the terminal stops at
  `-`). Mario issued a hex-only `dctx_` token on the Desk server (Desk check
  404), and, because a locked Coolify variable referenced by the compose
  file cannot be deleted, pointed the compose reference to a new variable
  (`CC_DESK_TOKEN=${CC_DESK_TOKEN_V2}`) and restarted n8n. Desk check then
  `read_verified` (3.6 s). Both integrations are verified; the path
  Orbit -> n8n -> product is proven for Desk and FamilyPlan.

Open after step 5:
- Lock `CC_GATEWAY_INTEGRATIONS` and `CC_DESK_TOKEN_V2` (both not locked at
  the time of the check) and delete the unused old `CC_DESK_TOKEN`.
- Cold start: the JavaScript runner shuts down after 15 s idle
  (`N8N_RUNNERS_AUTO_SHUTDOWN_TIMEOUT=15`); the first lookup after that took
  up to the 4 s Orbit timeout. Set it to `0` on the runner (or raise the
  integration timeout) before step 6.
- The n8n database backup (section 8).

### Locks, runner warm, Desk token exposure (2026-10-22)

- `CC_GATEWAY_INTEGRATIONS` and `CC_DESK_TOKEN_V2` are locked. The old
  `CC_DESK_TOKEN` variable cannot be deleted ("managed by compose": the
  container key is still named `CC_DESK_TOKEN`, now fed from
  `${CC_DESK_TOKEN_V2}`); its old value is unused and no longer valid at Desk.
- Mario set `N8N_RUNNERS_AUTO_SHUTDOWN_TIMEOUT=0` and restarted n8n. After
  about 90 s idle the connection checks took 582 ms (Desk) and 689 ms
  (FamilyPlan) instead of up to 3.6 s; both 200.
- Incident: while looking for the remaining `CC_DESK_TOKEN` reference,
  Claude read the generated compose file in the Coolify UI with a filter that
  assumed `KEY=value` lines; the generated file uses `KEY: value` with
  resolved values, so the `CC_DESK_TOKEN_V2` value appeared in the agent
  session. Treat that Desk token as exposed and rotate it (Desk hash and
  n8n variable). Lesson: never read Coolify's generated compose file, it
  holds resolved secrets; read only the raw compose with key names.

UI fix deployed (2026-10-22): the integration list under Connectors and the
inbox's "Customer account from" select requested `/api/api/…` and showed
"not configured" / no option although both integrations were verified.
Fixed in `1d6f52f` (with a source check against `/api` paths in
`useResource`), pushed to `main` on Mario's approval and deployed
automatically (08:46–08:51 UTC). Verified: Connectors shows "read verified"
for "uLiquid Desk" and "FamilyPlan" in their projects, and the FamilyPlan
inbox editor offers "FamilyPlan (familyplan)"; no inbox is bound yet.

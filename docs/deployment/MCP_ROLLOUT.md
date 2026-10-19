# MCP gateway rollout (Track M, WP-M5)

This runbook turns on the Orbit MCP gateway (OAuth server, `mcp` service, proposal tools) in production, one approved step at a time. It authorizes nothing by itself: every step below needs its own explicit OK from Mario (table "Approvals needed"). Nothing in it has been run against production yet.

Design and decisions: `plans/orbit-modularization/09-mcp-gateway.md` (§3.1 placement, §7 limits and audit, §9 review checklist) and the WP-M5 plan `docs/superpowers/plans/2026-10-19-track-m-wp-m5-rollout.md` (D-M5-1…10). Status and checklists: `docs/IMPLEMENTATION_STATUS.md` (Track M sections). Prepared security review: `docs/SECURITY_REVIEW.md`, "MCP gateway prepared review (WP-M5)".

`<APP_ORIGIN>` below is the production web origin (the `APP_ORIGIN` value in Coolify). The MCP resource and endpoint is `<APP_ORIGIN>/mcp` (`MCP_RESOURCE` blank = this default; it must stay stable forever, it is bound into tokens and client configurations).

## Preconditions

1. WP-M4 (#172) is merged and deployed (A1), then the WP-M5 PR (A2). The WP-M5 branch is stacked on #172; retarget its PR to `main` after #172 merges and re-run CI.
2. A push to `main` deploys through the Coolify webhook, so each merge is a production deployment.
3. In Coolify the flags are still off: `ORBIT_MCP_OAUTH`, `ORBIT_MCP_GATEWAY`, `ORBIT_MCP_PROPOSALS`, `ORBIT_MCP_DCR` are `false` or empty. `MCP_RESOURCE` is empty (default `<APP_ORIGIN>/mcp`), `ORBIT_MCP_CIMD_HOSTS` is `chatgpt.com`, `ORBIT_MCP_ALLOWED_ORIGINS` is empty (no browser clients), `MCP_JWKS_URL` and `ORBIT_MCP_ORIGIN` are empty (compose defaults `http://api:4311/api/auth/jwks` and `http://mcp:4312`).
4. A current backup exists (`docs/BACKUP_RESTORE.md`) before A2, which carries a migration.
5. The smoke script runs from a checkout of the deployed commit with Node 24: `node scripts/mcp-smoke.ts` (no dependency, no download; see the header of `scripts/mcp-smoke.ts`). It prints one `PASS`/`FAIL`/`SKIP` line per check and exits 1 on a failure. A token, when used, is read from `MCP_SMOKE_TOKEN` and never printed; set it with `read -s MCP_SMOKE_TOKEN; export MCP_SMOKE_TOKEN` and `unset MCP_SMOKE_TOKEN` afterwards. Never paste a token into a chat, ticket or log.

## Approvals needed

Each row is a separate OK from Mario, given in order (exceptions: A7 may come before A6, and A9 at any time). A later step never starts before the earlier one is verified. Sub-steps named in a row are part of that row's OK; a sub-step marked "own OK" needs a separate one.

| # | Step | Production effect | Verify with |
|---|---|---|---|
| A1 | Merge #172 (WP-M4) | Code only, no migration; flags stay off, nothing MCP-related runs | Deployment healthy; existing smoke of the app |
| A2 | Merge the WP-M5 PR. Sub-steps: (a) the read-only pre-check query before the merge; (b) clearing a domain Coolify generated for `mcp`, if any (own OK, a Coolify change) | Migration `202610190001_mcp_grant_constraints` (additive) and the new `mcp` compose service in disabled mode; nothing is exposed | "A2 in detail" below; `node scripts/mcp-smoke.ts --disabled` once A3 routes `/mcp` |
| A3 | Coolify: domain `<APP_ORIGIN>/mcp` on the `mcp` service | `/mcp` reaches the disabled gateway (404, health only) | "Coolify setup" below |
| A4 | `ORBIT_MCP_OAUTH=true` | OAuth server, `/connect` and Connected apps live; gateway still disabled | "Flag flips", step 1 |
| A5 | `ORBIT_MCP_GATEWAY=true` | Gateway serves read tools to granted clients | "Flag flips", step 2 |
| A6 | ChatGPT developer-mode connector with Mario's account, read only | First real client connects (consent, search, fetch) | "ChatGPT developer mode" below |
| A7 | MCP Inspector download and run | A tool is downloaded and run locally. In production it may also need `ORBIT_MCP_DCR=true` for the run, or an extra host in `ORBIT_MCP_CIMD_HOSTS`; each of these is its own OK (A7a), and is reverted after the run | "MCP Inspector" below |
| A8 | `ORBIT_MCP_PROPOSALS=true` | Proposal tool listed for granted editors; proposals wait for the owner's decision in Orbit | "Flag flips", step 3 |
| A9 | Decisions from D-M5-9 | Product decisions only | `docs/SECURITY_REVIEW.md`, "Open points and Mario decisions" |

A7 can run before A6: the Inspector shows an access token, which the authenticated part of the smoke needs. A9 can be decided at any time; its outcome may add work before A8.

## A2 in detail: what the merge changes in production

- **Migration `202610190001_mcp_grant_constraints`** (auth tables, additive; `McpGrant` is unqualified, in the default schema): a `CHECK` constraint `McpGrant_status_check` (`status IN ('pending','active','revoked')`), an index `McpGrant_sessionId_idx`, and a nullable column `McpGrant.requestHash` (binds a pending selection to its authorization request). Before merging (sub-step A2a), run this read-only query in the production database (Coolify, postgres service terminal, `psql` as the owner role `orbit_migrator`); the result must be `0`, otherwise the migration fails and the stack does not start:

  ```sql
  SELECT count(*) FROM "McpGrant" WHERE "status" NOT IN ('pending','active','revoked');
  ```

  With `ORBIT_MCP_OAUTH` off the table should be empty. Existing pending selections (none expected) would need a new selection after the merge.
- **Release gate**: the `migrate` service runs `scripts/db-deploy.ts --allow-remote-migration`, which refuses without `ORBIT_RELEASE_APPROVAL` (compose blocks the deployment while it is empty). It is already set in Coolify; check that it is present and update it to the A2 change reference if desired, as for earlier releases (`docs/deployment/MODULAR_PLATFORM_ROLLOUT.md`).
- **New compose service `mcp`** (same image, `node_modules/.bin/tsx apps/api/src/mcp-main.ts`, port 4312, health check on `/healthz`, `stop_grace_period: 15s`). With either flag off it runs in **disabled mode** (D-M5-1): `GET /healthz` answers `{"status":"disabled"}`, everything else 404 before any body is read; no auth, database or tool code is loaded.
- **Web**: `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` are forwarded to the `mcp` service (D-M5-4). While disabled they answer 404 as before; if the `mcp` container is down they answer 502. The forwarding passes no cookies back to the browser.
- **Code with flags off**: the OAuth pre-flip hardening, gateway hardening and proposal controls are inactive until A4/A5/A8.

After the deployment, in Coolify:

1. The `mcp` service is healthy and its log shows a "listening" line; `migrate` completed once.
2. The constraint and index exist (read-only): `SELECT conname FROM pg_constraint WHERE conname = 'McpGrant_status_check';` and `SELECT indexname FROM pg_indexes WHERE indexname = 'McpGrant_sessionId_idx';`.
3. **The `<<:` merge key renders**: the `mcp` service's environment in Coolify contains the shared API variables (for example `DATABASE_URL`, `ORBIT_MCP_GATEWAY`) plus `MCP_PORT=4312` and `MCP_JWKS_URL`. Docker Compose renders the YAML merge key locally (`node scripts/check-coolify-compose.mjs`); Coolify parses the file itself, so check its render.
4. **No public domain yet**: open the `mcp` service's domain field. Coolify may generate a domain from the path-only `SERVICE_URL_MCP_4312: /mcp` at deploy time. If a generated domain appeared, clearing it is a Coolify change and needs its own OK (sub-step A2b); until then it exposes only the disabled health check (everything else 404). The route itself belongs to A3.

## Coolify setup (A3)

1. On the `mcp` service set the domain to `<APP_ORIGIN>/mcp` (same host as `web`, path `/mcp`, port 4312). Do not assign domains to any other new service. Redeploy so Traefik picks up the route.
2. **Router priority**: Traefik ranks rules by length, so `Host && PathPrefix(/mcp)` beats the web catch-all. Verify: `curl -si -X POST -H 'content-type: application/json' -d '{}' <APP_ORIGIN>/mcp` must answer the gateway's empty 404 (disabled) and not a Next page. No web route starts with `/mcp` today (`/api/mcp-connect/*` and `/api/mcp-grants` start with `/api`); keep it that way, since `PathPrefix(/mcp)` also matches `/mcpanything`.
3. **Prefix handling**: the gateway serves the endpoint at `/mcp` and at `/` (D-M5-3), so both a stripped and an unstripped prefix work. Find out which one Coolify does: `curl -s <APP_ORIGIN>/mcp/healthz`. `{"status":"disabled"}` means the prefix is stripped; the health status (`disabled` or `ok`, nothing else) is then public, which goes into the A3 record. A 404 means it is not stripped.
4. **Disabled smoke**: `MCP_SMOKE_URL=<APP_ORIGIN>/mcp MCP_SMOKE_WEB_URL=<APP_ORIGIN> node scripts/mcp-smoke.ts --disabled` (add `MCP_SMOKE_HEALTH_URL=<APP_ORIGIN>/mcp/healthz` if the prefix is stripped). Expect `RESULT PASS`.
5. **Client address and peer trust** (checked after A5, when the endpoint answers 401): the gateway believes the right-most `X-Forwarded-For` entry only from a loopback or private peer (Traefik on the Coolify network) and keys the unauthenticated limit (30 a minute) on it, IPv6 by /64. From one network, send 31 requests within a minute; the last one answers `429`:

   ```sh
   for i in $(seq 31); do curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' <APP_ORIGIN>/mcp; done
   ```

   The same request with a forged header (`-H 'X-Forwarded-For: 203.0.113.9'`) from that network still gets 429. From a second network (phone hotspot) it gets `401` at once. If both networks get 429, every client shares one key (a CDN or another proxy in front of Traefik, or Traefik not appending): stop and fix before A6. The `mcp` service publishes no host port (asserted by `scripts/check-coolify-compose.mjs`), so a docker-proxy peer cannot spoof the header.
6. **Stop grace**: on the server, `docker inspect --format '{{.Config.StopTimeout}}' <mcp container>` shows `15`. If Coolify drops `stop_grace_period`, the gateway's own 10 s forced exit still applies, but Docker's default 10 s SIGKILL can race it.

## Flag flips (A4, A5, A8)

Set each flag in the Coolify environment (shared by `api`, `worker` and `mcp`) and redeploy. One flag per deployment; smoke after each.

1. **A4 `ORBIT_MCP_OAUTH=true`.** Smoke:
   - `<APP_ORIGIN>/.well-known/oauth-authorization-server/api/auth` answers 200 JSON with `issuer` `<APP_ORIGIN>/api/auth`, `code_challenge_methods_supported` `["S256"]` and `authorization_response_iss_parameter_supported` `true`; `<APP_ORIGIN>/api/auth/jwks` answers 200.
   - Settings → Connected apps is visible; `/connect` renders.
   - The gateway is still disabled: the `--disabled` smoke from A3 still passes.
2. **A5 `ORBIT_MCP_GATEWAY=true`.** The `mcp` log shows "listening", and the health check answers `{"status":"ok"}`. Smoke without a token:
   `MCP_SMOKE_URL=<APP_ORIGIN>/mcp MCP_SMOKE_WEB_URL=<APP_ORIGIN> MCP_SMOKE_SKIP_SEARCH=1 node scripts/mcp-smoke.ts`
   checks both PRM paths (resource, authorization server, scopes, bearer method), the 401 challenge (`WWW-Authenticate: Bearer resource_metadata="<APP_ORIGIN>/.well-known/oauth-protected-resource/mcp"`) with and without an invalid token, and `GET` → 405; the authenticated checks are skipped. Then the client-address check from "Coolify setup", step 5. With a token (from A7, or any client that shows it), the same command without `MCP_SMOKE_SKIP_SEARCH` adds, for 2026-07-28 and 2025-11-25: discovery (`server/discover` / `initialize`, stateless), `tools/list`, `tools/call orbit_projects`, `tools/call search`, unknown tool → -32602, and a batch → 400/-32600. `search` may spend one query embedding per project (at most five) when a project's spend mandate approves paid tests.
   The consent flow, `search`/`fetch` with citations and the revoke check run with the real client (A6).
3. **A8 `ORBIT_MCP_PROPOSALS=true`.** Reconnect the connector with `orbit:propose` ticked on the consent step. `tools/list` now contains `marketing_assignment_propose` for an editor grant. Propose one test assignment; it appears as a pending request in the owner's approval inbox and nothing runs. Reject it there. Then "Stop proposals" on the grant in Connected apps: the tool disappears on the next request and the next connect shows the consent step again.

## ChatGPT developer mode (A6)

Q-21/Q-23: check first that Mario's ChatGPT plan offers developer mode with custom MCP connectors. Menu names change; as of writing:

1. ChatGPT → Settings → Apps (Connectors) → Advanced settings → enable Developer mode.
2. Create a connector: MCP server URL `<APP_ORIGIN>/mcp`, authentication OAuth. ChatGPT discovers the PRM, the authorization server and registers by its client metadata document (`chatgpt.com` is the only allowed CIMD host; DCR stays off).
3. Sign in to Orbit if asked; on the consent step select the workspace and projects and **untick `orbit:propose`** (read only; `ORBIT_MCP_PROPOSALS` is off anyway).
4. In a chat with the connector: ask for the projects (`orbit_projects`), a knowledge question (`search`, then `fetch` with citations that open Orbit or the canonical source), and the marketing status (`marketing_project_status`).
5. Revoke the grant in Settings → Connected apps; the next ChatGPT call must fail and ChatGPT must offer to reconnect. Reconnect afterwards if the connector stays in use.
6. Record the result in `docs/IMPLEMENTATION_STATUS.md` (Track M) without tokens, ids of real users or conversation content.

## MCP Inspector (A7)

The Inspector is an external tool: its download (exact version, source, size) and run need the approval. It runs locally against the deployed endpoint, for both revisions, with its conformance checks and the OAuth flow. The Inspector must be able to register: either temporarily `ORBIT_MCP_DCR=true` in production (Better Auth allows 5 registrations a minute per IP; set it back to `false` right after and revoke the Inspector's grant), or an extra host in `ORBIT_MCP_CIMD_HOSTS` for the run. Check which one the pinned Inspector version supports before the run. Either change is a production configuration change with its own OK (A7a), separate from the download. The access token it shows can feed the authenticated smoke above (never copy it anywhere else).

## Monitoring

- **Uptime Kuma**: the gateway's `/healthz` is not public unless Coolify strips the prefix (then `<APP_ORIGIN>/mcp/healthz`, keyword `"ok"`). Otherwise monitor `<APP_ORIGIN>/.well-known/oauth-protected-resource/mcp` (keyword `authorization_servers`, 5 minutes): it goes through web to the gateway, so it fails when either is down. The container health check covers `/healthz` inside Coolify.
- **Logs** (JSON lines with `code`; no tokens, arguments or bodies are logged). In the `mcp` service unless noted:
  - `MCP_RATE_LIMITED` with `bucket`: `ip` (unauthenticated per address), `capacity` (the address limiter is full: an address flood; alert on any), `grant`, `user`, `client`, `search`, `proposal`.
  - After every gateway restart the verified-token cache is empty, so each client's first request counts against its address again: watch `bucket: ip` 429s for a few minutes after a deploy (ChatGPT calls from shared egress addresses).
  - Plain 401s are challenges and expected; a rise without matching reconnects points at a key-set or grant problem.
  - `MCP_REQUEST_FAILED` (503, for example the JWKS URL unreachable), `MCP_PROPOSAL_RECORD_FAILED` (a proposal was created but its quota event was not written; the daily quota is then one short), `MCP_OUTPUT_INVALID`, `MCP_TOOL_TIMEOUT`, `MCP_SEARCH_PROJECT_BUSY` and `MCP_SEARCH_PROJECT_UNAVAILABLE` (a project skipped in a multi-project search), `MCP_AUDIT_FAILED`, `MCP_CALL_LOG_FAILED`, `MCP_LAST_USED_FAILED`, `MCP_OBSERVER_FAILED`.
  - In the `api` service: `MCP_PROPOSAL_CANCEL_FAILED` (a pending proposal could not be cancelled after a grant revocation, a proposal stop or a client change; the approval guard still refuses it).
- **Data**: `AuditEvent` `mcp.tool_call` per project call, `McpGrantEvent` for project-less calls and grant changes, `AgentRun` kind `mcp` in the AI cost views.

## Incident steps

Pick the narrowest step that stops the problem; each production change still needs Mario's OK unless the incident procedure in `.agentic/workflows/incident-fix.md` says otherwise.

1. **One user's connection misbehaves**: revoke the grant (the user in Settings → Connected apps, or a workspace owner in the owner section). It takes effect on the next call; pending proposals of the grant are cancelled.
2. **One client misbehaves** (for example a looping agent): revoke every grant of that client in the owner section. There is no single "disable client" action yet (see the security review). Removing its host from `ORBIT_MCP_CIMD_HOSTS` stops new registrations from that host.
3. **Proposals cause trouble**: per grant "Stop proposals" in Connected apps, or for everyone `ORBIT_MCP_PROPOSALS=false` (proposal tools vanish; already created requests stay pending for the owner to reject).
4. **The gateway causes trouble**: `ORBIT_MCP_GATEWAY=false` and redeploy; the service drops to disabled mode, clients get 404. `ORBIT_MCP_OAUTH=false` also closes the OAuth server, `/connect` and Connected apps; access tokens expire within 10 minutes and are useless without the gateway.
5. **Signing key suspected compromised**: first step 4 (no token is accepted while the gateway is off). Rotating the key means replacing the rows of the auth table `jwks` (Better Auth creates a new key when none exists); this deletes data and needs an explicit approval. Access tokens signed with the old key then fail (restart `mcp` to drop its 5-minute key cache). Refresh tokens are opaque and not signed, so revoke the affected grants as well if they may be exposed. This procedure is not rehearsed yet; rehearse it on a local database before relying on it.

## Rollback

- Flags off in reverse order (`ORBIT_MCP_PROPOSALS`, `ORBIT_MCP_GATEWAY`, `ORBIT_MCP_OAUTH`) and redeploy, or remove the `/mcp` domain from the `mcp` service (A3 undone; the service keeps running disabled).
- Code: redeploy the previous `main` commit. The migration stays in place: it is additive (constraint, index, nullable column) and the previous code runs against it; dropping it is not part of a rollback.

## Known limitations

- `infra/compose.yml` (the non-Coolify Caddy variant) has no `mcp` service, so the two PRM paths answer 502 there.
- The `mcp` container gets the whole API environment (database URLs, auth secret, credential key) and the `database` and `egress` networks, also while disabled. Least-privilege environment and networks for `mcp` are a follow-up.
- The daily proposal quota can be overshot by calls already in flight (no database guard); the hourly bucket is charged first and caps 20 an hour per key and process.
- Under an address flood (`bucket: capacity`), a legitimate client with an expired token from a new address gets 429 instead of the 401 challenge until the window ends.
- Limits are per process; a second gateway replica needs Redis-backed limits first.
- The first request of a token this process has not verified counts against its address: many new users behind one address (NAT, ChatGPT egress) can see 429 until the minute ends.

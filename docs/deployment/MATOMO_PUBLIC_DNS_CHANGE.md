# Production Change Plan

## Ziel

Restore the existing FamilyPlan Matomo integration (site 2) in Orbit. The local host-mapping candidate is conditional on the scoped VM102 loopback NAT helper in `infra/network/`. A temporary source-restricted proof returned public HTTPS 200 with a verified certificate. Do not push/deploy until the persistent helper is installed and verified.

## Betroffene Systeme

Orbit Production (GitHub), Coolify application `q9xduufgytnsqmk6wurfvb4l` on VM102. The generated runtime anchor is shared by API, MCP, worker, web, webmail bridge and the one-shot migration container. The VM102 host additionally receives the scoped NAT helper after Mario's network-path approval. Matomo, its database, public DNS, Proxmox host rules and other services remain unchanged.

## Risiko-Level

Critical: production deployment configuration. Primary profile: backend API, existing stack, incident-fix/release workflow. Impact is a short Orbit deployment interruption and a change in the network path for two existing analytics names. Threat review: retain the connector's private-address rejection, checked-address pinning, HTTPS certificate validation, response limits, redirect rejection and read-only/site-scoped API behavior. Add no private endpoint exception.

## Change Steps

Network preflight on VM102 confirms that `176.31.234.10` routes via `10.50.0.1`, while the existing VM102 HTTPS proxy listens on port 443 and serves Matomo with verified TLS. First test a dedicated VM102 NAT table, scoped to the current Orbit MCP source address and application bridge, destination `176.31.234.10`, TCP 443, DNAT to VM102 `10.50.0.12:443`. Save the existing ruleset, validate with `nft -c`, and arm an automatic five-minute removal of only this new table before applying it. Do not flush or restore unrelated firewall/Docker tables. If successful, persist a rule that discovers only the Orbit API/MCP/worker addresses and refreshes them after deployments. This is standard loopback routing of the existing public proxy; TLS, connector address checks and host security/filter rules remain active.

1. Remove only `analytics.eds-labs.io` and `analytics.uliquid.vip` from the VM102 generator's private-host list; regenerate the adapter and test its resolved configuration.
2. Check the unchanged canonical Compose, database/schema approval hash, previous deployed revision and existing backup health. Commit the isolated fix on the current main baseline and push it to main under Mario's approval.
3. Follow the webhook deployment to completion; verify runtime DNS, container health, authenticated Orbit access and the existing FamilyPlan connector's read-only capability check.

## Datenbank/Migrationen

No schema, SQL migration, grant, database URL, volume or data path change. Baseline/rollback revision: `9a90b828af9f3059073d114e20656a6f3cf31bbb`. The existing approved schema guard remains mandatory; do not change its approved hash. The normal migration service may check already-applied migrations during deployment. Backup precheck: the running backup container reports `external` (boot timestamp only), and Coolify lists no application scheduled tasks. A recent successful off-host backup/restore was not established by this check; do not describe `external` as backup success. No restore or data overwrite is part of this configuration-only candidate.

## Secrets/Config

No credential, feature flag, permission, site ID or stored connector mutation. Remove two generated `extra_hosts` overrides to `10.50.0.12`; public DNS currently resolves both hostnames to `176.31.234.10`. Keep the Orbit/n8n/Postiz mappings. Do not pin a public address in application code or read/print stored secrets.

## Tests vor Deploy

Passed on Node 24.18.0: frozen dependency install, Coolify/PVE resolved-Compose checks and schema-guard negative checks, generator consistency, lint/import boundaries, root/web typecheck, complete production build, 32 mocked connector/Matomo tests (two files), and six host-helper unit tests including fail-closed cases. Connector tests initially failed during shared config setup; rerunning with synthetic non-connectable local configuration passed. No production credentials were loaded. Full database/integration suites were not run: no API/database/domain code changed, and this candidate does not alter canonical Compose or database inputs. Database approval hash remains `7003d212a05fb497af8935f4606e21dd6bb8910cd942e710e837837b9e12fee1`.

## Deployment Plan

**Initial blocker (before NAT proof):** a credential-free HTTPS preflight from the running MCP container on 2026-11-11 returned `ECONNREFUSED` for the public address `176.31.234.10:443`. The current private mapping reaches Matomo with HTTP 200 and a verified TLS certificate. Public DNS resolves correctly to `176.31.234.10`. This established a missing public loopback path in addition to the connector private-address policy. A dedicated VM102 NAT-table test, scoped to the MCP container and public TCP 443, then returned HTTPS 200 with certificate verification and incremented only the new NAT counter. No Proxmox-host rule was modified.

The additionally approved host-side change is documented in `infra/network/README.md`: inspect the VM102/Proxmox route and existing NAT/firewall rules, then restore only Orbit-to-Matomo HTTPS reachability through the public endpoint. Do not add a private-address exception or disable TLS/SSRF protections.

Once the route is verified, a main push triggers the approved Orbit webhook deployment. Do not start a second deployment while one is active. Confirm the exact commit, successful build/schema gate and healthy runtime before provider verification. No separate Matomo or webmail application deployment.

## Post-Deploy Checks

Confirm both analytics hostnames no longer resolve to private addresses from Orbit; API/MCP/worker/web ready; normal authenticated project view; Matomo site 2 read capability verified by Orbit. If the next provider error is authentication rather than routing, report that separately and do not generate/replace a credential automatically.

## Monitoring/Alerts

Current operator state (2026-11-11): installed the checksum-matched helper and units on VM102. `systemd-analyze verify` passed, the service returned `Result=success` / `ExecMainStatus=0`, and the refresh timer is enabled/active. The generated source set contains only the exact current Orbit API/MCP/worker bridge/address tuples (11 at activation). The public Matomo HTTPS probe again returned HTTP 200 with certificate validation. A 15-minute rollback timer (`eds-orbit-matomo-release-rollback.timer`) remains armed during application rollout; it disables/stops the refresh helper and removes only its own table/cache. The earlier five-minute probe was rolled back before this installation. No Proxmox-host or unrelated firewall table was changed. Main delivery and provider verification are the next steps.

Watch Coolify deployment/application health, Orbit read-only readiness and backup status. Report exact deployment/commit and sanitized connector result. Do not trigger paid model runs, posts, messages, tracking events or marketing imports as smoke tests.

## Rollback/Forward-Fix

If the change causes an Orbit regression, revert only this host-mapping change and regenerate/validate the adapter, then deliver the fast-forward revert and redeploy. Alternatively redeploy the previous compatible revision under the approved recovery procedure. Preserve live database/Redis/files and all keys. Restoring the two private mappings reintroduces the known Matomo failure; do not weaken connector security to mask it.

## Approval

- Required: yes
- Approved by: Mario, explicit “ja” to correcting the Matomo host mapping and redeploying the affected Orbit services in this chat.
- Date: 2026-11-11
- Scope: the host-mapping correction and affected Orbit redeployment. Mario additionally approved the narrowly scoped Proxmox/VM102 network-path correction for Orbit-to-public-Matomo HTTPS in this chat on 2026-11-11. The scoped VM102 helper is installed and verified. No database or credential mutation is part of this change; main delivery and application rollout are authorized as described above.

# Shared Host Deployment

Checkpoint: 2026-09-17. Both standalone and shared-proxy variants passed fresh isolated local Linux ARM64 installation. Evidence is in `docs/evidence/container-acceptance.json`; this is not a production deployment.

Each variant used its own PostgreSQL/Redis volumes and internal database/frontend networks. Both ran the migration/grant entry point and real-role checks, then API/web/worker health and authenticated HTTPS setup/login/logout. Read-only non-root application runtime, CPU/memory/PID limits and all four Linux PNG formats passed.

Standalone uses Orbit's dedicated Caddy proxy. Local acceptance mapped only temporary loopback ports 14080/14443 for the proxy and 14310/14311 for direct app probes; it did not bind host 80/443. The production topology's configured 80/443 bindings still require host-specific conflict checks before release.

Shared hosting attaches **only web** to the named external proxy network. The API, worker, PostgreSQL and Redis stay off that network; the shared app services publish no host ports. In the actual test, a separate Caddy probe and web were the only external-network members, and the probe could not resolve API/PostgreSQL/Redis. This verified the supplied shared topology without modifying an existing proxy project.

TLS used Caddy's private local test CA, trusted only by the acceptance process. No public certificate or DNS change was made. Caddy's executable requires the minimal `NET_BIND_SERVICE` capability; application containers retain no capabilities. Native rasterization uses installed DejaVu fonts and a cache under `/tmp`.

Both temporary projects were shut down after acceptance, preserving their volumes. Existing local development services, Desk and Forecast were untouched. Follow `DEPLOYMENT_BOOTSTRAP.md` only after a separately authorized release. Production host capacity, public TLS, firewall routing, AMD64 and shared-host I/O guarantees remain unverified.

# Deployment bootstrap — prepared, not executed in production

Checkpoint: 2026-09-17. This procedure targets a new, isolated Orbit stack. It is not authorization to deploy, migrate, replace an existing database, change DNS, or modify other services. The Appendix A migration remains explicitly unexecuted.

## Release inputs

Use the validated immutable application image and matching lockfile, reviewed forward migrations, separate encrypted backup/restore evidence, and the operator's approved release/change reference. Place generated secrets in a private deployment environment file or secret-management integration; never paste them into logs, screenshots, source files, or command arguments. Compose configuration inspection must use `config --quiet`, not dump resolved environment values.

Required role URLs all address Orbit's own `postgres:5432/orbit` database: `MIGRATION_DATABASE_URL` uses its dedicated `orbit_migrator` owner, `DATABASE_URL` uses `orbit_app`, and `AUTH_DATABASE_URL` uses `orbit_auth`. The latter roles require distinct strong passwords of at least 24 characters. `DB_PASSWORD` matches the dedicated owner credential only for first initialization. Also supply unique `AUTH_SECRET`, 64-hex-character `CREDENTIAL_KEY`, `ORBIT_SETUP_TOKEN`, `PUBLISHER_INSTANCE_ID`, public HTTPS `APP_ORIGIN`, and the selected proxy variables. `ORBIT_RELEASE_APPROVAL` records the explicit human-approved change reference for the one-shot migration command. That string is an audit input, not a substitute for actual authorization.

The default Compose runtime is test mode with external writes disabled, live evaluation false, and blank OpenAI credentials/model/rate configuration. A separate reviewed change is needed for paid or live actions. Existing Codex, other applications, Slack, or model credentials are not inherited.

## Ordered operator procedure after release approval

1. Select exactly one proxy topology: standalone adds `infra/compose.standalone.yml`; shared hosting adds `infra/compose.shared.yml`. The shared variant binds no host ports and attaches only web to the named existing proxy network. Point the approved proxy at `web:4310` on that network. Do not modify another project's Compose stack.
2. Validate interpolation without printing secrets, build/pull the reviewed image, and start only Orbit's PostgreSQL and Redis. Keep the application stopped until role/bootstrap checks pass.
3. Invoke the maintenance-profile one-shot `migrate` service. It runs `scripts/db-deploy.ts --allow-remote-migration` against the explicitly supplied role URLs and requires `ORBIT_RELEASE_APPROVAL`. It creates missing limited roles, applies forward Prisma migrations, installs the exact grant matrix, and checks permissions using real app/auth connections plus an unscoped RLS read. It refuses privileged/member application roles; it never repairs existing roles silently or rotates their passwords.
4. Start API, worker and web after successful migration. For standalone hosting also start the proxy. Complete first-owner setup through the application with the dedicated setup token; the public signup endpoint remains disabled.
5. Verify authenticated browser traffic through the actual proxy, project isolation, database roles, worker heartbeat and Redis/database outage behavior. Check all four PNG templates in the Linux image. Capture queue restart/replay and outcome-unknown handling before considering readiness.
6. Record the resulting immutable image IDs, migration state and validation evidence. Keep live connector/model gates blocked until their separately authorized acceptance tests complete.

Command shape (use the operator's actual private environment file path and approved topology):

```sh
docker compose --env-file /secure/orbit-release.env -f infra/compose.yml -f infra/compose.standalone.yml config --quiet
docker compose --env-file /secure/orbit-release.env -f infra/compose.yml -f infra/compose.standalone.yml up -d postgres redis
docker compose --env-file /secure/orbit-release.env -f infra/compose.yml -f infra/compose.standalone.yml --profile maintenance run --rm migrate
docker compose --env-file /secure/orbit-release.env -f infra/compose.yml -f infra/compose.standalone.yml up -d api worker web proxy
```

Build/pull the reviewed application image before the one-shot service; the commands above intentionally do not encode an unreviewed image rebuild. For shared hosting replace the standalone override and omit `proxy` from the final command.

## Runtime isolation and limits

API/web/worker run as the image's `node` user with read-only root filesystems, dropped capabilities, no privilege escalation, PID/CPU/memory caps, bounded logs, and writable temporary files only. Web additionally has a small dedicated writable `.next/cache` tmpfs owned by UID/GID 1000. DejaVu fonts are installed for deterministic font availability; raster bytes remain bound to the actual renderer version and output hash. The internal frontend/database networks are separate; standalone proxy receives external access for TLS certificate management. Network naming alone is not a destination firewall.

Worker health uses an atomically written timestamp after a successful database pump and Redis read. A stale/missing heartbeat is unhealthy. This proves recent control-loop connectivity, not a completed job or live connector success. `pg_isready` and the API liveness endpoint do not prove schema/grants correctness; the bootstrap's role checks and authenticated acceptance tests supply that evidence.

The PDF parser runs in a child process with a wall-clock deadline and V8 heap limit; container memory/PID limits remain necessary for native memory containment.

## Failure and rollback

Do not launch the application after bootstrap failure. Preserve sanitized error codes, inspect migration state using the owner role, and use reviewed forward repairs. `--grants-only` is an explicit repair/check option after a migration has already completed; it is not an automatic fallback. Do not remove volumes or downgrade an applied schema as a routine rollback. Application rollback uses a compatible previous image; database restoration requires a separately approved, tested restore procedure. Stop only Orbit's own services when necessary. Desk, Forecast, existing Postiz/Matomo/Chatwoot, proxy configuration and DNS remain outside this procedure's execution scope.

## Reproducible local image construction

The Dockerfile pins the official Node 24.18.0 multi-platform image digest and uses one shared CA/OpenSSL/font layer for build and runtime. Dependency manifests and the frozen lock are copied before application source, so source edits reuse the Linux dependency layer. Runtime starts the installed project executables directly and does not download a second package manager.

A normal `docker build -f infra/Dockerfile -t eds-orbit:local-rc .` is self-contained. The optional empty `package-cache` stage can be replaced by a local BuildKit context containing `/seed/v11` content-addressed pnpm packages and `/seed/metadata` public registry manifests. Local acceptance used only package entries matching the reviewed lockfile, excluded foreign OS/CPU packages and postinstall side-effect caches, and preserved package bytes and file-integrity hashes. Four copied cache records needed local index-format normalization for the pinned package manager; this did not change package contents or install verification. The optional seed index is fingerprinted so a changed seed does not silently reuse stale records. Registry verification decisions were not copied; the frozen install, integrity and supply-chain checks remained active. No environment file, credential, host node_modules tree or macOS native binary was copied as a Linux build result. Cache contents stay in build cache mounts rather than the runtime application directory. Downloads use eight concurrent requests and a bounded ten-minute request timeout to tolerate slow registry responses without disabling TLS or package verification.

This cache is an optional network optimization, not a release input. A fresh uncached build still downloads and verifies its own dependencies. Never point the optional context at a home directory, credential store, entire workspace or private unfiltered package cache. Architecture-specific runtime acceptance must name its tested platform; a local arm64 result does not establish amd64 deployment acceptance.

## Executed local acceptance

Both fresh standalone and shared-proxy Linux ARM64 variants passed this ordering on 2026-09-17 using separate test databases/volumes. The immutable tested image, real migration/role results, authenticated HTTPS, default-deny gates, cgroup limits, PNG outputs and Redis/worker recovery are recorded in `docs/evidence/container-acceptance.json`. These tests used only temporary loopback proxy ports and a private local CA; no production release was performed. Caddy retains its executable-required `NET_BIND_SERVICE` capability; application containers drop all capabilities. Fontconfig writes only under `/tmp/orbit-cache`. Both temporary stacks were shut down with their volumes retained.

# Coolify Docker Compose deployment

This document prepares the private `eds-labs/eds-orbit` repository for a **new, isolated** Coolify deployment. It does not authorize a deployment, production migration, DNS change, provider activation, or live publishing.

The repository root [`docker-compose.yml`](../../docker-compose.yml) is the canonical Coolify definition. It starts exactly five durable application dependencies: `web`, `api`, `worker`, `postgres`, and `redis`, plus the one-shot `migrate` job. No Caddy container, host path, host port, or external database/Redis endpoint is included. Coolify's integrated Traefik owns public routing and TLS.

## Architecture and isolation

- `web` is the only service assigned a Coolify domain. It listens internally on port `4310` and proxies application API requests to `http://api:4311` through Docker DNS.
- `api` listens internally on `4311`; `worker`, PostgreSQL, and Redis have no public listener. Compose publishes no `ports:`.
- `frontend` and `database` are internal networks. `egress` is used only by API and worker for separately approved external integrations.
- PostgreSQL uses the pinned `pgvector/pgvector` PostgreSQL 17 image with the named `orbit_pg` volume. Redis uses the pinned Redis 7.4 image, append-only persistence, and the named `orbit_redis` volume.
- API, worker, web, database, and Redis have Compose health checks. API and worker wait for `migrate` to complete successfully; migrations cannot run concurrently with normal application startup in the same stack.
- Application containers use a multi-stage Node image, prune development dependencies, run as `node`, use read-only roots, a limited tmpfs, dropped Linux capabilities, no-new-privileges, an init process, bounded logs, and durable restart policies. The migration job intentionally exits after success and has no restart policy.

The image contains `tsx` and Prisma as production dependencies because API/worker and the one-shot Prisma migration run TypeScript directly. It does not download a package manager or install dependencies at runtime.

## Coolify setup after explicit release approval

1. In Coolify, create or select the target **Project** and production **Environment** on the approved server. Confirm that the server uses Coolify's Traefik proxy and has DNS/TLS authority for the domain.
2. Select **+ New**, choose the GitHub source, and select the private repository `eds-labs/eds-orbit`. Authenticate using the existing GitHub App or deploy key with read access only.
3. Under **Configuration → General**, choose the **Docker Compose** build pack. Set Branch to `main`, Base Directory to `/`, and Docker Compose Location to `docker-compose.yml`. Reload the Compose content from Git after every Compose change.
4. Keep **Raw Compose Deployment** disabled. Coolify then supplies its managed routing/network labels. Do not add an in-repository Traefik/Caddy proxy or hand-written route labels.
5. The Compose definition asks Coolify to generate a domain for the `web` service on internal port `4310`. Override `APP_ORIGIN` and the generated web domain only when the approved public hostname must be exactly `https://orbit.eds-labs.io` (the production web domain; check `APP_ORIGIN` in Coolify if it changes). Do not assign domains to API, worker, PostgreSQL, Redis, or migrate.
6. In Coolify Environment Variables, inspect the generated values and add a non-secret human change reference for the required `ORBIT_RELEASE_APPROVAL`. Coolify generates distinct persistent passwords for the migrator, app and auth roles plus the application secrets. Do not copy generated values into the repository, a host path or shell history.
7. Before the first deployment, inspect the rendered Compose configuration and image build output. Ensure the approved change reference is present in `ORBIT_RELEASE_APPROVAL`. Start the deployment only under the separate change approval.
8. After deployment, use Coolify service status and logs to confirm `migrate` completed once, then API/worker/web became healthy. Test an authenticated browser flow at the public HTTPS URL. Record the deployment ID, image digest, migration result, and verification evidence.

Coolify supports Git-based Compose applications: it reads the repository Compose file, retains service health checks and dependencies, supplies its normal Traefik routing for configured service domains, and enables branch/webhook deployments. Do not enable a predefined network unless Orbit must intentionally communicate with another Coolify resource.

## Environment variables

The Compose definition uses Coolify's documented `SERVICE_*` variables to generate persistent values for a fresh resource. [`.env.example`](../../.env.example) documents manual overrides without usable secrets.

| Group | Variables | Notes |
| --- | --- | --- |
| Generated secrets | `SERVICE_PASSWORD_64_DBMIGRATOR`, `SERVICE_PASSWORD_64_DBAPP`, `SERVICE_PASSWORD_64_DBAUTH`, `SERVICE_REALBASE64_64_AUTHSECRET`, `SERVICE_HEX_64_CREDENTIALKEY`, `SERVICE_PASSWORD_64_ORBITSETUPTOKEN` | Coolify generates and persists separate values. Generator identifiers intentionally contain no underscores because Coolify parses the underscore count. `CREDENTIAL_KEY` resolves to exactly 64 hexadecimal characters. |
| Generated database URLs | `MIGRATION_DATABASE_URL`, `DATABASE_URL`, `AUTH_DATABASE_URL` | Defaults address `postgres:5432/<POSTGRES_DB>` with users `orbit_migrator`, `orbit_app`, and `orbit_auth`. Each URL reuses only its matching generated password. |
| Required release/runtime | `ORBIT_RELEASE_APPROVAL` | This remains a manually entered human change reference. `${ORBIT_RELEASE_APPROVAL:?}` blocks a fresh deployment while it is empty. |
| Generated runtime identity | `APP_ORIGIN`, `PUBLISHER_INSTANCE_ID`, `SERVICE_URL_WEB` | Coolify generates a web URL and stable publisher identity. The port-specific `SERVICE_URL_WEB_4310` entry marks the routed container port, while runtime URL resolution uses `SERVICE_URL_WEB`. Override `APP_ORIGIN` when using the approved custom domain. |
| Internal defaults | `POSTGRES_DB`, `REDIS_URL`, `QUEUE_NAMESPACE` | Defaults are `orbit`, `redis://redis:6379`, and `orbit`; retain Docker service names. |
| Safety gates | `EXECUTION_MODE`, `ENABLE_EXTERNAL_WRITES`, `LIVE_RAG_EVAL_PASSED` | Defaults keep the system in test mode with external writes and live RAG evaluation disabled. Changing them requires separate authorization. |
| Feature flags | `ORBIT_CONTENT_PACKAGES`, `ORBIT_TOOL_SEARCH`, `ORBIT_AGENTS` | Default `false`; passed to API and worker (Orbit Chat runs in the worker). Set to `true` in the Coolify environment variables and redeploy only after the matching approval in `docs/plans/ORBIT_CORE_ROLLOUT_PLAN.md`. |
| Optional integration | `OPENAI_API_KEY`, `OPENAI_VERIFIED_MODELS`, `OPENAI_RATE_CARD_JSON` | Leave blank until model, budget, and provider controls have been approved and verified. |
| Optional integration | `ANTHROPIC_API_KEY`, `AI_DEFAULT_PROVIDER` | Bootstrap fallbacks for the Anthropic Claude provider; prefer the encrypted owner field under Settings → AI and leave these blank (`AI_DEFAULT_PROVIDER` defaults to `openai`). |
| Legacy only | `ORBIT_HOSTNAME` | Used only by the old Caddy standalone configuration under `infra/`; Coolify ignores it. |

`ORBIT_IMAGE_TAG` is optional metadata for locally invoked Compose. Coolify builds the Git revision itself. Build arguments are not required and no secret is passed as a Docker build argument.

Coolify preserves existing environment-variable values when a Compose definition is reloaded. A resource created from an older Orbit Compose revision can therefore retain the invalid literal `required`; do not reuse its initialized database volume with newly generated credentials. Prefer a fresh resource after this revision, or use a separately reviewed credential-recovery procedure. Never delete an existing volume without confirming it contains no required data and obtaining explicit approval.

## Migration, release, and rollback

`migrate` runs `scripts/db-deploy.ts --allow-remote-migration` exactly once per stack start before API and worker. It runs `prisma migrate deploy`, creates only missing least-privilege app/auth roles, verifies grants and RLS, and refuses mismatched databases or privileged application roles. It never runs `prisma migrate dev`.

Do not deploy two Compose resources against the same database. Do not restart or manually re-run migration while an earlier deployment is in progress. If migration fails, leave application services stopped, preserve sanitized logs, inspect migration state with the owner role, and apply a reviewed forward repair. Do not delete the database volume or downgrade an applied schema as a rollback.

For application rollback, redeploy the last known-compatible Git revision through Coolify after confirming its database compatibility. Database recovery is a separate approved procedure; follow [backup and restore](../BACKUP_RESTORE.md), restore into a new isolated target first, and fence writers before any cutover.

## GitHub delivery and operating checks

Enable the GitHub webhook in the Coolify Git source so approved pushes to `main` create a deployment. A webhook delivery confirms that Coolify received an event; it is not deployment or health evidence. Restrict repository write access and protect `main` according to the team workflow.

For a release record, capture:

1. Coolify deployment ID, Git commit, image digest, and `migrate` completion.
2. `web`, `api`, `worker`, PostgreSQL, and Redis health; check that only `web` has a public domain.
3. Authenticated HTTPS behavior at `https://orbit.eds-labs.io` (the production web domain; check `APP_ORIGIN` in Coolify if it changes), worker heartbeat, and a safe read-only operational path.
4. The current backup/recovery state, owner/change reference, and any blocked live connector/model gates.

Coolify documentation: [Docker Compose](https://coolify.io/docs/applications/builds/docker-compose), [Compose networking](https://coolify.io/docs/core/networking-in-coolify), [Traefik routing](https://coolify.io/docs/core/networking/proxy/traefik/overview), and [health checks](https://coolify.io/docs/applications/configuration/health-checks).


## VM102: restore Git deployments after the server migration

The migrated `Orbit Production` resource is a user-defined Coolify Service with fixed local migration images. It runs Compose but has no Git source or push deployment pipeline. A GitHub App alone does not convert it into a Git application.

The replacement must be a GitHub Application using `eds-labs/eds-orbit`, branch `main`, the Docker Compose build pack, base `/`, and **`/docker-compose.pve.yml`**. Keep automatic deployments and previews off, leave domains empty, and do not deploy the preparation resource until the production change is approved. Keep Raw Compose Deployment off.

`docker-compose.pve.yml` is generated from the canonical root definition by `node scripts/render-pve-compose.mjs`. It retains builds, migration gating, flags, commands, images, health checks and isolation. The only runtime adaptations are the five existing VM102 internal host mappings and the existing bind-mounted PostgreSQL and Redis data paths under `/data/orbit-production`. Missing directories must fail instead of silently creating an empty database. Never run both resources against these data directories. The Compose check also rejects a stale generated adapter after changes to the canonical file; regenerate and review both together.

Before cutover:

1. Copy the existing runtime variable values directly within the server into the inactive application. Preserve database role passwords, authentication/encryption keys, feature flags and provider credentials. Do not use newly generated replacement credentials and do not print values.
2. Compare rendered environments against the running services. Confirm both bind paths, five internal host mappings, worker queue identity and database/auth roles. Keep all production domains off the draft.
3. Build the reviewed commit without stopping production. Validate against isolated database/Redis copies with worker/provider actions disabled and no public route. A healthy container alone does not establish authenticated feature acceptance.
4. Obtain explicit production-change approval. Pause/drain workers, take a fresh protected backup, stop the current resource, and ensure no process still mounts the data directories before starting the Git application. Keep data and the fixed migration images available for rollback.
5. Move the existing domain routes and backup job target to the replacement, check HTTPS, authentication, API readiness, MCP health, worker readiness and all internal service connections, and test backup invocation against the correct new container. No public DNS change is needed.
6. Enable push deployments only after the owner approves that deployment policy. Keep the configured revision pinned during preparation; change to `HEAD` only when activating branch deployments. The old server's Orbit automatic deployment stays disabled.

`ORBIT_RELEASE_APPROVAL` is a human release reference, not a permanent blanket approval for arbitrary future database migrations. Set `ORBIT_IMAGE_TAG=pve-production` as a runtime variable and the custom build command to `ORBIT_APPROVED_SCHEMA_SHA256=<reviewed hash> sh scripts/build-pve.sh`, using the value returned by `sh scripts/check-pve-schema.sh --print-hash` after comparing with the running release. The build script builds the runner and backup images directly, so Compose does not require production runtime secrets while building. Keep production values runtime-only and Dockerfile build-argument injection disabled. Keep that approved hash in Coolify, not in a self-updating repository file. Missing or changed schema, SQL migration or database grant-script inputs stop the build before the current deployment is stopped. Review new database changes and obtain a new explicit migration approval before updating this hash. This guard prevents accidental schema rollout; it is not a sandbox for untrusted code pushed to the trusted main branch. Do not remove the migrate service, bypass its role/RLS checks or silently enable feature flags to make a deployment pass.

Rollback: prevent further automatic deployments, stop the replacement and restore the previous service and route/backup target using the retained migration images and unchanged data paths. If a new schema migration has run, assess compatibility first; never downgrade or overwrite a live database merely to roll back code.

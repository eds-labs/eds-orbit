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
5. Add `https://eds-orbit.apps.eds-labs.io:4310` in the Domains field for the `web` service only. The `:4310` suffix selects the internal container port; public HTTPS remains on 443. Do not assign domains to API, worker, PostgreSQL, Redis, or migrate.
6. In Coolify Environment Variables, add every required value below. Mark secrets as secret values in the UI. Do not use a repository `.env` file, host path, or shell history for production secrets.
7. Before the first deployment, inspect the rendered Compose configuration and image build output. Ensure the approved change reference is present in `ORBIT_RELEASE_APPROVAL`. Start the deployment only under the separate change approval.
8. After deployment, use Coolify service status and logs to confirm `migrate` completed once, then API/worker/web became healthy. Test an authenticated browser flow at the public HTTPS URL. Record the deployment ID, image digest, migration result, and verification evidence.

Coolify supports Git-based Compose applications: it reads the repository Compose file, retains service health checks and dependencies, supplies its normal Traefik routing for configured service domains, and enables branch/webhook deployments. Do not enable a predefined network unless Orbit must intentionally communicate with another Coolify resource.

## Environment variables

Start from [`.env.example`](../../.env.example); it documents all names without usable secrets.

| Group | Variables | Notes |
| --- | --- | --- |
| Required secrets | `DB_PASSWORD`, `AUTH_SECRET`, `CREDENTIAL_KEY`, `ORBIT_SETUP_TOKEN` | `CREDENTIAL_KEY` must be exactly 64 hexadecimal characters; generate every value uniquely. |
| Required database URLs | `MIGRATION_DATABASE_URL`, `DATABASE_URL`, `AUTH_DATABASE_URL` | All address `postgres:5432/<POSTGRES_DB>`; users are respectively `orbit_migrator`, `orbit_app`, and `orbit_auth`. Use distinct passwords of at least 24 characters. |
| Required release/runtime | `APP_ORIGIN`, `ORBIT_RELEASE_APPROVAL`, `PUBLISHER_INSTANCE_ID` | Set `APP_ORIGIN=https://eds-orbit.apps.eds-labs.io`. The release approval is a human change reference consumed by the migration job. |
| Internal defaults | `POSTGRES_DB`, `REDIS_URL`, `QUEUE_NAMESPACE` | Defaults are `orbit`, `redis://redis:6379`, and `orbit`; retain Docker service names. |
| Safety gates | `EXECUTION_MODE`, `ENABLE_EXTERNAL_WRITES`, `LIVE_RAG_EVAL_PASSED` | Defaults keep the system in test mode with external writes and live RAG evaluation disabled. Changing them requires separate authorization. |
| Optional integration | `OPENAI_API_KEY`, `OPENAI_VERIFIED_MODELS`, `OPENAI_RATE_CARD_JSON` | Leave blank until model, budget, and provider controls have been approved and verified. |
| Legacy only | `ORBIT_HOSTNAME` | Used only by the old Caddy standalone configuration under `infra/`; Coolify ignores it. |

`ORBIT_IMAGE_TAG` is optional metadata for locally invoked Compose. Coolify builds the Git revision itself. Build arguments are not required and no secret is passed as a Docker build argument.

## Migration, release, and rollback

`migrate` runs `scripts/db-deploy.ts --allow-remote-migration` exactly once per stack start before API and worker. It runs `prisma migrate deploy`, creates only missing least-privilege app/auth roles, verifies grants and RLS, and refuses mismatched databases or privileged application roles. It never runs `prisma migrate dev`.

Do not deploy two Compose resources against the same database. Do not restart or manually re-run migration while an earlier deployment is in progress. If migration fails, leave application services stopped, preserve sanitized logs, inspect migration state with the owner role, and apply a reviewed forward repair. Do not delete the database volume or downgrade an applied schema as a rollback.

For application rollback, redeploy the last known-compatible Git revision through Coolify after confirming its database compatibility. Database recovery is a separate approved procedure; follow [backup and restore](../BACKUP_RESTORE.md), restore into a new isolated target first, and fence writers before any cutover.

## GitHub delivery and operating checks

Enable the GitHub webhook in the Coolify Git source so approved pushes to `main` create a deployment. A webhook delivery confirms that Coolify received an event; it is not deployment or health evidence. Restrict repository write access and protect `main` according to the team workflow.

For a release record, capture:

1. Coolify deployment ID, Git commit, image digest, and `migrate` completion.
2. `web`, `api`, `worker`, PostgreSQL, and Redis health; check that only `web` has a public domain.
3. Authenticated HTTPS behavior at `https://eds-orbit.apps.eds-labs.io`, worker heartbeat, and a safe read-only operational path.
4. The current backup/recovery state, owner/change reference, and any blocked live connector/model gates.

Coolify documentation: [Docker Compose](https://coolify.io/docs/applications/builds/docker-compose), [Compose networking](https://coolify.io/docs/core/networking-in-coolify), [Traefik routing](https://coolify.io/docs/core/networking/proxy/traefik/overview), and [health checks](https://coolify.io/docs/applications/configuration/health-checks).

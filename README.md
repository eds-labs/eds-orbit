# EDS Orbit

A self-hosted marketing workspace with project-scoped knowledge, verified facts, hybrid retrieval, evidence-bound content review, durable workers and conservative publishing controls.

**Locally tested release candidate.** Test publishing writes an internal receipt and never sends a real post. Live OpenAI, embedding quality and provider acceptance require separately authorized credentials and budgets. See [release readiness](docs/RELEASE_READINESS.md) and the [acceptance report](docs/ACCEPTANCE_REPORT.md).

## Local isolated setup

Requirements: Node.js **24.18.0**, pnpm **11.19.0**, Docker Compose, and Python3 for repository checks. PostgreSQL17/pgvector0.8.6 and Redis7.4.7 use their own Compose project, volumes and localhost ports55432/56379.

```sh
nvm use
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
pnpm db:generate
pnpm local:setup
pnpm dev
```

Open [localhost:4310](http://localhost:4310). The API listens on localhost:4311. The setup command creates unique local credentials in ignored `.runtime/local.env` with mode0600. Read the `ORBIT_SETUP_TOKEN` locally for first-owner setup; do not paste the file into tickets or logs. New projects start in Observe with no source data, model budget or external write authorization.

The optional `pnpm exec tsx scripts/seed-e2e.ts` creates only a clearly synthetic account for isolated browser acceptance. Its generated password stays in ignored `.runtime/e2e-user.json`. Do not use that script for production users.

## Working paths

1. Create a project, set timezone and content language, and add authorized sources.
2. Import a document or an allowlisted URL. Confirm structured facts and their public/model-use rights independently.
3. Inspect retrieval evidence, create a bounded mission and define an owner policy.
4. Review the generated claims, approve the exact content package in Assisted mode, and test-publish through the durable worker.
5. Import real measurements or labeled fixtures, record uncertain insights, correct data and inspect affected content when sources change.

Document text is untrusted input. Generated posts cannot promote themselves into verified facts. Public use and external model use are independent permissions. Revocation invalidates dependent evidence, approvals, drafts and schedules; ambiguous remote writes require reconciliation.

## Verification

```sh
pnpm api:generate        # with ORBIT_CONFIG_FILE=.runtime/local.env
pnpm lint
pnpm typecheck
pnpm test
pnpm test:migration-profile
pnpm build
pnpm secrets:check
pnpm dependencies:inventory
pnpm audit --audit-level high
pnpm test:e2e            # API, web and worker must be running
pnpm framework:check
```

Three safety-net suites guard tenant isolation and access:

- `apps/api/tests/rls-matrix.integration.test.ts` classifies every table, requires FORCE RLS and checks cross-project reads and writes as the restricted app role. A new table fails it until it is classified.
- `apps/api/tests/access-matrix.integration.test.ts` calls every route, collection and action as anonymous, non-member, viewer, editor and owner, and compares the result with `apps/api/tests/fixtures/access-matrix.json`. After an intended access change, regenerate the fixture with `UPDATE_ACCESS_MATRIX=1 pnpm test access-matrix` and review its diff like any security change.
- `apps/worker/tests/queue-dispatch.integration.test.ts` checks the wiring of the worker queues that have no dedicated test.

In CI (`CI=true`), the test setup refuses to run without the test database and Redis instead of skipping the integration tests.

### Parallel worktrees

All worktrees share one local Postgres, and `scripts/db-deploy.ts` reissues every grant by its own branch's table lists. Two branches with different migrations on the shared `orbit_test` therefore revoke each other's grants. Give each worktree its own database instead:

```sh
node scripts/test-db-for-worktree.ts          # once per worktree, and after pulling new migrations
node scripts/test-db-for-worktree.ts --reset  # after switching to a branch without some applied migration
node scripts/test-db-for-worktree.ts --drop   # before removing the worktree
```

The script derives `orbit_test_<worktree>_<hash>` from the worktree path, creates it from `template0` on the local container (127.0.0.1:55432 only), migrates it with this branch's `scripts/db-deploy.ts` and writes the three `TEST_*` URLs to ignored `.runtime/test.env` (mode 0600), together with a matching `PUBLISHER_INSTANCE_ID` and `QUEUE_NAMESPACE` that keep the run's Redis keys and queues apart on the shared local Redis. Credentials come from `.runtime/local.env` (this worktree's, else the main checkout's). `tests/setup.ts` and `pnpm test:migration-profile` prefer `.runtime/test.env` over the shared URLs; without the file they use `orbit_test` as before. A worktree without its own `.runtime/local.env` runs the suite with `node --env-file=<main checkout>/.runtime/local.env ./node_modules/vitest/vitest.mjs run`. CI is unchanged.

Playwright normally uses its installed Chromium. For local testing with an existing Chrome installation, set `PLAYWRIGHT_CHANNEL=chrome`; reports record the actual browser. Integration tests use a separate `orbit_test` database (or a worktree's own `orbit_test_<worktree>`, see above) with the same restricted app/auth roles. The restore test creates `orbit_restore_test`, pauses every restored project and never starts a publisher.

## Hosting and authority

Use the [Coolify Docker Compose deployment guide](docs/deployment/COOLIFY.md) for the production-ready repository configuration, [deployment bootstrap](docs/DEPLOYMENT_BOOTSTRAP.md), [standalone/shared hosting](docs/SHARED_HOST_DEPLOYMENT.md), [operations](docs/OPERATIONS.md), [backup/restore](docs/BACKUP_RESTORE.md), and [upgrades](docs/UPGRADE.md). Production migration and live activation are deliberate operator steps. Development does not authorize changes to existing hosts, Desk, Forecast, DNS, provider accounts or publishing.

Provider states distinguish configured credentials, verified reads, verified writes and reconciled publication. A successful HTTP receipt is not proof of public delivery. Mail and ad activation remain disabled without their own supported provider and mandate; drafts and exports work independently.

## Repository and licensing

`apps/web` contains the Next.js UI, `apps/api` the Fastify control plane, `apps/worker` the BullMQ executors, and `packages/knowledge`/`packages/db` the PostgreSQL knowledge layer. Shared contracts, AI routing, connector adapters and branded creative rendering live under `packages`.

Adapter authors should follow [connector development](docs/CONNECTOR_DEVELOPMENT.md) and the actual provider capability matrix.

`pnpm lint` also checks import boundaries for the planned modular platform (`scripts/boundaries.mjs`). `scripts/boundaries.json` maps every source file to its target zone: platform, a module such as marketing or knowledge, the worker, the web shell or a web module, or a package. The rules forbid these imports:

- the platform importing a module;
- the worker importing a module;
- the web shell importing a web module;
- one module importing another, except through a declared dependency's `contract.ts`;
- packages importing apps;
- the web app importing server code.

Only violations missing from the recorded baseline fail the check. When a violation is removed, refresh the baseline with `node scripts/source-check.mjs --update-boundaries`. `--boundary-report` prints imports between zones.

Codex Project Framework1.1.0 was merged missing-only; provenance is in [framework baseline](docs/FRAMEWORK_BASELINE.md). The complete controlling specification is retained in `docs/EDS_ORBIT_UNIFIED_CODEX_MASTER_v3.md`. Original EDS Labs marks remain reserved brand assets. The repository is private; no open-source license grant has been assumed. See [license status](LICENSE-STATUS.md). Operational inventory and acceptance evidence require review before any public release.

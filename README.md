# EDS Orbit

A self-hosted marketing workspace with project-scoped knowledge, verified facts, hybrid retrieval, evidence-bound content review, durable workers and conservative publishing controls.

**Locally tested release candidate.** Test publishing writes an internal receipt and never sends a real post. Live OpenAI, embedding quality and provider acceptance require separately authorized credentials and budgets. See [release readiness](docs/RELEASE_READINESS.md) and the [acceptance report](docs/ACCEPTANCE_REPORT.md).

## Local isolated setup

Requirements: Node.js **24.18.0**, pnpm **11.19.0**, Docker Compose, and Python3 for repository checks. PostgreSQL17/pgvector0.8.6 and Redis7.4.7 use their own Compose project, volumes and localhost ports55432/56379.

```sh
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
pnpm build
pnpm secrets:check
pnpm dependencies:inventory
pnpm audit --audit-level high
pnpm test:e2e            # API, web and worker must be running
pnpm framework:check
```

Playwright normally uses its installed Chromium. For local testing with an existing Chrome installation, set `PLAYWRIGHT_CHANNEL=chrome`; reports record the actual browser. Integration tests use a separate `orbit_test` database with the same restricted app/auth roles. The restore test creates `orbit_restore_test`, pauses every restored project and never starts a publisher.

## Hosting and authority

Use [deployment bootstrap](docs/DEPLOYMENT_BOOTSTRAP.md), [standalone/shared hosting](docs/SHARED_HOST_DEPLOYMENT.md), [operations](docs/OPERATIONS.md), [backup/restore](docs/BACKUP_RESTORE.md), and [upgrades](docs/UPGRADE.md). Production migration and live activation are deliberate operator steps. Development does not authorize changes to existing hosts, Desk, Forecast, DNS, provider accounts or publishing.

Provider states distinguish configured credentials, verified reads, verified writes and reconciled publication. A successful HTTP receipt is not proof of public delivery. Mail and ad activation remain disabled without their own supported provider and mandate; drafts and exports work independently.

## Repository and licensing

`apps/web` contains the Next.js UI, `apps/api` the Fastify control plane, `apps/worker` the BullMQ executors, and `packages/knowledge`/`packages/db` the PostgreSQL knowledge layer. Shared contracts, AI routing, connector adapters and branded creative rendering live under `packages`.

Adapter authors should follow [connector development](docs/CONNECTOR_DEVELOPMENT.md) and the actual provider capability matrix.

Codex Project Framework1.1.0 was merged missing-only; provenance is in [framework baseline](docs/FRAMEWORK_BASELINE.md). The complete controlling specification is retained in `docs/EDS_ORBIT_UNIFIED_CODEX_MASTER_v3.md`. Original EDS Labs marks remain reserved brand assets. No open-source license grant or public repository publication has been assumed; see [license status](LICENSE-STATUS.md). Operational inventory and acceptance evidence require review before any public release.

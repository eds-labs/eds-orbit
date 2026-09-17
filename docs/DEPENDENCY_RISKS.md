# Dependency risk assessment

Assessed 2026-09-17 using the actual pnpm audit. The initial scan reported two high and one moderate advisory; the table records those original findings. The refreshed `docs/evidence/dependency-audit.json` now reports zero in every severity category across 517 dependencies. This is a package vulnerability scan, not evidence of successful exploitation or production acceptance.

| Dependency and advisory | Actual scope | Chosen remediation |
| --- | --- | --- |
| deepmerge-ts 7.1.5, [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx), high | Recursive object graph stack exhaustion. Transitive Prisma config loader dependency; Orbit supplies a repository-controlled, plain object containing schema, migration path and PostgreSQL datasource URL. No request payload or retrieved document enters this loader. | Exact override to 8.0.0, first fixed major. |
| mysql2 3.15.3, [GHSA-3f6p-5ww8-9rcr](https://github.com/sidorares/node-mysql2/security/advisories/GHSA-3f6p-5ww8-9rcr), high | A malicious MySQL authentication challenge can downgrade to plaintext credentials. Present through Prisma and Better Auth, but Orbit uses PostgreSQL/pg exclusively; no MySQL server connection is configured. | Exact override to 3.23.1 (also exceeds 3.22.0 authentication fix). |
| mysql2 3.15.3, [GHSA-rgwj-5xj2-c3m3](https://github.com/sidorares/node-mysql2/security/advisories/GHSA-rgwj-5xj2-c3m3), moderate | Unbounded compressed-protocol inflate, requiring a MySQL connection with compression. This runtime path is unused in Orbit. | Same 3.23.1 override, first fixed release. |

## Compatibility rationale

The [deepmerge-ts 8.0.0 release](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0) changes default Map value merging, renames type utilities and fixes nested mutation by `deepmergeInto`. It retains the named `deepmerge` export and ESM/CommonJS entry points. The installed `@prisma/config` loader imports only `deepmerge`, passing it to c12 with dotenv, rcFile, giget, extend and packageJson loading disabled. Orbit's `packages/db/prisma.config.ts` contains no Maps, custom merge callbacks, `deepmergeInto` calls or renamed utility types. This makes the override a bounded compatibility choice, although it is outside Prisma's upstream declared major range and must retain the regression checks below.

The [mysql2 3.23.1 release](https://github.com/sidorares/node-mysql2/releases/tag/v3.23.1) remains on major 3. The standard and promise entry points remain exported; the package's Node requirement is compatible with the project's pinned Node 24.18.0. No direct Orbit code imports mysql2. Do not enable a MySQL backend merely to exercise this optional dependency.

Official npm manifests were checked for exact versions, engine constraints, export entry points and integrity metadata. Overrides are narrow selectors in `pnpm-workspace.yaml`; they must not silently upgrade already-newer versions. Lockfile and resolved dependency inventory must be regenerated together. No broad Prisma or Better Auth major upgrade is needed for these findings.

## Required verification after lock regeneration

- A new audit must record zero findings for these three advisories; keep the original audit as historical evidence or clearly identify a replacement timestamp.
- Run Prisma generation/config loading, TypeScript checks, PostgreSQL authentication/integration tests and the web build.
- Build the Linux container from the frozen patched lockfile and exercise the migration entry point plus API, web and worker readiness on an isolated local stack.
- Retain original dependency/license inventory with the patched resolved versions. Remove the override only after upstream manifests independently require safe versions and the same checks pass.

Current verification: patched lock/install and Prisma generation completed; refreshed audit reports zero findings; the production web build passed (`docs/evidence/web-build.log`); owned connector, native transport, creative, real-PostgreSQL Slack and Postiz-proof regressions passed 50/50 across six files (`docs/evidence/connector-creative-slack-postiz.log`). The frozen-lock Linux ARM64 image build, Prisma generation, both fresh Compose migrations and API/web/worker authenticated runtime acceptance passed (`docs/evidence/container-acceptance.json`). AMD64 and production-host acceptance remain unperformed. Risk acceptance has not been used to waive the audit. No remote infrastructure or provider write was performed.

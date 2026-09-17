# Contributing

Read AGENTS.md, the project profile and README. Use synthetic fixtures only. Add regressions for authorization, lifecycle, costs and side effects. Run framework checks, lint/typecheck, unit/integration tests and the web build. UI changes need mobile and keyboard evidence. No default passwords or live smoke publications. Never weaken a failing quality gate to claim completion. API changes update OpenAPI and generated client. Database migrations are additive once applied. Connector changes must distinguish documented capability, offline contract tests and verified live behavior.

For provider adapters, follow [Connector Development](docs/CONNECTOR_DEVELOPMENT.md). Existing-install release procedures are in [Upgrade](docs/UPGRADE.md).

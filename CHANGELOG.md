# Changelog

Alle wesentlichen Änderungen am Codex Project Framework werden in dieser Datei dokumentiert. Das Format orientiert sich an Keep a Changelog; Versionen folgen Semantic Versioning.

## [0.1.0-rc.1] - 2026-09-17

### Added

- EDS Orbit as a self-hosted marketing workspace with Next.js, Fastify, PostgreSQL/pgvector and a separate BullMQ worker
- Project isolation with Better Auth, restricted database roles and FORCE RLS
- Knowledge Layer with versioned sources, Structured Facts, hybrid retrieval, index generations and evaluation gates
- Bounded missions, versioned approvals, test publishing, connector adapters, Marketing Memory and Operations views
- Isolated standalone/shared-host Compose topologies plus operations, upgrade and connector runbooks

### Verified

- 253 application tests, 12 framework tests and four browser workflows against the production build
- Fresh Linux ARM64 container acceptance for standalone and shared host, including HTTPS, roles, resource limits and worker recovery

### Security

- Observe/test mode by default, external writes disabled and no runtime credentials embedded
- No real provider or paid model calls in this release

## [1.1.0] - 2026-07-23

### Added

- Ausführbare GitHub-CI für Framework-Prüfung und Unit-Tests
- Formale Schemas für Framework-Version, Projektprofil und Stack-Presets
- Desktop-App-Profil und vollständiges Browser-Extension-Routing
- Git-Hygiene über `.gitignore`
- Automatisierte Tests für Validator und Generator-Scripts
- Nicht überschreibender Framework-Installer mit Dry-Run
- Contribution- und Security-Dokumentation

### Changed

- Projektprofil auf vollständig neutrale Platzhalter umgestellt
- Validator um Versionsabgleich, vollständige YAML-/Schema-Prüfung und Backtick-Pfadprüfung erweitert

## [1.0.0] - 2026-07-22

### Added

- Erstintegration von Agentic Scaffold, Stack Presets und Operational Governance

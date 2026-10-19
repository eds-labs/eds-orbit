# Changelog

Alle wesentlichen Änderungen am Codex Project Framework werden in dieser Datei dokumentiert. Das Format orientiert sich an Keep a Changelog; Versionen folgen Semantic Versioning.

## [Unreleased]

### Added

- Anthropic Claude as a second runtime AI provider behind the shared AI functions (Messages API, SDK 0.135.0): chat, specialists, support and drafts run on Claude when their route names a Claude model; prompt caching, strict tools, structured outputs, hosted web search, refusal and cut-off handling
- Model registry, dated Claude model and price suggestion, Anthropic tier models and default provider, owner action `ai-provider-configure`
- Per-project Claude credit budget with two warnings and an internal stop per billing period (anchor day), enforced in `reserve` for every Anthropic reservation; `GET /ai-budget`, `ai-cost?groupBy=provider`, attention item `platform_provider_budget`
- Owner-approved fallback to the OpenAI tier when the Claude budget stops a call (off by default)
- Settings → AI: providers, models, budget, usage and costs

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

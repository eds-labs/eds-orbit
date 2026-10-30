# AGENTS.md — Codex Project Framework

Diese Datei ist der verbindliche Einstieg für Codex. Ausführliche Regeln liegen in `.agentic/`, wiederverwendbare Skills in `.agents/skills/`. Projektspezifische Vorgaben in `.agentic/project-profile.yaml` haben Vorrang vor generischen Presets, dürfen Sicherheits- und Freigaberegeln aber nicht stillschweigend abschwächen.

## Arbeitsvereinbarung

- Arbeite zuerst kontextbasiert und danach codebasiert.
- Erstelle bei mehr als einer betroffenen Datei oder bei erhöhtem Risiko einen kurzen Plan.
- Bevorzuge kleine, nachvollziehbare Änderungen und respektiere bestehende Architektur-, Namens- und Testmuster.
- Vermeide aufgabenfremde Refactorings und neue Produktionsabhängigkeiten ohne Begründung und Freigabe.
- Führe keine destruktiven oder produktiv wirksamen Aktionen ohne explizite menschliche Freigabe aus.
- Gib keine Secrets, Tokens, privaten Schlüssel oder Inhalte realer `.env`-Dateien aus.

## Verbindliche Lesereihenfolge

1. `AGENTS.md`
2. `.agentic/project-profile.yaml`
3. `.agentic/rules/engineering-principles.md`
4. `.agentic/rules/testing.md`
5. `.agentic/rules/security.md`
6. `.agentic/routing/risk-classification.md`
7. Passendes Profil aus `.agentic/environments/`
8. Passendes App-Profil aus `.agentic/app-profiles/`
9. Bei Stack-Entscheidungen `.agentic/routing/stack-selection.md`, ein Preset aus `.agentic/stack-presets/` und die zugehörige Struktur aus `.agentic/app-structures/`
10. Passender Workflow aus `.agentic/workflows/`
11. Betroffene Fachregeln und vor Abschluss die passenden `.agentic/quality-gates/`

Für reine, risikoarme Dokumentationsänderungen dürfen die Schritte 6 bis 9 knapp bestätigt werden, sofern keine Betriebs-, Sicherheits- oder Architekturentscheidung betroffen ist.

## Projektprofil

`.agentic/project-profile.yaml` beschreibt Projekt, Stack, Architektur, Umgebung, Befehle, Sicherheitsniveau und Pflichtprüfungen. Ersetze Platzhalter bei der Initialisierung eines konkreten Projekts. Nutze keine dort eingetragenen Beispielbefehle ungeprüft; gleiche sie mit dem Repository ab. Bei Widersprüchen gelten die sicherere Regel und eine dokumentierte Rückfrage beziehungsweise Freigabe.

## Risiko und Umgebung

Klassifiziere Änderungen gemäß `.agentic/routing/risk-classification.md` als `low`, `medium`, `high` oder `critical`. Bestimme zusätzlich die Zielumgebung über `.agentic/environments/` (`local`, `preview`, `staging`, `production`).

Bei `high` oder `critical` sind vor der Umsetzung mindestens Risikoanalyse, Teststrategie und Rollback-Plan erforderlich. Für produktive Änderungen gelten zusätzlich Backup- beziehungsweise Wiederherstellungsprüfung, Monitoring, explizite Freigabe und Post-Deployment-Verifikation.

Prüfe je nach Betroffenheit:

- Datenbank: `.agentic/database/`
- Secrets und Konfiguration: `.agentic/config/`
- Authentifizierung, Autorisierung und Mandantentrennung: `.agentic/security/`
- Deployment: `.agentic/deployment-presets/`
- CI/CD: `.agentic/ci/`
- Logging, Metriken und Alarmierung: `.agentic/observability/`
- Datenschutz und Compliance: `.agentic/compliance/`
- Betrieb und Kosten: `.agentic/operations/`
- KI-Funktionen: `.agentic/ai/`

## App-Profil-Auswahl

- UI, Komponenten und Browser-Flows: `.agentic/app-profiles/web-frontend.md`
- Server, API und Business-Logik: `.agentic/app-profiles/backend-api.md`
- Produkt mit Usern, Tenants, Rollen oder Billing: `.agentic/app-profiles/fullstack-saas.md`
- Jobs, ETL, Reporting und Datenqualität: `.agentic/app-profiles/data-pipeline.md`
- LLM-, Tool- oder Agentenlogik: `.agentic/app-profiles/ai-agent-app.md`
- Skripte und Automationen: `.agentic/app-profiles/automation-script.md`
- Command-Line-Tool: `.agentic/app-profiles/cli-tool.md`
- Browser-Erweiterung: `.agentic/app-profiles/browser-extension.md`
- Mobile oder Cross-Platform App: `.agentic/app-profiles/mobile-app.md`
- Desktop-Anwendung: `.agentic/app-profiles/desktop-app.md`

Begründe die Auswahl kurz. Wenn mehrere Profile betroffen sind, benenne ein primäres Profil und die ergänzenden Regeln.

## Stack-Auswahl

Bei einer neuen Anwendung, einem neuen Modul oder Service:

1. Lies `.agentic/routing/stack-selection.md`.
2. Vergleiche Zielplattform, Anwendungstyp, Teamkompetenz, Betriebsmodell und Risiko.
3. Wähle genau ein führendes Preset aus `.agentic/stack-presets/`.
4. Nutze die dort referenzierte Struktur aus `.agentic/app-structures/`.
5. Übertrage die Entscheidung in `.agentic/project-profile.yaml`.
6. Prüfe `.agentic/quality-gates/stack-fit-checklist.md`.

Begründe die Wahl und nenne mindestens eine realistische Alternative. Presets sind Ausgangspunkte, keine Erlaubnis, einen bestehenden Projektstack ungefragt zu ersetzen.

## Workflow-Auswahl

- Feature: `.agentic/workflows/feature.md`
- Bugfix: `.agentic/workflows/bugfix.md`
- Refactor: `.agentic/workflows/refactor.md`
- Datenbank-/Schemamigration: `.agentic/workflows/migration.md`
- Release: `.agentic/workflows/release.md`
- Incident: `.agentic/workflows/incident-fix.md`
- Review: `.agentic/workflows/pr-review.md`

Ergänzende Workflows wie Performance, Dokumentation oder Dependency-Upgrade sind bei passender Aufgabe zu verwenden. Der Workflow bestimmt Planung, Nachweise und Abschlusskriterien.

## Agentenrollen und Skills

Rollenprofile in `.agentic/agents/` strukturieren Verantwortung, zum Beispiel Planner, Architect, Implementer, QA, Reviewer, Security Reviewer, Performance Reviewer, DevOps und Docs Writer. Verwende nur Rollen, die einen klaren Beitrag leisten; die Verantwortung für ein konsistentes Gesamtergebnis bleibt beim ausführenden Codex-Agenten.

Nutze passende Skills aus `.agents/skills/`. Lies vor der Anwendung die jeweilige `SKILL.md` vollständig und befolge Auslöser, Voraussetzungen, Ablauf, Sicherheitsregeln und Abschlusskriterien. Skills ergänzen das Projektprofil und die zentralen Regeln, ersetzen sie aber nicht.

## Menschliche Freigabe

Explizite Freigabe ist vor der wirksamen Aktion erforderlich bei:

- produktiven Deployments und Produktionsmigrationen
- Datenlöschung oder irreversiblen Datenänderungen
- Secrets-, Schlüssel- oder Zertifikatsänderungen
- Authentifizierungs-, Autorisierungs- oder Tenant-Isolation-Änderungen mit produktiver Wirkung
- Payment- und Billing-Änderungen
- Tracking oder Analytics mit personenbezogenen Daten
- neuen externen Providern, kostenpflichtigen Services oder wesentlichen Abhängigkeiten
- Umgehung verpflichtender Quality Gates

Vorbereitung, Analyse und lokale Validierung sind ohne Produktionswirkung zulässig; die Freigabe gilt nur für den konkret beschriebenen Schritt.

## Quality Gates und Definition of Done

Eine Aufgabe ist erst abgeschlossen, wenn:

- Ziel und Akzeptanzkriterien erfüllt sind.
- Risiko, Umgebung, App-Profil, Stack-Preset und Workflow nachvollziehbar bestimmt wurden.
- Relevante Tests ergänzt und die in `project-profile.yaml` geforderten Checks ausgeführt wurden oder eine begründete Ausnahme dokumentiert ist.
- Der Diff gegen Definition of Done, Review- und Security-Checkliste geprüft wurde.
- Bei Stack-, Release- oder Produktionsänderungen die passenden zusätzlichen Gates erfüllt sind.
- Dokumentation, Deployment- und Rollback-Hinweise dem Risiko entsprechen.
- Keine offenen kritischen Fehler oder unfreigegebenen produktiven Aktionen verbleiben.

Mindestens zu prüfen sind `.agentic/quality-gates/definition-of-done.md`, `.agentic/quality-gates/review-checklist.md` und `.agentic/quality-gates/security-checklist.md`; abhängig von der Aufgabe zusätzlich Stack Fit, Production Readiness, Release, Migration, Performance, Accessibility oder Data Safety.

## Abschlussformat

```md
## Risk Level / Environment
...

## Summary
- ...

## Changed Files
- `path`: ...

## Verification
- [x] ...
- [ ] Nicht ausgeführt: ... Grund: ...

## Security / Privacy / Operations
- ...

## Deployment / Rollback
- ...

## Open Risks / Follow-ups
- ...
```

## Orbit project context

- Address the user as Mario. Read this entrypoint when greeted with Hallo.
- Documentation and code comments are English; user communication may be German.
- Orbit is a self-hosted modular work platform. Its registered product modules are **Marketing, Knowledge and Support**; the shared **Orbit Assistant** coordinates module-contributed capabilities. Projects and Meetings are roadmap items, not implemented modules. "Orbit Core" retains its historical meaning and is not a synonym for the platform kernel.

### Sources of truth and working state

- Read `docs/IMPLEMENTATION_STATUS.md` and the relevant sections of `docs/REQUIREMENTS_TRACEABILITY.md` before continuing. Entries can describe historical local checkpoints: reconcile them with current code, Git/PR state and, when needed, independently verified runtime state.
- `docs/EDS_ORBIT_UNIFIED_CODEX_MASTER_v3.md` is the original product baseline and supersedes earlier master tasks. For the platform expansion, also read `docs/adr/0009-modular-platform.md` and the task-relevant documents in `plans/orbit-modularization/`, particularly `03-module-contracts.md`, `07-roadmap.md` and `08-risks-and-decisions.md`. Consult later accepted ADRs and feature plans for changes to that baseline.
- For UI work, consult `docs/DESIGN_SYSTEM.md` and `docs/superpowers/specs/2026-10-18-orbit-ui-restructure-design.md`: grouped module navigation, module overview pages, an attention-focused home page and grouped settings. Preserve existing deep links.
- Inspect the checkout path, branch, worktrees, uncommitted changes and current upstream before editing. The primary checkout may lag behind active Claude worktrees. Do not reset, switch or overwrite another task's worktree; use an appropriate isolated worktree when needed.
- Open PRs are not merged capabilities. Verify the selected base before relying on new provider adapters or other in-flight features. Keep implemented, tested, merged, deployed, enabled and live-accepted states distinct.

### Architecture and ownership

- Stack: TypeScript/pnpm monorepo, Next.js web, Fastify API, BullMQ worker, PostgreSQL/pgvector with Prisma, Redis and Better Auth. Read actual versions and commands from `package.json`, `apps/web/package.json`, `.nvmrc` and the lockfile; do not assume older profile version strings remain current.
- `apps/api/src/platform/` owns shared tenancy, governance, assistant, AI budgets, knowledge services, connections, files, email, notifications, realtime and MCP/auth infrastructure.
- `apps/api/src/modules/{marketing,knowledge,support}/` own product functionality. `apps/api/src/modules/registry.ts` registers manifests and contributions; `packages/module-contracts/` defines shared contracts. Some older top-level module paths remain compatibility entrypoints: inspect ownership before adding logic there.
- `apps/web/src/platform/` owns the shell; `apps/web/src/modules/` owns module UI contributions. The web app must not access the database or import server code.
- Respect the import rules in `scripts/boundaries.json` and `scripts/boundaries.mjs`: no platform-to-module, worker-to-module, shell-to-web-module, package-to-app or undeclared cross-module imports. Use registries and declared contracts. Do not add baseline exceptions merely to silence a new violation.
- Knowledge services are shared platform capabilities; the Knowledge module supplies management UI/routes. Source rights and invalidation must propagate to dependent content. Generated content is not verified evidence.
- Support is Orbit's own ticket and communication system, not a Chatwoot-backed module. Read `docs/SUPPORT.md`, `docs/SUPPORT_WIDGET.md`, `docs/EMAIL_AND_NOTIFICATIONS.md` and `docs/PLATFORM_FILES.md` as applicable. Preserve project-scoped file access, composite tenant foreign keys, FORCE RLS and content-free audit records.
- MCP is a protocol/authentication adapter over shared capabilities, with a separate service entrypoint at `apps/api/src/mcp-main.ts`. Read `plans/orbit-modularization/09-mcp-gateway.md` and `docs/deployment/MCP_ROLLOUT.md`. External client confirmation is not Orbit authorization; proposals retain the server-side ActionRequest approval path. The default-off per-inbox Support rule `SupportInbox.rules.mcpOwnerRepliesWithoutApproval` (current ticket inbox only, no project fallback) permits a recorded standing owner decision only for new personal MCP customer replies; delegated agents and other operations still require individual approval (`docs/SUPPORT_MCP.md`).
- Support category/tag definitions are managed through owner-approved MCP tools in `apps/api/src/modules/support/mcp-taxonomy.ts`, sharing native settings schemas and versioned writes. Keys remain stable; deletion is blocked by ticket/inbox references. These project-wide actions never inherit the per-inbox reply exception (`docs/SUPPORT_MCP.md`).
- MCP 2.0 delegated work orders are documented in `docs/MCP_2_0.md` and `docs/plans/MCP_2_0.md`. They reuse private conversations, the native chat worker, module registries and ActionRequests; keep `ORBIT_MCP_TASKS` off unless rollout is authorized. Preserve delegation scope checks before model/tool execution and exact owner approvals for mutations.

### Activation, authority and data

- Module availability, per-project activation and member module roles are separate checks. Read `docs/MODULE_ACTIVATION.md`; do not bypass these checks when adding routes, tools, jobs, exports or navigation.
- Feature flag defaults in code do not establish production flag state. Support, MCP and other gated capabilities require their own rollout evidence; a merge or passing CI alone is not live acceptance.
- Paid AI calls retain server-side mandate, source-use rights, reservation, settlement and budget checks. Read `docs/MODEL_ROUTING.md` and actual provider routing before changing a call path. Ambiguous transmitted calls or external writes require reconciliation before retry.
- The historical 2026-09-17 authorization covered local application auth/schema/policy code, isolated migrations, test credentials and stack dependencies. It is not blanket permission for new tasks or production actions. Follow the current task's scope; never copy existing secrets or infer deployment/publishing authority from local implementation approval.

### Verification and parallel worktrees

- Use pnpm and the repository's runtime pins. Standard code checks are `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`; use `pnpm test:e2e` for affected browser flows. Documentation-only changes may use path/reference checks and `git diff --check` with the reason for skipping runtime checks stated.
- Integration tests in a worktree use its own local test database: run `node scripts/test-db-for-worktree.ts` before the suite and after pulling migrations (README, "Parallel worktrees"). It also isolates Redis queue namespaces. Never redeploy or reset the shared `orbit_test` for another branch; follow the README for local environment loading without printing credentials.
- Preserve the safety nets: `apps/api/tests/rls-matrix.integration.test.ts`, `apps/api/tests/access-matrix.integration.test.ts` and `apps/worker/tests/queue-dispatch.integration.test.ts`. Review intended access-matrix fixture changes as security changes, not mechanical test updates.
- After API contract changes, regenerate the OpenAPI/client artifacts with `pnpm api:generate` in the configured local environment and review their diff. Run relevant module, permission, disabled-feature and cross-project negative tests.
- For Compose/MCP changes, run `pnpm test:coolify-compose` and the applicable conformance tests. Follow the rollout runbook for production checks; do not flip flags or call paid providers as an implicit smoke test.

### Main delivery workflow (Mario, 2026-10-19)

- Deliver routine authorized changes by committing and pushing directly to `main`; a pull request, merge queue, and pre-push GitHub CI success are not required.
- Since 2026-10-29 production runs on `https://coolify-pve.eds-labs.io` (application `Orbit Production (GitHub)`, compose `/docker-compose.pve.yml`). A push to `main` deploys it. A change to the schema, SQL migrations or grant scripts needs a newly approved schema hash in Coolify first (`docs/deployment/COOLIFY.md`, "Current production" and VM102).
- Isolated worktrees may still be used to protect concurrent work. Before delivery, integrate the current `origin/main` and push the resulting fast-forward history to `main`; never force-push or overwrite another task's changes.
- Keep the relevant local checks and report their results. GitHub Actions remains enabled as background feedback after pushes and can be run manually; its completion does not gate the push.
- This owner-approved project workflow overrides the generic protected-branch/PR and required-CI merge recommendations in `.agentic/ci/`. Production deployments, migrations and other consequential actions retain their separate explicit authorization requirements.

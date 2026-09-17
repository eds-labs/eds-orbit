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
- The active product contract is docs/EDS_ORBIT_UNIFIED_CODEX_MASTER_v3.md. Earlier Orbit master tasks are superseded.
- The 2026-09-17 request authorizes new local application auth/schema/policy code, isolated migrations, test credentials and dependency installation required by this stack. It does not authorize production changes or copying existing secrets.
- Documentation and code comments are English; user communication may be German.
- Check docs/IMPLEMENTATION_STATUS.md and docs/REQUIREMENTS_TRACEABILITY.md before continuing.

---
name: agentic-release
description: Für Release-Vorbereitung: prüft Changelog, Versionierung, Tests, Build, Migrationen, Feature Flags, Rollback, Monitoring und Post-Release-Verifikation.
---

# Agentic Release Skill

## Name

`agentic-release`

## Zweck

Für Release-Vorbereitung: prüft Changelog, Versionierung, Tests, Build, Migrationen, Feature Flags, Rollback, Monitoring und Post-Release-Verifikation.

## Auslöser

Nutze diesen Skill, wenn die Aufgabe zum beschriebenen Zweck passt oder ausdrücklich `agentic-release` verlangt.

## Voraussetzungen

- `AGENTS.md` und `.agentic/project-profile.yaml` wurden gelesen.
- Relevante Workflow-, Risiko-, Environment- und Fachregeln sind bekannt.
- Scope, Ziel und erforderliche Freigaben sind geklärt.

## Vorgehen

1. Lies `.agentic/workflows/release.md` und `.agentic/quality-gates/release-checklist.md`.
2. Prüfe Changelog, Version, Tests, Build und Migrationen.
3. Identifiziere Breaking Changes und Env-Änderungen.
4. Notiere Rollback- und Post-Release-Schritte.
5. Liefere eine Release Summary.

## Erwarteter Output

```md
## Release Summary
...

## Verification
...

## Migration / Rollback
...

## Risks
...

## Post-Release Checks
...
```

## Sicherheitsregeln

- Keine Secrets ausgeben oder erzeugen.
- Keine destruktiven oder produktiv wirksamen Aktionen ohne explizite Freigabe.
- Bei erhöhtem Risiko die betroffenen Security-, Datenbank- und Production-Regeln anwenden.

## Abschlusskriterien

- Ziel und dokumentierter Scope sind erfüllt.
- Relevante Tests und Quality Gates sind ausgeführt oder begründet als offen markiert.
- Sicherheits-, Freigabe- und Rollback-Anforderungen sind dem Risiko entsprechend dokumentiert.

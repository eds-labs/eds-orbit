---
name: agentic-project-intake
description: Für den Einstieg in neue oder unbekannte Repositories: liest Projektregeln, erfasst Struktur, App-Profile, Befehle und Risiken und erstellt vor Änderungen eine knappe Onboarding-Zusammenfassung.
---

# Agentic Project Intake Skill

## Name

`agentic-project-intake`

## Auslöser

Nutze diesen Skill, wenn die Aufgabe zum beschriebenen Zweck passt oder ausdrücklich `agentic-project-intake` verlangt.

## Voraussetzungen

- `AGENTS.md` und `.agentic/project-profile.yaml` wurden gelesen.
- Relevante Workflow-, Risiko-, Environment- und Fachregeln sind bekannt.
- Scope, Ziel und erforderliche Freigaben sind geklärt.

## Zweck

Erstelle eine belastbare Projektübersicht, bevor Codex Änderungen macht.

## Vorgehen

1. Lies `AGENTS.md` und `.agentic/project-profile.yaml`.
2. Prüfe, ob `.agentic/context/architecture-map.md`, `README.md`, Package-/Build-Dateien und Testkonfigurationen existieren.
3. Bestimme Anwendungstyp, Stack, wichtigste Commands und riskante Bereiche.
4. Ergänze keine Regeln automatisch, außer die Aufgabe verlangt das explizit.
5. Liefere eine kurze Onboarding-Zusammenfassung.

## Erwarteter Output

```md
## Projektübersicht
...

## Stack & Commands
...

## Struktur
...

## Risiken / sensible Bereiche
...

## Empfohlene nächste Schritte
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

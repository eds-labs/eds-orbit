---
name: stack-select
description: Wählt anhand von Anwendungstyp, Plattform, Betriebsmodell und Team-Skills ein passendes Techstack-Preset aus.
---

# Skill: Stack Select

## Name

`stack-select`

## Zweck

Wählt anhand von Anwendungstyp, Plattform, Betriebsmodell und Team-Skills ein passendes Techstack-Preset aus.

## Auslöser

Nutze diesen Skill, wenn die Aufgabe zum beschriebenen Zweck passt oder ausdrücklich `stack-select` verlangt.

## Voraussetzungen

- `AGENTS.md` und `.agentic/project-profile.yaml` wurden gelesen.
- Relevante Workflow-, Risiko-, Environment- und Fachregeln sind bekannt.
- Scope, Ziel und erforderliche Freigaben sind geklärt.

Nutze diese Skill, wenn eine neue Anwendung, ein neues Modul oder ein neues Repository geplant wird.

## Vorgehen

1. Lies `.agentic/routing/stack-selection.md`.
2. Erfasse Zielplattformen, Betriebsmodell, Team-Skills und Prioritäten.
3. Wähle ein Preset aus `.agentic/stack-presets/`.
4. Begründe die Wahl kurz.
5. Nenne 1-2 Alternativen und warum sie nicht gewählt wurden.
6. Verweise auf die passende Strukturdatei aus `.agentic/app-structures/`.
7. Prüfe gegen `.agentic/quality-gates/stack-fit-checklist.md`.

## Erwarteter Output

```md
## Empfohlenes Preset
...

## Warum
...

## Alternativen
...

## Projektstruktur
...

## Offene Risiken
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

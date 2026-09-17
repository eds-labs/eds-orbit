---
name: new-project-bootstrap
description: Führt den Bootstrap-Fragebogen aus und leitet Stack, Repo-Strategie, Deployment und ADRs ab.
---

# New Project Bootstrap Skill

## Name

`new-project-bootstrap`

## Zweck

Führt den Bootstrap-Fragebogen aus und leitet Stack, Repo-Strategie, Deployment und ADRs ab.

## Auslöser

Nutze diesen Skill, wenn die Aufgabe zum beschriebenen Zweck passt oder ausdrücklich `new-project-bootstrap` verlangt.

## Voraussetzungen

- `AGENTS.md` und `.agentic/project-profile.yaml` wurden gelesen.
- Relevante Workflow-, Risiko-, Environment- und Fachregeln sind bekannt.
- Scope, Ziel und erforderliche Freigaben sind geklärt.

Nutze diesen Skill für neue Apps, Services oder größere Module.

## Vorgehen

1. Fülle `.agentic/templates/project-bootstrap-questionnaire.md` aus dem User-Kontext.
2. Wähle, wenn verfügbar, ein Stack-Preset aus `.agentic/stack-presets/`.
3. Wähle eine Repo-Strategie aus `.agentic/repo-strategies/`.
4. Wähle ein Deployment-Preset aus `.agentic/deployment-presets/`.
5. Bestimme erforderliche ADRs.
6. Bestimme High-Risk-Bereiche.

## Erwarteter Output

```md
## Recommended Stack
## Alternative
## Repo Strategy
## Deployment Preset
## Initial Structure
## Risk Areas
## Required ADRs
## Next Implementation Steps
```

## Sicherheitsregeln

- Keine Secrets ausgeben oder erzeugen.
- Keine destruktiven oder produktiv wirksamen Aktionen ohne explizite Freigabe.
- Bei erhöhtem Risiko die betroffenen Security-, Datenbank- und Production-Regeln anwenden.

## Abschlusskriterien

- Ziel und dokumentierter Scope sind erfüllt.
- Relevante Tests und Quality Gates sind ausgeführt oder begründet als offen markiert.
- Sicherheits-, Freigabe- und Rollback-Anforderungen sind dem Risiko entsprechend dokumentiert.

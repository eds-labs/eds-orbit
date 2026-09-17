---
name: deployment-plan
description: Wählt Deployment-Preset und erstellt Deploy-/Rollback-Plan.
---

# Deployment Plan Skill

## Name

`deployment-plan`

## Zweck

Wählt Deployment-Preset und erstellt Deploy-/Rollback-Plan.

## Auslöser

Nutze diesen Skill, wenn die Aufgabe zum beschriebenen Zweck passt oder ausdrücklich `deployment-plan` verlangt.

## Voraussetzungen

- `AGENTS.md` und `.agentic/project-profile.yaml` wurden gelesen.
- Relevante Workflow-, Risiko-, Environment- und Fachregeln sind bekannt.
- Scope, Ziel und erforderliche Freigaben sind geklärt.

Nutze diesen Skill für Deployment-, Release-, Environment-, CI/CD- oder Provider-Planung.

## Vorgehen

1. Bestimme die Umgebung: Preview, Staging oder Production.
2. Wähle das passende Preset aus `.agentic/deployment-presets/`.
3. Lies `.agentic/ci/required-checks.md`.
4. Erstelle einen Deployment-Plan mit Env Vars, Migrationen, Checks und Rollback.

## Erwarteter Output

Use `.agentic/templates/deployment-plan.md`.

## Sicherheitsregeln

- Keine Secrets ausgeben oder erzeugen.
- Keine destruktiven oder produktiv wirksamen Aktionen ohne explizite Freigabe.
- Bei erhöhtem Risiko die betroffenen Security-, Datenbank- und Production-Regeln anwenden.

## Abschlusskriterien

- Ziel und dokumentierter Scope sind erfüllt.
- Relevante Tests und Quality Gates sind ausgeführt oder begründet als offen markiert.
- Sicherheits-, Freigabe- und Rollback-Anforderungen sind dem Risiko entsprechend dokumentiert.

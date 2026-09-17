---
name: production-change
description: Erstellt einen Production Change Plan mit Tests, Rollback und Post-Deploy Checks.
---

# Production Change Skill

## Name

`production-change`

## Zweck

Erstellt einen Production Change Plan mit Tests, Rollback und Post-Deploy Checks.

## Auslöser

Nutze diesen Skill, wenn die Aufgabe zum beschriebenen Zweck passt oder ausdrücklich `production-change` verlangt.

## Voraussetzungen

- `AGENTS.md` und `.agentic/project-profile.yaml` wurden gelesen.
- Relevante Workflow-, Risiko-, Environment- und Fachregeln sind bekannt.
- Scope, Ziel und erforderliche Freigaben sind geklärt.

Nutze diesen Skill für Production-Deployments, Produktionskonfiguration, Produktionsmigrationen oder andere kritische Betriebsarbeiten.

## Vorgehen

1. Lies `.agentic/environments/production.md`.
2. Lies `.agentic/templates/production-change-plan.md`.
3. Bestimme betroffene Systeme und Risikolevel.
4. Definiere Test-, Deployment-, Monitoring- und Rollback-Schritte.
5. Markiere Aktionen mit expliziter Freigabepflicht.

## Erwarteter Output

Use the Production Change Plan template exactly.

## Sicherheitsregeln

- Keine Secrets ausgeben oder erzeugen.
- Keine destruktiven oder produktiv wirksamen Aktionen ohne explizite Freigabe.
- Bei erhöhtem Risiko die betroffenen Security-, Datenbank- und Production-Regeln anwenden.

## Abschlusskriterien

- Ziel und dokumentierter Scope sind erfüllt.
- Relevante Tests und Quality Gates sind ausgeführt oder begründet als offen markiert.
- Sicherheits-, Freigabe- und Rollback-Anforderungen sind dem Risiko entsprechend dokumentiert.

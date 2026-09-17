---
name: risk-review
description: Bewertet Risiko-Level, betroffene Policies und erforderliche Freigaben für eine Aufgabe.
---

# Risk Review Skill

## Name

`risk-review`

## Zweck

Bewertet Risiko-Level, betroffene Policies und erforderliche Freigaben für eine Aufgabe.

## Auslöser

Nutze diesen Skill, wenn die Aufgabe zum beschriebenen Zweck passt oder ausdrücklich `risk-review` verlangt.

## Voraussetzungen

- `AGENTS.md` und `.agentic/project-profile.yaml` wurden gelesen.
- Relevante Workflow-, Risiko-, Environment- und Fachregeln sind bekannt.
- Scope, Ziel und erforderliche Freigaben sind geklärt.

Nutze diesen Skill für Features, Bugfixes, Refactorings, Migrationen, Deployments oder andere betriebliche Änderungen.

## Vorgehen

1. Lies `.agentic/routing/risk-classification.md`.
2. Bestimme betroffene Bereiche: Datenbank, Auth, Secrets, Deployment, Userdaten, externe Provider, Kosten und AI-Tools.
3. Weise das Risikolevel low, medium, high oder critical zu.
4. Liste die zu lesenden Policies auf.
5. Nenne, ob menschliche Freigabe nötig ist.
6. Erstelle sichere nächste Schritte.

## Erwarteter Output

```md
## Risk Level

## Why

## Impacted Areas

## Required Policies

## Approval Needed

## Safe Plan
```

## Sicherheitsregeln

- Keine Secrets ausgeben oder erzeugen.
- Keine destruktiven oder produktiv wirksamen Aktionen ohne explizite Freigabe.
- Bei erhöhtem Risiko die betroffenen Security-, Datenbank- und Production-Regeln anwenden.

## Abschlusskriterien

- Ziel und dokumentierter Scope sind erfüllt.
- Relevante Tests und Quality Gates sind ausgeführt oder begründet als offen markiert.
- Sicherheits-, Freigabe- und Rollback-Anforderungen sind dem Risiko entsprechend dokumentiert.

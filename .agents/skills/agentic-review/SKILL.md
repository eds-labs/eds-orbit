---
name: agentic-review
description: Für Reviews von Diffs, Commits, Pull Requests oder uncommitted Changes auf Korrektheit, Wartbarkeit, Sicherheit, Performance, Tests, Dokumentation und Breaking Changes.
---

# Agentic Review Skill

## Name

`agentic-review`

## Zweck

Für Reviews von Diffs, Commits, Pull Requests oder uncommitted Changes auf Korrektheit, Wartbarkeit, Sicherheit, Performance, Tests, Dokumentation und Breaking Changes.

## Auslöser

Nutze diesen Skill, wenn die Aufgabe zum beschriebenen Zweck passt oder ausdrücklich `agentic-review` verlangt.

## Voraussetzungen

- `AGENTS.md` und `.agentic/project-profile.yaml` wurden gelesen.
- Relevante Workflow-, Risiko-, Environment- und Fachregeln sind bekannt.
- Scope, Ziel und erforderliche Freigaben sind geklärt.

## Vorgehen

1. Review-Scope bestimmen.
2. Kontext und Ziel der Änderung verstehen.
3. Prüfe gegen `.agentic/quality-gates/review-checklist.md`.
4. Bei sensiblen Bereichen zusätzlich `.agentic/quality-gates/security-checklist.md` anwenden.
5. Findings priorisieren.

## Erwarteter Output

```md
## Blocker
- ...

## Should Fix
- ...

## Nice to Have
- ...

## Questions
- ...

## Verdict
Approved | Changes requested
```

## Sicherheitsregeln

- Keine Secrets ausgeben oder erzeugen.
- Keine destruktiven oder produktiv wirksamen Aktionen ohne explizite Freigabe.
- Bei erhöhtem Risiko die betroffenen Security-, Datenbank- und Production-Regeln anwenden.

## Abschlusskriterien

- Ziel und dokumentierter Scope sind erfüllt.
- Relevante Tests und Quality Gates sind ausgeführt oder begründet als offen markiert.
- Sicherheits-, Freigabe- und Rollback-Anforderungen sind dem Risiko entsprechend dokumentiert.

---
name: incident-response
description: Hilft bei Incident-Diagnose, Sofortmaßnahmen, Rollback und Nachbereitung.
---

# Incident Response Skill

## Name

`incident-response`

## Zweck

Hilft bei Incident-Diagnose, Sofortmaßnahmen, Rollback und Nachbereitung.

## Auslöser

Nutze diesen Skill, wenn die Aufgabe zum beschriebenen Zweck passt oder ausdrücklich `incident-response` verlangt.

## Voraussetzungen

- `AGENTS.md` und `.agentic/project-profile.yaml` wurden gelesen.
- Relevante Workflow-, Risiko-, Environment- und Fachregeln sind bekannt.
- Scope, Ziel und erforderliche Freigaben sind geklärt.

Nutze diesen Skill bei Produktionsfehlern, Ausfällen, Security Incidents oder Datenproblemen.

## Vorgehen

1. Klassifiziere den Schweregrad.
2. Erfasse Symptome und betroffene Systeme.
3. Bevorzuge sichere Eindämmung vor breitem Refactoring.
4. Bestimme Rollback- und Recovery-Pfad.
5. Sichere Belege und vermeide destruktive Aktionen.
6. Erstelle Post-Incident-Notizen.

## Erwarteter Output

Use `.agentic/templates/incident-runbook.md`.

## Sicherheitsregeln

- Keine Secrets ausgeben oder erzeugen.
- Keine destruktiven oder produktiv wirksamen Aktionen ohne explizite Freigabe.
- Bei erhöhtem Risiko die betroffenen Security-, Datenbank- und Production-Regeln anwenden.

## Abschlusskriterien

- Ziel und dokumentierter Scope sind erfüllt.
- Relevante Tests und Quality Gates sind ausgeführt oder begründet als offen markiert.
- Sicherheits-, Freigabe- und Rollback-Anforderungen sind dem Risiko entsprechend dokumentiert.

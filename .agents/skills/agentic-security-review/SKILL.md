---
name: agentic-security-review
description: Für Security-Reviews von Authentifizierung, Autorisierung, Billing, Admin-Funktionen, Uploads, Webhooks, User Content, Agenten-Tools, Secrets und externen Seiteneffekten.
---

# Agentic Security Review Skill

## Name

`agentic-security-review`

## Zweck

Für Security-Reviews von Authentifizierung, Autorisierung, Billing, Admin-Funktionen, Uploads, Webhooks, User Content, Agenten-Tools, Secrets und externen Seiteneffekten.

## Auslöser

Nutze diesen Skill, wenn die Aufgabe zum beschriebenen Zweck passt oder ausdrücklich `agentic-security-review` verlangt.

## Voraussetzungen

- `AGENTS.md` und `.agentic/project-profile.yaml` wurden gelesen.
- Relevante Workflow-, Risiko-, Environment- und Fachregeln sind bekannt.
- Scope, Ziel und erforderliche Freigaben sind geklärt.

## Vorgehen

1. Scope und Trust Boundaries bestimmen.
2. Prüfe AuthN/AuthZ, Input Validation, Secrets, Logging, externe Systeme und Datenlecks.
3. Bei Agenten/LLM: Prompt Injection, Tool Validation, Approval Gates und Output Validation prüfen.
4. Konkrete Findings mit Datei/Flow nennen.
5. Missbrauchs-/Negativtests vorschlagen.

## Erwarteter Output

```md
## Critical
- ...

## High / Medium
- ...

## Tests Needed
- ...

## Recommended Fixes
- ...
```

## Sicherheitsregeln

- Keine Secrets ausgeben oder erzeugen.
- Keine destruktiven oder produktiv wirksamen Aktionen ohne explizite Freigabe.
- Bei erhöhtem Risiko die betroffenen Security-, Datenbank- und Production-Regeln anwenden.

## Abschlusskriterien

- Ziel und dokumentierter Scope sind erfüllt.
- Relevante Tests und Quality Gates sind ausgeführt oder begründet als offen markiert.
- Sicherheits-, Freigabe- und Rollback-Anforderungen sind dem Risiko entsprechend dokumentiert.

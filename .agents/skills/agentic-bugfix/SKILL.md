---
name: agentic-bugfix
description: Für Bugfixes: reproduziert oder analysiert den Fehler, belegt die Root Cause, setzt den kleinsten sicheren Fix um, ergänzt einen Regressionstest und führt relevante Prüfungen aus.
---

# Agentic Bugfix Skill

## Name

`agentic-bugfix`

## Zweck

Für Bugfixes: reproduziert oder analysiert den Fehler, belegt die Root Cause, setzt den kleinsten sicheren Fix um, ergänzt einen Regressionstest und führt relevante Prüfungen aus.

## Auslöser

Nutze diesen Skill, wenn die Aufgabe zum beschriebenen Zweck passt oder ausdrücklich `agentic-bugfix` verlangt.

## Voraussetzungen

- `AGENTS.md` und `.agentic/project-profile.yaml` wurden gelesen.
- Relevante Workflow-, Risiko-, Environment- und Fachregeln sind bekannt.
- Scope, Ziel und erforderliche Freigaben sind geklärt.

## Vorgehen

1. Fehlerbild, erwartetes und tatsächliches Verhalten festhalten.
2. Reproduktionspfad oder plausible failing path bestimmen.
3. Root Cause identifizieren und belegen.
4. Ähnliche Stellen suchen.
5. Kleinsten sicheren Fix implementieren.
6. Regressionstest ergänzen.
7. Relevante Tests/Checks ausführen.

## Erwarteter Output

```md
## Root Cause
...

## Fix
...

## Regression Test
...

## Verification
...

## Risks
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

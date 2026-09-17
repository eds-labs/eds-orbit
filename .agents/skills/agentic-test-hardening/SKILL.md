---
name: agentic-test-hardening
description: Für neue oder verbesserte Tests, Regressionstests, die Stabilisierung flaky Tests, Testmatrizen und die Abstimmung mit den Befehlen des Projektprofils.
---

# Agentic Test Hardening Skill

## Name

`agentic-test-hardening`

## Zweck

Für neue oder verbesserte Tests, Regressionstests, die Stabilisierung flaky Tests, Testmatrizen und die Abstimmung mit den Befehlen des Projektprofils.

## Auslöser

Nutze diesen Skill, wenn die Aufgabe zum beschriebenen Zweck passt oder ausdrücklich `agentic-test-hardening` verlangt.

## Voraussetzungen

- `AGENTS.md` und `.agentic/project-profile.yaml` wurden gelesen.
- Relevante Workflow-, Risiko-, Environment- und Fachregeln sind bekannt.
- Scope, Ziel und erforderliche Freigaben sind geklärt.

## Vorgehen

1. Betroffene Logik und Risiko bestimmen.
2. Bestehende Tests finden.
3. Testlücken identifizieren.
4. Minimal sinnvolle Tests ergänzen.
5. Flaky Ursachen vermeiden: echte Wartezeiten, globale Zustände, Zeit, Netzwerk, Reihenfolge.
6. Relevante Checks ausführen.

## Erwarteter Output

- Teststrategie
- Ergänzte/angepasste Tests
- Ausgeführte Checks
- Bekannte Lücken

## Sicherheitsregeln

- Keine Secrets ausgeben oder erzeugen.
- Keine destruktiven oder produktiv wirksamen Aktionen ohne explizite Freigabe.
- Bei erhöhtem Risiko die betroffenen Security-, Datenbank- und Production-Regeln anwenden.

## Abschlusskriterien

- Ziel und dokumentierter Scope sind erfüllt.
- Relevante Tests und Quality Gates sind ausgeführt oder begründet als offen markiert.
- Sicherheits-, Freigabe- und Rollback-Anforderungen sind dem Risiko entsprechend dokumentiert.

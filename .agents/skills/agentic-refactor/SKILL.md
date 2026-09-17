---
name: agentic-refactor
description: Für sichere Refactorings ohne Verhaltensänderung: erfasst bestehendes Verhalten, ergänzt bei Bedarf Characterization Tests, ändert die Struktur in kleinen Schritten und prüft die Äquivalenz.
---

# Agentic Refactor Skill

## Name

`agentic-refactor`

## Zweck

Für sichere Refactorings ohne Verhaltensänderung: erfasst bestehendes Verhalten, ergänzt bei Bedarf Characterization Tests, ändert die Struktur in kleinen Schritten und prüft die Äquivalenz.

## Auslöser

Nutze diesen Skill, wenn die Aufgabe zum beschriebenen Zweck passt oder ausdrücklich `agentic-refactor` verlangt.

## Voraussetzungen

- `AGENTS.md` und `.agentic/project-profile.yaml` wurden gelesen.
- Relevante Workflow-, Risiko-, Environment- und Fachregeln sind bekannt.
- Scope, Ziel und erforderliche Freigaben sind geklärt.

## Sicherheitsregeln

- Verhalten darf sich nicht ändern.
- Keine Feature-Änderungen beimischen.
- Vorher Tests prüfen.
- Bei ungetesteter kritischer Logik zuerst Characterization Tests ergänzen.
- Kleine Schritte und klare Summary.

## Vorgehen

1. Scope und Nicht-Ziele definieren.
2. Bestehendes Verhalten erfassen.
3. Testabdeckung prüfen.
4. Refactor-Plan erstellen.
5. Schrittweise ändern.
6. Tests ausführen.
7. Ergebnis gegen `.agentic/workflows/refactor.md` prüfen.

## Erwarteter Output

- Nachvollziehbares Ergebnis gemäß dem beschriebenen Vorgehen
- Ausgeführte Prüfungen, verbleibende Risiken und offene Punkte

## Abschlusskriterien

- Ziel und dokumentierter Scope sind erfüllt.
- Relevante Tests und Quality Gates sind ausgeführt oder begründet als offen markiert.
- Sicherheits-, Freigabe- und Rollback-Anforderungen sind dem Risiko entsprechend dokumentiert.

# Architecture Rules

## Grundregeln

- Bestehende Architektur und Modulgrenzen erkennen, bevor du neue Dateien anlegst.
- Neue Logik in die kleinste passende Schicht einfügen.
- Abhängigkeiten sollen nach innen zeigen: UI -> Application -> Domain -> Infrastructure.
- Infrastructure-Details nicht in Domain-Logik leaken.
- Feature Flags nutzen, wenn Rollout-Risiko besteht.

## Vor Architekturänderungen prüfen

- Welches konkrete Problem löst die Änderung?
- Gibt es eine kleinere lokale Lösung?
- Welche Module werden gekoppelt oder entkoppelt?
- Welche Tests sichern die Änderung ab?
- Gibt es Migration-/Rollout-Risiken?

## Anti-Patterns

- Neue globale Utilities für Einzelfälle.
- God Services oder Dateien mit gemischten Verantwortlichkeiten.
- Business-Logik in Komponenten, Routen oder Jobs duplizieren.
- Abhängigkeiten einführen, um wenige Zeilen Code zu sparen.

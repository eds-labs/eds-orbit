# Testing Rules

## Grundsatz

Tests sollen Verhalten absichern, nicht Implementation Details konservieren.

## Wann Tests nötig sind

- Neue Business-Logik: Unit- oder Integrationstest.
- Bugfix: Regressionstest, der den Fehler abdeckt.
- API-Änderung: Happy Path, Validierungsfehler und relevante AuthZ-Negativfälle.
- UI-Änderung: kritische Zustände und wichtigste User-Flows.
- Migration: Vorwärts- und, wenn möglich, Rollback-/Kompatibilitätsprüfung.

## Testarten

- Unit: reine Logik, Edge Cases.
- Integration: Datenbank, API, externe Adapter mit Mocks/Fakes.
- E2E: kritische User-Flows, nicht jede Kleinigkeit.
- Characterization Tests: vor Refactors in schlecht getesteten Bereichen.

## Vor Abschluss

- Relevante Tests ausführen.
- Wenn Checks nicht möglich sind, klar sagen warum.
- Keine Snapshot-Tests ohne echten Review-Wert ergänzen.

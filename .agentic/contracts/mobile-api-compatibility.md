# Mobile API Compatibility

## Grundsatz

Mobile Clients aktualisieren nicht gleichzeitig mit dem Backend. APIs müssen alte App-Versionen berücksichtigen.

## Regeln

- Felder eher hinzufügen als ändern/entfernen.
- Backend muss mindestens die unterstützten App-Versionen bedienen.
- Feature Flags/Remote Config bei riskanten App-Funktionen.
- App-Version in Requests optional berücksichtigen.
- Kritische Contract-Tests für alte Clients.

## Codex-Regel

API-Änderungen für Mobile brauchen eine Kompatibilitätsnotiz.

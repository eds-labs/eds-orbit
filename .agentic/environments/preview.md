# Environment: Preview

## Ziel

Review- und Demo-Umgebung pro Branch oder Pull Request.

## Regeln

- Preview nutzt Testdaten oder isolierte Daten.
- Feature Flags dürfen genutzt werden.
- Secrets sind environment-spezifisch.
- Preview-URLs sind nicht als sichere Zugriffskontrolle zu behandeln.

## Checks

- Build erfolgreich
- Smoke Test kritischer Route
- Auth-Flow mit Testuser
- keine echten Produktionsdaten
- keine offenen Debug-Endpunkte

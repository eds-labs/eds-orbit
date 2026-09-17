# App Profile: CLI Tool

## Prioritäten

- klare Commands
- gute Fehlermeldungen
- stabile Exit Codes
- Help Text
- Konfigurationsauflösung
- Cross-Platform-Verhalten

## Immer prüfen

- `--help`
- fehlende/ungültige Argumente
- Exit Codes
- stdout vs stderr
- nicht-interaktive Nutzung
- Shell-sichere Pfadbehandlung

## Tests

- Command-Invocation-Tests.
- Snapshot nur für Help-Ausgaben, wenn stabil und wertvoll.
- Tests für Fehlerfälle.

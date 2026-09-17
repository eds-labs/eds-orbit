# App Profile: Browser Extension

## Prioritäten

- minimale Permissions
- Content Script Isolation
- sichere Message Passing Contracts
- Manifest-Konformität
- Datenschutz

## Immer prüfen

- Welche Browser-Permissions sind nötig?
- Werden Page-Daten minimiert?
- Sind Messages validiert?
- Gibt es CSP-Auswirkungen?
- Funktioniert es bei mehreren Tabs/Fenstern?

## Tests

- Unit-Tests für Message Contracts.
- Integration/Manual Tests in Browser.
- Negativtests für unerwartete Messages.

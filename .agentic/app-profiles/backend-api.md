# App Profile: Backend API

## Prioritäten

- korrekte Domänenlogik
- stabile API-Verträge
- Auth/AuthZ
- Input Validation
- Fehlerbehandlung
- Observability
- Datenbank-Konsistenz

## Immer prüfen

- Request Validation
- Response Schema
- Status Codes
- Auth Checks
- Rate Limits bei öffentlichen Endpunkten
- Idempotenz bei kritischen Operationen
- Transaktionen bei Multi-Step Writes
- Pagination bei Listen

## Tests

- Unit-Tests für Business-Logik.
- Integrationstests für API-Endpunkte.
- Negativtests für Berechtigungen.

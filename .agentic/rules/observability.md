# Observability Rules

## Wann Observability nötig ist

- neue kritische Flows
- Jobs/Pipelines
- Auth/Billing/Admin-Aktionen
- externe API-Integrationen
- Performance-sensitive Pfade

## Prüfen

- Gibt es brauchbare Logs ohne sensible Daten?
- Gibt es Metriken für Erfolg/Fehler/Latenz?
- Gibt es Tracing oder Korrelation IDs, wenn relevant?
- Sind Alerts nötig?
- Können Fehler reproduziert oder diagnostiziert werden?

## Logging

- Keine Tokens, Passwörter, API Keys oder personenbezogene Daten unnötig loggen.
- Fehlerkontext strukturiert, aber datenarm erfassen.

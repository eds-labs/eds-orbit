# Queue Policy

## Regeln

- Jobs haben eindeutige Namen.
- Payloads sind klein und versionierbar.
- Keine Secrets in Payloads.
- Retry-Strategie definieren.
- Dead-letter oder Failed-Jobs-Ansicht.
- Idempotency Key bei Nebenwirkungen.

## Tests

- erfolgreicher Job
- Provider-Fehler
- Retry
- doppelter Job
- malformed payload

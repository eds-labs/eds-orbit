# Idempotency

## Grundsatz

Wiederholte Ausführung darf keine falschen doppelten Nebenwirkungen erzeugen.

## Kritisch bei

- Payments
- E-Mails
- Webhooks
- Imports
- AI-Kosten
- Datenlöschung
- Queue Retries

## Techniken

- Idempotency Keys
- Unique Constraints
- Processed Event Tabelle
- Statusmaschine
- Transaktionen
- dedizierte Outbox Pattern

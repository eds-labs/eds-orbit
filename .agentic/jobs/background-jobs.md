# Background Jobs

## Dafür geeignet

- E-Mail-Versand
- Webhook-Verarbeitung
- PDF-Erzeugung
- AI-Verarbeitung
- lange Imports
- Batch Updates
- Payment-Sync

## Nicht in normalem Request verstecken

Lange oder wiederholbare Arbeit gehört in Jobs/Queues/Cron, nicht in fragile HTTP-Requests.

## Pflicht

- idempotent
- retry-sicher
- Fehlerlogging
- Dead-letter oder manuelle Recovery
- Monitoring

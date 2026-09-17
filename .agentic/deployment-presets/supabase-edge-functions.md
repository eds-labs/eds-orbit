# Deployment Preset: Supabase Edge Functions

## Geeignet für

- Webhooks
- serverseitige Integrationen
- leichte API-Endpunkte nah an Supabase

## Pflichtchecks

- Secrets serverseitig setzen
- keine Service Role im Client
- Webhook-Signaturen validieren
- Idempotenz bei Provider-Events
- Logs ohne sensible Daten
- lokale Tests oder Integrationstests
- Deploy-Reihenfolge mit DB-Migrationen beachten

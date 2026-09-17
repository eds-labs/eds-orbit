# Deployment Preset: Vercel + Supabase

## Geeignet für

- Next.js Webapps
- SaaS MVPs
- Dashboards
- Apps mit Supabase Auth, Postgres, Storage, Realtime und Edge Functions

## Struktur

- Frontend/Next.js: Vercel
- Datenbank/Auth/Storage: Supabase
- Serverless/Edge-Webhooks: Supabase Edge Functions oder Next.js Route Handler

## Pflichtchecks

- `NEXT_PUBLIC_*` nur für wirklich öffentliche Werte
- Supabase Service Role Key niemals im Client
- RLS für user-/tenantbezogene Tabellen
- Webhook-Secrets serverseitig validieren
- Preview-Projekte von Production trennen
- Migrationen nicht nur im Dashboard klicken, sondern versionieren

## Rollback

- Code-Rollback über Vercel Deployment
- Feature Flag für riskante Features
- DB-Rollback oder Forward-Fix definieren
- Supabase Policies separat prüfen

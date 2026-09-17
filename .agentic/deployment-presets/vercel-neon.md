# Deployment Preset: Vercel + Neon/Postgres

## Geeignet für

- Next.js mit eigener Auth/API-Schicht
- Projekte mit Postgres Branching
- Teams, die DB-Migrationen stark versionieren wollen

## Pflichtchecks

- Connection Pooling beachten
- Migrationen in CI testen
- Preview Branch DBs nicht mit Production verwechseln
- Secrets pro Environment trennen
- Cold-Start- und Connection-Limits berücksichtigen

## Typische Architektur

```txt
Vercel App
├── Next.js App Router
├── Route Handlers / Server Actions
└── DB Client mit serverseitiger Env Config

Neon/Postgres
├── Production Branch
├── Staging Branch
└── Preview Branches optional
```

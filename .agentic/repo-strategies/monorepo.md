# Repo Strategy: Monorepo

## Geeignet für

- Web + Mobile + API
- shared UI und shared Schemas
- mehrere Apps mit gemeinsamer Domäne

## Struktur

```txt
apps/
├── web/
├── mobile/
├── api/
└── docs/

packages/
├── ui/
├── config/
├── db/
├── auth/
├── schemas/
└── api-client/
```

## Regeln

- Package Boundaries definieren
- Shared Packages klein halten
- keine zyklischen Abhängigkeiten
- CI affected-aware machen

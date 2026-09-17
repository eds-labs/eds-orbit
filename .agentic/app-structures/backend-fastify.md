# Projektstruktur: Backend Fastify + Postgres

```txt
.
├── src/
│   ├── app.ts
│   ├── server.ts
│   ├── config/
│   ├── plugins/
│   ├── db/
│   │   ├── schema/
│   │   └── migrations/
│   ├── modules/
│   │   └── <module>/
│   │       ├── routes.ts
│   │       ├── service.ts
│   │       ├── repository.ts
│   │       ├── schema.ts
│   │       └── tests/
│   └── shared/
├── tests/
└── .agentic/
```

## Codex-Regeln

- Route-Validation immer per Schema.
- Businesslogik nicht in Route Handlern verstecken.
- Datenzugriff über Repository/DB-Modul.
- Fehlerformat konsistent halten.

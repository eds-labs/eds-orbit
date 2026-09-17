# Projektstruktur: Web Next.js + Custom Backend/Postgres

```txt
.
├── apps/
│   ├── web/
│   │   ├── src/app/
│   │   ├── src/components/
│   │   ├── src/features/
│   │   └── tests/
│   └── api/
│       ├── src/modules/
│       ├── src/shared/
│       ├── src/db/
│       └── tests/
├── packages/
│   ├── config/
│   ├── ui/
│   ├── schemas/
│   └── api-client/
├── infra/
├── docs/
└── .agentic/
```

## Codex-Regeln

- API-Vertrag in `packages/schemas` oder OpenAPI zuerst definieren.
- Keine direkte DB-Nutzung aus `apps/web`, außer bewusstes Fullstack-Pattern wurde gewählt.
- Auth/AuthZ zentral im API-Layer.
- API-Client generieren oder typisieren, keine duplizierten DTOs.

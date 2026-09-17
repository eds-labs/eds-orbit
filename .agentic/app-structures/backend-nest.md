# Projektstruktur: Backend NestJS + Postgres

```txt
.
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── config/
│   ├── common/
│   │   ├── guards/
│   │   ├── filters/
│   │   ├── pipes/
│   │   └── interceptors/
│   ├── database/
│   └── modules/
│       └── <module>/
│           ├── <module>.module.ts
│           ├── <module>.controller.ts
│           ├── <module>.service.ts
│           ├── dto/
│           ├── entities/
│           └── tests/
├── test/
└── .agentic/
```

## Codex-Regeln

- Module klar begrenzen.
- Guards für AuthZ statt verstreuter Checks.
- DTOs/Validation konsequent.
- Keine zirkulären Modulabhängigkeiten ohne explizite Begründung.

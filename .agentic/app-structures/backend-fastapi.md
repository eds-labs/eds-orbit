# Projektstruktur: Backend FastAPI + Postgres

```txt
.
├── app/
│   ├── main.py
│   ├── api/
│   │   └── v1/
│   ├── core/
│   ├── db/
│   ├── models/
│   ├── schemas/
│   ├── services/
│   └── repositories/
├── tests/
├── alembic/
├── pyproject.toml
└── .agentic/
```

## Codex-Regeln

- Pydantic-Schemas für Request/Response.
- SQLAlchemy/SQLModel-Modelle nicht mit API-Schemas vermischen.
- Dependencies für Auth, DB-Session und Settings zentral.
- pytest für neue Businesslogik.

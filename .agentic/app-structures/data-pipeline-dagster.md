# Projektstruktur: Dagster Data Pipeline

```txt
.
├── src/
│   └── project_name/
│       ├── definitions.py
│       ├── assets/
│       ├── resources/
│       ├── jobs/
│       ├── schedules/
│       ├── sensors/
│       └── checks/
├── tests/
├── data/
│   ├── raw/
│   ├── processed/
│   └── external/
└── .agentic/
```

## Codex-Regeln

- Assets statt lose Tasks modellieren.
- Jobs idempotent bauen.
- Datenqualität als Checks ausdrücken.
- Raw Data nie überschreiben.

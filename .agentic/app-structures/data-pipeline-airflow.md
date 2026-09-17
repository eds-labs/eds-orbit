# Projektstruktur: Apache Airflow

```txt
.
├── dags/
│   └── <domain>_dag.py
├── include/
│   ├── sql/
│   ├── scripts/
│   └── configs/
├── plugins/
├── tests/
└── .agentic/
```

## Codex-Regeln

- DAG Import muss schnell und side-effect frei bleiben.
- Tasks idempotent bauen.
- Retries und Timeouts explizit setzen.
- Secrets über Connections/Variables, nicht im Code.

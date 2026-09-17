# Projektstruktur: Python CLI + Typer

```txt
.
├── src/
│   └── project_name/
│       ├── __main__.py
│       ├── cli.py
│       ├── commands/
│       ├── services/
│       └── config.py
├── tests/
├── pyproject.toml
└── .agentic/
```

## Codex-Regeln

- CLI Commands dünn halten.
- Businesslogik testbar in Services.
- `typer.testing.CliRunner` für CLI Tests.

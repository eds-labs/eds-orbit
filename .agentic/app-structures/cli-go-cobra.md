# Projektstruktur: Go CLI + Cobra

```txt
.
├── cmd/
│   ├── root.go
│   └── <command>.go
├── internal/
│   ├── config/
│   ├── service/
│   └── output/
├── pkg/
├── testdata/
├── main.go
└── .agentic/
```

## Codex-Regeln

- CLI Parsing in `cmd/`, Businesslogik in `internal/`.
- Exit Codes bewusst setzen.
- JSON-Ausgabe für Automation optional vorsehen.

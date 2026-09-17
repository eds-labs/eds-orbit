# Projektstruktur: Rust CLI + clap

```txt
.
├── src/
│   ├── main.rs
│   ├── cli.rs
│   ├── commands/
│   ├── config.rs
│   └── output.rs
├── tests/
├── testdata/
├── Cargo.toml
└── .agentic/
```

## Codex-Regeln

- Argumente in `cli.rs` definieren.
- Fehler mit `thiserror`/`anyhow` bewusst wählen.
- Snapshot/Golden Tests für CLI Output, wenn stabil.

# Projektstruktur: Desktop Tauri + React

```txt
.
├── src/
│   ├── app/
│   ├── components/
│   ├── features/
│   └── lib/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands/
│   │   └── services/
│   ├── capabilities/
│   └── tauri.conf.json
├── tests/
└── .agentic/
```

## Codex-Regeln

- Tauri Commands schmal halten.
- Rust für Systemintegration, Frontend für UI.
- Capabilities/Permissions restriktiv halten.
- Keine Shell-Ausführung ohne harte Validierung.

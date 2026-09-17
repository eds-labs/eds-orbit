# Projektstruktur: Desktop Electron + React

```txt
.
├── electron/
│   ├── main/
│   ├── preload/
│   └── ipc/
├── src/
│   ├── renderer/
│   ├── components/
│   ├── features/
│   └── lib/
├── tests/
└── .agentic/
```

## Codex-Regeln

- Context Isolation aktiv lassen.
- IPC APIs explizit und minimal.
- Nie Node APIs direkt im Renderer freigeben.
- Auto-Update/Signing getrennt behandeln.

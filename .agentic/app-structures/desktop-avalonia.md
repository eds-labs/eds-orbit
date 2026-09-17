# Projektstruktur: Avalonia Desktop

```txt
.
├── src/
│   ├── App.axaml
│   ├── MainWindow.axaml
│   ├── Features/
│   │   └── <Feature>/
│   │       ├── Views/
│   │       ├── ViewModels/
│   │       └── Services/
│   ├── Core/
│   └── Infrastructure/
├── tests/
└── .agentic/
```

## Codex-Regeln

- MVVM verwenden.
- UI und Businesslogik trennen.
- Cross-platform File/System APIs abstrahieren.

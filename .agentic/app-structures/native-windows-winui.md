# Projektstruktur: Native Windows WinUI 3

```txt
.
├── src/
│   ├── App.xaml
│   ├── MainWindow.xaml
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

- MVVM konsequent verwenden.
- UI-Thread und async Operations sauber trennen.
- Windows App SDK APIs kapseln.

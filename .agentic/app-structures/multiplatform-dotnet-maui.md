# Projektstruktur: .NET MAUI

```txt
.
├── src/
│   ├── App.xaml
│   ├── MauiProgram.cs
│   ├── Features/
│   │   └── <Feature>/
│   │       ├── Views/
│   │       ├── ViewModels/
│   │       └── Services/
│   ├── Core/
│   └── Platforms/
├── tests/
└── .agentic/
```

## Codex-Regeln

- MVVM-Struktur einhalten.
- Plattformcode in `Platforms/` kapseln.
- Services über DI registrieren.

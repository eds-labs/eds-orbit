# Projektstruktur: Flutter

```txt
.
├── lib/
│   ├── main.dart
│   ├── app/
│   ├── core/
│   ├── features/
│   │   └── <feature>/
│   │       ├── data/
│   │       ├── domain/
│   │       └── presentation/
│   └── shared/
├── test/
├── integration_test/
├── assets/
└── .agentic/
```

## Codex-Regeln

- Feature-first Struktur.
- UI, Domain und Data Layer trennen.
- Platform Channels nur bei Bedarf.
- `flutter analyze` und Tests vor Abschluss.

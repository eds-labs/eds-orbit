# Projektstruktur: Native Android Kotlin + Compose

```txt
.
├── app/
│   └── src/main/java/<package>/
│       ├── MainActivity.kt
│       ├── core/
│       ├── feature/
│       │   └── <feature>/
│       │       ├── data/
│       │       ├── domain/
│       │       └── presentation/
│       ├── navigation/
│       └── ui/theme/
├── build.gradle.kts
└── .agentic/
```

## Codex-Regeln

- Composables möglichst stateless.
- State in ViewModels oder State Holdern.
- Repository für Datenzugriff.
- Preview/Accessibility mitdenken.

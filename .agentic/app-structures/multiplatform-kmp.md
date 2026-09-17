# Projektstruktur: Kotlin Multiplatform + Compose

```txt
.
├── composeApp/
│   ├── src/
│   │   ├── commonMain/
│   │   ├── androidMain/
│   │   ├── iosMain/
│   │   └── desktopMain/
├── shared/
│   ├── src/commonMain/
│   ├── src/androidMain/
│   └── src/iosMain/
├── iosApp/
├── build.gradle.kts
└── .agentic/
```

## Codex-Regeln

- Businesslogik zuerst in `commonMain`.
- Platform-spezifische APIs über expect/actual kapseln.
- UI-Sharing bewusst entscheiden: komplett, teilweise oder native UI.

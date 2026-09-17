# Projektstruktur: Mobile Expo / React Native

```txt
.
├── app/
│   ├── (auth)/
│   ├── (tabs)/
│   └── _layout.tsx
├── src/
│   ├── components/
│   ├── features/
│   │   └── <feature>/
│   │       ├── screens/
│   │       ├── components/
│   │       ├── hooks/
│   │       ├── api/
│   │       └── tests/
│   ├── lib/
│   ├── navigation/
│   ├── state/
│   └── theme/
├── assets/
├── tests/
└── .agentic/
```

## Codex-Regeln

- Jede Screen-Logik in Feature-Ordnern.
- Device APIs kapseln.
- Offline/Netzwerkfehler immer behandeln.
- Keine Secrets in App-Bundle.

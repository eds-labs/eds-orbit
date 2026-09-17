# Projektstruktur: Native Apple SwiftUI

```txt
.
├── App/
│   ├── MainApp.swift
│   ├── AppState.swift
│   └── Dependencies.swift
├── Features/
│   └── <Feature>/
│       ├── Views/
│       ├── ViewModels/
│       ├── Models/
│       └── Services/
├── Shared/
├── Resources/
├── Tests/
└── .agentic/
```

## Codex-Regeln

- SwiftUI Views klein halten.
- Side Effects in Services/ViewModels.
- MainActor-Grenzen bewusst setzen.
- Accessibility Labels bei interaktiven Controls.

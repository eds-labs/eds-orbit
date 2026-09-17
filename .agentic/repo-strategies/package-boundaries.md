# Package Boundaries

## Regeln

- `ui` enthält keine Business-Logik.
- `schemas` enthält keine DB-Zugriffe.
- `db` enthält keine UI-Imports.
- `api-client` hängt nicht von Server Runtime ab.
- `config` darf keine Secrets exportieren, die im Client landen.

## Codex-Regel

Bei neuen Packages Zweck und erlaubte Abhängigkeiten dokumentieren.

# Dependency Policy

## Neue Dependencies nur wenn

- bestehende Mittel nicht ausreichen
- Nutzen klar ist
- Library gepflegt wirkt
- Lizenz kompatibel ist
- Security-Risiko akzeptabel ist
- Bundle/Runtime-Kosten akzeptabel sind

## Vermeiden

- zweite UI-Library
- zweite State-Management-Library
- zweite Validation-Library
- große Utility-Libraries für kleine Funktionen
- unmaintained Packages

## Codex-Regel

Vor neuer Dependency:

```md
Dependency:
Purpose:
Alternatives considered:
Maintenance/Security:
Bundle/Runtime impact:
```

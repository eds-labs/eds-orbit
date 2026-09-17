# Test Strategy

## Testpyramide

- viele Unit Tests für reine Logik
- gezielte Integration Tests für DB/API/Auth
- wenige, aber wertvolle E2E Tests für kritische Flows
- Contract Tests für API-Grenzen
- Security Negativtests für High-Risk-Flows

## Codex-Regel

Jede Änderung braucht eine Testentscheidung:

```md
Tests added:
Tests run:
Tests not run and why:
Risk not covered:
```

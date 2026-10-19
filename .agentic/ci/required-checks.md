# Required Checks

EDS Orbit uses direct commits and pushes to `main` by Mario's instruction of 2026-10-19. These are local validation requirements; GitHub CI remains background feedback and is not a required merge or push gate.

## Lokale Mindestprüfungen vor direktem Push auf main

- Lint
- Typecheck/Compile
- Unit Tests
- Build

## Je nach Änderung zusätzlich

- DB Migration Test
- Integration Tests
- E2E Smoke Tests
- API Contract Tests
- Security Tests
- Visual Regression Tests
- Mobile Build
- Desktop Packaging

## High/Critical Risk

Bei High/Critical Risk darf Codex nicht nur sagen "sieht gut aus". Es muss konkrete Checks nennen, die gelaufen sind oder noch laufen müssen.

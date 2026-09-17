# Monorepo CI Policy

## Ziele

- nur betroffene Apps/Packages testen, wenn möglich
- shared packages bei Änderungen vollständig prüfen
- API Contracts zwischen Apps sichern
- Build-Reihenfolge beachten

## Typische Checks

- workspace install
- affected lint
- affected test
- affected build
- package boundary checks
- generated clients/schemas up to date

## Codex-Regel

Bei Monorepo-Änderungen immer angeben, welche Apps und Packages betroffen sind.

# GitHub Actions Policy

## Standard Checks

- install
- lint
- typecheck
- unit tests
- integration tests, wenn vorhanden
- build
- dependency/security scan, wenn passend

## Regeln

- CI nutzt keine echten Production-Secrets außer für explizite Deploy-Jobs.
- Pull Requests sollen keine Production-Deploys auslösen.
- Caches dürfen keine Secrets enthalten.
- Branch Protection sollte required checks erzwingen.

## Codex-Regel

Wenn neue Commands in `package.json`, `pyproject.toml`, `go.mod` etc. entstehen, CI-Dokumentation prüfen.

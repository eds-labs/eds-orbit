# Release Pipeline

## Standard Release Steps

1. Changelog/Release Notes
2. Relevante lokale Checks erfolgreich; GitHub CI läuft nach dem direkten Push auf `main` im Hintergrund (Mario, 2026-10-19)
3. Migrationen prüfen
4. Staging Smoke Test
5. Production Deploy
6. Post-Deploy Checks
7. Monitoring beobachten
8. Rollback-Fenster definieren

## Release Notes enthalten

- Features
- Fixes
- Breaking Changes
- Migration Notes
- Known Risks

## Codex-Regel

Bei Release-Aufgaben immer Deployment Notes und Rollback notieren.

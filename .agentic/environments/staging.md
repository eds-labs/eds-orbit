# Environment: Staging

## Ziel

Production-ähnliche Prüfung vor Release.

## Regeln

- Migrationen wie in Production ausführen.
- Feature Flags vorab testen.
- Externe Provider möglichst im Sandbox-Modus verwenden.
- Monitoring und Logs prüfen.
- Staging darf keine echten Kundendaten enthalten, außer dies ist bewusst erlaubt und abgesichert.

## Pflicht vor Release

- Smoke Tests
- Auth/Roles-Check
- Datenbankmigration geprüft
- Rollback-Plan formuliert
- relevante Alerts bekannt

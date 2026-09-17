# Rollback Policy

## Code vs Daten

Code-Rollbacks sind oft einfach. Datenbank-Rollbacks sind oft nicht einfach.

## Strategien

- Feature Flag deaktivieren
- Code zurückrollen
- Forward-Fix Migration
- Kompatibilitätsphase verlängern
- Read-Path auf alte Struktur zurücksetzen
- Daten aus Backup wiederherstellen, nur wenn bewusst entschieden

## Verbotene Annahmen

- `down` Migration ist automatisch sicher
- Backup-Restore ist schnell
- gelöschte Daten sind einfach wiederherstellbar
- Production-Datenstruktur entspricht lokalem Stand

## Required Output

Für High/Critical Changes:

```md
Rollback Type: code rollback | forward fix | feature flag | restore | not safely reversible
Expected Impact:
Data Loss Risk:
Manual Steps:
```

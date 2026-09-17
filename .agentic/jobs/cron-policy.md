# Cron Policy

## Regeln

- Cron Jobs müssen idempotent sein.
- Laufzeit und Überschneidungen beachten.
- Locking prüfen, wenn Job nicht parallel laufen darf.
- Logs und Alerts bei Fehlern.
- Zeitzone explizit definieren.

## Beispiele

- tägliche Reports
- Subscription Sync
- Cleanup abgelaufener Tokens
- Datenimport

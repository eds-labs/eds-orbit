# Environment: Production

## Grundsatz

Production ist kritisch. Codex darf keine destruktiven oder irreversiblen Aktionen ausführen, ohne dass der User dies explizit verlangt und die Konsequenzen klar sind.

## Verboten ohne explizite Freigabe

- Daten löschen
- Tabellen droppen
- irreversible Migrationen
- Secrets ändern oder anzeigen
- Production-DB direkt verändern
- Admin-/Auth-Regeln lockern
- Payment-/Billing-Logik deployen
- Tracking mit personenbezogenen Daten aktivieren

## Pflicht bei Production Changes

```md
## Production Change Plan
Ziel:
Risiko:
Betroffene Systeme:
Migrationsplan:
Backup:
Rollback:
Tests:
Monitoring:
Post-Deploy Checks:
Kommunikation:
```

## Minimum Checks

- CI grün
- Build reproduzierbar
- Migration rückwärtskompatibel oder Rollback definiert
- Secrets vorhanden, aber nicht offengelegt
- Logs/Alerts für kritische Pfade vorhanden
- Post-Deploy-Smoke-Test definiert

## Rollback

Jede Production-Änderung braucht eine Aussage zu:

- Code-Rollback
- Datenbank-Rollback oder Forward-Fix
- Feature-Flag-Deaktivierung
- Provider-Konfiguration
- Kommunikation an Nutzer oder Team

# Human Approval Policy

## Explizite Freigabe nötig

- Production-Migrationen
- Datenlöschung
- Secrets ändern/rotieren
- Auth/AuthZ-Änderungen
- Payment-/Billing-Änderungen
- Admin-Bypass
- neuer kostenpflichtiger Provider
- Tracking/Analytics mit personenbezogenen Daten
- rechtlich relevante Texte
- irreversible Operationen

## Approval Output

```md
Action requiring approval:
Reason:
Impact:
Rollback:
Exact command/change:
```

Codex darf die Aktion erst ausführen, wenn der User klar zustimmt.

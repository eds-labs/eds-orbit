# Release Risk Checklist

## Fragen

- Enthält der Release DB-Migrationen?
- Ändert der Release Auth/Rollen?
- Ändert der Release API Contracts?
- Betrifft der Release Payment/Billing?
- Betrifft der Release Userdaten?
- Gibt es Feature Flags?
- Gibt es Rollback?
- Gibt es Post-Deploy Checks?

Wenn zwei oder mehr High-Risk-Bereiche betroffen sind, Release aufteilen oder besonders prüfen.

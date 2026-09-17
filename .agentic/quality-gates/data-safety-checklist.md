# Data Safety Checklist

## Vor Datenänderungen

- [ ] Datenklasse bekannt
- [ ] Betroffene Tabellen/Collections bekannt
- [ ] Backup-Status bekannt
- [ ] Query/Script auf Testdaten geprüft
- [ ] Dry Run möglich?
- [ ] Rollback/Forward-Fix bekannt
- [ ] Audit/Logging geprüft
- [ ] Tenant/User-Scope korrekt

## Nie ohne Freigabe

- Production-Daten löschen
- irreversible Transformation
- globale Updates ohne WHERE/Scope
- personenbezogene Daten exportieren

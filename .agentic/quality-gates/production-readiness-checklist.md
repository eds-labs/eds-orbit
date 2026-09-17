# Production Readiness Checklist

## Code

- [ ] CI grün
- [ ] Build erfolgreich
- [ ] relevante Tests vorhanden
- [ ] keine Debug-Logs
- [ ] keine Secrets im Code

## Security

- [ ] Auth/AuthZ geprüft
- [ ] Rollen/Tenant-Isolation geprüft
- [ ] Input Validation
- [ ] Rate Limits bei sensiblen Endpunkten
- [ ] Security Negativtests bei High Risk

## Database

- [ ] Migration versioniert
- [ ] Backward Compatibility geprüft
- [ ] Backup/Rollback bekannt
- [ ] RLS/Permissions geprüft
- [ ] Indexbedarf geprüft

## Operations

- [ ] Env Vars gesetzt
- [ ] Logs/Errors sichtbar
- [ ] Alerts bei kritischen Flows
- [ ] Post-Deploy Smoke Test
- [ ] Rollback Plan

## Compliance

- [ ] Userdaten geprüft
- [ ] Tracking/Consent geprüft
- [ ] Audit Logs, falls nötig
- [ ] Data Retention geprüft

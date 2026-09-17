# Workflow: Migration

## Typen

- Datenbank-Schema
- Datenmigration
- Framework-/Runtime-Upgrade
- Infra-/Deployment-Migration

## Schritte

1. Ist die Migration rückwärtskompatibel?
2. Muss Code vor Schema oder Schema vor Code deployt werden?
3. Gibt es Datenverlust-Risiko?
4. Braucht es Backfill?
5. Gibt es Rollback?
6. Sind Migrations bereits deployed und daher unveränderlich?
7. Welche Tests/Smoke Tests sichern den Rollout?

## Output

- Migrationsplan
- Rollout-Reihenfolge
- Rollback-/Recovery-Plan
- Risiken
- Verifikation

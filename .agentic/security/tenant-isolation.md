# Tenant Isolation

## Grundsatz

Multi-Tenant-Isolation ist eine Security Boundary.

## Pflichtregeln

- Tenant ID nie nur aus dem Client übernehmen.
- Datenzugriff serverseitig tenant-scoped filtern.
- Neue Tabellen mit Tenant-Bezug brauchen Tenant-Spalte oder klare Begründung.
- Background Jobs müssen tenant-aware sein.
- Admin- und Supportzugriffe müssen auditiert werden.

## Tests

Mindestens ein Negativtest:

- Tenant A darf Ressource von Tenant B nicht lesen.
- Tenant A darf Tenant ID beim Insert/Update nicht fälschen.
- API gibt nicht über Fehlermeldungen fremde Ressourcen preis.

## Häufige Fehler

- UI filtert korrekt, API aber nicht
- Query nach `id` ohne `tenant_id`
- Background Job verarbeitet globale IDs ohne Tenant-Kontext
- Search/Export ignoriert Tenant-Grenzen

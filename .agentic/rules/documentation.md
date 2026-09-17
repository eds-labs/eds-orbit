# Documentation Rules

## Dokumentieren, wenn sich ändert

- öffentliche APIs
- Environment Variables
- Setup-/Run-Commands
- Architekturentscheidungen
- Migrations-/Rollback-Verfahren
- Security-relevante Annahmen
- User-visible Verhalten

## ADRs

Nutze `.agentic/templates/adr.md`, wenn:

- eine Architekturentscheidung schwer rückgängig ist,
- eine neue Dependency zentral wird,
- eine API dauerhaft verändert wird,
- eine wichtige Trade-off-Entscheidung getroffen wurde.

## Stil

- Kurz, konkret, auffindbar.
- Beispiele statt abstrakter Regeln, wenn möglich.
- Dokumentation im gleichen PR wie die Verhaltensänderung aktualisieren.

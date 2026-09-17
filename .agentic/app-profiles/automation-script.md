# App Profile: Automation Script

## Prioritäten

- sichere Defaults
- Dry Run
- Idempotenz
- klare Logs
- keine stillen Datenverluste
- einfache Installation

## Immer prüfen

- Hat das Skript Seiteneffekte?
- Gibt es `--dry-run`?
- Gibt es Bestätigung für destruktive Aktionen?
- Sind Pfade und Inputs validiert?
- Können Teilschritte wiederholt werden?

## Tests

- Unit-Tests für Parsing/Transformation.
- Integration mit temporären Dateien/Fakes.
- Negativtests für ungültige Inputs.

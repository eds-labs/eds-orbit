# App Profile: Data Pipeline

## Prioritäten

- Datenqualität
- Idempotenz
- Wiederholbarkeit
- Observability
- Backfills
- Schema-Evolution
- Kosten und Laufzeit

## Immer prüfen

- Was ist die Quelle?
- Was ist das Ziel?
- Was ist der Primary Key?
- Ist der Job idempotent?
- Was passiert bei Teilfehlern?
- Gibt es Dead Letter Handling?
- Gibt es Datenqualitätschecks?
- Wie werden Backfills durchgeführt?

## Tests

- kleine Fixture-basierte Pipeline-Tests.
- Schema-/Contract-Tests.
- Tests für Duplikate und Teilfehler.

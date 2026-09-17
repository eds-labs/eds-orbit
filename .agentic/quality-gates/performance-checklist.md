# Performance Checklist

- Gibt es N+1 Queries?
- Gibt es unbounded Listen, Loops oder Loads?
- Werden große Datenmengen paginiert/gestreamt?
- Sind relevante DB-Indexe vorhanden?
- Ist Caching sinnvoll und korrekt invalidiert?
- Wird Client-Bundle unnötig größer?
- Gibt es unnötige Re-Renders?
- Gibt es Metriken oder Benchmarks?

# Postgres Indexing Policy

## Wann Index prüfen?

- neue Foreign Keys
- häufige Filterspalten
- Sortierung/Pagination
- einzigartige Constraints
- Full-Text-Suche
- Tenant-Scoped Queries
- Background Jobs mit Batch Processing

## Regeln

- Indexe passend zur Query hinzufügen, nicht blind.
- Composite Index Reihenfolge beachten.
- Unique Constraints für fachliche Eindeutigkeit bevorzugen.
- Große Production-Indexe können Locks/Last verursachen.
- Explain/Analyze nutzen, wenn Performance kritisch ist.

## Codex-Regel

Wenn neue Queries auf großen Tabellen entstehen, muss Codex Indexbedarf ansprechen.

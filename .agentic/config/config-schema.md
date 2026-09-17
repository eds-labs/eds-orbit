# Config Schema Policy

## Ziel

Konfiguration soll früh und verständlich fehlschlagen, statt später mit unklaren Runtime-Fehlern.

## Empfehlungen

- TypeScript: Zod/Valibot/typisierte Config
- Python: Pydantic Settings oder vergleichbar
- Go: explizite Config Structs und Validation
- Rust: serde + Validierung

## Pflichtfelder

Für jede neue Konfiguration:

- Name
- Beschreibung
- Umgebung: local/preview/staging/production
- Sichtbarkeit: client/server
- Pflicht oder optional
- Default-Wert, falls sicher
- Beispielwert ohne Secret

## Codex-Regel

Wenn ein neues Config-Feld hinzukommt, aktualisiere:

- `.env.example`
- Config-Validation
- README oder Setup-Doku
- Tests für fehlende/ungültige Config, wenn kritisch

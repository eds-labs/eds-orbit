# Data Classification

## Klassen

- Public: öffentlich unkritisch
- Internal: interne Projektdaten
- Confidential: Kundendaten, Geschäftslogik, interne Metriken
- Restricted: Secrets, Tokens, Zahlungsdaten, sensible personenbezogene Daten

## Regeln

- Restricted niemals in Logs oder Prompts ohne Schutz.
- Confidential nur mit Zweck verarbeiten.
- Public-Beispiele dürfen keine echten Personen imitieren.
- Datenklasse bei neuen Tabellen/Events/Exports notieren.

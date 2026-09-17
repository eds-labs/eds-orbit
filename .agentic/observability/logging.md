# Logging Policy

## Ziele

- Fehler nachvollziehen
- Missbrauch erkennen
- Betrieb absichern
- Datenschutz respektieren

## Niemals loggen

- Passwörter
- vollständige Tokens
- API Keys
- Kreditkarten-/Zahlungsdaten
- sensible personenbezogene Daten ohne Zweck
- vollständige Prompts mit sensiblen Daten

## Immer hilfreich

- Request ID / Correlation ID
- User/Tenant ID nur wenn datenschutzkonform
- Event-Typ
- Fehlerklasse
- externe Provider-Response grob, nicht secret-haltig

## Codex-Regel

Bei neuer kritischer Logik prüfen, ob Logs für Fehlersuche vorhanden sind und keine Secrets enthalten.

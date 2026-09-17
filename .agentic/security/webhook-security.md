# Webhook Security

## Pflicht

- Signatur validieren
- Timestamp/Replay prüfen, wenn Provider unterstützt
- Idempotency Key oder Event ID speichern
- Rohbody erhalten, wenn Signatur das verlangt
- Fehler sicher behandeln
- unbekannte Events nicht crashen lassen

## Nicht tun

- Webhook ohne Signatur akzeptieren
- Event-Daten blind vertrauen
- Payment-Status nur aus Frontend setzen
- doppelte Events mehrfach abrechnen

## Tests

- gültiges Event
- ungültige Signatur
- doppeltes Event
- unbekannter Event-Typ
- Provider Retry

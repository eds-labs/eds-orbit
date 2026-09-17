# AI Tool Policy

## Tool-Risiko

Low:
- read-only Suche
- formatieren
- lokale Analyse

Medium:
- Datei schreiben
- Draft erstellen
- API Call ohne Nebenwirkung

High:
- E-Mail senden
- externe Systeme verändern
- Datenbank schreiben
- Kosten verursachen

Critical:
- Daten löschen
- Production ändern
- Payment auslösen
- Secrets ändern

## Regeln

- Tool-Schemas strikt validieren.
- Destruktive Tools brauchen Human Approval.
- Tool-Ausführung loggen.
- Least Privilege.

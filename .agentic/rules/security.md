# Security Rules

## Sensible Bereiche

Besondere Vorsicht bei:

- Authentifizierung und Autorisierung
- Rollen, Tenants, Admin-Funktionen
- Zahlungslogik und Abos
- Datei-Uploads
- Webhooks und Signaturen
- User-generated Content
- Datenbank-Migrationen
- Secrets und Environment Variables
- Agenten-Tools und externe Writes

## Niemals

- Secrets in Code, Logs, Testsnapshots oder Antworten ausgeben.
- Auth-Checks entfernen, ohne Ersatz und explizite Aufgabe.
- SQL per String-Konkatenation mit User Input bauen.
- Ungeprüfte User-Eingaben in Shell-Kommandos verwenden.
- Produktionsdaten löschen oder verändern.
- Externe Tool-Aktionen ohne Freigabepfad automatisieren, wenn sie destruktiv sind.

## Pflicht bei Security-relevanten Änderungen

- Kurz Bedrohungsmodell notieren.
- Negativtests ergänzen.
- Fehlerfälle so gestalten, dass keine sensiblen Details leaken.
- Rate Limits/Idempotenz prüfen, wenn relevant.
- Security-Review aus `.agentic/quality-gates/security-checklist.md` anwenden.

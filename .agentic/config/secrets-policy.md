# Secrets Policy

## Niemals

- Secrets in Code schreiben
- Secrets in Tests hardcoden
- Secrets in Logs ausgeben
- `.env` Dateien committen
- echte API Keys in Beispielen verwenden
- Service Role Keys im Client verwenden
- Tokens vollständig in Fehlermeldungen anzeigen

## Immer

- `.env.example` pflegen
- Secrets pro Umgebung trennen
- Secret Rotation ermöglichen
- minimale Berechtigungen verwenden
- Secrets in CI/CD über Secret Store setzen
- Logs redigieren

## Review-Fragen

- Ist das Secret wirklich serverseitig?
- Braucht die Integration Schreibrechte?
- Gibt es einen Sandbox-Key?
- Ist Rotation dokumentiert?
- Welche Systeme erhalten Zugriff?

## Beispiel für Platzhalter

```env
SUPABASE_URL="https://example.supabase.co"
SUPABASE_ANON_KEY="replace-with-public-anon-key"
SUPABASE_SERVICE_ROLE_KEY="server-only-do-not-expose"
```

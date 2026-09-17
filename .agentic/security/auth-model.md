# Auth Model

## AuthN vs AuthZ

- AuthN: Wer ist der Nutzer?
- AuthZ: Was darf dieser Nutzer tun?

Codex darf Login-Erfolg nie mit Berechtigung gleichsetzen.

## Pflicht bei Auth-Features

- Session-Lifecycle
- Passwort-/Token-Handling
- Magic Link / OAuth / MFA Risiken
- Logout und Token-Invalidierung
- Server-side Checks
- sichere Redirects
- Rate Limits bei sensiblen Endpunkten

## Verboten

- Berechtigung nur im Frontend prüfen
- User-ID aus Request Body vertrauen
- unsignierte Tokens akzeptieren
- Redirect URLs unvalidiert übernehmen
- Auth Errors mit zu viel Detail zurückgeben

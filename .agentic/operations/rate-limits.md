# Rate Limits

## Wann nötig?

- Login
- Passwortreset
- Magic Links
- Public APIs
- AI Requests
- File Uploads
- Webhooks, falls Provider-Missbrauch möglich
- teure Such-/Export-Endpunkte

## Regeln

- Limit pro User/IP/Tenant passend wählen
- Fehlermeldung nutzbar, aber nicht ausnutzbar
- Admin-/Systempfade bewusst behandeln
- Tests für Limit-Verhalten, wenn kritisch

# Lightweight Threat Model

Nutze dieses Modell für High- oder Critical-Risk-Änderungen.

## Assets

- Welche Daten/Systeme sind schützenswert?
- Welche Secrets sind beteiligt?
- Welche Nutzerrollen sind beteiligt?

## Entry Points

- API-Endpunkte
- Forms
- Webhooks
- File Uploads
- Background Jobs
- Admin Tools
- AI Tools

## Abuse Cases

- fremde Daten lesen
- fremde Daten ändern
- Rechte ausweiten
- Kosten verursachen
- Daten exfiltrieren
- System überlasten
- Audit umgehen

## Controls

- AuthN/AuthZ
- Validation
- Rate Limits
- Signaturen
- RLS
- Logging/Audit
- Human Approval

## Output

```md
Threats:
Controls:
Missing Tests:
Residual Risk:
```

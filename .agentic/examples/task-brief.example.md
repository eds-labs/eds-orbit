# Task Brief — Beispiel

## Ziel

Passwort-Reset für eingeloggte und ausgeloggte Nutzer ermöglichen.

## Kontext

User sollen sicher ein neues Passwort setzen können, ohne dass preisgegeben wird, ob eine E-Mail existiert.

## Anwendungstyp

`fullstack-saas`

## Workflow

`feature`

## Akzeptanzkriterien

- [ ] User kann Reset-Link anfordern.
- [ ] Antwort verrät nicht, ob E-Mail existiert.
- [ ] Token läuft nach 30 Minuten ab.
- [ ] Token ist nur einmal nutzbar.
- [ ] Erfolgs- und Missbrauchsfälle sind getestet.

## Nicht-Ziele

- Kein Redesign der Login-Seite.
- Kein Wechsel des Auth-Providers.

## Risiken

- Account Enumeration
- Token Leakage
- Rate Limiting
- E-Mail-Zustellbarkeit

## Erwartete Verifikation

- Unit-Tests für Token-Logik.
- Integrationstests für Request/Consume Flow.
- Negativtests für ungültiges/abgelaufenes Token.

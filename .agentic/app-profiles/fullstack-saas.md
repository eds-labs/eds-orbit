# App Profile: Fullstack SaaS

## Prioritäten

- End-to-End User Flow
- Mandantenfähigkeit
- Billing/Subscription-Grenzen
- Rollen und Berechtigungen
- Datenisolierung
- Admin-Funktionen
- Onboarding

## Immer prüfen

- Darf dieser User diese Daten sehen?
- Gehört die Ressource zum richtigen Tenant?
- Gibt es Race Conditions?
- Sind Trial/Plan-Limits korrekt?
- Was passiert bei fehlgeschlagener Zahlung?
- Gibt es sichere Defaults für neue Rollen/Pläne?

## Tests

- E2E für kritische Flows.
- Integrationstests für Tenant-Isolation.
- Negativtests für Rollen/Berechtigungen.

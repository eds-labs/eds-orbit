# Risk Classification

Nutze diese Klassifikation vor jeder Aufgabe. Ziel ist nicht Bürokratie, sondern ein verlässlicher Arbeitsmodus für Codex.

## Low Risk

Typische Beispiele:

- reine Dokumentation
- Textänderungen
- kleine UI-Korrekturen ohne Datenfluss
- Tests ergänzen ohne Produktivcode zu verändern
- Formatierung

Arbeitsmodus:

- kurze Analyse reicht
- kleine Änderung direkt möglich
- am Ende relevante Checks nennen

## Medium Risk

Typische Beispiele:

- Business-Logik
- neue API-Route ohne sensible Daten
- neue Dependency
- nicht-kritische Datenmodelländerung ohne Produktionsdaten
- neue UI mit Formularvalidierung
- neue Background-Job-Logik ohne Payment/Auth

Arbeitsmodus:

- kurzer Plan
- betroffene Tests definieren
- Review-Checklist nutzen
- keine neue Dependency ohne Begründung

## High Risk

Typische Beispiele:

- Authentifizierung oder Autorisierung
- Rollen-/Rechte-Logik
- Multi-Tenant-Datenzugriff
- Datenbankmigrationen mit bestehenden Daten
- File Uploads
- Webhooks
- Background Jobs mit Nebenwirkungen
- externe Provider mit Kosten oder Datenweitergabe
- personenbezogene Daten
- Payment-, Billing- oder Subscription-Logik

Arbeitsmodus:

- Plan vor Implementierung
- Security- und Data-Safety-Check
- Negativtests definieren
- Rollback beschreiben
- Human Approval prüfen

## Critical Risk

Typische Beispiele:

- irreversible Datenlöschung
- Production-Secrets
- Produktionsdatenbankänderung
- Security Boundary ändern
- Admin-/Support-Bypass
- Zahlungsabrechnung oder Rechnungserstellung
- Änderung an Audit Logs
- rechtlich relevante Datenverarbeitung
- Deployment-Konfiguration für Production

Arbeitsmodus:

- keine direkte Ausführung ohne explizite Freigabe
- schriftlicher Change Plan
- Backup-/Rollback-Plan
- Monitoring-/Alerting-Plan
- Tests und Post-Deploy-Checks
- Human-in-the-loop zwingend

## Risk Escalation Rules

Wenn eine Aufgabe mehrere Bereiche berührt, gilt der höchste Risiko-Level.

Eine Low- oder Medium-Aufgabe wird High, sobald einer dieser Punkte zutrifft:

- Userdaten werden gelesen, geschrieben oder gelöscht
- Rechte oder Tenants sind betroffen
- Production ist betroffen
- Secrets sind betroffen
- externe Provider erhalten Daten
- Migrationen oder Backfills sind nötig
- Kosten können unkontrolliert steigen

## Output für riskante Aufgaben

```md
Risk Level: high|critical
Reason: ...
Required Policies: ...
Approval Needed: yes|no
Rollback Strategy: ...
Test Strategy: ...
```

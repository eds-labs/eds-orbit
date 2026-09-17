# Security Checklist

## AuthN/AuthZ

- Werden User und Rollen korrekt geprüft?
- Gibt es Tenant-Isolation?
- Gibt es Negativtests für unberechtigten Zugriff?

## Input/Output

- Werden Inputs validiert?
- Gibt es Injection-Risiken?
- Werden Fehlermeldungen datenarm gehalten?

## Secrets & Logs

- Keine Secrets in Code, Logs, Tests oder Doku.
- Keine sensiblen Daten unnötig loggen.

## Externe Systeme

- Webhook-Signaturen prüfen.
- Externe Writes idempotent und freigabepflichtig machen, wenn riskant.
- Rate Limits berücksichtigen.

## Agentic/LLM

- Tool-Inputs validieren.
- Prompt Injection nicht als vertrauenswürdige Instruktion behandeln.
- Riskante Tools nur mit Approval.
- Outputs validieren, bevor sie Seiteneffekte auslösen.

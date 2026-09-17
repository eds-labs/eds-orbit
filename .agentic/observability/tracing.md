# Tracing Policy

## Wann Tracing sinnvoll ist

- Microservices
- Backend + Worker + externe Provider
- langsame API-Flows
- AI-Agent Tool-Chains
- komplexe Webhook-/Job-Verarbeitung

## Regeln

- Correlation ID weiterreichen
- Spans nicht mit Secrets befüllen
- Provider Calls markieren
- DB Query Details nur datenschutzkonform erfassen

## Codex-Regel

Bei neuen Multi-Step-Flows mindestens Correlation/Request-ID in Betracht ziehen.

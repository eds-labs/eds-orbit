# App Profile: AI Agent App

## Prioritäten

- Tool-Sicherheit
- Prompt-Injection-Schutz
- saubere Tool-Schemas
- Observability/Tracing
- Kostenkontrolle
- Evaluationen
- Human Approval für riskante Aktionen

## Immer prüfen

- Welche Tools darf der Agent nutzen?
- Welche Aktionen brauchen Freigabe?
- Welche Daten dürfen in den Prompt?
- Wie wird Tool-Input validiert?
- Wie wird Output validiert?
- Gibt es Guardrails?
- Gibt es Evals für typische Fälle?
- Wie wird Fehlverhalten geloggt?

## Tests

- Unit-Tests für Tool-Funktionen.
- Simulationen für Agent-Flows.
- Eval-Sets für typische Aufgaben.
- Negativtests für Prompt Injection und Tool-Missbrauch.

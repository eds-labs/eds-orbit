# Operational Decision Tree

## 1. Was wird geändert?

- Nur Code? Prüfe Workflow und Tests.
- Datenbank? Prüfe `.agentic/database/`.
- Secrets oder Env Vars? Prüfe `.agentic/config/`.
- Auth oder Rollen? Prüfe `.agentic/security/`.
- Deployment? Prüfe `.agentic/deployment-presets/` und `.agentic/environments/`.
- API-Vertrag? Prüfe `.agentic/contracts/`.
- Userdaten oder Tracking? Prüfe `.agentic/compliance/`.
- Background Jobs? Prüfe `.agentic/jobs/`.
- AI-Agent-Tools? Prüfe `.agentic/ai/`.

## 2. Welche Umgebung?

- local: schnelle Iteration erlaubt
- preview: prüfe Seed/Testdaten und Feature Flags
- staging: production-ähnliche Checks
- production: keine destruktive Aktion ohne Freigabe

## 3. Welcher Abschluss ist nötig?

- Low: Summary + Checks
- Medium: Plan + Tests + Review Notes
- High: Security/Data/Deployment Notes + Rollback
- Critical: Human Approval + Change Plan + Post-Deploy Checks

# Audit Log Policy

## Wann Audit Logs?

- Admin-Aktionen
- Support-Zugriffe
- Rollen-/Rechteänderungen
- Billing-Änderungen
- Datenexporte
- kritische Datenlöschungen
- AI-Agent-Tools mit Nebenwirkungen

## Audit Event Felder

- actor_id
- actor_role
- tenant_id, falls relevant
- action
- target_type
- target_id
- timestamp
- result
- request_id

## Regeln

- Audit Logs sind manipulationssensibel.
- Keine Secrets in Audit Logs.
- Zugriff auf Audit Logs beschränken.

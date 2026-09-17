# Error Handling Policy

## Grundsatz

User bekommen verständliche, sichere Fehlermeldungen. Intern muss der Fehler nachvollziehbar sein.

## Regeln

- Externe Fehler nicht roh an User weitergeben.
- Stacktraces nicht in Production Response.
- Validation Errors klar und nutzbar.
- Auth Errors nicht zu detailliert.
- Retry nur bei sicheren/idempotenten Aktionen.
- Timeouts definieren.

## Error-Kategorien

- ValidationError
- AuthenticationError
- AuthorizationError
- NotFoundError
- ConflictError
- RateLimitError
- ExternalServiceError
- InternalError

## Tests

- invalid input
- fehlende Auth
- fehlende Berechtigung
- externer Provider down
- Timeout

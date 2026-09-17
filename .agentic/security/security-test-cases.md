# Security Test Cases

## Auth/AuthZ

- unauthenticated request is rejected
- authenticated user cannot access another user's resource
- tenant A cannot access tenant B resource
- non-admin cannot call admin endpoint
- expired token is rejected

## Input Validation

- invalid payload rejected
- unexpected fields ignored or rejected
- SQL/command injection payload harmless
- oversized payload rejected

## Webhooks

- missing signature rejected
- invalid signature rejected
- replay/idempotency handled
- unknown event ignored safely

## File Upload

- unsupported type rejected
- oversized file rejected
- filename cannot escape path
- uploaded file not executed

## AI Tools

- prompt injection cannot trigger unauthorized tool
- tool input schema validates
- destructive tool requires approval

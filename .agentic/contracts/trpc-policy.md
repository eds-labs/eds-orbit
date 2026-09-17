# tRPC Policy

## Geeignet für

- TypeScript Fullstack
- interne APIs zwischen Web und Backend
- schneller typisierter Produktaufbau

## Regeln

- Input Validation zwingend
- Auth/Context zentral sauber definieren
- keine vertraulichen Felder im Output
- Router modular nach Feature
- Public API nicht automatisch tRPC-only planen

## Codex-Regel

Neue Procedures brauchen Input Schema, Auth-Entscheidung und Tests für Fehlerfälle.

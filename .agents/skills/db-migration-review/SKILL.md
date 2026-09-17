---
name: db-migration-review
description: Prüft Migrationen auf Backward Compatibility, Backfill, RLS, Indexe und Rollback.
---

# DB Migration Review Skill

## Name

`db-migration-review`

## Zweck

Prüft Migrationen auf Backward Compatibility, Backfill, RLS, Indexe und Rollback.

## Auslöser

Nutze diesen Skill, wenn die Aufgabe zum beschriebenen Zweck passt oder ausdrücklich `db-migration-review` verlangt.

## Voraussetzungen

- `AGENTS.md` und `.agentic/project-profile.yaml` wurden gelesen.
- Relevante Workflow-, Risiko-, Environment- und Fachregeln sind bekannt.
- Scope, Ziel und erforderliche Freigaben sind geklärt.

Nutze diesen Skill bei Änderungen an Datenbankschema, Migrationen, Seed-Daten, RLS-Policies oder Produktionsdaten.

## Vorgehen

1. Lies `.agentic/database/migration-policy.md`.
2. Lies `.agentic/database/rollback-policy.md`.
3. Lies bei Supabase-Nutzung `.agentic/database/supabase-rls-policy.md`.
4. Prüfe Datenkompatibilität, Backfill, Indizes, Constraints und Berechtigungen.
5. Erstelle ein Migration-Review.

## Erwarteter Output

```md
## Migration Risk
## Affected Data
## Backward Compatibility
## Backfill
## Indexes/Constraints
## RLS/Permissions
## Tests
## Rollback/Forward-Fix
```

## Sicherheitsregeln

- Keine Secrets ausgeben oder erzeugen.
- Keine destruktiven oder produktiv wirksamen Aktionen ohne explizite Freigabe.
- Bei erhöhtem Risiko die betroffenen Security-, Datenbank- und Production-Regeln anwenden.

## Abschlusskriterien

- Ziel und dokumentierter Scope sind erfüllt.
- Relevante Tests und Quality Gates sind ausgeführt oder begründet als offen markiert.
- Sicherheits-, Freigabe- und Rollback-Anforderungen sind dem Risiko entsprechend dokumentiert.

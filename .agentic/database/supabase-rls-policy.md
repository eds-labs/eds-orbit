# Supabase RLS Policy

## Grundsatz

Bei Supabase-Projekten ist Row Level Security kein optionales Add-on, sondern Teil des Sicherheitsmodells.

## Jede neue Tabelle braucht

- RLS-Entscheidung
- Owner-/Tenant-Spalte, falls userbezogen
- Policies für select/insert/update/delete
- Tests oder SQL-Checks für erlaubte und verbotene Zugriffe
- Entscheidung, ob Service Role Zugriff nötig ist

## Häufige Fehler

- RLS aktiviert, aber keine Policies
- Client nutzt Service Role Key
- Tenant-ID wird nur im Frontend gefiltert
- Policies erlauben `true` zu breit
- Admin-Bypass nicht dokumentiert

## Prüffragen

- Kann User A Daten von User B sehen?
- Kann Tenant A Daten von Tenant B sehen?
- Können Inserts fremde Tenant IDs setzen?
- Sind Updates auf Owner/Tenant-Felder eingeschränkt?
- Gibt es sichere Server-seitige Admin-Funktionen?

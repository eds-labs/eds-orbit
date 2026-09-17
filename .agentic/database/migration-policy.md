# Database Migration Policy

## Grundsatz

Datenbankmigrationen sind High Risk, sobald bestehende Daten oder Production betroffen sind.

## Vor jeder Migration

- Welche Tabellen/Spalten/Indexes sind betroffen?
- Gibt es bestehende Daten?
- Ist die Änderung rückwärtskompatibel?
- Muss Code vor oder nach der Migration deployt werden?
- Gibt es Backfill?
- Wie wird Rollback oder Forward-Fix gemacht?
- Sind neue Queries indexiert?
- Sind RLS/Permissions betroffen?

## Sichere Migrationsmuster

Bevorzugt:

1. Neue nullable Spalte hinzufügen.
2. Code schreibt beide Felder oder nutzt neue Struktur optional.
3. Backfill ausführen.
4. Constraints setzen.
5. Alte Spalte später entfernen.

Vermeiden:

- Spalte direkt droppen
- Typänderungen ohne Backfill-Plan
- lange Locks in Production
- nicht getestete irreversible Migrationen
- manuelle Dashboard-Änderungen ohne Versionierung

## Required Output

```md
Migration Summary:
Affected Data:
Backward Compatible: yes/no
Backfill Needed: yes/no
Rollback/Forward-Fix:
Tests:
RLS/Permissions:
```

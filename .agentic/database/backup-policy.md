# Backup Policy

## Mindestanforderungen

- Production-Datenbank wird regelmäßig gesichert.
- Restore wurde mindestens einmal getestet.
- Backup-Aufbewahrung ist dokumentiert.
- Zugriff auf Backups ist eingeschränkt.
- Backups mit personenbezogenen Daten werden wie Production-Daten behandelt.

## Vor riskanten Changes

- aktuelles Backup vorhanden
- Restore-Pfad bekannt
- erwartete Recovery Time grob bekannt
- Verantwortliche Person bekannt

## Codex-Regel

Bei kritischen DB-Änderungen darf Codex nicht behaupten, ein Backup existiere, wenn dies nicht im Projekt dokumentiert ist. Stattdessen muss Codex den Backup-Status als offene Prüfung markieren.

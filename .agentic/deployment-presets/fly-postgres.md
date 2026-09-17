# Deployment Preset: Fly.io + Postgres

## Geeignet für

- kleine globale Apps
- Apps mit Docker-Deployments
- APIs mit regionalem Betrieb

## Pflichtchecks

- Region bewusst wählen
- Volumes verstehen
- DB-Backups prüfen
- Secrets über Provider-Mechanismus setzen
- Healthchecks und Release Commands definieren

## Risiken

- Stateful Services brauchen Backup-Strategie
- Regionale Latenz beachten
- Deployment- und Migration-Reihenfolge planen

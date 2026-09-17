# Deployment Preset: Docker Compose Single Server

## Services

Typisch:

- app
- postgres
- redis
- worker
- reverse-proxy

## Regeln

- App-Container sind stateless.
- Daten liegen in benannten Volumes oder gemounteten Datenpfaden.
- Backups werden außerhalb des App-Containers gespeichert.
- Migrationslauf ist explizit und nachvollziehbar.

## Production-Check

- `restart: unless-stopped`
- Healthchecks
- getrennte Networks
- nur Reverse Proxy exposed Ports
- Secrets nicht im Git
- Backup/Restore einmal getestet

# Deployment Preset: Docker auf VPS

## Geeignet für

- kleine bis mittlere Projekte
- Kostenkontrolle
- eigene Kontrolle über Runtime
- Fullstack App + Postgres + Redis

## Pflichtchecks

- Backups automatisieren
- Firewall/SSH absichern
- Reverse Proxy mit TLS
- `.env` nicht ins Image kopieren
- Healthchecks definieren
- Log-Rotation einrichten
- Docker Volumes nicht unbedacht löschen

## Minimalstruktur

```txt
infra/
├── docker-compose.yml
├── Caddyfile oder nginx.conf
├── scripts/
│   ├── backup.sh
│   ├── restore.sh
│   └── deploy.sh
└── README.md
```

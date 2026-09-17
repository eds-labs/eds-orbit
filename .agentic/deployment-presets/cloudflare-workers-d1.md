# Deployment Preset: Cloudflare Workers + D1/KV/R2

## Geeignet für

- Edge-nahe APIs
- kleine serverless Anwendungen
- statische Sites mit dynamischer Edge-Logik
- niedrige Latenz weltweit

## Pflichtchecks

- Runtime-Limits beachten
- D1/KV/R2 bewusst wählen
- Secrets via Plattform setzen
- Caching-Regeln verstehen
- lokale und remote Migrations unterscheiden
- Provider-Lock-in dokumentieren

## Nicht ideal für

- lange laufende Prozesse
- schwere Node.js-Abhängigkeiten
- komplexe relationale Workloads ohne sorgfältiges Design

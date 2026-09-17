# Seed Policy

## Regeln

- Seed-Daten dürfen keine echten personenbezogenen Daten enthalten.
- Testdaten müssen klar als Testdaten erkennbar sein.
- Production darf nicht automatisch geseedet werden, außer bewusst als Referenzdaten.
- Seeds müssen idempotent sein.

## Typische Seed-Arten

- lokale Demo-User
- Rollen und Permissions
- Referenzdaten
- Testdaten für E2E

## Codex-Regel

Wenn Codex Seeds ergänzt, muss klar sein:

- für welche Umgebung sie gedacht sind
- ob sie idempotent sind
- ob sie echte Daten imitieren, ohne echte Daten zu enthalten

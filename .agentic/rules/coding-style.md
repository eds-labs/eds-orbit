# Coding Style

## Allgemein

- Bestehenden Stil pro Datei/Modul übernehmen.
- Klare Namen statt Kommentare für triviale Logik.
- Kommentare nur für Warum, nicht für offensichtliches Was.
- Fehler explizit behandeln.
- Keine stillen Catch-Blöcke.
- Keine Magic Values ohne Namen oder Kontext.

## Funktionen

- Kleine Funktionen mit klarer Verantwortung.
- Inputs validieren, Outputs stabil halten.
- Seiteneffekte sichtbar machen.
- Pure Logik bevorzugen, wo sinnvoll.

## Typen und Contracts

- Öffentliche Schnittstellen typisieren.
- Keine breiten `any`/untyped Escape Hatches ohne Begründung.
- API-Contracts und Domain-Typen nicht vermischen, wenn das Projekt eine Trennung vorsieht.

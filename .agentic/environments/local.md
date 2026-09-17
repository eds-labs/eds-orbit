# Environment: Local

## Ziel

Schnelle Entwicklung mit lokalen oder isolierten Ressourcen.

## Erlaubt

- lokale Tests ausführen
- lokale Dev-Server starten
- lokale Seed-Daten neu erzeugen
- lokale Datenbanken resetten, wenn keine echten Daten betroffen sind

## Vorsicht

- `.env` nicht ausgeben
- echte API-Keys nicht in Logs kopieren
- lokale Änderungen nicht als Production-ready darstellen
- Docker-Volumes nur nach Prüfung löschen

## Vor Abschluss

- relevante Tests nennen
- wenn Checks nicht liefen, Grund angeben
- keine Production-Aussagen ohne Production-Profil

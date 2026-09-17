# File Upload Security

## Risiken

- Malware
- XSS über SVG/HTML
- Pfadmanipulation
- übergroße Dateien
- öffentliche Buckets
- unautorisierter Download
- sensible Metadaten

## Pflichtchecks

- Dateigröße begrenzen
- MIME/Extension prüfen, aber nicht blind vertrauen
- zufällige Storage-Namen verwenden
- Zugriff serverseitig prüfen
- private Buckets bevorzugen
- Upload und Download getrennt autorisieren
- keine hochgeladenen Dateien ausführen

## Tests

- zu große Datei
- falscher Dateityp
- fremder User lädt fremde Datei
- fehlende Auth
- Sonderzeichen im Dateinamen

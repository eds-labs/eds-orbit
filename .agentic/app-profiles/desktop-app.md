# App-Profil: Desktop-Anwendung

Nutze dieses Profil für native oder cross-platform Desktop-Anwendungen auf macOS, Windows oder Linux.

## Architektur

- Trenne UI, Anwendungslogik und Plattformintegration klar.
- Kapsle Dateisystem-, Prozess-, Keychain/Credential- und Betriebssystem-APIs hinter schmalen Adaptern.
- Halte IPC- und Bridge-Oberflächen minimal, typisiert und explizit freigegeben.
- Plane Update-, Signing- und Packaging-Flows getrennt von der normalen Feature-Logik.

## Sicherheit

- Keine Secrets in App-Bundles, Renderer-Prozessen oder Client-Konfigurationen ablegen.
- Shell-, Dateisystem- und Netzwerkzugriffe auf erlaubte Operationen begrenzen und Eingaben validieren.
- Bei Electron Context Isolation aktivieren und Node-Zugriff im Renderer vermeiden.
- Bei Tauri Capabilities und Permissions nach Least Privilege konfigurieren.

## Testing

- Business-Logik mit Unit-Tests absichern.
- Plattformadapter mit Integrations- oder Contract-Tests prüfen.
- Kritische Fenster-, Update- und Persistenz-Flows mindestens auf den unterstützten Zielplattformen testen.
- Packaging, Signierung und Installation vor Releases in isolierten Artefakten validieren.

## Quality Gates

- Accessibility und Tastaturbedienung prüfen.
- Offline-, Fehler- und Update-Zustände prüfen.
- Plattformberechtigungen und lokale Datenspeicherung reviewen.
- Passendes Desktop-Stack-Preset und Deployment-Preset dokumentieren.

# Codex Project Framework

## Zweck

Dieses Framework macht wiederkehrbare Codex-Arbeit in neuen und bestehenden Softwareprojekten nachvollziehbar, sicher und produktionsnah. Es verbindet projektspezifischen Kontext mit Stack-Entscheidungen, standardisierten Arbeitsabläufen, spezialisierten Rollen, Prüfregeln und operativer Governance.

## Kernprinzip

Jede nicht triviale Aufgabe durchläuft dasselbe Schichtenmodell:

```text
Aufgabe
→ Risiko bestimmen
→ Umgebung bestimmen
→ Anwendungstyp auswählen
→ Stack-Preset auswählen
→ Workflow auswählen
→ Agentenrollen verwenden
→ Implementieren
→ Testen
→ Review durchführen
→ Quality Gates prüfen
→ Ergebnis dokumentieren
```

Ein vorhandenes Projektprofil und bestehende Architekturentscheidungen haben Vorrang vor generischen Presets. Sicherheits-, Datenschutz- und Freigaberegeln dürfen nicht stillschweigend abgeschwächt werden.

## Wichtige Verzeichnisse

| Verzeichnis | Zweck |
|---|---|
| `routing/` | Entscheidungsbäume für Risiko, Stack und weitere Arbeitswege |
| `rules/` | allgemeine Engineering-, Security-, Test- und Dokumentationsregeln |
| `agents/` | Rollenprofile für Planung, Architektur, Umsetzung, QA, Review, Security, DevOps und Dokumentation |
| `workflows/` | standardisierte Abläufe für Feature, Bugfix, Refactor, Migration, Release, Incident und Review |
| `app-profiles/` | Regeln und Qualitätsanforderungen nach Anwendungstyp |
| `stack-presets/` | strukturierte Technologieentscheidungen mit Einsatzgrenzen, Tests und Deployment-Hinweisen |
| `app-structures/` | empfohlene Projektstrukturen, jeweils einem Stack-Preset zugeordnet |
| `environments/` | Regeln für lokale Entwicklung, Preview, Staging und Production |
| `deployment-presets/` | Betriebs- und Deployment-Muster für typische Plattformen |
| `quality-gates/` | Definition of Done und spezialisierte Abschlusschecklisten |
| `security/` | Threat Modeling, Rollen, Berechtigungen, Tenant-Isolation und Security-Testfälle |
| `database/` | Migrationen, Backups, Rollbacks, Seeds, Aufbewahrung und Datenbank-Sicherheit |
| `observability/` | Logging, Fehlerbehandlung, Metriken, Tracing und Alarmierung |
| `ci/` | Branch-, Required-Check-, Monorepo- und Release-Pipeline-Regeln |
| `testing/` | Teststrategie und Regeln nach Testart |
| `governance/` | Verantwortlichkeiten, Change Management, Eskalation und menschliche Freigaben |
| `compliance/` | Datenschutz, Datenklassifikation, Audit Logs und Tracking-Regeln |
| `ai/` | Modell- und Tool-Routing, Guardrails, Evals, Memory, Prompt- und Kostenregeln |
| `templates/` | wiederverwendbare Pläne, Reviews, ADRs, Runbooks und Übergaben |
| `context/` | Domain, Architektur, Constraints, Umgebungen und externe Systeme |
| `memory/` | belastbare, wiederverwendbare Erkenntnisse und bekannte Fallstricke |
| `schemas/` | maschinenprüfbare Verträge für Framework-Version, Projektprofil und Stack-Presets |

Weitere Bereiche wie `config/`, `contracts/`, `dependencies/`, `design/`, `jobs/`, `operations/` und `repo-strategies/` ergänzen die zentralen Schichten um spezialisierte Policies.

## Typischer Ablauf einer Aufgabe

1. Aufgabe und Akzeptanzkriterien verstehen.
2. `AGENTS.md`, Projektprofil und relevanten Kontext lesen.
3. Risiko klassifizieren.
4. Zielumgebung bestimmen.
5. Passendes App-Profil auswählen.
6. Bei Architektur- oder Neuprojektentscheidungen ein Stack-Preset auswählen.
7. Passenden Workflow auswählen.
8. Einen risikogerechten Plan erstellen.
9. Minimal und nachvollziehbar implementieren.
10. Relevante Tests und Projektbefehle ausführen.
11. Diff, Verhalten, Fehlerpfade und unbeabsichtigte Nebenwirkungen selbst prüfen.
12. Passende Quality Gates vollständig prüfen.
13. Ergebnis, Checks, Risiken, Deployment und Rollback dokumentieren.
14. Nur belastbare, wiederverwendbare Erkenntnisse in `memory/` oder dauerhafte Regeln aufnehmen.

## Neues Projekt starten

1. Kopiere das Framework in das neue Repository, ohne vorhandene Dateien blind zu überschreiben.
2. Fülle `.agentic/project-profile.yaml` vollständig aus.
3. Bestimme Anwendungstyp, Repository-Strategie und Zielumgebungen.
4. Wähle über `routing/stack-selection.md` ein Stack-Preset und dokumentiere die Entscheidung als ADR unter `docs/adr/`.
5. Übernimm die passende Vorlage aus `app-structures/` in die geplante Projektstruktur.
6. Lege reale Install-, Lint-, Typecheck-, Test- und Build-Befehle fest.
7. Passe Security, Datenbank, Deployment, Observability, CI und Freigaben an.
8. Prüfe das Framework mit `python3 scripts/check_framework.py`, bevor Produktcode entsteht. In CI ist `--require-full-validation` zu verwenden.

Der Skill `.agents/skills/new-project-bootstrap/` unterstützt die Erhebung, `.agents/skills/stack-select/` die Stack-Entscheidung und `.agents/skills/new-project-from-stack/` die strukturierte Initialisierung.

## Bestehendes Projekt integrieren

1. Inventarisiere bestehende `AGENTS.md`, Regeln, CI, Architektur, Commands und Sicherheitsvorgaben.
2. Kopiere die Framework-Verzeichnisse kontrolliert und vergleiche gleichnamige Dateien inhaltlich.
3. Erhalte projektspezifische Regeln und ergänze fehlende sichere Vorgaben.
4. Leite das Projektprofil aus nachweisbaren Repository-Dateien ab; nutze Platzhalter für offene Entscheidungen.
5. Behandle vorhandenen Stack und Architektur als Standard, bis eine explizite Migration beschlossen wurde.
6. Verknüpfe bestehende Tests und CI-Checks mit den Quality Gates.
7. Dokumentiere Konflikte und Abweichungen in einem Merge-Report oder ADR.
8. Führe alle Framework- und Projektprüfungen aus.

## Stack-Preset auswählen

Codex vergleicht Zielplattform, Anwendungstyp, Produktphase, Teamkompetenz, vorhandene Systeme, Betriebsmodell, Compliance, Kosten und Risiko. Anschließend wird genau ein führendes Preset aus `stack-presets/` gewählt und dessen `structure_ref` geprüft. Die Begründung nennt die entscheidenden Kriterien, erkennbare Nachteile und mindestens eine realistische Alternative. Bei einem bestehenden Repository beschreibt das Preset den aktuellen oder beschlossenen Zielstack; es löst keine automatische Migration aus.

Vor Abschluss einer Stack-Entscheidung ist `quality-gates/stack-fit-checklist.md` anzuwenden.

## Production-Änderungen

Production ist geschützt. Vor jeder produktiv wirksamen Änderung sind erforderlich:

- dokumentierte Risikoanalyse mit betroffenen Systemen und Daten
- aktuelles, überprüfbares Backup oder begründete Wiederherstellungsstrategie
- konkreter Rollback-Plan mit Auslösekriterien
- Monitoring-, Logging- und Alarmierungsplan
- explizite menschliche Freigabe für den konkreten Schritt
- stufenweise Ausführung, soweit technisch möglich
- Post-Deployment-Prüfung fachlicher und technischer Signale
- Incident- und Kommunikationsweg bei Abweichungen

Nutze mindestens `templates/production-change-plan.md`, `quality-gates/production-readiness-checklist.md` sowie die passenden Regeln aus `environments/production.md`, `database/`, `deployment-presets/`, `observability/` und `governance/human-approval.md`.

## Skills verwenden

Skills liegen unter `.agents/skills/<skill-name>/SKILL.md`. Wähle einen Skill, wenn Aufgabe und Auslöser zusammenpassen. Lies seine `SKILL.md` vollständig, prüfe Voraussetzungen, befolge das Vorgehen und liefere den erwarteten Output. Sicherheitsregeln und Abschlusskriterien des Skills sind verbindlich. Mehrere Skills dürfen kombiniert werden, wenn ihre Zuständigkeiten klar bleiben; Projektprofil, Risiko- und Freigaberegeln gelten immer zusätzlich.

Neue Skills müssen mindestens Name, Zweck, Auslöser, Voraussetzungen, Vorgehen, erwarteten Output, Sicherheitsregeln und Abschlusskriterien dokumentieren.

## Projektprofil anpassen

In `.agentic/project-profile.yaml` sind mindestens zu pflegen:

- Projektname, Anwendungstyp, Phase, Beschreibung und Owner
- gewähltes Stack-Preset sowie Frontend, Backend, Datenbank, ORM, Auth und Tooling
- Architektur-, API- und Repository-Strategie
- Standardumgebung, Production-Schutz und Deployment-Preset
- tatsächlich ausführbare Install-, Dev-, Lint-, Typecheck-, Test- und Build-Befehle
- Risikolevel, Tenant-Isolation und Secrets-Policy
- geschützte Pfade und sensible Domänen
- verpflichtende Quality Checks und Dokumentationsanforderung

Platzhalter sind im Framework zulässig, aber vor produktiver Nutzung aufzulösen. Echte Secrets gehören niemals in das Profil.

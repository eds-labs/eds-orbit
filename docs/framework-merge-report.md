# Framework Merge Report

## Verarbeitete Archive

- `codex-agentic-scaffold-v1.zip` — Basis für Projektregeln, Workflows, Rollen, App-Profile, Skills und grundlegende Quality Gates
- `codex-stack-presets-addon-v1.zip` — Stack-Routing, 20 Stack-Presets, 20 zugeordnete App-Strukturen und zwei ergänzende Skills
- `codex-operational-governance-addon-v1.zip` — Risiko, Environments, Deployment, Security, Datenbank-Lifecycle, Observability, CI/CD, Compliance, Governance und sieben ergänzende Skills

Verwendet wurden die bytegleich mit den Download-Kopien geprüften Archive unter `/Users/marioeuchner/Documents`. Die Archive selbst wurden nicht verändert.

## Zusammengeführte Bereiche

- Zentrale Anweisungen und Dokumentation: `AGENTS.md`, `README.md`, `MANIFEST.md`, `.agentic/README.md`
- Framework-Metadaten und Projektkonfiguration: `.agentic/framework-version.yaml`, `.agentic/project-profile.yaml`
- Agentisches Grundgerüst: `.agentic/rules/`, `.agentic/agents/`, `.agentic/workflows/`, `.agentic/app-profiles/`, `.agentic/context/`, `.agentic/memory/`
- Stack-Schicht: `.agentic/routing/stack-selection.md`, `.agentic/stack-presets/`, `.agentic/app-structures/`
- Operational Governance: Environments, Deployment-Presets, Config, Datenbank, Security, Observability, CI, Contracts, Testing, Design, Dependencies, Governance, Operations, Compliance, Repo-Strategien, Jobs und AI
- Wiederverwendbare Skills: `.agents/skills/`
- Hilfsskripte und ADR-Vorlagen: `scripts/`, `docs/adr/`

## Gelöste Konflikte

| Betroffene Dateien | Art des Konflikts | Lösung | Begründung |
|---|---|---|---|
| Drei Fassungen von `README.md` | identischer Zielpfad, unterschiedliche Komponentenbeschreibung | neues zentrales `README.md`; ausführliche Nutzung in `.agentic/README.md` | Erhält Schnellstart und alle Komponenten, ohne Add-on-Installationssprache zu duplizieren |
| Zwei Fassungen von `MANIFEST.md` | identischer Zielpfad, Basis- gegen Operations-Inhalt | gemeinsames Framework-Manifest | Beide Komponenten und die Stack-Schicht sind gleichberechtigt auffindbar |
| `AGENTS.md`, `AGENTS.stack-presets.addon.md`, `AGENTS.operational-snippet.md` und Operational-Snippet | überlappende Einstiegsvorgaben | relevante Regeln vollständig in `AGENTS.md` integriert | Eine verbindliche Quelle verhindert widersprüchliche Lesereihenfolgen und Freigaberegeln |
| `.agentic/project-profile.yaml` und Anforderungen der Add-ons | fehlende Stack-, Environment-, Security- und Quality-Felder | Schema erweitert, bestehende sichere Basisregeln erhalten | Das Profil deckt nun alle Pflichtbereiche ab und nutzt klare Platzhalter |
| `stack-fit-checklist.md` und `stack-fit-checklist-ops.md` | fachlich überlappende Quality Gates | Operations-Fragen in `stack-fit-checklist.md` übernommen | Ein Gate prüft nun Team, Technik, Betrieb, Backup, Monitoring, Kosten und Lock-in gemeinsam |
| Uneinheitliche Skill-Dokumente | unterschiedliche Überschriften und fehlende Vertragsabschnitte | alle Skills auf acht Pflichtabschnitte vereinheitlicht | Skills bleiben maschinen- und menschenlesbar, ohne fachliche Inhalte zu verlieren |
| Uneinheitliche Stack-Preset-Metadaten | Betriebs- und Beschreibungsfelder nicht durchgängig vorhanden | Beschreibung, Anwendungstyp, empfohlene Tools und Deployment-Hinweis ergänzt | Alle Presets sind konsistent prüfbar und weiterhin mit ihrer App-Struktur verknüpft |

## Entfernte Duplikate und veraltete Dateien

- `AGENTS.stack-presets.addon.md` — in `AGENTS.md` integriert
- `AGENTS.operational-snippet.md` — in `AGENTS.md` integriert
- `.codex/snippets/operational-governance.md` — redundante Snippet-Fassung nicht übernommen
- Add-on-spezifische `README.md`- und `INSTALL.md`-Dateien — Inhalte zentral konsolidiert
- `.agentic/quality-gates/stack-fit-checklist-ops.md` — in das zentrale Stack-Fit-Gate integriert
- `CHECKSUMS.txt` der Basis — nach Zusammenführung inhaltlich veraltet und deshalb entfernt
- automatisch entstandene nummerierte Zwischenfassungen von `AGENTS.md`, `README.md`, `MANIFEST.md` und `project-profile.yaml` — nach Inhaltsprüfung entfernt

## Geänderte Pfade

- Add-on-Anweisungen wurden nicht als separate Dateien beibehalten, sondern in `AGENTS.md` überführt.
- Die ausführliche, komponentenübergreifende Nutzung wurde in `.agentic/README.md` zentralisiert.
- Operations-Anforderungen des Stack-Fit-Gates wurden nach `.agentic/quality-gates/stack-fit-checklist.md` verschoben.
- Es wurden keine fachlichen Quellverzeichnisse umbenannt; bestehende `structure_ref`-Pfade bleiben gültig.

## Warnungen

- `.agentic/project-profile.yaml` enthält absichtlich `REPLACE_ME`-Platzhalter. Sie verhindern erfundene Projekt-, Auth-, Deployment- und Verantwortlichkeitsangaben und müssen bei der Übernahme in ein konkretes Repository ausgefüllt werden.
- Deployment-Presets und Operations-Regeln sind generische sichere Ausgangspunkte. Provider, Backup-Ziele, Retention, Alerting und Freigabeverantwortliche müssen projektspezifisch festgelegt werden.
- Der lokale Patch-Wrapper meldete einen außerhalb des Projekts fehlenden Hook unter `/hooks/validate-schema.py`. Die geschriebenen Dateien wurden deshalb jeweils direkt verifiziert; alle Framework-, Python- und YAML-Prüfungen bestanden unabhängig davon.

## Empfehlungen

1. Projektprofil für das erste konkrete Zielrepository ausfüllen.
2. Gewähltes Stack- und Deployment-Preset in den vorhandenen ADRs dokumentieren.
3. Reale CI-Required-Checks und Branch-Protection an das Projektprofil angleichen.
4. Backup-, Rollback-, Monitoring- und Freigabeverantwortliche vor Production-Nutzung festlegen.
5. `python3 scripts/check_framework.py` bei jeder Framework-Änderung in CI ausführen.

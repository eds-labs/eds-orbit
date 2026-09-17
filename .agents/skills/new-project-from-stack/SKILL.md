---
name: new-project-from-stack
description: Erstellt aus einem gewählten Stack-Preset eine konkrete Projektstruktur und aktualisiert project-profile.yaml.
---

# Skill: New Project From Stack

## Name

`new-project-from-stack`

## Zweck

Erstellt aus einem gewählten Stack-Preset eine konkrete Projektstruktur und aktualisiert project-profile.yaml.

## Auslöser

Nutze diesen Skill, wenn die Aufgabe zum beschriebenen Zweck passt oder ausdrücklich `new-project-from-stack` verlangt.

## Voraussetzungen

- `AGENTS.md` und `.agentic/project-profile.yaml` wurden gelesen.
- Relevante Workflow-, Risiko-, Environment- und Fachregeln sind bekannt.
- Scope, Ziel und erforderliche Freigaben sind geklärt.

Nutze diese Skill, wenn ein Projekt oder Modul aus einem Stack-Preset angelegt werden soll.

## Vorgehen

1. Lies das gewählte Preset aus `.agentic/stack-presets/`.
2. Lies die zugehörige Struktur aus `.agentic/app-structures/`.
3. Erstelle oder aktualisiere `.agentic/project-profile.yaml` anhand `.agentic/templates/project-profile.stack-preset.yaml`.
4. Erstelle nur Skeleton-Dateien, keine unnötige Beispiel-Logik.
5. Lege Tests/Ordner nur an, wenn sie zum Preset gehören.
6. Dokumentiere Commands und offene Setup-Schritte.

## Sicherheitsregeln

- Keine Secrets erzeugen.
- Keine produktiven Deployments konfigurieren.
- Keine unnötigen Dependencies installieren.
- Wenn Commands nicht ausführbar sind, dokumentiere sie statt sie zu erfinden.

## Erwarteter Output

- Nachvollziehbares Ergebnis gemäß dem beschriebenen Vorgehen
- Ausgeführte Prüfungen, verbleibende Risiken und offene Punkte

## Abschlusskriterien

- Ziel und dokumentierter Scope sind erfüllt.
- Relevante Tests und Quality Gates sind ausgeführt oder begründet als offen markiert.
- Sicherheits-, Freigabe- und Rollback-Anforderungen sind dem Risiko entsprechend dokumentiert.

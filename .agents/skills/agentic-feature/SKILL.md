---
name: agentic-feature
description: Für neue Features: plant zuerst, wählt das passende App-Profil, implementiert kleine vertikale Schnitte, ergänzt Tests und prüft gegen die Definition of Done.
---

# Agentic Feature Skill

## Name

`agentic-feature`

## Zweck

Für neue Features: plant zuerst, wählt das passende App-Profil, implementiert kleine vertikale Schnitte, ergänzt Tests und prüft gegen die Definition of Done.

## Voraussetzungen

- `AGENTS.md` und `.agentic/project-profile.yaml` wurden gelesen.
- Relevante Workflow-, Risiko-, Environment- und Fachregeln sind bekannt.
- Scope, Ziel und erforderliche Freigaben sind geklärt.

## Auslöser

Nutze diesen Skill für neue Funktionalität oder Erweiterung bestehender Funktionalität.

## Vorgehen

1. Lies `AGENTS.md`, `.agentic/project-profile.yaml`, `.agentic/workflows/feature.md` und passendes App-Profil.
2. Formuliere Akzeptanzkriterien und Nicht-Ziele.
3. Erstelle einen kurzen Plan mit Dateien, Risiken und Tests.
4. Implementiere minimal-invasiv.
5. Ergänze Tests für neue Logik.
6. Prüfe Security/Accessibility/Performance, wenn relevant.
7. Schließe mit Summary, Changed Files, Verification, Risks und Follow-ups ab.

## Sicherheitsregeln

- Kein breiter Refactor.
- Keine neue Dependency ohne Begründung.
- Bestehende Patterns übernehmen.
- Bei Auth/Billing/Admin/Tenant-Themen Security-Review anwenden.

## Erwarteter Output

- Nachvollziehbares Ergebnis gemäß dem beschriebenen Vorgehen
- Ausgeführte Prüfungen, verbleibende Risiken und offene Punkte

## Abschlusskriterien

- Ziel und dokumentierter Scope sind erfüllt.
- Relevante Tests und Quality Gates sind ausgeführt oder begründet als offen markiert.
- Sicherheits-, Freigabe- und Rollback-Anforderungen sind dem Risiko entsprechend dokumentiert.

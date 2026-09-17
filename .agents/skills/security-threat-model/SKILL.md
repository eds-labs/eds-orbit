---
name: security-threat-model
description: Erstellt ein leichtgewichtiges Threat Model für High-/Critical-Risk Features.
---

# Security Threat Model Skill

## Name

`security-threat-model`

## Zweck

Erstellt ein leichtgewichtiges Threat Model für High-/Critical-Risk Features.

## Auslöser

Nutze diesen Skill, wenn die Aufgabe zum beschriebenen Zweck passt oder ausdrücklich `security-threat-model` verlangt.

## Voraussetzungen

- `AGENTS.md` und `.agentic/project-profile.yaml` wurden gelesen.
- Relevante Workflow-, Risiko-, Environment- und Fachregeln sind bekannt.
- Scope, Ziel und erforderliche Freigaben sind geklärt.

Nutze diesen Skill für Auth, Tenant-Isolation, Uploads, Webhooks, AI-Tools, Billing und andere High-Risk-Features.

## Vorgehen

1. Lies `.agentic/security/threat-model.md`.
2. Bestimme Assets, Akteure, Einstiegspunkte und Trust Boundaries.
3. Liste Missbrauchsfälle auf.
4. Ordne vorhandene und fehlende Controls zu.
5. Definiere Security-Tests.

## Erwarteter Output

Use `.agentic/templates/security-threat-model-lite.md`.

## Sicherheitsregeln

- Keine Secrets ausgeben oder erzeugen.
- Keine destruktiven oder produktiv wirksamen Aktionen ohne explizite Freigabe.
- Bei erhöhtem Risiko die betroffenen Security-, Datenbank- und Production-Regeln anwenden.

## Abschlusskriterien

- Ziel und dokumentierter Scope sind erfüllt.
- Relevante Tests und Quality Gates sind ausgeführt oder begründet als offen markiert.
- Sicherheits-, Freigabe- und Rollback-Anforderungen sind dem Risiko entsprechend dokumentiert.

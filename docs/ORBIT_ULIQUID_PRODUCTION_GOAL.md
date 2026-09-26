# EDS Orbit -- uLiquid Production Readiness Goal

**Status:** ACTIVE\
**Created:** 2026-09-26\
**Execution owner:** Codex\
**Primary target:** Orbit zuverlässig als tägliches Marketing-Workspace
für uLiquid Desk nutzbar machen.

## 1. Mission

Orbit soll für reale uLiquid-Marketingarbeit nutzbar werden, ohne
regelmäßige technische Eingriffe.

Der erste Produktiv-Meilenstein lautet:

> Ein Nutzer gibt Orbit einen normalen uLiquid-Marketingauftrag. Orbit
> verwendet aktuelles, freigegebenes uLiquid-Wissen und Branding,
> erstellt einen kanalgeeigneten Entwurf mit belegten Aussagen,
> richtigem CTA und offizieller URL, macht das Ergebnis einfach prüfbar
> und erlaubt einen kontrollierten nächsten Schritt -- ohne
> unbeabsichtigte externe Veröffentlichung.

Nicht möglichst viele neue Features bauen. Vorhandene Systeme verbinden,
stabilisieren und mit uLiquid real abnehmen.

## 2. Definition of Done -- uLiquid Draft Production Ready

Der Meilenstein ist erst erreicht, wenn gegen das aktuelle deployte
uLiquid-Projekt nachgewiesen wurde:

-   Marketingauftrag kann über Orbit Chat bzw. den vorgesehenen
    Hauptworkflow gestartet werden.
-   Aktuelle freigegebene uLiquid-Fakten und Quellen werden gefunden.
-   Der Generator erhält den aktuellen Marketing-Profil-Kontext vor der
    Generierung.
-   Kampagnentyp, Zielkanal, CTA, offizielle URL, Sprache, Zielgruppe
    und Produkt sind strukturiert bekannt.
-   Kanalabhängige Regeln werden verwendet; kein pauschales
    280-Zeichen-Limit für alle Social-Kanäle.
-   Verifizierte aktuelle Status-/Presale-Aussagen können bestehen;
    unbelegte/veraltete bleiben blockiert.
-   Faktische Aussagen besitzen nachvollziehbare
    Evidence-/Claim-Referenzen.
-   Entwurf ist in der UI verständlich prüfbar.
-   Freigegebene uLiquid-Brand-Assets können verwendet werden.
-   Branded Visual kann bei Bedarf erstellt und bei aktivem Drive
    korrekt gespeichert werden.
-   Entwurf kann bewusst exportiert/übergeben werden, ohne automatisch
    veröffentlicht zu werden.
-   Retry/Resume erzeugt keine unbeabsichtigten doppelten Paid Calls,
    Drafts oder Provider Writes.
-   Readiness zeigt aktionsbezogene Blocker verständlich an.
-   Produktionsnaher Acceptance Run ist mit exakt deploytem Commit
    dokumentiert.
-   Backup-/Recovery-Voraussetzungen sind vor breiter
    Live-Write-Aktivierung dokumentiert.

**Autonomes öffentliches Publishing ist für diesen Meilenstein nicht
erforderlich.**

## 3. Nicht-Ziele

Diese Punkte dürfen P0 nicht verzögern, sofern sie nicht für den Golden
Path nötig sind:

-   vollautonomes Social Publishing;
-   Ads-Spend-Automation;
-   Newsletter-Versand;
-   Blog/CMS Live Publishing;
-   Agent-Swarm-Neubau;
-   Orbit MCP Server;
-   zusätzliche AI Provider;
-   großes UI-Redesign;
-   Ersatz von Postiz, Google Drive oder Matomo;
-   Infrastruktur-Neubau ohne nachgewiesene Notwendigkeit.

## 4. Arbeitsregeln für Codex

### Status strikt trennen

Für wichtige Fähigkeiten immer getrennt dokumentieren: - **IMPLEMENTED**
-- Code vorhanden - **TESTED** -- automatisiert/lokal erfolgreich
geprüft - **DEPLOYED** -- Zielsystem läuft damit - **ACCEPTED** --
realer uLiquid-Ablauf erfolgreich nachgewiesen

### External Effects

Ohne explizite Freigabe: - keine echten Social Posts, Newsletter oder
Ads; - `ENABLE_EXTERNAL_WRITES` nicht allgemein aktivieren; - keinen
Knowledge Index automatisch aktivieren; - unbekannten
Provider-Write-Ausgang niemals blind wiederholen.

### Paid AI

Vor neuen Paid Runs vorhandene OpenAI-Konfiguration, Policy/Budget,
Index-Generationen und Evaluationen prüfen. Gültige Ergebnisse
wiederverwenden. Kosten begrenzen und dokumentieren. Keine Evaluation
nur wegen veralteter Dokumentation erneut starten.

### Vorgehen

Pro Phase: Inspect → Ist-Zustand dokumentieren → kleinste sichere
Änderung → Tests → Verifikation → dieses Dokument aktualisieren → Commit
→ Deployment nur wenn vorgesehen → Acceptance separat dokumentieren.

## 5. Bekannte Ausgangslage -- vor Verwendung verifizieren

Vorhanden sind Web/API/Worker, PostgreSQL/pgvector, Redis, RLS,
Paid-Call-Budgetierung, Orbit Chat,
Knowledge/Facts/Evidence/Index/Evaluation/Revocation, Marketing
Profiles, Missions, Generation, Review/Approvals, Google Drive, Brand
Rendering, Postiz und Matomo.

Der analysierte `main`-Stand bestand 306 Tests in 26 Testfiles und 8
Chromium-Flows. Ein erfolgreicher Paid-uLiquid-Chat war dokumentiert.

Zu verifizieren/reparieren: 1. Index-Aktivierungsfix aus offenem PR. 2.
Generation und Guardrails verwenden offenbar nicht vollständig denselben
Marketing-Kontext. 3. Pauschales 280-Zeichen-Social-Limit. 4. Konflikt
allgemeiner Live-Status-Regel mit Presale-Verifikation. 5.
Unterschiedliche Retrieval-Pfade in Chat und Mission Generation. 6.
Fehlender komfortabler Batch-Draft-Workflow. 7. Orbit Draft, Postiz
Draft, Schedule und Publish nicht klar genug getrennt. 8. Zu starres
Claim-Format für natürliche Marketing-Copy. 9. Zu globale Readiness. 10.
Production/off-host Backup/Recovery noch nicht real bewiesen.

# 6. Umsetzungsphasen

## Phase 0 -- Authoritative Current State \[P0\]

-   [x] aktuellen `main` SHA dokumentieren
-   [x] offene PRs und Index-Aktivierungsfix prüfen
-   [x] deployten Orbit SHA/Version ermitteln
-   [x] uLiquid Readiness auslesen
-   [x] Marketing Profile + Version prüfen
-   [x] OpenAI-Konfiguration ohne Secrets prüfen
-   [x] Policy/Budget prüfen
-   [x] aktive/Candidate Knowledge Index Generations prüfen
-   [x] aktuelle Live-Evaluation Records prüfen
-   [x] Source Freshness und Embedded Corpus Counts prüfen
-   [x] Google Drive Connection/Root und Approved Assets prüfen
-   [x] uLiquid Postiz Assignments prüfen
-   [x] Matomo Connector Status prüfen
-   [x] Execution Mode / External Write Flags prüfen
-   [x] Capability Matrix aktualisieren

**Acceptance:** Kein Paid Call/Provider Write. Repo- und Deploymentstand
eindeutig dokumentiert.

## Phase 1 -- Bestehende Release-Lücken schließen \[P0\]

-   [ ] Index-Aktivierungsfix prüfen und falls korrekt/nicht superseded
    integrieren
-   [ ] keine automatische Index-Aktivierung
-   [ ] lint, typecheck, full tests, build
-   [ ] relevante Playwright-Flows
-   [ ] secret scan und Dependency/Security Checks
-   [ ] exakte Ergebnisse dokumentieren

**Acceptance:** `main` grün; keine Regression bei RLS, Budget,
Revocation oder Write Controls.

## Phase 2 -- Gemeinsamer Generation Contract \[P0\]

Generator und Guardrails müssen denselben autoritativen Kontext
verwenden.

Der Contract enthält mindestens: Project/Generation, Marketing Profile
ID/Version, Campaign Type, Product, Audience, Language, Target
Channel/Provider, Content Type, Topics/Prohibitions, Intended Primary
CTA, Official Target URL, Evidence/Source References, Approved Asset
IDs, Channel Constraints, Mission ID/Version, Policy ID/Version und Cost
Ceiling.

-   [ ] Chat Proposal → Mission → Generation → Preflight tracen
-   [ ] gemeinsamen typisierten Generation Context
    einführen/wiederverwenden
-   [ ] Generator und Guardrails daraus speisen
-   [ ] Official Links aus aktuellem verifiziertem Profil/Fakten
-   [ ] Intended CTA explizit übergeben
-   [ ] Profile-Version-Invalidierung erhalten
-   [ ] Product-/Presale-Regressionstests

**Acceptance:** Draft scheitert nicht mehr nur deshalb, weil Regeln erst
nach der Generierung bekannt werden.

## Phase 3 -- Channel-aware Rules \[P0\]

-   [ ] zentrale Channel-Capability/Rules-Auflösung
-   [ ] echte Provider-Identifier verwenden, wo verfügbar
-   [ ] pauschales `social <= 280` entfernen
-   [ ] gleiche Regeln in Generation und Preflight
-   [ ] finale Länge inkl. angehängter URL berücksichtigen
-   [ ] Tests für X, Telegram, LinkedIn und unknown provider
-   [ ] unbekannte Live-Fähigkeiten fail-closed

**Acceptance:** Telegram/LinkedIn werden nicht durch X-Regeln blockiert.

## Phase 4 -- Evidence-aware Status/Claim Guardrails \[P0\]

-   [ ] Live-/Presale-Regelkonflikt reproduzieren
-   [ ] überlappende Regex durch evidence-aware Statusprüfung
    ersetzen/strukturieren
-   [ ] unbelegte/veraltete Statusaussagen weiter blockieren
-   [ ] Price- und Guaranteed-Profit/Risk-Free-Guards erhalten
-   [ ] Tests: verified live erlaubt; ohne Fact blockiert; stale/revoked
    blockiert; unsupported feature status blockiert
-   [ ] Claim-Ledger Exact-Match-Verhalten prüfen
-   [ ] natürliche Copy mit belastbarer Claim-Verknüpfung ermöglichen
-   [ ] kein Model-Self-Approval

**Acceptance:** Gleiche Aussage besteht mit gültigem Beleg und wird ohne
Beleg deterministisch abgelehnt.

## Phase 5 -- Chat und Generation Retrieval angleichen \[P0/P1\]

-   [ ] Chat Retrieval Mode sichtbar machen
-   [ ] sichere Nutzung des bestehenden Hybrid Retrieval prüfen
-   [ ] gleicher Active Index, Rights, Budget Journal und Cost Ceiling
-   [ ] falls lexical: `lexical_degraded` sichtbar ausweisen
-   [ ] Rechte-/Zeit-/Projekt-Fencing beider Pfade testen
-   [ ] fixes uLiquid Query Set vergleichen

**Acceptance:** Retrieval ist transparent, kostenbegrenzt und
rights-safe.

## Phase 6 -- Golden Path: einzelner uLiquid Draft \[P0\]

Acceptance-Auftrag:

> Create an English Telegram draft for uLiquid Desk explaining one
> currently verified product capability, using the approved uLiquid
> tone, one approved CTA and an official uLiquid link. Use only current
> verified project knowledge. Do not publish.

Nachweisen: - \[ \] Auftrag → Readiness → Evidence → Proposal →
Mission/Job → Draft - \[ \] Evidence/Claims sichtbar - \[ \] Guardrails
erfolgreich oder verständlicher Blocker - \[ \] Draft prüf-/editierbar -
\[ \] Approved Brand Asset verwendbar - \[ \] optional Visual + Drive
Save - \[ \] Export/Handoff - \[ \] kein Public Post

Acceptance Record: deployed SHA, Profile Version, Evidence IDs, Index
Generation, Model, Cost, Content ID, Asset ID, Drive Result,
Readiness/Preflight und `NO_EXTERNAL_PUBLICATION`.

## Phase 7 -- Action-specific Readiness \[P1\]

Separate Readiness für Chat, Knowledge Search, Text Draft, Visual, Drive
Save, Internal Review, Export, Postiz Draft, Postiz Schedule, Postiz
Live, Matomo, Blog Live, Newsletter Live und Ads Live.

-   [ ] machine-readable Codes + verständliche Gründe
-   [ ] Postiz Live-Verifikation nicht für internen Draft verlangen
-   [ ] Mock-only nicht als real `live_ready` darstellen
-   [ ] Operator Summary in Overview und/oder Chat

## Phase 8 -- Batch Draft Preparation \[P1, erst nach Phase 6\]

-   [ ] bounded Batch Mission/Draft Plan
-   [ ] Max Draft Count + Gesamt-Cost-Ceiling
-   [ ] Themen-/Duplikatkontrolle
-   [ ] jeder Draft einzeln reviewbar
-   [ ] keine automatische Veröffentlichung
-   [ ] Resume/Retry idempotent
-   [ ] Tests für 3--5 Drafts

**Acceptance:** „Bereite 5 uLiquid Posts für nächste Woche vor" erzeugt
höchstens fünf prüfbare Drafts innerhalb des Budgets.

## Phase 9 -- Postiz Draft Handoff \[P1/P2\]

-   [ ] vorhandene Postiz `draft` Capability end-to-end prüfen
-   [ ] explizite Aktion `Send to Postiz as Draft`
-   [ ] exakten Channel anzeigen
-   [ ] Idempotency/unknown outcome
-   [ ] Draft-Handoff darf kein `now` Publish auslösen
-   [ ] getrennte Readiness/Rechte für Draft vs Live
-   [ ] echter Provider-Test nur nach expliziter Freigabe

## Phase 10 -- Production Hardening \[P1\]

-   [ ] Coolify Deployment/Services prüfen
-   [ ] Web/API/Worker Health und Restart
-   [ ] Migration State und persistente Volumes
-   [ ] Off-host Backup
-   [ ] `CREDENTIAL_KEY` Recovery separat absichern
-   [ ] Production Restore Drill planen/dokumentieren
-   [ ] unabhängiges Uptime/Alerting
-   [ ] Rollback auf vorherigen SHA
-   [ ] finalen uLiquid Acceptance Run wiederholen

# 7. Reihenfolge und Stop Conditions

Reihenfolge: **0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10**.

Eine Phase darf übersprungen werden, wenn sie nachweislich bereits
erfüllt ist. Evidence dokumentieren; `ACCEPTED` nur bei realer
uLiquid-Abnahme.

Sofort stoppen und dokumentieren bei unbekanntem
Paid-/External-Write-Ausgang, notwendiger echter Veröffentlichung ohne
Freigabe, notwendiger Paid Evaluation ohne Mandat, unerwartetem
Migrationsrisiko, Security Regression oder unklarem Production State.

# 8. Current Capability Matrix

Status as observed on 2026-09-26, before the Phase 1 verification run. `DEPLOYED`
means the code is in the running revision; it does not mean a provider action is
enabled. `TESTED` remains `VERIFY` until checks run against this revision.

| Capability | IMPLEMENTED | TESTED | DEPLOYED | ACCEPTED uLiquid | Blocker / evidence |
| --- | --- | --- | --- | --- | --- |
| Orbit Chat | YES | VERIFY | YES | PARTIAL | Live succeeded chat jobs; no complete Golden Path acceptance. |
| OpenAI text generation | YES | VERIFY | YES | PARTIAL | Server-side key and verified model list configured; earlier paid chat succeeded. No new call in Phase 0. |
| Knowledge ingestion | YES | VERIFY | YES | PARTIAL | Official site last fetched 2026-09-25; five verified-fact sources have no fetch timestamp and health reports five stale sources. |
| Hybrid retrieval | YES | VERIFY | YES | VERIFY | Active vector generation exists; current Chat retrieval mode and rights-safe query result not measured in Phase 0. |
| Live RAG evaluation | YES | VERIFY | YES | PARTIAL | Existing generation 2 evaluation: 60 cases, passed, MRR 0.85417; no new evaluation. |
| Marketing profile | YES | VERIFY | YES | PARTIAL | uLiquid Desk profile v1 and official links visible; end-to-end generation use not accepted. |
| Single text draft | YES | VERIFY | YES | PARTIAL | Three older Orbit drafts visible in Content Studio; none is a current accepted Golden Path run. |
| Brand assets | YES | VERIFY | YES | NO | Asset library empty; profile references zero approved assets. |
| Visual rendering | YES | VERIFY | YES | NO | Code/UI available, but no approved uLiquid asset or accepted visual. |
| Google Drive save | YES | VERIFY | YES | VERIFY | Project account connected and root listing visible; no new save/readback performed. |
| Postiz assignment | YES | VERIFY | YES | YES | uLiquid Desk Telegram and uLiquid X are assigned; other projects' channels remain unassigned. |
| Postiz draft handoff | PARTIAL | VERIFY | YES | NO | Connector supports `draft`; no accepted explicit Orbit-to-Postiz draft handoff. |
| Postiz live publish | YES | VERIFY | YES | NO | Connector write proof exists, but project channel write verification remains required and external writes are disabled. |
| Matomo import | YES | VERIFY | YES | VERIFY | Connector reports read verified (last check 2026-09-22); no current import acceptance. |
| Batch drafts | PARTIAL | VERIFY | YES | NO | Reviewable drafts exist; bounded batch request and resume behavior not accepted. |
| Production backup/restore | PARTIAL | VERIFY | VERIFY | NO | Isolated restore is documented; current off-host production restore and key escrow remain unproven. |

Allowed values: `YES`, `NO`, `PARTIAL`, `VERIFY`, `N/A`.

# 9. Progress Log

Codex hängt nach jedem Arbeitsblock einen Eintrag an. Alte Einträge
nicht überschreiben.

### 2026-09-26 11:36 CEST -- Phase 0 -- Authoritative current state

**Repo SHA before:** `46ea2494a443d9b4d3a0c20774f92a0d5d753493` (`main` = `origin/main`).
**Repo SHA after:** Phase 0 documentation commit (see Git history).
**Deployment SHA:** `46ea2494a443d9b4d3a0c20774f92a0d5d753493` (Coolify successful webhook deployment `y5vrnwex6t1zenel1mokenfn`, started 2026-09-26 11:10 CEST; resource reports Running).
**Status:** COMPLETE for read-only inventory; `ULIQUID_DRAFT_PRODUCTION_READY = NO / NOT YET ACCEPTED`.

**Inspected:** Current local and remote `main`, all GitHub PRs, PR #4 diff and activation regression, Coolify deployment history, authenticated uLiquid Overview/Settings/Operations/Knowledge/Assets/Content/Connectors, and non-secret Coolify runtime flags. No open PRs; PR #4 merged 2026-09-26 09:10 UTC. Its fix offers activation only for `evaluated` generations, retains server-side validation, and has a browser regression. It is already in deployed `main`; no reimplementation is needed.

**Production/uLiquid evidence:** Project `uLiquid` is in `observe`, readiness `test ready`; Generation `live ready` is a global indicator and does not constitute draft or publication acceptance. Existing policy v1 is active in observe mode, limited to internal/script, with paid test authorization and $10 daily/monthly/per-run limits. Overview shows $0.11 spent and $0.03 reserved. OpenAI configuration was updated 2026-09-19, contains a shared key and dedicated image key, verified text/embedding/image model IDs, and a price card last verified 2026-09-18. No key values were viewed or recorded. Knowledge generation 2 (`openai:text-embedding-3-small:1536:chunk-v1`) is **active** with 54 chunks; generation 1 is retired and no candidate is shown. Existing live evaluation reports 60 cases, passed, MRR 0.85417. Six active sources are listed: one official website (last fetched 2026-09-25 18:41 CEST) and five verified-fact sources without fetch timestamp; health reports five stale sources, zero expired facts, missing evidence, conflicts or failed imports. Time-sensitive facts such as presale status require fresh review despite a `verified` label. Profile v1 has six referenced sources and **zero approved assets**. Content Studio lists three older Orbit drafts. Google Drive is connected and a project root listing is visible, but save/readback was not exercised. Postiz reports write verified for publish/reconcile (last check 2026-09-24); Telegram and X are assigned to uLiquid. Matomo reports read verified (last check 2026-09-22). Operations shows a ready worker and zero pending outbox at observation time.

**Safety and execution:** Coolify production variables show `EXECUTION_MODE=test` and `ENABLE_EXTERNAL_WRITES=false`. The project is `observe`; UI readiness lists `EXTERNAL WRITES DISABLED` and `CHANNEL WRITE VERIFICATION REQUIRED`. No Postiz draft, schedule or live publish was attempted.

**Documentation drift:** `docs/IMPLEMENTATION_STATUS.md` still describes an earlier local-only checkpoint with no application OpenAI credential or production deployment; that is no longer the current state. The goal's earlier assumption of an open activation PR is superseded by merged/deployed PR #4. Historical test counts and browser runs are not treated as current test evidence.

**Costs / external effects:** Paid AI cost $0; new evaluation 0; provider writes 0; public publications 0. Read-only production UI and connector metadata were viewed.

**Open blockers:** No critical Phase 0 stop condition observed. For draft acceptance: five stale-source warnings/time-sensitive fact review, zero approved brand assets, no current end-to-end Telegram draft/visual/Drive acceptance, and global readiness cannot prove action-specific readiness. Production off-host restore/key recovery remains unproven before any broad live-write activation.

**Next action:** Phase 1: validate the already merged activation fix with current-revision lint, typecheck, full tests, build, relevant Playwright, framework/secret/runtime-artifact scans, dependency inventory and high-severity audit. Record exact results; make no index activation or provider call. If green, proceed to Phase 2 contract inspection.

## Template

### YYYY-MM-DD HH:MM -- Phase X -- `<Titel>`{=html}

**Repo SHA before:**\
**Repo SHA after:**\
**Deployment SHA:**\
**Status:** IN_PROGRESS / BLOCKED / COMPLETE / ACCEPTED

**Inspected** - ...

**Changed** - ...

**Verification** - command/test: - result:

**Production/uLiquid evidence** - ...

**Costs / external effects** - Paid AI cost: - Provider writes: - Public
publication:

**Open blockers** - ...

**Next action** - ...

# 10. Decision Log

Architektur-/Produktentscheidungen, die spätere Arbeit beeinflussen,
append-only dokumentieren:

  Date   Decision   Reason   Consequence
  ------ ---------- -------- -------------

# 11. Final Acceptance

`ULIQUID_DRAFT_PRODUCTION_READY = YES` darf erst gesetzt werden, wenn:

-   Phasen 0--6 abgeschlossen sind;
-   alle P0-Regressionstests grün sind;
-   der Golden Path gegen das deployte uLiquid-Projekt erfolgreich war;
-   kein ungeklärter P0-Blocker existiert;
-   tatsächlicher deployed SHA dokumentiert ist;
-   External Writes während der Draft-Abnahme nicht unbeabsichtigt
    aktiviert wurden;
-   Kosten/Provider-Effekte dokumentiert sind.

**Current final state:**
`ULIQUID_DRAFT_PRODUCTION_READY = NO / NOT YET ACCEPTED`

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

-   [x] Index-Aktivierungsfix prüfen und falls korrekt/nicht superseded
    integrieren
-   [x] keine automatische Index-Aktivierung
-   [x] lint, typecheck, full tests, build
-   [x] relevante Playwright-Flows
-   [x] secret scan und Dependency/Security Checks
-   [x] exakte Ergebnisse dokumentieren

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

-   [x] Chat Proposal → Mission → Generation → Preflight tracen
-   [x] gemeinsamen typisierten Generation Context
    einführen/wiederverwenden
-   [x] Generator und Guardrails daraus speisen
-   [x] Official Links aus aktuellem verifiziertem Profil/Fakten
-   [x] Intended CTA explizit übergeben
-   [x] Profile-Version-Invalidierung erhalten
-   [x] Product-/Presale-Regressionstests

**Acceptance:** Draft scheitert nicht mehr nur deshalb, weil Regeln erst
nach der Generierung bekannt werden.

## Phase 3 -- Channel-aware Rules \[P0\]

-   [x] zentrale Channel-Capability/Rules-Auflösung
-   [x] echte Provider-Identifier verwenden, wo verfügbar
-   [x] pauschales `social <= 280` entfernen
-   [x] gleiche Regeln in Generation und Preflight
-   [x] finale Länge inkl. angehängter URL berücksichtigen
-   [x] Tests für X, Telegram, LinkedIn und unknown provider
-   [x] unbekannte Live-Fähigkeiten fail-closed

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

Status as observed on 2026-09-26, after the Phase 3 local verification run.
`DEPLOYED` means the code is in the running revision; it does not mean a
provider action is enabled. `TESTED` records local or automated checks, not
live uLiquid acceptance.

| Capability | IMPLEMENTED | TESTED | DEPLOYED | ACCEPTED uLiquid | Blocker / evidence |
| --- | --- | --- | --- | --- | --- |
| Orbit Chat | YES | YES | YES | PARTIAL | Local tests and browser flows passed; live succeeded chat jobs, but no complete Golden Path acceptance. |
| OpenAI text generation | YES | YES | YES | PARTIAL | Bounded mocked/local tests passed; earlier paid chat succeeded. No new paid call. |
| Knowledge ingestion | YES | YES | YES | PARTIAL | Tests passed; official site last fetched 2026-09-25, while health reports five stale sources. |
| Hybrid retrieval | YES | YES | YES | VERIFY | Local exact SQL/evaluation tests passed; current Chat retrieval mode not measured. |
| Live RAG evaluation | YES | YES | YES | PARTIAL | Local gates passed; existing generation 2 live evaluation: 60 cases, passed, MRR 0.85417. |
| Marketing profile | YES | YES | YES | PARTIAL | Migration/RLS and browser tests passed; profile v1 visible, generation contract not accepted. |
| Shared generation contract | YES | YES | NO | NO | Local product/presale, invalid link, policy scope, profile and channel-change tests passed; verify uLiquid official URL fact/source model rights and allowed policy origins before deployment/acceptance. |
| Channel-aware social rules | YES | YES | NO | NO | Local X, Telegram, LinkedIn and unknown-provider tests passed. Generation and preflight use assigned Postiz identifiers and include an appended URL; uLiquid channels have not been accepted on the deployed revision. |
| Single text draft | YES | YES | YES | PARTIAL | Local browser flow passed; three older Orbit drafts visible, no current Golden Path run. |
| Brand assets | YES | YES | YES | NO | Local browser flow passed; uLiquid asset library empty and zero approved assets. |
| Visual rendering | YES | YES | YES | NO | Local tests passed, but no approved uLiquid asset or accepted visual. |
| Google Drive save | YES | YES | YES | VERIFY | Mock/local tests passed; project account/root visible, no real save/readback performed. |
| Postiz assignment | YES | YES | YES | YES | Project-scoping browser test passed; Telegram and X assigned to uLiquid. |
| Postiz draft handoff | PARTIAL | PARTIAL | YES | NO | Connector `draft` contract tested; explicit Orbit handoff and live provider proof absent. |
| Postiz live publish | YES | YES | YES | NO | Local safety tests passed; writes disabled and project channel verification required. |
| Matomo import | YES | YES | YES | VERIFY | Local normalization/import tests passed; read verification last checked 2026-09-22. |
| Batch drafts | PARTIAL | PARTIAL | YES | NO | Reviewable drafts exist; bounded batch and resume flow not tested end-to-end. |
| Production backup/restore | PARTIAL | VERIFY | VERIFY | NO | Isolated restore is documented; current off-host production restore and key escrow remain unproven. |

Allowed values: `YES`, `NO`, `PARTIAL`, `VERIFY`, `N/A`.

# 9. Progress Log

Codex hängt nach jedem Arbeitsblock einen Eintrag an. Alte Einträge
nicht überschreiben.

### 2026-09-26 11:36 CEST -- Phase 0 -- Authoritative current state

**Repo SHA before:** `46ea2494a443d9b4d3a0c20774f92a0d5d753493` (`main` = `origin/main`).
**Repo SHA after:** `3fac510faa7bc3bc1144697a8349de629a48388a`.
**Deployment SHA:** `46ea2494a443d9b4d3a0c20774f92a0d5d753493` (Coolify successful webhook deployment `y5vrnwex6t1zenel1mokenfn`, started 2026-09-26 11:10 CEST; resource reports Running).
**Status:** COMPLETE for read-only inventory; `ULIQUID_DRAFT_PRODUCTION_READY = NO / NOT YET ACCEPTED`.

**Inspected:** Current local and remote `main`, all GitHub PRs, PR #4 diff and activation regression, Coolify deployment history, authenticated uLiquid Overview/Settings/Operations/Knowledge/Assets/Content/Connectors, and non-secret Coolify runtime flags. No open PRs; PR #4 merged 2026-09-26 09:10 UTC. Its fix offers activation only for `evaluated` generations, retains server-side validation, and has a browser regression. It is already in deployed `main`; no reimplementation is needed.

**Production/uLiquid evidence:** Project `uLiquid` is in `observe`, readiness `test ready`; Generation `live ready` is a global indicator and does not constitute draft or publication acceptance. Existing policy v1 is active in observe mode, limited to internal/script, with paid test authorization and $10 daily/monthly/per-run limits. Overview shows $0.11 spent and $0.03 reserved. OpenAI configuration was updated 2026-09-19, contains a shared key and dedicated image key, verified text/embedding/image model IDs, and a price card last verified 2026-09-18. No key values were viewed or recorded. Knowledge generation 2 (`openai:text-embedding-3-small:1536:chunk-v1`) is **active** with 54 chunks; generation 1 is retired and no candidate is shown. Existing live evaluation reports 60 cases, passed, MRR 0.85417. Six active sources are listed: one official website (last fetched 2026-09-25 18:41 CEST) and five verified-fact sources without fetch timestamp; health reports five stale sources, zero expired facts, missing evidence, conflicts or failed imports. Time-sensitive facts such as presale status require fresh review despite a `verified` label. Profile v1 has six referenced sources and **zero approved assets**. Content Studio lists three older Orbit drafts. Google Drive is connected and a project root listing is visible, but save/readback was not exercised. Postiz reports write verified for publish/reconcile (last check 2026-09-24); Telegram and X are assigned to uLiquid. Matomo reports read verified (last check 2026-09-22). Operations shows a ready worker and zero pending outbox at observation time.

**Safety and execution:** Coolify production variables show `EXECUTION_MODE=test` and `ENABLE_EXTERNAL_WRITES=false`. The project is `observe`; UI readiness lists `EXTERNAL WRITES DISABLED` and `CHANNEL WRITE VERIFICATION REQUIRED`. No Postiz draft, schedule or live publish was attempted.

**Documentation drift:** `docs/IMPLEMENTATION_STATUS.md` still describes an earlier local-only checkpoint with no application OpenAI credential or production deployment; that is no longer the current state. The goal's earlier assumption of an open activation PR is superseded by merged/deployed PR #4. Historical test counts and browser runs are not treated as current test evidence.

**Costs / external effects:** Paid AI cost $0; new evaluation 0; provider writes 0; public publications 0. Read-only production UI and connector metadata were viewed.

**Open blockers:** No critical Phase 0 stop condition observed. For draft acceptance: five stale-source warnings/time-sensitive fact review, zero approved brand assets, no current end-to-end Telegram draft/visual/Drive acceptance, and global readiness cannot prove action-specific readiness. Production off-host restore/key recovery remains unproven before any broad live-write activation.

**Next action:** Phase 1: validate the already merged activation fix with current-revision lint, typecheck, full tests, build, relevant Playwright, framework/secret/runtime-artifact scans, dependency inventory and high-severity audit. Record exact results; make no index activation or provider call. If green, proceed to Phase 2 contract inspection.

### 2026-09-26 11:45 CEST -- Phase 1 -- Existing release gaps

**Repo SHA before:** `3fac510faa7bc3bc1144697a8349de629a48388a`.
**Repo SHA after:** Phase 1 documentation/evidence commit (see Git history).
**Deployment SHA:** `46ea2494a443d9b4d3a0c20774f92a0d5d753493`; no deployment performed.
**Status:** COMPLETE for the existing activation release gap and local release checks. Production Golden Path remains unaccepted.

**Inspected:** Merged PR #4 (`2ebc2eb2340162f0901c2b0cc6304c4809c29aa5`) changes only the index action menu for `building` versus `evaluated` and adds a browser regression. Current `main` and the live deployment already include it. The browser test confirms `Activate` appears for `evaluated`, is absent for `building`, and opens the confirmation dialog without submitting an index change. Existing server activation guards remain in place. No code change or new activation was needed.

**Verification:** Node 24.18.0, pnpm 11.19.0, PostgreSQL 17/pgvector and Redis local. `pnpm lint` PASS; `pnpm typecheck` PASS; `pnpm build` PASS; full `pnpm test` **306/306, 26/26 files PASS** on a fresh isolated local database with migrated schema and least-privilege grants; `pnpm test:e2e` **9/9 Chromium PASS**; `pnpm test:migration-profile` PASS (legacy data retained and profile/chat RLS/grants checked); `pnpm test:coolify-compose` PASS; `pnpm framework:check` PASS with 0 errors/0 warnings; `python3 scripts/check-secrets.py` PASS across 540 candidate files; `python3 scripts/check-runtime-artifacts.py` PASS across 39 generated files against six local credential values without disclosing them; `pnpm dependencies:inventory` recorded 406 packages/licenses; `pnpm audit --audit-level high` reported no known vulnerabilities. The deterministic local retrieval evaluation recorded 64 cases and provider cost 0; it was not a new live RAG evaluation.

**Test environment note:** The first full run against the existing local `orbit_test` database passed 305/306; its worker lifecycle case timed out twice. That database contains 1,189 accumulated synthetic projects, which the worker scans. A fresh isolated database ran the full suite in 20.94s with 306/306 passing. The old database was not pruned, and this local test-environment slowdown is not evidence about production throughput.

**Costs / external effects:** Paid AI cost $0; new live evaluation 0; index activations 0; provider writes 0; public publications 0. Playwright used a local synthetic account and internal test-publishing only.

**Open blockers:** Current uLiquid draft/visual/Drive acceptance, stale-source review, zero approved assets, action-specific readiness and off-host recovery remain outside Phase 1. CI on the new documentation commit and a production deployment of that commit were not run; the activation fix itself is deployed.

**Next action:** Phase 2: trace Chat proposal → Mission → Generation → Preflight, compare the actual profile/CTA/evidence fields, then implement the smallest shared generation contract with regression tests. No paid call or external write is needed for that inspection.

### 2026-09-26 12:35 CEST -- Phase 2 -- Shared generation contract

**Repo SHA before:** `2e213379f37502911a3bcd79139865ec953e4f57`.
**Repo SHA after:** Phase 2 local implementation commit (see Git history).
**Deployment SHA:** `46ea2494a443d9b4d3a0c20774f92a0d5d753493`; no deployment performed.
**Status:** COMPLETE for local Phase 2 implementation and verification; `DEPLOYED = NO`, `ACCEPTED uLiquid = NO`, `ULIQUID_DRAFT_PRODUCTION_READY = NO`.

**Inspected and changed:** Chat proposals and the manual mission form previously carried a profile version and primary CTA but no selected official target URL. Live generation passed only a short goal, audience, product, language, channel and topics to OpenAI; current profile voice, strategy, guardrails, CTA and official link were checked after drafting. A typed generation contract now binds project/generation, mission/version, policy/version and cost ceiling, evidence/source and approved asset references, campaign/profile, product/audiences/language, product or presale strategy, voice/guardrails, selected CTA, verified official URL fact/source rights/version and selected channel/provider. Current policy channel/type scope and allowed link origin are checked before any paid retrieval; Chat proposals and manual mission creation also check an active policy. No channel character limit is inferred: the contract records `characterLimit: null` until Phase 3 resolves provider-specific rules. Mission creation and Chat proposals require a CTA and URL from the current profile; browser-authored and deterministic drafts inherit the mission URL. Preflight rejects a changed or missing mission URL and the wrong primary CTA. Live generation rechecks the mission, profile, URL fact/source rights and channel assignment before model transmission and after the model response; an in-flight change discards the draft after settling known cost.

**Verification:** Node 24.18.0; `pnpm lint` PASS; `pnpm typecheck` PASS; final `pnpm build` PASS; full `pnpm test --pool=threads --maxWorkers=1` **315/315 tests, 26/26 files PASS** on a fresh migrated and least-privilege local database; `pnpm test:e2e` **9/9 Chromium PASS** on the local app, including mission CTA/official-link selection and the Knowledge → Mission → Review → test publication → revocation flow. `pnpm framework:check` PASS (0 errors/0 warnings); `python3 scripts/check-secrets.py` PASS (540 candidate files); `python3 scripts/check-runtime-artifacts.py` PASS (39 generated files); `pnpm audit --audit-level high` found no known vulnerabilities. The deterministic local knowledge run recorded 64 cases and provider cost 0; no live RAG evaluation was run.

**Test environment note:** An initial full Vitest run passed 249 tests but could not start two fork workers. A second run passed 309/310 with the worker lifecycle timing out against the reused Phase 1 database. A fresh isolated Phase 2 database completed the full suite. Initial Playwright failure was caused by a running local API process predating the deterministic-draft change; after restarting that process, the focused flow and full 9-test suite passed. No production state was used to resolve these local test issues.

**Risk and rollback:** High-risk local generation-path change, no migration or new dependency. A mismatch fails closed before a new paid call where possible; after transmission, known provider cost is settled and content is withheld. Revert the single Phase 2 commit to restore the previous code and form behavior. Deploy and real uLiquid acceptance remain separate decisions.

**Costs / external effects:** Paid AI cost $0; new live evaluation 0; index activation 0; external provider writes 0; public publications 0. Playwright created only synthetic local data and an internal test publication.

**Open blockers:** The contract is not deployed or accepted on uLiquid. Confirm that the selected uLiquid official-link fact and its source allow model use and that the active policy allows its URL origin. Existing uLiquid missions without an explicit target URL will need review or recreation before further generation. Five stale-source warnings/time-sensitive fact review, zero approved brand assets, no current Golden Path acceptance, action-specific readiness and off-host recovery remain open. Channel-specific character limits and provider constraints are Phase 3.

**Next action:** Phase 3: resolve per-provider channel rules from assigned integration metadata, replace the global 280-character social limit in generation/claim checking/preflight, and prove Telegram and X behavior without external writes.

### 2026-09-26 13:24 CEST -- Phase 3 -- Channel-aware social rules

**Repo SHA before:** `3de6e73625edd6069756d95fc1529864eb9b6796`.
**Repo SHA after:** Phase 3 local implementation commit (see Git history).
**Deployment SHA:** `46ea2494a443d9b4d3a0c20774f92a0d5d753493` was last verified in the earlier baseline; production was not re-read in Phase 3 and no deployment was performed.
**Status:** COMPLETE for local Phase 3 implementation and verification; `DEPLOYED = NO`, `ACCEPTED uLiquid = NO`, `ULIQUID_DRAFT_PRODUCTION_READY = NO`.

**Inspected and changed:** The former `social <= 280` rule existed in claim checking and preflight; a separate Slack inline-approval preview also had a 280-character cutoff. Generation had `characterLimit: null`, while the campaign context read an assigned Postiz provider identifier independently. A single project-scoped resolver now uses the exact assigned integration ID and its Postiz `identifier`, rejecting ambiguous assignments. X uses a conservative 280-character weighted Unicode count; Telegram uses 4096 for text or 1024 when an asset makes the text a caption; LinkedIn uses 3000. The final text, including an official target URL appended by Orbit, is shared by review and publisher handoff. Generation receives the provider, counting method, limit, reserved URL characters and body budget; a changed connector/rule invalidates an in-flight generation. Unknown providers retain reviewable Orbit drafts but cause `CHANNEL_CAPABILITY_UNVERIFIED` at live preflight. The optional short Slack digest preview remains a Slack presentation limit, not a social-channel guardrail. A browser test revealed that opening a mission form in a project without a marketing profile could crash; optional profile fields are now read safely.

**Rule evidence and limits:** [X character counting](https://docs.x.com/fundamentals/counting-characters.md) documents weighted Unicode, 280 and 23-character URLs; Orbit intentionally adds a 23-character allowance to each URL-like token and overcounts ambiguous Unicode rather than passing a potentially over-limit post. [Telegram Bot API](https://core.telegram.org/bots/api) documents 4096-message and 1024-media-caption maxima. Current [Postiz Telegram provider](https://github.com/gitroomhq/postiz-app/blob/main/libraries/nestjs-libraries/src/integrations/social/telegram.provider.ts) sends image text as a caption; its [LinkedIn provider](https://github.com/gitroomhq/postiz-app/blob/main/libraries/nestjs-libraries/src/integrations/social/linkedin.provider.ts) exposes 3000, and its [X provider](https://github.com/gitroomhq/postiz-app/blob/main/libraries/nestjs-libraries/src/integrations/social/x.provider.ts) exposes 280 for non-premium standard posts. Orbit does not infer premium or long-form privileges. These upstream limits require confirmation against the installed Postiz version and assigned uLiquid account before live acceptance.

**Verification:** Node 24.18.0; focused generation/preflight tests **43/43 PASS**; full `pnpm test --pool=threads --maxWorkers=1` **323/323 tests, 26/26 files PASS** on an isolated migrated local database; `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm framework:check`, secret pattern scan, runtime artifact scan and `pnpm audit --audit-level high` all PASS. Full `pnpm test:e2e` **9/9 Chromium PASS** against a separate isolated browser database after fixing the missing-profile form crash. The first browser attempt used credentials from another local test database (9 sign-ins failed); a second run identified the form crash (8/9). A fresh browser account and the targeted fix yielded the final 9/9 result. The original ignored browser account file was restored; the Phase 3 test account is preserved separately in ignored runtime storage. No production data was changed.

**Risk and rollback:** High-risk local publication-preflight change. Provider writes still require the existing policy, approval, write verification and execution flags. No migration or new dependency. Revert the single Phase 3 commit to restore prior code; validate deployed Postiz provider settings before any production enablement.

**Costs / external effects:** Paid AI cost $0; new live RAG evaluation 0; index activation 0; external provider writes 0; public publications 0. Browser flows used only synthetic local state and internal test publication.

**Open blockers:** Phase 3 code is not deployed or uLiquid-accepted. The current uLiquid Telegram and X assignments need provider-settings/readback confirmation on the installed Postiz version. Existing Phase 2 blockers remain: official URL fact/source model rights and policy origins, stale-source and time-sensitive fact review, zero approved brand assets, missing Golden Path acceptance, action-specific readiness and off-host recovery.

**Next action:** Phase 4: reproduce the current live/presale wording conflict and replace status regex behavior with evidence-aware checks while preserving financial and unsupported-claim safeguards. No paid evaluation or provider write is needed for local inspection and tests.

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

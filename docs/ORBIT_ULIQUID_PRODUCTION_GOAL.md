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

-   [x] Live-/Presale-Regelkonflikt reproduzieren
-   [x] überlappende Regex durch evidence-aware Statusprüfung
    ersetzen/strukturieren
-   [x] unbelegte/veraltete Statusaussagen weiter blockieren
-   [x] Price- und Guaranteed-Profit/Risk-Free-Guards erhalten
-   [x] Tests: verified live erlaubt; ohne Fact blockiert; stale/revoked
    blockiert; unsupported feature status blockiert
-   [x] Claim-Ledger Exact-Match-Verhalten prüfen
-   [x] natürliche Copy mit belastbarer Claim-Verknüpfung ermöglichen
-   [x] kein Model-Self-Approval

**Acceptance:** Gleiche Aussage besteht mit gültigem Beleg und wird ohne
Beleg deterministisch abgelehnt.

## Phase 5 -- Chat und Generation Retrieval angleichen \[P0/P1\]

-   [x] Chat Retrieval Mode sichtbar machen
-   [x] sichere Nutzung des bestehenden Hybrid Retrieval prüfen
-   [x] gleicher Active Index, Rights, Budget Journal und Cost Ceiling
-   [x] falls lexical: `lexical_degraded` sichtbar ausweisen
-   [x] Rechte-/Zeit-/Projekt-Fencing beider Pfade testen
-   [x] fixes uLiquid Query Set vergleichen (synthetic local fixture;
    live uLiquid acceptance remains separate)

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

Status as observed on 2026-09-28 after the deferred Phase 6 generation job. The running revision remains `dcc9146caff40043126ba6a7d08171d7cd6c7fc5`; PR #10 remains undeployed. An evidence-scoped recovery is prepared locally but has not passed isolated CI or live acceptance.
`DEPLOYED` means the code is in the running revision; it does not mean a
provider action is enabled. `TESTED` records local or automated checks, not
live uLiquid acceptance.

| Capability | IMPLEMENTED | TESTED | DEPLOYED | ACCEPTED uLiquid | Blocker / evidence |
| --- | --- | --- | --- | --- | --- |
| Orbit Chat | YES | YES | YES | PARTIAL | On the running revision, exact-key hybrid fact retrieval, approved asset-ID lookup and a confirmed, reviewable proposal passed live. The associated Mission has not generated a draft. |
| OpenAI text generation | YES | YES | YES | PARTIAL | The second approved Chat run settled $0.037793 and saved one proposal. The deferred Mission job ran once at 09:00 UTC in test mode and blocked with `INSUFFICIENT_EVIDENCE`; zero new Content rows and zero budget reservations for that job were observed. |
| Knowledge ingestion | YES | YES | YES | PARTIAL | Official public platform page was reviewed on 2026-09-26; Orbit still reports five stale sources and one dependent content item with missing evidence. This review does not clear their sync warnings. |
| Hybrid retrieval | YES | YES | YES | PARTIAL | The deployed exact-key Chat search returned the selected facts through hybrid retrieval on active generation 2. This does not prove Mission draft acceptance; no new RAG evaluation or index activation occurred. |
| Chat and Mission retrieval alignment | PARTIAL | PARTIAL | PARTIAL | NO | Chat used the confirmed exact Fact keys. The scheduled Mission passed a broad goal to lexical retrieval and blocked with `INSUFFICIENT_EVIDENCE`; 28 otherwise verified Facts match that text. A local correction passes exact dotted Mission topics as `factKeys` for confirmed Chat Missions and preserves missing/changed-Fact blocks. It is not deployed. |
| Live RAG evaluation | YES | YES | YES | PARTIAL | Local gates passed; existing generation 2 live evaluation: 60 cases, passed, MRR 0.85417. |
| Marketing profile | YES | YES | YES | PARTIAL | Live profile v2 now approves the exact `Explore the beta` CTA and retains the existing guardrails. An older profile-v1 test draft moved to needs review. Generation contract is not accepted. |
| Shared generation contract | YES | YES | YES | PARTIAL | The live policy, profile v2, verified facts, assigned Telegram channel, official target URL and approved logo passed proposal confirmation. The Mission generation and resulting copy are unaccepted. |
| Channel-aware social rules | YES | YES | YES | NO | Local X, Telegram, LinkedIn and unknown-provider tests passed. Generation and preflight use assigned Postiz identifiers and include the appended URL; no deployed uLiquid draft acceptance. |
| Evidence-aware status and claim guardrails | YES | YES | YES | NO | Local integration tests permit current linked status and exact price claims; missing, stale, withdrawn, mismatched and unsupported claims fail. No deployed uLiquid draft acceptance. |
| Single text draft | YES | YES | YES | PARTIAL | Three older Orbit drafts remain. The confirmed proposal created one Mission; its scheduled job is now `blocked_dependency` after one attempt with `INSUFFICIENT_EVIDENCE`. No new draft exists. |
| Approved early single live draft | PARTIAL | PARTIAL | NO | NO | PR #10 remains draft and undeployed. A local recovery path requires the exact blocked one-attempt evidence failure, one dispatched Outbox event, no other Mission job, no Content or prior reservation, active policy and owner confirmation; it creates a separate one-attempt job and leaves the old job blocked. Isolated CI and live acceptance remain open. |
| Brand assets | YES | YES | YES | PARTIAL | Approved uLiquid logo `cfe2bfa8-ef84-4a30-93bc-96cf863d307a` was found by exact ID and included in the confirmed proposal. Use in a new draft is unproven. |
| Visual rendering | YES | YES | YES | NO | An approved logo exists, but no uLiquid visual was generated or accepted. The current OpenAI settings dialog reports no usable image key. |
| Google Drive save | YES | YES | YES | VERIFY | Mock/local tests passed; project account/root visible, no real save/readback performed. |
| Postiz assignment | YES | YES | YES | YES | Project-scoping browser test passed; Telegram and X assigned to uLiquid. |
| Postiz draft handoff | PARTIAL | PARTIAL | YES | NO | Connector `draft` contract tested; explicit Orbit handoff and live provider proof absent. |
| Postiz live publish | YES | YES | YES | NO | Local safety tests passed; writes disabled and project channel verification required. |
| Matomo import | YES | YES | YES | VERIFY | Local normalization/import tests passed; read verification last checked 2026-09-22. |
| Batch drafts | PARTIAL | PARTIAL | YES | NO | Reviewable drafts exist; bounded batch and resume flow not tested end-to-end. |
| Production backup/restore | PARTIAL | VERIFY | VERIFY | NO | A mode-0600 pre-PR-#10 on-host archive (`20260928T0855Z`, 1,173,571 bytes) passed a full read through container `pg_restore`; it predates the scheduled job failure. Off-host production restore and key escrow remain unproven. |

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

### 2026-09-26 13:53 CEST -- Phase 4 -- Evidence-aware status and claim guardrails

**Repo SHA before:** `5410cdff07a414b6cb4f2081f311f1ad38acdb5a`.
**Repo SHA after:** Phase 4 local implementation commit (see Git history).
**Deployment SHA:** `46ea2494a443d9b4d3a0c20774f92a0d5d753493` was last verified in the earlier baseline; production was not re-read in Phase 4 and no deployment was performed.
**Status:** COMPLETE for local Phase 4 implementation and verification; `DEPLOYED = NO`, `ACCEPTED uLiquid = NO`, `ULIQUID_DRAFT_PRODUCTION_READY = NO`.

**Inspected and changed:** The previous generic status regex rejected `presale is live` even when a separate presale check found a verified fact. That presale check searched any project fact and ignored its evidence link, source rights, version and freshness. The claim ledger accepted only literal `key: value` renderings. Status and price checks now require claims tied to the same current public evidence snapshot, source generation and fact version. Presale-live additionally requires a matching `presale.status=live` fact, a presale campaign and verification age below both the source age limit and 24 hours. Bounded natural fact sentences can now carry the exact fact value and subject. Unsupported feature-status wording, mismatched amounts, guaranteed-profit and risk-free language remain blocked. Any extra marketing text still needs explicit owner body review; that review cannot override factual or evidence failures.

**Verification:** Node 24.18.0; focused SQL integration suite **39/39 PASS** on an isolated migrated local database with mocked AI provider; final full `pnpm test --pool=threads --maxWorkers=1` **331/331 tests, 26/26 files PASS**, including literal fact-rendering and risk-free regressions; `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm framework:check`, secret scan, runtime-artifact scan, `pnpm audit --audit-level high` and `git diff --check` PASS. Full `pnpm test:e2e` **9/9 Chromium PASS** against a separate isolated local browser database. The original ignored browser account file was restored after testing.

**Risk and rollback:** High-risk local publication-review change with no migration or new dependency. Revert only the Phase 4 commit to restore prior policy. Before production acceptance, review live uLiquid facts and sources, deploy through the release gates, and exercise a real draft and review without provider writes.

**Costs / external effects:** Paid AI cost $0; new live RAG evaluation 0; index activation 0; external provider writes 0; public publications 0. Browser flows used synthetic local state and internal test publication only.

**Open blockers:** Phase 4 is neither deployed nor uLiquid-accepted. The uLiquid status/price facts and source rights have not been refreshed or approved for these claims. Previous blockers remain: current source freshness, official URL fact/source model rights and policy origins, zero approved brand assets, action-specific readiness, off-host recovery, and the deployed Golden Path.

**Next action:** Phase 5: inspect Chat retrieval mode against Mission hybrid retrieval, preserve rights, active-index and budget gates, make lexical degradation explicit if needed, and compare a fixed uLiquid query set. No paid or external action is implied by this local phase completion.

### 2026-09-26 14:31 CEST -- Phase 5 -- Chat and Mission retrieval alignment

**Repo SHA before:** `b79a1d4a6ef5dabd3a9bc4eab94fd970b3c908b6`.
**Repo SHA after:** Phase 5 local implementation commit (see Git history).
**Deployment SHA:** `46ea2494a443d9b4d3a0c20774f92a0d5d753493` was last verified during Phase 0; production was not re-read in Phase 5 and no deployment was performed.
**Status:** COMPLETE for local Phase 5 implementation and verification; `DEPLOYED = NO`, `ACCEPTED uLiquid = NO`, `ULIQUID_DRAFT_PRODUCTION_READY = NO`.

**Inspected and changed:** Mission Generation already used `retrieveHybrid()` with the active index, policy reservation, embedding receipt, post-call policy/index checks and project-scoped `retrieve()`. Chat `knowledge_search` called `retrieve()` without a query vector: it was lexical-only, recorded `lexical_degraded` in evidence but omitted that mode from the tool result and UI. Chat runs now call the existing Hybrid retriever with a trusted per-tool job key and the same budget run key as Chat text generation. Query cost is therefore journaled against the same policy per-run ceiling; unknown embedding cost and other search failures terminate the Chat run instead of allowing a new paid tool call. Search results include evidence ID, mode, index profile/generation and a visible mode card. The lexical path remains explicitly labeled `lexical_degraded` when used without a trusted Chat run. Public/model rights, evidence validity and current index are checked again before the result enters the prompt.

**Fixed local comparison:** Three versioned synthetic uLiquid-oriented queries (`presale status`, `product capability`, `hazard notifications`) ran through both paths with mocked embeddings. Both paths returned the same current fact IDs and active index generation; the semantic-only passage appeared in Hybrid, not lexical. An expired fact, model-rights withdrawal and another project's empty corpus were excluded. A filled shared per-run budget blocked the embedding before transmission. This is a deterministic local comparison, not a new live uLiquid RAG evaluation or production quality acceptance.

**Verification:** Focused Chat integration tests **8/8 PASS**; final full suite **333/333 tests, 26/26 files PASS** on a freshly migrated isolated local database; `pnpm typecheck`, `pnpm lint`, `pnpm build`, framework check, secret scan, runtime-artifact scan, dependency audit and `git diff --check` PASS. Full `pnpm test:e2e` **9/9 Chromium PASS** on a separate fresh local browser database, including the visible `lexical_degraded` card. The first full-suite run in the temporary verification checkout hit a Worker timeout because its runtime directory was absent; a retry against the existing accumulated test database also timed out. After creating the checkout runtime directory and a fresh isolated test database, the complete suite passed. The original macOS workspace had intermittently unavailable cloud-evicted source/dependency files; the tests used the same committed base plus Phase 5 edits in a temporary local checkout outside that file-provider path.

**Risk and rollback:** High-risk local AI retrieval and cost-boundary change; no migration or new production dependency. Revert the single Phase 5 commit if necessary. Before any deployed acceptance, confirm the installed active index, policy budget, source rights, query receipts and current uLiquid results on the deployed revision without disabling write gates.

**Costs / external effects:** Paid AI cost $0; new live RAG evaluation 0; index activation 0; external provider writes 0; public publications 0. SQL budget reservations and browser state were synthetic local test data; embeddings and model responses were mocked.

**Open blockers:** Phase 5 code is not deployed or uLiquid-accepted. Real current uLiquid query results were not generated in this phase; the existing production evaluation record cannot substitute for a Chat-path acceptance run on the deployed SHA. Stale sources, official URL rights/policy origins, zero approved brand assets, action-specific readiness, off-host recovery and the Golden Path remain open.

**Next action:** Phase 6: execute the single uLiquid draft Golden Path only after confirming current production state and rights. Keep external publication disabled; obtain separate authorization for any new paid model call, provider write or deployment required for live acceptance.

### 2026-09-26 15:09 CEST -- Production release and Phase 6 preflight

**Repo SHA before:** `38207488b8de27fc76f14c12f19f15b5d17f8ca4` (`main` and `origin/main`; Phase 0--5 release).
**Repo SHA after:** This documentation commit (see Git history).
**Deployment SHA:** `38207488b8de27fc76f14c12f19f15b5d17f8ca4` (Coolify webhook deployment started 2026-09-26 14:59 CEST, finished Success after 3m44s).
**Status:** Phase 0--5 code DEPLOYED; Phase 6 BLOCKED at the production policy/asset gate. `ULIQUID_DRAFT_PRODUCTION_READY = NO / NOT YET ACCEPTED`.

**Release evidence:** Mario approved deployment. The six focused Phase 0--5 commits were pushed through PR [#5](https://github.com/eds-labs/eds-orbit/pull/5); both isolated Orbit acceptance checks and Framework Check passed. The exact tested SHA was fast-forwarded to `main`; main CI passed. Before the push, a fresh custom-format production database dump was created at `/root/orbit-backups/20260926T125318Z-pre-orbit-phase6-release.dump` (1.2 MB, owner-only permissions, `pg_restore -l` passed, SHA-256 `f3acc9d579dde25b34591e5606a931652dfda8c59ef59356d3d9005de170fe9b`). It is on-host only; no off-host restore or key-recovery proof is claimed. Production had zero unfinished migrations before and after rollout. The migration container exited 0. The new API, Worker, Web, PostgreSQL and Redis containers report `running healthy`; authenticated Orbit Settings, Knowledge, Chat and Operations load. The Worker heartbeat was ready at 15:09 CEST with zero pending outbox. Public web entry returned HTTP 200; `/api/health` returned 404 and is not used as a health gate for this web host.

**Production safety and uLiquid state:** Runtime flags remain `EXECUTION_MODE=test` and `ENABLE_EXTERNAL_WRITES=false`. The project remains `observe`. Overview/Operations still show $0.11 spent and $0.03 reserved, with no new job from this work. Active Knowledge generation 2 remains at 54 chunks; health still reports five stale sources, zero expired facts, missing evidence, conflicts or failed imports. The current uLiquid Marketing Profile is v1, English, with one primary CTA per item and zero approved assets. The assigned uLiquid Telegram Postiz integration is `cmu9g999m0001o18n6dfzymud`. The verified beta-registration fact names `https://desk.uliquid.vip/en/register`; its origin is `https://desk.uliquid.vip`. The example product-control fact is verified, public-use and model-use allowed, but its source `d7f6ff20-4e8c-43dd-941a-ecff25b2b66c` is among the stale-source warnings. Its currentness requires owner review before use in acceptance.

**Deterministic Phase 6 blocker:** Active policy v1 has `channels=["internal"]`, `contentTypes=["script"]`, `allowedOrigins=[]`, `maxPerDay=0`, `approvedPaidTests=true`, and $10 daily/monthly/per-run ceilings. `createProposal()` rejects the assigned Telegram integration with `CHANNEL_NOT_APPROVED` and the beta-registration origin with `LINK_NOT_ALLOWED`; social preflight also rejects the content type. A paid Chat/proposal/generation run cannot satisfy the Golden Path under this mandate. No policy was broadened, and no paid run was started to rediscover this deterministic failure. A narrowly scoped owner decision is required for one Telegram `social` draft using that integration and official origin, within the current budget and policy window, while retaining `observe`, `test`, disabled external writes and zero public publication. A separate owner decision is required to select/approve a uLiquid brand asset before the asset/visual acceptance step. The five stale sources and selected product/CTA fact need currentness and rights review; off-host restore/key recovery remains open before broader live-write enablement.

**Costs / external effects:** Paid AI cost $0; new RAG evaluation 0; index activation 0; Postiz/Drive writes 0; social posts 0; public publications 0. Production effects were the approved code deployment, its migration runner (exit 0, no new release migration), and the on-host backup. Read-only UI, database status and runtime-flag checks followed.

**Next action:** Obtain the precise Phase 6 policy/paid-draft and brand-asset decisions; verify the chosen current fact and official CTA. Then run one bounded English Telegram draft through evidence, claims, guardrails, review and controlled handoff, recording model/cost/content/asset/Drive evidence. Keep Postiz schedule/live and all external publication disabled.

### 2026-09-26 16:23 CEST -- Authorized Phase 6 live attempt and focused repair

**Repo SHA before:** `6f679becad065f6b4f07a1add26a7a68a5dcd67e` (`main`; local correction pending).
**Repo SHA after:** This focused repair commit (see Git history).
**Deployment SHA:** `6f679becad065f6b4f07a1add26a7a68a5dcd67e` at the live attempt; the repair is not deployed.
**Status:** Phase 6 IN_PROGRESS. `ULIQUID_DRAFT_PRODUCTION_READY = NO / NOT YET ACCEPTED`.

**Inspected:** The verified, public/model-authorized `product.user_control` fact, official public uLiquid platform page, beta-registration URL fact, current project policy/profile, assigned Telegram integration, active Knowledge generation 2, asset library, Content Studio, Calendar, budget, runtime flags, Worker and Outbox. The public website review supports current wording but does not clear Orbit's five stale-source sync warnings. An authenticated visit to the registration URL redirected to an existing Desk session; anonymous registration was not proven.

**Production preparation:** Mario authorized a narrow internal Telegram social draft policy, one paid OpenAI run within the existing $10 daily/monthly/per-run caps, the exact `Explore the beta` CTA and official Desk registration URL, and approval of the selected Drive logo. Before those writes, a custom-format PostgreSQL dump was saved at `/root/orbit-backups/20260926T1318Z-pre-phase6-policy.dump` (1,154,781 bytes, mode 600). `pg_restore -l` returned 243 lines; host/container SHA-256 agreed: `ca72c4a464f5022ca689dfeab19a660b85b52083c47ed910d02efd05272850b`. This is an on-host backup, not an off-host restore proof. A new active policy record permits `internal` and the assigned Telegram integration `cmu9g999m0001o18n6dfzymud`, `script` and `social`, and `https://desk.uliquid.vip`, from 2026-09-26 13:00Z to 2026-10-18 15:00Z; mode remains `observe`, `maxPerDay=0`, `approvedPaidTests=true`, and the existing $10 caps remain. The new record displays entity Version 1 even though it replaces the prior policy, so its displayed version is not a sequential policy revision. The Drive logo was imported without a Drive write and approved in Orbit as asset `cfe2bfa8-ef84-4a30-93bc-96cf863d307a`. Marketing Profile v2 adds only the exact CTA and retains existing guardrails. One old profile-v1 test draft moved to needs review; no schedule was created.

**Paid run outcome:** One private uLiquid Orbit Chat run completed. It identified the product-control fact (`53684847-55b5-4976-a19f-14d50d270a01`, source `3095efb4-aa01-432f-a64d-11191e257aa3`) and official registration fact (`2c4845f9-7f50-4dc1-b818-9ff861144416`). Chat reported hybrid retrieval on active generation 2, but a broad search produced `insufficient_evidence` and `fact_context_limit`. The model also found profile v1 did not yet authorize the exact CTA and exact asset-ID lookup returned no approved asset despite the asset's approved state. It saved no proposal, mission, new draft or visual. Profile v2 was saved after the run; no second paid call was made.

**Changed locally:** `knowledge_search` now accepts up to eight exact fact keys and the Chat instruction directs their use when supplied by the user. `approved_assets` now matches an approved asset's exact ID as well as its data. The focused integration test checks both routes. Server-side evidence validation, approval filtering, budget limits, generation guardrails and publication gates remain in place.

**Verification:** Pinned Node 24.18.0: focused Chat integration 8/8, full Vitest 333/333 across 26 files, lint, typecheck and production build passed. Local Playwright browser acceptance passed 9/9 with isolated API, Worker, PostgreSQL and Redis; Framework Check and bounded secret scan passed; dependency inventory recorded 406 entries and `pnpm audit --audit-level high` found zero advisories. The source checkout under Documents had 10,468 dataless installed package files, causing misleading module-load failures. An exact-SHA fresh GitHub clone with the identical code/documentation diff and 0 dataless packages supplied the full passing validation. The local Worker test initially timed out while scanning 1,458 old synthetic projects; it passed against a freshly migrated isolated local database. No production or paid-provider action was used in these checks. The final live Golden Path has not been rerun on the corrected revision.

**Costs / external effects:** Approximate new paid OpenAI spend $0.03 (observed project spend $0.11 → $0.14; reserved $0.03 unchanged). No new RAG evaluation or index activation. Orbit policy/profile/asset writes occurred as authorized. Drive writes 0; Postiz writes 0; social posts 0; public publications 0. Runtime stayed `EXECUTION_MODE=test`, `ENABLE_EXTERNAL_WRITES=false`; Worker ready and Pending Outbox 0 at the last live check.

**Open blockers:** Local repair is not deployed; a second paid run is outside the one-run authorization. Stale-source sync warnings, anonymous registration destination, actual proposal→mission→draft→review→asset→handoff acceptance, and off-host restore/key recovery remain unproven. No claim of `ULIQUID_DRAFT_PRODUCTION_READY = YES` is justified.

**Next action:** Review the focused commit, deploy it only with a specific production release approval, then separately authorize one additional bounded paid acceptance run. Keep external writes disabled and prohibit schedule/live publish.

### 2026-09-26 18:14 CEST -- Phase 6 repair deployed; one authorized acceptance run blocked at proposal

**Repo SHA:** PR #6 head `5299e02a7cee7f83b2af75166b243a261d3e24e4` was merged into `main` as `4ab48c3b3edb51e13fc7630a056300caa3113bdd`. All three PR checks and both `main` checks passed. **Deployment SHA:** Coolify deployment `mitaovpqbbxy42uayne9ikfv` finished for `4ab48c3b3edb51e13fc7630a056300caa3113bdd`; the application and new API, Web, Worker, Redis and PostgreSQL containers were healthy. Zero unfinished Prisma migrations were observed after deployment.

**Pre-deploy safety:** Mario approved this exact release and one additional paid internal uLiquid Telegram draft acceptance run. The fresh owner-only dump `/root/orbit-backups/20260926T1510Z-pre-phase6-chat-repair.dump` is 1,162,562 bytes, mode 600, SHA-256 `11d624d238cf47b1273b9ff7501c0d9e0583ad357cf0a34cda7d15d168070dec`; `pg_restore -l` listed 243 lines and a full `pg_restore -f /dev/null` archive read exited 0. This is on-host backup validation, not a production restore drill. Runtime flags remained `EXECUTION_MODE=test`, `ENABLE_EXTERNAL_WRITES=false`, `LIVE_RAG_EVAL_PASSED=false`. The project remained in `observe`, with the existing narrow Telegram/social/Desk-origin policy, `maxPerDay=0`, approved paid tests and $10 daily/monthly/per-run ceilings. Profile v2, the approved logo, Knowledge generation 2 with 54 chunks, Worker ready and Pending Outbox 0 were verified before the run. Five stale sources and one older dependent content item with missing evidence remained visible.

**Single paid acceptance result:** One new Chat run `03750b27-9300-445a-8c5a-ccf7a5b0117a` completed on the deployed SHA. It used exact `factKeys` for `product.user_control` and `url.beta_registration`, reported hybrid retrieval on active index generation 2, returned the selected public/model-authorized product-control and official-link facts, and found approved logo `cfe2bfa8-ef84-4a30-93bc-96cf863d307a` version 2 by exact ID. The selected product fact's source is `d7f6ff20-4e8c-43dd-941a-ecff25b2b66c`, which still has a stale-source warning. The model's `propose_campaign` tool returned the generic `CHAT_FAILED` code; no proposal, mission, job, new draft, review, visual or handoff resulted. The underlying tool exception or model tool-call payload is not persisted by the current runner, so its precise cause is unproven. Do not attribute it to retrieval, asset rights or a specific mission field without further evidence.

**Cost and external effects:** Five Chat text reservations and one query embedding settled for 54,889 USD millionths ($0.054889). The Overview rounded project spend from $0.14 to $0.18; the existing $0.03 reservation remained. No additional paid run, RAG evaluation, index activation, Drive/Postiz write, schedule, social post or public publication occurred. The one-run mandate is consumed. `ULIQUID_DRAFT_PRODUCTION_READY = NO / NOT YET ACCEPTED`.

**Local diagnostic verification (18:34 CEST):** The runner's generic `CHAT_FAILED` handling is reproduced with an invalid `propose_campaign` payload. The local change reports only bounded, sanitized invalid field paths for Zod validation errors; other errors and all proposal, policy, evidence and write gates remain unchanged. A regression checks that an invalid input value is not echoed and no proposal is saved. On pinned Node 24.18.0 in a fresh checkout with a newly migrated, isolated local database: full Vitest suite **334/334 tests, 26/26 files PASS**; final focused Chat suite **9/9 PASS**; Chromium Playwright **9/9 PASS** on a separate synthetic browser database; lint, typecheck, production build, Framework Check (0 errors/0 warnings), Coolify Compose check, secret scan (542 candidate files), runtime artifact scan (39 files against six local credential values), dependency audit (no known vulnerabilities) and `git diff --check` PASS. The older checkout's initial full-suite run hit local synthetic-data and cloud-file issues; the fresh checkout run is the valid complete result. This diagnostic does not prove the cause of the live `CHAT_FAILED` or authorize a deployment or paid retry.

**Next action:** Diagnose the proposal failure without another paid or external call. A local diagnostic change now returns sanitized invalid field names if the failure was Zod validation; it does not establish the cause of the live failure and is not deployed. Review and test that change, then seek separate release and paid-run authorization for another live Golden Path attempt. Keep external writes disabled. Phase 7 remains gated by Phase 6 acceptance.

### 2026-09-27 08:06 CEST -- Phase 6 diagnostics released; paid acceptance pending authenticated access

**Repo SHA:** PR [#7](https://github.com/eds-labs/eds-orbit/pull/7) head `7b94c61dbfe5bb4bcf65ce00f96fc667c64b33a2` was merged into `main` as `a1bd64393c26ed28f74b1004941e2e3441e0de72` at 05:48:08 UTC. All three PR checks and both [Framework Check](https://github.com/eds-labs/eds-orbit/actions/runs/36298250200) and [Orbit acceptance](https://github.com/eds-labs/eds-orbit/actions/runs/36298250207) on `main` passed. **Deployment SHA:** Coolify webhook deployment `tgaarrfyvk0sf7tyshgeuduf` finished at 05:52:30 UTC for the exact merge SHA. The application is `running:healthy`; Web, API, Worker, Redis and PostgreSQL containers each reported healthy after rollout. The public web entry returned HTTP 200 with valid TLS; zero unfinished Prisma migrations were observed. Coolify runtime logs require `read:sensitive` permission and were not available through the read-only release token.

**Pre-release safety and rollback:** Mario approved the focused release and exactly one additional bounded paid internal uLiquid Telegram draft acceptance run. Before merge, an owner-only custom-format production dump was created at `/root/orbit-backups/20260927T0545Z-pre-phase6-proposal-diagnostics.dump` (1,166,368 bytes, mode 600, SHA-256 `771cfa69c7705c5d3cb06edb350159a22c406d36283a8a1db08373a0fe767dca`). The dump listed 243 archive entries and passed a full `pg_restore -f /dev/null` archive read. This proves archive readability on the host, not an off-host restore or key-recovery drill. The previous deployment SHA `4ab48c3b3edb51e13fc7630a056300caa3113bdd` remains the code rollback target. Post-release API flags remained `EXECUTION_MODE=test`, `ENABLE_EXTERNAL_WRITES=false`, `LIVE_RAG_EVAL_PASSED=false`; no publication path was enabled.

**uLiquid acceptance state:** The pre-release authenticated project check still showed `observe`, the narrowly approved internal/Telegram social policy with official Desk origin, `maxPerDay=0`, approved paid tests and $10 daily/monthly/per-run ceilings, marketing profile v2, one approved logo asset and connected Drive. The newly released diagnostic changes only the model-facing feedback for invalid proposal fields; it does not establish the cause of the previous live `CHAT_FAILED`. A fresh authenticated browser session was unavailable after rollout: the existing Chrome window could not be attached for control, while the Orbit in-app browser requested sign-in. No credential was copied, no production data or policy was changed, and the newly approved paid run has **not** started. Current post-release facts, rights, budget and source freshness must be rechecked after sign-in before any paid call.

**Cost and external effects:** $0 new AI spend; no OpenAI call, RAG evaluation, index activation, Drive/Postiz write, schedule, social post or public publication in this work block. The only production mutation was the approved code deployment. `ULIQUID_DRAFT_PRODUCTION_READY = NO / NOT YET ACCEPTED`. **Next action:** Use an authenticated Orbit session to repeat the uLiquid preflight, then execute exactly one bounded internal draft acceptance run under the already granted approval. If the proposal still fails, capture the sanitized diagnostic and stop without a paid retry. Phase 7 remains gated by Phase 6 acceptance.

### 2026-09-27 08:20 CEST -- Phase 6 single paid acceptance failed at proposal validation

**Repo/deployment SHA:** The running `main` and Coolify deployment remained `a1bd64393c26ed28f74b1004941e2e3441e0de72`. The uLiquid project remained in `observe` with marketing profile v2, active knowledge generation 2 (54 chunks), the approved Telegram/internal `social` policy, $10 daily/monthly/per-run paid-test limits and approved logo `cfe2bfa8-ef84-4a30-93bc-96cf863d307a`. Five source-freshness warnings and one old content item's missing-evidence warning remained. The selected public/model-authorized fact keys were `product.user_control` and `url.beta_registration`; their source `d7f6ff20-4e8c-43dd-941a-ecff25b2b66c` still carried a stale-source warning. The OpenAI settings dialog reported no saved application-level configuration and no usable image key; the settled paid text run proves a working runtime text route, not image readiness. Drive remained connected; Postiz Telegram/X were assigned; Matomo's last read verification remained 2026-09-22. Runtime flags remained `EXECUTION_MODE=test`, `ENABLE_EXTERNAL_WRITES=false`, `LIVE_RAG_EVAL_PASSED=false`.

**One-run result:** In an authenticated Orbit browser session, exactly one bounded internal English uLiquid Telegram draft request was submitted. Chat run `6efcbc28-7c82-4e1b-b316-e6e69fef29cc` finished with one proposal-save attempt. Its visible knowledge card reported hybrid retrieval on index generation 2, and the approved logo was found by exact ID. The proposal action returned `PROPOSAL_VALIDATION_FAILED` with invalid paths `goal`, `channels`, `startAt`, `endAt`, `targetAction` and `mission`. The model reported the failure and made no second proposal attempt. No proposal, mission, new draft, review, visual or handoff resulted. The exact raw tool-call payload was not persisted; the missing-field feedback proves the server validation failure, while the precise model-side cause remains unproven. The job was marked succeeded at the run level, so that status must not be treated as draft acceptance.

**Cost and external effects:** Six reservations for this run (five `chat_text`, one `query_embedding`) were read back as settled. Their settled total was 35,024 USD micros ($0.035024); no reservation from this run remained unresolved. The UI rounded project spend to $0.21 and still displayed a pre-existing $0.03 reservation. There was no new RAG evaluation, index activation, Drive/Postiz write, schedule, social post or public publication. Worker heartbeat was ready and pending outbox was zero. The approved one-run mandate is consumed. `ULIQUID_DRAFT_PRODUCTION_READY = NO / NOT YET ACCEPTED`.

**P0 blocker / next action:** The model-facing `propose_campaign` tool exposes `mission` only as an untyped object although the server requires a strict mission contract. Inspect and locally test a complete tool schema that names the required mission fields while retaining Zod validation, evidence, budget, policy and safety gates. A new production deployment and paid acceptance run need their own concrete approval; Phase 7 remains gated by Phase 6 acceptance.

### 2026-09-27 08:41 CEST -- Phase 6 proposal tool schema corrected locally

**Repo/deployment SHA:** The focused code correction is commit `68831ff677da1149d1d40c61c645d076db78ce1d` in draft PR [#9](https://github.com/eds-labs/eds-orbit/pull/9). Production still runs `a1bd64393c26ed28f74b1004941e2e3441e0de72`; the correction is **not deployed or uLiquid-accepted**.

**Inspected and changed:** The model-facing `propose_campaign` tool previously declared only `mission: { type: "object" }`, while `createProposal()` applies the strict Mission Zod schema and campaign context checks. The tool now names the mission fields required for a saveable draft, including assigned/policy-approved channel IDs, UTC period, content count/type, primary CTA, exact official target URL, source IDs, campaign type and current profile version. It omits `allowedActions`; the server continues to force `draft` and independently validates the payload, facts, source rights, asset approval, budget, active index, policy and project scope. A mocked-provider regression inspects the actual tool definition against server-required fields; the invalid-proposal diagnostic and no-save assertion remain covered. This improves the contract but does not prove why the model omitted fields in the live call, since raw tool arguments were not persisted.

**Verification:** On Node 24.18.0 and a freshly migrated isolated local database, focused Chat integration **9/9** and full Vitest **334/334 in 26 files** passed. On a separate synthetic browser database, Chromium Playwright **9/9** passed. Lint, typecheck, production build, Framework Check (0 errors/0 warnings), Coolify Compose check, secret scan (542 candidate files), runtime-artifact scan (39 generated files against six local credential values), dependency audit (no known vulnerabilities), Prettier and `git diff --check` passed. The first full-suite attempt used an older accumulated local database and timed out on one Worker acceptance; the fresh isolated full rerun passed. PR #9 CI was still running when this entry was written.

**Cost/external effects and next action:** $0 additional AI spend; no new paid provider call, RAG evaluation, index activation, production data change, Drive/Postiz write, schedule, social post or publication. Review PR #9 and its CI, then seek separate approval for its production release and exactly scoped paid acceptance if still needed. Keep external writes disabled. Phase 6 and `ULIQUID_DRAFT_PRODUCTION_READY` remain unaccepted; Phase 7 remains gated.

### 2026-09-27 09:45 CEST -- PR #9 released; one Chat proposal confirmed, generation deferred

**Repo/deployment SHA:** PR [#8](https://github.com/eds-labs/eds-orbit/pull/8) merged as `cb7384c8db461508d9372184ea5af49a6409181c`. Contrary to the assumed path filter, its documentation-only merge triggered Coolify deployment `qpvbcoykrjfhjsiwtmg6ryob`, which finished with all five services healthy and identical application code. After explicit owner approval, PR [#9](https://github.com/eds-labs/eds-orbit/pull/9) merged as `dcc9146caff40043126ba6a7d08171d7cd6c7fc5`; Coolify deployment `w6ps8ifl2rf7se7tgxbzawbj` finished at 07:23:35 UTC on that exact SHA. Both `main` CI workflows passed. All five new services are healthy, no unfinished Prisma migration exists, and the authenticated uLiquid UI loads. The pre-release `/root/orbit-backups/20260927T0715Z-pre-pr9.dump` is a 1,162,956-byte, root-owned mode-0600 custom archive that passed a complete read through `pg_restore -f /dev/null`. Off-host restore is still unverified.

**Runtime and project preflight:** API `EXECUTION_MODE=test`, `ENABLE_EXTERNAL_WRITES=false`, `LIVE_RAG_EVAL_PASSED=false`; project `observe`, external writes disabled, channel write verification required. The active policy (2026-09-26 to 2026-10-18) allows `social` for assigned Telegram integration `cmu9g999m0001o18n6dfzymud` and official origin `https://desk.uliquid.vip`, with approved paid tests and $10 daily, monthly and per-run ceilings. Profile v2 and one approved logo remain configured. The worker is healthy. No new RAG evaluation or index activation occurred.

**Single approved Chat run:** Chat job `03338f3f-8f19-43f0-b643-7d90a7145238` succeeded. Exact-key `product.user_control` and `url.beta_registration` lookup reported hybrid retrieval on active index generation 2. The approved logo `cfe2bfa8-ef84-4a30-93bc-96cf863d307a` was returned by exact ID. Proposal `e7f2da6d-700f-4b82-8b62-9daee51262cb` passed confirmation and created Mission `6a08bbe4-c3f4-40e4-81d2-85d1a378ded1`, targeting one draft-only English Telegram product item with `Explore the beta` and the official beta registration URL. Six Chat reservations settled for exactly $0.037793. No further Chat request or RAG evaluation was made.

**Generation stop and pending decision:** Confirmation created generation job `132462b7-07e8-42c0-9362-644a763094a3`, `queued`, zero attempts, with its undispatched Outbox event available only on **2026-09-28 09:00 UTC**, matching the requested Mission start. An additional manual `Run mission` click returned `MISSION_NOT_ACTIVE` because the period is still in the future; the server enqueued no second job. The worker has made no generation request and no generation cost has been charged. The job's standard `maxAttempts` is 3, which needs an explicit disposition under the owner's no-retry constraint. The Content Studio still lists only three earlier items; no new draft, review result, visual, Drive save, Postiz handoff, social schedule or publication exists. The single future Outbox entry is an **internal generation job**, not an external post. A specific owner decision on keeping or stopping that queued job is pending; do not silently shift its period, create another paid proposal, or proceed to Phase 7. `ULIQUID_DRAFT_PRODUCTION_READY = NO / NOT YET ACCEPTED`.

### 2026-09-28 08:34 CEST -- Deferred Phase 6 job audited; one-draft correction prepared locally

**Repo/deployment SHA:** Local branch `codex/orbit-phase6-live-record-20260927` at `a273a945d2eee0e00f11a0d0a65179b804e40be7` before the new correction commit; draft PR [#10](https://github.com/eds-labs/eds-orbit/pull/10) remains open. Running production revision remains `dcc9146caff40043126ba6a7d08171d7cd6c7fc5`. This entry supersedes the malformed generation Job ID in the prior record: the verified ID is `132462b7-07e8-42c0-9362-644a763094a3`.

**Current uLiquid state:** The confirmed proposal `e7f2da6d-700f-4b82-8b62-9daee51262cb` and Mission `6a08bbe4-c3f4-40e4-81d2-85d1a378ded1` remain the authorized draft-only path. Read-only production verification at 05:35–05:40 UTC found the generation Job queued with zero attempts, its sole Outbox event undispatched and due at 09:00 UTC, and zero Content rows for the Mission. API and Worker run `EXECUTION_MODE=test`, `ENABLE_EXTERNAL_WRITES=false`, and `LIVE_RAG_EVAL_PASSED=false`; project mode is `observe`. The deployed Worker would take the deterministic synthetic generation branch at the due time, which cannot establish paid AI draft acceptance. This is a Phase 6 P0 release gap, not evidence of an accepted draft.

**Local correction:** An owner-only, explicitly confirmed action advances only the exact confirmed, future, draft-only Mission and its original queued generation Job. It checks project scope, policy, the $10 per-run ceiling, zero attempts, zero existing Mission content/reservation and one undispatched Outbox event in one transaction; it sets the job to one attempt and an immediate due time. The Worker runs paid generation for that marked job while the global test mode and external-write block stay in place, skips automatic review/publication, and blocks ambiguous or failed outcomes without retry. The ordinary `Run mission` path reuses an existing pending job to avoid a duplicate after Mission version changes. No schema, secret or provider configuration changes are proposed.

**Verification and open blockers:** Four focused API/DB integration tests passed locally; typecheck, lint, build, framework validation, bounded secret scan and high-severity dependency audit passed. The existing real-Redis Worker lifecycle test timed out at its 20-second acceptance wait on this local host, and browser/full-suite checks are pending at this record point. The new code is not deployed or accepted. Production backup/restore, green PR CI, deployed SHA/flags, the exact one-run result, evidence/claims, review, approved asset and controlled export remain required. Phase 7 stays gated; `ULIQUID_DRAFT_PRODUCTION_READY = NO / NOT YET ACCEPTED`.

**Cost/external effects and next action:** $0 additional AI cost and zero production data mutation, new evaluation, index activation, Drive/Postiz write, schedule or publication in this work block. Complete relevant checks and PR review; then obtain a specific owner approval for this new PR #10 release and the exact once-only action before production mutation. If the 09:00 UTC queue deadline arrives first, stop and re-audit the Job and Mission rather than assuming the approved paid run is still possible.

### 2026-09-28 08:49 CEST -- PR #10 acceptance green; production remains untouched

**Repo/deployment SHA:** Branch commit `11a193a556ba639fc4beae95d4adc2bafd57b21f` is pushed to draft PR [#10](https://github.com/eds-labs/eds-orbit/pull/10) against production `main` `dcc9146caff40043126ba6a7d08171d7cd6c7fc5`. The PR is mergeable and remains unmerged. No new deployment SHA exists.

**Verification:** Both isolated Orbit acceptance checks passed, including local setup, full Vitest, TypeScript, lint, build, bounded secret scan, dependency inventory, high-severity audit and all nine Playwright browser checks. The framework check passed. Locally, four focused API/DB integration cases and 132 unit tests passed; local build, lint and typecheck passed. The local real-Redis Worker lifecycle test timed out at its 20-second wait, and a local Playwright invocation could not connect because the app server was not started; the complete isolated CI equivalents passed and are the release gate. No live uLiquid draft acceptance is implied by green CI.

**Fresh production read:** At approximately 06:46 UTC the exact generation Job `132462b7-07e8-42c0-9362-644a763094a3` remained `queued`, attempts `0`, maxAttempts `3`; there were zero Content rows for Mission `6a08bbe4-c3f4-40e4-81d2-85d1a378ded1` and one undispatched Outbox event. The 09:00 UTC due time is unchanged. No paid call, production mutation, external provider write, schedule or publication occurred in this work block.

**Decision gate:** The prior approval covered PR #9 and a bounded run, not the new owner action and Worker code in PR #10. Before merge/deployment and the exact one-time paid action, obtain explicit owner approval for this reviewed release. Recheck the Job, flags, policy and backup immediately before acting. If the due time is reached or the state changes first, stop for a fresh decision. `ULIQUID_DRAFT_PRODUCTION_READY = NO / NOT YET ACCEPTED`; Phase 7 remains gated.

### 2026-09-28 11:03 CEST -- Approved PR #10 release stopped after scheduled Job failed

**Repo/deployment SHA:** Branch `f428edf09e5e3bfff39d6423612eb1f7703e4c83`; production `main` and running application remain `dcc9146caff40043126ba6a7d08171d7cd6c7fc5`. PR [#10](https://github.com/eds-labs/eds-orbit/pull/10) remains draft, open and unmerged. All PR checks passed. Mario explicitly approved that PR and exactly one paid internal draft run; no deployment or paid action followed because the production Job precondition changed at its scheduled time.

**Preflight and backup:** Immediately before 09:00 UTC, exact Job `132462b7-07e8-42c0-9362-644a763094a3` was `queued`, attempts `0`, maxAttempts `3`. API and Worker both reported `EXECUTION_MODE=test`, `ENABLE_EXTERNAL_WRITES=false`, `LIVE_RAG_EVAL_PASSED=false`. A fresh root-only PostgreSQL custom archive `/root/orbit-backups/20260928T0855Z-pre-pr10.dump` was created with mode `0600`, 1,173,571 bytes, and fully read through `pg_restore -f /dev/null` inside the PostgreSQL container (exit 0). No restore was executed.

**Stop condition and actual result:** At 09:00 UTC, before the new code could be safely deployed, the existing Worker consumed the scheduled Job once. Read-only SQL then showed `blocked_dependency`, attempts `1`, maxAttempts `3`, error `INSUFFICIENT_EVIDENCE`, zero Content rows for Mission `6a08bbe4-c3f4-40e4-81d2-85d1a378ded1`, and zero BudgetReservation rows keyed to that Job. The proposed owner action requires a queued zero-attempt future Job and can no longer apply. Do not change the Job or Mission directly, retry it, create another proposal, merge PR #10 as though it still completed Phase 6, or proceed to Phase 7.

**Costs/external effects:** No new paid generation reservation or draft was observed; no RAG evaluation, index activation, Drive/Postiz write, schedule or public post was performed in this work block. The production Worker itself updated the Job to a blocked state. The only operator-side production effect was creation of the on-host backup; no application deployment or manual production-data write occurred. `ULIQUID_DRAFT_PRODUCTION_READY = NO / NOT YET ACCEPTED`.

**Next decision:** Investigate the exact evidence failure read-only and determine whether the existing verified facts or the Mission retrieval contract caused it. Then propose a minimal evidence-safe correction and a new, explicitly scoped one-attempt acceptance path with fresh owner approval if it requires another paid call or production mutation. Retain the no-retry and no-publication boundaries. PR #10 must be updated or superseded for the new state before any release.

### 2026-09-28 13:15 CEST -- Phase 6 evidence diagnosis and bounded recovery prepared locally

**Repo/deployment SHA:** Local branch `codex/orbit-phase6-live-record-20260927` starts this work block at `3e0a86c557471b409d4c65b7a17e02d8bac23edc`; the running production revision remains `dcc9146caff40043126ba6a7d08171d7cd6c7fc5`. PR [#10](https://github.com/eds-labs/eds-orbit/pull/10) is still draft, unmerged and undeployed. Mario approved continuing this bounded correction and requested a handover at a clean stopping point. No production release or paid call is included before that handover.

**Read-only diagnosis:** The exact Mission goal and its two source IDs were checked against production. Both sources are active official sources with public/model rights and verified English `product.user_control` Facts; the confirmed Chat Proposal has four Fact references, including `product.user_control` and the beta-registration URL. Earlier Chat Evidence with exact keys is `ready` in hybrid mode. The Mission did not carry an exact `factKeys` input into its scheduled deterministic retrieval. Its broad goal matches 28 verified Facts lexically; a local real-SQL regression fixture reproduces `fact_context_limit` and `insufficient_evidence` for a similarly broad query. The failed production Evidence row was rolled back with the job transaction, so the exact production gap array is unavailable. The old Worker took the deterministic test branch, and the error occurred before a paid generation reservation.

**Minimal correction:** Confirmed Chat Missions with exact dotted `allowedTopics` now pass those keys to deterministic and paid hybrid retrieval; the existing source, validity, model-use, context and missing-Fact checks still apply. The owner-only action can recover only the exact original generation Job after one terminal `INSUFFICIENT_EVIDENCE` attempt and a delivered Outbox event. It checks no other Mission job, Content or old Job reservation, enforces project observe mode, safe runtime flags, the active paid mandate and the $10 per-run ceiling, then creates one new Job with `maxAttempts=1` and a separate audit event. The original blocked Job remains unchanged. The UI states this condition and requires the explicit paid-draft checkbox. No schema, secret, provider or safety-flag change is proposed.

**Verification:** 46 focused API integration tests passed, including broad-query overflow, exact-key live generation, successful single-job recovery and rejection when the old Job has a reservation. Local TypeScript typecheck, lint, production build, framework check, bounded secret scan, dependency inventory and high-severity audit passed. The full local Vitest run hit the existing real-Redis Worker lifecycle 20-second timeout and was stopped after it stalled; a second run excluding that suite passed 335 tests in 25 files but the Auth integration setup timed out and skipped its five cases. Playwright and isolated PR CI for this correction remain open. No test result is counted as live uLiquid acceptance.

**Cost/external effects and next action:** Zero new AI cost, evaluation, index activation, production-data mutation, Drive/Postiz write, schedule or publication in this work block. A second read at approximately 13:20 CEST found the original Job still `blocked_dependency` after one attempt with `INSUFFICIENT_EVIDENCE`, exactly one dispatched Outbox event, zero Mission Content, zero reservations referencing that Job and exactly one generation Job for the Mission. Finish diff and security review, commit and push the bounded correction to draft PR #10, and require green isolated CI before any release. Recheck the policy, safety flags, backup and Mission expiry immediately before any later approved deploy/action. On a changed state or unknown provider outcome, stop without retry. `ULIQUID_DRAFT_PRODUCTION_READY = NO / NOT YET ACCEPTED`; Phase 7 remains gated.

## Production Change Plan -- Phase 6 evidence-scoped recovery (prepared; not executed)

**Goal and risk:** Release the reviewed exact-key retrieval correction and owner-only recovery action, then create at most one new paid internal Telegram draft Job for the same confirmed Mission. Production release and Job creation are critical; the bounded OpenAI call is high risk. This plan does not authorize a public post, Postiz/Drive write, schedule, index activation or new evaluation.

**Preflight and backup:** Require green isolated PR CI, a reviewed diff, the intended merge/deployment SHA, healthy API/Web/Worker, the current uLiquid owner session, observe project mode, active mandate with the $10 per-run ceiling, exact confirmed proposal, approved asset and current Fact/source rights. Read the old Job, Outbox, Mission, all generation Jobs for that Mission, Content and budget reservations again. Check `EXECUTION_MODE=test`, `ENABLE_EXTERNAL_WRITES=false`, `LIVE_RAG_EVAL_PASSED=false`, and an unexpired Mission. Create and fully read a fresh restricted PostgreSQL custom archive immediately before any deployment; the earlier `20260928T0855Z` archive predates the Job failure and is not the fresh release backup. Do not proceed on an ambiguous paid/provider outcome or changed state.

**Release and single action:** Merge/deploy only the reviewed PR, then verify all running service revisions, health, migration status and safety flags. Invoke the owner action once with its explicit paid-internal-draft confirmation. The transaction must leave the old blocked Job unchanged and create exactly one new `liveDraftOnce` Job with `maxAttempts=1`. Watch that Job to a terminal state; after any failure or uncertain transmission, do not retry. Inspect the resulting Content, Evidence, Claims, reviewability, approved asset, actual settled model/cost and no-publication proof before changing Phase 6 acceptance.

**Rollback, monitoring and communication:** Keep external writes disabled. On a code fault, redeploy the prior known-good SHA and preserve all Job, audit, reservation and Content records; do not roll back or replay a transmitted paid call. No schema migration is planned. Monitor Worker/outbox status, single attempt count, exception/audit events, budget journal, Content count and publication/schedule absence. Report the observed result and any blocker to Mario before Phase 7.

## Production Change Plan -- Phase 6 one-draft correction (halted after Job state changed)

### Ziel

Release the bounded early-start action for the already confirmed uLiquid Telegram Mission, then run at most one paid internal AI draft and verify the Phase 6 Golden Path without external publication.

### Betroffene Systeme

Orbit API, Web and Worker release image; the existing uLiquid Mission, Job and Outbox row; OpenAI text generation under the active project policy. No Postiz, Drive or social-provider write is included.

### Risiko-Level

Critical for the production release and the production Mission/Job transaction; high for one paid provider call. The release touches an owner-only action and a durable Worker path. Stop on changed authorization, policy, safety flags, Job state or unexpected deployment/migration effects.

### Change Steps

1. Verify `main`, PR #10 diff/CI, running SHA, service health, backup location, active uLiquid policy/profile/asset, exact proposal/Mission/Job/Outbox state and remaining time before 09:00 UTC.
2. After specific owner approval, create and fully read a fresh mode-0600 PostgreSQL custom-format backup; deploy the reviewed PR while retaining `EXECUTION_MODE=test` and `ENABLE_EXTERNAL_WRITES=false`.
3. Verify all running service image SHAs, health, migration status, owner action availability, project mode and unchanged safety flags. Stop on any mismatch.
4. With the same exact owner mandate and only if the original Job is still queued at zero attempts, invoke the owner action once. Observe the Job and budget reservation until a terminal state; do not retry a failure or uncertain outcome.
5. If a real draft exists, inspect its model/cost, active knowledge evidence and claims, guardrails, reviewability, approved brand asset and controlled export. Record the Content ID and no-publication proof. Advance Phase 7 only after Phase 6 acceptance.

### Datenbank/Migrationen

No schema migration. The approved action updates one Mission, one Job and one Outbox event atomically with an audit event. Never edit these production rows directly as a workaround. If the scheduled old Worker consumes the job first, stop for a new state-based decision.

### Secrets/Config

No secret or configuration change. Verify only safe flag values; do not display credentials.

### Tests vor Deploy

Focused API integration and Worker safety checks, full relevant unit/integration suite, TypeScript typecheck, lint, build, Playwright, framework check, bounded secret scan, dependency audit and green PR CI. Record any local environmental limitation without treating it as passed.

### Deployment Plan

Promote only the reviewed PR after owner approval and verified backup. Coolify may deploy on merge; treat the merge as the production release action. Do not run the paid job merely because the code deployed.

### Post-Deploy Checks

Compare image tags to the merge SHA across all services, verify health and no unexpected migration, read the exact job/outbox state and safety flags, then use the owner action once only if its full preflight still passes.

### Monitoring/Alerts

Watch Worker health, queue/outbox, Job attempt count and terminal status, exception/audit events, budget reservations and draft Content count. Alert the owner on any blocked or ambiguous outcome. Confirm no publication intent, external content-provider write, schedule or social post was created.

### Rollback/Forward-Fix

For a code fault, redeploy the prior known-good SHA with external writes disabled; preserve all Job, reservation and Content evidence. A claimed or transmitted paid call must not be retried after rollback. No schema rollback is needed. Preserve the fresh archive and document the state before any forward fix.

### Approval

- Required: yes, for the exact PR #10 production release and the once-only paid Mission action.
- Approved by: Mario for PR #10 and the exact one-run action; precondition failed before deployment, so no release or paid run was executed under this approval.
- Date: 2026-09-28.

## Production Change Plan -- Phase 6 correction (approved and executed; acceptance blocked)

### Ziel

Deploy the exact focused Chat fact-key and approved asset-ID lookup repair, then verify one reviewable uLiquid Telegram draft without public publication.

### Betroffene Systeme

Orbit API and Worker release image, Chat read tools, uLiquid internal draft workflow. No Postiz, Drive or social-provider write is planned.

### Risiko-Level

High: production deployment and a separately costed OpenAI acceptance run. The current code change does not alter authorization, project scope, budget enforcement or publication gates.

### Change Steps

1. Verify `main`, CI, current deployment SHA, flags, Worker, Outbox and current uLiquid policy/profile/asset state.
2. Take and verify a new owner-only pre-deploy PostgreSQL dump; deploy only the reviewed repair commit with external writes disabled.
3. Confirm running image SHA, healthy API/Web/Worker, zero pending migration surprises, the exact asset-ID and fact-key behavior, and unchanged safety flags.
4. After a separate bounded paid-run approval, execute one English Telegram internal draft Golden Path; record evidence IDs, model/cost, proposal/mission/content IDs, claim review, asset result and controlled export. Do not schedule or publish.

### Datenbank/Migrationen

No schema migration in this repair. Verify migration state before and after deployment; stop on unexpected migration activity.

### Secrets/Config

No secret or runtime-flag change. Keep `EXECUTION_MODE=test`, `ENABLE_EXTERNAL_WRITES=false`, project `observe`, and existing paid caps.

### Tests vor Deploy

333/333 Vitest, 9/9 Playwright, lint, typecheck, build, Framework Check, secret scan and high-severity dependency audit passed on the exact diff in a clean local clone. Require green CI for the release SHA before production deployment.

### Deployment Plan

Deploy the reviewed commit through the existing Coolify release path after Mario approves this specific production release. Do not treat a local test or push as deployment evidence.

### Post-Deploy Checks

Verify image SHA, health, current uLiquid policy/profile/asset, active Knowledge generation, budget, Worker/Outbox and flags. Run only read-only smoke tests until the separate paid acceptance mandate.

### Monitoring/Alerts

Watch deployment logs, Worker heartbeat, failed jobs, Outbox, project spend and exceptions during the acceptance window. Stop on unknown paid or external-write outcome.

### Rollback/Forward-Fix

Code rollback: redeploy `6f679becad065f6b4f07a1add26a7a68a5dcd67e` if the repair regresses; keep external writes disabled. Database: no migration or rollback expected; preserve the fresh backup and use a forward fix for any data issue. Provider configuration and credentials stay unchanged. Notify Mario of a failed deployment or blocked acceptance before further paid or external actions.

### Approval

- Required: yes, specifically for this new production deployment and separately for one more paid OpenAI run.
- Approved by: Mario, specifically for PR #6 deployment and one additional bounded paid internal acceptance run.
- Date: 2026-09-26.

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

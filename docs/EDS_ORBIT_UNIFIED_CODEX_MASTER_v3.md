# EDS Orbit — Unified Codex Master Specification v3

**Stand:** 17. September 2026  
**Revision:** 3 — integrierter Knowledge Layer, Hybrid RAG, Marketing Memory, Knowledge Health und geschlossene Betriebslücken  
**Status:** vollständiger Umsetzungsauftrag; keine implementierte Anwendung, kein ausgeführtes Serveraudit, keine Live-Abnahme  
**Marke:** EDS Labs · **Arbeitsname:** EDS Orbit · **Repository-Vorschlag:** `eds-orbit`  
**Framework:** Codex Project Framework 1.1.0 aus dem bereitgestellten Archiv

## Verwendung und Geltung

Diese Datei ist die **einzige konsolidierte Produktspezifikation** für den ersten Codex-Gesamtauftrag. Sie ersetzt `EDS_ORBIT_CODEX_MASTER_TASK.md`, `EDS_ORBIT_CODEX_MASTER_TASK_v2.md`, `EDS_ORBIT_UNIFIED_CODEX_MASTER.md` sowie den separaten VPS-Auftrag als einzeln zu verwendende Arbeitsdokumente. Die relevanten Inhalte der bisherigen Produkt- und Hosting-Planung sind hier enthalten; der vollständige lesende Infrastrukturauftrag steht in Anhang A. Frühere Dateien nicht zusätzlich als konkurrierende Masteraufträge einlesen.

Die tatsächlich geltenden lokalen `AGENTS.md`- und Framework-Sicherheitsregeln bleiben verbindlich. Diese Spezifikation ist kein Befehl, Toolsperren, Quality Gates oder zusätzliche Freigabeanforderungen zu umgehen. Bei Konflikten restriktive Grenze erhalten, Entscheidung dokumentieren und unabhängige reversible Arbeit fortsetzen.

**Entwicklung:** neue Orbit-Anwendung im Entwicklungsworkspace implementieren, isoliert testen und bis zum maximal erreichbaren integrierten Release Candidate bringen. **Bestandsinfrastruktur:** ausschließlich lesend inventarisieren und planen. Keine Bestellungen, Migrationen, Kündigungen, DNS-Änderungen, produktiven Deployments, Werbeausgaben oder realen Veröffentlichungen durch diesen Auftrag autorisiert. Desk und Forecast bleiben separat.

**RAG ist Pflichtumfang**, kein optionaler Anhang. Bestehende Agenten-, UI-, Sicherheits-, Kosten-, Publishing-, Hosting- und Testanforderungen werden durch die Wissensschicht ergänzt und dort mitverwendet. Ein Upload-Dialog ohne belegbaren Retrieval-/Publishing-Pfad erfüllt den Auftrag nicht.

### Orientierung

| Bereich | Inhalt |
|---|---|
| 0–2 | Auftrag, Framework, konkreter Stack, Governance |
| 3–7 | Produkt, Autonomie, Agenten, Jobs und echte Integrationen |
| 8–14 | EDS Liquid Glass, Sicherheit, Open Source, Umsetzung, Abnahme, Hosting |
| 15 | Strukturierte Fakten, Quellen, Hybrid RAG, Rechte, Evidence und Publikationsprüfung |
| 16 | Marketing Memory und kontrollierter Lernkreislauf |
| 17 | Onboarding, autonome Betriebsführung, Inhaltsqualität und Wartbarkeit |
| 18 | Zusätzliche konkrete RAG-/Memory-/Betriebsabnahmen |
| Anhang A | Vollständiger ausschließlich lesender VPS-Inventurauftrag |
| Anhang B | Kopierbare erste Codex-Anweisung |
| Quellen | Nachprüfbare technische Grundlagen und Herkunft der Spezifikation |

### Was diese Revision zusätzlich absichert

- Änderungen von Fakten erreichen bereits geplante Inhalte; beim Publizieren werden Wissen, Rechte und Policy erneut geprüft.
- Öffentliche Verwendbarkeit ist getrennt von internem Leserecht und von erlaubter Übermittlung an den Modellanbieter.
- Löschung, Rechteentzug und Quellenkorrekturen gelten auch für Vektoren, Caches, Evidence-Packs, Memory und wartende Jobs.
- Selbst erzeugte Marketingtexte sind kein unabhängiger Faktenbeweis; Marketing-Erkenntnisse überschreiben keine Produktfakten.
- Embedding-/Reindexierungs-Kosten, Prüfdatensätze, Betriebskennzahlen und Fehlerfälle sind Bestandteil des ersten Releases.
- Offline-/Testabnahme, bezahlte API-Smoke-Tests und echte Produktivfreigabe bleiben klar getrennt.

---

## 0. Gesamtauftrag

Baue EDS Orbit als eigenständigen, selbst hostbaren Marketing-Workspace, der nach einer einmaligen Einrichtung und ausdrücklich aktivierten Betriebsrichtlinie möglichst viel selbstständig erledigt. Mario soll sich auf uLiquid Desk konzentrieren können und hauptsächlich bei relevanten Ausnahmen oder Entscheidungen eingreifen müssen.

Liefere eine integrierte, funktionsfähige Release-Candidate-Anwendung statt eines Scaffolds, einer UI-Demo oder eines weiteren Projektplans. Plane intern in prüfbaren Abschnitten, implementiere, teste, korrigiere und integriere sie im Rahmen dieses Gesamtauftrags. Die Abschnitte sind keine regelmäßigen Aufforderungen an Mario, die jeweils nächste Phase freizugeben.

Verbindlich:
- Techstack, Projektstruktur und Governance aus dem tatsächlichen lokalen **Codex Project Framework** übernehmen.
- UI: **EDS Labs + Liquid Glass**, bestehende Markenmaterialien, Arctic Blue, keine neue lila Farbwelt, kein erfundenes Logo.
- Laufende Agenten ausschließlich über die **OpenAI API**. Aufgabeabhängiges GPT-5.6-Routing; Astra nur als begrenzte Eskalation für schwierige Aufgaben.
- Entwicklung: **Astra Ultra als Lead-Empfehlung**; Sol Ultra als Alternative. Codex-Ausführungsmodus und Produktionsmodell-Routing strikt trennen.
- Autonomie durch versionierte, serverseitig durchgesetzte Regeln statt durch unbeschränkte Agentenrechte.
- Verbindlicher Knowledge Layer ab dem ersten Release: strukturierte Fakten, Hybrid RAG, belegte Marketing Memory und Knowledge Health. Keine bloß spätere RAG-Roadmap.
- Belege, Projektzugriff, öffentliche Verwendbarkeit und zeitliche Gültigkeit bis unmittelbar vor der Veröffentlichung prüfen; ein erfolgreicher Retrieval-Treffer ist keine Veröffentlichungserlaubnis.
- Open-Source-Vorbereitung und Self-Hosting. Keine uLiquid-spezifischen Daten im generischen Produktkern.
- Keine Veröffentlichung des Repositorys, keine Produktionsmigration, keine Anzeigenbuchung und kein Live-Versand allein aufgrund dieses Auftrags. Solche Schritte benötigen eigene passende Autorisierung.

### Erfolgskriterium

Nach Konfiguration der erforderlichen Konten, Quellen, Kostenlimits und Betriebsrichtlinie kann Orbit aus einem Marketingziel selbstständig einen vollständigen Arbeitszyklus durchführen: Wissen synchronisieren, relevante aktuelle Belege abrufen, recherchieren, planen, Texte und Assets erzeugen, prüfen, den Faktenstand unmittelbar vor der erlaubten Publikation erneut validieren, veröffentlichen, Status abgleichen, Ergebnisse auswerten und den Folgeplan anhand belegter Erkenntnisse verbessern. Der Serverbetrieb darf nicht von einem geöffneten Browser, Mac oder Chat abhängen.

## 1. Geprüfte Framework-Basis und offene Betriebsdaten

Grundlage ist das von Mario hochgeladene Archiv `Codex Project Framework.zip`. `VERSION` und `.agentic/framework-version.yaml` nennen **1.1.0**. Die Framework-Grundlagen wurden für Revision 2 geprüft; für diese Revision wurden insbesondere VERSION, AGENTS.md, Projektprofil, Web-Stack-Preset, App-Struktur sowie AI-Memory-, Routing-, Queue- und Freigaberegeln erneut gelesen. Das ist eine statische Dokumentenprüfung, kein ausgeführter Framework-Test und keine App- oder Live-Abnahme.

Archiv-SHA-256: `5c02ca5ad6316970e39e60c0722c663a715f3d710f832a708c878b4098346dfa`

Verifizierte Referenzen innerhalb des Archivs:
- `AGENTS.md`
- `.agentic/project-profile.yaml`
- `.agentic/stack-presets/web-next-custom-postgres.yaml`
- `.agentic/app-structures/web-next-custom-postgres.md`
- `.agentic/project-profile.examples/ai-agent-app.yaml`
- `.agentic/deployment-presets/docker-compose-single-server.md`
- `.agentic/deployment-presets/docker-vps.md`
- `.agentic/jobs/queue-policy.md`
- `.agentic/ai/model-routing.md`
- `.agentic/ai/guardrails.md`
- `.agentic/ai/memory-policy.md`
- `.agentic/governance/human-approval.md`

Das Framework ist eine Engineering-/Governance-Grundlage mit auswählbaren Presets, keine bereits implementierte Orbit-Anwendung. Das neutrale Projektprofil enthält noch `REPLACE_ME`. Technologien mit mehreren Optionen sind im Framework nicht bereits eindeutig entschieden. Insbesondere verweist das gewählte Web-Preset bei Hosting auf Managed-Angebote; die Kombination mit selbst gehostetem PostgreSQL ist deshalb eine ausdrücklich zu dokumentierende projektspezifische Anpassung.

Nicht geprüft: aktuelles App-Repository, tatsächliche VPS-Ressourcen, laufende Vertragskosten, Lastverläufe, produktive Zugangsdaten, Restore-Nachweise oder Provider-Berechtigungen. Keine bestehende Infrastruktur wurde verändert. Die Original-Logo-Datei ist nicht Bestandteil dieses Auftrags; kein generiertes Ersatzlogo verwenden.

## 2. Framework-Aufnahme und konkretisierter Zielstack

1. Lies `AGENTS.md` und die dort festgelegte Reihenfolge sowie vorhandene lokale Projektanweisungen. Integriere Framework 1.1.0 ohne vorhandene projektspezifische Regeln blind zu überschreiben. `.git/`, macOS-Metadaten und die Git-Historie des Framework-Archivs nicht in das neue App-Repository übernehmen.
2. Primäres App-Profil: `ai-agent-app`; ergänzend `fullstack-saas` sowie Web-/Backend-/Data-Pipeline-Regeln, soweit tatsächlich betroffen. Entwicklungsumgebung zunächst `local`, Ziel `production` geschützt. Risikoklasse wegen externer Aktionen, Zugangsdaten und Projekttrennung: `high`.
3. Führendes Stack-Preset: **`web-next-custom-postgres`**. Struktur aus `.agentic/app-structures/web-next-custom-postgres.md` übernehmen, um einen Worker ergänzen. Alternativpreset `web-next-supabase` in der ADR kurz vergleichen; keine zweite parallele Backend-Plattform einführen.
4. Zielentscheidungen für dieses neue Projekt:
   - Frontend: Next.js App Router, TypeScript, Tailwind CSS, shadcn/ui; EDS Liquid Glass über gemeinsame Design-Tokens.
   - Backend: Fastify mit klaren fachlichen Modulen und zentraler Auth/AuthZ. Das ist die Auswahl aus den Framework-Optionen, kein unveränderlicher Framework-Default.
   - Datenbank: selbst gehostetes PostgreSQL mit pgvector und nativer Volltextsuche. Prisma als ORM; kein paralleles Drizzle und keine zusätzliche Vektordatenbank als Pflichtkomponente. pgvector-Erweiterung, Vektortypen, Indizes und Raw-/TypedSQL anhand der gewählten Prisma-Version integrieren, nicht versionsfremde Beispiele mischen. Self-Hosting-Abweichung vom Managed-Hosting-Hinweis des Presets in einer ADR begründen. Details in Abschnitt 15.
   - Jobs: separater Node.js-Worker, BullMQ und eigene Redis-Instanz. Durable Geschäfts- und Aktionszustände bleiben in PostgreSQL; Queue-Zustand darf nicht der einzige Nachweis einer Veröffentlichung sein. Keine eigene Temporal-Installation für Orbit im ersten Release ohne belegte Notwendigkeit. Postiz kann unabhängig eigene Temporal-Abhängigkeiten benötigen.
   - API-Vertrag: OpenAPI und daraus erzeugter TypeScript-Client. Keine zusätzliche tRPC-Schicht für dieselben Endpunkte.
   - Authentifizierung: gepflegte, zum API-/Session-Modell passende Bibliothek nach kurzer dokumentierter Auswahl; keine selbst entwickelte Passwort-Kryptografie, keine Cloud-Auth-Pflicht und keine unbestätigte Behauptung, das Framework schreibe eine konkrete Auth-Lösung vor.
   - Tooling: pnpm-Monorepo als Projektwahl, Vitest, Integrationstests mit isolierter Testdatenbank/Testcontainers und Playwright für E2E.
   - Deployment: `docker-compose-single-server` mit ergänzenden Regeln aus `docker-vps`; Caddy als gemeinsamer Reverse Proxy im Services-Hosting. Kein Kubernetes und keine zusätzliche Hypervisor-Schicht für den ersten Release.
5. Nutze aktuell unterstützte, zusammenpassende Runtime- und Paketversionen. Versionsauswahl, Lockfile und Image-Digests dokumentieren. Das Framework legt hier keine vollständig verifizierte Versionsmatrix fest.
6. Dokumentiere Framework-Version, Fingerprints, Anpassungen, Risiko und Architektur in `docs/FRAMEWORK_BASELINE.md` sowie ADRs für Stack, Hosting und Autonomie. Fülle das reale Projektprofil mit nachweislich ausführbaren Befehlen. Keine behaupteten Testergebnisse aus Vorlagen übernehmen.
7. Führe vor Produktcode die Framework-Integritätsprüfung gemäß README aus, soweit die installierten Voraussetzungen vorliegen; in CI vollständige YAML-/Schema-Prüfung erzwingen. Anschließend echte App-Checks ergänzen. Fehlende Werkzeuge und nicht ausgeführte Tests ausdrücklich ausweisen.

Zielstruktur, ohne Verpflichtung zu unnötigen Microservices:

```text
apps/web/          # Darstellung, keine direkte Nutzung der Produktdatenbank
apps/api/          # API-Vertrag, Auth/AuthZ, fachliche Module
apps/worker/       # begrenzte Jobs, Agenten und Aktionsausführung
packages/ui/
packages/schemas/
packages/api-client/
packages/config/
packages/knowledge/ # Retrieval-/Evidence-Verträge und wiederverwendbare Domänenlogik
evals/knowledge/    # synthetische, versionierte Wissens- und Sicherheitsfälle
infra/
docs/
.agentic/
```

Web, API und Worker sind gemeinsam versionierte Teile eines modularen Produkts und keine voneinander unabhängigen Plattformen. Der Knowledge Layer ist ein internes Modul, kein zusätzlicher Microservice. Ingestion-, Embedding-, Retrieval- und Publishing-Aufgaben erhalten getrennte Queue-Klassen und begrenzte Nebenläufigkeit. Alle Datenzugriffe erzwingen Projektzuordnung. Worker skalieren über dieselben Verträge und dürfen später auf einen anderen Host verlegt werden.

### Abgrenzung der Autonomie zur Framework-Governance

Das AI-Beispielprofil verlangt menschliche Freigaben für externe Writes und Nachrichten. Orbit darf diese Sicherheitsvorgabe nicht stillschweigend entfernen. Eine ausdrücklich vom Owner aktivierte, versionierte Betriebsrichtlinie kann nur eng beschriebene wiederkehrende Marketingaktionen autorisieren; Empfänger/Kanäle, Inhaltstypen, erlaubte Aussagen, Häufigkeit, Zeitraum und Budgets müssen überprüfbar begrenzt sein. Die genaue Delegation ist als eigene ADR und vor Aktivierung als Owner-Entscheidung zu dokumentieren.

Dieses Mandat ist **keine** Erlaubnis für Codex oder Orbit, Server zu kaufen, zu migrieren, DNS zu ändern, produktiv zu deployen, Zugriffsrechte zu erweitern oder Daten zu löschen. Solche produktiven Infrastrukturänderungen behalten ihre konkrete menschliche Freigabe gemäß Framework. Bis zum wirksamen Mandat bleibt Live-Publishing gesperrt.

## 3. Produktumfang des ersten vollständigen Release Candidates

### 3.1 Einrichtung und Projekte

Richte einen Self-Hosting-Setup-Assistenten ein: Owner, Zeitzone, Oberflächensprache, Modellzugang, Budgetlimits, Projekt, Markenmaterialien, Wissensquellen, Kanäle und Autonomierichtlinie. Oberfläche Englisch als Open-Source-Ausgangspunkt, deutsche Übersetzung für die wesentlichen Arbeitsabläufe; Content-Sprache pro Projekt unabhängig konfigurieren.

Mehrere Projekte auf einer Installation unterstützen. Projektrollen Owner, Editor und Viewer ausreichend halten; keine unnötige SaaS-Abrechnung oder komplexe Marketplace-Infrastruktur. Credentials, Wissen, Inhalte und Kennzahlen müssen strikt projektbezogen isoliert sein.

Neue Installation: Demo/Observe, keine externen Schreibaktionen. Demo-Daten eindeutig markieren. Echte Produktionsdaten beginnen leer. Kein verborgenes automatisches Importieren privater Projekte.

### 3.2 Ziele und Kampagnen

Natürliche Sprache in einen bearbeitbaren strukturierten Auftrag übersetzen. Felder: Zielaktion, Zielgruppe, Produkt, Zeitraum, Sprache, Kanäle, Content-Frequenz, verbindliche Quellen, Grenzen und erlaubte Aktionen. Zahlenziele und Budgetobergrenzen niemals erfinden.

Kampagnen verbinden Aufgaben, Inhalte, Quellen, Medien, Veröffentlichungen, Tracking und Ergebnisse. Ein Agent darf Unteraufgaben innerhalb eines freigegebenen Ziels erzeugen, aber keine neuen Hauptziele, Empfängergruppen oder Ausgabenberechtigungen freischalten.

### 3.3 Übersicht und Ausnahmen

Die Startseite beantwortet: Läuft der Autopilot? Was wurde erledigt? Was ist blockiert? Welche Entscheidung ist wirklich nötig? Welche Ergebnisse sind belastbar?

Zeige echte Laufzustände, letzte erfolgreiche Synchronisierung, Datenlücken, verbleibendes Budget und globale/projektbezogene Pause. Ein ausführlicher Aktivitätsverlauf ist verfügbar, aber nicht die primäre Oberfläche. Keine dekorativen Live-Agenten-Animationen ohne Bezug zu tatsächlichen Jobs.

### 3.4 Content-Studio und Kalender

Posts, Blogartikel, Newsletter, Anzeigenentwürfe und Skripte gemeinsam verwalten. Pro Inhalt: Versionen, Quellen, Kampagne, Kanal, Sprache, Asset, Ziel-Link, Status und Entscheidungen.

Social-Media-Varianten aus einem überprüften Hauptinhalt ableiten. Blogfluss: Themen-/Suchabsichtsbriefing, Quellen, Gliederung, Entwurf, Fakten- und Markenprüfung, Überarbeitung, Publikation, Aktualisierungsdatum. Newsletter unterstützt Betreffvarianten, Vorschau, Segmentreferenz und Entwurfsexport. Versand erst mit verifiziertem Provider und passender Freigaberichtlinie.

Kalender und Aufgabenboard sind Ansichten derselben persistenten Objekte. Drag-and-drop braucht Tastatur-/Formularalternative. Bearbeitungen dürfen geplante Veröffentlichungen nicht inkonsistent zurücklassen.

### 3.5 Wissen und Marke

Der vollständige erste Release enthält den Knowledge Layer aus Abschnitt 15, die Marketing Memory aus Abschnitt 16 und deren Abnahmekriterien. Quellenverwaltung, Retrieval und Evidence-Prüfung sind echte Produktfunktionen, nicht nur ein Upload-Button oder eine Chat-Demo.

Verbindliche Fakten, redaktionelle Präferenzen und experimentelle Erkenntnisse getrennt halten. Faktenobjekte benötigen Quelle, Stand, Gültigkeit, Status und prüfenden Verantwortlichen.

Produktstatus: verfügbar, Beta/Test, geplant, eingestellt. Agenten dürfen diese Kategorien nicht eigenmächtig umdeuten. Konflikte oder abgelaufene Fakten blockieren nur betroffene Inhalte; unabhängige Arbeit läuft weiter.

Ingestion: manuelle Fakten, Dateien, freigegebene Webseiten und dokumentierte Adapter. Website-Texte, importierte Nachrichten und Dokumente sind nicht vertrauenswürdige Inhalte, keine Systemanweisungen. Quellenzugriffe einschränken und Inhalte isoliert verarbeiten.

Brand-Assets mit Herkunft, Nutzungsfreigabe, gültigen Varianten und Projektreferenz speichern. Weder neue Logos noch Farben oder Schriftdateien aus fremden Projekten übernehmen. Eine heruntergeladene Schriftdatei nicht unbesehen im Open-Source-Repo verteilen.

### 3.6 Kreativproduktion

Vorhandene Banner- und Layoutvorlagen priorisieren. Baue eine echte, testbare Rendering-Strecke für Text-/Asset-Varianten und benötigte Plattformformate: sichere Ränder, korrekte Seitenverhältnisse, Textüberlaufprüfung, unverändertes freigegebenes Logo, Vorschau und exportierbare Dateien.

Optionaler OpenAI-Bildadapter ist eine separate Fähigkeit mit eigenem Budget und zur Implementierungszeit verifiziertem Bildmodell. Textmodelle nicht als direkte Bildgeneratoren behandeln. Fehlt ein genehmigtes Ausgangsasset, einen beschreibenden Creative-Brief erstellen und den Asset-Schritt blockieren statt eine fertige Grafik vorzutäuschen.

### 3.7 Analysen und Experimente

Erkenntnisse werden versioniert und mit Datenbelegen in der Marketing Memory abgelegt; sie ändern weder Produktfakten noch Autonomiegrenzen automatisch. Der Umgang mit Korrekturen, kleinen Stichproben und veralteten Erkenntnissen ist in Abschnitt 16 verbindlich geregelt.

Quellen strikt auseinanderhalten: Anzeigenklicks, gemessene Website-Besuche, Anwendungsevents und verifizierte Geschäftsergebnisse. Quellen und Erfassungszeitraum neben Kennzahlen anzeigen. Nicht verfügbar ist nicht null; geschätzt ist nicht gemessen.

Attribution nur mit vorhandenen, zulässig verarbeiteten Daten. Keine automatische Gleichsetzung zeitlich ähnlicher Daten mit kausalen Conversions. Kein Fingerprinting oder heimliche Verknüpfung persönlicher Daten.

Kennzahlen deterministisch berechnen. Sprachmodelle erklären Befunde, Datenlücken und Hypothesen; sie berechnen nicht die verbindlichen Summen oder die Ausgabenberechtigung.

Experimente: Hypothese, Varianten, primäre Zielaktion, Laufzeit-/Stoppregeln, Mindestdaten und Ergebnisstatus. Kleine Stichproben erzeugen keine sicheren Gewinner. Schlechte Trackingqualität blockiert automatische Budgetoptimierung, nicht die gesamte Redaktion.

### 3.8 Community, E-Mail und Ads

Diese Bereiche im Datenmodell und in echten Entwurfs-/Analyseabläufen berücksichtigen. Keine sichtbaren Schaltflächen ohne Funktion.

Community: Fragen aus autorisierten Quellen oder gekennzeichneten Imports bündeln, Antwortentwürfe und Content-Ideen erstellen. Öffentliche Antworten nur für separat autorisierte, risikoarme FAQ-Abläufe; Beschwerden und sensible Fragen zur Prüfung. Kein Scraping privater Mitglieder, keine massenhaften unaufgeforderten Direktnachrichten.

E-Mail: Entwürfe, Segmente und Consent-/Sperrstatus-Referenzen. Ohne verbundenen Marketing-Mail-Provider nur Entwurf/Export, kein behaupteter Versand. Keine privaten Gmail-Konten stillschweigend als Newsletter-Engine verwenden.

Ads: Konzepte, Varianten, Tracking und Performance-Import. Kostenpflichtige Aktivierung oder Budgetänderung zunächst manuell freigeben. Spätere Automatik nur mit separatem Mandat einschließlich Account, Kampagnen, Grenzwerten, Änderungsmaximum, Datenqualitätsbedingungen und Audit.

## 4. Autonomie und Berechtigung

### Betriebsarten

- **Observe:** lesen, analysieren und intern vorbereiten. Keine produktiven externen Schreibaktionen.
- **Assisted:** externe Aktionen benötigen eine passende Einzelfreigabe.
- **Autopilot:** risikoarme Aktionen dürfen nach ausdrücklich aktivierter, versionierter Policy automatisch ausgeführt werden.

Observe ist der Installationszustand, Autopilot das beabsichtigte Betriebsziel. Kein endloser Freigabezwang für normale Posts nach erfolgreicher Einrichtung.

### Automatisch innerhalb eines aktivierten Mandats

Recherche, Themenfindung, Planung, Entwürfe, kanalbezogene Varianten, Vorlagen-Rendering, Fakten-/Markenprüfung, risikoarme Terminierung/Publikation, freigegebene FAQ-Inhalte, Statusabgleich, Analysen und Folgeplanung. Automatische Routinepublikation benötigt verifizierte Quellen, zulässige Themen, erlaubten Kanal/Ziel-Link und bestandene technische sowie inhaltliche Prüfungen.

### Zusätzliche Freigabe

Neue oder erhöhte Werbeausgaben, neue Empfängergruppen, neue Kanäle, Änderungen von Preisen/Terminen/Leistungsversprechen, Zugangsdaten/Rechteänderungen, umfangreiche Löschungen und sensible Finanz-/Token-/Presale-Aussagen. Ein günstigeres oder stärkeres Modell darf solche Grenzen nicht aufheben.

### Serverseitige Policy-Engine

Der Executor erhält nur validierte strukturierte Aktionspakete. Vor jedem externen Write erneut prüfen: Identität, Projekt, Aktion, Kanal/Account, Ressourcen, Policy-Version, Risikoklasse, Faktenstand, Content-Version, Budget, Pausenzustand und Integrationsgesundheit.

Owner-Freigaben an einen nachvollziehbaren Hash des Pakets binden: Inhalt, Asset, Link, Kanal, Empfängerreferenz, Termin und gegebenenfalls Kostenmaximum. Änderungen erzeugen erneute Prüfung. Policy-Änderungen dürfen keine bestehenden Aktionen unbemerkt erweitern.

Zusätzlich sind Evidence-Pack, Claim-Ledger, Quellenversionen, Freigabe zur öffentlichen Nutzung und Gültigkeit zum tatsächlichen Veröffentlichungszeitpunkt erforderlich. Bei Änderungen abhängige Entwürfe und Termine invalidieren. Für besonders zeitkritische Inhalte lokale Terminierung mit Just-in-time-Prüfung vor dem Provider-Aufruf bevorzugen; remote terminierte Inhalte lassen sich nicht ohne Weiteres bis zum Versand kontrollieren. Abschnitt 15.8 konkretisiert dies.

LLM-Selbstbewertung oder ein numerischer Confidence-Wert allein berechtigt niemals zu einer externen Aktion. Der Reviewer ist hilfreich, aber kein Sicherheitsmechanismus mit garantierter Fehlerfreiheit.

Pausieren muss bereits extern terminierte Inhalte berücksichtigen: ausstehende lokale Aktionen sperren und Remote-Termine soweit unterstützt abbrechen. Nicht abbrechbare oder möglicherweise bereits ausgeführte Aktionen klar melden. Keine pauschale Zusage, jede Veröffentlichung rückgängig machen zu können.

## 5. Agentenrollen und OpenAI-Routing

Rollen: Marketing Lead, Research/SEO, Redaktion, Creative, Analytics, Campaign/Ads, Community/E-Mail und Brand/Facts Reviewer. Das sind Aufgabenprofile mit getrennten Rechten, keine acht dauerhaft aktiven Chatbots.

Produktionsrouting — Zuordnung als Implementierungsentscheidung:

| Profil | Dokumentierte Model-ID | Vorgesehene Arbeit |
|---|---|---|
| fast | `gpt-5.6-luna` | Klassifikation, Metadaten, Extraktion, eng definierte Transformation |
| standard | `gpt-5.6-terra` | Routineentwürfe und Varianten mit guter Faktenbasis, einfache Zusammenfassungen |
| quality | `gpt-5.6-sol` | Kampagnenplanung, Blogartikel, Quellenabgleich, hochwertige Redaktion und Prüfberichte |
| escalation | `gpt-6-astra` | Schwierige Widersprüche, komplexe Strategiekorrektur und ungelöste Qualitätsfälle |

Diese IDs wurden am 17.09.2026 in der offiziellen Modellübersicht dokumentiert gefunden [S1]. Vor tatsächlicher Nutzung API-Zugang und benötigte Fähigkeiten mit dem verbundenen Projekt prüfen. Kontozugriff ist durch öffentliche Dokumentation nicht bewiesen.

OpenAI Responses API und eine zum Framework passende SDK-Anbindung verwenden. OpenAI Agents SDK kann Rollen, Werkzeuge und Tracing unterstützen; Job-Persistenz, Berechtigung und Budgetverwaltung bleiben Verantwortung der Anwendung. SDK-Verfügbarkeit und APIs beim Implementieren verifizieren [S3].

Routing zentral konfigurierbar: Modelle nicht in einzelnen Agenten hardcoden. Unterstützte Reasoning-Einstellungen je Modell prüfen. **Ultra nicht als ungeprüften Produktions-API-Parameter übernehmen**: Es ist im Codex-Kontext ein Modus zur Arbeit mit Subagenten [S2].

Eskalation nicht allein auf Wunsch eines Agenten: strukturierter Anlass, definierte Fehlertypen, vorhandenes Eskalationsbudget und begrenzte Versuche. Nach beispielsweise zwei Korrekturversuchen höchstens eine Astra-Eskalation; weiterhin ungelöste Fälle zur Ausnahme. Diese Startgrenzen sind Produktdefaults, keine gemessene Optimalität.

Ausfall eines Eskalationsmodells darf sensible Aufgaben nicht stillschweigend durch ein schwächeres Modell genehmigen. Unabhängige risikoarme Aufgaben weiterbearbeiten.

Embedding-Routing ist getrennt vom Textmodell-Routing: als erster Kandidat `text-embedding-3-small` mit 1536 Dimensionen; `text-embedding-3-large` nur nach dokumentiertem Qualitätsvergleich und kompatibler Dimension/Index-Konfiguration. Diese Embeddings sind kein Modelltraining. Modellwechsel erfordern kontrollierte Reindexierung und neue Evaluationen; siehe Abschnitt 15.4.

Kosten: pro Job vorab reservieren, nach Nutzung abrechnen; Tages-/Monatslimits und Nebenläufigkeit atomar durchsetzen. Textmodell-, Embedding-, Bild-, Tool- und gegebenenfalls Reranking-Kosten unterscheiden. Auch Query-Embeddings, Reindexierungen und nicht erfolgreich abgeschlossene, möglicherweise bereits berechnete API-Aufrufe berücksichtigen. Preise mit Prüfdatum konfigurierbar halten. Keine erfundenen festen Monatskosten. Vor Aktivierung kostenpflichtiger Automatik müssen Owner-Limits vorhanden sein.

## 6. Dauerhafte Ausführung und Fehlerbehandlung

Die Fachobjekte und der Workflow-Status gehören in persistente Speicherung. Keine rein im Browser oder RAM gehaltenen Agentenketten.

Zustände mindestens: queued, running, waiting_approval, blocked_dependency, retry_scheduled, succeeded, failed, canceled. Veröffentlichungen zusätzlich: intent_created, sending, outcome_unknown, scheduled_remote, published, canceled_remote und failed, soweit fachlich passend.

Jede Nebenwirkung besitzt eine stabile Idempotenzkennung. Bei Timeout nach einer Provider-Anfrage zuerst den Remote-Status abgleichen. Wenn der Provider keine eindeutige Klärung unterstützt, auf outcome_unknown halten und gezielt eskalieren, nicht blind erneut senden. Keine unerfüllbare globale Exactly-once-Garantie behaupten.

Arbeitsabläufe brauchen Leases/Locks, begrenzte Wiederholungen, Backoff, Verarbeitungsfristen, Dead-Letter-/Fehlerübersicht und Wiederaufnahme nach Neustart. Versionsänderungen, Replays und doppelte Webhooks berücksichtigen.

Scheduler berücksichtigt Projektzeitzone und Sommerzeit, speichert eindeutige Zeitpunkte und verhindert doppelte Tages-/Wochenjobs. Laufende Jobs, ausstehende Freigaben und reservierte Budgets nach Worker-Absturz konsistent rekonstruieren.

Transaktionale Outbox für verbindliche Zustandswechsel und Queue-Handoff sowie idempotente Inbox für relevante Webhooks vorsehen. Lösch-/Rechte-/Versionsereignisse müssen laufende Knowledge-Jobs und geplante Inhalte erreichen; veraltete Jobs dürfen entfernte Quellen nicht wieder aktivieren.

Unabhängige Schritte parallelisieren, abhängige Schritte geordnet ausführen. Kein unendlicher Agenten-Chat. Kontrollierte maximale Schritte und Laufzeit pro Auftrag.

## 7. Integrationen und ehrlicher Funktionsstatus

Jeder Connector implementiert Capability-Erkennung, begrenzte Berechtigungen, Healthcheck, Fehlerabbildung und Testvertrag. Getrennte Status: nicht verbunden, konfiguriert, lesend verifiziert, schreibend verifiziert, gestört, nicht unterstützt. Demo/Mock niemals als Live-Verifikation ausgeben.

### Verbindliche erste Integrationen

**Knowledge-Quellen:** manuelle strukturierte Fakten, Dateiimporte, freigegebene Websites/Blogs und öffentliche GitBook-Dokumentation; inkrementelle Synchronisierung, Versionierung und vollständiges Entfernen gemäß Abschnitt 15. Private Quellen nur mit gesondert verifiziertem Zugriff. Vorhandene ChatGPT-/Codex-Connectorverbindungen sind nicht automatisch Credentials für die fertige Orbit-Anwendung.

**Postiz:** verbundene Kanäle lesen, Medien verarbeiten, Draft/Schedule/Publish nach Policy, Remote-ID speichern, Status abgleichen und Termine soweit dokumentiert ändern/abbrechen. Die dokumentierte Create-Post-API unterscheidet `draft`, `schedule` und `now` [S4]. Gegen die tatsächlich installierte Version testen, bevor weitere Möglichkeiten als unterstützt gelten.

**Matomo:** lesende Reports für freigegebene Sites/Kampagnen/Ziele. Zeitfenster, Zeitzone, Dimensionsdefinitionen und fehlende Zielkonfiguration korrekt behandeln. Adminrechte sind für Routineanalyse nicht das Default.

**Slack:** Ausnahmen und Zusammenfassungen; sichere interaktive Antworten, soweit die vorhandene Integration dies unterstützt. Signatur, Replay-Schutz, User-/Workspace-Mapping und ressourcenspezifische Autorisierung. Eine Benachrichtigung allein ist noch keine beidseitige Freigabefunktion. UI-Freigabe bleibt als vollständig funktionierender Rückweg verfügbar.

**Blog:** mindestens einen echten, im Zielprojekt überprüften Publikationsweg umsetzen. Adapter anhand vorhandener Website/CMS bestimmen; Draft, Preview, Publikation und Änderungsstatus unterstützen, soweit dieser Weg es erlaubt. Kein erfundener Universal-CMS-Endpoint. Fehlt das Zielsystem, einen vollständigen Artikel-/Asset-Export liefern und den Live-Adapter als offene Abhängigkeit markieren.

**Dateiimport:** belastbarer CSV-Import für Anzeigenstatistiken, darunter konfigurierbare AdsGram-Exporte. Schema-Mapping, Währung, Zeitzone, Fehlerprotokoll und Duplikaterkennung. Keine unbestätigte AdsGram-API voraussetzen.

Marketing-E-Mail-, Community- und Paid-Ads-Write-Adapter nur auf Basis tatsächlich verfügbarer Provider implementieren. Ist ein Provider noch nicht bestimmt, sind Entwurf/Import echte Teilfunktionen; Live-Versand oder Account-Steuerung bleiben ausdrücklich außerhalb der verifizierten Fähigkeiten.

## 8. UI und Originalmarke

EDS-Labs-Logo und vorhandene Markenregeln aus autorisierter lokaler Quelle übernehmen. Herkunft in einem Asset-Manifest festhalten. Bis zur Verfügbarkeit ist ein eindeutig als Entwicklungsplatzhalter benannter Text zulässig, kein erfundenes Symbol. Finale Markenabnahme erst mit Originalasset.

Liquid Glass als gemeinsame Designsprache: transluzente Navigation/Inspektoren, dezente Lichtkanten, Tiefenstaffelung und ruhige Arctic-Blue-Akzente. Leseflächen brauchen stabile Kontraste. Lange Tabellen und Artikel nicht auf unruhige transparente Hintergründe setzen.

Responsiver Browser-Workspace mit iPhone-tauglicher Bedienung. Hauptaktionen, Ausnahmen und Content-Vorschau auf kleinen Displays zugänglich. Tastaturbedienung, sichtbarer Fokus, reduzierte Bewegung und reduzierte Transparenz mit stabiler Fallback-Oberfläche berücksichtigen. PWA-Installation nur ergänzen, wenn Framework und Testumfang dies tragen; kein natives iOS-Projekt erforderlich.

Verwende die verfügbaren Frontend-/Visualisierungsskills für visuelle Konzepte vor UI-Implementierung. Entwickle vollständige Desktop- und mobile Primäransichten statt nur eines Headers. Keine neue Markenwelt als kreative Abweichung. Konzepte und späteres Browser-Rendering in einem Fidelity-Protokoll vergleichen. Produkt- und Architekturarbeit kann unabhängig von noch fehlenden Visual-Assets fortgesetzt werden.

Alle Hauptansichten brauchen Lade-, Leer-, Fehler-, Berechtigungs- und Erfolgszustände. Keine erfundenen Conversion-Raten, Agentenresultate oder Kundenstimmen in Produktionsansichten.

## 9. Sicherheits- und Datengrenzen

Separates Deployment und getrennte Credentials von uLiquid Desk. Keine Trading-API-Keys, Wallet-Signierrechte oder privaten Desk-Adminzugänge in diesem Produkt.

Geheimnisse nur serverseitig, verschlüsselt und mit klarer Rotation; nicht in Browser-Bundles, Logs, Traces, Modellprompts oder Demo-Seeds. Least-Privilege pro Connector. Projektfilter und Objektberechtigungen auf jedem serverseitigen Zugriff testen.

Webzugriff schützt vor SSRF, privaten IPs, Redirect-Umgehungen und Zugriff auf lokale Dienste. Uploads begrenzen und validieren; Rich Text und HTML sicher rendern. Prompt-Injection-Testfälle für importierte Dokumente und Connector-Inhalte implementieren. Sicherheitsleitlinien für Agenten ausdrücklich berücksichtigen [S5].

RAG-Rechte gelten durchgängig für Dokumente, Chunks, Embeddings, Suchergebnisse, Evidence-Packs, Caches, Exporte und Logs. Private oder nur intern freigegebene Informationen dürfen nicht über RAG in öffentliches Marketing gelangen. Unterscheide Lesezugriff, Übermittlung an OpenAI und Freigabe zur öffentlichen Verwendung.

Audit speichert Entscheidungen, Eingabe-/Quellenreferenzen, Versionen, Ausführungen und Ergebnisse; keine privaten internen Modellgedankengänge anfordern oder speichern. Telemetrie und Traces datensparsam und konfigurierbar. Open-Source-Installation ohne verpflichtende externe Produkttelemetrie.

Freigaben auf abgelaufene Sessions, CSRF, unzulässige Wiederverwendung und Cross-Project-Zugriff prüfen. Ein Slack-Text wie „ja“ ohne eindeutige Zuordnung ist kein genereller Blankoscheck.

Datenexport, Löschung und konfigurierbare Aufbewahrung vorsehen. Newsletter-Sperrlisten und Opt-out-Referenzen dürfen nicht durch KI-Auswahl umgangen werden. Rechtliche Konformität nicht allein aus einer technischen Checkbox ableiten.

## 10. Open-Source-Vorbereitung

Self-Hosting ohne EDS-Cloud-Pflicht; eigene Providerkonten. Code, Demo-Daten und optionale private Projektkonfigurationen getrennt halten. Betriebsgeheimnisse, Empfängerlisten und Kundendaten bleiben außerhalb des Repositorys.

MIT ist eine **Lizenzempfehlung**, keine bereits bestätigte abschließende Entscheidung. Sie erlaubt breite Wiederverwendung einschließlich kommerzieller Nutzung unter ihren Bedingungen [S6]. Abhängigkeiten, Beiträge und Markenassets getrennt auf Rechte prüfen. Keine Nichtkommerziell-Klausel in eine als MIT/Open Source bezeichnete Code-Lizenz hineinmischen.

Vor Veröffentlichung Lizenzentscheidung, Rechte am Logo und Asset-Hinweise dokumentieren. Original-Branding austauschbar gestalten; Name/Logo nicht stillschweigend als frei verwendbare Marke versprechen.

Bereitstellen: README, Setup-/Upgrade-/Backup-/Restore-Dokumentation, Architektur, Sicherheitskontakt/SECURITY, CONTRIBUTING, Code of Conduct, Connector-Entwicklung, öffentliche Konfigurationsbeispiele ohne Secrets, reproduzierbare Tests/CI und synthetische Demo-Daten.

Generischer Kern; uLiquid nur als lokales, bewusst eingerichtetes Projekt oder bereinigtes Beispiel. Keine Produktionsfakten oder Presale-Termine aus früheren Chats als Demo-Defaults fest einbauen.

## 11. Ausführung in Codex

### Lead-Modell

Empfehlung: Astra Ultra für den zusammenhängenden Aufbau und die abschließende Integration. Offizielle Codex-Dokumentation ordnet Astra schwierigen End-to-End-Aufgaben und Ultra der parallelen Arbeit mit Subagenten zu [S2]. Keine Garantie, dass ein Modell einen beliebigen Gesamtauftrag fehlerfrei in einer Sitzung abschließt.

Sol Ultra ist die Alternative, besonders wenn die Architektur bereits eng vorgegeben ist. Ein verifizierter Lead mit klaren Zuständigkeiten ist wichtiger als wahllos viele parallel arbeitende Agenten.

Mögliche Teilverantwortungen: Framework/Backend, Agenten/Policy, UI, Integrationen sowie unabhängige Tests/Sicherheit. Getrennte Dateiverantwortung und gemeinsame Verträge. Framework-native Worktrees/Agentenorganisation nur verwenden, wenn tatsächlich vorhanden und verstanden.

### Interne Abschnitte

A. Framework-/Asset-/Connector-Aufnahme; Anforderungsmatrix, Datenmodell, Rollen/Rechte, ADRs und ausschließlich lesende Infrastrukturaufnahme.
B. Knowledge-Foundation: Setup, Projekte, strukturierte Fakten, Quellen, Versionsmodell, isolierte Ingestion, Embeddings, Hybrid Retrieval und synthetische Evals.
C. Erster vollständiger vertikaler Pfad: Ziel, Evidence-Pack, Content, Claim-Prüfung, persistenter Job, Policy und Test-Publishing ohne Produktionswirkung.
D. Modellrouting, Reviewer, Kostenkontrolle, Lösch-/Änderungsfolgen, Ausnahme-Inbox und Wiederanlauf.
E. Reale Connector-Implementierungen, Assets, Kalender, Just-in-time-Publishing, Statusabgleich, Analysen und Marketing Memory.
F. Weitere Contentformate, Knowledge-UI, Exporte, Experimente, Content-Qualität und mobile Bedienung.
G. Unabhängige Sicherheitsprüfung, RAG-Evals, Recovery-/E2E-/Installationsprüfungen, visuelle Abnahme und Release-Dokumentation.

RAG wird vor der vollständigen Agenten- und Publishing-Strecke integriert, nicht nachträglich daran angehängt. Infrastrukturaufnahme darf Entwicklung nicht blockieren. Keine Produktivmigration in diesen Abschnitten.

Nach jedem Abschnitt selbst prüfen und korrigieren. Keine unfertige Funktion als abgeschlossen markieren, nur weil Code kompiliert. Kleine reversible Detailentscheidungen treffen und dokumentieren; echte Blockaden isolieren statt jedes Mal den ganzen Auftrag abzubrechen.

Bei Kontextgrenzen Zustand, Entscheidungen, verbleibende Arbeit und Testergebnisse dauerhaft ablegen. Eine neue Sitzung muss am bestehenden Stand fortsetzen können, ohne Features neu zu erfinden. Bei externen Blockaden mit unabhängiger Arbeit fortfahren und den verbleibenden Aufwand ehrlich berichten.

## 12. Abnahmeplan

Der Abnahmeplan umfasst gemeinsam A01–A32, H01–H12 sowie die Knowledge-/Memory- und Betriebschecks aus Abschnitt 18. Alle IDs in einer gemeinsamen Traceability-Matrix abbilden.

Für jedes Kriterium Test-ID, Umgebung, Datum, Ergebnis und Evidenz dokumentieren. Ergebnisse unterscheiden: `PASS_LIVE`, `PASS_TEST`, `BLOCKED_EXTERNAL`, `FAIL`, `NOT_RUN`. Ein Mock-Vertragstest ist kein bestandener Live-Test.

| ID | Mindestnachweis |
|---|---|
| A01 | Clean Checkout nach dokumentierter Einrichtung startbar; Migrationen und Basistests laufen. |
| A02 | Owner-Setup und Login funktionieren ohne öffentliche Default-Passwörter. |
| A03 | Zwei Projekte können keine fremden Inhalte, Credentials oder Jobs lesen/verändern. |
| A04 | Eine Mission erzeugt persistente, miteinander verbundene Aufgaben und Contentobjekte. |
| A05 | Mindestens ein echter OpenAI-Aufruf liefert validierte strukturierte Ausgabe; Modell-ID und Usage sind sichtbar. |
| A06 | Tests belegen taskabhängiges Routing, begrenzte Eskalation und Blockade bei fehlender Modellfähigkeit. |
| A07 | Preis-, Termin- oder Produktstatus-Widerspruch verhindert betroffene Auto-Publikation. |
| A08 | Observe führt keinen externen Write aus, auch wenn der Prompt dazu auffordert. |
| A09 | Assisted veröffentlicht ohne passende Einzelfreigabe nicht. |
| A10 | Autopilot publiziert zulässigen Routineinhalt innerhalb der aktivierten Policy ohne weitere Nutzerinteraktion. |
| A11 | Geänderte Content-/Asset-/Link-/Policy-Version wird vor Ausführung erneut geprüft. |
| A12 | Budgetlimits bleiben bei parallelen Jobs atomar wirksam; fehlendes Budget startet keine kostenpflichtige Automatik. |
| A13 | Medienrendering erzeugt nutzbare Dateien ohne Textüberlauf und mit korrekten freigegebenen Assets. |
| A14 | Postiz-Draft sowie autorisierter Test von Schedule/Publish und Statusabgleich funktionieren. |
| A15 | Matomo-Lesezugriff liefert echte Daten oder eine korrekt erklärte fehlende Konfiguration, keine erfundenen Werte. |
| A16 | Blogadapter funktioniert gegen das gewählte Ziel; ohne Ziel ist Export geprüft und Live-Publikation ausdrücklich blockiert. |
| A17 | Slack-Ausnahme und eindeutig zugeordnete, autorisierte Rückmeldung funktionieren; UI-Rückweg ist unabhängig nutzbar. |
| A18 | CSV-Reimport dupliziert keine Messwerte; Währung, Zeitraum und fehlerhafte Zeilen werden geprüft. |
| A19 | Worker-Neustart verliert weder Arbeitsstatus noch ausstehende Freigaben. |
| A20 | Timeout nach externer Publikation erzeugt keine blinde doppelte Veröffentlichung. |
| A21 | Doppelte Webhooks und wiederholte Freigaben erzeugen keine doppelten Nebenwirkungen. |
| A22 | Pause verhindert neue lokale Writes und klärt externe Termine inklusive nicht abbrechbarer Fälle. |
| A23 | Zeitumstellung erzeugt keine doppelten oder verschwundenen geplanten Aufgaben. |
| A24 | Prompt-Injection, SSRF, XSS und Cross-Project-Zugriff werden mit negativen Tests abgedeckt. |
| A25 | Logs, Traces, Frontend-Bundle und Repo enthalten keine echten Secrets oder persönlichen Demo-Daten. |
| A26 | Vollständiger Contentzyklus im Test wird ohne manuelle Eingriffe außerhalb definierter Ausnahmefälle beendet. |
| A27 | Kleiner Datenbestand erzeugt ein unsicheres Experimentergebnis statt eines erfundenen eindeutigen Gewinners. |
| A28 | Desktop-/iPhone-Kernabläufe, Tastatur, Kontraste und reduzierte Bewegung werden im Browser geprüft. |
| A29 | Visueller Vergleich mit Konzept und EDS-Referenz dokumentiert; Original-Logo oder offene Asset-Blockade ausgewiesen. |
| A30 | Backup und Wiederherstellung in isolierter Umgebung getestet. |
| A31 | Connector-Ausfall, API-Limit und Modell-Ausfall werden begrenzt wiederholt und verständlich als Ausnahme behandelt. |
| A32 | Alle enthaltenen Bedienaktionen sind funktionsfähig oder transparent wegen fehlender Fähigkeit deaktiviert. |

Live-Tests ausschließlich in autorisierten Testkonten bzw. mit ausdrücklich genehmigten Inhalten und Kosten. Keine echten Marketingveröffentlichungen als versteckter Smoke-Test.

Ein sieben Tage umfassender simulierter Scheduler-/Workflow-Zyklus ist ein sinnvoller Test, ersetzt aber keine siebentägige reale Beobachtung. Beides im Bericht klar unterscheiden.

## 13. Definition of Done und Übergabe

Der Build-RC ist erreicht, wenn alle im aktuellen Scope implementierbaren Kernpfade integriert sind, deterministische Tests bestehen, keine offenen kritischen/bedeutenden bekannten Sicherheitsfehler vorliegen, die UI getestet wurde und externe Voraussetzungen explizit dokumentiert sind.

Produktiver Autopilot ist erst aktivierbar, wenn für seine konkreten Aktionen Modelle, Knowledge-Freshness, RAG-Qualitätsgates, Evidence-Prüfung, Quellenrechte, Credentials, Connector-Fähigkeiten, Budget, Inhalte und Owner-Mandat geprüft sind. Ein RC mit extern blockiertem Live-Adapter ist nicht gleichbedeutend mit vollständig live abgenommenem Betrieb.

Abschlussdateien mindestens:
- `docs/FRAMEWORK_BASELINE.md`
- `docs/PRODUCT_DECISIONS.md`
- `docs/AUTONOMY_POLICY.md`
- `docs/MODEL_ROUTING.md`
- `docs/CONNECTOR_CAPABILITIES.md`
- `docs/ACCEPTANCE_REPORT.md`
- `docs/SECURITY_REVIEW.md`
- `docs/OPERATIONS.md`
- `docs/RELEASE_READINESS.md`
- `docs/KNOWLEDGE_ARCHITECTURE.md`
- `docs/RAG_EVALUATION_REPORT.md`
- `docs/MARKETING_MEMORY.md`
- `docs/DATA_LIFECYCLE.md`
- `docs/REQUIREMENTS_TRACEABILITY.md`
- `docs/IMPLEMENTATION_STATUS.md`
- `docs/LIVE_ACTIVATION_CHECKLIST.md`

Abschlussantwort enthält: implementierte Funktionen, ausgeführte Tests mit Ergebnissen, Screenshots/Evidenz, verifizierte Live-Fähigkeiten, offene externe Blockaden, konkrete Start-/Setup-Schritte aus dem tatsächlichen Framework und eine klare Aussage, ob nur Build-RC oder auch Live-Abnahme erreicht ist.

Nicht mit einem bloßen Plan, leeren Agentenverzeichnissen, Mock-Adaptern als vermeintlichen Integrationen oder einer hübschen Oberfläche ohne Backend fertig melden.

## 14. Hosting: gemeinsamer Services-Host, getrennte Produkt- und Compute-Systeme

Dieser Abschnitt definiert das vorbereitete Deployment-Ziel. Er ist keine Serverbestellung und keine Freigabe einer Bestandsmigration. Konkreter Anbieter und Zielhost werden erst nach Inventur und Owner-Entscheidung gebunden.

### 14.1 Zielaufteilung

- **Desk:** eigener, unveränderter Produktserver mit seinen eigenen Datenbanken, Queues, Schlüsselgrenzen und Deployments. Orbit erhält keine Trading-/Wallet-/Exchange-Schlüssel. Desk darf durch Ausfall von Marketing/Analytics weder Login noch Trading blockieren.
- **Services:** EDS Orbit, Postiz, Matomo einschließlich zugehörigem Analysis-/MCP-Dienst, benötigte Slack-/Webhook-Brücken und kleine verifizierte Nebenanwendungen. Jeder Stack wird separat betrieben und aktualisiert.
- **Forecast:** bestehenden Compute-Server vorerst getrennt lassen. Kein Trainings-, Backtest-, Snapshot- oder Modellumzug im Orbit-Auftrag. Forschungsläufe und produktive Inferenz nicht ungeprüft gemeinsam priorisieren.
- **Bestehende externe Plattformen:** beispielsweise eine vorhandene FamilyPlan-/Supabase-Umgebung nicht beiläufig migrieren. Sie ist kein automatisch freigegebener Konsolidierungskandidat.
- **Backups und externe Erreichbarkeitsüberwachung:** außerhalb des Services-Hosts, mit unabhängiger Fehlerdomäne und getrennten Wiederherstellungsrechten.

Ein Ausfall des Services-Hosts legt bewusst mehrere Marketing-/Analytics-Dienste gleichzeitig still. Container sind weder Hochverfügbarkeit noch ein Ersatz für separate Host-Sicherheitsgrenzen. Diese akzeptierte Restgefahr muss im Betriebsplan stehen. Strikte Verfügbarkeit würde mindestens ein anderes Betriebsmodell erfordern und ist nicht Teil dieses ersten Single-Server-Deployments.

### 14.2 Zwei unterstützte Betriebsvarianten

**Standalone für Open Source:** Orbit kann allein mit seinen eigenen Datenbank-/Queue-/Speicherkomponenten gestartet werden. Postiz, Matomo und Slack werden über konfigurierte Endpunkte verbunden, nicht zwangsweise mitinstalliert.

**Shared Host für EDS:** Orbit nutzt den vorhandenen Host-Reverse-Proxy. Keine zweite Bindung auf Host-Ports 80/443 und keine Neuerstellung fremder Compose-Projekte, Netzwerke oder Volumes. Unterschiedliche Projekte für Orbit, Postiz, Matomo und Basisdienste; Konfigurationen in getrennten Verzeichnissen, z. B. `/srv/orbit`, `/srv/postiz`, `/srv/matomo`, `/srv/platform`. Diese Pfade sind Vorschläge, keine Behauptung über den Ist-Zustand.

Nur der Host-Reverse-Proxy wird öffentlich erreichbar; Backend-/Datenbank-/Queue-Ports bleiben intern. Proxy-Netz nur für benötigte Frontend-Dienste; Datenbanknetze jeweils privat. Authentifizierte interne APIs statt gemeinsamer Datenbankzugänge. PostgreSQL-/Redis-/MariaDB-Komponenten besitzen pro Anwendung eigene Benutzer, Credentials, Volumes und klar getrennte Lebenszyklen. Zu Beginn keine appübergreifend konsolidierte Datenbankinstanz nur zur RAM-Einsparung.

### 14.3 Vorläufige Dimensionierung, keine gemessene Kapazitätszusage

Planungsbasis für die eigenen Marken, normale Web-/Analytics-Last und API-basierte Agenten: **32 GB RAM, ungefähr 8–12 moderne CPU-Ausführungseinheiten, 500 GB bis 1 TB NVMe, x86-64**, mit belegbaren CPU-Zusagen des Anbieters. Physische Kerne, Threads und vCPUs dürfen im Vergleich nicht gleichgesetzt werden.

Kein GPU-Bedarf für das vorgesehene remote ausgeführte Sprachmodell-Routing. Lokale Modelle, umfangreiches Videorendering, große Browser-Farmen und Forecast-Training sind nicht in dieser Dimensionierung enthalten. 64 GB erst nach gemessenen Spitzen, wachsendem Bedarf oder bewusstem Reservebedarf wählen; zusätzlicher RAM löst keinen gemeinsamen Hostausfall.

Knowledge-Last zusätzlich vermessen: Dokument-/Chunkzahl, Originaldateien, Vektoren, Volltext-/Vektorindizes, Indexaufbau, DB-Working-Set, Query-Latenz, Backups und wachsende Quellenversionen. Embedding-Berechnung über OpenAI ersetzt nicht den lokalen Speicher-/Indexbedarf. Ingestion und Reindexierung dürfen Publishing/Matomo nicht verdrängen. Keine pauschale Behauptung, dass die zusätzliche RAG-Last ohne Messung in die ursprüngliche RAM-Reserve passt.

Finale Auswahl auf vorhandene Zeitreihen, gleichzeitige Lastspitzen, Datenbank-/Medienwachstum, belegten Restore-Bedarf und Vertragskosten stützen. Mindestens etwa 25–30 Prozent freie Planungsreserve anstreben; die tatsächliche Nutzung muss mit App-Lasttests und Produktionsmetriken überprüft werden. Große Builds/E2E-Läufe außerhalb des produktiven Hosts durchführen.

### 14.4 Ressourcen, Sicherheit und Betrieb

CPU-, RAM- und Prozesslimits explizit setzen und ihre tatsächliche Wirksamkeit in der gewählten Compose-/Engine-Version überprüfen. Grenzen und Worker-Concurrency vor Aktivierung in Staging testen. Logrotation, Medienaufbewahrung, Disk-Watermarks, Queue-Backpressure sowie Timeout/Retry-Obergrenzen konfigurieren. Matomo-Archivierung und datenintensive Wartungsjobs zeitlich kontrollieren.

Keine Docker-Socket-Mounts, SSH-Keys, Host-Root-Rechte oder Provider-Admin-Tokens in Marketingagenten. Browser-/Recherchewerkzeuge gegen SSRF und Zugriff auf private Netze, Cloud-Metadaten und fremde lokale Dienste absichern. Betriebssystem und Container im kontrollierten Prozess patchen; Updates zustandsbehafteter Anwendungen nicht blind über bewegliche `latest`-Tags auslösen.

Backups umfassen anwendungskonsistente Datenbanken, Medien, Knowledge-Quelldateien, Fakten-/Dokumentversionen, aktive Indexkonfigurationen, Lösch-/Widerrufsjournal, verschlüsselte Credential-/Schlüsselkonfigurationen, Aktionsjournal und Wiederanlaufzustände. Nach Restore zunächst keine externen Writes; Widerrufe, Quellenversionen und Remote-Publishing-Status abgleichen. Ein Wiederaufbau der Embeddings braucht ein kontrolliertes Budget und darf gelöschte Daten nicht erneut importieren. Backup-Schlüssel separat sichern, nicht in Git. Host-Snapshots ergänzen, ersetzen aber keine unabhängig wiederherstellbaren Off-Host-Backups. Restore auf leerem isoliertem Ziel testen; Job-Replay darf keine bereits erledigten externen Aktionen verdoppeln.

Vorgeschlagene, erst zu vereinbarende Services-Ziele: maximal eine Stunde Verlust kritischer Orbit-/Publish-Zustände und Wiederanlauf innerhalb eines Arbeitstags. Diese Ziele sind keine erreichte Zusage; Backup-Technik, Aufwand und Restore-Test müssen dazu passen. Gibt es nur tägliche Datenbanksicherungen, darf kein Ein-Stunden-Wiederherstellungspunkt behauptet werden. Bereits extern veröffentlichte Aktionen vor erneutem Ausführen mit dem Provider abgleichen.

Interne Metriken und Slack-Alarme vorsehen, aber zusätzlich extern prüfen, ob der Services-Host überhaupt erreichbar ist. Ein Monitor auf demselben ausgefallenen Host reicht nicht als alleinige Alarmierung. Keine eigenständige zusätzliche Monitoring-Plattform entwickeln, sofern bestehende einfache Werkzeuge ausreichen.

### 14.5 Migration getrennt vorbereiten, nicht ausführen

Vorbereitung ist zulässig; tatsächliche Umzüge verlangen jeweils Freigabe, geprüfte Sicherung, Wartungsfenster und datenkonsistenten Rollback.

1. Aktuelle Server, Verträge, Dienste, Versionen, Domains, Speicherpfade, Datenbanken, Queues, OAuth-/MCP-Abhängigkeiten und vorhandene Messdaten read-only inventarisieren. Bereits gelöschte Hosts nicht aus alten Listen übernehmen.
2. Orbit unabhängig als neue Installation für den Zielhost vorbereiten. Bestehende Systeme nur mit eng begrenzten API-Zugängen anbinden. Öffentliches Deploy und Autopilot-Aktivierung bleiben separate Freigaben.
3. Bei Bestandsumzügen Softwareversion und Speicherlayout zunächst beibehalten; kein gleichzeitiges Major-Upgrade. Vorhandene Hostnamen, Matomo-Site-IDs, Tracking-Links, OAuth-Redirects, Issuer/Audience und MCP-Discovery-Pfade erhalten oder explizit prüfen.
4. Pro Service Datenbank und Dateien konsistent übertragen, Restore isoliert prüfen, Abschalt-/Umschaltfolge festlegen. Keine kopierten laufenden Datenbankverzeichnisse als automatisch konsistente Sicherung behandeln.
5. Für Postiz/Orbit/Newsletter immer nur einen aktiven Publisher/Scheduler je Bestand zulassen. Zielkopie zunächst ohne externe Schreibfähigkeit starten; beim Cutover alte Writer sperren, Endzustand synchronisieren und erst danach Ziel aktivieren.
6. Matomo-Tracking und Archivierung am Ziel prüfen. Messlücken während Umzug benennen; keine ungeprüfte Zero-Downtime-Zusage. MCP-OAuth bis zum authentifizierten Toolaufruf prüfen, nicht nur HTTP-Erreichbarkeit.
7. Rollback vor und nach den ersten neuen Schreibvorgängen unterscheiden: nach Zielschreibvorgängen genügt ein DNS-Rückwechsel nicht. Daten-/Queue-Abgleich und Abgleich bereits veröffentlichter Inhalte ausdrücklich planen.
8. Altserver erst nach erfolgreicher Funktions-, Backup-/Restore- und Beobachtungsabnahme zur separaten Kündigungsentscheidung vorlegen. Nicht automatisch kündigen oder löschen.

Mit dem im bisherigen Projektkontext geplanten Presale-Start am 19. September 2026 keine kurzfristige Migration der funktionierenden Publishing-/Analytics-Dienste erzwingen. Tatsächlichen Kampagnenkalender prüfen und Wartungsfenster gesondert wählen. Providerwahl und DNS-/Cloudflare-Migration nicht unnötig mit App-/DB-Upgrades bündeln.

### 14.6 Zusätzliche Abnahmekriterien

| ID | Nachweis |
|---|---|
| H01 | Framework 1.1.0 und gewähltes Preset sind mit tatsächlichen Projektdateien und ADRs belegt. |
| H02 | Standalone- und Shared-Host-Varianten sind dokumentiert; keine Konflikte auf 80/443. |
| H03 | Separate Compose-Projekte, Credentials, Volumes und Netzwerke verhindern unbeabsichtigte Stack-Übergriffe. |
| H04 | CPU-/RAM-/Prozesslimits, Concurrency und Backpressure sind getestet; fehlende I/O-Garantien benannt. |
| H05 | Marketing-/Analytics-Ausfall führt nicht zu einer Pflichtabhängigkeit von Desk. |
| H06 | Kein Agent kann Docker, Hostdateien, SSH oder Cloud-Provider administrieren. |
| H07 | Off-Host-Backup und isolierter Restore inklusive Medien und Entschlüsselungsmaterial sind nachgewiesen. |
| H08 | Externe Erreichbarkeitsalarmierung ist dokumentiert und tatsächlich geprüft. |
| H09 | Ein Publishing-Cutover kann nicht zwei aktive Writer für denselben Bestand erzeugen. |
| H10 | Rollback berücksichtigt Zielschreibvorgänge, Queue-Zustände und bereits externe Aktionen. |
| H11 | Bestandsdienste, DNS, Forecast und Desk bleiben ohne spezifische Freigabe unverändert. |
| H12 | Ressourcen-/Kostenbericht trennt echte Messungen, Annahmen, Listenpreise und Vertragsdaten. |

Zusätzliche Übergabedokumente: `docs/SHARED_HOST_DEPLOYMENT.md`, `docs/HOSTING_DECISION.md`, `docs/BACKUP_RESTORE.md`, `docs/SERVICE_MIGRATION_PLAN.md` und `docs/FRAMEWORK_BASELINE.md`. Infrastrukturplan und Testnachweise getrennt ausweisen.

---

## 15. Knowledge Layer und Hybrid RAG — verbindlicher erster Release

### 15.1 Architektur und Zuständigkeiten

Baue drei fachlich getrennte Wissensbereiche auf derselben kontrollierten Datenbasis:

| Bereich | Zweck | Was ausdrücklich nicht erlaubt ist |
|---|---|---|
| Structured Knowledge | Bestätigte Produktfakten, Preise, Termine, Links, Status, Brand- und Kampagnenregeln | Verbindliche Werte aus ähnlichen Textfragmenten erraten oder durch ältere Texte überschreiben |
| Project RAG | Relevante Ausschnitte aus zugelassenen Dokumenten, Websites, Guides, FAQs und Recherche abrufen | Dokumente als Systemanweisungen behandeln oder Treffer mit Wahrheit gleichsetzen |
| Marketing Memory | Redaktionelle Präferenzen, historische Inhalte und belegte Marketingerkenntnisse wiederverwenden | Eigene Texte als unabhängige Bestätigung verwenden; Beobachtungen als kausalen Erfolg ausgeben |

Strukturierte Fakten werden deterministisch per Fachschlüssel und Gültigkeitsbereich abgefragt. RAG liefert Kontext und Quellen; es ersetzt weder Zahlenberechnung noch Policy-Engine. Der Knowledge-Service darf keine Veröffentlichungen, Budgets oder Infrastrukturaktionen auslösen. Er liefert typisierte Belege und bekannte Lücken an die bestehenden Workflows.

Der fachliche Pfad lautet:

`Ziel → Planner → Wissensbedarf → aktuelle Fakten + autorisiertes Retrieval → Evidence-Pack → Content → Claim-/Brand-Prüfung → Policy → erneuter Preflight → erlaubte Aktion → Messdaten → geprüfte Erkenntnis → Folgeplanung`.

Hybrid Retrieval ist eine Projektentscheidung für Self-Hosting: PostgreSQL-Volltextsuche und pgvector statt einer zusätzlichen verpflichtenden Vektordatenbank. pgvector dokumentiert die Kombination mit Volltextsuche und Ranking-Fusion [S14]. Ein Managed-File-Search-/Vector-Store-Backend ist **kein zweiter Pflichtpfad** des ersten Releases. Eine spätere Alternative darf hinter einem Interface ergänzt werden, ohne Fakten- und Rechteverwaltung auszulagern.

### 15.2 Datenmodell, Herkunft und verbindliche Fakten

Definiere die Datenverträge vor Agentenprompts. Die folgenden fachlichen Objekte müssen abgebildet werden; die konkrete Tabellenaufteilung wird in einer ADR festgelegt, nicht jedes Objekt braucht einen eigenen Dienst:

| Objekt | Mindestinhalt |
|---|---|
| KnowledgeSource | Workspace/Projekt, Typ, erlaubte Origin/Pfade, Zugriffsprofil, Zweck, Rechteklasse, Sync-Regeln, Owner, Status |
| KnowledgeDocument / DocumentVersion | externe stabile ID, kanonische URL, Titel, Sprache, Quellenversion, Content-Hash, Extraktionsversion, Speicherreferenz, Vorgänger |
| KnowledgeChunk | Dokumentversion, Chunk-Hash, Position/Abschnitt, Textreferenz, Sprach-/Themenmetadaten, Seiten-/Absatzanker |
| EmbeddingProfile / ChunkEmbedding | Anbieter/Modell-ID, Dimension, Distanzmetrik, Transformationsversion, Indexgeneration und Vektor |
| ProductFact / FactVersion | Fachschlüssel, typisierter Wert, Einheit/Währung, Gültigkeit, Verifikation, Quelle, zuständiger Prüfer und Ersetzungsbeziehung |
| SourceSyncRun / IngestionJob | Cursor, Run-ID, Start/Ende, importiert/unverändert/fehlgeschlagen/entfernt, Kosten, Fehler, Wiederaufnahme |
| KnowledgeConflict | betroffene Fachschlüssel/Versionen, Konfliktart, Quelle, Auswirkung, Resolution und Bearbeiter |
| EvidencePack / EvidenceItem | Query- und Retrievalversion, konkrete Fakten-/Chunkversionen, Auswahlgrund, Gültigkeitsprüfung, Rechte, Lücken |
| ContentClaim / ContentDependency | konkrete Aussage, zugehörige Contentversion, verwendeter Fakt/Beleg, Prüfstatus und Änderungsabhängigkeit |
| KnowledgeTombstone / Revocation | betroffene Ressource, Entzug/Löschung, Zeitpunkt, Generation, Weiterverarbeitungsverbote und Bereinigungsstatus |
| MarketingInsight / EditorialPreference | Art der Erinnerung, Datenbelege, Gültigkeit, Bestätigung und Grenzen; siehe Abschnitt 16 |

Jedes quellengestützte Objekt benötigt verbindliche Projektzuordnung. `workspace_id`/`tenant_id` als einen einheitlich benannten Mandantenbegriff wählen; `project_id` zusätzlich für die Marke. Auch Foreign Keys, Unique Constraints, Queue-Payload-Referenzen, Blob-Pfade und Caches müssen diese Trennung berücksichtigen. Keine unbeschränkte globale Chunksuche.

**Zeit und Status sind getrennte Dimensionen:**

- `source_updated_at`: vom Quellsystem ausgewiesener Änderungszeitpunkt, mit Angabe, ob er vertrauenswürdig verfügbar ist.
- `fetched_at`/`last_successful_sync_at`: Zeitpunkt des technischen Abrufs; nicht gleich inhaltlich geprüft.
- `verified_at`/`verified_by`: wann und durch wen ein verbindlicher Fakt bestätigt wurde.
- `valid_from`/`valid_until`: fachliche Gültigkeit mit UTC-Zeitpunkten und expliziter Interpretation der Quellzeitzone.
- `recorded_at`/`supersedes_id`: nachvollziehbare Historie; Versionsnummer allein ersetzt keine Gültigkeit.
- Fachstatus z. B. `candidate`, `verified`, `conflicting`, `expired`, `superseded`, `revoked`; technischer Sync-/Indexstatus separat.

Preise als Decimal mit Währung, Mengen mit Einheit und Fristen mit eindeutiger Zeitzone speichern. Gültigkeit möglichst als halb offenes Intervall `[valid_from, valid_until)` behandeln. Für denselben Fakt-/Projekt-/Markt-/Sprachgeltungsbereich dürfen nicht still zwei widersprüchliche aktive Werte existieren. Unklare Angaben werden nicht als verifiziert markiert.

**Autorität ist eine serverseitige Policy, kein vom Dokument frei gesetztes Feld.** Bevorzugte Reihenfolge: bestätigter strukturierter Fakt; ausdrücklich als maßgeblich zugelassene aktuelle offizielle Dokumentation; aktuelle eigene Website; freigegebene historische Inhalte; externe Recherche. Gleichrangige widersprüchliche Informationen führen zur Konfliktprüfung. Relevanzscore oder Aktualität allein darf diese Reihenfolge nicht überstimmen.

Ein veränderter Website-Text kann eine Faktenänderung vorschlagen und betroffene Inhalte zurückhalten. Er darf nicht selbstständig Preise, Produktversprechen oder Regeln als bestätigt überschreiben. Automatische Verifikation ist nur für vorher ausdrücklich zugelassene maschinenlesbare Faktenquellen, konkret zugeordnete Felder und eine passende Policy zulässig. Owner-Korrekturen werden versioniert und für alle betroffenen Agenten wirksam.

### 15.3 Quellenaufnahme und inkrementelle Synchronisierung

**Funktionsfähiger Pflichtumfang:** manuelle Fakten/Brand-Regeln; TXT/Markdown-Import; sicher extrahiertes HTML; freigegebene öffentliche Website-/Blog-/GitBook-Seiten. Sitemap oder Feed verwenden, wenn tatsächlich verfügbar. Ein fehlender privater GitBook-Zugang darf den funktionierenden Public-Web-/Dateiimport nicht blockieren. GitBook-Web-Import ist nicht als verifizierter privater API-Connector auszugeben.

Textbasierte PDFs und DOCX-Dateien mit gepflegten lokalen Parsern unterstützen, sofern die gewählten Pakete sicher integriert und mit Fixtures geprüft sind. Tabellen, Abschnitte und Quellenanker erhalten. Verschlüsselte, defekte oder rein gescannte Dateien sauber als nicht extrahierbar kennzeichnen. OCR nicht stillschweigend aktivieren; nur als gesonderte, begrenzte Fähigkeit mit Kosten-/Datenschutzentscheidung. Nie eingebettete Makros, Skripte oder importiertes MDX ausführen.

Optional innerhalb eines bestehenden, autorisierten Connectors: Release Notes, ausgewählte GitHub-Dokumentationspfade und frühere eigene Posts/Kampagnen importieren. Ganze Repositories, private Nachrichtenbestände oder Kontaktdaten sind keine automatisch erlaubte Wissensquelle. Private Connector-Zugänge müssen in Orbit separat eingerichtet sein; eine hier oder in Codex verbundene App überträgt keine Credentials in das Produkt.

**Ingestion-Pipeline:**

1. Quelle, Umfang, Verwendungsrechte und erlaubte Datenübermittlung prüfen.
2. Domain-/Pfad-Allowlist, MIME-Typ, Größen-/Zeit-/Seitenlimits und Robots-/Nutzungsregeln anwenden; keine Zugangssperren umgehen.
3. Sicher abrufen, kanonisieren, Boilerplate entfernen und Struktur erhalten. Originaldateien nur entsprechend der konfigurierten Aufbewahrung speichern.
4. Sprache, Titel, Abschnitts-/Seitenanker und Herkunft erfassen. Behauptete Metadaten aus Dokumenten sind Eingabedaten, keine Sicherheitsentscheidungen.
5. Content-Hash mit vorhandener Version vergleichen; unveränderte Inhalte nicht erneut vollständig verarbeiten oder bezahlen.
6. Neue Version und Chunks zunächst als vorbereitete Generation anlegen; Embeddings erstellen; Integrität und erwartete Anzahl prüfen.
7. Fertige Dokument-/Indexgeneration transaktional aktivieren. Ein halber Import darf keinen gemischten aktuellen Wissensstand erzeugen.
8. Abhängige Content-/Faktenprüfungen, Caches und Knowledge Health aktualisieren; Kosten und technische Fehler dokumentieren.

Stabile externe IDs, ETags/Last-Modified soweit verfügbar, Inhalts-Hashes, idempotente Jobschlüssel, Backoff und Checkpoints verwenden. Wiederholtes Importieren derselben Datei darf weder Dokumente noch Kosten unnötig vervielfachen. Inhaltliche Duplikate innerhalb eines Projekts deduplizieren, ohne unterschiedliche Herkunfts- oder Nutzungsrechte zu verlieren.

Chunking anhand von Überschriften, Absätzen und Dokumentstruktur implementieren. Startkandidat für Fließtext: ungefähr 600–900 Tokens mit geringem, z. B. 80–120 Tokens umfassendem Overlap; dies ist ein zu evaluierender Produktdefault, kein allgemeingültiges Optimum. Kurze FAQs, Faktenblöcke, Tabellen und Code nicht mechanisch genauso zerschneiden. Keine Tabellenwerte ohne Spaltenkontext oder Überschriften als Beleg ausgeben.

**Fehlermodell:** Ein transienter Timeout entfernt nicht den ganzen Wissensbestand. Die letzte vollständige Version kann innerhalb ihrer erlaubten Freshness weiterverwendet werden. Rechteentzug, bestätigte Löschung und abgelaufene fachliche Gültigkeit dagegen sofort sperren. Eine Seite, die in einem unvollständigen Crawl fehlt, ist nicht automatisch gelöscht. 401/403, 404/410, temporäre Serverfehler und Parserfehler unterscheiden; Unsicherheit bei Veröffentlichungsrechten blockiert die betroffene öffentliche Nutzung.

### 15.4 Embeddings, Datenbank und Kosten

OpenAI-Embedding-API über einen zentralen Adapter verwenden. Erster zu evaluierender Kandidat: `text-embedding-3-small`, 1536 Dimensionen. Die offizielle Dokumentation nennt 1536 als Default für small und 3072 für large sowie eine konfigurierbare Dimensionsreduktion [S13]. Das konkrete Konto muss das Modell unterstützen; öffentliche Dokumentation ist kein Kontonachweis.

Bei schlechter Recall-Qualität zunächst Extraktion, Chunking, Filter und Suchanfragen prüfen. Ein Wechsel auf `text-embedding-3-large` ist erst nach einem dokumentierten Vergleich sinnvoll. Kein automatischer Wechsel mit Vermischung inkompatibler Vektorräume. Nicht auf Verdacht sämtliche Inhalte erneut kostenpflichtig einbetten.

Dimensionen, Distanzmetrik, Typ und Index müssen zusammenpassen. Die dokumentierten HNSW-Grenzen von pgvector unterscheiden u. a. `vector` bis 2000 und `halfvec` bis 4000 Dimensionen [S14]. Deshalb nicht blind einen 3072-dimensionalen Default in einen dafür ungeeigneten `vector`-HNSW-Index stecken. Bei large z. B. eine getestete niedrigere Ausgabedimension oder einen passenden Typ mit eigener ADR wählen.

Für Prisma **die tatsächlich gewählte Version** prüfen. Je nach Version kommen dokumentierte Erweiterungen oder angepasste SQL-Migrationen und Raw-/TypedSQL für Vektortypen zum Einsatz [S16]. Keine Mischung inkompatibler Prisma-Generationen und keine ungeprüften Annahmen über native Unterstützung. Parametrisierte Abfragen; kein vom Modell erzeugtes freies SQL. Test-Datenbank enthält dieselbe pgvector-Version und dieselben sicherheitsrelevanten SQL-Objekte wie die Zielkonfiguration.

Embedding-Identität mindestens aus Mandant/Projekt, erlaubtem Inhalt, normalisiertem Chunk-Hash, Modell, Dimension, Vorverarbeitungs- und Chunking-Version bilden. Bei Rechteänderungen Lesbarkeit und Cachezugriff neu prüfen, auch wenn der Vektor physisch wiederverwendbar wäre. Cachetreffer zwischen fremden Projekten dürfen keine Existenz oder Inhalte offenlegen.

Modell-/Dimensionalitätswechsel: getrennte neue Indexgeneration, budgetierter Hintergrundaufbau, Evaluation, atomarer Wechsel und dokumentierter Rollback. Die alte Generation bleibt nur innerhalb ihrer Aufbewahrungs- und Rechtebedingungen. Eine Löschung darf durch Reindexierung oder Rollback nicht rückgängig gemacht werden.

Kosten umfassen initiale Dokument-Embeddings, spätere Änderungen, Query-Embeddings, optionale Query-Rewrites/Reranking, Inhaltsgenerierung und bezahlte Tools. Tages-/Monats-/Run-Limits, Kostenreservierung, begrenzte Batchgröße, Rate Limits und Priorität für zeitkritisches Publishing durchsetzen. API-Ausfall führt zu einem sichtbaren Degraded-/Blocked-Status; keine stillschweigende Behauptung, hybride Suche funktioniere vollwertig ohne Vektoren.

**Datengrenze:** Originale und Vektoren werden in der eigenen Anwendung gespeichert, aber eingebettete Texte und ausgewählte Generierungskontexte werden an OpenAI übermittelt. Das ist kein vollständig lokaler/offline KI-Betrieb. Nur zulässige, notwendige Inhalte senden; keine Empfängerlisten oder Secrets. Response-Speicherung soweit passend deaktivieren; `store=false` ist keine allgemeine Zero-Data-Retention-Zusage für alle Endpunkte, Logs und Tools [S17]. Verfügbarkeit, Regions- und Retention-Einstellungen dokumentieren, nicht erfinden.

### 15.5 Hybrid Retrieval und Evidence-Pack

Retrieval ist ein serverseitiger, typisierter Dienst mit Authentifizierung und Zweckbindung. Request: Projekt, Task-Typ, Sprache, zulässiger Wissenszweck, fachlicher Stichtag/Publikationszeitpunkt, Query und Budget. Der authentifizierte Server bestimmt den effektiven Mandanten-/Rechtekontext; die vom Agenten gelieferte Projekt-ID allein autorisiert nichts.

Ablauf:

1. Relevante aktuelle strukturierte Fakten und verbindliche Regeln zuerst per Fachschlüssel laden.
2. Erlaubten Kandidatenraum aus Projekt, Quellberechtigung, Dokumentstatus, Gültigkeit, Verwendungszweck, Sprache und Public-/Internal-Klassifikation bilden.
3. Exakte Begriffe wie Produktnamen, Ticker, URLs und IDs separat unterstützen. Native Volltextsuche mit geeigneter DE-/EN-Konfiguration und einer Strategie für nicht zu stemmende Bezeichner verwenden.
4. Vektor- und lexikalische Kandidaten innerhalb derselben Berechtigungs-/Versionsgrenzen abrufen und mit einer nachvollziehbaren Fusion, zunächst RRF, kombinieren. PostgreSQL-FTS nicht fälschlich als eingebautes BM25 bezeichnen.
5. Doppelte/überlappende Chunks reduzieren, dokumentbezogene Vielfalt erhalten und das Context-Budget einhalten. Autorität und Gültigkeit sind harte Regeln, keine bloßen Rankinggewichte.
6. Optionales budgetiertes Reranking nur auf bereits autorisierten Kandidaten, ohne Rechteerweiterung; kein zusätzlicher externer Modellanbieter.
7. Ausgewählte Fakten, Belege, Konflikte und explizite Wissenslücken als versioniertes Evidence-Pack ausgeben.

Zunächst exakte Vektorsuche für kleine, vorgefilterte Projektbestände als verlässliche Baseline testen. HNSW/ANN nur mit belegtem Performancebedarf und Recall-Vergleich aktivieren. Selektive Filter können bei ANN zu weniger Treffern führen; geeignete iterative Scans, Filterindizes oder begrenzte exakte Fallbacks sind zu testen [S14]. Nie zur Verbesserung der Treffermenge Projektfilter entfernen oder zuerst fremde Inhalte an ein Reranking-Modell senden.

Startwerte wie Candidate-Pool, `top_k`, maximale Chunks pro Dokument und Context-Tokenlimit zentral konfigurieren. Beispielbaseline: bis zu 40 Kandidaten je Suchzweig, 8 finale Chunks und ein klar begrenztes Context-Budget. Werte sind konfigurierbare Ausgangspunkte und werden mit Evals angepasst, nicht als bewiesenes Optimum behauptet.

Evidence-Pack enthält mindestens: eindeutige ID, Projekt und Zweck, Query-/Retriever-/Indexversion, Erzeugungs- und fachlichen Stichtag, Faktenversionen, konkrete Chunk-/Dokumentversionen, zitierfähige Quellenanker, Auswahlgründe, Konflikte, Freshness, ausgeschlossene/veraltete Quellen und offene Fragen. Ein Hash referenziert den verwendeten Stand. Keine bloße Liste von URLs und keine erfundenen Zitate.

Bei fehlendem ausreichendem Beleg: `insufficient_evidence`, betroffene Claims benennen und nötigenfalls Inhaltsvorschlag ohne unbelegte Aussage erstellen. Nicht den gesamten Autopilot anhalten, wenn unabhängige Arbeit möglich ist. Historische Suche ist ein expliziter Modus; historische Ergebnisse sind nicht automatisch für aktuelle Publikationen freigegeben. Ähnlichkeitsscores nicht als Wahrheitswahrscheinlichkeiten darstellen.

### 15.6 Projekttrennung, Vertraulichkeit und sichere Verarbeitung

Drei getrennte Fragen serverseitig prüfen: **Darf dieser Nutzer/Agent die Information lesen? Darf sie an OpenAI gesendet werden? Darf sie in öffentlichem Marketing verwendet werden?** Ein interner Roadmap-Text darf trotz Leserecht nicht ungeprüft in einen öffentlichen Beitrag gelangen. Sensitivität und Embargo werden von autorisierten Nutzern/Policies gesetzt, nicht vom Quelltext oder Modell.

Default: keine projektübergreifende Suche, keine gemeinsame ungeschützte Memory und kein unkontrollierter Export. Gemeinsame EDS-Brand-Daten nur als ausdrücklich freigegebene, versionierte Shared Collection mit klaren Leserprojekten. Gemeinsame Marke bedeutet nicht gemeinsame Produktpreise oder Kundendaten.

PostgreSQL-RLS als zusätzliche Datenbankgrenze vorsehen; App-/Worker-Rollen sind weder Superuser noch `BYPASSRLS` noch unbeschränkte Tabellenowner. Bei notwendigen Owner-Zugriffen Rollen trennen und FORCE RLS passend einsetzen; PostgreSQL dokumentiert die entsprechenden Bypass-Regeln [S15]. RLS ersetzt nicht Authentifizierung, sichere Abfragen oder korrekt gesetzten Kontext. Connection-Pooling und transaktionslokale Tenant-Kontexte ausdrücklich negativ testen; keine Leckage durch wiederverwendete Sessions.

Die Rechteprüfung gilt auch für Chunk-Downloads, Suchvorschauen, Explain-Retrieval, Evidence-Links, API-Exports, Hintergrundjobs, Attachments, Logs, URL-State und Caches. Verweigerte Dokumente dürfen nicht mit Titel oder Ausschnitt in Fehlermeldungen auftauchen. Cachekeys berücksichtigen Mandant, Projekt, effektive Rechte, Quellen-/Indexgeneration und Zweck. Beim Entzug bestehende Caches und bereits vorbereitete Aktionen unbrauchbar machen.

Importierte Texte bleiben untrusted data. Sie dürfen keine Systemprompts, Tools, Modellzuordnung, Secret-Zugriffe, Faktenautorität oder Publikationspolicy umschreiben. Strukturiertes Parsing und getrennte Toolrechte verwenden; ein Textfilter allein ist kein Schutz gegen alle Prompt-Injections [S5]. Auch ein freundlicher vermeintlicher „Admin-Hinweis“ in einer Website bleibt Quelleninhalt.

URL- und Asset-Fetcher gegen SSRF absichern: erlaubte Schemes/Origins, Ports/Pfade, validierte DNS-Auflösung und tatsächliches Verbindungsziel; Loopback, private/link-local/Metadaten-Adressen einschließlich IPv6 und Redirect-Umgehungen verhindern. Redirects standardmäßig nicht folgen oder jeden Schritt vollständig erneut prüfen. Browser-Subrequests, Bilder, CSS und Sitemap-Parser in dieselbe Egress-Grenze einbeziehen; keine XML-External-Entities. Authentifizierte interne Service-Connectoren verwenden eine getrennte feste Allowlist, keine Ausnahme für den allgemeinen Crawler. OWASP-Leitlinien als Prüfreferenz nutzen [S19].

### 15.7 Löschung, Widerruf und Datenlebenszyklus

Ein autorisierter Quellenentzug setzt sofort eine persistente Sperre/Tombstone. Neue Retrievals, laufende Jobs, wiederholte Imports und wartende Publikationen dürfen den entzogenen Inhalt nicht mehr verwenden. Asynchrone physische Bereinigung darf die sofortige Zugriffssperre nicht verzögern.

Bereinigung umfasst je nach Policy Originaldateien, extrahierten Text, Chunks, Vektoren, Caches, Suchindizes, Prompt-/Trace-Inhalte, exportierte temporäre Artefakte, Evidence-Kopien und abgeleitete Memory. Minimal notwendige Audit-Metadaten dürfen separat nach dokumentierter Frist bestehen; „Audit“ ist kein Vorwand, alle gelöschten Klartexte dauerhaft aufzubewahren.

Löschung und Verarbeitung können gleichzeitig stattfinden. Jeder Job überprüft Ressourcen-/Revocation-Generation vor Lesen, vor externem Senden und vor Aktivierung seiner Ergebnisse. Stale Jobs dürfen keine gelöschte Quelle wiederherstellen. Entfernung einer ganzen Quelle, eines einzelnen Dokuments und einer Dokumentversion getrennt testen.

Backups haben eine eigene begrenzte Aufbewahrung. Nach Restore Widerrufe/Löschungen vor Wiederaufnahme des Autopiloten erneut anwenden; keine sofortige physische Löschung aus unveränderlichen Backups versprechen. Export-/Retention-/Restore-Verhalten und externe Providerreste nachvollziehbar dokumentieren.

Ein entfernter Beleg zieht nicht automatisch bereits öffentliche Beiträge im ganzen Internet zurück. Betroffene Veröffentlichungen auflisten, lokal sperren und nur mit vorhandener Adapterfähigkeit und passender Autorisierung aktualisieren/zurückziehen. Fehlende Rückholbarkeit ausdrücklich zeigen.

### 15.8 Belege bis zur Veröffentlichung sichern

Jede veröffentlichungsrelevante konkrete Behauptung braucht einen `ContentClaim` mit Referenz auf freigegebene Fakten oder auf tatsächlich stützende Belegstellen. Strenge Pflicht insbesondere für Preise, Termine, Zahlen, Leistungs-/Verfügbarkeitsaussagen, Token-/Presale-Angaben und externe Vergleiche. Reine Stilmittel nicht künstlich als Fakten behandeln.

Der Reviewer prüft, ob eine Quelle die Aussage wirklich stützt, ob Einschränkungen übernommen wurden und ob keine aus dem Kontext gezogenen Zitate entstehen. LLM-Prüfung ist ein Hilfsmittel, kein mathematischer Wahrheitsbeweis. Zahlen-/Preis-/Terminwerte soweit strukturiert deterministisch vergleichen; ungeklärte materielle Claims verhindern automatische Publikation.

Die öffentlich sichtbare Zitierform hängt vom Format ab: Blogartikel können Quellenabschnitte/Links enthalten; kurze Social-Posts brauchen nicht sämtliche internen Evidence-IDs. Intern bleibt die vollständige Zuordnung erhalten. Private Quellen-URLs, signierte Links oder vertrauliche Ausschnitte dürfen niemals automatisch veröffentlicht werden.

**Änderungsfolgen:** Fakten-/Quellenupdates erzeugen eine Auswirkungsprüfung über `ContentDependency`. Betroffene Entwürfe, Freigaben und Termine markieren; bei wesentlicher Änderung neues Contentpaket und neue Policy-/Freigabeentscheidung. Ein still geänderter Bildtext zählt ebenfalls als Contentänderung. Unabhängige Inhalte bleiben arbeitsfähig.

Unmittelbar vor einem externen Write erneut prüfen: Content-/Asset-Hash, effektive Policy, Pausenzustand, Kanal, Termin, Kosten, Evidence-Gültigkeit, aktive Faktenversion, Quelle/ACL/Embargo und Datenfrische. Für denselben Aktionsintent Race Conditions mit Locks/Fencing und transaktionalem Zustandswechsel begrenzen. Keine Datenbanktransaktion minutenlang während eines Provider-Netzaufrufs offenhalten. Den geprüften Stand und den Moment der externen Übergabe auditieren; eine Änderung nach bereits erfolgter Übergabe erfordert eine kompensierende Aktion und ist nicht vollständig vermeidbar.

Für Inhalte mit veränderlichen oder kritischen Fakten **lokal planen und just-in-time an den Publisher übergeben**, damit der letzte Check tatsächlich vor der Übergabe stattfindet. Eine weit im Voraus angelegte Remote-Schedule kann später ohne erneuten Orbit-Check veröffentlichen. Solche Remote-Termine nur zulassen, wenn Freshness-/Cancel-/Reconcile-Verhalten nachgewiesen und von der Policy gedeckt ist. Bei nicht rechtzeitig abbrechbarer Remote-Aktion ehrliche Ausnahme mit Risiko melden, nicht „sicher pausiert“ anzeigen.

Content- und RAG-Prüfung umfasst auch Ausgangslinks und Trackingparameter. Links auf autorisierte Kampagnenziele begrenzen; ihre Validierung nutzt denselben sicheren URL-Fetcher, keine neue SSRF-Lücke.

### 15.9 Knowledge-UI und nachvollziehbare Suchqualität

Ergänze einen vollständigen Bereich **Knowledge** im EDS-Liquid-Glass-Workspace:

- **Sources:** Quellen hinzufügen, erlaubten Umfang festlegen, Rechte-/Verwendungszweck, Sync-Status, letzte erfolgreiche Synchronisierung, Importfehler, Pause und autorisiertes Entfernen.
- **Facts:** verbindliche Werte, Gültigkeit, Versionen, Quellen, Review und Konfliktauflösung; Preis-/Termin-/Statusänderungen nicht hinter einem Chat verstecken.
- **Library:** Dokumente mit aktuellem Stand, älteren Versionen, Extraktions-/Chunkvorschau und klarer Public-/Internal-/Embargo-Kennzeichnung.
- **Knowledge Health:** getrennte Zahlen und konkrete Fälle für Konflikte, abgelaufene Fakten, fehlende Belege, fehlerhafte Imports und überfällige Synchronisierungen. Keine erfundene umfassende Wahrheitssicherheitsnote.
- **Retrieval Inspector:** Testfrage im eigenen Rechtekontext, verwendete Fakten/Chunks, Quellenanker, ausgeschlossene veraltete Ergebnisse, effektive Filter, Retrievalversion, Laufzeit und Kosten.
- **Impact:** welche Entwürfe, Freigaben und Publikationen von einer Fakten-/Quellenänderung betroffen sind.

„Zuletzt abgerufen“, „zuletzt indexiert“ und „inhaltlich verifiziert“ getrennt anzeigen. Quellanzahl oder große Vektormengen sind keine Qualitätskennzahlen. Vorschauen dürfen nur autorisierte Inhalte zeigen. Mobile Kernpfade: Konflikt verstehen, konkrete Faktenkorrektur bestätigen und betroffene Inhalte ansehen. Filter und große Tabellen dürfen diesen Pfad nicht verdrängen.

### 15.10 Evals, Regression und beobachtbarer Betrieb

Mit den dokumentierten Eval-Grundlagen als Referenz [S18] vor Live-Autopilot ein versioniertes synthetisches Knowledge-Evalset mit mindestens 60 Fällen aufbauen. DE/EN, exakte Produktbezeichner, semantische Fragen, widersprüchliche Altpreise, zukünftige/abgelaufene Fakten, unbekannte Antworten, Projektgrenzen, interne Dokumente, Prompt Injection, Widerruf, Löschung und Quellenkorrekturen abdecken. Keine echten Kundendaten in öffentlichen Fixtures.

Deterministische Tests prüfen Filter, Gültigkeit, Access Control, Versionswechsel, Caches und Publishing-Sperren. Embedding-/Retrieval-Evals zusätzlich gegen echte freigegebene Embedding-Aufrufe durchführen; statische Testvektoren belegen nicht die semantische Qualität des echten Modells. Kostenpflichtige Live-Evals nur mit ausdrücklich freigegebenem Testbudget. Fehlender API-Zugang führt zu `BLOCKED_EXTERNAL`, nicht zu behauptetem Qualitätserfolg.

Metriken getrennt ausweisen: Recall@k/MRR auf definierten relevanten Quellen, korrekte Quellenzuordnung, belegte Claims, Abstention bei unzureichendem Wissen, Freshness-Verstöße, getestete Zugriffsschutzfälle, Latenz, Kosten und Kontextgröße. LLM-Grader ergänzen deterministische Erwartungswerte und kontrollierte Sichtprüfung; nicht ausschließlich denselben schreibenden Agenten seine Texte freigeben lassen.

Erste vertragliche Qualitätsziele, keine schon erreichten Messwerte: `Recall@10 >= 0.90` auf den beantwortbaren Fällen des eigenen Goldsets; keine fremden/entzogenen/unerlaubt internen Belege in den dafür vorgesehenen Negativtests; alle deterministischen Preis-/Termin-/Versionssperren bestanden. Semantische Abdeckung und Abstention separat berichten und vor Autopilot-Aktivierung begründen. Ein endliches Testset ist keine allgemeine Fehlerfreiheitsgarantie.

Bei Prompt-, Modell-, Chunking-, Parser-, Rechte- oder Rankingänderungen relevante Regressionen erneut ausführen. Dataset/Config/Indexversion und Commit im Bericht festhalten. Gates nicht nachträglich senken, um einen fehlgeschlagenen Lauf als bestanden zu markieren.

Betriebsmetriken: Sync-Lag, aktive Quellen/Chunks, Fehler/Rate-Limits, Query-Latenz, Nulltreffer/Abstention, blockierte Claims, Budgetverbrauch, Reindex-Fortschritt und Queue-Last. Open-Source-Installation ohne externe Telemetriepflicht. Redigierte Logs und Referenzen statt sämtlicher Dokumenttexte; keine Geheimnisse und keine versteckten Modellgedankengänge sammeln.

---

## 16. Marketing Memory — nachvollziehbares Lernen ohne Faktenvermischung

### 16.1 Drei getrennte Erinnerungsarten

**Editorial Preferences:** ausdrücklich vom Owner bestätigte Tonalität, bevorzugte Formulierungen, Korrekturbeispiele und ausgeschlossene Stilmittel. Eine beiläufige Korrektur zunächst als Vorschlag behandeln; freigegebene Regeln versioniert anwenden. Ein Community-Kommentar ist keine Anweisung des Owners.

**Content History:** veröffentlichte bzw. freigegebene Inhalte, Thema, Sprache, Kanal, Kampagne, Contentversion, Zeitpunkt und Ergebnisreferenzen. Nutzbar für Wiederverwertung und Duplikatvermeidung, aber mit Herkunft `generated_derived`/`human_authored` gekennzeichnet. Eigene KI-Texte sind keine neue unabhängige Produktfaktenquelle.

**Performance Insights:** strukturierte Beobachtungen aus reproduzierbar berechneten Messdaten. Enthalten Quelle/Snapshot, Definition der Zielaktion, Zeitraum, Kanal/Zielgruppe, Nenner/Stichprobe, Attribution, Einschränkungen, Gültigkeit und Status `hypothesis`, `observed`, `experiment_supported`, `expired` oder `retracted`.

Das Modell wird dadurch nicht automatisch feintrainiert. Diese Memory ist kontrollierter Kontext. Kein Fine-Tuning, kein Forecast-Training und keine autonome Änderung von Systemprompts, Toolrechten oder Code im ersten Release.

### 16.2 Lernkreislauf und Schutz vor Selbstbestätigung

`Remote-/Website-Daten → normalisierte Events/Metriken → deterministische Aggregation → Insight-Vorschlag → Evidenz-/Methodenprüfung → erlaubte Verwendung im nächsten Plan`.

Kennzahlen und finanzielle Summen werden in Code/SQL berechnet, nicht vom LLM geraten. Quellenklicks, Website-Sessions und tatsächliche Produktaktionen bleiben verschiedene Größen. Datenkorrekturen oder nachlaufende Conversions aktualisieren betroffene Insights versioniert; aufgehobene Ergebnisse invalidieren abhängige Empfehlungen.

Der Planner darf bestätigte, risikoarme Erkenntnisse innerhalb des bestehenden Mandats nutzen, z. B. mehr konkrete Anwendungsbeispiele vorschlagen. Er darf daraus keine neuen Werbeausgaben, höhere Postingfrequenz, neue Zielgruppen oder Produktversprechen ableiten, wenn die Policy dies nicht schon erlaubt.

Keine falsche Kausalität: Ein erfolgreicher Beitrag kann wegen Budget, Kanal, Saison, Zielgruppe oder Zeitpunkt besser abschneiden. Kleine Stichproben, unvollständiges Tracking und widersprüchliche Quellen als Einschränkungen sichtbar halten. Keine Botquote aus bloßer Klickgeschwindigkeit errechnen. Keine vermeintliche Gewinnerwahl ohne vorher definierte Daten-/Stoppregeln.

**Self-Feedback-Sperre:** Eine Aussage aus einem alten Orbit-Post wird nicht dadurch glaubwürdiger, dass sie in einem späteren Blogartikel wiederholt wurde. Herkunftsketten erhalten und für Facts-Verification dieselbe Ursprungsquelle erkennen. KI-Zusammenfassungen oder zitierende Drittseiten gelten nicht automatisch als voneinander unabhängige Belege.

### 16.3 Aktualisierung, Korrektur und Rechte

Memory ist projektbezogen, korrigierbar, exportierbar und nach Policy löschbar. Private Inhalte und personenbezogene Datensätze standardmäßig nicht einbetten; möglichst aggregierte Erkenntnisse verwenden. Rechte-/Löschänderungen der Quelldaten gelten auch für davon abgeleitete Memory.

Erkenntnisse erhalten Review-/Verfallsregeln je Typ. Ein saisonaler Effekt oder eine frühere Presale-Phase darf die dauerhafte Produktkommunikation nicht unbemerkt dominieren. Owner kann Regeln oder Erkenntnisse gezielt deaktivieren und die Wirkung im Folgeplan sehen.

Quellenbasierte Memory-Zusammenfassungen dürfen über RAG gefunden werden, referenzieren aber immer das zugrunde liegende Insight-/Preference-Objekt und dessen Status. Wahrheit, Policy und Messdaten bleiben in ihren fachlichen Objekten, nicht nur in einem Vektoreintrag.

### 16.4 Messbares Produktziel

Orbit soll die manuelle Betreuung reduzieren, nicht nur mehr Text produzieren. Neben Zielaktionen auch Anteil zulässiger automatisch abgeschlossener Arbeit, Gründe für Blockaden, notwendige Owner-Eingriffe, Fehlpublikationen, Kosten je Contentpaket und Wiederholungen messen.

Eine hohe Autonomiequote darf nie durch Ignorieren von Konflikten oder gelockerte Sicherheitsregeln optimiert werden. Ein berechtigt angehaltener Beitrag ist kein Fehler, den der Agent durch Abschalten des Gates „beheben“ soll.

---

## 17. Ergänzte Betriebsanforderungen — möglichst wenig tägliche Betreuung

### 17.1 Guided Setup und überprüfbare Autopilot-Bereitschaft

Ein verständlicher Setup-Assistent führt durch Owner/Auth, Projekt, Zeitzone, Logo/Brand, Quellenrechte, bestätigte Kernfakten, Konten, Modellfähigkeiten, Kostenlimits und erlaubte Routineaktionen. Quellenimport darf einen Brand-/Facts-Vorschlag erzeugen; dieser ist vor Aktivierung eindeutig als Vorschlag gekennzeichnet und wird vom Owner bestätigt. Keine alten uLiquid-Preise oder Zugangsaussagen als produktive Defaults übernehmen.

Autopilot erst nach überprüfbarem Preflight aktivieren: notwendige Connector-Fähigkeiten, aktuelle Wissensbasis, geeignete Modelle, bestandene relevanten Evals, gültige Kostenlimits, Content-/Themen-/Kanallimits und ausdrückliches Owner-Mandat. Fehlende Newsletter- oder Ads-Provider blockieren nur die jeweiligen Fähigkeiten, nicht autorisierte Social-/Blog-Arbeit.

Die Bedienoberfläche unterscheidet `not_configured`, `draft_ready`, `test_ready` und `live_ready` je Fähigkeit. Verbundene Zugangsdaten allein sind keine bestandene Funktionsprüfung. Default bleibt Observe. Eine Simulation muss im Executor tatsächlich externe Writes verhindern; ein Label im Frontend genügt nicht. Bezahlte Embedding-/Textaufrufe brauchen auch im Observe-/Testmodus ein genehmigtes Budget.

### 17.2 Geschlossene Marketingsteuerung ohne Endlosschleifen

Ein Ziel braucht messbare Zielaktionen, Zeitraum, Zielgruppen, erlaubte Themen, Kanäle, maximale Frequenz und Budget. Der Lead erzeugt begrenzte Arbeitspakete, überprüft Ergebnisse und plant innerhalb dieser Grenzen weiter. Kein tägliches Neuaufblasen desselben Ziels zu unbegrenzt vielen Beiträgen oder Agentenläufen.

Posts mehrerer Kampagnen berücksichtigen gemeinsame Kanalquoten, Mindestabstände, Zeitzone und gegebenenfalls Ruhezeiten. Slots atomar reservieren, damit parallele Agenten Limits nicht gemeinsam überschreiten. Der Kalender zeigt Konflikte und manuelle Sperren. Agenten dürfen Quoten, Laufzeit oder Kampagnenziel nicht selbst erweitern.

Für Quellen-/Providerstörungen sinnvolle Degradation: validierte zeitlose Inhalte nur innerhalb ihrer gültigen Policy verwenden; andernfalls intern vorbereiten oder pausieren. Keine erfundenen Ersatzfakten, keine unverifizierte Preiswerbung und kein endloser Retry. Wiederanlauf nutzt vorhandenen Status statt alle Inhalte neu zu erzeugen.

### 17.3 Redaktionelle Qualität und Wiederverwertung

Vor Neu-Erstellung vorhandene Themen, Artikel und Posts prüfen. Exakte und semantisch ähnliche Inhalte auf Überlappung prüfen; zwischen erlaubter Kanaladaption und versehentlicher Wiederholung unterscheiden. Ein bestehender Blogartikel kann aktualisiert werden statt einen nahezu gleichen Artikel zu erzeugen. Inhaltliche Vielfalt ist kein Grund, neue unbelegte Behauptungen zu erfinden.

Kanalregeln, Zeichen-/Medienlimits und Linkformate aus verifizierten Adapterfähigkeiten beziehen. Blogpakete beinhalten Titel, Beschreibung, Slug, Gliederung, Quellen, interne Linkvorschläge, Alt-Texte und Aktualisierungsstatus. Keine erfundenen Testimonials, Referenzkunden, Zahlen, Performanceversprechen oder künstlichen Community-Interaktionen.

Vorlagen- und Medienrechte gelten auch für Reposts, Zuschnitte und neue Varianten. Vorhandenes EDS-Logo unverändert verwenden. Externe Recherche bedeutet nicht, fremde Artikel vollständig kopieren oder Bilder ohne Nutzungsrecht übernehmen zu dürfen. Rechte-/Lizenzhinweise als Datenobjekte erhalten; die Software ersetzt keine rechtliche Prüfung.

### 17.4 Ausnahme-Inbox statt Benachrichtigungsflut

Ausnahmen nach Ursache, Projekt, betroffenen Inhalten und Schwere gruppieren. Derselbe Quellenausfall oder Faktenkonflikt soll nicht für jeden Agenten erneut eine Slack-Nachricht erzeugen. Eine Korrektur kann mehrere abhängige Inhalte wieder zur Prüfung freigeben, aber nicht ohne erneute fachliche Checks direkt veröffentlichen.

Standardkommunikation: eine konfigurierbare Zusammenfassung und unmittelbare Hinweise nur bei kritischen Fehlern oder echten Entscheidungen. Ruhezeiten und Sammelintervalle sind Owner-Einstellungen, keine automatisch hier eingerichteten Benachrichtigungen. Meldungen enthalten konkret benötigte Entscheidung, kurze Begründung, betroffene Version und Link zur geschützten Vorschau.

Slack darf keine Geheimnisse oder private Dokumentvolltexte versenden. Aktionen über authentifizierte, versionierte, einmalig wirksame Freigaben. Veraltete mobile Vorschauen und wiederholte Antworten erneut validieren. Offene Browser-/PWA-Caches dürfen alte Freigaben nicht offline wirksam machen.

### 17.5 Verlässlichkeit, Budgets und betriebliche Diagnose

Kostenreservierungen und Nebenläufigkeit müssen Textmodelle, Embeddings, Bild-/Researchtools und Reindexierung gemeinsam berücksichtigen. Nicht bekannte oder noch nicht abgeglichene Kosten als solche behandeln; ein Timeout bedeutet nicht zwingend, dass keine Kosten entstanden sind. Owner-Limit weder durch neuen Agenten noch neuen Jobschlüssel umgehen.

Ein Operations-Bereich zeigt tatsächliche Worker-/Queue-/Connector-/Knowledge-Zustände, letzten Erfolg, festhängende Läufe, fehlendes Budget und benötigte Konfiguration. Sichere Aktionen wie lokalen Job erneut prüfen, neu planen oder pausieren brauchen klare Rollen. Keine globalen „alles neu starten“- oder Host-Shell-Funktionen für Marketing-Agenten.

Ressourcenengpässe, Datenbankfehler, Storage-Watermarks, Rate Limits und wiederholte Quellenfehler führen zu Backpressure statt eskalierender Parallelität. Publish-/Approval-Aufgaben dürfen nicht hinter einem vollständigen Wissens-Reindex verhungern. Ein CPU-/RAM-/Latenzbudget je Queueklasse dokumentieren und in isolierter Testumgebung prüfen.

Nach Backup-Restore oder Klonen eines Stacks sind externe Writes zunächst gesperrt. Prüfung von Revocations, Remote-Status, ausstehenden Freigaben und Budgetjournal vor Wiederaufnahme. Kopierte Publisher-Credentials allein dürfen keine zweite aktive Instanz auslösen.

### 17.6 Reproduzierbarkeit, Wartbarkeit und Open-Source-Qualität

Konfigurationsschema mit Versionsnummer und nachvollziehbaren Migrationen. Modelle, Prompttemplates, Knowledge-/Policy-Regeln und Connectorverträge versionieren; keine zur Laufzeit ungeprüft nachgeladenen Agentenskills. Sicherheitsrelevante Konfigurationsänderungen durch autorisierte Benutzer, nicht als Ergebnis einer Marketinganalyse.

Setup-Dokumentation muss einen frischen Checkout in einem isolierten Testziel starten können. .env-Beispiele enthalten nur Platzhalter; echte .env-Dateien weder kopieren noch ausgeben. Installationsskripte validieren Eingaben, verwenden keine globalen destruktiven Befehle und verändern keine anderen Stacks. Neue lokale Schema-/Auth-/Policy-Implementierung und isolierte Testmigrationen gehören zur Entwicklung; bestehende Produktionssysteme oder geschützte Dateien bleiben von diesem Auftrag unberührt. Zusätzliche lokale Freigaberegeln respektieren.

CI prüft Lockfile, Build, Tests, Secrets, Abhängigkeitsrisiken und Lizenzhinweise. Einfache maschinenlesbare Dependency-/SBOM-Ausgabe vorsehen, soweit die gewählten Werkzeuge dies unterstützen. Keine neue Pflicht-Cloud nur für Tests/Telemetrie. Testresultate, Screenshots, Quelle/Version und Ausführungsumgebung protokollieren; synthetische Beispiele kennzeichnen.

In `docs/REQUIREMENTS_TRACEABILITY.md` jede verpflichtende Funktion mit Implementierungspfaden, Tests, Ergebnis und offenen Abhängigkeiten verknüpfen. In `docs/IMPLEMENTATION_STATUS.md` erledigte Schritte, aktuelle Entscheidung, nächster sicherer Schritt und tatsächliche Blockaden pflegen. Bei Sitzungs-/Kontextende verwertbaren Stand sichern, statt einen unfertigen Scope als abgeschlossen umzudefinieren.

### 17.7 Bewusste Scope-Grenzen

Nicht im ersten Release erforderlich: GraphRAG/Knowledge Graph, eigene Trainingsplattform/Fine-Tuning, zusätzliche Vektordatenbank, lokale LLM-/GPU-Flotte, unbeschränkte Browseragenten, eigenständige Video-Renderingplattform, kompletter CRM-Vertrieb, Lead-Scraping, Social-Bots für künstliches Engagement, universeller visueller Agenten-Builder, native Mobilapps, Kubernetes oder ein vollwertiger Hosted-SaaS-Billingdienst.

Diese Grenzen sollen einen fertigen Kern ermöglichen, nicht die beschriebenen Pflichtpfade abwählen. Die bestehenden Content-, Blog-, Knowledge-, Analyse-, Integrations- und Autonomieanforderungen bleiben Teil des zusammenhängenden Auftrags. Fehlende reale Konten begrenzen Live-Verifikation, entschuldigen aber keine unverdrahteten internen Kernfunktionen.

---

## 18. Zusätzlicher Abnahmeplan: Knowledge, Memory und Betrieb

Diese Checks ergänzen, ersetzen aber nicht A01–A32 und H01–H12. Bei kombinierten Fällen mehrere Test-IDs demselben nachvollziehbaren Test zuordnen, statt identischen Testcode zu duplizieren. Es geht um belegte Eigenschaften, nicht um eine dekorative Anzahl von Tests.

### 18.1 Knowledge und Marketing Memory

| ID | Verbindlicher Mindestnachweis |
|---|---|
| K01 | TXT/Markdown und zugelassene HTML-/Website-/GitBook-Quellen durchlaufen echte Extraktion, Versionierung, Chunking und Retrieval; problematische Dateitypen werden ehrlich abgewiesen. |
| K02 | Unveränderter Wiederimport erzeugt weder Dubletten noch unnötige erneute Dokument-Embedding-Aufrufe. |
| K03 | Unterbrochener/fehlerhafter Versionsimport aktiviert keine gemischte Generation und verliert nicht unbemerkt die letzte zulässige Version. |
| K04 | Aktueller verifizierter strukturierter Preis gewinnt gegen einen semantisch gut passenden historischen Post mit altem Preis. |
| K05 | Künftige und abgelaufene Fakten sowie Zeitzonen-/Intervallgrenzen werden zum geplanten und tatsächlichen Veröffentlichungszeitpunkt korrekt behandelt. |
| K06 | Widersprüchliche gleichrangige Fakten erzeugen eine konkrete Ausnahme; der Agent entscheidet nicht eigenmächtig über den gültigen Wert. |
| K07 | Fehlender Beleg führt zu `insufficient_evidence`, Einschränkung oder berechtigter Blockade statt erfundener aktueller Produktbehauptung. |
| K08 | DE-/EN-Goldfragen belegen die semantische Retrievalqualität; echte Modell-Evaluation und Testvektorprüfung sind getrennt berichtet. |
| K09 | Exakte Namen/Ticker/URLs/IDs werden durch lexikalische oder strukturierte Suche auch ohne semantischen Treffer gefunden. |
| K10 | Fremde Projekte/Mandanten liefern keine Dokumente, Chunks, Embeddings, Vorschauen, Titel oder Evidence-Links; Shared Collections benötigen explizite Rechte. |
| K11 | Datenbanktests mit der echten nicht privilegierten App-/Worker-Rolle und wiederverwendeten Connections belegen RLS-/Kontextgrenzen. |
| K12 | Lesbare interne oder embargo-belegte Fakten dürfen nicht in öffentlichen Content gelangen; erlaubter Verwendungszweck wird serverseitig geprüft. |
| K13 | Daten ohne Freigabe zur externen Modellverarbeitung erreichen weder Embedding- noch Generierungs-/Reranking-Aufrufe. |
| K14 | Dokument-/Website-Prompt-Injection kann weder Tools/Secrets abrufen noch Routing, Faktenautorität, Budget oder Publikationspolicy umschreiben. |
| K15 | SSRF-Negativfälle umfassen IPv4/IPv6, Redirects, DNS-/Zielprüfung, Metadatenziele und eingebettete Browser-/Asset-/Sitemap-Requests. |
| K16 | Quellen-/Dokumentlöschung oder Rechteentzug sperrt Retrieval, Caches, Exporte, Evidence und abhängige Publikationen sofort; physische Bereinigung ist nachvollziehbar. |
| K17 | Gleichzeitig laufender oder wiederholter Import/Embedding-Job kann eine entzogene Quelle nicht wieder aktivieren. |
| K18 | Modell-/Dimensionswechsel baut getrennte Indexgenerationen auf; Query-/Dokumentvektoren inkompatibler Profile werden nicht vermischt. |
| K19 | Installationsprobe enthält lauffähige pgvector-Erweiterung, Versionen, Schema und Indizes; gewählte Prisma-Integration ist tatsächlich getestet. |
| K20 | Berechtigtes, gefiltertes Retrieval wird gegen exakte Baseline geprüft; bei aktiviertem ANN zusätzlich Recall und Unterfüllung testen, nie Filter entfernen. |
| K21 | Lexikalischer und semantischer Zweig werden nachvollziehbar fusioniert; Tokenlimits und Reduktion redundanter Chunks funktionieren. |
| K22 | Quellenanker/Belegstellen lassen sich auf die konkrete Originalversion zurückführen; public Renderer leakt keine privaten oder signierten Quellenlinks. |
| K23 | Relevante Quellen-/Faktenänderung invalidiert abhängige Entwürfe/Freigaben/Termine, lässt aber unabhängige Arbeit weiterlaufen. |
| K24 | Publikations-Preflight erkennt abgelaufene/geänderte Evidence und Rechte; parallele Updates/Worker verhindern keine erneute Prüfung. |
| K25 | Remote-Schedules werden bei kritischen Änderungen abgeglichen/abgebrochen, soweit möglich; nicht abbrechbarer oder unklarer Zustand ist sichtbar statt fälschlich sicher. |
| K26 | Eigene erzeugte Posts und abgeleitete Zusammenfassungen können nicht als unabhängige Faktenverifikation zurück in Structured Knowledge aufsteigen. |
| K27 | Memory-Insights referenzieren reproduzierbare Messdaten; kleine Stichproben und Datenkorrekturen erzeugen Unsicherheit/Revision statt erfundener sicherer Gewinner. |
| K28 | Retrieval-/Prompt-/Dokumentcaches sind nach Projekt, Zweck und Rechten getrennt; Änderungen/Löschungen invalidieren betroffene Einträge. |
| K29 | Embedding-, Rerank- und Reindex-Budgets bleiben auch bei parallelen Jobs, Fehlern und Wiederholungen begrenzt; unbekannte Kosten werden nicht als null verbucht. |
| K30 | Isolierter Restore respektiert Tombstones und Quellenrechte; zunächst keine externen Writes oder unbegrenzte kostenpflichtige Reindexierung. |
| K31 | Knowledge-UI zeigt Quellen, Fakten, Konflikte, Inspector und Auswirkungen mit echten Zuständen; relevante iPhone-Pfade sind getestet. |
| K32 | Mindestens 60 versionierte Evalfälle, vereinbarte Gates, Latenz/Kosten und Modell-/Index-/Commitstände im tatsächlichen RAG-Evaluationsbericht nachgewiesen. |

### 18.2 Autonomer Betrieb und Produktreife

| ID | Verbindlicher Mindestnachweis |
|---|---|
| B01 | Setup und Preflight trennen fehlende Konfiguration, interne Funktionsfähigkeit, Testbereitschaft und konkrete Live-Bereitschaft; Observe ist Installationsdefault. |
| B02 | Mehrere Kampagnen/Worker können gemeinsame Kanalquoten, Slotreservierungen und Budgetgrenzen nicht gegenseitig überlaufen. |
| B03 | Duplikat-/Themenprüfung unterscheidet erlaubte Kanaladaption von unnötig wiederholten Beiträgen; manuelle Kalendersperren bleiben wirksam. |
| B04 | Wiederkehrende Fehler werden gebündelt; mobile/Slack-Freigaben bleiben eindeutig, versioniert und geschützt vor Replay oder veralteten Vorschauen. |
| B05 | Operations-UI verwendet reale Worker-/Queue-/Knowledge-/Connectorzustände und ermöglicht nur begrenzte rollenbasierte Wiederanlaufaktionen. |
| B06 | Ein simulierter siebentägiger Ziel-/Content-/Knowledge-Zyklus bewältigt Update, Ausfall, berechtigte Ausnahme und Folgeplanung ohne unautorisierte Writes. |
| B07 | Datenfluss zu OpenAI und Speicherung sind dokumentiert; Self-Hosting oder `store=false` werden nicht als unbelegte vollständige Lokalität/ZDR beworben. |
| B08 | Korrektur, Export, Retention und Löschung von Facts/Memory sind funktional; öffentliche Artefakte enthalten keine privaten Beispieldaten oder Secrets. |
| B09 | Frische Standalone- und Shared-Host-Testinstallation sind nachvollziehbar; gebaute Kernansichten sind gegen die EDS-/Liquid-Glass-Vorgaben geprüft. |
| B10 | Dependency-/Secret-/Lizenzprüfung und reproduzierbare CI laufen oder fehlende Werkzeuge sind explizit als offene Gates ausgewiesen; keine öffentliche Repo-Veröffentlichung. |
| B11 | Tatsächliche Bestandszugriffe bleiben read-only; keinerlei Training, Backtest, Hoständerung, Migration oder verborgenes Live-Publishing als Smoke-Test. |
| B12 | Alle Pflichtanforderungen sind in Traceability/Abnahme erfasst; Statuscheckpoint ermöglicht Fortsetzung, externe Blockade wird nicht mit fehlender interner Implementierung verwechselt. |

### 18.3 Ergebnisregeln

Ergebnisstatus wie im Kernplan: `PASS_TEST`, `PASS_LIVE`, `BLOCKED_EXTERNAL`, `FAIL`, `NOT_RUN`. Bei wirklich optionalen Fähigkeiten ein begründetes `NOT_APPLICABLE_OPTIONAL` zulassen; nicht auf verpflichtende RAG-/Policy-/UI-/Recovery-Pfade anwenden. Ein Test, der nur Mocks nutzt, darf kein Live-Häkchen erhalten.

Live-Evals und Sandbox-Publishing sind gesonderte, budgetierte Testaktionen. Keine verdeckten öffentlichen Posts, Mails, Ads-Buchungen oder Produktionsdatenänderungen zum Erfüllen eines Gates. Realistische Provider-Vertragstests müssen trotzdem implementiert sein; ohne Konten bleiben nur deren Live-Nachweise offen.

Der Releasebericht umfasst ausdrücklich den Stand der Wissensqualität und verbleibende Unsicherheit. Ein Build-RC mit offenem Live-Embedding-Gate kann installierbar sein, ist aber für faktenbasierten produktiven Autopilot nicht vollständig abgenommen. Kein LLM oder endliches Testset garantiert fehlerfreie autonome Kommunikation.

---

## Anhang A — VPS-Infrastrukturaufnahme und Konsolidierung: ausschließlich lesend

Dieser Anhang ist ein Workstream desselben Gesamtauftrags. Er autorisiert keine Produktionsänderung. Fehlender Lesezugriff wird als Blockade dieses Workstreams dokumentiert; Orbit-Entwicklung darf unabhängig fortgesetzt werden.

### Ziel

Mario möchte mehrere kleine VPS für Nebenanwendungen konsolidieren und dadurch weniger Betriebssysteme, Deployments und Backups einzeln betreuen. uLiquid Desk bleibt ausdrücklich separat. Forecast bleibt in der empfohlenen ersten Stufe ebenfalls separat. Geplante gemeinsame Services: EDS Orbit, Postiz, Matomo/uLiquid Analysis, zugehörige MCP-/Webhook-Dienste und geeignete kleine Websites.

Nutze das vorhandene Codex Project Framework 1.1.0. Lies die Projektanweisungen und die Regeln für Security, Operations und Production. Diese Aufgabe ist nur Analyse. Keine Produktionsänderung ist freigegeben.

### Unbedingte Grenzen

Keine Server bestellen, upgraden, neu installieren, kündigen oder löschen. Keine Deployments, Neustarts, Updates, Paketinstallationen, DNS-/Firewall-/Proxy-Änderungen, DB-Migrationen, Sicherungsläufe, Trainings, Backtests, aktiven Lasttests oder Veröffentlichungen ausführen. Keine Redis-Queues ändern oder konsumieren. Keine Nutzer-, Trading- oder Wallet-Daten exportieren.

Nutze bereits autorisierte lesende Provider-/SSH-/Monitoring-Zugänge. Reichen die Rechte nicht, dokumentiere genau den fehlenden Lesezugriff und arbeite mit belegbar verfügbaren Daten weiter. Nicht anhand alter Hostlisten behaupten, gelöschte Server liefen noch.

Secrets, Tokens, API-Schlüssel, E-Mail-Empfängerlisten und `.env`-Inhalte dürfen nicht in der Antwort oder in Artefakten erscheinen. Keine vollständigen `docker inspect`-/`docker compose config`-/Environment-Ausgaben übernehmen; ausschließlich notwendige sichere Felder auswählen. Vorhandene Logs nur eng begrenzt und redigiert lesen. Keine Agenten- oder Prompttexte aus privaten Nutzerdaten extrahieren.

### 1. Aktuellen Bestand belegen

Pro erreichbarem Server erfassen:
- eindeutiger Alias/ID, Anbieter, Rolle, aktueller Status und Belegzeitpunkt;
- OS-/Kernel-Version, Architektur, CPU-Modell und vCPU-/Core-Zuordnung, RAM, Swap, Datenträgergröße und freier Platz;
- gebuchter Tarif, tatsächlich laufender Monatspreis, Netto/Brutto, Restlaufzeit, Verlängerung und Kündigungsfrist – nur soweit aus autorisierten Quellen belegt;
- Docker-/Compose-Version, laufende Service-/Image-Versionen, Restart-Zähler, Health-Status und tatsächlich konfigurierte Ressourcenlimits;
- Datenbank-Engine/-Version und Größen, Daten-/Medien-/Snapshot-/Log-Volumes sowie Wachstumsindikatoren;
- Domains, öffentliche Ports, Reverse Proxy, abhängige APIs, OAuth-/MCP-Endpunkte, Cron-/Worker-/Scheduler-Zuständigkeiten;
- Backup-Ziele, letzter erfolgreicher Lauf, letzter belegter Restore und bekannte Wiederherstellungsziele;
- vorhandene externe Überwachung und Zuständigkeit für Alarme.

Desk nur für die Abgrenzung und bereits vorhandene Metadaten betrachten; keine zusätzlichen sensitiven Zugriffe. Vorhandene FamilyPlan-/Supabase-Plattformen nicht automatisch als VPS-Umzug behandeln.

### 2. Vorhandene Messwerte auswerten

Bestehende Zeitreihen der letzten 7–14 Tage bevorzugen. Erhebe, soweit vorhanden, CPU-Spitzen/P95, RAM-Spitzen und Working Set, OOM-Ereignisse, Swap, I/O-Wartezeiten, Disk-Auslastung und Wachstum, Datenbanklast, Queue-Längen, Jobdauer und zeitliche Gleichzeitigkeit.

Für Orbit ist jetzt auch der Knowledge Layer einzuplanen: erwartete Dokument-/Chunkzahl, Versionen, Quelldateien, Volltext-/Vektorindizes, Indexaufbau, Sync-/Reindex-Queues, Datenbank-Working-Set und Backupvolumen. Solange Orbit noch nicht implementiert ist, sind dies ausdrücklich Annahmen; keine Ist-Auslastung erfinden. API-basierte Embeddings benötigen keine lokale GPU, aber lokale Speicherung und Suche benötigen weiterhin Ressourcen.

Eine einzelne Momentaufnahme ist keine Kapazitätsplanung. Fehlen historische Messwerte, diese als fehlend ausweisen; keine Messwerte erfinden und keinen neuen Monitoring-Agenten installieren. Ein späterer Messplan kann vorgeschlagen werden, ohne ihn jetzt zu starten.

Für Forecast insbesondere nur vorhandene Messwerte früherer Trainings/Backtests auswerten. Nichts neu starten. Bei Postiz alle tatsächlich installierten Nebenkomponenten berücksichtigen; die aktuelle Dokumentation beschreibt auch Temporal, aber der reale Bestand ist maßgeblich. Matomo-Archivierungszeiten und Speichervolumen getrennt vom HTTP-Traffic betrachten.

### 3. Zielvarianten vergleichen

#### Empfohlene Variante

Desk separat; Forecast separat; ein neuer oder geeigneter bestehender 32-GB-Services-Host mit ungefähr 8–12 modernen CPU-Ausführungseinheiten und 500 GB bis 1 TB NVMe. Keine GPU, kein lokales LLM, kein dauernder Video-Renderbetrieb in dieser Planung. Mindestens etwa 25–30 % Reserve anstreben. Die Auslegung bleibt bis zum Lastnachweis eine Annahme.

#### Alternative mit Reserve

64-GB-Services-Host nur bei gemessener Last, größerem Datenwachstum oder bewusst gewünschter Reserve. Ein Forecast-Umzug ist eine gesonderte Architektur-/Risikofrage und nicht automatisch durch 64 GB gerechtfertigt.

#### Bestehendes System behalten oder vergrößern

Auch prüfen, ob einer der aktuellen Nicht-Desk-/Nicht-Forecast-Hosts bereits geeignet ist. Ein neuer Anbieter ist kein Selbstzweck. In-place-Upgrades können Unterbrechungen oder Tarifwechsel auslösen und sind nicht autorisiert. Provider-Kontrollfläche und Anwendungsbetrieb getrennt bewerten.

### 4. Kostenmodell

Aktuelle real bezahlte Kosten und öffentlich angebotene Preise getrennt ausweisen. Nur tatsächlich kündbare/reduzierbare Altverträge als Einsparung zählen. Desk und unverändert laufenden Forecast bei beiden Varianten gleich behandeln.

Monatlicher Unterschied = abbaubare Altserverkosten minus neuer Services-Host minus zusätzliche Off-Host-Backups/Monitoring.

Migration, parallele Restlaufzeiten, Einrichtung und erforderliche Zusatzspeicher separat aufführen. Bei positiver Ersparnis kann eine Amortisation aus einmaligen Kosten / monatlicher Ersparnis berechnet werden. Ohne Kostenbelege keine Einsparzahl behaupten.

Konkrete Anbieterangebote beim tatsächlichen Audit neu prüfen und mit Abrufdatum, Vertragsbedingungen, Standort, CPU-Zusage und Backup-Kosten ausweisen. Die unverändert übernommene Produktanforderung ist eine belegte Entscheidung zwischen geeignetem bestehendem Host, ungefähr 32 GB als Planungsbasis und begründeter 64-GB-Alternative. Frühere öffentliche Preisbeispiele sind weder aktuelle Vertragskosten noch eine Bestellung und werden hier nicht als verbindliche Kaufgrundlage fortgeführt.

Root-Zugriff ist nicht gleich Bare Metal. Physische Kerne, Threads und vCPUs sowie dedizierte und geteilte Ressourcen im Vergleich klar auseinanderhalten. Angebots-CPU-Zahlen sind kein unabhängiger Leistungsvergleich. Keine unbelegte Anbieter-Zuverlässigkeitsrangfolge erstellen.

### 5. Migration nur planen

Priorität: Orbit unabhängig neu aufsetzen; existierende Dienste erst nach Bestands-, Backup- und Restore-Prüfung umziehen. Mit dem bisher geplanten Presale-Start am 19. September 2026 kein kurzfristiges Umzugsfenster für laufendes Publishing/Analytics annehmen.

Pro Service: Abhängigkeiten, aktuelle Version, konsistente DB-/Dateisicherung, Testziel ohne externe Schreibrechte, Wartungsfenster, Single-Writer-Abschaltung und Cutover skizzieren. Bestehende Domains, Matomo-Site-IDs, Tracking-Parameter, Postiz-OAuth-Redirects und MCP-Discovery/Issuer/Audience erhalten beziehungsweise vollständig prüfen. Beim Umzug keine gleichzeitigen Major-Upgrades.

Unterscheide einen Rollback vor den ersten Zielschreibvorgängen von einem danach. Nach neuen DB-/Queue-Schreibvorgängen oder externen Veröffentlichungen reicht ein DNS-Rückwechsel nicht. Rücksynchronisation und Provider-Reconciliation planen. Nie zwei aktive Publisher für denselben Bestand.

Backups und externe Erreichbarkeitsüberwachung müssen außerhalb der Fehlerdomäne des gemeinsamen Services-Hosts liegen. Keine globale Docker-/Hostadministration durch Orbit. Kubernetes/zusätzlicher Hypervisor sind kein Standardbestandteil dieser Konsolidierung.

### Ergebnisdateien

Erstelle lokal beziehungsweise im freigegebenen Dokumentationsrepository:
1. `VPS_INVENTORY.md` – belegter aktueller Bestand, keine Secrets.
2. `RESOURCE_AND_COST_COMPARISON.md` – Quellen, echte Metriken, Annahmen, Kosten, offene Daten.
3. `CONSOLIDATION_RECOMMENDATION.md` – eine klare Empfehlung und begründete Alternative.
4. `MIGRATION_PLAN_NOT_EXECUTED.md` – Reihenfolge, Risiken, Sicherung/Restore, Single Writer, Rollback und nötige Einzel-Freigaben.

Abschluss klar kennzeichnen: Welche Hosts konnten tatsächlich gelesen werden? Welche Daten fehlen? Was wurde nur vorgeschlagen? Bestätige nur bei tatsächlicher Einhaltung, dass auf den Zielsystemen nichts verändert wurde.

---

## Anhang B — Erste Codex-Anweisung

Die folgende Anweisung kann zusammen mit dieser Datei und dem Framework im Codex-Workspace verwendet werden. Sie ist eine Einstiegshilfe; die vollständige Spezifikation bleibt maßgeblich.

```text
Arbeite auf Basis von `EDS_ORBIT_UNIFIED_CODEX_MASTER_v3.md`.
Diese Datei ersetzt alle früheren Orbit-Masteraufträge und enthält auch
den ausschließlich lesenden VPS-Inventurauftrag.

Du bist Lead für die vollständige Umsetzung von EDS Orbit: ein autonomer,
selbst hostbarer, Open-Source-fähiger Marketing-Workspace mit integriertem
Knowledge Layer, Hybrid RAG und Marketing Memory.

ZIEL
Liefere den maximal innerhalb der verfügbaren Berechtigungen erreichbaren,
integrierten und getesteten Release Candidate. Kein bloßer Plan, kein Scaffold
und keine UI-Demo. Arbeite nach einem internen Implementierungsplan weiter,
ohne nach jeder Phase eine neue Aufforderung zum Fortfahren zu verlangen.

START
1. Lies zuerst die geltenden AGENTS.md-Anweisungen, die vollständige
   Masterdatei und die vom Codex Project Framework vorgegebenen Referenzen.
2. Prüfe das bereitgestellte Codex Project Framework 1.1.0 und übernimm es
   kontrolliert. Keine bestehenden Regeln überschreiben und weder .git noch
   echte Secrets aus dem Framework-/Projektbestand kopieren.
3. Konkretisiere Projektprofil, Architektur, Datenmodell, Rechte, API-Verträge,
   Kostenmodell und Anforderungs-/Testmatrix anhand der Spezifikation.
4. Beginne anschließend mit der Implementierung. RAG gehört in die Foundation,
   nicht auf eine spätere Roadmap. Sichere den Fortschritt fortlaufend in
   docs/IMPLEMENTATION_STATUS.md und docs/REQUIREMENTS_TRACEABILITY.md.

VERBINDLICHE LEITPLANKEN
- Framework-Preset web-next-custom-postgres; Next.js, TypeScript, Fastify,
  PostgreSQL mit pgvector/Volltextsuche, Prisma und getrennte BullMQ-Worker.
  Kompatible konkrete Versionen und Vektorintegration vor Verwendung prüfen.
- EDS-Labs-Markenwelt, originales Logo, Arctic Blue und Liquid Glass;
  vollständige Desktop- und mobile Kernansichten. Keine neue Logo-/Farbwelt.
- Laufende KI ausschließlich über OpenAI. GPT-5.6 taskabhängig routen,
  Astra nur für begrenzte schwierige Eskalationen. Embeddings separat
  konfigurieren, validieren und budgetieren. Ultra ist kein pauschaler
  Produktions-API-Parameter.
- Strukturierte bestätigte Fakten, Dokumentwissen und Marketing Memory
  getrennt halten. Relevante Belege vor der Generierung abrufen und
  Fakten, Quellenrechte, Gültigkeit und Policy vor Publikation erneut prüfen.
- Quellen inkrementell synchronisieren. Änderungen, Löschung und Rechteentzug
  müssen Chunks, Vektoren, Caches, Evidence, Memory und geplante Inhalte erreichen.
- Keine eigenen KI-Posts als unabhängigen Faktenbeweis verwenden.
  Intern lesbare Informationen sind nicht automatisch öffentlich verwendbar.
- Autopilot über versionierte Owner-Mandate, serverseitige Policies,
  Kosten-/Frequenzgrenzen, dauerhafte Jobs und einen kontrollierten Executor.
  Keine unbeschränkten Toolrechte oder endlosen Agentenschleifen.
- Postiz, Matomo, Slack, Blog-/Datei- und Knowledge-Adapter nach tatsächlichen
  Fähigkeiten implementieren. Vorhandene ChatGPT-/Codex-Verbindungen sind
  nicht automatisch Zugangsdaten der fertigen Anwendung.

UMSETZUNG UND QUALITÄT
Nutze verfügbare Subagents für klar abgegrenzte Bereiche und unabhängige QA;
ein Lead bleibt für Verträge, Integration und Endabnahme verantwortlich.
Implementiere vollständige vertikale Pfade: Ziel, aktuelle Belege, Content,
Review, Policy, Test-Publishing, Statusabgleich, Analytics und Folgeplanung.
Alle weiteren Pflichtfunktionen der Masterdatei bleiben ebenfalls im Scope.

Führe die Abnahmegruppen A, H, K und B tatsächlich aus, soweit autorisiert.
Teste insbesondere RAG-Qualität, Faktenkonflikte, Projekt-/Datentrennung,
Prompt Injection, Löschung während laufender Jobs, Kostenlimits,
Duplicate-Publishing-Schutz, Wiederanlauf und mobile Bedienung.
Korrigiere Fehler und wiederhole betroffene Tests. Testvektoren und Mocks
sind keine bestandene Live-Embedding- oder Provider-Abnahme.

BERECHTIGUNGSGRENZEN
Entwicklung und Tests erfolgen isoliert. Bezahlte Live-API-Tests nur mit
passendem freigegebenem Testbudget. Keine echten Posts, Mails oder Ads als
verdeckter Test. Keine Secrets in Prompts, Logs, Fixtures oder Repository.

Bestands-VPS ausschließlich lesend untersuchen. Desk und Forecast bleiben
separat. Keine Server bestellen, migrieren, kündigen, aktualisieren oder
neustarten; keine produktiven DNS-, Firewall-, Datenbank- oder Deployment-
Änderungen. Kein Training und kein Backtest. Repository nicht veröffentlichen.
Zusätzliche lokale Freigabeanforderungen und Quality Gates nicht umgehen.

Fehlende Konten, Originalassets oder Infrastrukturzugänge als konkrete
externe Blockaden dokumentieren und an unabhängigen Teilen weiterarbeiten.
Nicht wegen einer offenen Live-Integration den gesamten Auftrag abbrechen.

ABSCHLUSS
Liefere einen belegten Abnahmebericht mit Funktionen, Tests, RAG-Evals,
Screenshots, Sicherheits-/Betriebsstatus, lesender Infrastrukturaufnahme,
fehlender Konfiguration und separat freizugebenden Produktionsschritten.
Unterscheide implementiert, getestet, live verifiziert und extern blockiert.
Keine fehlenden internen Funktionen als externe Blockade umdeklarieren.

Beginne jetzt mit Framework-/Workspace-Aufnahme und Architektur-Baseline
und arbeite anschließend selbstständig in Richtung des vollständigen
Release Candidates weiter.
```

---

## Quellen, Prüfreferenzen und Revisionsnachweis

### Technische Primärquellen

Quellen dienen zur Überprüfung von Plattformfähigkeiten und Risiken; die konkreten Architekturentscheidungen und Abnahmeschwellen dieses Dokuments sind Projektvorgaben, keine Behauptung, dass ein Anbieter diese fertige Lösung bereitstellt. APIs, Paketversionen, Fähigkeiten und Accountzugänge vor Implementierung nochmals prüfen. Public Docs sind kein Nachweis für persönliche Kontoberechtigungen.

Die OpenAI-Modell-/Embedding-/Datenschutz-/Eval-Grundlagen, pgvector, PostgreSQL-RLS, Prisma-Vektorintegration und OWASP-SSRF wurden für diese Revision am 17.09.2026 konsultiert. Unverändert übernommene allgemeine Produkt-/Hostingreferenzen aus Revision 2 werden nicht als erneut ausgeführtes Live-Audit ausgegeben.

| ID | Primärquelle und Zweck |
|---|---|
| S1 | [OpenAI: Models](https://developers.openai.com/api/docs/models) — dokumentierte Textmodellfamilien und IDs; kein Kontozugriffsnachweis. |
| S2 | [Codex: Models](https://developers.openai.com/codex/models) — Auswahl des Entwicklungsmodells/-modus; getrennt vom Produktionsrouting. |
| S3 | [OpenAI: Agents](https://developers.openai.com/api/docs/guides/agents) — Agenten-/SDK-Grundlagen; vormals über den Agents-SDK-Guide verlinkt. |
| S4 | [Postiz: Create Post](https://docs.postiz.com/public-api/posts/create) — Adaptervertrag und Entwurf/Terminierung/Publikation. |
| S5 | [OpenAI: Safety in building agents](https://developers.openai.com/api/docs/guides/agent-builder-safety) — Risiken externer Inhalte, Toolrechte und Sicherheitsprüfungen. |
| S6 | [Open Source Initiative: MIT License](https://opensource.org/license/mit) — bisherige Lizenzempfehlung, keine bestätigte Veröffentlichung. |
| S7 | [Docker: Resource constraints](https://docs.docker.com/engine/containers/resource_constraints/) — explizite Laufzeitbegrenzungen. |
| S8 | [Docker: Security](https://docs.docker.com/engine/security/) — Host-/Daemon-Sicherheitsgrenzen. |
| S9 | [Postiz: Docker Compose](https://docs.postiz.com/installation/docker-compose) — tatsächlichen installierten Stack/Versionen separat prüfen. |
| S10 | [Matomo: Server migration](https://matomo.org/faq/how-to-install/faq_76/) — Referenz für spätere separat freizugebende Migration. |
| S11 | [netcup: Root Server](https://www.netcup.com/de/server/root-server) — möglicher Angebotsvergleich im späteren Audit, keine Preis- oder Kaufzusage. |
| S12 | [Serverdiscounter: VPS](https://serverdiscounter.com/vserver) — möglicher Angebotsvergleich im späteren Audit, keine Preis- oder Kaufzusage. |
| S13 | [OpenAI: Vector embeddings](https://developers.openai.com/api/docs/guides/embeddings) — Embeddingmodelle, Dimensionen und Adaptergrundlagen. |
| S14 | [pgvector: offizielles Repository](https://github.com/pgvector/pgvector) — Hybrid Search, Typ-/Indexdimensionen, Filter und exakte/approximative Suche. |
| S15 | [PostgreSQL: Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) — RLS und privilegierte Rollen. |
| S16 | [Prisma: PostgreSQL extensions](https://www.prisma.io/docs/postgres/database/postgres-extensions) und [Prisma: pgvector extension](https://www.prisma.io/extensions/pgvector) — versionsabhängige Integrationswege, nicht ungeprüft miteinander mischen. |
| S17 | [OpenAI: Data controls](https://developers.openai.com/api/docs/guides/your-data) — Datenübermittlung, Speicherung und Retention-Grenzen. |
| S18 | [OpenAI: Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) — dokumentierte Evaluationsgrundlagen; Schwellen und Fixtures bleiben Projektentscheidungen. |
| S19 | [OWASP: SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) — Referenz für abgesicherte Quellen-/Asset-Fetcher. |

### Lokale Quellen und Geltungsbereich dieser Bearbeitung

- Nutzerdatei `Codex Project Framework.zip`, Version 1.1.0, SHA-256 `5c02ca5ad6316970e39e60c0722c663a715f3d710f832a708c878b4098346dfa`.
- Bisherige Produktspezifikation `EDS_ORBIT_CODEX_MASTER_TASK_v2.md` und konsolidierter Master `EDS_ORBIT_UNIFIED_CODEX_MASTER.md`.
- Bisheriger lesender Infrastrukturauftrag `EDS_VPS_KONSOLIDIERUNG_READ_ONLY_TASK.md`.
- Vom Nutzer bestätigte Ergänzung: RAG jetzt vor Beginn des Codex-Laufs integrieren und weitere relevante Lücken schließen.

Diese Revision überarbeitet Dokumente. Keine App implementiert, kein Repository angelegt/veröffentlicht, keine VPS-Abfrage oder Migration ausgeführt, keine Konten verbunden und keine bezahlten Embeddings/Test-Publikationen gestartet. Die Datei enthält zu implementierende Anforderungen und Zieltests, keine bestandenen Abnahmen.

### Änderungen gegenüber dem vorherigen konsolidierten Master

1. Wissensschicht direkt in Stack, Datenmodell, Agentenablauf, Kostenkontrolle, Policy, UI, Tests und Hosting integriert.
2. Structured Facts, Hybrid RAG, Marketing Memory, Knowledge Health und ein vollständiges Evidence-/Claim-Modell ergänzt.
3. Zeitliche Gültigkeit, Geltungsbereich, Quellenversionen und erneute Prüfung bei Veröffentlichung konkretisiert.
4. Inkrementeller Import, Chunking, OpenAI-Embeddings, Indexmigration, Caches, Löschung und laufende Job-Races spezifiziert.
5. Öffentliche Verwendbarkeit, Modellübermittlung und Leserecht getrennt; Projekt-/RLS-/Egress-Grenzen erweitert.
6. Marketing Memory gegen Selbstbestätigung, kleine Stichproben und unbelegte Optimierung abgesichert.
7. Setup-/Aktivierungschecks, begrenzte autonome Planung, Benachrichtigungsbündelung und redaktionelle Qualität ergänzt.
8. Knowledge-Evals und weitere Betriebsabnahmen hinzugefügt; Checkpoints und Anforderungstraceability verbindlich gemacht.
9. Bestehende Desk-/Forecast-Trennung und read-only VPS-Grenzen beibehalten; RAG-Kapazitätsbedarf ergänzt und volatile Preisbeispiele aus der verbindlichen Kaufgrundlage entfernt.
10. Neue erste Codex-Anweisung in dieselbe Datei aufgenommen. Keine weiteren früheren Masterdateien zum Start erforderlich.

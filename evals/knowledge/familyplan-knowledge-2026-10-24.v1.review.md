# FamilyPlan knowledge retrieval evaluation — review sheet

Dataset `evals/knowledge/familyplan-knowledge-2026-10-24.v1.json` for the live index evaluation of the FamilyPlan project (`knowledge_evaluate`, step `evaluate`). Prepared by Claude on 2026-10-24 from the 96 active chunks of the curated source `7179fa92-d780-4117-aa54-69d62b6a8985` ("FamilyPlan – Kuratierte Projektwissensbasis", German). **To be reviewed by Mario before use** (independent labeling).

- 56 German cases with expected chunks (gate: at least 48, recall@10 at least 0.9). A case passes when any expected chunk is among the 10 nearest chunks.
- 14 negative safeguard cases (gate: at least 12, zero forbidden hits): English queries against the German-only corpus, the same pattern as the uLiquid set.
- `purpose: internal`: the source is model-usable but not public.
- The chunk ids hold while the corpus is unchanged. `begin_index` snapshots the corpus; re-import or edits change ids and need a new dataset version.

| ID | Query | Expected chunk (prefix) |
| --- | --- | --- |
| pos-01 | Was ist das Ziel der Marketingstrategie für FamilyPlan? | 6edadf18, c070d4ab |
| pos-02 | Welche Zielgruppe spricht FamilyPlan primär an? | 10ef5131 |
| pos-03 | Welche Kampagnenprioritäten hat die 90-Tage-Strategie? | 6c75abec |
| pos-04 | Wie viele Reels pro Woche sind auf Instagram geplant? | 092609f6, bec1e153 |
| pos-05 | Wie sieht der Conversion-Funnel von FamilyPlan aus? | 7c3532ed |
| pos-06 | Was passiert in Woche 1 bis 2 der Marketing-Roadmap? | 5eabd623 |
| pos-07 | Wie viel Werbebudget ist im ersten Monat vorgesehen? | 208a7a20 |
| pos-08 | Was ist die North-Star-Kennzahl von FamilyPlan? | 7253e595 |
| pos-09 | Wie arbeitet der Marketing-Agent in Orbit mit der Strategie? | bec1e153 |
| pos-10 | Welche Claim-Regeln gelten für Android und die Web-Version? | e94da31c, b2748543, 4400a3ef |
| pos-11 | Welche strategischen Entscheidungen sind bestätigt? | 34fa37e7 |
| pos-12 | Wann wurden die iOS-Versionen im Store veröffentlicht? | b2aeb630, 4400a3ef |
| pos-13 | Welche Entscheidungen sind noch offen? | e01bbec2 |
| pos-14 | Ist der Premiumpreis von 4,99 Euro noch gültig? | e53f93d3, 54185ea8 |
| pos-15 | Was kostet FamilyPlan Premium im Monat und im Jahr? | 82c988dc, b2748543 |
| pos-16 | Welche Funktionen sind in Free und welche in Premium enthalten? | 8f85052d |
| pos-17 | Wie werden Abos gekauft und gekündigt? | eb049727 |
| pos-18 | Wie heißt die App im App Store? | fdf17b4c |
| pos-19 | Wodurch unterscheidet sich FamilyPlan, ohne überzogene Claims zu machen? | b3d81201 |
| pos-20 | Was brauchen Kinder in der FamilyPlan-App? | f7122559 |
| pos-21 | Welcher Ton und welche Markenwerte gelten für FamilyPlan? | a381e7ae, 9d2f93a5 |
| pos-22 | Wie lautet die Positionierung von FamilyPlan in einem Satz? | f7c83b4a |
| pos-23 | Welche Kernbotschaften nutzt das Marketing? | 390bc317 |
| pos-24 | Welches Gestaltungsprinzip und welche Markenfarbe hat FamilyPlan? | b16cace8 |
| pos-25 | Welcher Call-to-Action ist primär? | e3c5bfda, 7c3532ed |
| pos-26 | Welche Social-Media-Kanäle wurden früher priorisiert? | 59d1ced2, 092609f6 |
| pos-27 | Welche Aussagen sind in Marketinginhalten zulässig? | b2748543 |
| pos-28 | Welche KPIs werden zur Messung empfohlen? | 5b78b173, 7253e595 |
| pos-29 | Wie werden Daten in FamilyPlan klassifiziert? | 061d12d4 |
| pos-30 | Welche Rollen gibt es für Eltern, Betreuer und Kinder? | 50dc77cc |
| pos-31 | Ist die Standortfreigabe freiwillig und abschaltbar? | f657fa45 |
| pos-32 | Wie werden importierte externe Kalendertermine geteilt? | bafc71fb |
| pos-33 | Wie geht der KI-Assistent mit Datenschutz und Einwilligung um? | 3b3bb203 |
| pos-34 | Wo finde ich Datenschutzerklärung und Kontolöschung? | e2a55a7d |
| pos-35 | Darf Orbit Daten echter Familienkonten lesen? | 7d851551, 7bc94080 |
| pos-36 | Welche Datenschutzthemen sind noch zu prüfen? | af0701d2 |
| pos-37 | Welche öffentlichen Primärquellen gibt es für FamilyPlan? | 80e07c2a |
| pos-38 | Wie oft sollen Preise und App-Version geprüft werden? | 2c04cd6a |
| pos-39 | Was ist das Leitprinzip des FamilyPlan Assistant? | 2629a53e |
| pos-40 | Was kann der KI-Assistent heute nachweisbar? | 1ef45c24 |
| pos-41 | Welche Tools und Aktionen nutzt der Assistant? | f3b9c137 |
| pos-42 | Welche KI-Funktionen sind geplant und dürfen nicht beworben werden? | d3b23455 |
| pos-43 | Ist eine Zero-Data-Retention mit OpenAI vereinbart? | 7baae038, e01bbec2 |
| pos-44 | Wie ist die technische Architektur von FamilyPlan aufgebaut? | b8f34ab8, 3b9049e0 |
| pos-45 | Mit welchen Technologien ist die iOS-App gebaut? | 28290b79 |
| pos-46 | Welches Backend und welche Autorisierung nutzt FamilyPlan? | 549d734c |
| pos-47 | Wie funktioniert die Offline-Synchronisierung der Apps? | cc19c3e7 |
| pos-48 | Wie ist die Abrechnung über Apple umgesetzt? | efa83a45, eb049727 |
| pos-49 | Welche Sicherheitsregeln gelten für den Betrieb? | 920bc940 |
| pos-50 | Welche Projekt-ID hat FamilyPlan in EDS Orbit? | 673691e4, a54d2628 |
| pos-51 | Welche externen Kalender werden unterstützt? | 5bb5327d |
| pos-52 | Unter welchem Pfad ist die Web-Beta auf der Website zu finden? | 8fdecdfe |
| pos-53 | Welche Betriebsregeln gelten für Orbit gegen erfundene Zahlen? | eb3acbbe |
| pos-54 | Was ist FamilyPlan kurz zusammengefasst? | 56df3f19, 95042280 |
| pos-55 | Welche Supportfragen dürfen nicht ohne Ticketsystem beantwortet werden? | b4d7c17b |
| pos-56 | Wie soll der Support bei Unsicherheit antworten und eskalieren? | 2f8f1401 |
| neg-lang-01 | How much does FamilyPlan Premium cost? | 82c988dc (forbidden) |
| neg-lang-02 | Is location sharing optional? | f657fa45 (forbidden) |
| neg-lang-03 | What is FamilyPlan's North Star metric? | 7253e595 (forbidden) |
| neg-lang-04 | Which backend does FamilyPlan use? | 549d734c (forbidden) |
| neg-lang-05 | What is the assistant's guiding principle? | 2629a53e (forbidden) |
| neg-lang-06 | How many reels per week are planned on Instagram? | 092609f6 (forbidden) |
| neg-lang-07 | Is zero data retention agreed with OpenAI? | 7baae038 (forbidden) |
| neg-lang-08 | What is the paid ad budget in the first month? | 208a7a20 (forbidden) |
| neg-lang-09 | How do I cancel my subscription? | eb049727 (forbidden) |
| neg-lang-10 | Which roles exist for children in the app? | 50dc77cc (forbidden) |
| neg-lang-11 | What is the brand design principle? | b16cace8 (forbidden) |
| neg-lang-12 | Which data classification levels exist? | 061d12d4 (forbidden) |
| neg-lang-13 | When was iOS version 1.2 released? | b2aeb630 (forbidden) |
| neg-lang-14 | What is the primary call to action? | e3c5bfda (forbidden) |
